//! The `/api/w/{slug}/comments` routes behind the real access guard: what the NestJS e2e specs
//! (`rbac`, `guests`, `projects`, `events-visibility`) and `comments.service.spec.ts` exercise.

mod common;

use axum::http::StatusCode;
use sea_orm::{DbBackend, EntityTrait, QueryTrait};
use serde_json::{Value, json};
use trama_comments::cursor::{CommentCursor, encode_comment_cursor};
use trama_comments::service::{index, list, list_all, page_query};
use trama_contracts::common::SubjectType;
use trama_contracts::roles::TokenScope;
use trama_entities::{domain_events, upload_references, uploads};

use common::{
    PNG, Req, World, artifact, comment_at, issue, milestone, only_projects, person, project, sql,
    token, workspace,
};

const URL: &str = "/api/w/acme/comments";

struct Team {
    owner: String,
    admin: String,
    member: String,
    other: String,
    viewer: String,
    narrowed: String,
}

/// `acme`: roles of every kind, a project-limited member on `pj_a`, projects `pj_a` and `pj_b`,
/// and one issue in each (`in_a`, `in_b`) and one without a project (`in_free`).
async fn team(w: &World) -> Team {
    let db = w.db();
    workspace(db, "acme").await;
    project(db, "ws_acme", "pj_a").await;
    project(db, "ws_acme", "pj_b").await;
    issue(db, "ws_acme", "in_a", Some("pj_a")).await;
    issue(db, "ws_acme", "in_b", Some("pj_b")).await;
    issue(db, "ws_acme", "in_free", None).await;
    Team {
        owner: person(db, "acme", "u_owner", "owner", None).await,
        admin: person(db, "acme", "u_admin", "admin", None).await,
        member: person(db, "acme", "u_member", "member", None).await,
        other: person(db, "acme", "u_other", "member", None).await,
        viewer: person(db, "acme", "u_viewer", "viewer", None).await,
        narrowed: person(db, "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false)))
            .await,
    }
}

fn payload(kind: &str, id: &str, body: &str) -> Value {
    json!({ "subject": { "type": kind, "id": id }, "body": body })
}

async fn post(w: &World, cookie: &str, kind: &str, id: &str, body: &str) -> common::Res {
    w.send(Req::post(URL).session(cookie).json(&payload(kind, id, body))).await
}

async fn created(w: &World, cookie: &str, kind: &str, id: &str, body: &str) -> String {
    let res = post(w, cookie, kind, id, body).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    res.body["id"].as_str().unwrap().to_owned()
}

fn user(id: &str) -> Value {
    json!({ "type": "user", "id": id })
}

#[tokio::test]
async fn creates_reads_edits_and_deletes_a_comment() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;

    let res = post(&w, &t.member, "issue", "in_a", "  Looks good  ").await;
    assert_eq!(res.status, StatusCode::CREATED);
    let id = res.body["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("cm_") && id.len() == 15, "{id}");
    assert_eq!(res.body["workspaceId"], "ws_acme");
    assert_eq!(res.body["subject"], json!({ "type": "issue", "id": "in_a" }));
    assert_eq!(res.body["author"], user("u_member"));
    assert_eq!(res.body["body"], "Looks good");
    let at = res.body["createdAt"].as_str().unwrap();
    assert!(at.len() == 24 && at.ends_with('Z'), "{at}");
    assert_eq!(res.body["createdAt"], res.body["updatedAt"]);
    let keys: Vec<_> = res.body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 7, "{keys:?}");

    // list, filtered and unfiltered; one by id
    let one = w.send(Req::get(&format!("{URL}/{id}")).session(&t.viewer)).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body, res.body);
    let listed = w
        .send(Req::get(&format!("{URL}?subjectType=issue&subjectId=in_a")).session(&t.viewer))
        .await;
    assert_eq!(listed.body, json!([res.body]));
    let all = w.send(Req::get(URL).session(&t.member)).await;
    assert_eq!(all.status, StatusCode::OK, "{}", all.message());
    assert_eq!(all.body.as_array().unwrap().len(), 1);
    // a viewer's member grants are narrower than a member's: as for NestJS, they list one subject
    let denied = w.send(Req::get(URL).session(&t.viewer)).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(denied.message(), "List comments for one subject you can access");
    let none = w.send(Req::get(&format!("{URL}?subjectId=in_b")).session(&t.member)).await;
    assert_eq!(none.body, json!([]));

    // edit
    let edited = w
        .send(
            Req::patch(&format!("{URL}/{id}")).session(&t.member).json(&json!({ "body": " v2 " })),
        )
        .await;
    assert_eq!(edited.status, StatusCode::OK);
    assert_eq!(edited.body["body"], "v2");
    assert_eq!(edited.body["createdAt"], res.body["createdAt"]);
    assert!(edited.body["updatedAt"].as_str().unwrap() >= res.body["updatedAt"].as_str().unwrap());

    // delete
    let gone = w.send(Req::delete(&format!("{URL}/{id}")).session(&t.member)).await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT);
    assert!(gone.bytes.is_empty());
    let missing = w.send(Req::get(&format!("{URL}/{id}")).session(&t.member)).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.message(), format!("Comment \"{id}\" not found"));
    w.drop().await;
}

#[tokio::test]
async fn a_whitespace_only_comment_is_stored_empty_like_nestjs() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = post(&w, &t.member, "issue", "in_a", "   ").await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(res.body["body"], "");
    w.drop().await;
}

#[tokio::test]
async fn projects_milestones_and_artifacts_are_commentable_too() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    milestone(w.db(), "ws_acme", "ms_a", "pj_a").await;
    artifact(w.db(), "ws_acme", "ar_a", Some("in_a")).await;
    sql(
        w.db(),
        r#"INSERT INTO import_jobs (id, "workspaceId", provider, "sourceLabel", source, options, mapping, credential, progress, "createdBy")
           VALUES ('imp_1', 'ws_acme', 'csv', 'x', '{}', '{}', '{}', '{}', '{}', '{"type":"user","id":"u_owner"}')"#,
    )
    .await;
    for (kind, id) in
        [("project", "pj_a"), ("milestone", "ms_a"), ("artifact", "ar_a"), ("import", "imp_1")]
    {
        let res = post(&w, &t.member, kind, id, "Looks good").await;
        assert_eq!(res.status, StatusCode::CREATED, "{kind}: {}", res.message());
        let listed = w
            .send(Req::get(&format!("{URL}?subjectType={kind}&subjectId={id}")).session(&t.member))
            .await;
        assert_eq!(listed.body.as_array().unwrap().len(), 1, "{kind}");
    }
    w.drop().await;
}

#[tokio::test]
async fn refuses_unknown_subjects_and_invalid_bodies() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let res = post(&w, &t.member, "issue", "in_nope", "x").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Unknown issue \"in_nope\"");
    // a subject of another workspace does not exist here
    workspace(w.db(), "other").await;
    issue(w.db(), "ws_other", "in_elsewhere", None).await;
    assert_eq!(
        post(&w, &t.member, "issue", "in_elsewhere", "x").await.status,
        StatusCode::BAD_REQUEST
    );

    let bad = |body: Value| w.send(Req::post(URL).session(&t.member).json(&body));
    let res = bad(json!({ "subject": { "type": "bogus", "id": 1 }, "body": "" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        "subject.type must be one of the following values: issue, artifact, project, milestone, import; subject.id must be a string; body must be longer than or equal to 1 characters"
    );
    let res =
        bad(json!({ "subject": { "type": "issue", "id": "in_a" }, "body": "x".repeat(20_001) }))
            .await;
    assert_eq!(res.message(), "body must be shorter than or equal to 20000 characters");
    assert_eq!(bad(json!({})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad(json!([])).await.message(), "Request body must be a JSON object");
    let res = w
        .send(Req::patch(&format!("{URL}/cm_x")).session(&t.member).json(&json!({ "body": "" })))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    w.drop().await;
}

#[tokio::test]
async fn roles_gate_the_writes() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    // rbac.e2e: a viewer reads but cannot comment
    let res = post(&w, &t.viewer, "issue", "in_a", "hi").await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let url = format!("{URL}?subjectType=issue&subjectId=in_a");
    assert_eq!(w.send(Req::get(&url).session(&t.viewer)).await.status, StatusCode::OK);

    let id = created(&w, &t.member, "issue", "in_a", "mine").await;
    let url = format!("{URL}/{id}");
    // a viewer can neither edit nor delete
    let patch =
        |cookie: &str| w.send(Req::patch(&url).session(cookie).json(&json!({ "body": "changed" })));
    assert_eq!(patch(&t.viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(w.send(Req::delete(&url).session(&t.viewer)).await.status, StatusCode::FORBIDDEN);
    // only the author edits, whoever else they are
    for cookie in [&t.other, &t.admin, &t.owner] {
        let res = patch(cookie).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.message(), "Only the author can edit a comment");
    }
    // another member cannot delete; an admin and the owner can
    let res = w.send(Req::delete(&url).session(&t.other)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Only the author or an admin can delete a comment");
    assert_eq!(w.send(Req::delete(&url).session(&t.admin)).await.status, StatusCode::NO_CONTENT);
    let id = created(&w, &t.member, "issue", "in_a", "mine again").await;
    assert_eq!(
        w.send(Req::delete(&format!("{URL}/{id}")).session(&t.owner)).await.status,
        StatusCode::NO_CONTENT
    );
    // unknown comment
    let res = w.send(Req::delete(&format!("{URL}/cm_zzz")).session(&t.owner)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // not signed in
    assert_eq!(w.send(Req::get(URL)).await.status, StatusCode::UNAUTHORIZED);
    w.drop().await;
}

#[tokio::test]
async fn tokens_follow_their_scope_and_permissions() {
    let Some(w) = World::new().await else { return };
    let _t = team(&w).await;
    let read = token(w.db(), "ws_acme", "u_member", TokenScope::Read, None).await;
    let res = w.send(Req::post(URL).bearer(&read).json(&payload("issue", "in_a", "x"))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let url = format!("{URL}?subjectType=issue&subjectId=in_a");
    assert_eq!(w.send(Req::get(&url).bearer(&read)).await.status, StatusCode::OK);

    let only_read =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["comments:read"])).await;
    let res = w.send(Req::post(URL).bearer(&only_read).json(&payload("issue", "in_a", "x"))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let write =
        token(w.db(), "ws_acme", "u_member", TokenScope::Custom, Some(&["comments:write"])).await;
    let res = w.send(Req::post(URL).bearer(&write).json(&payload("issue", "in_a", "x"))).await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(res.body["author"], user("u_member"));
    w.drop().await;
}

#[tokio::test]
async fn records_the_event_and_publishes_live_events() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let mut live = w.events.subscribe();
    let drain = |rx: &mut tokio::sync::broadcast::Receiver<trama_events::PublishedEvent>| {
        std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>()
    };

    let body = format!("{}{}", "é".repeat(150), "x".repeat(100));
    let id = created(&w, &t.member, "issue", "in_a", &body).await;
    let rows = domain_events::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(rows.len(), 1);
    let event = &rows[0];
    assert_eq!(event.r#type, "comment.created");
    assert_eq!(event.workspace_id, "ws_acme");
    assert_eq!(event.actor, user("u_member"));
    assert_eq!(event.subject, json!({ "type": "issue", "id": "in_a" }));
    assert_eq!(event.data["commentId"], id);
    assert_eq!(event.data["excerpt"].as_str().unwrap(), body.chars().take(200).collect::<String>());
    assert_eq!(event.data.as_object().unwrap().len(), 2);

    let seen = drain(&mut live);
    assert_eq!(seen.len(), 1, "{seen:?}");
    let e = &seen[0];
    assert_eq!(e.workspace_id, "ws_acme");
    assert_eq!(serde_json::to_value(&e.event).unwrap()["type"], "created");
    assert_eq!(serde_json::to_value(&e.event).unwrap()["entity"], "comment");
    assert_eq!(e.event.id, id);
    assert_eq!(e.event.client_id, None);
    assert_eq!(
        serde_json::to_value(e.subject.as_ref().unwrap()).unwrap(),
        json!({ "type": "issue", "id": "in_a" })
    );

    // an edit and a delete publish, scoped by the subject, and record nothing
    w.send(Req::patch(&format!("{URL}/{id}")).session(&t.member).json(&json!({ "body": "v2" })))
        .await;
    w.send(Req::delete(&format!("{URL}/{id}")).session(&t.member)).await;
    let seen = drain(&mut live);
    let kinds: Vec<_> = seen
        .iter()
        .map(|e| serde_json::to_value(&e.event).unwrap()["type"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds, ["updated", "deleted"]);
    for e in &seen {
        assert_eq!(e.event.id, id);
        assert_eq!(serde_json::to_value(&e.event).unwrap()["entity"], "comment");
        assert_eq!(e.subject.as_ref().map(|s| s.id.as_str()), Some("in_a"));
    }
    assert_eq!(domain_events::Entity::find().all(w.db()).await.unwrap().len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn a_limited_person_only_touches_comments_on_work_they_can_see() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let db = w.db();
    milestone(db, "ws_acme", "ms_a", "pj_a").await;
    milestone(db, "ws_acme", "ms_b", "pj_b").await;
    artifact(db, "ws_acme", "ar_a", Some("in_a")).await;
    artifact(db, "ws_acme", "ar_b", Some("in_b")).await;
    artifact(db, "ws_acme", "ar_free", None).await;
    let hidden = created(&w, &t.owner, "issue", "in_b", "internal-only comment").await;
    let visible = created(&w, &t.owner, "issue", "in_a", "shared comment").await;

    let n = &t.narrowed;
    // guests.e2e: a hidden task is 404 to read and to write
    let res = w.send(Req::get(&format!("{URL}?subjectType=issue&subjectId=in_b")).session(n)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "issue \"in_b\" not found");
    assert_eq!(post(&w, n, "issue", "in_b", "peek").await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        w.send(Req::get(&format!("{URL}/{hidden}")).session(n)).await.status,
        StatusCode::NOT_FOUND
    );
    let res =
        w.send(Req::get(&format!("{URL}/page?subjectType=issue&subjectId=in_b")).session(n)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // an issue without a project is hidden unless unassigned work is included
    assert_eq!(post(&w, n, "issue", "in_free", "x").await.status, StatusCode::NOT_FOUND);
    // so are the projects, milestones and artifacts around it
    let res = post(&w, n, "project", "pj_b", "x").await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::NOT_FOUND, "Project \"pj_b\" not found")
    );
    assert_eq!(post(&w, n, "milestone", "ms_b", "x").await.status, StatusCode::NOT_FOUND);
    assert_eq!(post(&w, n, "artifact", "ar_b", "x").await.status, StatusCode::NOT_FOUND);
    assert_eq!(post(&w, n, "artifact", "ar_free", "x").await.status, StatusCode::NOT_FOUND);
    assert_eq!(post(&w, n, "milestone", "ms_missing", "x").await.status, StatusCode::NOT_FOUND);

    // listing needs one subject
    let res = w.send(Req::get(URL).session(n)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "List comments for one subject you can access");
    assert_eq!(
        w.send(Req::get(&format!("{URL}?subjectType=issue")).session(n)).await.status,
        StatusCode::FORBIDDEN
    );

    // and their own project works
    let res = post(&w, n, "issue", "in_a", "hello").await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    for (kind, id) in [("project", "pj_a"), ("milestone", "ms_a"), ("artifact", "ar_a")] {
        assert_eq!(post(&w, n, kind, id, "hello").await.status, StatusCode::CREATED, "{kind}");
    }
    let listed =
        w.send(Req::get(&format!("{URL}?subjectType=issue&subjectId=in_a")).session(n)).await;
    assert_eq!(listed.body.as_array().unwrap().len(), 2);
    assert_eq!(
        w.send(Req::get(&format!("{URL}/{visible}")).session(n)).await.status,
        StatusCode::OK
    );
    let page =
        w.send(Req::get(&format!("{URL}/page?subjectType=issue&subjectId=in_a")).session(n)).await;
    assert_eq!(page.status, StatusCode::OK);
    // the owner is not narrowed
    assert_eq!(w.send(Req::get(URL).session(&t.owner)).await.body.as_array().unwrap().len(), 6);
    w.drop().await;
}

#[tokio::test]
async fn unassigned_work_is_visible_to_a_person_who_includes_it() {
    let Some(w) = World::new().await else { return };
    let _t = team(&w).await;
    let cookie =
        person(w.db(), "acme", "u_wide", "member", Some(only_projects(&["pj_a"], true))).await;
    assert_eq!(post(&w, &cookie, "issue", "in_free", "x").await.status, StatusCode::CREATED);
    artifact(w.db(), "ws_acme", "ar_free", None).await;
    assert_eq!(post(&w, &cookie, "artifact", "ar_free", "x").await.status, StatusCode::CREATED);
    assert_eq!(post(&w, &cookie, "issue", "in_b", "x").await.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

/// Five comments of `in_a`: `cm_3` and `cm_4` share a millisecond (4 and 9 hundred microseconds
/// apart), which only the id tells apart.
async fn seed_page(w: &World) {
    let system = json!({ "type": "system" });
    let subject = json!({ "type": "issue", "id": "in_a" });
    for (id, at) in [
        ("cm_1", "2026-01-01T00:00:01.000000Z"),
        ("cm_2", "2026-01-01T00:00:02.000000Z"),
        ("cm_3", "2026-01-01T00:00:03.500100Z"),
        ("cm_4", "2026-01-01T00:00:03.500900Z"),
        ("cm_5", "2026-01-01T00:00:05.000000Z"),
    ] {
        comment_at(w.db(), "ws_acme", id, &subject, &system, id, &format!("'{at}'")).await;
    }
    // noise: another subject, another workspace
    comment_at(
        w.db(),
        "ws_acme",
        "cm_other",
        &json!({ "type": "issue", "id": "in_b" }),
        &system,
        "x",
        "now()",
    )
    .await;
    workspace(w.db(), "other").await;
    comment_at(w.db(), "ws_other", "cm_ws", &subject, &system, "x", "now()").await;
}

fn ids(res: &common::Res) -> Vec<&str> {
    res.body["items"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn pages_newest_first_without_skipping_or_repeating() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    seed_page(&w).await;
    let base = format!("{URL}/page?subjectType=issue&subjectId=in_a");
    let get = |q: &str| w.send(Req::get(&format!("{base}{q}")).session(&t.viewer));

    let first = get("&limit=2").await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(ids(&first), ["cm_5", "cm_4"]);
    let cursor = first.body["nextCursor"].as_str().unwrap().to_owned();
    let second = get(&format!("&limit=2&cursor={cursor}")).await;
    assert_eq!(ids(&second), ["cm_3", "cm_2"]);
    let cursor = second.body["nextCursor"].as_str().unwrap().to_owned();
    let last = get(&format!("&limit=2&cursor={cursor}")).await;
    assert_eq!(ids(&last), ["cm_1"]);
    assert_eq!(last.body["nextCursor"], Value::Null);
    assert!(last.body.as_object().unwrap().contains_key("nextCursor"));

    // exactly one full page: no cursor
    let all = get("&limit=5").await;
    assert_eq!(ids(&all), ["cm_5", "cm_4", "cm_3", "cm_2", "cm_1"]);
    assert_eq!(all.body["nextCursor"], Value::Null);
    // the default page holds everything here, items are full comments
    let default = get("").await;
    assert_eq!(default.body["items"].as_array().unwrap().len(), 5);
    assert_eq!(default.body["items"][0]["author"], json!({ "type": "system" }));
    assert_eq!(default.body["items"][0]["createdAt"], "2026-01-01T00:00:05.000Z");
    // the cursor names the last item at millisecond precision
    let cursor = encode_comment_cursor(&CommentCursor {
        at: "2026-01-01T00:00:03.500Z".parse().unwrap(),
        id: "cm_4".into(),
    });
    assert_eq!(first.body["nextCursor"].as_str().unwrap(), cursor);
    w.drop().await;
}

#[tokio::test]
async fn refuses_a_bad_page_request() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let get = |q: &str| w.send(Req::get(&format!("{URL}/page{q}")).session(&t.viewer));
    let res = get("").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(
        res.message().starts_with("subjectType must be one of the following values"),
        "{}",
        res.message()
    );
    let base = "?subjectType=issue&subjectId=in_a";
    for (q, message) in [
        ("&limit=0", "limit must not be less than 1"),
        ("&limit=101", "limit must not be greater than 100"),
        (
            "&limit=x",
            "limit must not be greater than 100; limit must not be less than 1; limit must be an integer number",
        ),
        ("&cursor=garbage!!", "cursor is not valid"),
        ("&cursor=bm9wZQ", "cursor is not valid"),
    ] {
        let res = get(&format!("{base}{q}")).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{q}");
        assert_eq!(res.message(), message, "{q}");
    }
    let res = get(&format!("{base}&cursor={}", "x".repeat(201))).await;
    assert_eq!(res.message(), "cursor must be shorter than or equal to 200 characters");
    let res = get("?subjectType=bogus&subjectId=in_a").await;
    assert!(res.message().starts_with("subjectType must be one of"));
    let res = w.send(Req::get(&format!("{URL}?subjectType=bogus")).session(&t.viewer)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    w.drop().await;
}

#[tokio::test]
async fn the_plain_list_is_oldest_first_and_bounded_to_one_page() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    sql(
        w.db(),
        r#"INSERT INTO comments (id, "workspaceId", subject, author, body, "createdAt", "updatedAt")
           SELECT 'cm_' || lpad(g::text, 3, '0'), 'ws_acme', '{"type":"issue","id":"in_a"}',
                  '{"type":"system"}', 'n' || g, now() + g * interval '1 second', now()
             FROM generate_series(1, 105) g"#,
    )
    .await;
    let res = w.send(Req::get(URL).session(&t.member)).await;
    let rows = res.body.as_array().unwrap();
    assert_eq!(rows.len(), 100);
    assert_eq!(rows[0]["id"], "cm_001");
    assert_eq!(rows[99]["id"], "cm_100");
    // the snapshot's listing is not bounded
    assert_eq!(list_all(w.db(), "ws_acme").await.unwrap().len(), 105);
    assert_eq!(list(w.db(), "ws_acme", Some("issue"), Some("in_a")).await.unwrap().len(), 100);
    // empty filters are no filters
    assert_eq!(list(w.db(), "ws_acme", Some(""), Some("")).await.unwrap().len(), 100);
    assert_eq!(list(w.db(), "ws_acme", None, Some("in_b")).await.unwrap().len(), 0);
    w.drop().await;
}

#[tokio::test]
async fn indexes_comments_per_subject_and_author() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    let issue = json!({ "type": "issue", "id": "in_1" });
    let (u1, agent, system) =
        (user("u_1"), json!({ "type": "agent", "id": "ag_1" }), json!({ "type": "system" }));
    for (id, subject, author) in [
        ("cm_1", &issue, &u1),
        ("cm_2", &issue, &u1),
        ("cm_3", &issue, &agent),
        ("cm_4", &json!({ "type": "workstream", "id": "wk_1" }), &system),
    ] {
        comment_at(w.db(), "ws_acme", id, subject, author, "x", "now()").await;
    }
    comment_at(w.db(), "ws_other", "cm_5", &issue, &u1, "x", "now()").await;

    let entries = index(w.db(), "ws_acme").await.unwrap();
    assert_eq!(
        serde_json::to_value(&entries).unwrap(),
        json!([
            { "subject": { "type": "issue", "id": "in_1" }, "author": { "type": "agent", "id": "ag_1" }, "count": 1 },
            { "subject": { "type": "issue", "id": "in_1" }, "author": { "type": "user", "id": "u_1" }, "count": 2 },
            { "subject": { "type": "workstream", "id": "wk_1" }, "author": { "type": "system" }, "count": 1 },
        ])
    );
    let all = list_all(w.db(), "ws_acme").await.unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(
        serde_json::to_value(&all[3].subject).unwrap(),
        json!({ "type": "workstream", "id": "wk_1" })
    );
    assert_eq!(index(w.db(), "ws_empty").await.unwrap(), vec![]);
    w.drop().await;
}

#[test]
fn the_page_query_is_scoped_ordered_and_one_row_over() {
    let sql = |cursor: Option<&CommentCursor>| {
        page_query("ws_1", SubjectType::Issue, "in_1", cursor, 50)
            .build(DbBackend::Postgres)
            .to_string()
    };
    let plain = sql(None);
    assert!(plain.contains(r#""comments"."workspaceId" = 'ws_1'"#), "{plain}");
    assert!(plain.contains(r#""comments"."subject"->>'type' = 'issue'"#), "{plain}");
    assert!(plain.contains(r#""comments"."subject"->>'id' = 'in_1'"#), "{plain}");
    assert!(
        plain.contains(
            r#"ORDER BY date_trunc('milliseconds', "comments"."createdAt") DESC, "comments"."id" DESC"#
        ),
        "{plain}"
    );
    assert!(plain.ends_with("LIMIT 51"), "{plain}");

    let at = "2026-03-04T05:06:07.089Z".parse().unwrap();
    let cursor = sql(Some(&CommentCursor { at, id: "cm_9".into() }));
    assert!(
        cursor.contains(
            r#"date_trunc('milliseconds', "comments"."createdAt") < '2026-03-04 05:06:07.089"#
        ),
        "{cursor}"
    );
    assert!(cursor.contains(r#""comments"."id" < 'cm_9'"#), "{cursor}");
    assert!(cursor.contains(r#""comments"."workspaceId" = 'ws_1'"#), "{cursor}");
}

#[tokio::test]
async fn keeps_the_files_a_comment_mentions() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let stage = |cookie: &str| {
        w.send(Req::post("/api/w/acme/uploads").session(cookie).file("shot.png", &PNG))
    };
    let markdown = |id: &str| format!("see ![shot.png](/api/w/acme/uploads/{id})");

    // a file nobody saved yet belongs to its uploader only
    let staged = stage(&t.member).await;
    assert_eq!(staged.status, StatusCode::CREATED);
    let upload = staged.body["id"].as_str().unwrap().to_owned();
    let res = post(&w, &t.other, "issue", "in_a", &markdown(&upload)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "That file is not available to attach here");
    assert_eq!(
        post(&w, &t.member, "issue", "in_a", "/api/w/acme/uploads/upl_abcdefghijkl").await.status,
        StatusCode::BAD_REQUEST
    );

    // the uploader saves it onto a comment: a reference keeps it alive
    let id = created(&w, &t.member, "issue", "in_a", &markdown(&upload)).await;
    let refs = upload_references::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(
        (refs[0].upload_id.as_str(), refs[0].subject_type.as_str()),
        (upload.as_str(), "comment")
    );
    assert_eq!(refs[0].subject_id, id);
    // now everyone who can read the comment can attach it again
    let again = created(&w, &t.other, "issue", "in_a", &markdown(&upload)).await;
    assert_eq!(upload_references::Entity::find().all(w.db()).await.unwrap().len(), 2);

    // editing the file out of the first comment keeps it (the second still mentions it)
    let res = w
        .send(
            Req::patch(&format!("{URL}/{id}"))
                .session(&t.member)
                .json(&json!({ "body": "no file" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(upload_references::Entity::find().all(w.db()).await.unwrap().len(), 1);
    assert!(uploads::Entity::find_by_id(&upload).one(w.db()).await.unwrap().is_some());
    // an edit may not point at a file the editor cannot attach
    let other = stage(&t.other).await.body["id"].as_str().unwrap().to_owned();
    let res = w
        .send(
            Req::patch(&format!("{URL}/{id}"))
                .session(&t.member)
                .json(&json!({ "body": markdown(&other) })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    // deleting the last comment that mentions it deletes the file
    let res = w.send(Req::delete(&format!("{URL}/{again}")).session(&t.other)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert!(upload_references::Entity::find().all(w.db()).await.unwrap().is_empty());
    assert!(uploads::Entity::find_by_id(&upload).one(w.db()).await.unwrap().is_none());
    w.drop().await;
}
