//! The `/api/w/{slug}/artifacts…` routes behind the real access guard: the behaviour of
//! `task-artifacts.e2e-spec.ts`, `artifacts-visibility.e2e-spec.ts` and the validation, event
//! and upload rules of `artifacts.service.spec.ts`.

mod common;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_contracts::roles::TokenScope;
use trama_entities::{artifacts, comments, domain_events, upload_references, uploads};

use common::{Req, Res, World, comment, issue, only_projects, person, project, token, workspace};

const A: &str = "/api/w/acme/artifacts";

struct Team {
    owner: String,
    member: String,
    viewer: String,
}

/// `acme` with an owner, a member and a viewer, a project `pj_a` and a task `AUTH-1`
/// (`in_1`, alias `OLD-1`) in it.
async fn team(w: &World) -> Team {
    let db = w.db();
    workspace(db, "acme").await;
    project(db, "ws_acme", "pj_a").await;
    issue(db, "ws_acme", "in_1", "AUTH-1", Some("pj_a"), &["OLD-1"]).await;
    Team {
        owner: person(db, "acme", "u_owner", "owner", None).await,
        member: person(db, "acme", "u_member", "member", None).await,
        viewer: person(db, "acme", "u_viewer", "viewer", None).await,
    }
}

async fn create(w: &World, cookie: &str, body: &Value) -> Res {
    w.send(Req::post(A).session(cookie).json(body)).await
}

async fn attach(w: &World, cookie: &str, task: &str, body: &Value) -> Res {
    w.send(Req::post(&format!("/api/w/acme/tasks/{task}/artifacts")).session(cookie).json(body))
        .await
}

async fn events(w: &World, kind: &str) -> Vec<domain_events::Model> {
    domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq(kind))
        .order_by_asc(domain_events::Column::At)
        .all(w.db())
        .await
        .unwrap()
}

fn ids(body: &Value) -> Vec<&str> {
    body.as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn attaches_to_tasks_lists_by_task_and_prevents_orphans() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = attach(
        &w,
        &t.owner,
        "AUTH-1",
        &json!({ "kind": "pull_request", "title": "Fix token refresh", "externalId": "#42" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let artifact = res.body.clone();
    assert_eq!(artifact["issueId"], "in_1");
    assert_eq!(artifact["kind"], "pull_request");
    assert_eq!(artifact["title"], "Fix token refresh");
    assert!(artifact.get("projectId").is_none());

    // by id, by key (any case), by alias, and with the owner filter
    for task in ["in_1", "AUTH-1", "auth-1", "OLD-1"] {
        let res = w
            .send(Req::get(&format!("/api/w/acme/tasks/{task}/artifacts")).session(&t.owner))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{task}");
        assert_eq!(res.body, json!([artifact]), "{task}");
    }
    let res = w.send(Req::get(&format!("{A}?issueId=in_1")).session(&t.owner)).await;
    assert_eq!(res.body, json!([artifact]));
    let res = w
        .send(Req::get(&format!("{A}/{}", artifact["id"].as_str().unwrap())).session(&t.owner))
        .await;
    assert_eq!(res.body, artifact);

    // an artifact without a task is refused
    let orphan = create(&w, &t.owner, &json!({ "kind": "document", "title": "Orphan" })).await;
    assert_eq!(orphan.status, StatusCode::BAD_REQUEST);
    assert_eq!(orphan.message(), "An artifact needs a task: issueId");
    // projects own no artifacts, and the nested route of an unknown task is a 404
    let res = w
        .send(
            Req::post("/api/w/acme/projects/pj_a/artifacts")
                .session(&t.owner)
                .json(&json!({ "kind": "document", "title": "Design notes" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = attach(&w, &t.owner, "NOPE-9", &json!({ "kind": "document", "title": "x" })).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Issue \"NOPE-9\" not found");
    let res = w.send(Req::get("/api/w/acme/tasks/NOPE-9/artifacts").session(&t.owner)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

#[tokio::test]
async fn answers_the_wire_form_of_an_artifact() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = create(
        &w,
        &t.member,
        &json!({ "kind": "document", "title": "  Notes  ", "description": " why ", "issueId": "in_1" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let mut body = res.body.clone();
    let id = body["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("ar_"));
    // `createdAt` and `updatedAt` are millisecond ISO strings
    for key in ["createdAt", "updatedAt"] {
        let at = body[key].as_str().unwrap();
        assert!(at.ends_with('Z') && at.len() == 24, "{at}");
        body.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        body,
        json!({
            "id": id, "issueId": "in_1", "description": "why", "kind": "document",
            "provider": "other", "title": "Notes", "state": "published",
            "authorRef": { "type": "user", "id": "u_member" },
        })
    );
    // the upload and workspace columns never reach the wire
    let row = artifacts::Entity::find_by_id(id.as_str()).one(w.db()).await.unwrap().unwrap();
    assert_eq!(row.workspace_id, "ws_acme");
    assert_eq!(row.upload_id, None);
    w.drop().await;
}

#[tokio::test]
async fn read_only_members_and_tokens_read_but_do_not_mutate() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let artifact =
        attach(&w, &t.owner, "AUTH-1", &json!({ "kind": "document", "title": "Private design" }))
            .await
            .body;
    let id = artifact["id"].as_str().unwrap();

    let res = w.send(Req::get("/api/w/acme/tasks/AUTH-1/artifacts").session(&t.viewer)).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w
        .send(
            Req::patch(&format!("{A}/{id}"))
                .session(&t.viewer)
                .json(&json!({ "title": "Changed" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w.send(Req::delete(&format!("{A}/{id}")).session(&t.viewer)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = attach(&w, &t.viewer, "AUTH-1", &json!({ "kind": "document", "title": "x" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    let secret = token(w.db(), "ws_acme", "u_owner", TokenScope::Read, None).await;
    let res = w.send(Req::get("/api/w/acme/tasks/AUTH-1/artifacts").bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w
        .send(
            Req::post("/api/w/acme/tasks/AUTH-1/artifacts")
                .bearer(&secret)
                .json(&json!({ "kind": "document", "title": "Denied" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // nothing changed
    assert_eq!(artifacts::Entity::find().count(w.db()).await.unwrap(), 1);
    w.drop().await;
}

#[tokio::test]
async fn hides_and_protects_artifacts_of_tasks_in_hidden_projects() {
    for include_unassigned in [true, false] {
        let Some(w) = World::new().await else { return };
        let db = w.db();
        workspace(db, "acme").await;
        project(db, "ws_acme", "pj_visible").await;
        project(db, "ws_acme", "pj_hidden").await;
        issue(db, "ws_acme", "in_visible", "VIS-1", Some("pj_visible"), &[]).await;
        issue(db, "ws_acme", "in_hidden", "HID-1", Some("pj_hidden"), &[]).await;
        let owner = person(db, "acme", "u_owner", "owner", None).await;
        let member = person(
            db,
            "acme",
            "u_member",
            "member",
            Some(only_projects(&["pj_visible"], include_unassigned)),
        )
        .await;

        let visible =
            attach(&w, &owner, "in_visible", &json!({ "kind": "document", "title": "Visible" }))
                .await
                .body;
        let hidden =
            attach(&w, &owner, "in_hidden", &json!({ "kind": "document", "title": "Hidden" }))
                .await
                .body;
        let hidden_id = hidden["id"].as_str().unwrap();
        let visible_id = visible["id"].as_str().unwrap();

        let res = w.send(Req::get(A).session(&member)).await;
        assert_eq!(res.status, StatusCode::OK);
        assert!(ids(&res.body).contains(&visible_id));
        assert!(!ids(&res.body).contains(&hidden_id));
        let res = w.send(Req::get(&format!("{A}/{hidden_id}")).session(&member)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{include_unassigned}");
        let res = w.send(Req::get("/api/w/acme/tasks/in_hidden/artifacts").session(&member)).await;
        assert_eq!((res.status, res.body), (StatusCode::OK, json!([])));

        let res =
            attach(&w, &member, "in_hidden", &json!({ "kind": "document", "title": "x" })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.message(), "Unknown issue \"in_hidden\"");
        let res = create(
            &w,
            &member,
            &json!({ "kind": "document", "title": "x", "issueId": "in_hidden" }),
        )
        .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        let res = w
            .send(
                Req::patch(&format!("{A}/{visible_id}"))
                    .session(&member)
                    .json(&json!({ "issueId": "in_hidden" })),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        let res = w
            .send(
                Req::patch(&format!("{A}/{hidden_id}"))
                    .session(&member)
                    .json(&json!({ "title": "Changed" })),
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        let res = w.send(Req::delete(&format!("{A}/{hidden_id}")).session(&member)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(artifacts::Entity::find().count(db).await.unwrap(), 2);
        w.drop().await;
    }
}

#[tokio::test]
async fn validates_bodies_like_class_validator() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = create(&w, &t.owner, &json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.message().starts_with("kind must be one of the following values: pull_request"));
    assert_eq!(res.body["error"], "Bad Request");
    let res = attach(&w, &t.owner, "AUTH-1", &json!({ "kind": "document", "title": 4 })).await;
    assert_eq!(
        res.message(),
        "title must be shorter than or equal to 300 characters; title must be longer than or equal to 1 characters; title must be a string"
    );
    // a body-validation failure wins over an unknown task
    let res = attach(&w, &t.owner, "NOPE-1", &json!({ "kind": "x" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let res = w.send(Req::get(&format!("{A}?kind=nope")).session(&t.owner)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.message().starts_with("kind must be one of the following values"));
    let res =
        w.send(Req::get("/api/w/acme/tasks/AUTH-1/artifacts?state=nope").session(&t.owner)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let res = w
        .send(Req::patch(&format!("{A}/ar_x")).session(&t.owner).json(&json!({ "title": null })))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.message().contains("title must be a string"));
    w.drop().await;
}

#[tokio::test]
async fn filters_lists() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_2", "AUTH-2", Some("pj_a"), &[]).await;
    let pr = attach(
        &w,
        &t.owner,
        "in_1",
        &json!({ "kind": "pull_request", "title": "PR", "repository": "acme/api" }),
    )
    .await
    .body;
    let doc =
        attach(&w, &t.owner, "in_2", &json!({ "kind": "document", "title": "Doc" })).await.body;
    let list = |q: &str| {
        let url = format!("{A}?{q}");
        let w = &w;
        let cookie = &t.owner;
        async move { w.send(Req::get(&url).session(cookie)).await.body }
    };
    // newest first
    assert_eq!(ids(&list("").await), [doc["id"].as_str().unwrap(), pr["id"].as_str().unwrap()]);
    assert_eq!(ids(&list("kind=pull_request").await), [pr["id"].as_str().unwrap()]);
    assert_eq!(ids(&list("state=published").await), [doc["id"].as_str().unwrap()]);
    assert_eq!(ids(&list("repository=acme%2Fapi").await), [pr["id"].as_str().unwrap()]);
    assert_eq!(ids(&list("issueId=in_2").await), [doc["id"].as_str().unwrap()]);
    // an empty filter filters nothing
    assert_eq!(ids(&list("issueId=&repository=").await).len(), 2);
    // the owner of the nested route wins over the query
    let res = w
        .send(
            Req::get("/api/w/acme/tasks/in_1/artifacts?issueId=in_2&kind=pull_request")
                .session(&t.owner),
        )
        .await;
    assert_eq!(ids(&res.body), [pr["id"].as_str().unwrap()]);
    w.drop().await;
}

#[tokio::test]
async fn defaults_follow_the_kind_and_events_are_recorded() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let pr = attach(
        &w,
        &t.member,
        "in_1",
        &json!({ "kind": "merge_request", "title": "MR", "externalId": "!7" }),
    )
    .await
    .body;
    assert_eq!(pr["provider"], "gitlab");
    assert_eq!(pr["state"], "open");
    assert_eq!(pr["ci"], "pending");
    assert_eq!(pr["review"], "none");
    assert_eq!(pr["hasConflicts"], false);
    let gh =
        attach(&w, &t.member, "in_1", &json!({ "kind": "pull_request", "title": "PR" })).await.body;
    assert_eq!(gh["provider"], "github");
    let build =
        attach(&w, &t.member, "in_1", &json!({ "kind": "build", "title": "CI" })).await.body;
    assert_eq!(build["state"], "pending");
    assert!(build.get("ci").is_none() && build.get("hasConflicts").is_none());
    let report =
        attach(&w, &t.member, "in_1", &json!({ "kind": "test_report", "title": "T" })).await.body;
    assert_eq!(report["state"], "succeeded");

    let attached = events(&w, "artifact.attached").await;
    assert_eq!(attached.len(), 4);
    let first = &attached[0];
    assert_eq!(first.subject, json!({ "type": "artifact", "id": pr["id"] }));
    assert_eq!(first.actor, json!({ "type": "user", "id": "u_member" }));
    assert_eq!(
        first.data,
        json!({ "kind": "merge_request", "title": "MR", "externalId": "!7", "state": "open", "issueId": "in_1" })
    );
    assert!(events(&w, "review.requested").await.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn link_artifacts_need_an_http_url_and_uploads_cannot_be_claimed() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let mk = |body: Value| {
        let (w, cookie) = (&w, &t.owner);
        async move { attach(w, cookie, "in_1", &body).await }
    };
    let res = mk(json!({ "kind": "link", "title": "x" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "A link artifact needs a valid http(s) url");
    let res = mk(json!({ "kind": "link", "title": "x", "url": "ftp://x" })).await;
    assert_eq!(res.message(), "An artifact url must be a valid http(s) url");
    let res = mk(json!({ "kind": "link", "title": "x", "url": "https://x.test" })).await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(
        (res.body["kind"].as_str(), res.body["state"].as_str()),
        (Some("link"), Some("published"))
    );
    let res =
        mk(json!({ "kind": "file", "title": "x", "url": "/api/w/acme/uploads/upl_abcdefghijkl" }))
            .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "An artifact url must be a valid http(s) url");
    // a document may carry only a description
    let res = mk(json!({ "kind": "document", "title": "n", "description": "just words" })).await;
    assert_eq!(res.status, StatusCode::CREATED);
    w.drop().await;
}

#[tokio::test]
async fn updates_record_the_changes_and_skip_no_ops() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    issue(w.db(), "ws_acme", "in_2", "AUTH-2", Some("pj_a"), &[]).await;
    let art = attach(
        &w,
        &t.member,
        "in_1",
        &json!({ "kind": "pull_request", "title": "PR", "externalId": "#1", "description": "d", "url": "https://x.test/1" }),
    )
    .await
    .body;
    let id = art["id"].as_str().unwrap();
    let patch = |body: Value| {
        let (w, cookie, id) = (&w, &t.member, id);
        async move { w.send(Req::patch(&format!("{A}/{id}")).session(cookie).json(&body)).await }
    };

    // nothing changes: the stored artifact, no event
    let res = patch(json!({ "title": "PR", "state": "open" })).await;
    assert_eq!((res.status, &res.body), (StatusCode::OK, &art));
    assert!(events(&w, "artifact.updated").await.is_empty());

    let res = patch(json!({
        "title": "  Renamed  ", "state": "merged", "ci": "passing", "description": "   ",
        "url": null, "hasConflicts": null, "issueId": "in_2",
    }))
    .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["title"], "Renamed");
    assert_eq!(res.body["state"], "merged");
    assert_eq!(res.body["issueId"], "in_2");
    for gone in ["description", "url", "hasConflicts"] {
        assert!(res.body.get(gone).is_none(), "{gone}");
    }
    assert_ne!(res.body["updatedAt"], art["updatedAt"]);
    assert_eq!(res.body["createdAt"], art["createdAt"]);
    let updated = events(&w, "artifact.updated").await;
    assert_eq!(updated.len(), 1);
    assert_eq!(
        updated[0].data,
        json!({
            "title": "Renamed", "externalId": "#1", "issueId": "in_2",
            "changes": {
                "title": ["PR", "Renamed"],
                "description": ["d", null],
                "issueId": ["in_1", "in_2"],
                "url": ["https://x.test/1", null],
                "state": ["open", "merged"],
                "ci": ["pending", "passing"],
                "hasConflicts": [false, null],
            },
        })
    );
    // `kind` cannot be changed through the body
    let res = patch(json!({ "kind": "link" })).await;
    assert_eq!(res.body["kind"], "pull_request");
    w.drop().await;
}

#[tokio::test]
async fn refuses_to_detach_the_task_owner() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let art =
        attach(&w, &t.member, "in_1", &json!({ "kind": "document", "title": "d" })).await.body;
    let id = art["id"].as_str().unwrap();
    let res = w
        .send(Req::patch(&format!("{A}/{id}")).session(&t.member).json(&json!({ "issueId": null })))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "An artifact needs a task: issueId");
    let res = w
        .send(
            Req::patch(&format!("{A}/{id}"))
                .session(&t.member)
                .json(&json!({ "issueId": "in_nope" })),
        )
        .await;
    assert_eq!(res.message(), "Unknown issue \"in_nope\"");
    assert!(events(&w, "artifact.updated").await.is_empty());
    let row = artifacts::Entity::find_by_id(id).one(w.db()).await.unwrap().unwrap();
    assert_eq!(row.issue_id.as_deref(), Some("in_1"));
    w.drop().await;
}

#[tokio::test]
async fn requesting_a_review_is_recorded_once_and_not_shown_live() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let mut live = trama_events::Events::of(&w.state).subscribe();
    let art = attach(
        &w,
        &t.member,
        "in_1",
        &json!({ "kind": "pull_request", "title": "PR", "externalId": "#9", "review": "requested" }),
    )
    .await
    .body;
    let id = art["id"].as_str().unwrap();
    let requested = events(&w, "review.requested").await;
    assert_eq!(requested.len(), 1);
    assert_eq!(requested[0].data, json!({ "title": "PR", "externalId": "#9", "issueId": "in_1" }));
    assert_eq!(requested[0].subject, json!({ "type": "artifact", "id": id }));
    // only `artifact.attached` went out live
    let mut live_ids = Vec::new();
    while let Ok(event) = live.try_recv() {
        live_ids.push(event.event.id.clone());
    }
    assert_eq!(live_ids, [id]);

    // asking again with the same review changes nothing; moving off and back records again
    let patch = |body: Value| {
        let (w, cookie) = (&w, &t.member);
        async move { w.send(Req::patch(&format!("{A}/{id}")).session(cookie).json(&body)).await }
    };
    patch(json!({ "review": "requested" })).await;
    assert_eq!(events(&w, "review.requested").await.len(), 1);
    patch(json!({ "review": "approved" })).await;
    assert_eq!(events(&w, "review.requested").await.len(), 1);
    patch(json!({ "review": "requested" })).await;
    assert_eq!(events(&w, "review.requested").await.len(), 2);
    w.drop().await;
}

#[tokio::test]
async fn deleting_removes_its_comments_and_records_the_event() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let art =
        attach(&w, &t.member, "in_1", &json!({ "kind": "document", "title": "Gone" })).await.body;
    let id = art["id"].as_str().unwrap();
    comment(w.db(), "ws_acme", "cm_1", &json!({ "type": "artifact", "id": id }), "on it").await;
    comment(w.db(), "ws_acme", "cm_2", &json!({ "type": "issue", "id": "in_1" }), "elsewhere")
        .await;
    let res = w.send(Req::delete(&format!("{A}/{id}")).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(res.body, Value::Null);
    let res = w.send(Req::get(&format!("{A}/{id}")).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), format!("Artifact \"{id}\" not found"));
    let left: Vec<String> =
        comments::Entity::find().all(w.db()).await.unwrap().into_iter().map(|c| c.id).collect();
    assert_eq!(left, ["cm_2"]);
    let deleted = events(&w, "artifact.deleted").await;
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].data, json!({ "title": "Gone", "issueId": "in_1" }));
    let again = w.send(Req::delete(&format!("{A}/{id}")).session(&t.member)).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

/// An artifact made by the upload route, serialized like the ones this crate answers.
#[tokio::test]
async fn an_uploaded_file_is_released_with_its_artifact_or_when_the_url_moves() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
    // the multipart route is served by trama-uploads
    let mut body = Vec::new();
    body.extend_from_slice(
        b"--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shot.png\"\r\nContent-Type: image/png\r\n\r\n",
    );
    body.extend_from_slice(&png);
    body.extend_from_slice(b"\r\n--b--\r\n");
    let upload = |cookie: &str| {
        axum::http::Request::post("/api/w/acme/tasks/AUTH-1/artifacts/upload")
            .header("cookie", cookie)
            .header("x-client-id", "test-client")
            .header("content-type", "multipart/form-data; boundary=b")
            .body(axum::body::Body::from(body.clone()))
            .unwrap()
    };
    let make = || async {
        use tower::ServiceExt;
        let res = w.app.clone().oneshot(upload(&t.member)).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let bytes = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        serde_json::from_slice::<Value>(&bytes).unwrap()
    };

    // both routes answer the same shape
    let first = make().await;
    let id = first["id"].as_str().unwrap().to_owned();
    let listed = w.send(Req::get(&format!("{A}/{id}")).session(&t.member)).await.body;
    assert_eq!(listed, first);
    assert_eq!(first["kind"], "image");
    assert!(first.get("uploadId").is_none());

    // renaming keeps the file: the url still points at it
    let res = w
        .send(
            Req::patch(&format!("{A}/{id}"))
                .session(&t.member)
                .json(&json!({ "title": "Renamed" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(uploads::Entity::find().count(w.db()).await.unwrap(), 1);
    // a remote url drops the file
    let res = w
        .send(
            Req::patch(&format!("{A}/{id}"))
                .session(&t.member)
                .json(&json!({ "url": "https://example.com/shot.png" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(uploads::Entity::find().count(w.db()).await.unwrap(), 0);
    assert_eq!(upload_references::Entity::find().count(w.db()).await.unwrap(), 0);
    let row = artifacts::Entity::find_by_id(id.as_str()).one(w.db()).await.unwrap().unwrap();
    assert_eq!(row.upload_id, None);

    // deleting an uploaded artifact releases its file
    let second = make().await;
    let id2 = second["id"].as_str().unwrap();
    assert_eq!(uploads::Entity::find().count(w.db()).await.unwrap(), 1);
    let res = w.send(Req::delete(&format!("{A}/{id2}")).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(uploads::Entity::find().count(w.db()).await.unwrap(), 0);
    // the own upload path is accepted as a url only while the artifact owns the file
    let third = make().await;
    let id3 = third["id"].as_str().unwrap();
    let url = third["url"].as_str().unwrap().to_owned();
    let res = w
        .send(
            Req::patch(&format!("{A}/{id3}"))
                .session(&t.member)
                .json(&json!({ "url": url, "title": "ok" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    w.drop().await;
}
