//! The projects routes against a real database and the real access guard: the project cases
//! of `projects.e2e-spec.ts`, `projects-repositories.e2e-spec.ts` and the project-icon part of
//! `project-views-icon.e2e-spec.ts`, the project tag and re-key cases of
//! `projects.service.spec.ts`, and the service functions the routing rules, the importers and
//! the invites call. `remove-project-updates-documents-migration.e2e-spec.ts` tests a TypeORM
//! migration and is not ported.

mod common;

use axum::http::StatusCode;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, QueryOrder, Statement,
};
use serde_json::{Value, json};
use trama_contracts::{activity::LiveEventEntity, common::ActorRef};
use trama_entities::{domain_events, issues, milestones};
use trama_projects::{NewProject, ProjectFilter, service};

use common::{Req, Res, World, agent_token, issue, milestone, narrowed, person, sql, workspace};

const PJ: &str = "/api/w/acme/projects";

/// A workspace `acme` with an owner, a member and a viewer.
struct Fx {
    w: World,
    owner: String,
    member: String,
    viewer: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    let member = person(w.db(), "ws_acme", "m1", "member").await;
    let viewer = person(w.db(), "ws_acme", "vw", "viewer").await;
    Some(Fx { w, owner, member, viewer })
}

impl Fx {
    async fn get(&self, cookie: &str, path: &str) -> Res {
        self.w.send(Req::get(path).session(cookie)).await
    }
    async fn post(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.w.send(Req::post(path).session(cookie).json(body)).await
    }
    async fn patch(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.w.send(Req::patch(path).session(cookie).json(body)).await
    }
    async fn delete(&self, cookie: &str, path: &str) -> Res {
        self.w.send(Req::delete(path).session(cookie)).await
    }

    /// A project made by the owner; panics unless it is created.
    async fn make(&self, body: Value) -> Value {
        let res = self.post(&self.owner, PJ, body).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body
    }

    async fn event_types(&self) -> Vec<String> {
        domain_events::Entity::find()
            .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
            .order_by_asc(domain_events::Column::At)
            .all(self.w.db())
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.r#type)
            .collect()
    }
}

fn id(project: &Value) -> String {
    project["id"].as_str().unwrap().to_owned()
}

fn uri(project: &Value) -> String {
    format!("{PJ}/{}", id(project))
}

// ── projects.e2e-spec.ts: CRUD with repository and lead; events ──

#[tokio::test]
async fn crud_with_repository_and_lead() {
    let Some(f) = fx().await else { return };
    let p = f
        .make(json!({
            "name": "Checkout v2", "summary": "Faster checkout", "repository": "acme/api",
            "leadId": "owner", "priority": "high"
        }))
        .await;
    assert!(id(&p).starts_with("pj_"));
    assert_eq!(p["status"], "backlog");
    assert_eq!(p["priority"], "high");
    assert_eq!(p["repository"], "acme/api");
    assert_eq!(p["leadId"], "owner");
    assert_eq!(p["color"], "#6b7280");
    assert_eq!(p["labels"], json!([]));

    // a lead who is not a member, and a bad color
    assert_eq!(
        f.post(&f.owner, PJ, json!({ "name": "Bad lead", "leadId": "us_missing" })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.post(&f.owner, PJ, json!({ "name": "Bad color", "color": "red" })).await.status,
        StatusCode::BAD_REQUEST
    );

    // status transitions set and clear completedAt
    let started = f
        .patch(
            &f.owner,
            &uri(&p),
            json!({ "status": "in_progress", "targetDate": "2026-12-01T00:00:00.000Z", "summary": null }),
        )
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.message());
    assert_eq!(started.body["status"], "in_progress");
    assert_eq!(started.body["targetDate"], "2026-12-01T00:00:00.000Z");
    assert!(started.body.get("summary").is_none());
    assert!(started.body.get("completedAt").is_none());
    let done = f.patch(&f.owner, &uri(&p), json!({ "status": "completed" })).await;
    assert!(done.body["completedAt"].as_str().is_some());
    let reopened = f.patch(&f.owner, &uri(&p), json!({ "status": "in_progress" })).await;
    assert!(reopened.body.get("completedAt").is_none());

    // the status filter no longer matches
    let list = f.get(&f.owner, &format!("{PJ}?status=backlog")).await;
    assert_eq!(list.body, json!([]));

    assert_eq!(f.delete(&f.owner, &uri(&p)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(f.get(&f.owner, &uri(&p)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&f.owner, &format!("{PJ}/pj_nope")).await.status, StatusCode::NOT_FOUND);

    let types = f.event_types().await;
    for expected in
        ["project.created", "project.updated", "project.status_changed", "project.deleted"]
    {
        assert!(types.iter().any(|t| t == expected), "{expected} in {types:?}");
    }
    f.w.drop().await;
}

// ── projects.e2e-spec.ts: health is a manual field ──

#[tokio::test]
async fn health_is_set_cleared_filtered_and_emitted_as_an_event() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Health demo", "health": "at_risk" })).await;
    assert_eq!(p["health"], "at_risk");
    let plain = f.make(json!({ "name": "No health yet" })).await;
    assert!(plain.get("health").is_none());

    assert_eq!(
        f.post(&f.owner, PJ, json!({ "name": "Bad health", "health": "great" })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.patch(&f.owner, &uri(&p), json!({ "health": "great" })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.patch(&f.owner, &uri(&p), json!({ "health": 42 })).await.status,
        StatusCode::BAD_REQUEST
    );

    let off = f.patch(&f.owner, &uri(&p), json!({ "health": "off_track" })).await;
    assert_eq!(off.body["health"], "off_track");
    // unrelated edits keep it
    let kept = f.patch(&f.owner, &uri(&p), json!({ "summary": "Still off track" })).await;
    assert_eq!(kept.body["health"], "off_track");

    let filtered = f.get(&f.owner, &format!("{PJ}?health=off_track")).await;
    let ids: Vec<&str> =
        filtered.body.as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [id(&p).as_str()]);

    let cleared = f.patch(&f.owner, &uri(&p), json!({ "health": null })).await;
    assert!(cleared.body.get("health").is_none());

    let rows = domain_events::Entity::find()
        .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
        .order_by_asc(domain_events::Column::At)
        .all(f.w.db())
        .await
        .unwrap();
    let pairs: Vec<String> = rows
        .iter()
        .filter(|e| e.r#type == "project.health_changed" && e.subject["id"] == id(&p))
        .map(|e| {
            format!(
                "{}>{}",
                e.data["from"].as_str().unwrap_or("none"),
                e.data["to"].as_str().unwrap_or("none")
            )
        })
        .collect();
    assert_eq!(pairs.len(), 2);
    assert!(pairs.contains(&"at_risk>off_track".to_owned()), "{pairs:?}");
    assert!(pairs.contains(&"off_track>none".to_owned()), "{pairs:?}");
    f.w.drop().await;
}

// ── projects-repositories.e2e-spec.ts ──

#[tokio::test]
async fn the_repository_is_trimmed_and_cleared_with_null() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Has repo", "repository": "  acme/web  " })).await;
    assert_eq!(p["repository"], "acme/web");

    let cleared = f.patch(&f.owner, &uri(&p), json!({ "repository": null })).await;
    assert!(cleared.body.get("repository").is_none());
    assert!(f.get(&f.owner, &uri(&p)).await.body.get("repository").is_none());

    assert_eq!(
        f.post(&f.owner, PJ, json!({ "name": "Too long", "repository": "x".repeat(2049) }))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    f.w.drop().await;
}

// ── project-views-icon.e2e-spec.ts: the project icon ──

#[tokio::test]
async fn icons_are_validated_and_null_clears() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Iconic", "icon": "rocket" })).await;
    assert_eq!(p["icon"], "rocket");
    for icon in ["bar-chart-3", "rocket", "🚀", "👩‍💻", "🇮🇹"] {
        let res = f.patch(&f.owner, &uri(&p), json!({ "icon": icon })).await;
        assert_eq!(res.body["icon"], icon);
    }
    let cleared = f.patch(&f.owner, &uri(&p), json!({ "icon": null })).await;
    assert!(cleared.body.get("icon").is_none());
    assert!(f.get(&f.owner, &uri(&p)).await.body.get("icon").is_none());

    // anything else is rejected, on create and on patch
    let too_long = "a".repeat(49);
    let bad = [
        "Rocket",
        "two words",
        "rocket-",
        "-rocket",
        "1rocket",
        "<script>",
        "🚀🚀",
        "🚀 ",
        "javascript:alert(1)",
        "",
        too_long.as_str(),
        "../x",
    ];
    for icon in bad {
        assert_eq!(
            f.patch(&f.owner, &uri(&p), json!({ "icon": icon })).await.status,
            StatusCode::BAD_REQUEST,
            "{icon}"
        );
    }
    for icon in ["Rocket", "🚀🚀", "<script>"] {
        assert_eq!(
            f.post(&f.owner, PJ, json!({ "name": "Nope", "icon": icon })).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        f.patch(&f.owner, &uri(&p), json!({ "icon": 42 })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert!(f.get(&f.owner, &uri(&p)).await.body.get("icon").is_none());
    f.w.drop().await;
}

// ── projects.service.spec.ts: project tags ──

#[tokio::test]
async fn tags_are_suggested_normalized_reserved_and_unique() {
    let Some(f) = fx().await else { return };
    // suggested from the name, and an explicit tag is normalized to upper case
    let trama = f.make(json!({ "name": "Trama" })).await;
    assert_eq!(trama["key"], "TRMA");
    let delta = f.make(json!({ "name": "Project delta", "key": "dlta" })).await;
    assert_eq!(delta["key"], "DLTA");
    // the same suggestion again gets a suffix
    let cora = f.make(json!({ "name": "Cora" })).await;
    assert_eq!(cora["key"], "CORA");
    let second = f.make(json!({ "name": "Cora" })).await;
    assert_eq!(second["key"], "COR1");

    // a taken tag is a 409
    let taken = f.post(&f.owner, PJ, json!({ "name": "Again", "key": "CORA" })).await;
    assert_eq!(taken.status, StatusCode::CONFLICT);
    assert_eq!(taken.message(), "Project tag \"CORA\" is already used");
    // keeping your own tag on an update is fine
    assert_eq!(
        f.patch(&f.owner, &uri(&cora), json!({ "key": "CORA" })).await.status,
        StatusCode::OK
    );

    // reserved prefixes
    let adr = f.post(&f.owner, PJ, json!({ "name": "Decision records", "key": "ADR" })).await;
    assert_eq!(adr.status, StatusCode::BAD_REQUEST);
    assert_eq!(adr.message(), "ADR is reserved for decision identifiers");
    let unpr = f.post(&f.owner, PJ, json!({ "name": "Unassigned", "key": "UNPR" })).await;
    assert_eq!(unpr.status, StatusCode::BAD_REQUEST);
    assert_eq!(unpr.message(), "UNPR is reserved for issues without a project");
    // a tag that is not 1 to 4 letters or digits starting with a letter
    let bad = f.post(&f.owner, PJ, json!({ "name": "Bad", "key": "1ABC" })).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.message(), "key must match /^[A-Za-z][A-Za-z0-9]{0,3}$/ regular expression");
    f.w.drop().await;
}

// ── projects.service.spec.ts: re-key on tag change ──

#[tokio::test]
async fn changing_the_tag_rekeys_the_issues_and_keeps_their_old_keys_as_aliases() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Cora", "key": "CORA" })).await;
    issue(f.w.db(), "ws_acme", "in_1", "CORA-8", 8, Some(&id(&p)), &[], &["BUG-3"]).await;
    let mut live = f.w.events.subscribe();

    let res = f.patch(&f.owner, &uri(&p), json!({ "key": "TRMA" })).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["key"], "TRMA");

    let issue_row = issues::Entity::find_by_id("in_1").one(f.w.db()).await.unwrap().unwrap();
    assert_eq!(issue_row.key, "TRMA-1");
    assert_eq!(issue_row.number, 1);
    assert_eq!(issue_row.aliases, json!(["BUG-3", "CORA-8"]));
    assert_eq!(issue_row.project_id.as_deref(), Some(id(&p).as_str()));

    let rows = domain_events::Entity::find()
        .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
        .filter(domain_events::Column::Type.ne("project.created"))
        .order_by_asc(domain_events::Column::At)
        .all(f.w.db())
        .await
        .unwrap();
    let kinds: Vec<&str> = rows.iter().map(|e| e.r#type.as_str()).collect();
    assert_eq!(kinds, ["issue.rekeyed", "project.updated"]);
    assert_eq!(rows[0].subject, json!({ "type": "issue", "id": "in_1" }));
    assert_eq!(
        rows[0].data,
        json!({
            "key": "TRMA-1", "from": "CORA-8", "to": "TRMA-1",
            "fromProjectId": id(&p), "toProjectId": id(&p),
            "reason": "project_tag_changed"
        })
    );
    assert_eq!(rows[1].data, json!({ "fields": ["key"] }));

    // the re-keyed issue and the project are announced on the live stream
    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        seen.push((published.event.entity, published.event.id.clone()));
    }
    assert!(seen.contains(&(LiveEventEntity::Issue, "in_1".to_owned())), "{seen:?}");
    assert!(seen.contains(&(LiveEventEntity::Project, id(&p))), "{seen:?}");
    f.w.drop().await;
}

// ── projects.service.ts: remove ──

#[tokio::test]
async fn deleting_rekeys_issues_to_unassigned_and_cleans_up_milestones() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Cora", "key": "CORA", "description": "the plan" })).await;
    milestone(f.w.db(), "ws_acme", "ms_1", &id(&p)).await;
    issue(f.w.db(), "ws_acme", "in_1", "CORA-8", 8, Some(&id(&p)), &["ms_1"], &["BUG-3"]).await;
    issue(f.w.db(), "ws_acme", "in_2", "CORA-9", 9, Some(&id(&p)), &[], &[]).await;
    // an issue of another project also naming the milestone is cleaned up too
    let other = f.make(json!({ "name": "Other", "key": "OTHR" })).await;
    issue(f.w.db(), "ws_acme", "in_3", "OTHR-1", 1, Some(&id(&other)), &["ms_1"], &[]).await;
    sql(
        f.w.db(),
        r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
           VALUES ('cm_1', 'ws_acme', '{"type":"milestone","id":"ms_1"}',
                   '{"type":"user","id":"owner"}', 'hi')"#,
    )
    .await;
    let mut live = f.w.events.subscribe();

    assert_eq!(f.delete(&f.owner, &uri(&p)).await.status, StatusCode::NO_CONTENT);

    // the issues are unassigned and re-keyed under UNPR, aliases kept
    let moved = |n: &str| {
        let db = f.w.db().clone();
        let n = n.to_owned();
        async move { issues::Entity::find_by_id(n).one(&db).await.unwrap().unwrap() }
    };
    let one = moved("in_1").await;
    assert_eq!(one.key, "UNPR-1");
    assert_eq!(one.number, 1);
    assert_eq!(one.aliases, json!(["BUG-3", "CORA-8"]));
    assert!(one.project_id.is_none());
    assert_eq!(one.milestone_ids, json!([]));
    let two = moved("in_2").await;
    assert_eq!(two.key, "UNPR-2");
    // the other project's issue keeps its project but loses the deleted milestone
    let three = moved("in_3").await;
    assert_eq!(three.key, "OTHR-1");
    assert_eq!(three.project_id.as_deref(), Some(id(&other).as_str()));
    assert_eq!(three.milestone_ids, json!([]));
    // the milestone and its comment are gone, and the project with it
    assert_eq!(milestones::Entity::find().all(f.w.db()).await.unwrap().len(), 0);
    let count = |query: &str| {
        let db = f.w.db().clone();
        let query = query.to_owned();
        async move {
            db.query_one_raw(Statement::from_string(DbBackend::Postgres, query))
                .await
                .unwrap()
                .unwrap()
                .try_get_by_index::<i64>(0)
                .unwrap()
        }
    };
    assert_eq!(count("SELECT count(*) FROM comments").await, 0);
    assert_eq!(count("SELECT count(*) FROM projects").await, 1);
    assert_eq!(f.get(&f.owner, &uri(&p)).await.status, StatusCode::NOT_FOUND);

    // the rekeys and the delete are announced
    let rows = domain_events::Entity::find()
        .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
        .filter(domain_events::Column::Type.ne("project.created"))
        .order_by_asc(domain_events::Column::At)
        .all(f.w.db())
        .await
        .unwrap();
    let kinds: Vec<&str> = rows.iter().map(|e| e.r#type.as_str()).collect();
    assert_eq!(kinds, ["issue.rekeyed", "issue.rekeyed", "project.deleted"]);
    assert_eq!(rows[0].data["reason"], "project_deleted");
    assert_eq!(rows[0].data["toProjectId"], Value::Null);
    assert_eq!(rows[2].data, json!({ "name": "Cora", "key": "CORA" }));
    let mut announced = Vec::new();
    while let Ok(published) = live.try_recv() {
        if published.event.entity == LiveEventEntity::Issue {
            announced.push(published.event.id.clone());
        }
    }
    announced.sort();
    assert_eq!(announced, ["in_1", "in_2"]);
    f.w.drop().await;
}

// ── text handling and filters ──

#[tokio::test]
async fn text_is_trimmed_and_the_list_filters_and_orders() {
    let Some(f) = fx().await else { return };
    let zebra = f.make(json!({ "name": "  Zebra rollout  ", "summary": "   " })).await;
    assert_eq!(zebra["name"], "Zebra rollout");
    assert!(zebra.get("summary").is_none());
    f.make(json!({ "name": "Checkout v2", "leadId": "owner" })).await;
    f.make(json!({ "name": "quagga", "key": "QGGA" })).await;

    let names = |query: &str| {
        let f = &f;
        let path = format!("{PJ}{query}");
        async move {
            let res = f.get(&f.owner, &path).await;
            assert_eq!(res.status, StatusCode::OK, "{}", res.message());
            res.body
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["name"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    // newest update first
    assert_eq!(names("").await, ["quagga", "Checkout v2", "Zebra rollout"]);
    // q is a case-insensitive substring of the name
    assert_eq!(names("?q=ZEB").await, ["Zebra rollout"]);
    assert_eq!(names("?q=quagga").await, ["quagga"]);
    assert_eq!(names("?q=nothing").await, Vec::<String>::new());
    // leadId
    assert_eq!(names("?leadId=owner").await, ["Checkout v2"]);
    assert_eq!(names("?leadId=vw").await, Vec::<String>::new());
    // status: seeded id, legacy enum and unknown
    assert_eq!(names("?status=planned").await.len(), 0);
    let planned = f.patch(&f.owner, &uri(&zebra), json!({ "status": "planned" })).await;
    assert_eq!(planned.body["status"], "planned");
    assert_eq!(names("?status=planned").await, ["Zebra rollout"]);
    assert_eq!(names("?status=zzz").await, Vec::<String>::new());
    // a repeated query key is a 400
    assert_eq!(f.get(&f.owner, &format!("{PJ}?q=a&q=b")).await.status, StatusCode::BAD_REQUEST);
    f.w.drop().await;
}

// ── labels ──

#[tokio::test]
async fn labels_are_validated_against_the_workspace_catalog() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Labeled", "labels": ["lb_p"] })).await;
    assert_eq!(p["labels"], json!(["lb_p"]));
    // the patch replaces the whole list
    let res = f.patch(&f.owner, &uri(&p), json!({ "labels": [] })).await;
    assert_eq!(res.body["labels"], json!([]));

    // unknown ids and labels of another scope are refused
    let unknown = f.post(&f.owner, PJ, json!({ "name": "Nope", "labels": ["lb_x"] })).await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown.message(), "Unknown label \"lb_x\"");
    let wrong_scope = f.post(&f.owner, PJ, json!({ "name": "Nope", "labels": ["lb_i"] })).await;
    assert_eq!(wrong_scope.status, StatusCode::BAD_REQUEST);
    f.w.drop().await;
}

// ── permissions ──

#[tokio::test]
async fn writes_need_manage_projects_and_reads_need_membership() {
    let Some(f) = fx().await else { return };
    let p = f.make(json!({ "name": "Guarded" })).await;
    let body = json!({ "name": "x" });
    // a viewer reads but cannot write
    assert_eq!(f.get(&f.viewer, PJ).await.status, StatusCode::OK);
    assert_eq!(f.get(&f.viewer, &uri(&p)).await.status, StatusCode::OK);
    assert_eq!(f.post(&f.viewer, PJ, body.clone()).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        f.patch(&f.viewer, &uri(&p), json!({ "name": "y" })).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.delete(&f.viewer, &uri(&p)).await.status, StatusCode::FORBIDDEN);
    // a member manages projects by default
    assert_eq!(f.post(&f.member, PJ, body).await.status, StatusCode::CREATED);
    // anonymous requests are refused
    assert_eq!(f.w.send(Req::get(PJ)).await.status, StatusCode::UNAUTHORIZED);
    // an agent token acts as itself
    let secret = agent_token(f.w.db(), "ws_acme", "ag_1").await;
    let res = f.w.send(Req::post(PJ).bearer(&secret).json(json!({ "name": "By bot" }))).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let event = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("project.created"))
        .order_by_desc(domain_events::Column::At)
        .one(f.w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.actor, json!({ "type": "agent", "id": "ag_1" }));
    f.w.drop().await;
}

// ── project scope (currentAccess / applyProjectScope) ──

#[tokio::test]
async fn a_narrowed_member_only_reaches_their_projects_and_cannot_create() {
    let Some(f) = fx().await else { return };
    let a = f.make(json!({ "name": "Alpha", "key": "ALFA" })).await;
    let b = f.make(json!({ "name": "Beta", "key": "BETA" })).await;
    let scoped = narrowed(f.w.db(), "ws_acme", "scoped", &[id(&a).as_str()], false).await;

    let list = f.get(&scoped, PJ).await;
    let ids: Vec<&str> =
        list.body.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [id(&a).as_str()]);
    assert_eq!(f.get(&scoped, &uri(&a)).await.status, StatusCode::OK);
    assert_eq!(f.get(&scoped, &uri(&b)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.patch(&scoped, &uri(&b), json!({ "name": "x" })).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.delete(&scoped, &uri(&b)).await.status, StatusCode::NOT_FOUND);
    // the list cannot grow through the API
    let res = f.post(&scoped, PJ, json!({ "name": "New" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Your access cannot add projects outside its list");
    // editing their own project works
    assert_eq!(
        f.patch(&scoped, &uri(&a), json!({ "name": "Alpha 2" })).await.status,
        StatusCode::OK
    );
    // a member with no project at all sees nothing
    let nobody = narrowed(f.w.db(), "ws_acme", "nobody", &[], false).await;
    assert_eq!(f.get(&nobody, PJ).await.body, json!([]));
    f.w.drop().await;
}

// ── service functions for the routing rules, the importers and the invites ──

#[tokio::test]
async fn the_service_lists_creates_and_reads_for_other_crates() {
    let Some(f) = fx().await else { return };
    // what the importers call (an actor, a name, and the rest optional)
    let created = service::create(
        &f.w.state,
        "ws_acme",
        &ActorRef::system(),
        NewProject { name: "Imported".into(), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(created.key, "IMPO");
    assert_eq!(created.status, "backlog");

    // what the routing rules and the project sharing of the invites call
    let row = service::get(f.w.db(), "ws_acme", &created.id).await.unwrap();
    assert_eq!(row.name, "Imported");
    assert_eq!(row.key, "IMPO");
    let err = service::get(f.w.db(), "ws_acme", "pj_nope").await.unwrap_err();
    assert_eq!(err.status_code(), StatusCode::NOT_FOUND);
    assert!(err.to_string().ends_with("Project \"pj_nope\" not found"));

    // what the workspace snapshot embeds
    let listed = service::list(f.w.db(), "ws_acme", ProjectFilter::default()).await.unwrap();
    assert!(listed.contains(&created));
    assert!(
        service::list(f.w.db(), "ws_other", ProjectFilter::default()).await.unwrap().is_empty()
    );
    f.w.drop().await;
}
