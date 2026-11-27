//! The public service API against a database: `issues-bulk`, `issues-external-ref`,
//! `issue-project-keys` and `issues.service` (list limit, parent link under the lock).

mod common;

use std::sync::Arc;

use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde_json::json;
use trama_auth::member_access::with_access;
use trama_contracts::access::{MemberAccess, MemberProjectScope};
use trama_contracts::common::{ActorRef, Priority};
use trama_contracts::imports::{
    ExternalProvider, ExternalRef, ExternalRefOrigin, ExternalStateType,
};
use trama_contracts::issues::IssueKind;
use trama_core::AppError;
use trama_entities::{comments, domain_events, issues};
use trama_issues::service::{
    self, BulkIssuePatch, ExternalRefRefresh, IssueFilter, IssueInput, NewIssue,
};

use common::{World, issue, person, project, sql, workspace};

fn actor() -> ActorRef {
    ActorRef::user("u_me")
}

/// The message of an error, without the status `Display` puts in front of it.
fn message(err: &AppError) -> String {
    err.to_string().split_once(": ").map(|(_, m)| m.to_owned()).unwrap_or_default()
}

/// The HTTP status of an error, read from its `Display`.
fn code(err: &AppError) -> u16 {
    err.to_string()[..3].parse().unwrap()
}

/// `acme` with the person `u_me` and `u_other`, a project `pj_a` (tag `AUTH`) and a project
/// `pj_b` (tag `TRMA`).
async fn setup() -> Option<World> {
    let w = World::new().await?;
    let db = w.db();
    workspace(db, "acme").await;
    person(db, "acme", "u_me", "member", None).await;
    person(db, "acme", "u_other", "member", None).await;
    project(db, "ws_acme", "pj_a", "AUTH").await;
    project(db, "ws_acme", "pj_b", "TRMA").await;
    Some(w)
}

async fn row(w: &World, id: &str) -> issues::Model {
    issues::Entity::find_by_id(id).one(w.db()).await.unwrap().unwrap()
}

async fn event_types(w: &World) -> Vec<String> {
    domain_events::Entity::find()
        .order_by_asc(domain_events::Column::At)
        .all(w.db())
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.r#type)
        .collect()
}

fn limited(project_ids: &[&str], include_unassigned: bool) -> Arc<MemberAccess> {
    Arc::new(MemberAccess {
        projects: MemberProjectScope {
            all: false,
            project_ids: project_ids.iter().map(|id| (*id).to_owned()).collect(),
        },
        include_unassigned,
        grants: Vec::new(),
    })
}

fn external() -> ExternalRef {
    ExternalRef {
        provider: ExternalProvider::Github,
        id: "acme/api#12".into(),
        url: "https://github.com/acme/api/issues/12".into(),
        key: Some("#12".into()),
        state: Some("Open".into()),
        state_type: Some(ExternalStateType::Open),
        synced_at: None,
        origin: ExternalRefOrigin::Link,
    }
}

fn refs(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

// ───────────────────────── IssuesService.getMany ─────────────────────────

#[tokio::test]
async fn get_many_returns_rows_in_input_order_and_folds_duplicates() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "in_b", "BUG-2", None, &[]).await;
    let rows =
        service::get_many(w.db(), "ws_acme", &refs(&["in_b", "in_a", "in_b"])).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["in_b", "in_a"]);
    w.drop().await;
}

#[tokio::test]
async fn get_many_404s_naming_every_unknown_reference() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    let err =
        service::get_many(w.db(), "ws_acme", &refs(&["in_a", "in_x", "in_y"])).await.unwrap_err();
    assert_eq!(code(&err), 404);
    assert!(message(&err).contains("in_x, in_y"), "{err}");
    w.drop().await;
}

#[tokio::test]
async fn get_many_resolves_ids_keys_and_aliases_and_hides_projects() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    project(db, "ws_acme", "pj_ok", "OKAY").await;
    project(db, "ws_acme", "pj_hidden", "HIDE").await;
    issue(db, "ws_acme", "in_a", "AUTH-1", Some("pj_ok"), &["OLD-1"]).await;
    issue(db, "ws_acme", "in_b", "AUTH-2", Some("pj_ok"), &[]).await;
    issue(db, "ws_acme", "in_h", "AUTH-3", Some("pj_hidden"), &[]).await;
    let access = limited(&["pj_ok"], true);

    let err = with_access(
        Some(access.clone()),
        service::get_many(db, "ws_acme", &refs(&["auth-2", "OLD-1", "in_a", "AUTH-3", "auth-2"])),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&err), 404);
    assert!(message(&err).contains("AUTH-3"), "{err}");

    let rows = with_access(
        Some(access),
        service::get_many(db, "ws_acme", &refs(&["auth-2", "OLD-1", "in_a", "auth-2"])),
    )
    .await
    .unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["in_b", "in_a"]);
    w.drop().await;
}

// ───────────────────────── IssuesService.updateMany ─────────────────────────

#[tokio::test]
async fn update_many_rejects_an_empty_patch() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    let rows = vec![row(&w, "in_a").await];
    let err = service::update_many(&w.state, "ws_acme", &actor(), rows, BulkIssuePatch::default())
        .await
        .unwrap_err();
    assert_eq!(code(&err), 400);
    assert!(message(&err).contains("at least one field"), "{err}");
    assert!(event_types(&w).await.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn update_many_applies_status_and_priority_to_every_issue_and_records_events_after_the_commit()
 {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "in_b", "BUG-2", None, &[]).await;
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await];
    let patch = BulkIssuePatch {
        status: Some("in_review".into()),
        priority: Some(Priority::High),
        ..BulkIssuePatch::default()
    };
    let out = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap();
    assert_eq!(
        out.iter().map(|r| (r.status.as_str(), r.priority.as_str())).collect::<Vec<_>>(),
        [("in_review", "high"), ("in_review", "high")]
    );
    for id in ["in_a", "in_b"] {
        let stored = row(&w, id).await;
        assert_eq!((stored.status.as_str(), stored.priority.as_str()), ("in_review", "high"));
    }
    let types = event_types(&w).await;
    assert_eq!(types.iter().filter(|t| *t == "issue.status_changed").count(), 2);
    assert_eq!(types.iter().filter(|t| *t == "issue.updated").count(), 2);
    w.drop().await;
}

#[tokio::test]
async fn update_many_an_unknown_reference_rejects_the_whole_batch_before_anything_is_written() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "in_b", "BUG-2", None, &[]).await;
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await];
    let patch =
        BulkIssuePatch { assignee_id: Some(Some("u_nobody".into())), ..BulkIssuePatch::default() };
    let err =
        service::update_many(&w.state, "ws_acme", &actor(), rows.clone(), patch).await.unwrap_err();
    assert_eq!(code(&err), 400);
    assert!(message(&err).contains("Not workspace members"), "{err}");
    let patch =
        BulkIssuePatch { project_id: Some(Some("pj_nope".into())), ..BulkIssuePatch::default() };
    let err = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap_err();
    assert_eq!(code(&err), 400);
    assert!(event_types(&w).await.is_empty());
    assert_eq!(row(&w, "in_a").await.assignee_id, None);
    assert_eq!(row(&w, "in_a").await.project_id, None);
    w.drop().await;
}

#[tokio::test]
async fn update_many_validates_the_assignee_and_project_once_and_applies_them_to_all() {
    let Some(w) = setup().await else { return };
    for (id, key) in [("in_a", "BUG-1"), ("in_b", "BUG-2"), ("in_c", "BUG-3")] {
        issue(w.db(), "ws_acme", id, key, None, &[]).await;
    }
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await, row(&w, "in_c").await];
    let patch = BulkIssuePatch {
        assignee_id: Some(Some("u_other".into())),
        project_id: Some(Some("pj_a".into())),
        ..BulkIssuePatch::default()
    };
    let out = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap();
    for stored in &out {
        assert_eq!(stored.assignee_id.as_deref(), Some("u_other"));
        assert_eq!(stored.project_id.as_deref(), Some("pj_a"));
        // moving to a project re-keys the issue and keeps the former key
        assert!(stored.key.starts_with("AUTH-"), "{}", stored.key);
    }
    let types = event_types(&w).await;
    assert_eq!(types.iter().filter(|t| *t == "issue.rekeyed").count(), 3);
    w.drop().await;
}

#[tokio::test]
async fn update_many_adds_and_removes_labels_per_issue_instead_of_replacing_them() {
    let Some(w) = setup().await else { return };
    let labels: Vec<_> = ["lb_1", "lb_2", "lb_3"]
        .iter()
        .map(|id| json!({ "id": id, "name": id, "color": "#112233", "template": false, "scope": "issue" }))
        .collect();
    sql(
        w.db(),
        &format!(r#"UPDATE workspaces SET settings = settings || '{{"labels": {}}}'::jsonb WHERE id = 'ws_acme'"#, json!(labels)),
    )
    .await;
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "in_b", "BUG-2", None, &[]).await;
    sql(w.db(), r#"UPDATE issues SET labels = '["lb_1","lb_2"]' WHERE id = 'in_a'"#).await;
    sql(w.db(), r#"UPDATE issues SET labels = '["lb_2"]' WHERE id = 'in_b'"#).await;
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await];
    let patch = BulkIssuePatch {
        add_labels: Some(refs(&["lb_3"])),
        remove_labels: Some(refs(&["lb_2"])),
        ..BulkIssuePatch::default()
    };
    let out = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap();
    assert_eq!(out[0].labels, json!(["lb_1", "lb_3"]));
    assert_eq!(out[1].labels, json!(["lb_3"]));
    assert_eq!(row(&w, "in_b").await.labels, json!(["lb_3"]));

    // a label both added and removed is refused
    let rows = vec![row(&w, "in_a").await];
    let patch = BulkIssuePatch {
        add_labels: Some(refs(&["lb_1"])),
        remove_labels: Some(refs(&["lb_1"])),
        ..BulkIssuePatch::default()
    };
    let err = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap_err();
    assert!(message(&err).contains("both added and removed"), "{err}");
    w.drop().await;
}

#[tokio::test]
async fn update_many_preserves_the_current_parent_when_it_saves_a_stale_row() {
    let Some(w) = setup().await else { return };
    for (id, key) in [("in_child", "BUG-1"), ("in_old", "BUG-2"), ("in_current", "BUG-3")] {
        issue(w.db(), "ws_acme", id, key, None, &[]).await;
    }
    sql(w.db(), r#"UPDATE issues SET "parentId" = 'in_old' WHERE id = 'in_child'"#).await;
    let stale = row(&w, "in_child").await;
    // the parent changes after the row was read
    sql(w.db(), r#"UPDATE issues SET "parentId" = 'in_current' WHERE id = 'in_child'"#).await;
    let patch = BulkIssuePatch { priority: Some(Priority::High), ..BulkIssuePatch::default() };
    let out =
        service::update_many(&w.state, "ws_acme", &actor(), vec![stale], patch).await.unwrap();
    assert_eq!(out[0].parent_id.as_deref(), Some("in_current"));
    assert_eq!(row(&w, "in_child").await.parent_id.as_deref(), Some("in_current"));
    w.drop().await;
}

#[tokio::test]
async fn update_many_a_person_claims_unassigned_issues_moved_to_in_progress() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "in_b", "BUG-2", None, &[]).await;
    sql(w.db(), r#"UPDATE issues SET "assigneeId" = 'u_other' WHERE id = 'in_b'"#).await;
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await];
    let patch = BulkIssuePatch { status: Some("in_progress".into()), ..BulkIssuePatch::default() };
    let out = service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap();
    assert_eq!(
        out.iter().map(|r| r.assignee_id.as_deref()).collect::<Vec<_>>(),
        [Some("u_me"), Some("u_other")]
    );
    // an agent does not claim
    issue(w.db(), "ws_acme", "in_c", "BUG-3", None, &[]).await;
    let rows = vec![row(&w, "in_c").await];
    let patch = BulkIssuePatch { status: Some("in_progress".into()), ..BulkIssuePatch::default() };
    let agent = ActorRef::agent("ag_me");
    let out = service::update_many(&w.state, "ws_acme", &agent, rows, patch).await.unwrap();
    assert_eq!(out[0].assignee_id, None);
    w.drop().await;
}

#[tokio::test]
async fn update_many_skips_the_status_event_when_the_status_does_not_change() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_a", "BUG-1", None, &[]).await;
    sql(w.db(), r"UPDATE issues SET status = 'done' WHERE id = 'in_a'").await;
    let rows = vec![row(&w, "in_a").await];
    let patch = BulkIssuePatch { status: Some("done".into()), ..BulkIssuePatch::default() };
    service::update_many(&w.state, "ws_acme", &actor(), rows, patch).await.unwrap();
    assert!(!event_types(&w).await.contains(&"issue.status_changed".to_owned()));
    w.drop().await;
}

// ───────────────────────── IssuesService.removeMany ─────────────────────────

#[tokio::test]
async fn remove_many_deletes_comments_duplicate_links_and_issues_in_one_go() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    issue(db, "ws_acme", "in_a", "BUG-1", None, &[]).await;
    issue(db, "ws_acme", "in_b", "BUG-2", None, &[]).await;
    issue(db, "ws_acme", "in_dup", "BUG-3", None, &[]).await;
    sql(db, r#"UPDATE issues SET "duplicateOfId" = 'in_a' WHERE id = 'in_dup'"#).await;
    for id in ["in_a", "in_b"] {
        sql(
            db,
            &format!(
                r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
                   VALUES ('cm_{id}', 'ws_acme', '{{"type":"issue","id":"{id}"}}', '{{"type":"system"}}', 'x')"#
            ),
        )
        .await;
    }
    let rows = vec![row(&w, "in_a").await, row(&w, "in_b").await];
    service::remove_many(&w.state, "ws_acme", &actor(), &rows).await.unwrap();
    assert_eq!(comments::Entity::find().count(db).await.unwrap(), 0);
    let remaining = issues::Entity::find().all(db).await.unwrap();
    assert_eq!(remaining.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["in_dup"]);
    assert_eq!(remaining[0].duplicate_of_id, None);
    assert_eq!(event_types(&w).await, ["issue.deleted", "issue.deleted"]);
    w.drop().await;
}

#[tokio::test]
async fn remove_many_leaves_everything_when_a_hierarchy_neighbour_is_hidden() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    project(db, "ws_acme", "pj_ok", "OKAY").await;
    project(db, "ws_acme", "pj_hidden", "HIDE").await;
    issue(db, "ws_acme", "in_parent", "OKAY-1", Some("pj_ok"), &[]).await;
    issue(db, "ws_acme", "in_child", "HIDE-1", Some("pj_hidden"), &[]).await;
    sql(db, r#"UPDATE issues SET "parentId" = 'in_parent' WHERE id = 'in_child'"#).await;
    let rows = vec![row(&w, "in_parent").await];
    let err = with_access(
        Some(limited(&["pj_ok"], true)),
        service::remove_many(&w.state, "ws_acme", &actor(), &rows),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&err), 404);
    assert_eq!(issues::Entity::find().count(db).await.unwrap(), 2);
    assert_eq!(row(&w, "in_child").await.parent_id.as_deref(), Some("in_parent"));
    assert!(event_types(&w).await.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn remove_many_detaches_surviving_children_and_records_the_hierarchy_change() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    issue(db, "ws_acme", "in_parent", "BUG-1", None, &[]).await;
    issue(db, "ws_acme", "in_child", "BUG-2", None, &[]).await;
    sql(db, r#"UPDATE issues SET "parentId" = 'in_parent' WHERE id = 'in_child'"#).await;
    let rows = vec![row(&w, "in_parent").await];
    service::remove_many(&w.state, "ws_acme", &actor(), &rows).await.unwrap();
    assert_eq!(row(&w, "in_child").await.parent_id, None);
    assert_eq!(event_types(&w).await, ["issue.deleted", "issue.updated"]);
    let updated = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("issue.updated"))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.subject, json!({ "type": "issue", "id": "in_child" }));
    assert_eq!(updated.data["fields"], json!(["parentId"]));
    w.drop().await;
}

// ───────────────────────── IssuesService external reference ─────────────────────────

#[tokio::test]
async fn set_external_ref_stores_the_pointer_fills_the_link_and_records_what_changed() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "iss_1", "BUG-1", None, &[]).await;
    let res = service::set_external_ref(&w.state, "ws_acme", &actor(), "iss_1", Some(&external()))
        .await
        .unwrap();
    assert_eq!(res.external_ref, Some(external()));
    assert_eq!(row(&w, "iss_1").await.external_url.as_deref(), Some(external().url.as_str()));
    let event = domain_events::Entity::find().one(w.db()).await.unwrap().unwrap();
    assert_eq!(event.r#type, "issue.updated");
    assert_eq!(event.data["fields"], json!(["externalRef"]));
    assert_eq!(
        event.data["external"],
        json!({ "provider": "github", "key": "#12", "origin": "link" })
    );
    w.drop().await;
}

#[tokio::test]
async fn set_external_ref_keeps_an_url_a_person_typed_and_removes_only_the_one_the_link_set() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "typed", "BUG-1", None, &[]).await;
    sql(
        w.db(),
        r#"UPDATE issues SET "externalUrl" = 'https://example.com/mine' WHERE id = 'typed'"#,
    )
    .await;
    service::set_external_ref(&w.state, "ws_acme", &actor(), "typed", Some(&external()))
        .await
        .unwrap();
    assert_eq!(row(&w, "typed").await.external_url.as_deref(), Some("https://example.com/mine"));
    service::set_external_ref(&w.state, "ws_acme", &actor(), "typed", None).await.unwrap();
    assert_eq!(row(&w, "typed").await.external_url.as_deref(), Some("https://example.com/mine"));

    issue(w.db(), "ws_acme", "linked", "BUG-2", None, &[]).await;
    service::set_external_ref(&w.state, "ws_acme", &actor(), "linked", Some(&external()))
        .await
        .unwrap();
    service::set_external_ref(&w.state, "ws_acme", &actor(), "linked", None).await.unwrap();
    let stored = row(&w, "linked").await;
    assert_eq!(stored.external_ref, None);
    assert_eq!(stored.external_url, None);
    w.drop().await;
}

#[tokio::test]
async fn set_external_ref_answers_409_naming_the_issue_that_already_carries_it() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "iss_1", "BUG-1", None, &[]).await;
    issue(w.db(), "ws_acme", "iss_2", "FEAT-9", None, &[]).await;
    service::set_external_ref(&w.state, "ws_acme", &actor(), "iss_2", Some(&external()))
        .await
        .unwrap();
    let err = service::set_external_ref(&w.state, "ws_acme", &actor(), "iss_1", Some(&external()))
        .await
        .unwrap_err();
    assert_eq!(code(&err), 409);
    assert!(message(&err).contains("FEAT-9"), "{err}");
    assert_eq!(row(&w, "iss_1").await.external_ref, None);
    w.drop().await;
}

#[tokio::test]
async fn refresh_external_ref_is_quiet_and_refuses_an_unlinked_issue() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "iss_1", "BUG-1", None, &[]).await;
    let refresh = ExternalRefRefresh {
        state: Some("Closed".into()),
        state_type: Some(ExternalStateType::Done),
        synced_at: Some("2026-10-09T00:00:00.000Z".into()),
        ..ExternalRefRefresh::default()
    };
    let err = service::refresh_external_ref(&w.state, "ws_acme", "iss_1", refresh.clone())
        .await
        .unwrap_err();
    assert_eq!(code(&err), 400);
    assert!(message(&err).contains("not linked"), "{err}");

    service::set_external_ref(&w.state, "ws_acme", &actor(), "iss_1", Some(&external()))
        .await
        .unwrap();
    let before = event_types(&w).await.len();
    let res = service::refresh_external_ref(&w.state, "ws_acme", "iss_1", refresh).await.unwrap();
    let linked = res.external_ref.unwrap();
    assert_eq!(linked.id, "acme/api#12");
    assert_eq!(linked.state.as_deref(), Some("Closed"));
    assert_eq!(linked.state_type, Some(ExternalStateType::Done));
    assert_eq!(linked.origin, ExternalRefOrigin::Link);
    // a mirror, not a change of the work: no domain event
    assert_eq!(event_types(&w).await.len(), before);
    w.drop().await;
}

#[tokio::test]
async fn external_link_responses_redact_a_project_hidden_parent() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    project(db, "ws_acme", "pj_visible", "VIS").await;
    project(db, "ws_acme", "pj_hidden", "HID").await;
    issue(db, "ws_acme", "in_parent", "HID-1", Some("pj_hidden"), &[]).await;
    issue(db, "ws_acme", "iss_1", "VIS-1", Some("pj_visible"), &[]).await;
    sql(db, r#"UPDATE issues SET "parentId" = 'in_parent' WHERE id = 'iss_1'"#).await;
    let access = limited(&["pj_visible"], false);

    let linked = with_access(
        Some(access.clone()),
        service::set_external_ref(&w.state, "ws_acme", &actor(), "iss_1", Some(&external())),
    )
    .await
    .unwrap();
    assert_eq!(linked.parent_id, None);
    let refreshed = with_access(
        Some(access),
        service::refresh_external_ref(
            &w.state,
            "ws_acme",
            "iss_1",
            ExternalRefRefresh { state: Some("Closed".into()), ..ExternalRefRefresh::default() },
        ),
    )
    .await
    .unwrap();
    assert_eq!(refreshed.parent_id, None);
    // the stored parent is untouched
    assert_eq!(row(&w, "iss_1").await.parent_id.as_deref(), Some("in_parent"));
    w.drop().await;
}

// ───────────────────────── IssuesService project issue keys ─────────────────────────

#[tokio::test]
async fn update_rekeys_an_issue_when_its_project_changes_and_retains_the_former_key() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_1", "CORA-8", Some("pj_a"), &["BUG-3"]).await;
    let patch = IssueInput { project_id: Some(Some("pj_b".into())), ..IssueInput::default() };
    let updated = service::update(&w.state, "ws_acme", &actor(), "in_1", patch).await.unwrap();
    assert_eq!(updated.project_id.as_deref(), Some("pj_b"));
    assert_eq!(updated.key, "TRMA-1");
    assert_eq!(updated.number, 1);
    assert_eq!(updated.aliases, json!(["BUG-3", "CORA-8"]));
    assert_eq!(row(&w, "in_1").await.key, "TRMA-1");
    assert_eq!(event_types(&w).await, ["issue.rekeyed", "issue.updated"]);
    // the former key still finds the issue
    let found = service::get(w.db(), "ws_acme", "cora-8").await.unwrap();
    assert_eq!(found.id, "in_1");
    w.drop().await;
}

#[tokio::test]
async fn update_does_not_rekey_when_only_the_issue_kind_changes() {
    let Some(w) = setup().await else { return };
    issue(w.db(), "ws_acme", "in_1", "CORA-8", Some("pj_a"), &["BUG-3"]).await;
    let patch = IssueInput { kind: Some(IssueKind::Feature), ..IssueInput::default() };
    let updated = service::update(&w.state, "ws_acme", &actor(), "in_1", patch).await.unwrap();
    assert_eq!(updated.kind, "feature");
    assert_eq!(updated.key, "CORA-8");
    assert_eq!(updated.aliases, json!(["BUG-3"]));
    assert_eq!(event_types(&w).await, ["issue.updated"]);
    w.drop().await;
}

#[tokio::test]
async fn create_numbers_issues_per_project_prefix_above_existing_keys() {
    let Some(w) = setup().await else { return };
    // existing keys and aliases are a floor for the counter
    issue(w.db(), "ws_acme", "in_old", "AUTH-41", Some("pj_a"), &["AUTH-57"]).await;
    let mut input = NewIssue::new(IssueKind::Bug, "First");
    input.project_id = Some("pj_a".into());
    let created = service::create(&w.state, "ws_acme", &actor(), input).await.unwrap();
    assert_eq!(created.key, "AUTH-58");
    let created =
        service::create(&w.state, "ws_acme", &actor(), NewIssue::new(IssueKind::Bug, "Loose"))
            .await
            .unwrap();
    assert_eq!(created.key, "UNPR-1");
    assert_eq!(created.status, "backlog");
    assert_eq!(event_types(&w).await, ["issue.created", "issue.created"]);
    w.drop().await;
}

// ───────────────────────── IssuesService.list ─────────────────────────

#[tokio::test]
async fn list_caps_an_omitted_limit_at_500_and_still_honors_a_smaller_one() {
    let Some(w) = setup().await else { return };
    sql(
        w.db(),
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, aliases)
           SELECT 'in_' || n, 'ws_acme', 'BUG-' || n, n, 'bug', 'Issue ' || n, 'manual', 'none', 'backlog', '[]'
           FROM generate_series(1, 520) AS n"#,
    )
    .await;
    let all = service::list(
        w.db(),
        "ws_acme",
        &IssueFilter { kind: Some(IssueKind::Bug), ..IssueFilter::default() },
    )
    .await
    .unwrap();
    assert_eq!(all.len(), 500);
    let paged = service::list(
        w.db(),
        "ws_acme",
        &IssueFilter { limit: Some(25), ..IssueFilter::default() },
    )
    .await
    .unwrap();
    assert_eq!(paged.len(), 25);
    let over = service::list(
        w.db(),
        "ws_acme",
        &IssueFilter { limit: Some(900), ..IssueFilter::default() },
    )
    .await
    .unwrap();
    assert_eq!(over.len(), 500);
    w.drop().await;
}

// ───────────────────────── IssuesService.update parent link ─────────────────────────

#[tokio::test]
async fn update_reads_the_parent_link_under_the_hierarchy_lock() {
    let Some(w) = setup().await else { return };
    let db = w.db();
    for (id, key) in [("in_child", "BUG-1"), ("in_old", "BUG-2"), ("in_next", "BUG-3")] {
        issue(db, "ws_acme", id, key, None, &[]).await;
    }
    sql(db, r#"UPDATE issues SET "parentId" = 'in_old' WHERE id = 'in_child'"#).await;
    // a new parent given by key, replacing the stored one
    let patch = IssueInput { parent_id: Some(Some("BUG-3".into())), ..IssueInput::default() };
    let updated = service::update(&w.state, "ws_acme", &actor(), "in_child", patch).await.unwrap();
    assert_eq!(updated.parent_id.as_deref(), Some("in_next"));
    // an unrelated edit keeps the stored link
    let patch = IssueInput { title: Some("Renamed".into()), ..IssueInput::default() };
    let updated = service::update(&w.state, "ws_acme", &actor(), "in_child", patch).await.unwrap();
    assert_eq!(updated.parent_id.as_deref(), Some("in_next"));
    // a parent that is a descendant is refused
    let patch = IssueInput { parent_id: Some(Some("in_child".into())), ..IssueInput::default() };
    let err = service::update(&w.state, "ws_acme", &actor(), "in_next", patch).await.unwrap_err();
    assert_eq!(code(&err), 400);
    assert_eq!(message(&err), "Issue hierarchy cannot contain cycles");
    w.drop().await;
}
