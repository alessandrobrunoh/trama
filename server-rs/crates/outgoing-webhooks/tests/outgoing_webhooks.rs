//! The outgoing webhook routes and the delivery task against a real database and the real
//! access guard: `server/test/outgoing-webhooks.e2e-spec.ts`. The pure parts (signature,
//! DTO rules, pattern matching) are unit tests next to the code.

mod common;

use axum::http::StatusCode;
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use trama_common::Secrets;
use trama_contracts::common::SubjectType;
use trama_entities::{outgoing_webhook_deliveries, outgoing_webhooks};
use trama_events::Events;
use trama_outgoing_webhooks::delivery::{self, DELIVERY_LOG_KEEP};
use trama_outgoing_webhooks::signature::verify_signature;

use common::{Req, Res, World, member, session, sql, user, workspace};

const W: &str = "/api/w/own/outgoing-webhooks";

struct Fx {
    w: World,
    olivia: String,
    mia: String,
}

/// `own`, owned by Olivia, with Mia as a plain member; `other`, owned by Otto.
async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    let db = w.db();
    workspace(db, "own").await;
    workspace(db, "other").await;
    user(db, "olivia", "Olivia").await;
    user(db, "mia", "Mia").await;
    user(db, "otto", "Otto").await;
    member(db, "ws_own", "olivia", "owner").await;
    member(db, "ws_own", "mia", "member").await;
    member(db, "ws_other", "otto", "owner").await;
    let olivia = session(db, "olivia").await;
    let mia = session(db, "mia").await;
    Some(Fx { w, olivia, mia })
}

impl Fx {
    async fn get(&self, uri: &str) -> Res {
        self.w.send(Req::get(uri).session(&self.olivia)).await
    }
    async fn post(&self, uri: &str, body: &Value) -> Res {
        self.w.send(Req::post(uri).session(&self.olivia).json(body)).await
    }
    async fn post_empty(&self, uri: &str) -> Res {
        self.w.send(Req::post(uri).session(&self.olivia)).await
    }
    async fn patch(&self, uri: &str, body: &Value) -> Res {
        self.w.send(Req::patch(uri).session(&self.olivia).json(body)).await
    }
    async fn delete(&self, uri: &str) -> Res {
        self.w.send(Req::delete(uri).session(&self.olivia)).await
    }

    /// Creates a webhook for `https://hooks.example.com<path>`; returns its id and secret.
    async fn create(&self, path: &str, events: &[&str]) -> (String, String) {
        let res = self
            .post(
                W,
                &json!({ "name": format!("hook {path}"), "url": format!("https://hooks.example.com{path}"), "events": events }),
            )
            .await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        (
            res.body["webhook"]["id"].as_str().unwrap().to_owned(),
            res.body["secret"].as_str().unwrap().to_owned(),
        )
    }

    async fn log(&self, id: &str) -> Vec<Value> {
        let res = self.get(&format!("{W}/{id}/deliveries")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body.as_array().unwrap().clone()
    }

    /// The event types delivered to `path`, oldest first.
    fn delivered(&self, path: &str) -> Vec<String> {
        self.w.to(path).iter().map(|c| header(c, "X-Trama-Event")).collect()
    }
}

fn header(req: &trama_integrations::HttpRequest, name: &str) -> String {
    let (_, value) =
        req.headers.iter().find(|(k, _)| k == name).unwrap_or_else(|| panic!("no {name} header"));
    value.clone()
}

fn body(req: &trama_integrations::HttpRequest) -> Value {
    serde_json::from_str(req.raw_body.as_deref().unwrap()).unwrap()
}

#[tokio::test]
async fn creates_a_webhook_shows_the_secret_once_and_never_lists_it() {
    let Some(f) = fx().await else { return };
    let res = f
        .post(W, &json!({ "name": " Build ", "url": "https://hooks.example.com/ok", "events": ["issue.*", "issue.*"] }))
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let secret = res.body["secret"].as_str().unwrap();
    assert!(secret.starts_with("whsec_"));
    let webhook = &res.body["webhook"];
    assert_eq!(webhook["name"], "Build");
    assert_eq!(webhook["enabled"], true);
    assert_eq!(webhook["events"], json!(["issue.*"]));
    assert_eq!(webhook["url"], "https://hooks.example.com/ok");
    assert_eq!(webhook["workspaceId"], "ws_own");
    assert!(webhook["id"].as_str().unwrap().starts_with("wh_"));
    // optional fields that have no value are omitted, not null
    assert!(webhook.get("lastDeliveryAt").is_none());
    assert!(webhook.get("lastStatus").is_none());
    assert!(webhook.get("secret").is_none());
    let id = webhook["id"].as_str().unwrap();

    assert!(!f.get(W).await.text().contains(secret));
    let one = f.get(&format!("{W}/{id}")).await;
    assert_eq!(one.status, StatusCode::OK);
    assert!(!one.text().contains("secret"));
    assert_eq!(one.body, *webhook);
    // stored encrypted and bound to the webhook
    let row = outgoing_webhooks::Entity::find_by_id(id).one(f.w.db()).await.unwrap().unwrap();
    assert_ne!(row.secret, secret);
    let secrets = Secrets::of(&f.w.state).unwrap();
    assert_eq!(secrets.decrypt(&row.secret, &format!("{id}:outgoing")).unwrap(), secret);
    f.w.drop().await;
}

#[tokio::test]
async fn lists_oldest_first() {
    let Some(f) = fx().await else { return };
    let (a, _) = f.create("/a", &["*"]).await;
    let (b, _) = f.create("/b", &["*"]).await;
    let list = f.get(W).await.body;
    let ids: Vec<&str> =
        list.as_array().unwrap().iter().map(|h| h["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [a.as_str(), b.as_str()]);
    f.w.drop().await;
}

#[tokio::test]
async fn is_admin_only_by_default_and_validates_the_url_and_events() {
    let Some(f) = fx().await else { return };
    let ok = json!({ "name": "x", "url": "https://a.example.com", "events": ["*"] });
    let as_mia = |req: Req| req.session(&f.mia);
    assert_eq!(f.w.send(as_mia(Req::get(W))).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.w.send(as_mia(Req::post(W)).json(&ok)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(f.w.send(Req::get(W)).await.status, StatusCode::UNAUTHORIZED);
    // not a member at all: the workspace does not exist for them
    let otto = session(f.w.db(), "otto").await;
    assert_eq!(f.w.send(Req::get(W).session(&otto)).await.status, StatusCode::NOT_FOUND);

    for url in [
        "ftp://a.example.com",
        "https://u:p@a.example.com",
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:3000/hook",
        "http://127.0.0.1/hook",
        "not a url",
    ] {
        let res = f.post(W, &json!({ "name": "x", "url": url, "events": ["*"] })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{url}");
    }
    let res =
        f.post(W, &json!({ "name": "x", "url": "https://a.example.com", "events": [] })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "events must contain at least 1 elements");
    let res = f
        .post(
            W,
            &json!({ "name": "x", "url": "https://a.example.com", "events": ["Issue Created"] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        r#"events must be "*", "<entity>.*" or an event type like "issue.created""#
    );
    let res = f.post(W, &json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.message().contains("name must be a string"), "{}", res.message());
    let res = f
        .post(W, &json!({ "name": "x", "url": "https://a.example.com", "events": ["issue.created", "project.*", "*"] }))
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    f.w.drop().await;
}

#[tokio::test]
async fn delivers_matching_events_with_a_verifiable_signature_and_skips_the_others() {
    let Some(f) = fx().await else { return };
    let (id, secret) = f.create("/ok", &["issue.*"]).await;
    f.w.record("own", "issue.created", SubjectType::Issue, "in_1").await;
    f.w.record("own", "project.created", SubjectType::Project, "pr_1").await; // not subscribed
    f.w.idle().await;

    let calls = f.w.to("/ok");
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call.method, axum::http::Method::POST);
    assert!(call.timeout.unwrap() <= std::time::Duration::from_secs(5));
    assert_eq!(call.url, "https://hooks.example.com/ok");
    let payload = body(call);
    assert_eq!(payload["event"], "issue.created");
    assert_eq!(payload["subject"], json!({ "type": "issue", "id": "in_1" }));
    assert_eq!(payload["actor"], json!({ "type": "user", "id": "olivia" }));
    assert_eq!(payload["workspaceId"], "ws_own");
    assert_eq!(payload["data"], json!({ "title": "Login fails" }));
    let at = payload["at"].as_str().unwrap();
    assert!(at.ends_with('Z') && at.len() == 24, "{at}");
    let delivery_id = payload["id"].as_str().unwrap();
    assert!(delivery_id.starts_with("ev_"));
    assert_eq!(header(call, "X-Trama-Event"), "issue.created");
    assert_eq!(header(call, "X-Trama-Delivery"), delivery_id);
    assert_eq!(header(call, "User-Agent"), "Trama-Webhooks/1");
    // the pre-rename headers are still sent for existing receivers
    assert_eq!(header(call, "X-Nabla-Event"), "issue.created");
    assert_eq!(header(call, "X-Nabla-Delivery"), delivery_id);
    assert_eq!(header(call, "X-Nabla-Signature"), header(call, "X-Trama-Signature"));
    let signature = header(call, "X-Trama-Signature");
    let raw = call.raw_body.as_deref().unwrap();
    assert!(verify_signature(&secret, raw, Some(&signature)));
    assert!(!verify_signature("whsec_wrong", raw, Some(&signature)));

    let log = f.log(&id).await;
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["event"], "issue.created");
    assert_eq!(
        (log[0]["status"].as_i64(), log[0]["ok"].as_bool(), log[0]["attempt"].as_i64()),
        (Some(200), Some(true), Some(1))
    );
    assert!(log[0]["durationMs"].is_number());
    assert_eq!(log[0]["webhookId"], id.as_str());
    assert!(log[0].get("error").is_none());
    let hook = f.get(&format!("{W}/{id}")).await.body;
    assert_eq!(hook["lastStatus"], 200);
    assert!(hook["lastDeliveryAt"].as_str().is_some());
    f.w.drop().await;
}

#[tokio::test]
async fn only_the_events_of_the_webhooks_workspace_are_delivered() {
    let Some(f) = fx().await else { return };
    f.create("/ok", &["*"]).await;
    f.w.record("other", "issue.created", SubjectType::Issue, "in_9").await;
    f.w.idle().await;
    assert!(f.w.to("/ok").is_empty());
    f.w.drop().await;
}

#[tokio::test]
async fn star_receives_everything_disabled_receives_nothing_and_reenabling_resumes() {
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["*"]).await;
    f.w.record("own", "project.created", SubjectType::Project, "pr_1").await;
    f.w.idle().await;
    assert_eq!(f.delivered("/ok"), ["project.created"]);

    assert_eq!(
        f.patch(&format!("{W}/{id}"), &json!({ "enabled": false })).await.status,
        StatusCode::OK
    );
    f.w.record("own", "project.created", SubjectType::Project, "pr_2").await;
    f.w.idle().await;
    assert_eq!(f.w.to("/ok").len(), 1);

    let res = f
        .patch(&format!("{W}/{id}"), &json!({ "enabled": true, "events": ["project.deleted"] }))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    f.w.record("own", "project.deleted", SubjectType::Project, "pr_2").await;
    f.w.idle().await;
    assert_eq!(f.delivered("/ok"), ["project.created", "project.deleted"]);
    f.w.drop().await;
}

#[tokio::test]
async fn retries_once_on_5xx_network_errors_and_timeouts_never_on_4xx_and_records_every_attempt() {
    let Some(f) = fx().await else { return };
    let (fail, _) = f.create("/fail", &["issue.*"]).await;
    let (flaky, _) = f.create("/flaky", &["issue.*"]).await;
    let (down, _) = f.create("/down", &["issue.*"]).await;
    let (slow, _) = f.create("/slow", &["issue.*"]).await;
    let (gone, _) = f.create("/gone", &["issue.*"]).await;
    f.w.record("own", "issue.created", SubjectType::Issue, "in_1").await;
    f.w.idle().await;

    assert_eq!(f.w.to("/fail").len(), 2); // exactly one retry, no storm
    assert_eq!(f.w.to("/flaky").len(), 2);
    assert_eq!(f.w.to("/down").len(), 2);
    assert_eq!(f.w.to("/slow").len(), 2);
    assert_eq!(f.w.to("/gone").len(), 1);
    // the retry sends the same delivery id
    let calls = f.w.to("/fail");
    assert_eq!(header(&calls[0], "X-Trama-Delivery"), header(&calls[1], "X-Trama-Delivery"));

    let shape = |log: &[Value]| -> Vec<(i64, i64, bool)> {
        log.iter()
            .map(|l| {
                (
                    l["attempt"].as_i64().unwrap(),
                    l["status"].as_i64().unwrap(),
                    l["ok"].as_bool().unwrap(),
                )
            })
            .collect()
    };
    let fail_log = f.log(&fail).await;
    assert_eq!(shape(&fail_log), [(2, 500, false), (1, 500, false)]);
    assert_eq!(fail_log[0]["error"], "HTTP 500");
    assert_eq!(shape(&f.log(&flaky).await), [(2, 200, true), (1, 503, false)]);
    let down_log = f.log(&down).await;
    assert_eq!(
        (down_log[0]["status"].as_i64(), down_log[0]["ok"].as_bool()),
        (Some(0), Some(false))
    );
    assert!(down_log[0]["error"].as_str().unwrap().contains("ECONNREFUSED"));
    assert_eq!(f.log(&slow).await[0]["error"], "Timed out after 5s");
    assert_eq!(shape(&f.log(&gone).await), [(1, 410, false)]);
    assert_eq!(f.get(&format!("{W}/{fail}")).await.body["lastStatus"], 500);
    assert_eq!(f.get(&format!("{W}/{down}")).await.body["lastStatus"], 0);
    f.w.drop().await;
}

#[tokio::test]
async fn delivers_the_events_of_one_webhook_in_order() {
    let Some(f) = fx().await else { return };
    f.create("/ok", &["*"]).await;
    for i in 0..5 {
        f.w.record("own", "issue.created", SubjectType::Issue, &format!("in_{i}")).await;
    }
    f.w.idle().await;
    let ids: Vec<String> =
        f.w.to("/ok")
            .iter()
            .map(|c| body(c)["subject"]["id"].as_str().unwrap().to_owned())
            .collect();
    assert_eq!(ids, ["in_0", "in_1", "in_2", "in_3", "in_4"]);
    f.w.drop().await;
}

#[tokio::test]
async fn test_sends_a_signed_ping_even_when_disabled_and_returns_the_delivery() {
    let Some(f) = fx().await else { return };
    let (id, secret) = f.create("/ok", &["issue.created"]).await;
    f.patch(&format!("{W}/{id}"), &json!({ "enabled": false })).await;
    let res = f.post_empty(&format!("{W}/{id}/test")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["event"], "ping");
    assert_eq!(
        (res.body["status"].as_i64(), res.body["ok"].as_bool(), res.body["attempt"].as_i64()),
        (Some(200), Some(true), Some(1))
    );
    assert!(res.body["id"].as_str().unwrap().starts_with("wd_"));
    let call = &f.w.to("/ok")[0];
    let payload = body(call);
    assert_eq!(payload["event"], "ping");
    assert_eq!(payload["actor"], json!({ "type": "system" }));
    assert_eq!(payload["subject"], json!({ "type": "webhook", "id": id }));
    assert_eq!(payload["data"]["message"], "Test delivery for webhook \"hook /ok\"");
    assert_eq!(header(call, "X-Trama-Event"), "ping");
    assert!(verify_signature(
        &secret,
        call.raw_body.as_deref().unwrap(),
        Some(&header(call, "X-Trama-Signature"))
    ));

    let (bad, _) = f.create("/fail", &["*"]).await;
    let failed = f.post_empty(&format!("{W}/{bad}/test")).await.body;
    assert_eq!((failed["status"].as_i64(), failed["ok"].as_bool()), (Some(500), Some(false)));
    assert_eq!(failed["error"], "HTTP 500");
    assert_eq!(f.w.to("/fail").len(), 1); // a test never retries
    assert_eq!(f.log(&bad).await.len(), 1);
    f.w.drop().await;
}

#[tokio::test]
async fn rotating_the_secret_invalidates_the_old_one() {
    let Some(f) = fx().await else { return };
    let (id, secret) = f.create("/ok", &["issue.*"]).await;
    // warm the dispatcher's cache with the old secret, then rotate
    f.w.record("own", "issue.created", SubjectType::Issue, "in_1").await;
    f.w.idle().await;
    let res = f.post_empty(&format!("{W}/{id}/rotate-secret")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    let rotated = res.body["secret"].as_str().unwrap().to_owned();
    assert!(rotated.starts_with("whsec_"));
    assert_ne!(rotated, secret);
    assert_eq!(res.body["webhook"]["id"], id.as_str());

    f.w.record("own", "issue.created", SubjectType::Issue, "in_2").await;
    f.w.idle().await;
    let calls = f.w.to("/ok");
    let last = calls.last().unwrap();
    let (raw, sig) = (last.raw_body.as_deref().unwrap(), header(last, "X-Trama-Signature"));
    assert!(verify_signature(&rotated, raw, Some(&sig)));
    assert!(!verify_signature(&secret, raw, Some(&sig)));
    f.w.drop().await;
}

#[tokio::test]
async fn patches_deletes_and_keeps_other_workspaces_out() {
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["issue.*"]).await;
    let uri = format!("{W}/{id}");
    let patched = f
        .patch(&uri, &json!({ "name": " Renamed ", "url": "https://hooks.example.com/other", "events": ["a.b", "a.b", "c.*"] }))
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.message());
    assert_eq!(patched.body["name"], "Renamed");
    assert_eq!(patched.body["url"], "https://hooks.example.com/other");
    assert_eq!(patched.body["events"], json!(["a.b", "c.*"]));
    assert_eq!(f.get(&uri).await.body, patched.body);

    let bad = f.patch(&uri, &json!({ "url": "javascript:alert(1)" })).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    // the URL is checked before the webhook is looked up, as in NestJS
    let missing = f.patch(&format!("{W}/wh_nope"), &json!({ "url": "ftp://x.example.com" })).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    for body in [json!({ "name": null }), json!({ "enabled": null }), json!({ "events": [] })] {
        assert_eq!(f.patch(&uri, &body).await.status, StatusCode::BAD_REQUEST, "{body}");
    }
    // an empty patch changes nothing
    assert_eq!(f.patch(&uri, &json!({})).await.body, patched.body);

    // other workspace: 404, whoever you are there
    let otto = session(f.w.db(), "otto").await;
    let theirs = format!("/api/w/other/outgoing-webhooks/{id}");
    for res in [
        f.w.send(Req::get(&theirs).session(&otto)).await,
        f.w.send(Req::post(&format!("{theirs}/test")).session(&otto)).await,
        f.w.send(Req::post(&format!("{theirs}/rotate-secret")).session(&otto)).await,
        f.w.send(Req::patch(&theirs).session(&otto).json(&json!({ "name": "x" }))).await,
        f.w.send(Req::delete(&theirs).session(&otto)).await,
        f.w.send(Req::get(&format!("{theirs}/deliveries")).session(&otto)).await,
    ] {
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(res.message(), format!("Webhook \"{id}\" not found"));
    }

    assert_eq!(f.delete(&uri).await.status, StatusCode::NO_CONTENT);
    let gone = f.get(&uri).await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    assert_eq!(gone.message(), format!("Webhook \"{id}\" not found"));
    assert_eq!(f.delete(&uri).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(W).await.body, json!([]));
    f.w.drop().await;
}

#[tokio::test]
async fn deleting_a_webhook_removes_its_deliveries() {
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["*"]).await;
    f.post_empty(&format!("{W}/{id}/test")).await;
    assert_eq!(outgoing_webhook_deliveries::Entity::find().all(f.w.db()).await.unwrap().len(), 1);
    f.delete(&format!("{W}/{id}")).await;
    assert!(outgoing_webhook_deliveries::Entity::find().all(f.w.db()).await.unwrap().is_empty());
    f.w.drop().await;
}

#[tokio::test]
async fn a_workspace_has_at_most_twenty_webhooks() {
    let Some(f) = fx().await else { return };
    for i in 0..20 {
        f.create(&format!("/h{i}"), &["*"]).await;
    }
    let res = f
        .post(
            W,
            &json!({ "name": "one more", "url": "https://hooks.example.com/x", "events": ["*"] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.message(), "A workspace can have at most 20 outgoing webhooks");
    // the limit is per workspace
    let otto = session(f.w.db(), "otto").await;
    let res =
        f.w.send(
            Req::post("/api/w/other/outgoing-webhooks").session(&otto).json(
                &json!({ "name": "x", "url": "https://hooks.example.com/x", "events": ["*"] }),
            ),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    f.w.drop().await;
}

#[tokio::test]
async fn returns_the_newest_deliveries_and_prunes_the_log() {
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["*"]).await;
    for _ in 0..25 {
        assert_eq!(f.post_empty(&format!("{W}/{id}/test")).await.status, StatusCode::OK);
    }
    assert_eq!(f.log(&id).await.len(), 20);
    assert_eq!(
        f.get(&format!("{W}/{id}/deliveries?limit=5")).await.body.as_array().unwrap().len(),
        5
    );
    assert_eq!(
        f.get(&format!("{W}/{id}/deliveries?limit=50")).await.body.as_array().unwrap().len(),
        25
    );
    let log = f.log(&id).await;
    let times: Vec<&str> = log.iter().map(|l| l["at"].as_str().unwrap()).collect();
    assert!(times.windows(2).all(|w| w[0] >= w[1]), "newest first");
    for query in ["limit=0", "limit=51", "limit=abc", "limit=1.5"] {
        let res = f.get(&format!("{W}/{id}/deliveries?{query}")).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{query}");
    }
    assert_eq!(
        f.get(&format!("{W}/{id}/deliveries?limit=99")).await.message(),
        "limit must not be greater than 50"
    );
    assert_eq!(f.get(&format!("{W}/wh_nope/deliveries")).await.status, StatusCode::NOT_FOUND);

    // only the newest 50 are kept
    for i in 0..30 {
        sql(
            f.w.db(),
            &format!(
                r#"INSERT INTO outgoing_webhook_deliveries (id, "webhookId", event, status, ok, "durationMs", attempt, at)
                   VALUES ('wd_old{i:02}', '{id}', 'old', 200, true, 1, 1, now() - interval '1 day' * ({i} + 1))"#
            ),
        )
        .await;
    }
    delivery::prune(&f.w.state, &id).await.unwrap();
    let kept = outgoing_webhook_deliveries::Entity::find().all(f.w.db()).await.unwrap();
    assert_eq!(kept.len(), usize::try_from(DELIVERY_LOG_KEEP).unwrap());
    // the 25 pings are newer than every backfilled row, which are pruned oldest first
    assert_eq!(kept.iter().filter(|d| d.event == "ping").count(), 25);
    assert!(kept.iter().any(|d| d.id == "wd_old00"));
    assert!(!kept.iter().any(|d| d.id == "wd_old29"));
    f.w.drop().await;
}

#[tokio::test]
async fn announces_changes_to_live_streams() {
    let Some(f) = fx().await else { return };
    let mut live = Events::of(&f.w.state).subscribe();
    let (id, _) = f.create("/ok", &["*"]).await;
    f.patch(&format!("{W}/{id}"), &json!({ "enabled": false })).await;
    f.post_empty(&format!("{W}/{id}/test")).await; // no live event
    f.delete(&format!("{W}/{id}")).await;
    let mut seen = Vec::new();
    while let Ok(event) = live.try_recv() {
        assert_eq!(event.workspace_id, "ws_own");
        let event = serde_json::to_value(&event.event).unwrap();
        seen.push(json!({ "type": event["type"], "entity": event["entity"], "id": event["id"] }));
    }
    let expected: Vec<Value> = ["created", "updated", "deleted"]
        .iter()
        .map(|kind| json!({ "type": kind, "entity": "webhook", "id": id }))
        .collect();
    assert_eq!(seen, expected);
    f.w.drop().await;
}

#[tokio::test]
async fn the_real_client_never_delivers_to_internal_addresses() {
    // a webhook stored with an internal URL (or whose name now resolves to one) is not reached
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["*"]).await;
    sql(
        f.w.db(),
        &format!(
            "UPDATE outgoing_webhooks SET url = 'http://169.254.169.254/latest' WHERE id = '{id}'"
        ),
    )
    .await;
    // a state without the fake receiver: `Http::of` falls back to the SSRF-safe client
    let state = trama_core::AppState::new(
        f.w.db().clone(),
        trama_core::Config::from_vars(&[("TRAMA_WEBHOOK_RETRY_MS", "10")]),
    );
    let hook =
        outgoing_webhooks::Entity::find_by_id(id.as_str()).one(f.w.db()).await.unwrap().unwrap();
    let payload = delivery::DeliveryPayload {
        id: "ev_1".into(),
        event: "ping".into(),
        workspace_id: "ws_own".into(),
        at: trama_core::time::now_iso(),
        actor: json!({ "type": "system" }),
        subject: json!({ "type": "webhook", "id": id }),
        data: json!({}),
    };
    let log = delivery::deliver(&state, &hook, &payload, false).await;
    assert_eq!((log.status, log.ok, log.attempt), (0, false, 1));
    assert!(log.error.unwrap().contains("not allowed"));
    assert!(f.w.to("/ok").is_empty());
    f.w.drop().await;
}

#[tokio::test]
async fn an_undecryptable_secret_is_a_failed_delivery_not_a_crash() {
    let Some(f) = fx().await else { return };
    let (id, _) = f.create("/ok", &["*"]).await;
    sql(f.w.db(), &format!("UPDATE outgoing_webhooks SET secret = 'v2:garbage' WHERE id = '{id}'"))
        .await;
    let res = f.post_empty(&format!("{W}/{id}/test")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!((res.body["status"].as_i64(), res.body["ok"].as_bool()), (Some(0), Some(false)));
    assert!(res.body["error"].as_str().is_some());
    assert!(f.w.to("/ok").is_empty());
    f.w.drop().await;
}
