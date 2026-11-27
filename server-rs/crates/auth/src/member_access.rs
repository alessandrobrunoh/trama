//! Member access: how far one person's work reaches, for the request being handled. The port of
//! `server/src/auth/member-access.ts` and its interceptor.
//!
//! The guard resolves the caller's [`MemberAccess`] for every `/w/{slug}` route and runs the
//! handler inside a tokio task-local holding it (the NestJS `AsyncLocalStorage`), so services
//! read it with [`current_access`] without threading it through. `None` means the caller's role
//! is not narrowed (every project, every action the role has).
//!
//! The task-local does not follow work moved to another task: read [`current_access`] before
//! `tokio::spawn` and wrap the spawned future in [`with_access`].
//!
//! Services apply the project limit with:
//!
//! * [`project_hidden`] / [`assert_can_use_project`] for one record (`Issue`, `Milestone`, … by
//!   its `project_id`; a project by its own id);
//! * [`apply_project_scope`] / [`project_scope_condition`] for a list query;
//! * [`can_view`] for whole resources (`comments:view`, …);
//! * [`scope_snapshot`] for the workspace snapshot.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use sea_orm::sea_query::{Expr, ExprTrait, SimpleExpr};
use sea_orm::{ColumnTrait, Condition, QueryFilter};
use trama_contracts::access::{MemberAccess, MemberAction, MemberGrant, MemberResource};
use trama_contracts::activity::WorkspaceSnapshot;
use trama_contracts::common::LegacySubjectRef;
use trama_core::AppError;

tokio::task_local! {
    static MEMBER_ACCESS: Option<Arc<MemberAccess>>;
}

/// The member access of the request being handled; `None` when the role is not narrowed or
/// outside a request.
#[must_use]
pub fn current_access() -> Option<Arc<MemberAccess>> {
    MEMBER_ACCESS.try_with(Clone::clone).ok().flatten()
}

/// Runs `fut` with `access` as the current member access (the guard does this for every
/// request; use it for spawned tasks and tests).
pub async fn with_access<F: Future>(access: Option<Arc<MemberAccess>>, fut: F) -> F::Output {
    MEMBER_ACCESS.scope(access, fut).await
}

/// Route segment → member resource (`API_TO_MEMBER`).
fn api_to_member(segment: &str) -> Option<MemberResource> {
    Some(match segment {
        "projects" => MemberResource::Projects,
        "milestones" => MemberResource::Milestones,
        "issues" | "tasks" | "decisions" => MemberResource::Issues,
        "artifacts" => MemberResource::Artifacts,
        "views" => MemberResource::Views,
        "comments" => MemberResource::Comments,
        _ => return None,
    })
}

/// `POST …/<verb>` that changes something which already exists rather than creating a row
/// (`POST_UPDATE`).
const POST_UPDATE: &[&str] = &[
    "bulk",
    "bulk-delete",
    "accept",
    "reject",
    "supersede",
    "cancel",
    "archive",
    "restore",
    "reorder",
    "link",
    "unlink",
    "refresh",
    "attach",
    "detach",
    "publish",
    "complete",
    "criteria",
    "merge",
    "external-ref",
    "read",
];

static WORKSPACE_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/w/:slug(?:/([^/]+))?(.*)$").unwrap_or_else(|e| unreachable!("{e}"))
});
static NESTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/:[^/]+/([^/]+)").unwrap_or_else(|e| unreachable!("{e}")));
static LAST_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^.*/w/:slug").unwrap_or_else(|e| unreachable!("{e}")));
static PARAM_THEN_SEGMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/:[^/]+/").unwrap_or_else(|e| unreachable!("{e}")));

fn action_for(method: &str, route_path: &str, nested_is_own_resource: bool) -> MemberAction {
    let verb = method.to_ascii_uppercase();
    match verb.as_str() {
        "GET" | "HEAD" | "OPTIONS" => return MemberAction::View,
        "DELETE" => return MemberAction::Delete,
        "PUT" | "PATCH" => return MemberAction::Update,
        _ => {}
    }
    let rest = LAST_PREFIX.replace(route_path, "");
    let last = rest.split('/').rfind(|s| !s.is_empty()).unwrap_or("");
    if last == "bulk-delete" {
        return MemberAction::Delete;
    }
    if last.starts_with(':') || POST_UPDATE.contains(&last) {
        return MemberAction::Update;
    }
    // `POST /projects/:id/updates` creates a child that is not its own resource: it edits the
    // project.
    if !nested_is_own_resource && PARAM_THEN_SEGMENT.is_match(&rest) {
        return MemberAction::Update;
    }
    MemberAction::Create
}

/// The member grant a workspace route needs (route pattern in NestJS form), or `None` when the
/// route is not work this table covers (members, tokens, settings, search, snapshot): those stay
/// gated by the role only. `POST /tasks` is `issues:create`, `PATCH /tasks/:id` is
/// `issues:update`.
#[must_use]
pub fn required_member_grant(method: &str, route_path: &str) -> Option<MemberGrant> {
    let caps = WORKSPACE_ROUTE.captures(route_path)?;
    let segment = caps.get(1)?.as_str();
    let rest = caps.get(2).map_or("", |m| m.as_str());
    let nested_resource = NESTED
        .captures(rest)
        .and_then(|c| c.get(1))
        .and_then(|nested| api_to_member(nested.as_str()));
    let resource = nested_resource.or_else(|| api_to_member(segment))?;
    Some(MemberGrant::new(resource, action_for(method, route_path, nested_resource.is_some())))
}

/// Is a record of this project outside `access`? Work without a project (`None` or `""`) is
/// hidden unless `include_unassigned`.
#[must_use]
pub fn project_hidden(access: Option<&MemberAccess>, project_id: Option<&str>) -> bool {
    let Some(access) = access.filter(|a| !a.projects.all) else { return false };
    match project_id.filter(|id| !id.is_empty()) {
        None => !access.include_unassigned,
        Some(id) => !access.projects.project_ids.iter().any(|p| p == id),
    }
}

/// Message of [`assert_can_use_project`].
pub const OUTSIDE_PROJECTS: &str = "Outside the projects you can access";

/// 403 when `project_id` is outside the current request's access; a no-op when access is not
/// narrowed.
///
/// # Errors
///
/// 403 `Outside the projects you can access`.
pub fn assert_can_use_project(project_id: Option<&str>) -> Result<(), AppError> {
    if project_hidden(current_access().as_deref(), project_id) {
        return Err(AppError::forbidden(OUTSIDE_PROJECTS));
    }
    Ok(())
}

/// The project filter of the current request for a list query, over `column` (`id` for projects,
/// `project_id` everywhere else); `None` when access is not narrowed.
#[must_use]
pub fn project_scope_condition(column: impl ColumnTrait) -> Option<Condition> {
    project_scope_expr(&Expr::col(column.as_column_ref()))
}

/// [`project_scope_condition`] over any expression, e.g. an aliased column of a join:
/// `&Expr::col((Alias::new("i"), issues::Column::ProjectId))`.
#[must_use]
pub fn project_scope_expr(column: &SimpleExpr) -> Option<Condition> {
    let access = current_access()?;
    if access.projects.all {
        return None;
    }
    let ids = &access.projects.project_ids;
    let col = || Expr::expr(column.clone());
    if ids.is_empty() {
        return Some(if access.include_unassigned {
            Condition::all().add(col().is_null())
        } else {
            Condition::all().add(Expr::cust("1 = 0"))
        });
    }
    let listed = col().is_in(ids.iter().cloned());
    Some(if access.include_unassigned {
        Condition::any().add(listed).add(col().is_null())
    } else {
        Condition::all().add(listed)
    })
}

/// Adds the current request's project filter to `query` (`applyProjectScope`).
#[must_use]
pub fn apply_project_scope<Q: QueryFilter>(query: Q, column: impl ColumnTrait) -> Q {
    match project_scope_condition(column) {
        Some(cond) => query.filter(cond),
        None => query,
    }
}

/// May the caller view `resource`? Always true when access is not narrowed.
#[must_use]
pub fn can_view(resource: MemberResource, access: Option<&MemberAccess>) -> bool {
    access.is_none_or(|a| a.grants.contains(&MemberGrant::new(resource, MemberAction::View)))
}

/// [`can_view`] with the current request's access.
#[must_use]
pub fn can_view_now(resource: MemberResource) -> bool {
    can_view(resource, current_access().as_deref())
}

/// Drops everything `access` cannot view from a snapshot (`scopeSnapshot`). `None` access
/// returns it unchanged. A visible issue whose parent is hidden loses its `parent_id`.
#[must_use]
pub fn scope_snapshot(
    mut snapshot: WorkspaceSnapshot,
    access: Option<&MemberAccess>,
) -> WorkspaceSnapshot {
    let Some(access) = access else { return snapshot };
    let allows = |resource| can_view(resource, Some(access));
    let project_ok = |id: Option<&str>| !project_hidden(Some(access), id);

    snapshot.projects = if allows(MemberResource::Projects) {
        std::mem::take(&mut snapshot.projects)
            .into_iter()
            .filter(|p| project_ok(Some(&p.id)))
            .collect()
    } else {
        Vec::new()
    };
    let mut issues: Vec<_> = if allows(MemberResource::Issues) {
        std::mem::take(&mut snapshot.issues)
            .into_iter()
            .filter(|i| project_ok(i.project_id.as_deref()))
            .collect()
    } else {
        Vec::new()
    };
    let issue_ids: HashSet<String> = issues.iter().map(|i| i.id.clone()).collect();
    for issue in &mut issues {
        if issue.parent_id.as_ref().is_some_and(|p| !issue_ids.contains(p)) {
            issue.parent_id = None;
        }
    }
    snapshot.issues = issues;
    snapshot.milestones = if allows(MemberResource::Milestones) {
        std::mem::take(&mut snapshot.milestones)
            .into_iter()
            .filter(|m| project_ok(Some(&m.project_id)))
            .collect()
    } else {
        Vec::new()
    };
    snapshot.artifacts = if allows(MemberResource::Artifacts) {
        std::mem::take(&mut snapshot.artifacts)
            .into_iter()
            .filter(|a| match &a.issue_id {
                Some(issue) if !issue.is_empty() => issue_ids.contains(issue),
                _ => access.include_unassigned,
            })
            .collect()
    } else {
        Vec::new()
    };

    let visible: HashMap<&str, HashSet<String>> = HashMap::from([
        ("project", snapshot.projects.iter().map(|p| p.id.clone()).collect()),
        ("issue", issue_ids.clone()),
        ("milestone", snapshot.milestones.iter().map(|m| m.id.clone()).collect()),
        ("artifact", snapshot.artifacts.iter().map(|a| a.id.clone()).collect()),
    ]);
    let ref_ok =
        |r: &LegacySubjectRef| visible.get(r.kind.as_str()).is_none_or(|ids| ids.contains(&r.id));
    let comments_ok = allows(MemberResource::Comments);
    snapshot.comments = if comments_ok {
        std::mem::take(&mut snapshot.comments).into_iter().filter(|c| ref_ok(&c.subject)).collect()
    } else {
        Vec::new()
    };
    if let Some(index) = snapshot.comment_index.take() {
        snapshot.comment_index = Some(if comments_ok {
            index.into_iter().filter(|c| ref_ok(&c.subject)).collect()
        } else {
            Vec::new()
        });
    }
    if !allows(MemberResource::Views) {
        snapshot.views = Vec::new();
    }
    snapshot.events =
        std::mem::take(&mut snapshot.events).into_iter().filter(|e| ref_ok(&e.subject)).collect();
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use trama_contracts::access::{
        access_within, effective_member_access, normalize_member_access, role_grants,
    };
    use trama_contracts::roles::{LegacyRole, WorkspaceRole};

    fn grant(s: &str) -> MemberGrant {
        MemberGrant::parse(s).unwrap()
    }

    fn grant_of(method: &str, route: &str) -> Option<String> {
        required_member_grant(method, route).map(|g| g.to_string())
    }

    #[test]
    fn splits_creating_an_issue_from_editing_one() {
        assert_eq!(grant_of("POST", "/api/w/:slug/issues").as_deref(), Some("issues:create"));
        assert_eq!(
            grant_of("PATCH", "/api/w/:slug/issues/:idOrKey").as_deref(),
            Some("issues:update")
        );
        assert_eq!(
            grant_of("DELETE", "/api/w/:slug/issues/:idOrKey").as_deref(),
            Some("issues:delete")
        );
        assert_eq!(grant_of("GET", "/api/w/:slug/issues").as_deref(), Some("issues:view"));
        assert_eq!(grant_of("POST", "/api/w/:slug/issues/bulk").as_deref(), Some("issues:update"));
        assert_eq!(
            grant_of("POST", "/api/w/:slug/issues/:idOrKey/comments").as_deref(),
            Some("comments:create")
        );
        assert_eq!(
            grant_of("POST", "/api/w/:slug/issues/:idOrKey/artifacts/upload").as_deref(),
            Some("artifacts:create")
        );
        assert_eq!(grant_of("GET", "/api/w/:slug/uploads/:id"), None);
        assert_eq!(
            grant_of("POST", "/api/w/:slug/tasks/bulk-delete").as_deref(),
            Some("issues:delete")
        );
        assert_eq!(
            grant_of("POST", "/api/w/:slug/projects/:id/updates").as_deref(),
            Some("projects:update")
        );
    }

    #[test]
    fn treats_the_thread_record_like_the_task_it_belongs_to() {
        assert_eq!(
            grant_of("POST", "/api/w/:slug/tasks/:idOrKey/thread/sync").as_deref(),
            Some("issues:update")
        );
        assert_eq!(
            grant_of("GET", "/api/w/:slug/tasks/:idOrKey/thread").as_deref(),
            Some("issues:view")
        );
        assert_eq!(grant_of("GET", "/api/w/:slug/decisions").as_deref(), Some("issues:view"));
    }

    #[test]
    fn leaves_workspace_administration_to_the_role() {
        assert_eq!(grant_of("POST", "/api/w/:slug/members"), None);
        assert_eq!(grant_of("GET", "/api/w/:slug/snapshot"), None);
        assert_eq!(grant_of("PATCH", "/api/w/:slug/settings"), None);
        assert_eq!(grant_of("GET", "/api/w/:slug"), None);
    }

    fn role(grants: Vec<MemberGrant>) -> WorkspaceRole {
        WorkspaceRole {
            id: "r".into(),
            name: "R".into(),
            owner: false,
            capabilities: Vec::new(),
            grants,
        }
    }

    #[test]
    fn normalize_member_access_stores_only_extras() {
        let member = role_grants(LegacyRole::Member);
        let viewer = role_grants(LegacyRole::Viewer);
        assert_eq!(
            normalize_member_access(
                &json!({ "projects": { "all": true }, "grants": member.iter().map(ToString::to_string).collect::<Vec<_>>() }),
                &member
            ),
            None
        );
        assert_eq!(normalize_member_access(&serde_json::Value::Null, &member), None);

        let access = normalize_member_access(
            &json!({ "projects": { "all": true }, "grants": ["issues:create"] }),
            &viewer,
        )
        .unwrap();
        assert_eq!(access.grants, [grant("issues:create")]);
        let scratch =
            normalize_member_access(&json!({ "grants": ["issues:create"] }), &[]).unwrap();
        assert!(scratch.grants.contains(&grant("issues:create")));
        assert!(scratch.grants.contains(&grant("issues:view")));
        assert!(!scratch.grants.contains(&grant("issues:update")));

        let dropped = normalize_member_access(
            &json!({ "grants": ["issues:view", "issues:create"] }),
            &viewer,
        )
        .unwrap();
        assert_eq!(dropped.grants, [grant("issues:create")]);
    }

    #[test]
    fn refuses_to_hand_out_a_role_or_projects_the_caller_lacks() {
        let member = role_grants(LegacyRole::Member);
        let viewer = role_grants(LegacyRole::Viewer);
        let stored = normalize_member_access(
            &json!({ "projects": { "all": false, "projectIds": ["pj_1"] }, "includeUnassigned": false, "grants": ["issues:create"] }),
            &viewer,
        )
        .unwrap();
        let caller = effective_member_access(Some(&role(viewer.clone())), Some(&stored)).unwrap();
        assert!(!access_within(None, Some(&caller), &viewer));
        assert!(access_within(Some(&stored), Some(&caller), &viewer));
        assert_eq!(
            normalize_member_access(&json!({ "projects": { "all": true }, "grants": [] }), &viewer),
            None
        );
        assert!(!access_within(None, Some(&caller), &member));
    }

    #[test]
    fn effective_access_is_unlimited_for_owners_and_full_members() {
        let owner = WorkspaceRole { owner: true, ..role(role_grants(LegacyRole::Owner)) };
        assert_eq!(effective_member_access(Some(&owner), None), None);
        assert_eq!(
            effective_member_access(Some(&role(role_grants(LegacyRole::Member))), None),
            None
        );

        let stored: MemberAccess = serde_json::from_value(json!({
            "projects": { "all": true, "projectIds": [] },
            "includeUnassigned": true,
            "grants": ["issues:create", "issues:view"],
        }))
        .unwrap();
        let access =
            effective_member_access(Some(&role(role_grants(LegacyRole::Viewer))), Some(&stored))
                .unwrap();
        assert!(access.grants.contains(&grant("issues:view")));
        assert!(access.grants.contains(&grant("issues:create")));
        assert!(!access.grants.contains(&grant("issues:update")));
    }

    fn limited() -> MemberAccess {
        normalize_member_access(
            &json!({ "projects": { "all": false, "projectIds": ["pj_1"] }, "includeUnassigned": false, "grants": ["issues:view"] }),
            &role_grants(LegacyRole::Viewer),
        )
        .unwrap()
    }

    #[test]
    fn hides_other_projects_and_unassigned_work() {
        let limited = limited();
        assert!(!project_hidden(Some(&limited), Some("pj_1")));
        assert!(project_hidden(Some(&limited), Some("pj_2")));
        assert!(project_hidden(Some(&limited), None));
        assert!(project_hidden(Some(&limited), Some("")));
        assert!(!project_hidden(None, Some("pj_2")));
    }

    fn snapshot() -> WorkspaceSnapshot {
        let ws = json!({ "id": "ws_1", "name": "W", "slug": "w", "settings": trama_contracts::settings::resolve_workspace_settings(&json!({})), "createdAt": "2026-01-01T00:00:00.000Z" });
        let user = json!({ "id": "u_1", "name": "U", "email": "u@x.dev", "avatarHue": 1, "createdAt": "2026-01-01T00:00:00.000Z" });
        let issue = |id: &str, project: Option<&str>, parent: Option<&str>| {
            let mut v = json!({
                "id": id, "workspaceId": "ws_1", "key": id, "number": 1, "kind": "bug", "title": id,
                "source": "manual", "priority": "none", "status": "backlog", "milestoneIds": [],
                "labels": [], "aliases": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
            });
            if let Some(p) = project {
                v["projectId"] = json!(p);
            }
            if let Some(p) = parent {
                v["parentId"] = json!(p);
            }
            v
        };
        let project = |id: &str| {
            json!({
                "id": id, "workspaceId": "ws_1", "name": id, "key": "PJ", "color": "#000000",
                "status": "backlog", "priority": "none", "labels": [],
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
            })
        };
        let milestone = |id: &str, project: &str| {
            json!({ "id": id, "workspaceId": "ws_1", "projectId": project, "name": id, "sortOrder": 0,
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" })
        };
        let comment = |subject: &str| {
            json!({ "id": format!("c_{subject}"), "workspaceId": "ws_1", "subject": { "type": "issue", "id": subject },
                    "author": { "type": "system" }, "body": "x",
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" })
        };
        let event = |subject: &str| {
            json!({ "id": format!("ev_{subject}"), "workspaceId": "ws_1", "at": "2026-01-01T00:00:00.000Z",
                    "actor": { "type": "system" }, "type": "issue.created",
                    "subject": { "type": "issue", "id": subject }, "data": {} })
        };
        serde_json::from_value(json!({
            "workspace": ws, "me": user, "myRole": "viewer", "users": [], "memberships": [], "agents": [],
            "projects": [project("pj_1"), project("pj_2")],
            "milestones": [milestone("ms_1", "pj_1"), milestone("ms_2", "pj_2")],
            "issues": [issue("in_1", Some("pj_1"), Some("in_2")), issue("in_2", Some("pj_2"), None), issue("in_3", None, None)],
            "artifacts": [],
            "comments": [comment("in_2"), comment("in_1")],
            "events": [event("in_2"), event("in_1"), { "id": "ev_ws", "workspaceId": "ws_1", "at": "2026-01-01T00:00:00.000Z",
                       "actor": { "type": "system" }, "type": "workstream.created",
                       "subject": { "type": "workstream", "id": "w_1" }, "data": {} }],
            "attention": [], "views": [], "integrations": [],
        }))
        .unwrap()
    }

    #[test]
    fn removes_hidden_projects_and_their_issues_from_a_snapshot() {
        let access = MemberAccess { grants: role_grants(LegacyRole::Member), ..limited() };
        let scoped = scope_snapshot(snapshot(), Some(&access));
        assert_eq!(scoped.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["pj_1"]);
        assert_eq!(scoped.issues.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["in_1"]);
        assert_eq!(scoped.issues[0].parent_id, None);
        assert_eq!(scoped.milestones.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["ms_1"]);
        assert_eq!(
            scoped.comments.iter().map(|c| c.subject.id.as_str()).collect::<Vec<_>>(),
            ["in_1"]
        );
        // events about retired subjects stay
        assert_eq!(
            scoped.events.iter().map(|e| e.subject.id.as_str()).collect::<Vec<_>>(),
            ["in_1", "w_1"]
        );
        assert_eq!(scope_snapshot(snapshot(), None), snapshot());

        // a viewer without comments:view loses every comment
        let no_comments = MemberAccess { grants: vec![grant("issues:view")], ..limited() };
        assert!(scope_snapshot(snapshot(), Some(&no_comments)).comments.is_empty());
        assert!(scope_snapshot(snapshot(), Some(&no_comments)).projects.is_empty());
    }

    #[tokio::test]
    async fn the_task_local_holds_the_request_access() {
        assert!(current_access().is_none());
        assert!(assert_can_use_project(Some("pj_2")).is_ok());
        let access = Some(Arc::new(limited()));
        with_access(access, async {
            assert!(current_access().is_some());
            assert!(assert_can_use_project(Some("pj_1")).is_ok());
            let err = assert_can_use_project(Some("pj_2")).unwrap_err();
            assert_eq!(err.status_code(), axum::http::StatusCode::FORBIDDEN);
            assert!(!can_view_now(MemberResource::Comments));
            assert!(project_scope_condition(trama_entities::issues::Column::ProjectId).is_some());
        })
        .await;
        assert!(project_scope_condition(trama_entities::issues::Column::ProjectId).is_none());
    }
}
