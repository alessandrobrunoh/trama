//! The service other crates call (`artifacts.service.spec.ts`): owners, visibility of tasks in
//! hidden projects, counts and the events recorded by background callers.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::json;
use trama_artifacts::service::{
    self, ArtifactFilter, ArtifactInput, count_for_issue, create, get, list, remove,
    resolve_issue_id, update,
};
use trama_auth::member_access::with_access;
use trama_contracts::access::{MemberAccess, MemberProjectScope};
use trama_contracts::common::ActorRef;
use trama_contracts::issues::{ArtifactKind, ReviewState};
use trama_core::AppError;
use trama_core::validation::Patch;
use trama_entities::{artifacts, domain_events};

use common::{World, issue, message, project, sql, workspace};

const WS: &str = "ws_acme";

fn actor() -> ActorRef {
    ActorRef::user("u_1")
}

fn input(issue_id: &str, title: &str) -> ArtifactInput {
    ArtifactInput {
        issue_id: Patch::Value(issue_id.to_owned()),
        title: Some(title.to_owned()),
        ..Default::default()
    }
}

fn limited(include_unassigned: bool) -> Arc<MemberAccess> {
    Arc::new(MemberAccess {
        projects: MemberProjectScope { all: false, project_ids: vec!["pj_visible".to_owned()] },
        include_unassigned,
        grants: Vec::new(),
    })
}

fn status(err: &AppError) -> StatusCode {
    err.status_code()
}

/// `acme` with a visible and a hidden project, a task in each and one without a project.
async fn world() -> Option<World> {
    let w = World::new().await?;
    let db = w.db();
    workspace(db, "acme").await;
    project(db, WS, "pj_visible").await;
    project(db, WS, "pj_hidden").await;
    issue(db, WS, "in_visible", "VIS-1", Some("pj_visible"), &[]).await;
    issue(db, WS, "in_hidden", "HID-1", Some("pj_hidden"), &["OLD-7"]).await;
    issue(db, WS, "in_free", "FREE-1", None, &[]).await;
    Some(w)
}

#[tokio::test]
async fn requires_a_task_owner_and_a_title() {
    let Some(w) = world().await else { return };
    let kind = ArtifactKind::Document;
    let no_owner = ArtifactInput { title: Some("x".into()), ..Default::default() };
    let err = create(&w.state, WS, &actor(), kind, no_owner).await.unwrap_err();
    assert_eq!(status(&err), StatusCode::BAD_REQUEST);
    assert_eq!(message(&err), "An artifact needs a task: issueId");
    let err = create(&w.state, WS, &actor(), kind, input("in_nope", "x")).await.unwrap_err();
    assert_eq!(message(&err), "Unknown issue \"in_nope\"");
    let err = create(
        &w.state,
        WS,
        &actor(),
        kind,
        ArtifactInput { issue_id: Patch::Value("in_visible".into()), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert_eq!(message(&err), "An artifact needs a title");
    let err = create(&w.state, WS, &actor(), kind, input("in_visible", "   ")).await.unwrap_err();
    assert_eq!(message(&err), "An artifact needs a title");
    // a task of another workspace is unknown
    workspace(w.db(), "other").await;
    let err =
        create(&w.state, "ws_other", &actor(), kind, input("in_visible", "x")).await.unwrap_err();
    assert_eq!(message(&err), "Unknown issue \"in_visible\"");
    w.drop().await;
}

#[tokio::test]
async fn links_need_a_url_and_documents_keep_a_trimmed_description() {
    let Some(w) = world().await else { return };
    let err = create(&w.state, WS, &actor(), ArtifactKind::Link, input("in_visible", "x"))
        .await
        .unwrap_err();
    assert_eq!(status(&err), StatusCode::BAD_REQUEST);
    let mut link = input("in_visible", "x");
    link.url = Patch::Value("ftp://x".into());
    assert!(create(&w.state, WS, &actor(), ArtifactKind::Link, link).await.is_err());
    let mut link = input("in_visible", "x");
    link.url = Patch::Value("https://x.test".into());
    let row = create(&w.state, WS, &actor(), ArtifactKind::Link, link).await.unwrap();
    assert_eq!((row.kind.as_str(), row.state.as_str()), ("link", "published"));
    let mut file = input("in_visible", "x");
    file.url = Patch::Value("/api/w/acme/uploads/upl_abcdefghijkl".into());
    assert!(create(&w.state, WS, &actor(), ArtifactKind::File, file).await.is_err());

    let mut doc = input("in_visible", "Notes");
    doc.description = Patch::Value(" why ".into());
    let row = create(&w.state, WS, &actor(), ArtifactKind::Document, doc).await.unwrap();
    assert_eq!(row.description.as_deref(), Some("why"));
    assert_eq!(row.issue_id.as_deref(), Some("in_visible"));
    let event = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("artifact.attached"))
        .filter(domain_events::Column::Subject.eq(json!({ "type": "artifact", "id": row.id })))
        .one(w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.data["issueId"], "in_visible");
    w.drop().await;
}

#[tokio::test]
async fn moves_an_artifact_and_refuses_to_detach_it() {
    let Some(w) = world().await else { return };
    let row = create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_visible", "d"))
        .await
        .unwrap();
    let detach = ArtifactInput { issue_id: Patch::Null, ..Default::default() };
    let err = update(&w.state, WS, &actor(), &row.id, detach).await.unwrap_err();
    assert_eq!(message(&err), "An artifact needs a task: issueId");
    let moved = ArtifactInput { issue_id: Patch::Value("in_free".into()), ..Default::default() };
    let row = update(&w.state, WS, &actor(), &row.id, moved).await.unwrap();
    assert_eq!(row.issue_id.as_deref(), Some("in_free"));
    let event = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("artifact.updated"))
        .one(w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.data["issueId"], "in_free");
    assert_eq!(event.data["changes"]["issueId"], json!(["in_visible", "in_free"]));
    // exactly one event: the refused detach recorded nothing
    assert_eq!(
        domain_events::Entity::find()
            .filter(domain_events::Column::Type.eq("artifact.updated"))
            .all(w.db())
            .await
            .unwrap()
            .len(),
        1
    );
    w.drop().await;
}

#[tokio::test]
async fn counts_the_artifacts_of_an_issue() {
    let Some(w) = world().await else { return };
    assert_eq!(count_for_issue(w.db(), WS, "in_visible").await.unwrap(), 0);
    for title in ["a", "b", "c"] {
        create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_visible", title))
            .await
            .unwrap();
    }
    create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_free", "d")).await.unwrap();
    assert_eq!(count_for_issue(w.db(), WS, "in_visible").await.unwrap(), 3);
    assert_eq!(count_for_issue(w.db(), "ws_other", "in_visible").await.unwrap(), 0);
    w.drop().await;
}

#[tokio::test]
async fn resolves_ids_keys_and_aliases_without_the_project_scope() {
    let Some(w) = world().await else { return };
    for given in ["in_hidden", "HID-1", "hid-1", "OLD-7", "old-7"] {
        let id = with_access(Some(limited(false)), resolve_issue_id(w.db(), WS, given)).await;
        assert_eq!(id.unwrap(), "in_hidden", "{given}");
    }
    for given in ["in_nope", "NOPE-1", "HID-2", "hid_1"] {
        let err = resolve_issue_id(w.db(), WS, given).await.unwrap_err();
        assert_eq!(status(&err), StatusCode::NOT_FOUND, "{given}");
        assert_eq!(message(&err), format!("Issue \"{given}\" not found"));
    }
    assert!(resolve_issue_id(w.db(), "ws_other", "HID-1").await.is_err());
    w.drop().await;
}

#[tokio::test]
async fn an_artifact_of_a_hidden_task_is_not_treated_as_unassigned() {
    for include_unassigned in [true, false] {
        let Some(w) = world().await else { return };
        let hidden =
            create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_hidden", "h"))
                .await
                .unwrap();
        let visible =
            create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_visible", "v"))
                .await
                .unwrap();
        let free = create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_free", "f"))
            .await
            .unwrap();
        // an artifact retained from a retired workstream has no task at all
        sql(
            w.db(),
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "legacyWorkstreamKey")
               VALUES ('ar_legacy', 'ws_acme', 'document', 'other', 'Legacy', 'published', 'ws-1')"#,
        )
        .await;

        let access = limited(include_unassigned);
        with_access(Some(access.clone()), async {
            let err = get(w.db(), WS, &hidden.id).await.unwrap_err();
            assert_eq!(status(&err), StatusCode::NOT_FOUND);
            assert!(get(w.db(), WS, &visible.id).await.is_ok());
            // an issue without a project, and an artifact without an issue, follow includeUnassigned
            assert_eq!(get(w.db(), WS, &free.id).await.is_ok(), include_unassigned);
            assert_eq!(get(w.db(), WS, "ar_legacy").await.is_ok(), include_unassigned);

            let listed: Vec<String> = list(w.db(), WS, &ArtifactFilter::default())
                .await
                .unwrap()
                .into_iter()
                .map(|a| a.id)
                .collect();
            assert!(!listed.contains(&hidden.id));
            assert!(listed.contains(&visible.id));
            assert_eq!(listed.contains(&free.id), include_unassigned);
            assert_eq!(listed.contains(&"ar_legacy".to_owned()), include_unassigned);

            // attaching to, moving onto, changing and deleting what is hidden
            let err =
                create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_hidden", "x"))
                    .await
                    .unwrap_err();
            assert_eq!(status(&err), StatusCode::BAD_REQUEST);
            let onto =
                ArtifactInput { issue_id: Patch::Value("in_hidden".into()), ..Default::default() };
            let err = update(&w.state, WS, &actor(), &visible.id, onto).await.unwrap_err();
            assert_eq!(status(&err), StatusCode::BAD_REQUEST);
            let rename = ArtifactInput { title: Some("Changed".into()), ..Default::default() };
            let err = update(&w.state, WS, &actor(), &hidden.id, rename).await.unwrap_err();
            assert_eq!(status(&err), StatusCode::NOT_FOUND);
            let err = remove(&w.state, WS, &actor(), &hidden.id).await.unwrap_err();
            assert_eq!(status(&err), StatusCode::NOT_FOUND);
        })
        .await;

        // outside a request nothing is narrowed
        assert!(get(w.db(), WS, &hidden.id).await.is_ok());
        assert_eq!(list(w.db(), WS, &ArtifactFilter::default()).await.unwrap().len(), 4);
        w.drop().await;
    }
}

#[tokio::test]
async fn a_member_limited_to_no_project_sees_only_unassigned_work() {
    let Some(w) = world().await else { return };
    let visible = create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_visible", "v"))
        .await
        .unwrap();
    let free = create(&w.state, WS, &actor(), ArtifactKind::Document, input("in_free", "f"))
        .await
        .unwrap();
    for (include_unassigned, expected) in [(true, vec![free.id.clone()]), (false, vec![])] {
        let access = Arc::new(MemberAccess {
            projects: MemberProjectScope { all: false, project_ids: Vec::new() },
            include_unassigned,
            grants: Vec::new(),
        });
        let listed =
            with_access(Some(access), list(w.db(), WS, &ArtifactFilter::default())).await.unwrap();
        let listed: Vec<String> = listed.into_iter().map(|a| a.id).collect();
        assert_eq!(listed, expected, "{include_unassigned}");
        assert!(!listed.contains(&visible.id));
    }
    w.drop().await;
}

#[tokio::test]
async fn review_requests_name_who_was_asked() {
    let Some(w) = world().await else { return };
    let mut pr = input("in_visible", "PR");
    pr.external_id = Patch::Value("#3".into());
    pr.review = Patch::Value(ReviewState::Requested);
    pr.reviewer_user_ids = vec!["u_a".into(), "u_b".into()];
    let row = create(&w.state, WS, &actor(), ArtifactKind::PullRequest, pr).await.unwrap();
    assert_eq!(row.review.as_deref(), Some("requested"));
    let event = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("review.requested"))
        .one(w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        event.data,
        json!({ "title": "PR", "externalId": "#3", "issueId": "in_visible", "reviewerUserIds": ["u_a", "u_b"] })
    );
    // a status change from a background caller (CI) updates ci and records the change
    let ci = ArtifactInput {
        ci: Patch::Value(trama_contracts::issues::CiState::Failing),
        ..Default::default()
    };
    let row = update(&w.state, WS, &ActorRef::system(), &row.id, ci).await.unwrap();
    assert_eq!(row.ci.as_deref(), Some("failing"));
    let stored = artifacts::Entity::find_by_id(row.id.as_str()).one(w.db()).await.unwrap().unwrap();
    assert_eq!(stored, row);
    assert_eq!(service::artifact_owners(&stored)["issueId"], "in_visible");
    w.drop().await;
}
