//! Web Push registration and delivery (`push.e2e-spec.ts`).

mod common;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Value, json};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::TokenScope;
use trama_entities::push_subscriptions;

use common::{
    Options, Req, VAPID_PUBLIC, World, eventually, issue, issue_subject, member, session, settle,
    token, user, workspace,
};

/// Public push services: IP literals need no name lookup.
const PHONE: &str = "https://8.8.8.8/dev-phone";
const LAPTOP: &str = "https://8.8.4.4/dev-laptop";

fn sub(endpoint: &str) -> Value {
    json!({ "endpoint": endpoint, "keys": { "p256dh": "BPlaceholderKeyForTests", "auth": "authsecret" } })
}

struct Cast {
    owner: String,
    dev: String,
}

async fn cast(w: &World) -> Cast {
    workspace(w.db(), "acme").await;
    user(w.db(), "u_owner", "Pia Owner").await;
    user(w.db(), "u_dev", "Dev Dario").await;
    member(w.db(), "ws_acme", "u_owner", "owner", None).await;
    member(w.db(), "ws_acme", "u_dev", "member", None).await;
    Cast { owner: session(w.db(), "u_owner").await, dev: session(w.db(), "u_dev").await }
}

async fn devices(w: &World, user: &str) -> Vec<push_subscriptions::Model> {
    push_subscriptions::Entity::find()
        .filter(push_subscriptions::Column::UserId.eq(user))
        .all(w.db())
        .await
        .unwrap()
}

async fn assign(w: &World, id: &str, key: &str, title: &str) {
    issue(w.db(), "ws_acme", id, key, title, Some("u_dev"), None).await;
    w.record(
        "ws_acme",
        ActorRef::user("u_owner"),
        "issue.created",
        issue_subject(id),
        json!({ "assigneeId": "u_dev" }),
    )
    .await;
}

#[tokio::test]
async fn exposes_the_public_key_registers_a_device_idempotently_and_forgets_it() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let status = w.send(Req::get("/api/me/push").session(&c.dev)).await;
    assert_eq!(status.status, StatusCode::OK);
    assert_eq!(status.body, json!({ "enabled": true, "publicKey": VAPID_PUBLIC }));

    let put = |body: Value| Req::put("/api/me/push/subscription", &body).session(&c.dev);
    // not https
    assert_eq!(w.send(put(sub("http://insecure.example/x"))).await.status, StatusCode::BAD_REQUEST);
    // one key missing
    let half = json!({ "endpoint": "https://push.example/a", "keys": { "p256dh": "x" } });
    let res = w.send(put(half)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "keys.p256dh and keys.auth are required");
    // no keys at all
    let res = w.send(put(json!({ "endpoint": "https://push.example/a" }))).await;
    assert_eq!(res.message(), "keys must be an object");
    // an endpoint that points inward is refused by the SSRF guard
    for endpoint in ["https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.5/x"] {
        let res = w.send(put(sub(endpoint))).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{endpoint}");
        assert!(res.message().starts_with("Invalid push endpoint: "), "{}", res.message());
    }
    assert!(devices(&w, "u_dev").await.is_empty());

    for _ in 0..2 {
        let res = w
            .send(put(sub(PHONE)).header("user-agent", &format!("Mozilla/5.0 {}", "x".repeat(400))))
            .await;
        // `PUT` answers 200
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body, json!({ "enabled": true }));
    }
    let rows = devices(&w, "u_dev").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].endpoint, PHONE);
    assert!(rows[0].id.starts_with("psh_"));
    assert_eq!(rows[0].user_agent.as_deref().map(str::len), Some(300));
    assert_eq!(
        (rows[0].p256dh.as_str(), rows[0].auth.as_str()),
        ("BPlaceholderKeyForTests", "authsecret")
    );

    // the secrets never leave the server
    let status = w.send(Req::get("/api/me/push").session(&c.dev)).await;
    assert!(status.body.get("p256dh").is_none());

    for _ in 0..2 {
        let res = w
            .send(
                Req::delete("/api/me/push/subscription", &json!({ "endpoint": PHONE }))
                    .session(&c.dev),
            )
            .await;
        assert_eq!(res.status, StatusCode::NO_CONTENT);
    }
    assert!(devices(&w, "u_dev").await.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn a_device_that_moves_to_another_account_is_repointed_and_only_the_owner_can_remove_it() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let put =
        |cookie: &str, body: Value| Req::put("/api/me/push/subscription", &body).session(cookie);
    assert_eq!(w.send(put(&c.dev, sub(PHONE))).await.status, StatusCode::OK);
    let first = devices(&w, "u_dev").await.remove(0);

    // someone else cannot remove it
    let res = w
        .send(
            Req::delete("/api/me/push/subscription", &json!({ "endpoint": PHONE }))
                .session(&c.owner),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(devices(&w, "u_dev").await.len(), 1);

    // signing in on the same browser as the other person moves it
    let moved = json!({ "endpoint": PHONE, "keys": { "p256dh": "newkey", "auth": "newauth" } });
    assert_eq!(w.send(put(&c.owner, moved)).await.status, StatusCode::OK);
    assert!(devices(&w, "u_dev").await.is_empty());
    let rows = devices(&w, "u_owner").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, first.id);
    assert_eq!(rows[0].created_at, first.created_at);
    assert_eq!(rows[0].p256dh, "newkey");
    w.drop().await;
}

#[tokio::test]
async fn validates_the_endpoint_to_forget() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let res = w.send(Req::delete("/api/me/push/subscription", &json!({})).session(&c.dev)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        "endpoint must be shorter than or equal to 2000 characters; endpoint must be a string"
    );
    let long = json!({ "endpoint": "x".repeat(2001) });
    let res = w.send(Req::delete("/api/me/push/subscription", &long).session(&c.dev)).await;
    assert_eq!(res.message(), "endpoint must be shorter than or equal to 2000 characters");
    w.drop().await;
}

#[tokio::test]
async fn push_is_personal_session_only_and_off_without_keys() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    let secret = token(w.db(), "ws_acme", ActorRef::user("u_dev"), TokenScope::Admin).await;
    assert_eq!(
        w.send(Req::get("/api/me/push").bearer(&secret)).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(Req::put("/api/me/push/subscription", &sub(PHONE)).bearer(&secret)).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(w.send(Req::get("/api/me/push")).await.status, StatusCode::UNAUTHORIZED);
    let _ = c;
    w.drop().await;

    let Some(w) = World::with(Options { vapid: false, listen: false }).await else { return };
    let c = cast(&w).await;
    let status = w.send(Req::get("/api/me/push").session(&c.dev)).await;
    assert_eq!(status.body, json!({ "enabled": false, "publicKey": null }));
    let res = w.send(Req::put("/api/me/push/subscription", &sub(PHONE)).session(&c.dev)).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Push notifications are not set up on this server");
    // validation runs first
    let res = w
        .send(
            Req::put("/api/me/push/subscription", &sub("http://insecure.example/x"))
                .session(&c.dev),
        )
        .await;
    assert_eq!(res.message(), "endpoint must be a URL address");
    w.drop().await;
}

#[tokio::test]
async fn sends_a_system_notification_to_the_assignees_devices_when_push_is_on() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    for endpoint in [PHONE, LAPTOP] {
        assert_eq!(
            w.send(Req::put("/api/me/push/subscription", &sub(endpoint)).session(&c.dev))
                .await
                .status,
            StatusCode::OK
        );
    }
    assign(&w, "in_1", "BUG-1", "Pager duty").await;
    let calls =
        eventually("both devices", || async { w.push.calls() }, |calls| calls.len() == 2).await;

    let mut endpoints: Vec<&str> = calls.iter().map(|call| call.endpoint.as_str()).collect();
    endpoints.sort_unstable();
    assert_eq!(endpoints, [LAPTOP, PHONE]);
    let call = &calls[0];
    let payload: Value = serde_json::from_str(&call.payload).unwrap();
    let notification = &payload["notification"];
    assert_eq!(notification["title"], "Pia Owner assigned you BUG-1: Pager duty");
    assert_eq!(notification["tag"], "assigned:in_1");
    assert_eq!(
        notification["data"]["onActionClick"]["default"],
        json!({ "operation": "navigateLastFocusedOrOpen", "url": "/acme/tasks/BUG-1" })
    );
    assert_eq!((call.ttl, call.timeout.as_secs()), (86_400, 10));
    assert_eq!(call.p256dh, "BPlaceholderKeyForTests");
    assert_eq!(call.auth, "authsecret");
    // the inbox got it too
    let inbox = w.send(Req::get("/api/w/acme/notifications").session(&c.dev)).await;
    assert_eq!(inbox.body["items"].as_array().unwrap().len(), 1);
    // nobody else's devices were used
    assert!(devices(&w, "u_owner").await.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn respects_the_per_kind_push_switch_and_drops_dead_subscriptions() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    w.send(Req::put("/api/me/push/subscription", &sub(PHONE)).session(&c.dev)).await;

    let off = json!({ "settings": { "assigned": { "push": false } } });
    w.send(Req::patch("/api/me/notification-settings", &off).session(&c.dev)).await;
    assign(&w, "in_2", "BUG-2", "Quiet one").await;
    settle().await;
    assert!(w.push.calls().is_empty());
    // the inbox still got it
    let inbox = w.send(Req::get("/api/w/acme/notifications").session(&c.dev)).await;
    assert_eq!(inbox.body["items"].as_array().unwrap().len(), 1);

    let on = json!({ "settings": { "assigned": { "push": true } } });
    w.send(Req::patch("/api/me/notification-settings", &on).session(&c.dev)).await;
    w.push.fail_with(Some(410));
    assign(&w, "in_3", "BUG-3", "Dead device").await;
    eventually("the attempt", || async { w.push.calls() }, |calls| !calls.is_empty()).await;
    // the 410 removes the subscription
    eventually("the removal", || devices(&w, "u_dev"), Vec::is_empty).await;

    w.push.reset();
    assign(&w, "in_4", "BUG-4", "After the 410").await;
    settle().await;
    assert!(w.push.calls().is_empty());
    w.drop().await;
}

#[tokio::test]
async fn keeps_a_subscription_when_the_push_service_fails_for_another_reason() {
    let Some(w) = World::new().await else { return };
    let c = cast(&w).await;
    w.send(Req::put("/api/me/push/subscription", &sub(PHONE)).session(&c.dev)).await;
    w.push.fail_with(Some(500));
    assign(&w, "in_5", "BUG-5", "Flaky service").await;
    eventually("the attempt", || async { w.push.calls() }, |calls| !calls.is_empty()).await;
    settle().await;
    assert_eq!(devices(&w, "u_dev").await.len(), 1);
    // the failure did not stop the inbox
    let inbox = w.send(Req::get("/api/w/acme/notifications").session(&c.dev)).await;
    assert_eq!(inbox.body["items"].as_array().unwrap().len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn does_not_push_without_vapid_keys_but_still_fills_the_inbox() {
    let Some(w) = World::with(Options { vapid: false, listen: true }).await else { return };
    let c = cast(&w).await;
    // a device registered while keys existed
    common::sql(
        w.db(),
        r#"INSERT INTO push_subscriptions (id, "userId", endpoint, p256dh, auth) VALUES ('psh_1', 'u_dev', 'https://8.8.8.8/old', 'k', 'a')"#,
    )
    .await;
    assign(&w, "in_6", "BUG-6", "No keys").await;
    eventually(
        "the inbox",
        || async { w.send(Req::get("/api/w/acme/notifications").session(&c.dev)).await.body },
        |b| !b["items"].as_array().unwrap().is_empty(),
    )
    .await;
    settle().await;
    assert!(w.push.calls().is_empty());
    let n = push_subscriptions::Entity::find().count(w.db()).await.unwrap();
    assert_eq!(n, 1);
    let _ = &c.owner;
    w.drop().await;
}
