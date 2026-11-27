//! `event-visibility.service.spec.ts` against real rows, plus the history side of
//! `events-visibility.e2e-spec.ts`.

mod common;

use serde_json::json;
use trama_contracts::access::{
    MemberAccess, MemberAction, MemberGrant, MemberProjectScope, MemberResource,
};
use trama_contracts::activity::{LiveEvent, LiveEventEntity, LiveEventType};
use trama_contracts::common::LegacySubjectRef;
use trama_events::visibility::{ScopedRef, filter_events, is_live_visible};

use common::{World, artifact, comment, issue, milestone, project, workspace};

const VIEW_GRANTS: [MemberGrant; 5] = [
    MemberGrant::new(MemberResource::Projects, MemberAction::View),
    MemberGrant::new(MemberResource::Issues, MemberAction::View),
    MemberGrant::new(MemberResource::Milestones, MemberAction::View),
    MemberGrant::new(MemberResource::Artifacts, MemberAction::View),
    MemberGrant::new(MemberResource::Comments, MemberAction::View),
];

fn access(project_ids: &[&str], include_unassigned: bool, grants: &[MemberGrant]) -> MemberAccess {
    MemberAccess {
        projects: MemberProjectScope {
            all: false,
            project_ids: project_ids.iter().map(|id| (*id).to_owned()).collect(),
        },
        include_unassigned,
        grants: grants.to_vec(),
    }
}

fn narrowed(project_ids: &[&str], include_unassigned: bool) -> MemberAccess {
    access(project_ids, include_unassigned, &VIEW_GRANTS)
}

/// `pr_1` with its issue `iss_1`, milestone `ms_1`, artifact `ar_1` and comment `cm_1`.
async fn world() -> Option<World> {
    let w = World::new().await?;
    workspace(w.db(), "1").await;
    project(w.db(), "ws_1", "pr_1").await;
    issue(w.db(), "ws_1", "iss_1", Some("pr_1")).await;
    milestone(w.db(), "ws_1", "ms_1", "pr_1").await;
    artifact(w.db(), "ws_1", "ar_1", Some("iss_1")).await;
    comment(w.db(), "ws_1", "cm_1", json!({ "type": "issue", "id": "iss_1" })).await;
    Some(w)
}

const REFS: [(&str, &str); 5] = [
    ("project", "pr_1"),
    ("issue", "iss_1"),
    ("milestone", "ms_1"),
    ("artifact", "ar_1"),
    ("import", "imp_1"),
];

fn refs() -> Vec<ScopedRef> {
    REFS.iter().map(|(kind, id)| ScopedRef::new(*kind, *id)).collect()
}

async fn visible(w: &World, events: Vec<ScopedRef>, access: &MemberAccess) -> Vec<ScopedRef> {
    filter_events(w.db(), "ws_1", events, Some(access)).await.unwrap()
}

#[tokio::test]
async fn keeps_visible_events_for_every_subject_type_and_workspace_level_ones_only_as_unassigned() {
    let Some(w) = world().await else { return };
    assert_eq!(visible(&w, refs(), &narrowed(&["pr_1"], true)).await, refs());
    let import = refs().split_off(4);
    assert_eq!(visible(&w, import, &narrowed(&["pr_1"], false)).await, vec![]);
    w.drop().await;
}

#[tokio::test]
async fn everything_is_visible_without_a_project_limit() {
    let Some(w) = world().await else { return };
    let events = vec![ScopedRef::new("workstream", "wk_1"), ScopedRef::new("issue", "nope")];
    assert_eq!(filter_events(w.db(), "ws_1", events.clone(), None).await.unwrap(), events);
    let all = MemberAccess {
        projects: MemberProjectScope::every(),
        include_unassigned: false,
        grants: Vec::new(),
    };
    assert_eq!(filter_events(w.db(), "ws_1", events.clone(), Some(&all)).await.unwrap(), events);
    let none: Vec<ScopedRef> = Vec::new();
    assert!(
        filter_events(w.db(), "ws_1", none, Some(&narrowed(&["pr_1"], true)))
            .await
            .unwrap()
            .is_empty()
    );
    w.drop().await;
}

#[tokio::test]
async fn drops_hidden_legacy_unresolved_and_unknown_subjects_rather_than_treating_them_as_unassigned()
 {
    let Some(w) = world().await else { return };
    let events = vec![
        ScopedRef::new("project", "pr_1"),
        ScopedRef::new("workstream", "wk_1"),
        ScopedRef::new("issue", "iss_missing"),
    ];
    assert_eq!(visible(&w, events, &narrowed(&["pr_2"], true)).await, vec![]);
    w.drop().await;
}

#[tokio::test]
async fn does_not_infer_unassigned_visibility_for_deleted_objects_with_unresolved_hidden_owners() {
    let Some(w) = world().await else { return };
    let events = vec![
        ScopedRef::new("artifact", "ar_deleted").with_data(json!({ "issueId": "iss_missing" })),
    ];
    assert_eq!(visible(&w, events, &narrowed(&["pr_1"], true)).await, vec![]);
    w.drop().await;
}

#[tokio::test]
async fn scopes_a_deleted_artifact_to_the_task_its_event_names() {
    let Some(w) = world().await else { return };
    let events =
        vec![ScopedRef::new("artifact", "ar_deleted").with_data(json!({ "issueId": "iss_1" }))];
    assert_eq!(visible(&w, events.clone(), &narrowed(&["pr_1"], false)).await, events);
    assert_eq!(visible(&w, events, &narrowed(&["pr_2"], true)).await, vec![]);
    w.drop().await;
}

#[tokio::test]
async fn scopes_deleted_issues_and_milestones_by_the_project_their_event_names() {
    let Some(w) = world().await else { return };
    let issue = ScopedRef::new("issue", "iss_gone").with_data(json!({ "projectId": "pr_1" }));
    let milestone =
        ScopedRef::new("milestone", "ms_gone").with_data(json!({ "projectId": "pr_1" }));
    let unassigned = ScopedRef::new("issue", "iss_none").with_data(json!({ "projectId": null }));
    let events = vec![issue.clone(), milestone.clone(), unassigned.clone()];
    assert_eq!(
        visible(&w, events.clone(), &narrowed(&["pr_1"], false)).await,
        vec![issue.clone(), milestone.clone()]
    );
    assert_eq!(visible(&w, events, &narrowed(&["pr_2"], true)).await, vec![unassigned]);
    // an issue without a project is unassigned work
    issue_without_project(&w).await;
    let bare = vec![ScopedRef::new("issue", "iss_bare")];
    assert_eq!(visible(&w, bare.clone(), &narrowed(&["pr_1"], true)).await, bare);
    assert_eq!(visible(&w, bare, &narrowed(&["pr_1"], false)).await, vec![]);
    w.drop().await;
}

async fn issue_without_project(w: &World) {
    issue(w.db(), "ws_1", "iss_bare", None).await;
}

#[tokio::test]
async fn requires_resource_grants_and_comments_access_before_exposing_excerpts() {
    let Some(w) = world().await else { return };
    let issue_event = ScopedRef::new("issue", "iss_1");
    let comment_event = ScopedRef::new("issue", "iss_1")
        .with_type("comment.created")
        .with_data(json!({ "excerpt": "private excerpt" }));

    assert_eq!(visible(&w, vec![issue_event], &access(&["pr_1"], false, &[])).await, vec![]);
    let without_comments: Vec<MemberGrant> =
        VIEW_GRANTS.iter().copied().filter(|g| g.resource != MemberResource::Comments).collect();
    assert_eq!(
        visible(&w, vec![comment_event.clone()], &access(&["pr_1"], false, &without_comments))
            .await,
        vec![]
    );
    assert_eq!(
        visible(&w, vec![comment_event.clone()], &narrowed(&["pr_1"], false)).await,
        vec![comment_event]
    );
    w.drop().await;
}

fn live(entity: LiveEventEntity, id: &str, kind: LiveEventType) -> LiveEvent {
    LiveEvent { kind, entity, id: id.to_owned(), client_id: None, at: "now".to_owned() }
}

fn issue_ref(id: &str) -> LegacySubjectRef {
    serde_json::from_value(json!({ "type": "issue", "id": id })).unwrap()
}

#[tokio::test]
async fn uses_the_original_comment_subject_for_live_comment_messages() {
    let Some(w) = world().await else { return };
    let event = live(LiveEventEntity::Comment, "cm_1", LiveEventType::Updated);
    let check = |access: MemberAccess, subject: Option<LegacySubjectRef>| {
        let (db, event) = (w.db().clone(), event.clone());
        async move {
            is_live_visible(&db, "ws_1", &event, Some(&access), subject.as_ref()).await.unwrap()
        }
    };
    assert!(check(narrowed(&["pr_1"], false), Some(issue_ref("iss_1"))).await);
    assert!(!check(narrowed(&["pr_2"], false), Some(issue_ref("iss_1"))).await);
    // without the subject, the stored comment names it
    assert!(check(narrowed(&["pr_1"], false), None).await);
    assert!(!check(narrowed(&["pr_2"], false), None).await);
    // a comment that is gone has no owner to resolve
    let gone = live(LiveEventEntity::Comment, "cm_gone", LiveEventType::Deleted);
    let access = narrowed(&["pr_1"], true);
    assert!(!is_live_visible(w.db(), "ws_1", &gone, Some(&access), None).await.unwrap());
    w.drop().await;
}

#[tokio::test]
async fn live_events_are_scoped_by_their_entity() {
    let Some(w) = world().await else { return };
    let narrow = narrowed(&["pr_1"], false);
    let check = |event: LiveEvent, access: Option<&MemberAccess>| {
        let db = w.db().clone();
        let access = access.cloned();
        async move { is_live_visible(&db, "ws_1", &event, access.as_ref(), None).await.unwrap() }
    };
    // no limit: everything
    assert!(check(live(LiveEventEntity::Issue, "nope", LiveEventType::Created), None).await);
    // the entity names its own subject
    assert!(
        check(live(LiveEventEntity::Issue, "iss_1", LiveEventType::Updated), Some(&narrow)).await
    );
    assert!(
        !check(
            live(LiveEventEntity::Issue, "iss_1", LiveEventType::Updated),
            Some(&narrowed(&["pr_2"], true))
        )
        .await
    );
    assert!(
        check(live(LiveEventEntity::Project, "pr_1", LiveEventType::Updated), Some(&narrow)).await
    );
    assert!(
        !check(live(LiveEventEntity::Project, "pr_2", LiveEventType::Updated), Some(&narrow)).await
    );
    assert!(
        check(live(LiveEventEntity::Milestone, "ms_1", LiveEventType::Created), Some(&narrow))
            .await
    );
    assert!(
        check(live(LiveEventEntity::Artifact, "ar_1", LiveEventType::Created), Some(&narrow)).await
    );
    // workspace-level entities need `includeUnassigned`
    let workspace_level = live(LiveEventEntity::Workspace, "ws_1", LiveEventType::Updated);
    assert!(!check(workspace_level.clone(), Some(&narrow)).await);
    assert!(check(workspace_level, Some(&narrowed(&["pr_1"], true))).await);
    for entity in [LiveEventEntity::Membership, LiveEventEntity::View, LiveEventEntity::Webhook] {
        let event = live(entity, "x_1", LiveEventType::Created);
        assert!(check(event.clone(), Some(&narrowed(&["pr_1"], true))).await, "{entity:?}");
        assert!(!check(event, Some(&narrow)).await, "{entity:?}");
    }
    // the resource grant is needed too
    let no_issue_grant = access(&["pr_1"], false, &[]);
    assert!(
        !check(
            live(LiveEventEntity::Issue, "iss_1", LiveEventType::Updated),
            Some(&no_issue_grant)
        )
        .await
    );
    w.drop().await;
}
