//! The service other crates call (`uploads.service.spec.ts`): staging, opening, the reference
//! rows that keep a file alive, and their maintenance.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use sea_orm::{DatabaseConnection, EntityTrait, PaginatorTrait};
use serde_json::json;
use trama_auth::member_access::with_access;
use trama_auth::upload_caller::{UploadCaller, with_upload_caller};
use trama_contracts::access::{MemberAccess, MemberGrant, MemberProjectScope};
use trama_contracts::common::ActorRef;
use trama_core::AppError;
use trama_entities::{upload_references, uploads};
use trama_uploads::service::{
    self, IncomingUpload, LostOwner, UploadSubject, assert_attachable, forget_subjects,
    ids_lost_with, link_artifact, reconcile_upload_references, release_ids, retained,
};

use common::{PNG, World, comment, issue, project, sql, workspace};

fn caller(id: &str) -> UploadCaller {
    UploadCaller { actor: ActorRef::user(id), role: "member".to_owned(), permissions: None }
}

fn file(name: &str, bytes: &[u8]) -> IncomingUpload {
    IncomingUpload { original_name: name.to_owned(), bytes: bytes.to_vec() }
}

fn limited_to(project: &str) -> MemberAccess {
    MemberAccess {
        projects: MemberProjectScope { all: false, project_ids: vec![project.to_owned()] },
        include_unassigned: true,
        grants: ["issues:view", "projects:view", "comments:view", "artifacts:view"]
            .iter()
            .filter_map(|g| MemberGrant::parse(g))
            .collect(),
    }
}

fn status(err: &AppError) -> StatusCode {
    err.status_code()
}

async fn count(db: &DatabaseConnection) -> (u64, u64) {
    (
        uploads::Entity::find().count(db).await.unwrap(),
        upload_references::Entity::find().count(db).await.unwrap(),
    )
}

fn mention(id: &str) -> String {
    format!("![x](/api/w/acme/uploads/{id})")
}

async fn staged(db: &DatabaseConnection, by: &str) -> String {
    service::stage(db, "ws_acme", "acme", &caller(by), &file("shot.png", &PNG)).await.unwrap().id
}

#[tokio::test]
async fn accepts_a_png_and_returns_a_workspace_url() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let staged = service::stage(w.db(), "ws_acme", "acme", &caller("u1"), &file("shot.png", &PNG))
        .await
        .unwrap();
    assert!(staged.url.starts_with("/api/w/acme/uploads/upl_"));
    assert_eq!(staged.markdown, format!("![shot.png]({})", staged.url));
    let opened = service::open(w.db(), "ws_acme", &staged.id, &caller("u1")).await.unwrap();
    assert_eq!(opened.bytes, PNG);
    assert_eq!(opened.content_type, "image/png");
    w.drop().await;
}

#[tokio::test]
async fn rejects_an_executable_and_a_file_over_the_size_limit() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let exe = [0x4d, 0x5a, 0x90, 0x00];
    for (name, bytes) in [
        ("run.exe", exe.to_vec()),
        ("run.png", exe.to_vec()),
        ("big.png", vec![0; 8 * 1024 * 1024 + 9]),
    ] {
        let err = service::stage(w.db(), "ws_acme", "acme", &caller("u1"), &file(name, &bytes))
            .await
            .unwrap_err();
        assert_eq!(status(&err), StatusCode::BAD_REQUEST, "{name}");
    }
    assert_eq!(count(w.db()).await, (0, 0));
    w.drop().await;
}

#[tokio::test]
async fn keeps_a_mentioned_file_readable_then_deletes_it_when_the_text_drops_it() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    workspace(db, "other").await;
    project(db, "ws_acme", "pj_1").await;
    issue(db, "ws_acme", "in_1", "A-1", Some("pj_1"), &[]).await;
    let id = staged(db, "u1").await;

    // another workspace, another person
    let err = service::open(db, "ws_other", &id, &caller("u1")).await.unwrap_err();
    assert_eq!(status(&err), StatusCode::NOT_FOUND);
    let err = service::open(db, "ws_acme", &id, &caller("u2")).await.unwrap_err();
    assert_eq!(status(&err), StatusCode::NOT_FOUND);
    assert_eq!(count(db).await.0, 1);

    let text = mention(&id);
    let subject = UploadSubject::issue("in_1", Some("pj_1".into()));
    retained(db, "ws_acme", None, Some(&text), Some(&subject)).await.unwrap();
    assert_eq!(service::open(db, "ws_acme", &id, &caller("u2")).await.unwrap().id, id);
    assert!(uploads::Entity::find_by_id(&id).one(db).await.unwrap().unwrap().referenced);

    retained(db, "ws_acme", Some(&text), None, Some(&subject)).await.unwrap();
    assert_eq!(count(db).await, (0, 0));
    let err = service::open(db, "ws_acme", &id, &caller("u1")).await.unwrap_err();
    assert_eq!(err.to_string(), format!("404 Not Found: File \"{id}\" not found"));
    w.drop().await;
}

#[tokio::test]
async fn hides_a_file_whose_only_mention_is_on_a_project_the_caller_cannot_see() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    project(db, "ws_acme", "pj_hidden").await;
    issue(db, "ws_acme", "in_hidden", "A-1", Some("pj_hidden"), &[]).await;
    let id = staged(db, "u1").await;
    let subject = UploadSubject::issue("in_hidden", Some("pj_hidden".into()));
    retained(db, "ws_acme", None, Some(&mention(&id)), Some(&subject)).await.unwrap();

    let access = Arc::new(limited_to("pj_visible"));
    let err = with_access(Some(access), service::open(db, "ws_acme", &id, &caller("u2")))
        .await
        .unwrap_err();
    assert_eq!(status(&err), StatusCode::NOT_FOUND);
    assert_eq!(count(db).await.0, 1, "a hidden mention does not delete the file");
    // not narrowed: readable
    assert!(service::open(db, "ws_acme", &id, &caller("u2")).await.is_ok());
    w.drop().await;
}

#[tokio::test]
async fn retained_without_a_subject_only_moves_the_flag_and_releases_unmentioned_files() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    let (a, b) = (staged(db, "u1").await, staged(db, "u1").await);
    retained(db, "ws_acme", None, Some(&mention(&a)), None).await.unwrap();
    assert!(uploads::Entity::find_by_id(&a).one(db).await.unwrap().unwrap().referenced);
    assert!(!uploads::Entity::find_by_id(&b).one(db).await.unwrap().unwrap().referenced);
    // `a` has no reference row, so dropping it from the text deletes it
    retained(db, "ws_acme", Some(&mention(&a)), None, None).await.unwrap();
    assert!(uploads::Entity::find_by_id(&a).one(db).await.unwrap().is_none());
    assert!(uploads::Entity::find_by_id(&b).one(db).await.unwrap().is_some());
    w.drop().await;
}

#[tokio::test]
async fn a_file_mentioned_by_two_records_survives_one_of_them() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    issue(db, "ws_acme", "in_1", "A-1", None, &[]).await;
    issue(db, "ws_acme", "in_2", "A-2", None, &[]).await;
    let id = staged(db, "u1").await;
    let text = mention(&id);
    for issue in ["in_1", "in_2"] {
        retained(db, "ws_acme", None, Some(&text), Some(&UploadSubject::issue(issue, None)))
            .await
            .unwrap();
    }
    retained(
        db,
        "ws_acme",
        Some(&text),
        Some("no files"),
        Some(&UploadSubject::issue("in_1", None)),
    )
    .await
    .unwrap();
    assert_eq!(count(db).await, (1, 1));
    // saving the same text again keeps a single row
    retained(db, "ws_acme", Some(&text), Some(&text), Some(&UploadSubject::issue("in_2", None)))
        .await
        .unwrap();
    assert_eq!(count(db).await, (1, 1));
    w.drop().await;
}

#[tokio::test]
async fn refuses_a_text_that_embeds_a_file_the_caller_cannot_read() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    workspace(db, "other").await;
    issue(db, "ws_acme", "in_1", "A-1", None, &[]).await;
    let mine = staged(db, "u1").await;
    let theirs = staged(db, "u2").await;
    let elsewhere = service::stage(db, "ws_other", "other", &caller("u1"), &file("a.png", &PNG))
        .await
        .unwrap()
        .id;
    let as_u1 = |text: String| {
        let db = db.clone();
        async move {
            with_upload_caller(
                Some(Arc::new(caller("u1"))),
                assert_attachable(&db, "ws_acme", Some(&text)),
            )
            .await
        }
    };
    // no files, no check
    assert!(assert_attachable(db, "ws_acme", Some("plain")).await.is_ok());
    assert!(assert_attachable(db, "ws_acme", None).await.is_ok());
    assert!(as_u1(mention(&mine)).await.is_ok());
    for text in [mention(&theirs), mention(&elsewhere), mention("upl_doesnotexist1")] {
        let err = as_u1(text).await.unwrap_err();
        assert_eq!(status(&err), StatusCode::BAD_REQUEST);
        assert_eq!(err.to_string(), "400 Bad Request: That file is not available to attach here");
    }
    // outside a request there is no caller: nothing can be attached
    assert!(assert_attachable(db, "ws_acme", Some(&mention(&mine))).await.is_err());

    // once a record the caller can read mentions it, anyone may reuse it
    let subject = UploadSubject::issue("in_1", None);
    retained(db, "ws_acme", None, Some(&mention(&theirs)), Some(&subject)).await.unwrap();
    assert!(as_u1(mention(&theirs)).await.is_ok());
    // but not when the mention is outside the caller's projects
    project(db, "ws_acme", "pj_x").await;
    sql(db, "UPDATE issues SET \"projectId\" = 'pj_x' WHERE id = 'in_1'").await;
    retained(
        db,
        "ws_acme",
        None,
        Some(&mention(&theirs)),
        Some(&UploadSubject::issue("in_1", Some("pj_x".into()))),
    )
    .await
    .unwrap();
    let narrowed = with_access(Some(Arc::new(limited_to("pj_y"))), as_u1(mention(&theirs))).await;
    assert!(narrowed.is_err());
    w.drop().await;
}

#[tokio::test]
async fn forgets_the_records_that_were_deleted_and_releases_their_files() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    issue(db, "ws_acme", "in_1", "A-1", None, &[]).await;
    issue(db, "ws_acme", "in_2", "A-2", None, &[]).await;
    let (only_1, both) = (staged(db, "u1").await, staged(db, "u1").await);
    let one = UploadSubject::issue("in_1", None);
    let two = UploadSubject::issue("in_2", None);
    retained(
        db,
        "ws_acme",
        None,
        Some(&format!("{} {}", mention(&only_1), mention(&both))),
        Some(&one),
    )
    .await
    .unwrap();
    retained(db, "ws_acme", None, Some(&mention(&both)), Some(&two)).await.unwrap();
    forget_subjects(db, "ws_acme", &[]).await.unwrap();
    assert_eq!(count(db).await, (2, 3));
    forget_subjects(db, "ws_acme", &[one]).await.unwrap();
    assert!(uploads::Entity::find_by_id(&only_1).one(db).await.unwrap().is_none());
    assert!(uploads::Entity::find_by_id(&both).one(db).await.unwrap().is_some());
    assert_eq!(count(db).await, (1, 1));
    w.drop().await;
}

#[tokio::test]
async fn names_the_files_lost_with_an_issue_and_releases_them_after_the_delete() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    issue(db, "ws_acme", "in_1", "A-1", None, &[]).await;
    issue(db, "ws_acme", "in_2", "A-2", None, &[]).await;
    let (in_body, in_comment, artifact_file, shared, other_comment) = (
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
    );
    sql(
        db,
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "issueId", "uploadId", url)
               VALUES ('ar_1', 'ws_acme', 'file', 'other', 'a.png', 'published', 'in_1', '{artifact_file}', '/api/w/acme/uploads/{artifact_file}')"#
        ),
    )
    .await;
    link_artifact(db, "ws_acme", "ar_1", &artifact_file, None).await.unwrap();
    comment(
        db,
        "ws_acme",
        "cm_1",
        &json!({ "type": "issue", "id": "in_1" }),
        &mention(&in_comment),
    )
    .await;
    comment(
        db,
        "ws_acme",
        "cm_2",
        &json!({ "type": "issue", "id": "in_2" }),
        &mention(&other_comment),
    )
    .await;
    comment(db, "ws_acme", "cm_3", &json!({ "type": "artifact", "id": "ar_1" }), &mention(&shared))
        .await;
    for (comment_id, body) in [("cm_1", &in_comment), ("cm_2", &other_comment), ("cm_3", &shared)] {
        retained(
            db,
            "ws_acme",
            None,
            Some(&mention(body)),
            Some(&UploadSubject::comment(comment_id)),
        )
        .await
        .unwrap();
    }
    retained(
        db,
        "ws_acme",
        None,
        Some(&mention(&in_body)),
        Some(&UploadSubject::issue("in_1", None)),
    )
    .await
    .unwrap();

    let body = mention(&in_body);
    let lost = ids_lost_with(
        db,
        "ws_acme",
        &LostOwner { issue_id: Some("in_1".into()), project_id: None },
        &[Some(&body), None],
    )
    .await
    .unwrap();
    let mut lost_sorted = lost.clone();
    lost_sorted.sort();
    let mut expected =
        vec![in_body.clone(), in_comment.clone(), artifact_file.clone(), shared.clone()];
    expected.sort();
    assert_eq!(lost_sorted, expected);
    assert_eq!(lost[0], in_body, "the text's files come first");

    // delete the issue (and with it the artifact), its comments and their references
    sql(db, "DELETE FROM comments WHERE id IN ('cm_1', 'cm_3')").await;
    sql(db, "DELETE FROM artifacts WHERE id = 'ar_1'").await;
    sql(db, "DELETE FROM issues WHERE id = 'in_1'").await;
    release_ids(db, "ws_acme", &lost).await.unwrap();
    let left: Vec<String> =
        uploads::Entity::find().all(db).await.unwrap().into_iter().map(|u| u.id).collect();
    assert_eq!(left, [other_comment], "only the file of the other issue's comment stays");

    // ids that are not upload ids are ignored
    release_ids(db, "ws_acme", &["x".into(), String::new()]).await.unwrap();
    // a project owner has no artifacts
    let lost = ids_lost_with(
        db,
        "ws_acme",
        &LostOwner { issue_id: None, project_id: Some("pj_1".into()) },
        &[],
    )
    .await
    .unwrap();
    assert!(lost.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn does_not_release_a_file_something_else_still_mentions() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    issue(db, "ws_acme", "in_1", "A-1", None, &[]).await;
    let id = staged(db, "u1").await;
    retained(db, "ws_acme", None, Some(&mention(&id)), Some(&UploadSubject::issue("in_1", None)))
        .await
        .unwrap();
    release_ids(db, "ws_acme", &[id.clone(), id.clone()]).await.unwrap();
    assert_eq!(count(db).await, (1, 1));
    // another workspace's release does not reach it
    release_ids(db, "ws_other", &[id]).await.unwrap();
    assert_eq!(count(db).await, (1, 1));
    w.drop().await;
}

#[tokio::test]
async fn rebuilds_the_reference_rows_from_the_records() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    project(db, "ws_acme", "pj_1").await;
    issue(db, "ws_acme", "in_1", "A-1", Some("pj_1"), &[]).await;
    let (in_issue, in_project, in_comment, in_artifact, stale, draft) = (
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
        staged(db, "u1").await,
    );
    sql(db, &format!("UPDATE issues SET body = 'see {}' WHERE id = 'in_1'", mention(&in_issue)))
        .await;
    sql(
        db,
        &format!("UPDATE projects SET description = '{}' WHERE id = 'pj_1'", mention(&in_project)),
    )
    .await;
    comment(
        db,
        "ws_acme",
        "cm_1",
        &json!({ "type": "issue", "id": "in_1" }),
        &mention(&in_comment),
    )
    .await;
    sql(
        db,
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "issueId", "uploadId")
               VALUES ('ar_1', 'ws_acme', 'file', 'other', 'a.png', 'published', 'in_1', '{in_artifact}')"#
        ),
    )
    .await;
    // a stale row: `stale` was mentioned by a record whose text no longer has it
    retained(
        db,
        "ws_acme",
        None,
        Some(&mention(&stale)),
        Some(&UploadSubject::issue("in_1", Some("pj_1".into()))),
    )
    .await
    .unwrap();
    // a mention of a file that does not exist is not recorded
    sql(db, "UPDATE comments SET body = body || ' /uploads/upl_doesnotexist1' WHERE id = 'cm_1'")
        .await;

    reconcile_upload_references(db, "ws_acme").await.unwrap();

    let mut rows: Vec<(String, String, String, Option<String>)> = upload_references::Entity::find()
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.upload_id, r.subject_type, r.subject_id, r.project_id))
        .collect();
    rows.sort();
    let mut expected = vec![
        (in_issue.clone(), "issue".to_owned(), "in_1".to_owned(), Some("pj_1".to_owned())),
        (in_project.clone(), "project".to_owned(), "pj_1".to_owned(), Some("pj_1".to_owned())),
        (in_comment.clone(), "comment".to_owned(), "cm_1".to_owned(), None),
        (in_artifact.clone(), "artifact".to_owned(), "ar_1".to_owned(), Some("pj_1".to_owned())),
    ];
    expected.sort();
    assert_eq!(rows, expected);
    // the dropped mention released its blob, mentioned files are flagged, drafts are untouched
    let rows = uploads::Entity::find().all(db).await.unwrap();
    let flag = |id: &str| rows.iter().find(|u| u.id == id).map(|u| u.referenced);
    assert_eq!(flag(&stale), None);
    for id in [&in_issue, &in_project, &in_comment, &in_artifact] {
        assert_eq!(flag(id), Some(true), "{id}");
    }
    assert_eq!(flag(&draft), Some(false));
    // running it again changes nothing
    reconcile_upload_references(db, "ws_acme").await.unwrap();
    assert_eq!(count(db).await, (5, 4));
    w.drop().await;
}

#[tokio::test]
async fn links_an_artifact_and_flags_the_file() {
    let Some(w) = World::new().await else { return };
    let db = w.db();
    workspace(db, "acme").await;
    let id = staged(db, "u1").await;
    link_artifact(db, "ws_acme", "ar_1", &id, Some("pj_1")).await.unwrap();
    link_artifact(db, "ws_acme", "ar_1", &id, Some("pj_2")).await.unwrap();
    let refs = upload_references::Entity::find().all(db).await.unwrap();
    assert_eq!(refs.len(), 1, "the conflict updates the project");
    assert_eq!(refs[0].project_id.as_deref(), Some("pj_2"));
    assert!(uploads::Entity::find_by_id(&id).one(db).await.unwrap().unwrap().referenced);
    w.drop().await;
}
