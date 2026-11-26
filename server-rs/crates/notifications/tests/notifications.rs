//! The inbox routes, the settings routes and how recorded domain events become notifications
//! (`notifications.e2e-spec.ts`, plus the project boundary and delivery rules of the specs).
//!
//! The NestJS e2e drives the tasks, comments and artifacts routes; those modules are ported
//! separately, so these tests record the domain events they record (same type, subject and
//! payload) and let the real listener produce the notifications.

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::TokenScope;

use common::{
    Req, World, agent, artifact, artifact_subject, eventually, issue, issue_subject, member,
    only_projects, project, project_subject, session, settle, sql, token, user, workspace,
};

struct Cast {
    owner: String,
    dev: String,
}

/// `Olivia Owner` owns `acme`, `Dev Dana` is a member.
async fn cast(w: &World) -> Cast {
    workspace(w.db(), "acme").await;
    user(w.db(), "u_owner", "Olivia Owner").await;
    user(w.db(), "u_dev", "Dev Dana").await;
    member(w.db(), "ws_acme", "u_owner", "owner", None).await;
    member(w.db(), "ws_acme", "u_dev", "member", None).await;
    Cast { owner: session(w.db(), "u_owner").await, dev: session(w.db(), "u_dev").await }
}

async fn inbox(w: &World, cookie: &str, query: &str) -> Value {
    let res = w.send(Req::get(&format!("/api/w/acme/notifications{query}")).session(cookie)).await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    res.body
}

async fn inbox_len(w: &World, cookie: &str) -> usize {
    items(&inbox(w, cookie, "").await).len()
}

fn items(body: &Value) -> &Vec<Value> {
    body["items"].as_array().unwrap()
}

fn owner() -> ActorRef {
    ActorRef::user("u_owner")
}

#[tokio::test]
async fn tells_someone_an_issue_was_assigned_to_them_and_only_them() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_1", "BUG-1", "Session expires", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_1"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;

    let body =
        eventually("the assignment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    assert_eq!(body["unread"], 1);
    let first = &items(&body)[0];
    assert_eq!(first["kind"], "assigned");
    assert_eq!(first["link"], "tasks/BUG-1");
    assert_eq!(first["title"], "Olivia Owner assigned you BUG-1: Session expires");
    assert_eq!(first["workspaceId"], "ws_acme");
    assert_eq!(first["actor"], json!({ "type": "user", "id": "u_owner" }));
    assert_eq!(first["subject"], json!({ "type": "issue", "id": "in_1" }));
    assert!(first["id"].as_str().unwrap().starts_with("ntf_"));
    // null fields are left out and the recipient is not part of the row
    for absent in ["readAt", "body", "userId"] {
        assert!(first.get(absent).is_none(), "{absent}");
    }
    assert!(first["createdAt"].as_str().unwrap().ends_with('Z'));
    // the person who acted is not told
    settle().await;
    assert_eq!(inbox_len(&w, &c.owner).await, 0);
    w.drop().await;
}

#[tokio::test]
async fn notifies_a_new_assignee_on_update_but_not_when_nothing_changed() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_2", "FEA-2", "Reassign me please", Some("u_dev"), None).await;
    let subject = || issue_subject("in_2");
    // a title change names no new assignee
    w.record("ws_acme", owner(), "issue.updated", subject(), json!({ "fields": ["title"] })).await;
    settle().await;
    assert_eq!(inbox_len(&w, &c.dev).await, 0);

    let change = json!({ "fields": ["assigneeId"], "assignee": { "from": null, "to": "u_dev" } });
    w.record("ws_acme", owner(), "issue.updated", subject(), change.clone()).await;
    eventually("the reassignment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;

    // the same message again within the minute is dropped
    w.record("ws_acme", owner(), "issue.updated", subject(), change).await;
    settle().await;
    let after = inbox(&w, &c.dev, "").await;
    let mine: Vec<Value> = items(&after)
        .iter()
        .filter(|n| n["kind"] == "assigned" && n["title"].as_str().unwrap().contains("Reassign me"))
        .cloned()
        .collect();
    assert_eq!(mine.len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn comments_notify_the_assignee_and_marking_read_lowers_the_unread_count() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_3", "BUG-3", "Needs eyes", Some("u_dev"), None).await;
    let excerpt = "Looks like a race condition in the refresh path.";
    w.record(
        "ws_acme",
        owner(),
        "comment.created",
        issue_subject("in_3"),
        json!({ "commentId": "cm_1", "excerpt": excerpt }),
    )
    .await;
    let after = eventually("the comment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    let comment = items(&after).iter().find(|n| n["kind"] == "comment").unwrap().clone();
    assert_eq!(comment["link"], "tasks/BUG-3");
    assert_eq!(comment["body"], excerpt);
    assert_eq!(comment["title"], "Olivia Owner commented on BUG-3: Needs eyes");

    let unread_before = after["unread"].as_i64().unwrap();
    let res = w
        .send(
            Req::post("/api/w/acme/notifications/read", &json!({ "ids": [comment["id"]] }))
                .session(&c.dev),
        )
        .await;
    // `@HttpCode(200)`
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["unread"].as_i64().unwrap(), unread_before - 1);

    let all = inbox(&w, &c.dev, "").await;
    let read = items(&all).iter().find(|n| n["id"] == comment["id"]).unwrap();
    assert!(read["readAt"].as_str().is_some_and(|d| d.ends_with('Z')));
    let unread_only = inbox(&w, &c.dev, "?unread=true").await;
    assert!(items(&unread_only).iter().all(|n| n["id"] != comment["id"]));
    // `unread=false` is false, not a truthy string
    assert_eq!(items(&inbox(&w, &c.dev, "?unread=false").await).len(), items(&all).len());

    // no ids: everything
    let res = w.send(Req::post("/api/w/acme/notifications/read", &json!({})).session(&c.dev)).await;
    assert_eq!(res.body["unread"], 0);
    w.drop().await;
}

#[tokio::test]
async fn marking_read_only_touches_the_listed_ids_of_the_caller() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_4", "BUG-4", "Two for me", Some("u_dev"), None).await;
    for text in ["first", "second"] {
        w.record(
            "ws_acme",
            owner(),
            "comment.created",
            issue_subject("in_4"),
            json!({ "excerpt": text }),
        )
        .await;
    }
    // the two comments have the same title: only one is stored inside the dedupe window
    let body = eventually("a comment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    settle().await;
    assert_eq!(items(&body).len(), 1);
    let id = items(&body)[0]["id"].clone();

    // an empty list marks nothing; unknown and foreign ids are ignored
    for ids in [json!([]), json!(["ntf_nope"])] {
        let res = w
            .send(
                Req::post("/api/w/acme/notifications/read", &json!({ "ids": ids })).session(&c.dev),
            )
            .await;
        assert_eq!(res.body["unread"], 1, "{ids}");
    }
    let res = w
        .send(
            Req::post("/api/w/acme/notifications/read", &json!({ "ids": [id] })).session(&c.owner),
        )
        .await;
    assert_eq!(res.body["unread"], 0);
    assert_eq!(inbox(&w, &c.dev, "").await["unread"], 1);

    // validation: class-validator wording
    for (ids, message) in [
        (json!("a"), "ids must contain no more than 500 elements; ids must be an array"),
        (json!([1]), "each value in ids must be a string"),
    ] {
        let res = w
            .send(
                Req::post("/api/w/acme/notifications/read", &json!({ "ids": ids })).session(&c.dev),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.message(), message);
    }
    w.drop().await;
}

#[tokio::test]
async fn routes_review_requests_and_failing_ci_to_the_right_person() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_5", "BUG-5", "Harden auth", Some("u_dev"), None).await;
    artifact(w.db(), "ws_acme", "ar_1", Some("in_5")).await;
    w.record(
        "ws_acme",
        owner(),
        "review.requested",
        artifact_subject("ar_1"),
        json!({ "title": "PR #7", "issueId": "in_5" }),
    )
    .await;
    w.record(
        "ws_acme",
        owner(),
        "artifact.updated",
        artifact_subject("ar_1"),
        json!({ "title": "PR #7", "issueId": "in_5", "changes": { "ci": ["pending", "failing"] } }),
    )
    .await;

    let body = eventually(
        "the issue notifications",
        || inbox(&w, &c.dev, ""),
        |b| {
            ["review_requested", "ci_failed"]
                .iter()
                .all(|k| items(b).iter().any(|n| n["kind"] == *k))
        },
    )
    .await;
    let by = |kind: &str| items(&body).iter().find(|n| n["kind"] == kind).unwrap().clone();
    assert_eq!(by("review_requested")["link"], "tasks/BUG-5");
    assert_eq!(by("review_requested")["title"], "Review requested: PR #7");
    assert_eq!(by("review_requested")["body"], "BUG-5 · Harden auth");
    assert_eq!(by("review_requested")["subject"], json!({ "type": "artifact", "id": "ar_1" }));
    assert_eq!(by("ci_failed")["title"], "Checks are failing: PR #7");
    w.drop().await;
}

#[tokio::test]
async fn a_review_request_goes_to_the_reviewers_the_provider_named() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_6", "BUG-6", "Review me", Some("u_owner"), None).await;
    artifact(w.db(), "ws_acme", "ar_2", Some("in_6")).await;
    w.record(
        "ws_acme",
        ActorRef::system(),
        "review.requested",
        artifact_subject("ar_2"),
        json!({ "title": "PR #9", "issueId": "in_6", "reviewerUserIds": ["u_dev"] }),
    )
    .await;
    let body =
        eventually("the review request", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    assert_eq!(items(&body)[0]["kind"], "review_requested");
    assert_eq!(items(&body)[0]["actor"], json!({ "type": "system" }));
    // the assignee is not told when the reviewers are known
    settle().await;
    assert_eq!(inbox_len(&w, &c.owner).await, 0);
    w.drop().await;
}

#[tokio::test]
async fn respects_the_settings_a_muted_kind_produces_nothing() {
    // the server has no SMTP_URL
    let Some(w) = World::without_mail().await else { return };
    let c = cast(&w).await;
    let before = w.send(Req::get("/api/me/notification-settings").session(&c.dev)).await;
    assert_eq!(before.status, StatusCode::OK);
    assert_eq!(
        before.body["settings"]["assigned"],
        json!({ "inApp": true, "email": false, "push": true })
    );
    assert_eq!(before.body["emailAvailable"], false);
    let mut kinds: Vec<&str> =
        before.body["settings"].as_object().unwrap().keys().map(String::as_str).collect();
    kinds.sort_unstable();
    assert_eq!(kinds, ["assigned", "ci_failed", "comment", "review_requested"]);

    let updated = w
        .send(
            Req::patch(
                "/api/me/notification-settings",
                &json!({ "settings": { "assigned": { "inApp": false } } }),
            )
            .session(&c.dev),
        )
        .await;
    assert_eq!(updated.status, StatusCode::OK);
    assert_eq!(
        updated.body["settings"]["assigned"],
        json!({ "inApp": false, "email": false, "push": true })
    );
    // untouched
    assert_eq!(
        updated.body["settings"]["comment"],
        json!({ "inApp": true, "email": false, "push": true })
    );
    // stored as the full resolved object, readable back
    let again = w.send(Req::get("/api/me/notification-settings").session(&c.dev)).await;
    assert_eq!(again.body["settings"]["assigned"]["inApp"], false);

    issue(w.db(), "ws_acme", "in_7", "BUG-7", "Muted assignment", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_7"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    settle().await;
    assert_eq!(inbox_len(&w, &c.dev).await, 0);

    // switched back on, it works
    let on = json!({ "settings": { "assigned": { "inApp": true } } });
    assert_eq!(
        w.send(Req::patch("/api/me/notification-settings", &on).session(&c.dev)).await.status,
        StatusCode::OK
    );
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_7"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    eventually("the assignment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;

    for (body, message) in [
        (
            json!({ "settings": { "nonsense": { "inApp": true } } }),
            "Unknown notification kind \"nonsense\"",
        ),
        (json!({ "settings": { "assigned": { "sms": true } } }), "Unknown channel \"sms\""),
        (
            json!({ "settings": { "assigned": { "inApp": "yes" } } }),
            "assigned.inApp must be true or false",
        ),
        (
            json!({ "settings": { "assigned": null } }),
            "Settings for \"assigned\" must be an object",
        ),
        (json!({}), "settings must be an object"),
        (json!({ "settings": [] }), "settings must be an object"),
    ] {
        let res = w.send(Req::patch("/api/me/notification-settings", &body).session(&c.dev)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.message(), message, "{body}");
    }
    w.drop().await;
}

#[tokio::test]
async fn keeps_notifications_private_and_out_of_agents_reach() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    issue(w.db(), "ws_acme", "in_8", "BUG-8", "Private", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_8"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    eventually("the assignment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    let owners = inbox(&w, &c.owner, "").await;
    assert!(items(&owners).iter().all(|n| !n["title"].as_str().unwrap().contains("assigned you")));

    agent(w.db(), "ws_acme", "ag_1", "Bot").await;
    let secret = token(w.db(), "ws_acme", ActorRef::agent("ag_1"), TokenScope::Admin).await;
    let res = w.send(Req::get("/api/w/acme/notifications").bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w.send(Req::post("/api/w/acme/notifications/read", &json!({})).bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    // personal settings never go through a token, and a non-member sees no workspace
    let user_token = token(w.db(), "ws_acme", ActorRef::user("u_dev"), TokenScope::Admin).await;
    assert_eq!(
        w.send(Req::get("/api/me/notification-settings").bearer(&user_token)).await.status,
        StatusCode::FORBIDDEN
    );
    user(w.db(), "u_out", "Outsider").await;
    let out = session(w.db(), "u_out").await;
    let res = w.send(Req::get("/api/w/acme/notifications").session(&out)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // not signed in
    assert_eq!(
        w.send(Req::get("/api/w/acme/notifications")).await.status,
        StatusCode::UNAUTHORIZED
    );
    w.drop().await;
}

#[tokio::test]
async fn a_viewer_can_mark_notifications_read() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    user(w.db(), "u_view", "Vera Viewer").await;
    member(w.db(), "ws_acme", "u_view", "viewer", None).await;
    let cookie = session(w.db(), "u_view").await;
    let res =
        w.send(Req::post("/api/w/acme/notifications/read", &json!({})).session(&cookie)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "unread": 0 }));
    w.drop().await;
}

#[tokio::test]
async fn validates_the_list_query() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    for (query, message) in [
        ("?unread=maybe", "unread must be a boolean value"),
        ("?limit=0", "limit must not be less than 1"),
        ("?limit=201", "limit must not be greater than 200"),
        ("?limit=1.5", "limit must be an integer number"),
    ] {
        let res =
            w.send(Req::get(&format!("/api/w/acme/notifications{query}")).session(&c.dev)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{query}");
        assert!(res.message().contains(message), "{query}: {}", res.message());
    }
    w.drop().await;
}

/// Inserts a stored notification of `user` about `subject`.
async fn stored(
    w: &World,
    id: &str,
    user: &str,
    subject: Value,
    kind: &str,
    minutes_ago: i64,
    read: bool,
) {
    sql(
        w.db(),
        &format!(
            r#"INSERT INTO notifications (id, "workspaceId", "userId", kind, title, actor, subject, link, "createdAt", "readAt")
               VALUES ('{id}', 'ws_acme', '{user}', '{kind}', 'Title {id}', '{{"type":"system"}}', '{subject}', 'tasks/X-1',
                       now() - interval '{minutes_ago} minutes', {})"#,
            if read { "now()" } else { "NULL" }
        ),
    )
    .await;
}

#[tokio::test]
async fn lists_newest_first_with_the_limit_and_the_unread_count() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let subject = json!({ "type": "issue", "id": "in_x" });
    stored(&w, "ntf_a", "u_dev", subject.clone(), "comment", 30, false).await;
    stored(&w, "ntf_b", "u_dev", subject.clone(), "comment", 20, true).await;
    stored(&w, "ntf_c", "u_dev", subject.clone(), "comment", 10, false).await;
    stored(&w, "ntf_o", "u_owner", subject, "comment", 5, false).await;

    let all = inbox(&w, &c.dev, "").await;
    let ids: Vec<&str> = items(&all).iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["ntf_c", "ntf_b", "ntf_a"]);
    assert_eq!(all["unread"], 2);
    let page = inbox(&w, &c.dev, "?limit=1").await;
    assert_eq!(items(&page).len(), 1);
    // the count does not follow the page size
    assert_eq!(page["unread"], 2);
    let unread = inbox(&w, &c.dev, "?unread=true").await;
    assert_eq!(items(&unread).len(), 2);
    w.drop().await;
}

#[tokio::test]
async fn the_retired_workstream_updates_link_to_the_task_list() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    stored(
        &w,
        "ntf_w",
        "u_dev",
        json!({ "type": "workstream", "id": "ws_1" }),
        "workstream_update",
        1,
        false,
    )
    .await;
    let body = inbox(&w, &c.dev, "").await;
    assert_eq!(items(&body)[0]["kind"], "workstream_update");
    assert_eq!(items(&body)[0]["link"], "tasks");
    w.drop().await;
}

#[tokio::test]
async fn someone_limited_to_some_projects_keeps_only_those_notifications() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    user(w.db(), "u_guest", "Gus Guest").await;
    member(w.db(), "ws_acme", "u_guest", "guest", Some(only_projects(&["p1"], false))).await;
    let cookie = session(w.db(), "u_guest").await;
    project(w.db(), "ws_acme", "p1").await;
    project(w.db(), "ws_acme", "p2").await;
    issue(w.db(), "ws_acme", "in_in", "IN-1", "Inside", None, Some("p1")).await;
    issue(w.db(), "ws_acme", "in_out", "OUT-1", "Outside", None, Some("p2")).await;
    issue(w.db(), "ws_acme", "in_none", "NON-1", "Unassigned", None, None).await;
    artifact(w.db(), "ws_acme", "ar_in", Some("in_in")).await;
    artifact(w.db(), "ws_acme", "ar_out", Some("in_out")).await;
    let rows = [
        ("ntf_1", json!({ "type": "issue", "id": "in_in" })),
        ("ntf_2", json!({ "type": "issue", "id": "in_out" })),
        ("ntf_3", json!({ "type": "issue", "id": "in_none" })),
        ("ntf_4", json!({ "type": "artifact", "id": "ar_in" })),
        ("ntf_5", json!({ "type": "artifact", "id": "ar_out" })),
        ("ntf_6", json!({ "type": "project", "id": "p1" })),
        ("ntf_7", json!({ "type": "project", "id": "p2" })),
        ("ntf_8", json!({ "type": "issue", "id": "in_gone" })),
        ("ntf_9", json!({ "type": "workstream", "id": "wk" })),
    ];
    for (i, (id, subject)) in rows.iter().enumerate() {
        let kind = if *id == "ntf_9" { "workstream_update" } else { "comment" };
        stored(
            &w,
            id,
            "u_guest",
            subject.clone(),
            kind,
            i64::try_from(rows.len() - i).unwrap(),
            false,
        )
        .await;
    }
    let res = w.send(Req::get("/api/w/acme/notifications").session(&cookie)).await;
    assert_eq!(res.status, StatusCode::OK);
    let ids: Vec<&str> = items(&res.body).iter().map(|n| n["id"].as_str().unwrap()).collect();
    // the Workstream updater's rows are about nothing a limited person can open
    assert_eq!(ids, ["ntf_6", "ntf_4", "ntf_1"]);
    assert_eq!(res.body["unread"], 3);

    let page =
        w.send(Req::get("/api/w/acme/notifications?limit=2&unread=true").session(&cookie)).await;
    assert_eq!(items(&page.body).len(), 2);
    assert_eq!(page.body["unread"], 3);
    w.drop().await;
}

#[tokio::test]
async fn does_not_notify_someone_about_work_in_a_project_outside_their_list() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    user(w.db(), "u_owner", "Olivia Owner").await;
    user(w.db(), "guest-in", "Guest In").await;
    user(w.db(), "guest-out", "Guest Out").await;
    user(w.db(), "u_dev", "Dev Dana").await;
    member(w.db(), "ws_acme", "u_owner", "owner", None).await;
    member(w.db(), "ws_acme", "guest-in", "guest", Some(only_projects(&["p1"], false))).await;
    member(w.db(), "ws_acme", "guest-out", "guest", Some(only_projects(&["p2"], false))).await;
    member(w.db(), "ws_acme", "u_dev", "member", None).await;
    project(w.db(), "ws_acme", "p1").await;
    project(w.db(), "ws_acme", "p2").await;
    // the assignee is a guest of another project; the reporter sees everything
    issue(w.db(), "ws_acme", "in_9", "ABC-1", "Issue", Some("guest-out"), Some("p1")).await;
    sql(w.db(), "UPDATE issues SET \"reporterId\" = 'u_dev' WHERE id = 'in_9'").await;
    w.record(
        "ws_acme",
        owner(),
        "comment.created",
        issue_subject("in_9"),
        json!({ "excerpt": "x" }),
    )
    .await;
    let dev = session(w.db(), "u_dev").await;
    eventually("the comment", || inbox(&w, &dev, ""), |b| !items(b).is_empty()).await;
    settle().await;
    let guest_out = session(w.db(), "guest-out").await;
    assert_eq!(inbox_len(&w, &guest_out).await, 0);

    // a guest of the task's project is told
    sql(w.db(), "UPDATE issues SET \"assigneeId\" = 'guest-in' WHERE id = 'in_9'").await;
    w.record(
        "ws_acme",
        owner(),
        "comment.created",
        issue_subject("in_9"),
        json!({ "excerpt": "y" }),
    )
    .await;
    let guest_in = session(w.db(), "guest-in").await;
    let body =
        eventually("the guest's comment", || inbox(&w, &guest_in, ""), |b| !items(b).is_empty())
            .await;
    assert_eq!(items(&body).len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn people_who_left_the_workspace_are_not_told() {
    let Some(w) = World::new().await else { return };
    let _ = cast(&w).await;
    user(w.db(), "u_gone", "Gone Gary").await;
    issue(w.db(), "ws_acme", "in_g", "GON-1", "Left", Some("u_gone"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_g"),
        json!({ "assigneeId": "u_gone" }),
    )
    .await;
    // a notification for someone else proves the event was handled
    issue(w.db(), "ws_acme", "in_h", "GON-2", "Here", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_h"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    let dev = session(w.db(), "u_dev").await;
    eventually("the assignment", || inbox(&w, &dev, ""), |b| !items(b).is_empty()).await;
    use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
    let gone = trama_entities::notifications::Entity::find()
        .filter(trama_entities::notifications::Column::UserId.eq("u_gone"))
        .count(w.db())
        .await
        .unwrap();
    assert_eq!(gone, 0);
    w.drop().await;
}

#[tokio::test]
async fn emails_the_person_when_they_ask_for_it() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let settings = w.send(Req::get("/api/me/notification-settings").session(&c.dev)).await;
    assert_eq!(settings.body["emailAvailable"], true);
    let on =
        json!({ "settings": { "assigned": { "email": true, "inApp": false, "push": false } } });
    assert_eq!(
        w.send(Req::patch("/api/me/notification-settings", &on).session(&c.dev)).await.status,
        StatusCode::OK
    );
    issue(w.db(), "ws_acme", "in_m", "BUG-9", "Mail me", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_m"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    let sent = eventually("the email", || async { w.mailer.sent() }, |s| !s.is_empty()).await;
    assert_eq!(sent.len(), 1);
    let mail = &sent[0].mail;
    assert_eq!(mail.to, "u_dev@test.dev");
    assert_eq!(mail.subject, "Olivia Owner assigned you BUG-9: Mail me");
    let app_url = &w.state.config.app_url;
    assert_eq!(
        mail.text,
        format!(
            "Olivia Owner assigned you BUG-9: Mail me\n\n{app_url}/acme/tasks/BUG-9\n\nYou can change what Trama emails you in Settings → Notifications."
        )
    );
    // nothing went to the inbox
    assert_eq!(inbox_len(&w, &c.dev).await, 0);
    w.drop().await;
}

#[tokio::test]
async fn emails_include_the_excerpt_between_the_title_and_the_link() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let on = json!({ "settings": { "comment": { "email": true } } });
    w.send(Req::patch("/api/me/notification-settings", &on).session(&c.dev)).await;
    issue(w.db(), "ws_acme", "in_c", "BUG-10", "Talk", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "comment.created",
        issue_subject("in_c"),
        json!({ "excerpt": "Hello there" }),
    )
    .await;
    let sent = eventually("the email", || async { w.mailer.sent() }, |s| !s.is_empty()).await;
    let lines: Vec<&str> = sent[0].mail.text.lines().collect();
    assert_eq!(lines[0], "Olivia Owner commented on BUG-10: Talk");
    assert_eq!(lines[1], "Hello there");
    assert_eq!(lines[2], "");
    assert!(lines[3].ends_with("/acme/tasks/BUG-10"));
    w.drop().await;
}

#[tokio::test]
async fn tells_the_recipients_streams_and_no_one_elses() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let mut live = w.events.subscribe();
    issue(w.db(), "ws_acme", "in_l", "BUG-11", "Live", Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_l"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    let body =
        eventually("the assignment", || inbox(&w, &c.dev, ""), |b| !items(b).is_empty()).await;
    let id = items(&body)[0]["id"].as_str().unwrap().to_owned();
    let mut seen = None;
    while let Ok(published) = live.try_recv() {
        if published.event.entity == trama_contracts::activity::LiveEventEntity::Notification {
            seen = Some(published);
        }
    }
    let published = seen.expect("a notification live event");
    assert_eq!(published.user_id.as_deref(), Some("u_dev"));
    assert_eq!(published.workspace_id, "ws_acme");
    assert_eq!(published.event.id, id);
    assert_eq!(published.event.kind, trama_contracts::activity::LiveEventType::Created);

    // marking read tells the person's own other tabs
    w.send(Req::post("/api/w/acme/notifications/read", &json!({})).session(&c.dev)).await;
    let read = live.try_recv().unwrap();
    assert_eq!(read.user_id.as_deref(), Some("u_dev"));
    assert_eq!(read.event.id, "read");
    assert_eq!(read.event.kind, trama_contracts::activity::LiveEventType::Updated);
    w.drop().await;
}

mod delivery {
    use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
    use trama_common::Mailer;
    use trama_contracts::common::{LegacySubjectRef, LegacySubjectType};
    use trama_contracts::identity::NotificationKind;
    use trama_entities::{notifications, users, workspaces};
    use trama_events::Events;
    use trama_notifications::PushService;
    use trama_notifications::delivery::{Env, Recipient, deliver};
    use trama_notifications::rules::NotificationDraft;

    use super::*;

    fn draft() -> NotificationDraft {
        NotificationDraft {
            user_id: "u_dev".into(),
            kind: NotificationKind::Assigned,
            title: "Assigned".into(),
            body: Some("b".repeat(600)),
            link: "tasks/ABC-1".into(),
            subject: LegacySubjectRef { kind: LegacySubjectType::Issue, id: "i1".into() },
        }
    }

    struct Fixture {
        env: Env,
        workspace: workspaces::Model,
        recipient: Recipient,
    }

    async fn fixture(w: &World) -> Fixture {
        let _ = cast(w).await;
        let workspace =
            workspaces::Entity::find_by_id("ws_acme").one(w.db()).await.unwrap().unwrap();
        let dev = users::Entity::find_by_id("u_dev").one(w.db()).await.unwrap().unwrap();
        let env = Env {
            db: w.db().clone(),
            events: Events::local(),
            mailer: Mailer::capture(&w.state.config),
            push: PushService::from_config(&w.state.config),
            app_url: "http://app.test".into(),
            actor: json!({ "type": "user", "id": "u_owner" }),
        };
        Fixture {
            env,
            workspace,
            recipient: Recipient { draft: draft(), user: Some(dev), is_member: true },
        }
    }

    async fn count(w: &World) -> u64 {
        notifications::Entity::find()
            .filter(notifications::Column::UserId.eq("u_dev"))
            .count(w.db())
            .await
            .unwrap()
    }

    /// Two deliveries of the same message at once store it once: the advisory lock makes the
    /// second one see the first one's row.
    #[tokio::test]
    async fn serializes_competing_duplicate_deliveries() {
        let Some(w) = World::with(common::Options { vapid: false, listen: false }).await else {
            return;
        };
        let f = fixture(&w).await;
        let (a, b, c) = tokio::join!(
            deliver(&f.env, &f.workspace, &f.recipient),
            deliver(&f.env, &f.workspace, &f.recipient),
            deliver(&f.env, &f.workspace, &f.recipient),
        );
        (a.unwrap(), b.unwrap(), c.unwrap());
        assert_eq!(count(&w).await, 1);
        // the body is cut at 500 characters
        let row = notifications::Entity::find().one(w.db()).await.unwrap().unwrap();
        assert_eq!(row.body.unwrap().chars().count(), 500);
        assert_eq!(row.actor, json!({ "type": "user", "id": "u_owner" }));
        assert_eq!(row.subject, json!({ "type": "issue", "id": "i1" }));
        assert!(row.read_at.is_none());
        w.drop().await;
    }

    #[tokio::test]
    async fn dedupes_by_workspace_person_kind_and_title_within_a_minute() {
        let Some(w) = World::with(common::Options { vapid: false, listen: false }).await else {
            return;
        };
        let f = fixture(&w).await;
        deliver(&f.env, &f.workspace, &f.recipient).await.unwrap();
        // another title, another kind: stored
        let mut other_title = f.recipient.clone();
        other_title.draft.title = "Assigned again".into();
        deliver(&f.env, &f.workspace, &other_title).await.unwrap();
        let mut other_kind = f.recipient.clone();
        other_kind.draft.kind = NotificationKind::Comment;
        deliver(&f.env, &f.workspace, &other_kind).await.unwrap();
        deliver(&f.env, &f.workspace, &f.recipient).await.unwrap();
        assert_eq!(count(&w).await, 3);

        // outside the window the same message is stored again
        sql(w.db(), "UPDATE notifications SET \"createdAt\" = now() - interval '2 minutes'").await;
        deliver(&f.env, &f.workspace, &f.recipient).await.unwrap();
        assert_eq!(count(&w).await, 4);
        w.drop().await;
    }

    #[tokio::test]
    async fn skips_people_who_are_gone_or_no_longer_members() {
        let Some(w) = World::with(common::Options { vapid: false, listen: false }).await else {
            return;
        };
        let f = fixture(&w).await;
        let mut not_member = f.recipient.clone();
        not_member.is_member = false;
        deliver(&f.env, &f.workspace, &not_member).await.unwrap();
        let mut gone = f.recipient.clone();
        gone.user = None;
        deliver(&f.env, &f.workspace, &gone).await.unwrap();
        assert_eq!(count(&w).await, 0);
        w.drop().await;
    }

    #[tokio::test]
    async fn forgets_notifications_read_more_than_ninety_days_ago() {
        let Some(w) = World::with(common::Options { vapid: false, listen: false }).await else {
            return;
        };
        let f = fixture(&w).await;
        let subject = json!({ "type": "issue", "id": "in_x" });
        stored(&w, "ntf_old", "u_dev", subject.clone(), "comment", 1, true).await;
        stored(&w, "ntf_new", "u_dev", subject.clone(), "comment", 1, true).await;
        stored(&w, "ntf_unread", "u_dev", subject, "comment", 1, false).await;
        sql(
            w.db(),
            "UPDATE notifications SET \"readAt\" = now() - interval '91 days' WHERE id = 'ntf_old'",
        )
        .await;
        sql(
            w.db(),
            "UPDATE notifications SET \"readAt\" = now() - interval '89 days' WHERE id = 'ntf_new'",
        )
        .await;
        sql(w.db(), "UPDATE notifications SET \"createdAt\" = now() - interval '100 days' WHERE id = 'ntf_unread'")
            .await;
        deliver(&f.env, &f.workspace, &f.recipient).await.unwrap();
        let ids: Vec<String> = notifications::Entity::find()
            .filter(notifications::Column::UserId.eq("u_dev"))
            .all(w.db())
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert!(!ids.contains(&"ntf_old".to_owned()));
        assert!(ids.contains(&"ntf_new".to_owned()));
        assert!(ids.contains(&"ntf_unread".to_owned()));
        assert_eq!(ids.len(), 3);
        w.drop().await;
    }
}

#[tokio::test]
async fn project_events_notify_nobody_and_unknown_issues_are_skipped() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    // an event about a task that does not exist (any more)
    w.record(
        "ws_acme",
        owner(),
        "issue.created",
        issue_subject("in_missing"),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
    // a project event the rules ignore
    w.record("ws_acme", owner(), "project.created", project_subject("pr_1"), json!({})).await;
    settle().await;
    assert_eq!(inbox_len(&w, &c.dev).await, 0);
    w.drop().await;
}
