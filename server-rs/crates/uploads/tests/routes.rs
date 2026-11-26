//! The `/api/w/{slug}/uploads…` routes behind the real access guard: multipart handling, who may
//! stage, attach, read and discard, and the headers of a download.

mod common;

use axum::http::{Method, StatusCode};
use sea_orm::EntityTrait;
use serde_json::json;
use trama_auth::Gate;
use trama_contracts::roles::{LegacyRole, TokenScope};
use trama_entities::{domain_events, upload_references, uploads};
use trama_uploads::UploadSubject;
use trama_uploads::service::retained;

use common::{
    PNG, Part, Req, World, comment, issue, only_projects, person, project, sql, token, workspace,
};

const URL: &str = "/api/w/acme/uploads";

/// `acme` with an owner, a member, a viewer, and a project-limited member on `pj_a`.
struct Team {
    owner: String,
    member: String,
    other: String,
    viewer: String,
    narrowed: String,
}

async fn team(w: &World) -> Team {
    let db = w.db();
    workspace(db, "acme").await;
    project(db, "ws_acme", "pj_a").await;
    project(db, "ws_acme", "pj_b").await;
    Team {
        owner: person(db, "acme", "u_owner", "owner", None).await,
        member: person(db, "acme", "u_member", "member", None).await,
        other: person(db, "acme", "u_other", "member", None).await,
        viewer: person(db, "acme", "u_viewer", "viewer", None).await,
        narrowed: person(db, "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false)))
            .await,
    }
}

async fn stage(w: &World, cookie: &str, name: &str, bytes: &[u8]) -> common::Res {
    w.send(Req::post(URL).session(cookie).file(name, bytes)).await
}

async fn staged_id(w: &World, cookie: &str) -> String {
    let res = stage(w, cookie, "shot.png", &PNG).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    res.body["id"].as_str().unwrap().to_owned()
}

fn path(id: &str) -> String {
    format!("{URL}/{id}")
}

#[tokio::test]
async fn stages_a_png_and_answers_with_its_url_and_markdown() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = stage(&w, &t.member, "dir/Shot.PNG", &PNG).await;
    assert_eq!(res.status, StatusCode::CREATED);
    let id = res.body["id"].as_str().unwrap();
    assert!(id.starts_with("upl_") && id.len() == 16, "{id}");
    let url = format!("/api/w/acme/uploads/{id}");
    assert_eq!(
        res.body,
        json!({
            "id": id,
            "filename": "Shot.png",
            "contentType": "image/png",
            "byteSize": 10,
            "kind": "image",
            "url": url,
            "markdown": format!("![Shot.png]({url})"),
        })
    );
    // stored as a draft of the uploader
    let row = uploads::Entity::find_by_id(id).one(w.db()).await.unwrap().unwrap();
    assert!(!row.referenced);
    assert_eq!(row.created_by, json!({ "type": "user", "id": "u_member" }));
    assert_eq!(row.workspace_id, "ws_acme");

    let doc = stage(&w, &t.member, "notes.md", b"# hi").await;
    assert_eq!(doc.body["kind"], "file");
    assert_eq!(doc.body["contentType"], "text/markdown");
    assert!(doc.body["markdown"].as_str().unwrap().starts_with("[notes.md]("));
    w.drop().await;
}

#[tokio::test]
async fn serves_a_draft_to_its_uploader_only_with_download_headers() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let id = staged_id(&w, &t.member).await;

    let own = w.send(Req::get(&path(&id)).session(&t.member)).await;
    assert_eq!(own.status, StatusCode::OK);
    assert_eq!(own.bytes, PNG);
    assert_eq!(own.header("content-type"), "image/png");
    assert_eq!(
        own.header("content-disposition"),
        "inline; filename=\"shot.png\"; filename*=UTF-8''shot.png"
    );
    assert_eq!(own.header("x-content-type-options"), "nosniff");
    assert_eq!(own.header("cache-control"), "private, no-store");
    assert_eq!(own.header("referrer-policy"), "no-referrer");
    assert_eq!(own.header("content-security-policy"), "default-src 'none'; sandbox");

    // nobody else, not even the owner of the workspace
    for cookie in [&t.other, &t.owner, &t.viewer] {
        let res = w.send(Req::get(&path(&id)).session(cookie)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(res.message(), format!("File \"{id}\" not found"));
    }
    let missing = w.send(Req::get(&path("upl_doesnotexist1")).session(&t.member)).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let malformed = w.send(Req::get(&path("nope")).session(&t.member)).await;
    assert_eq!(malformed.message(), "File \"nope\" not found");
    // a draft is not deleted by a failed read
    assert!(uploads::Entity::find_by_id(&id).one(w.db()).await.unwrap().is_some());

    let doc = stage(&w, &t.member, "notes.md", b"# hi").await;
    let doc_id = doc.body["id"].as_str().unwrap();
    let res = w.send(Req::get(&path(doc_id)).session(&t.member)).await;
    assert_eq!(res.header("content-type"), "text/markdown");
    assert!(res.header("content-disposition").starts_with("attachment; filename=\"notes.md\""));

    // unauthenticated
    assert_eq!(w.send(Req::get(&path(&id))).await.status, StatusCode::UNAUTHORIZED);
    w.drop().await;
}

#[tokio::test]
async fn a_saved_mention_makes_the_file_readable_by_those_who_can_read_the_record() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &[]).await;
    issue(w.db(), "ws_acme", "in_b", "AUTH-2", Some("pj_b"), &[]).await;
    let id = staged_id(&w, &t.member).await;
    let text = format!("see /api/w/acme/uploads/{id}");
    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&text),
        Some(&UploadSubject::issue("in_b", Some("pj_b".into()))),
    )
    .await
    .unwrap();

    for cookie in [&t.member, &t.other, &t.owner, &t.viewer] {
        assert_eq!(w.send(Req::get(&path(&id)).session(cookie)).await.status, StatusCode::OK);
    }
    // the member limited to pj_a cannot see a file that only an issue of pj_b mentions
    assert_eq!(
        w.send(Req::get(&path(&id)).session(&t.narrowed)).await.status,
        StatusCode::NOT_FOUND
    );
    // and it was not deleted for it
    assert!(uploads::Entity::find_by_id(&id).one(w.db()).await.unwrap().is_some());

    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&text),
        Some(&UploadSubject::issue("in_a", Some("pj_a".into()))),
    )
    .await
    .unwrap();
    assert_eq!(w.send(Req::get(&path(&id)).session(&t.narrowed)).await.status, StatusCode::OK);
    w.drop().await;
}

#[tokio::test]
async fn a_referenced_file_whose_mentions_are_gone_is_deleted_on_read() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &[]).await;
    let id = staged_id(&w, &t.member).await;
    let text = format!("/api/w/acme/uploads/{id}");
    let subject = UploadSubject::issue("in_a", Some("pj_a".into()));
    retained(w.db(), "ws_acme", None, Some(&text), Some(&subject)).await.unwrap();
    // the issue is deleted without telling the uploads service
    sql(w.db(), "DELETE FROM issues WHERE id = 'in_a'").await;
    let res = w.send(Req::get(&path(&id)).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert!(uploads::Entity::find_by_id(&id).one(w.db()).await.unwrap().is_none());
    w.drop().await;
}

#[tokio::test]
async fn comment_mentions_follow_the_record_the_comment_is_about() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_b", "AUTH-2", Some("pj_b"), &[]).await;
    comment(w.db(), "ws_acme", "cm_issue", &json!({ "type": "issue", "id": "in_b" }), "x").await;
    comment(w.db(), "ws_acme", "cm_import", &json!({ "type": "import", "id": "imp_1" }), "x").await;
    let hidden = staged_id(&w, &t.member).await;
    let open = staged_id(&w, &t.member).await;
    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&format!("/api/w/acme/uploads/{hidden}")),
        Some(&UploadSubject::comment("cm_issue")),
    )
    .await
    .unwrap();
    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&format!("/api/w/acme/uploads/{open}")),
        Some(&UploadSubject::comment("cm_import")),
    )
    .await
    .unwrap();
    assert_eq!(
        w.send(Req::get(&path(&hidden)).session(&t.narrowed)).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(w.send(Req::get(&path(&hidden)).session(&t.other)).await.status, StatusCode::OK);
    // a workspace-wide comment is visible to the narrowed member too
    assert_eq!(w.send(Req::get(&path(&open)).session(&t.narrowed)).await.status, StatusCode::OK);
    w.drop().await;
}

#[tokio::test]
async fn only_people_who_may_write_text_can_stage() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let viewer = stage(&w, &t.viewer, "shot.png", &PNG).await;
    assert_eq!(viewer.status, StatusCode::FORBIDDEN);
    assert_eq!(viewer.message(), "You cannot upload files here");
    // the narrowed member keeps the member grants on their projects
    assert_eq!(stage(&w, &t.narrowed, "shot.png", &PNG).await.status, StatusCode::CREATED);

    // tokens: a custom token needs a write permission on text
    let read =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["tasks:read"])).await;
    let res = w.send(Req::post(URL).bearer(&read).file("shot.png", &PNG)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "You cannot upload files here");
    let write =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["comments:write"])).await;
    let res = w.send(Req::post(URL).bearer(&write).file("shot.png", &PNG)).await;
    assert_eq!(res.status, StatusCode::CREATED);
    let admin = token(w.db(), "ws_acme", "u_member", TokenScope::Write, None).await;
    assert_eq!(
        w.send(Req::post(URL).bearer(&admin).file("shot.png", &PNG)).await.status,
        StatusCode::CREATED
    );
    w.drop().await;
}

#[tokio::test]
async fn a_custom_token_reads_a_file_only_through_a_permitted_resource() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &[]).await;
    let id = staged_id(&w, &t.other).await;
    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&format!("/api/w/acme/uploads/{id}")),
        Some(&UploadSubject::issue("in_a", Some("pj_a".into()))),
    )
    .await
    .unwrap();
    let tasks =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["tasks:read"])).await;
    let projects =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["projects:read"])).await;
    assert_eq!(w.send(Req::get(&path(&id)).bearer(&tasks)).await.status, StatusCode::OK);
    assert_eq!(w.send(Req::get(&path(&id)).bearer(&projects)).await.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

#[tokio::test]
async fn refuses_what_is_not_a_single_acceptable_file() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let cookie = &t.member;
    let post = |req: Req| w.send(req.session(cookie));

    // not multipart at all
    let res = post(Req::post(URL).json(&json!({ "file": "x" }))).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Choose a file to upload")
    );
    // multipart without a file
    let res =
        post(Req::post(URL).multipart(&[Part::Text { field: "file", value: "not a file" }])).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Choose a file to upload")
    );
    // an empty file, and a file input left empty
    let res = post(Req::post(URL).file("empty.png", b"")).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Choose a file to upload")
    );
    let res = post(Req::post(URL).file("", b"ignored")).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Choose a file to upload")
    );
    // another field name, or two files
    let res = post(Req::post(URL).multipart(&[Part::File {
        field: "upload",
        filename: "a.png",
        bytes: &PNG,
    }]))
    .await;
    assert_eq!(res.message(), "Upload a single file in the \"file\" field");
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let two = [
        Part::File { field: "file", filename: "a.png", bytes: &PNG },
        Part::File { field: "file", filename: "b.png", bytes: &PNG },
    ];
    let res = post(Req::post(URL).multipart(&two)).await;
    assert_eq!(res.message(), "Upload a single file in the \"file\" field");
    // text fields next to the file are ignored
    let with_text = [
        Part::Text { field: "note", value: "hello" },
        Part::File { field: "file", filename: "a.png", bytes: &PNG },
    ];
    assert_eq!(post(Req::post(URL).multipart(&with_text)).await.status, StatusCode::CREATED);

    // content rules
    let exe = [0x4d, 0x5a, 0x90, 0x00];
    let cases: [(&str, &[u8], &str); 5] = [
        ("run.exe", &exe, "This file type is not allowed"),
        ("run.png", &exe, "Executables and active content are not allowed"),
        ("pic.png", b"not a png", "The file contents do not match its type"),
        ("page.html", b"<html></html>", "This file type is not allowed"),
        ("page.txt", b"<script>alert(1)</script>", "The file contents do not match its type"),
    ];
    for (name, bytes, message) in cases {
        let res = stage(&w, cookie, name, bytes).await;
        assert_eq!(
            (res.status, res.message().as_str()),
            (StatusCode::BAD_REQUEST, message),
            "{name}"
        );
    }
    // nothing was stored for the refused ones
    let stored = uploads::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(stored.len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn limits_a_file_to_8_mb_but_not_to_the_2_mb_json_limit() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let max = 8 * 1024 * 1024;
    let ok = stage(&w, &t.member, "big.txt", &vec![b'a'; max]).await;
    assert_eq!(ok.status, StatusCode::CREATED, "{}", ok.message());
    assert_eq!(ok.body["byteSize"], max);
    let big = stage(&w, &t.member, "big.txt", &vec![b'a'; max + 1]).await;
    assert_eq!(big.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(big.message(), "File is larger than 8388608 bytes");
    assert_eq!(big.body["error"], "Payload Too Large");
    // a 3 MB file passes the 2 MB limit of JSON bodies
    assert_eq!(
        stage(&w, &t.member, "mid.txt", &vec![b'a'; 3 * 1024 * 1024]).await.status,
        StatusCode::CREATED
    );
    w.drop().await;
}

#[tokio::test]
async fn a_cookie_session_may_send_multipart_only_with_the_csrf_header() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = w.send(Req::post(URL).header("cookie", &t.member).file("a.png", &PNG)).await;
    assert_ne!(res.status, StatusCode::CREATED);
    assert_eq!(
        w.send(Req::post(URL).session(&t.member).file("a.png", &PNG)).await.status,
        StatusCode::CREATED
    );
    // elsewhere a session must send JSON: the task artifacts route here is the upload one only
    w.drop().await;
}

#[tokio::test]
async fn discards_only_an_unreferenced_draft_of_the_caller() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &[]).await;
    let id = staged_id(&w, &t.member).await;

    let other = w.send(Req::delete(&path(&id)).session(&t.other)).await;
    assert_eq!(other.status, StatusCode::NOT_FOUND);
    assert_eq!(other.message(), format!("File \"{id}\" not found"));
    let bad = w.send(Req::delete(&path("nope")).session(&t.member)).await;
    assert_eq!(bad.message(), "File \"nope\" not found");

    let own = w.send(Req::delete(&path(&id)).session(&t.member)).await;
    assert_eq!(own.status, StatusCode::NO_CONTENT);
    assert!(own.bytes.is_empty());
    assert_eq!(w.send(Req::get(&path(&id)).session(&t.member)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        w.send(Req::delete(&path(&id)).session(&t.member)).await.status,
        StatusCode::NOT_FOUND
    );

    // once a record mentions it, it stays
    let kept = staged_id(&w, &t.member).await;
    retained(
        w.db(),
        "ws_acme",
        None,
        Some(&format!("/api/w/acme/uploads/{kept}")),
        Some(&UploadSubject::issue("in_a", Some("pj_a".into()))),
    )
    .await
    .unwrap();
    let res = w.send(Req::delete(&path(&kept)).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Remove the attachment from the record instead");
    // the viewer gate lets a viewer call it (and find nothing of theirs)
    assert_eq!(
        w.send(Req::delete(&path(&kept)).session(&t.viewer)).await.status,
        StatusCode::NOT_FOUND
    );
    w.drop().await;
}

const ATTACH: &str = "/api/w/acme/tasks/AUTH-1/artifacts/upload";

#[tokio::test]
async fn attaches_a_file_to_a_task_as_an_artifact() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &["OLD-9"]).await;
    let res = w.send(Req::post(ATTACH).session(&t.member).file("shot.png", &PNG)).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let id = res.body["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("ar_"));
    let upload_url = res.body["url"].as_str().unwrap().to_owned();
    assert!(upload_url.starts_with("/api/w/acme/uploads/upl_"));
    let at = res.body["createdAt"].as_str().unwrap();
    assert!(at.ends_with('Z'));
    assert_eq!(
        res.body,
        json!({
            "id": id,
            "issueId": "in_a",
            "kind": "image",
            "provider": "other",
            "title": "shot.png",
            "url": upload_url,
            "state": "published",
            "authorRef": { "type": "user", "id": "u_member" },
            "createdAt": at,
            "updatedAt": res.body["updatedAt"],
        })
    );

    // the upload exists, referenced, kept alive by the artifact
    let upload_id = upload_url.rsplit('/').next().unwrap().to_owned();
    let row = uploads::Entity::find_by_id(&upload_id).one(w.db()).await.unwrap().unwrap();
    assert!(row.referenced);
    let refs = upload_references::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(
        (refs[0].subject_type.as_str(), refs[0].subject_id.as_str(), refs[0].project_id.as_deref()),
        ("artifact", id.as_str(), Some("pj_a"))
    );

    // the event
    let events = domain_events::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].r#type, "artifact.attached");
    assert_eq!(events[0].subject, json!({ "type": "artifact", "id": id }));
    assert_eq!(events[0].actor, json!({ "type": "user", "id": "u_member" }));
    assert_eq!(
        events[0].data,
        json!({ "kind": "image", "title": "shot.png", "state": "published", "issueId": "in_a" })
    );

    // anyone who can read the task's artifacts can open it; the person limited elsewhere cannot
    assert_eq!(w.send(Req::get(&upload_url).session(&t.other)).await.status, StatusCode::OK);
    assert_eq!(w.send(Req::get(&upload_url).session(&t.narrowed)).await.status, StatusCode::OK);
    let id_b = "/api/w/acme/tasks/in_a/artifacts/upload";
    assert_eq!(
        w.send(Req::post(id_b).session(&t.member).file("a.pdf", b"%PDF-1")).await.body["kind"],
        "file"
    );
    let alias = "/api/w/acme/tasks/old-9/artifacts/upload";
    assert_eq!(
        w.send(Req::post(alias).session(&t.member).file("a.pdf", b"%PDF-1")).await.status,
        StatusCode::CREATED
    );
    w.drop().await;
}

#[tokio::test]
async fn attaching_checks_the_task_the_person_and_the_file() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_a", "AUTH-1", Some("pj_a"), &[]).await;
    issue(w.db(), "ws_acme", "in_b", "AUTH-2", Some("pj_b"), &[]).await;

    let viewer = w.send(Req::post(ATTACH).session(&t.viewer).file("a.png", &PNG)).await;
    assert_eq!(viewer.status, StatusCode::FORBIDDEN);
    let none = w
        .send(
            Req::post("/api/w/acme/tasks/NOPE-1/artifacts/upload")
                .session(&t.member)
                .file("a.png", &PNG),
        )
        .await;
    assert_eq!(none.status, StatusCode::NOT_FOUND);
    assert_eq!(none.message(), "Issue \"NOPE-1\" not found");
    // a task in a project the person cannot reach looks like it does not exist
    let hidden = w
        .send(
            Req::post("/api/w/acme/tasks/AUTH-2/artifacts/upload")
                .session(&t.narrowed)
                .file("a.png", &PNG),
        )
        .await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND);
    assert_eq!(hidden.message(), "Issue \"AUTH-2\" not found");
    assert_eq!(
        w.send(Req::post(ATTACH).session(&t.narrowed).file("a.png", &PNG)).await.status,
        StatusCode::CREATED
    );
    // bad file, no file
    let exe = w.send(Req::post(ATTACH).session(&t.member).file("run.exe", &[0x4d, 0x5a])).await;
    assert_eq!(exe.message(), "This file type is not allowed");
    let none = w.send(Req::post(ATTACH).session(&t.member).json(&json!({}))).await;
    assert_eq!(none.message(), "Choose a file to upload");
    let big = w
        .send(
            Req::post(ATTACH).session(&t.member).file("big.txt", &vec![b'a'; 8 * 1024 * 1024 + 1]),
        )
        .await;
    assert_eq!(big.status, StatusCode::PAYLOAD_TOO_LARGE);

    // tokens: attaching needs artifacts:write
    let tasks =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["tasks:write"])).await;
    let res = w.send(Req::post(ATTACH).bearer(&tasks).file("a.png", &PNG)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let artifacts =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["artifacts:write"])).await;
    assert_eq!(
        w.send(Req::post(ATTACH).bearer(&artifacts).file("a.png", &PNG)).await.status,
        StatusCode::CREATED
    );
    let read = token(w.db(), "ws_acme", "u_member", TokenScope::Read, None).await;
    assert_eq!(
        w.send(Req::post(ATTACH).bearer(&read).file("a.png", &PNG)).await.status,
        StatusCode::FORBIDDEN
    );

    // refused attempts stored nothing
    let refused = uploads::Entity::find().all(w.db()).await.unwrap().len();
    assert_eq!(refused, 2);
    w.drop().await;
}

#[test]
fn the_gates_are_the_decorators_of_the_controller() {
    let routes = trama_uploads::router();
    let listed: Vec<String> =
        routes.routes().into_iter().map(|(method, path)| format!("{method} {path}")).collect();
    assert_eq!(
        listed,
        [
            "POST /w/{slug}/tasks/{idOrKey}/artifacts/upload",
            "POST /w/{slug}/uploads",
            "DELETE /w/{slug}/uploads/{id}",
            "GET /w/{slug}/uploads/{id}",
        ]
    );
    let gate = |method, path| routes.gate_of(&method, path).unwrap();
    // `@Multipart() @Roles('viewer')`
    let stage = gate(Method::POST, "/w/{slug}/uploads");
    assert_eq!(stage, Gate::authenticated().roles(LegacyRole::Viewer).multipart());
    // `@Multipart()` only
    let attach = gate(Method::POST, "/w/{slug}/tasks/{idOrKey}/artifacts/upload");
    assert_eq!(attach, Gate::authenticated().multipart());
    // the download is a plain GET, discarding `@Roles('viewer')`
    assert_eq!(gate(Method::GET, "/w/{slug}/uploads/{id}"), Gate::authenticated());
    assert_eq!(
        gate(Method::DELETE, "/w/{slug}/uploads/{id}"),
        Gate::authenticated().roles(LegacyRole::Viewer)
    );
}
