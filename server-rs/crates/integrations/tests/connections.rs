//! The connection routes against a real database and the real access guard:
//! `server/test/connection-ownership.e2e-spec.ts` (personal and workspace connections) and the
//! cases of `connections.service.spec.ts`, `integrations-base-url.spec.ts` and `secrets.spec.ts`
//! that need a database. The pure parts (`markSuggested`, `connectionHost`, `extractKeys`, the
//! provider clients) are unit tests next to the code.

mod common;

use axum::http::StatusCode;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde_json::{Value, json};
use trama_common::Secrets;
use trama_contracts::roles::TokenScope;
use trama_entities::{external_identities, integration_connections};
use trama_events::Events;
use trama_integrations::connections::usable_for;
use trama_integrations::service::{self, ConnectionScope};

use common::{Req, Res, World, member, session, token, user, workspace};

const W: &str = "/api/w/own";
const ME: &str = "/api/me/connections";

struct Fx {
    w: World,
    olivia: String,
    mia: String,
}

/// `own`, owned by Olivia, with Mia as a plain member, and Otto outside of it.
async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    let db = w.db();
    workspace(db, "own").await;
    user(db, "olivia", "Olivia").await;
    user(db, "mia", "Mia").await;
    user(db, "otto", "Otto").await;
    member(db, "ws_own", "olivia", "owner", None).await;
    member(db, "ws_own", "mia", "member", None).await;
    let olivia = session(db, "olivia").await;
    let mia = session(db, "mia").await;
    Some(Fx { w, olivia, mia })
}

impl Fx {
    async fn post(&self, cookie: &str, uri: &str, body: &Value) -> Res {
        self.w.send(Req::post(uri).session(cookie).json(body)).await
    }
    async fn get(&self, cookie: &str, uri: &str) -> Res {
        self.w.send(Req::get(uri).session(cookie)).await
    }
    async fn patch(&self, cookie: &str, uri: &str, body: &Value) -> Res {
        self.w.send(Req::patch(uri).session(cookie).json(body)).await
    }
    async fn post_empty(&self, cookie: &str, uri: &str) -> Res {
        self.w.send(Req::post(uri).session(cookie)).await
    }
    async fn delete(&self, cookie: &str, uri: &str) -> Res {
        self.w.send(Req::delete(uri).session(cookie)).await
    }
    /// A personal GitHub connection of Mia's; returns its id.
    async fn mia_connection(&self, login: &str) -> String {
        let res = self
            .post(&self.mia, ME, &json!({ "provider": "github", "token": format!("tok_{login}") }))
            .await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body["connection"]["id"].as_str().unwrap().to_owned()
    }
    fn http_calls(&self) -> usize {
        self.w.seen.lock().unwrap().len()
    }
}

// ───────────────────────────── personal connections ─────────────────────────────

#[tokio::test]
async fn lets_a_person_add_several_personal_accounts_per_provider_with_labels() {
    let Some(f) = fx().await else { return };
    let first = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_mia" })).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.message());
    let conn = &first.body["connection"];
    for (key, value) in [
        ("ownerType", "user"),
        ("ownerUserId", "mia"),
        ("ownerName", "Mia"),
        ("label", "GitHub · mia"),
        ("provider", "github"),
        ("host", "github.com"),
        ("account", "mia"),
        ("status", "connected"),
    ] {
        assert_eq!(conn[key], value, "{key}");
    }
    assert!(conn.get("workspaceId").is_none());
    assert_eq!(conn["webhookConfigured"], true);
    assert!(conn["id"].as_str().unwrap().starts_with("ic_"));
    assert!(conn["createdAt"].as_str().unwrap().ends_with('Z'));
    // the webhook setup comes with the first answer
    let webhook = &first.body["webhook"];
    assert_eq!(
        webhook["url"],
        format!("https://trama.test/api/webhooks/github/{}", conn["id"].as_str().unwrap())
    );
    assert_eq!(conn["webhookUrl"], webhook["url"]);
    assert!(webhook["secret"].as_str().unwrap().starts_with("whsec_"));
    assert_eq!(webhook["contentType"], "application/json");
    assert_eq!(
        webhook["events"],
        json!(["pull_request", "issues", "check_suite", "check_run", "status"])
    );

    let second = f
        .post(
            &f.mia,
            ME,
            &json!({ "provider": "github", "token": "tok_mia-work", "label": "  GitHub · work " }),
        )
        .await;
    assert_eq!(second.status, StatusCode::CREATED);
    assert_eq!(second.body["connection"]["label"], "GitHub · work");
    let dup = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_mia" })).await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    assert_eq!(dup.message(), "A github connection for \"mia\" already exists");

    let list = f.get(&f.mia, ME).await;
    assert_eq!(list.status, StatusCode::OK);
    let labels: Vec<&str> =
        list.body.as_array().unwrap().iter().map(|c| c["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["GitHub · mia", "GitHub · work"]);
    f.w.drop().await;
}

#[tokio::test]
async fn never_returns_a_token_or_secret_after_creation() {
    let Some(f) = fx().await else { return };
    let created =
        f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_secretive" })).await;
    let id = created.body["connection"]["id"].as_str().unwrap().to_owned();
    // the webhook signing secret is shown once, on creation, and nowhere else
    let webhook_secret = created.body["webhook"]["secret"].as_str().unwrap().to_owned();
    assert!(!created.body["connection"].to_string().contains("tok_secretive"));
    let bodies = [f.get(&f.mia, ME).await, f.get(&f.mia, &format!("{ME}/{id}")).await];
    for res in bodies {
        assert_eq!(res.status, StatusCode::OK);
        let text = res.text();
        assert!(!text.contains("tok_secretive"));
        assert!(!text.contains(&webhook_secret));
        for key in ["\"token\"", "\"secret\"", "\"webhookSecret\"", "\"config\""] {
            assert!(!text.contains(key), "{key} in {text}");
        }
    }
    let renamed = f.patch(&f.mia, &format!("{ME}/{id}"), &json!({ "label": "Renamed" })).await;
    assert_eq!(renamed.status, StatusCode::OK);
    assert!(!renamed.text().contains("tok_secretive"));
    f.w.drop().await;
}

#[tokio::test]
async fn stores_secrets_encrypted_in_the_format_nestjs_reads() {
    let Some(f) = fx().await else { return };
    let created = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_mia" })).await;
    let id = created.body["connection"]["id"].as_str().unwrap().to_owned();
    let secret = created.body["webhook"]["secret"].as_str().unwrap().to_owned();
    let row =
        integration_connections::Entity::find_by_id(&id).one(f.w.db()).await.unwrap().unwrap();
    let stored = row.secret.clone().unwrap();
    assert!(stored.starts_with("v2:") && !stored.contains("tok_mia"));
    let secrets = Secrets::of(&f.w.state).unwrap();
    assert_eq!(secrets.decrypt(&stored, &format!("{id}:secret")).unwrap(), "tok_mia");
    assert!(secrets.decrypt(&stored, "ic_other:secret").is_err(), "bound to its connection");
    assert_eq!(
        secrets.decrypt(row.webhook_secret.as_deref().unwrap(), &format!("{id}:webhook")).unwrap(),
        secret
    );
    assert_eq!(service::connection_token(&f.w.state, &row).unwrap(), "tok_mia");
    assert_eq!(
        service::connection_webhook_secret(&f.w.state, &row).unwrap().as_deref(),
        Some(secret.as_str())
    );
    // the owner row carries no workspace and the Wire form hides secrets
    assert_eq!(
        (row.owner_type.as_str(), row.workspace_id, row.owner_user_id.as_deref()),
        ("user", None, Some("mia"))
    );
    assert_eq!(row.config, json!({}));
    f.w.drop().await;
}

#[tokio::test]
async fn keeps_a_personal_connection_invisible_and_untouchable_for_everyone_else_admins_included() {
    let Some(f) = fx().await else { return };
    let id = f.mia_connection("mia").await;

    assert_eq!(f.get(&f.olivia, ME).await.body, json!([]));
    let not_found = format!("Integration \"{id}\" not found");
    for res in [
        f.get(&f.olivia, &format!("{ME}/{id}")).await,
        f.patch(&f.olivia, &format!("{ME}/{id}"), &json!({ "label": "mine now" })).await,
        f.post_empty(&f.olivia, &format!("{ME}/{id}/revoke")).await,
        f.post_empty(&f.olivia, &format!("{ME}/{id}/rotate-webhook-secret")).await,
        f.delete(&f.olivia, &format!("{ME}/{id}")).await,
        f.get(&f.olivia, &format!("{ME}/{id}/remote-repositories")).await,
    ] {
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(res.message(), not_found);
    }

    // the workspace's own list does not carry it either
    assert_eq!(f.get(&f.olivia, &format!("{W}/integrations")).await.body, json!([]));
    for res in [
        f.get(&f.olivia, &format!("{W}/integrations/{id}")).await,
        f.patch(&f.olivia, &format!("{W}/integrations/{id}"), &json!({ "label": "x" })).await,
        f.post_empty(&f.olivia, &format!("{W}/integrations/{id}/revoke")).await,
        f.delete(&f.olivia, &format!("{W}/integrations/{id}")).await,
    ] {
        assert_eq!(res.status, StatusCode::NOT_FOUND);
    }
    // the snapshot reads workspace rows only
    let rows = integration_connections::Entity::find().all(f.w.db()).await.unwrap();
    assert_eq!(rows.iter().filter(|r| r.workspace_id.as_deref() == Some("ws_own")).count(), 0);

    // still intact for its owner
    let own = f.get(&f.mia, &format!("{ME}/{id}")).await;
    assert_eq!(own.status, StatusCode::OK);
    assert_eq!(
        (own.body["status"].as_str(), own.body["label"].as_str()),
        (Some("connected"), Some("GitHub · mia"))
    );
    f.w.drop().await;
}

#[tokio::test]
async fn rejects_anonymous_callers_and_validates_input() {
    let Some(f) = fx().await else { return };
    assert_eq!(f.w.send(Req::get(ME)).await.status, StatusCode::UNAUTHORIZED);
    for body in [
        json!({ "provider": "svn", "token": "tok_x" }),
        json!({ "provider": "github" }),
        json!({ "provider": "github", "token": "tok_x", "label": "" }),
        json!({ "provider": "github", "token": "tok_x", "label": "x".repeat(81) }),
        json!({ "provider": "github", "token": "" }),
        json!({ "provider": "github", "token": "x".repeat(501) }),
        json!({ "provider": "github", "token": "tok_x", "baseUrl": "x".repeat(501) }),
    ] {
        let res = f.post(&f.mia, ME, &body).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(
        f.post(&f.mia, ME, &json!({ "provider": "svn", "token": "t" })).await.message(),
        "provider must be one of the following values: github, gitlab, bitbucket, delta"
    );
    // a credential the provider refuses is a 400, with what it said
    let bad = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "bad" })).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.message(), "GitHub rejected the request (401: Bad credentials)");
    // a failing provider and an unreachable one are 502s
    let boom = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "boom" })).await;
    assert_eq!(
        (boom.status, boom.message().as_str()),
        (StatusCode::BAD_GATEWAY, "GitHub failed: 500: Server Error")
    );
    let offline = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "offline" })).await;
    assert_eq!(
        (offline.status, offline.message().as_str()),
        (StatusCode::BAD_GATEWAY, "GitHub is unreachable: connect ECONNREFUSED")
    );
    assert_eq!(f.get(&f.mia, ME).await.body, json!([]));
    f.w.drop().await;
}

#[tokio::test]
async fn renames_revokes_reconnects_and_deletes() {
    let Some(f) = fx().await else { return };
    let id = f.mia_connection("mia").await;
    let uri = format!("{ME}/{id}");

    let renamed = f.patch(&f.mia, &uri, &json!({ "label": "GitHub · personal" })).await;
    assert_eq!(renamed.body["label"], "GitHub · personal");
    assert_eq!(
        f.patch(&f.mia, &uri, &json!({ "label": "" })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.patch(&f.mia, &uri, &json!({ "label": null })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.patch(&f.mia, &uri, &json!({ "token": null })).await.status,
        StatusCode::BAD_REQUEST
    );

    let revoked = f.post_empty(&f.mia, &format!("{uri}/revoke")).await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(revoked.body["id"], id.as_str());
    assert_eq!(revoked.body["status"], "revoked");
    assert_eq!(revoked.body["lastError"], "Revoked");
    assert_eq!(revoked.body["label"], "GitHub · personal");
    assert_eq!(f.get(&f.mia, ME).await.body[0]["status"], "revoked");
    // the token is wiped, the row stays
    let row =
        integration_connections::Entity::find_by_id(&id).one(f.w.db()).await.unwrap().unwrap();
    assert_eq!(row.secret, None);
    // a revoked connection reads nothing
    let repos = f.get(&f.mia, &format!("{uri}/remote-repositories")).await;
    assert_eq!(repos.status, StatusCode::BAD_REQUEST);
    assert_eq!(repos.message(), "This connection was revoked. Reconnect it with a new token.");
    // a rename still works (and does not re-check the provider), and a fresh token brings it back
    let calls = f.http_calls();
    assert_eq!(
        f.patch(&f.mia, &uri, &json!({ "label": "GitHub · old" })).await.status,
        StatusCode::OK
    );
    assert_eq!(f.http_calls(), calls);
    assert_eq!(f.get(&f.mia, &uri).await.body["status"], "revoked");
    let back = f.patch(&f.mia, &uri, &json!({ "token": "tok_mia" })).await;
    assert_eq!(back.status, StatusCode::OK, "{}", back.message());
    assert_eq!(
        (back.body["status"].as_str(), back.body["account"].as_str()),
        (Some("connected"), Some("mia"))
    );
    assert!(back.body.get("lastError").is_none());
    let row =
        integration_connections::Entity::find_by_id(&id).one(f.w.db()).await.unwrap().unwrap();
    assert!(row.secret.unwrap().starts_with("v2:"));

    assert_eq!(f.delete(&f.mia, &uri).await.status, StatusCode::NO_CONTENT);
    assert_eq!(f.get(&f.mia, &uri).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn a_token_the_provider_refuses_on_update_changes_nothing() {
    let Some(f) = fx().await else { return };
    let id = f.mia_connection("mia").await;
    let uri = format!("{ME}/{id}");
    let res = f.patch(&f.mia, &uri, &json!({ "token": "nope" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "GitHub rejected the request (401: Bad credentials)");
    let row =
        integration_connections::Entity::find_by_id(&id).one(f.w.db()).await.unwrap().unwrap();
    assert_eq!(service::connection_token(&f.w.state, &row).unwrap(), "tok_mia");
    // a new token for another account changes the account shown
    let moved = f.patch(&f.mia, &uri, &json!({ "token": "tok_mia2" })).await;
    assert_eq!(moved.body["account"], "mia2");
    f.w.drop().await;
}

#[tokio::test]
async fn a_personal_github_connection_records_its_login_as_an_identity() {
    let Some(f) = fx().await else { return };
    f.mia_connection("Mia-GH").await;
    let rows = external_identities::Entity::find().all(f.w.db()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0].user_id.as_str(),
            rows[0].provider.as_str(),
            rows[0].host.as_str(),
            rows[0].login.as_str(),
            rows[0].source.as_str()
        ),
        ("mia", "github", "github.com", "Mia-GH", "connection")
    );
    // a workspace connection proves nobody's login
    let res = f
        .post(
            &f.olivia,
            &format!("{W}/integrations"),
            &json!({ "provider": "github", "token": "tok_acme" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(external_identities::Entity::find().all(f.w.db()).await.unwrap().len(), 1);
    f.w.drop().await;
}

// ───────────────────────────── workspace connections ─────────────────────────────

#[tokio::test]
async fn keeps_workspace_connections_under_the_integrations_permission_separate_from_personal_ones()
{
    let Some(f) = fx().await else { return };
    let base = format!("{W}/integrations");
    assert_eq!(f.get(&f.mia, &base).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        f.post(&f.mia, &base, &json!({ "provider": "github", "token": "tok_acme" })).await.status,
        StatusCode::FORBIDDEN
    );

    let created = f
        .post(
            &f.olivia,
            &base,
            &json!({ "provider": "github", "token": "tok_acme", "label": "GitHub · Acme" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.message());
    let acme = created.body["connection"].clone();
    assert_eq!(acme["ownerType"], "workspace");
    assert_eq!(acme["label"], "GitHub · Acme");
    assert_eq!(acme["host"], "github.com");
    assert_eq!(acme["status"], "connected");
    assert_eq!(acme["workspaceId"], "ws_own");
    assert!(acme.get("ownerUserId").is_none());
    assert!(acme.get("ownerName").is_none());
    let id = acme["id"].as_str().unwrap().to_owned();
    assert_eq!(
        f.post(&f.olivia, &base, &json!({ "provider": "github", "token": "tok_acme-labs" }))
            .await
            .status,
        StatusCode::CREATED
    );
    assert_eq!(
        f.post(&f.olivia, &base, &json!({ "provider": "github", "token": "tok_acme" }))
            .await
            .status,
        StatusCode::CONFLICT
    );

    // the same GitHub account may be connected by a person and by the workspace
    assert_eq!(
        f.post(&f.olivia, ME, &json!({ "provider": "github", "token": "tok_acme" })).await.status,
        StatusCode::CREATED
    );
    assert_eq!(f.get(&f.olivia, &base).await.body.as_array().unwrap().len(), 2);
    assert_eq!(f.get(&f.olivia, ME).await.body.as_array().unwrap().len(), 1);

    // workspace connections revoke too
    assert_eq!(
        f.post_empty(&f.mia, &format!("{base}/{id}/revoke")).await.status,
        StatusCode::FORBIDDEN
    );
    let revoked = f.post_empty(&f.olivia, &format!("{base}/{id}/revoke")).await;
    assert_eq!(revoked.body["status"], "revoked");
    assert_eq!(f.get(&f.olivia, &format!("{base}/{id}")).await.body["status"], "revoked");
    assert_eq!(f.delete(&f.olivia, &format!("{base}/{id}")).await.status, StatusCode::NO_CONTENT);
    assert_eq!(f.delete(&f.olivia, &format!("{base}/{id}")).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn publishes_a_live_event_for_workspace_connections_only() {
    let Some(f) = fx().await else { return };
    let mut live = Events::of(&f.w.state).subscribe();
    let base = format!("{W}/integrations");
    let id =
        f.post(&f.olivia, &base, &json!({ "provider": "github", "token": "tok_acme" })).await.body
            ["connection"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    f.patch(&f.olivia, &format!("{base}/{id}"), &json!({ "label": "L" })).await;
    f.post_empty(&f.olivia, &format!("{base}/{id}/revoke")).await;
    f.post_empty(&f.olivia, &format!("{base}/{id}/rotate-webhook-secret")).await;
    f.delete(&f.olivia, &format!("{base}/{id}")).await;
    // personal connections have no workspace stream
    let mine = f.mia_connection("mia").await;
    f.delete(&f.mia, &format!("{ME}/{mine}")).await;

    let mut seen = Vec::new();
    while let Ok(event) = live.try_recv() {
        assert_eq!(event.workspace_id, "ws_own");
        assert_eq!(event.event.entity.as_str(), "integration");
        assert_eq!(event.event.id, id);
        seen.push(event.event.kind.as_str().to_owned());
    }
    assert_eq!(seen, ["created", "updated", "updated", "updated", "deleted"]);
    f.w.drop().await;
}

#[tokio::test]
async fn rotates_the_webhook_secret() {
    let Some(f) = fx().await else { return };
    let created = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_mia" })).await;
    let id = created.body["connection"]["id"].as_str().unwrap().to_owned();
    let first = created.body["webhook"]["secret"].as_str().unwrap().to_owned();
    let rotated = f.post_empty(&f.mia, &format!("{ME}/{id}/rotate-webhook-secret")).await;
    assert_eq!(rotated.status, StatusCode::OK);
    let second = rotated.body["webhook"]["secret"].as_str().unwrap();
    assert!(second.starts_with("whsec_") && second != first);
    assert_eq!(rotated.body["connection"]["id"], id.as_str());
    assert_eq!(rotated.body["webhook"]["url"], rotated.body["connection"]["webhookUrl"]);
    let row =
        integration_connections::Entity::find_by_id(&id).one(f.w.db()).await.unwrap().unwrap();
    assert_eq!(
        service::connection_webhook_secret(&f.w.state, &row).unwrap().as_deref(),
        Some(second)
    );

    // Delta has no webhook
    let delta = f
        .post(
            &f.mia,
            ME,
            &json!({ "provider": "delta", "token": "t", "baseUrl": "https://delta.example.net" }),
        )
        .await;
    assert_eq!(delta.status, StatusCode::CREATED, "{}", delta.message());
    let did = delta.body["connection"]["id"].as_str().unwrap();
    let res = f.post_empty(&f.mia, &format!("{ME}/{did}/rotate-webhook-secret")).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Delta connections have no webhook")
    );
    f.w.drop().await;
}

#[tokio::test]
async fn connects_delta_with_its_base_url() {
    let Some(f) = fx().await else { return };
    let created = f
        .post(&f.mia, ME, &json!({ "provider": "delta", "token": "t", "baseUrl": "https://Delta.Example.net:8443/api/" }))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.message());
    let conn = &created.body["connection"];
    assert_eq!(conn["baseUrl"], "https://delta.example.net:8443/api");
    assert_eq!(conn["host"], "delta.example.net:8443");
    assert_eq!(conn["account"], "delta.example.net:8443");
    assert_eq!(conn["label"], "Delta · delta.example.net:8443");
    assert_eq!(conn["webhookConfigured"], false);
    assert!(conn.get("webhookUrl").is_none());
    assert!(created.body.get("webhook").is_none());
    // no network call, and no identity: Delta proves no git login
    assert_eq!(f.http_calls(), 0);
    assert!(external_identities::Entity::find().all(f.w.db()).await.unwrap().is_empty());
    let id = conn["id"].as_str().unwrap();
    let repos = f.get(&f.mia, &format!("{ME}/{id}/remote-repositories")).await;
    assert_eq!(repos.status, StatusCode::BAD_REQUEST);
    assert_eq!(repos.message(), "Delta connections have no repository API yet");
    f.w.drop().await;
}

// ───────────────────────────── base URLs ─────────────────────────────

/// A workspace connection to a GitHub Enterprise host, inserted with a token NestJS would have
/// stored.
async fn enterprise(f: &Fx) -> String {
    let secrets = Secrets::of(&f.w.state).unwrap();
    integration_connections::ActiveModel {
        id: Set("ic_1".to_owned()),
        owner_type: Set("workspace".to_owned()),
        workspace_id: Set(Some("ws_own".to_owned())),
        label: Set("GitHub · octo".to_owned()),
        provider: Set("github".to_owned()),
        account: Set("octo".to_owned()),
        host: Set("ghe.example.com".to_owned()),
        base_url: Set(Some("https://ghe.example.com".to_owned())),
        secret: Set(Some(secrets.encrypt("tok_octo", "ic_1:secret"))),
        status: Set("connected".to_owned()),
        config: Set(json!({})),
        ..Default::default()
    }
    .insert(f.w.db())
    .await
    .unwrap();
    format!("{W}/integrations/ic_1")
}

#[tokio::test]
async fn does_not_send_the_stored_token_to_a_new_host_unless_the_token_is_supplied_again() {
    let Some(f) = fx().await else { return };
    let uri = enterprise(&f).await;
    let res = f.patch(&f.olivia, &uri, &json!({ "baseUrl": "https://attacker.example.net" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Enter the access token again when you change the base URL");
    assert_eq!(f.http_calls(), 0);
    let row =
        integration_connections::Entity::find_by_id("ic_1").one(f.w.db()).await.unwrap().unwrap();
    assert_eq!(row.base_url.as_deref(), Some("https://ghe.example.com"));
    f.w.drop().await;
}

#[tokio::test]
async fn accepts_a_new_host_with_a_fresh_token_and_an_unchanged_host_without_one() {
    let Some(f) = fx().await else { return };
    let uri = enterprise(&f).await;
    let res = f
        .patch(
            &f.olivia,
            &uri,
            &json!({ "baseUrl": "https://ghe.example.org", "token": "tok_octo" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(
        (res.body["baseUrl"].as_str(), res.body["host"].as_str()),
        (Some("https://ghe.example.org"), Some("ghe.example.org"))
    );
    // the new host was asked, with the new token
    let seen = f.w.seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(seen.url, "https://ghe.example.org/api/v3/user");
    drop(seen);
    let again = f.patch(&f.olivia, &uri, &json!({ "baseUrl": "https://ghe.example.org/" })).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.message());
    assert_eq!(again.body["baseUrl"], "https://ghe.example.org");
    // `null` goes back to the public host, which also needs the token again
    let calls = f.http_calls();
    assert_eq!(
        f.patch(&f.olivia, &uri, &json!({ "baseUrl": null })).await.status,
        StatusCode::BAD_REQUEST
    );
    let public = f.patch(&f.olivia, &uri, &json!({ "baseUrl": null, "token": "tok_octo" })).await;
    assert_eq!(public.status, StatusCode::OK, "{}", public.message());
    assert!(public.body.get("baseUrl").is_none());
    assert_eq!(public.body["host"], "github.com");
    assert_eq!(f.http_calls(), calls + 1);
    f.w.drop().await;
}

#[tokio::test]
async fn refuses_base_urls_that_point_at_internal_addresses_before_contacting_them() {
    let Some(f) = fx().await else { return };
    let uri = enterprise(&f).await;
    for base_url in [
        "http://169.254.169.254",
        "http://127.0.0.1:8080",
        "http://localhost",
        "https://10.0.0.5/gitlab",
        "http://[::1]",
    ] {
        let res = f.patch(&f.olivia, &uri, &json!({ "baseUrl": base_url, "token": "fresh" })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{base_url}");
        let message = res.message();
        assert!(
            message.starts_with("Invalid baseUrl: ") && message.contains("not allowed"),
            "{message}"
        );
        let res = f
            .post(&f.mia, ME, &json!({ "provider": "gitlab", "token": "t", "baseUrl": base_url }))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{base_url}");
    }
    assert_eq!(f.http_calls(), 0);
    f.w.drop().await;
}

#[tokio::test]
async fn validates_the_shape_of_a_base_url() {
    let Some(f) = fx().await else { return };
    let message = |provider: &str, base_url: &str| {
        let (f, provider, base_url) = (&f, provider.to_owned(), base_url.to_owned());
        async move {
            let res = f
                .post(
                    &f.mia,
                    ME,
                    &json!({ "provider": provider, "token": "t", "baseUrl": base_url }),
                )
                .await;
            assert_eq!(res.status, StatusCode::BAD_REQUEST);
            res.message()
        }
    };
    assert_eq!(message("github", "not a url").await, "Invalid baseUrl: Invalid URL");
    assert_eq!(
        message("github", "ftp://ghe.example.com").await,
        "Invalid baseUrl: baseUrl must be http(s)"
    );
    assert_eq!(
        message("github", "https://u:p@ghe.example.com").await,
        "Invalid baseUrl: baseUrl must not contain credentials"
    );
    assert_eq!(
        message("bitbucket", "https://bb.example.com").await,
        "Invalid baseUrl: Bitbucket has no custom base URL"
    );
    let res = f.post(&f.mia, ME, &json!({ "provider": "delta", "token": "t" })).await;
    assert_eq!(
        (res.status, res.message().as_str()),
        (StatusCode::BAD_REQUEST, "Invalid baseUrl: baseUrl is required for Delta")
    );
    // a blank base URL on GitHub is the public host
    let blank = f
        .post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_blank", "baseUrl": "  " }))
        .await;
    assert_eq!(blank.status, StatusCode::CREATED);
    assert!(blank.body["connection"].get("baseUrl").is_none());
    // the public host written out is not stored either
    let explicit = f.post(&f.mia, ME, &json!({ "provider": "github", "token": "tok_explicit", "baseUrl": "https://github.com/" })).await;
    assert_eq!(explicit.status, StatusCode::CREATED, "{}", explicit.message());
    assert!(explicit.body["connection"].get("baseUrl").is_none());
    f.w.drop().await;
}

// ───────────────────────────── repositories ─────────────────────────────

#[tokio::test]
async fn lists_the_repositories_a_connection_can_see() {
    let Some(f) = fx().await else { return };
    let id = f.mia_connection("mia").await;
    let uri = format!("{ME}/{id}/remote-repositories");
    let res = f.get(&f.mia, &uri).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["page"], 1);
    assert_eq!(res.body["perPage"], 30);
    assert_eq!(res.body["hasMore"], true);
    assert_eq!(res.body["items"][0]["fullName"], "mia/app");
    assert_eq!(res.body["items"][1]["defaultBranch"], "main");
    let seen = f.w.seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(seen.url, "https://api.github.com/user/repos?per_page=30&page=1&sort=pushed");
    drop(seen);
    let paged = f.get(&f.mia, &format!("{uri}?page=2&perPage=5")).await;
    assert_eq!((paged.body["page"].as_i64(), paged.body["perPage"].as_i64()), (Some(2), Some(5)));
    for (query, message) in [
        ("page=0", "page must not be less than 1"),
        ("page=x", "page must not be less than 1; page must be an integer number"),
        ("perPage=101", "perPage must not be greater than 100"),
        ("perPage=0", "perPage must not be less than 1"),
    ] {
        let res = f.get(&f.mia, &format!("{uri}?{query}")).await;
        assert_eq!(
            (res.status, res.message()),
            (StatusCode::BAD_REQUEST, message.to_owned()),
            "{query}"
        );
    }
    f.w.drop().await;
}

// ───────────────────────────── who may use which connection ─────────────────────────────

#[tokio::test]
async fn usable_for_gives_own_personal_connections_plus_the_workspace_ones_with_permission() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let base = format!("{W}/integrations");
    f.post(
        &f.olivia,
        &base,
        &json!({ "provider": "github", "token": "tok_acme", "label": "GitHub · Acme" }),
    )
    .await;
    f.post(&f.olivia, ME, &json!({ "provider": "github", "token": "tok_olivia" })).await;
    f.mia_connection("mia").await;
    let old = f.mia_connection("mia-old").await;
    assert_eq!(f.post_empty(&f.mia, &format!("{ME}/{old}/revoke")).await.status, StatusCode::OK);
    // one connection in error stays, with its status
    let failing = f.mia_connection("mia-failing").await;
    sql_status(&f, &failing, "error").await;

    let for_member = usable_for(db, "mia", "ws_own").await.unwrap();
    let accounts: Vec<(&str, bool)> =
        for_member.iter().map(|c| (c.connection.account.as_str(), c.suggested)).collect();
    // two personal accounts on one host: nothing is preselected among healthy ones but the only
    // healthy one
    assert_eq!(accounts, [("mia", true), ("mia-failing", false)]);
    assert_eq!(for_member[0].connection.owner_name.as_deref(), Some("Mia"));

    let for_owner = usable_for(db, "olivia", "ws_own").await.unwrap();
    let labels: Vec<(&str, bool)> =
        for_owner.iter().map(|c| (c.connection.label.as_str(), c.suggested)).collect();
    assert_eq!(labels, [("GitHub · Acme", true), ("GitHub · olivia", false)]);
    let json = serde_json::to_string(&[&for_member, &for_owner]).unwrap();
    assert!(
        !json.contains("tok_")
            && !json.contains("\"secret\"")
            && !json.contains("\"webhookSecret\"")
    );

    // someone outside the workspace gets nothing, not even their own connections
    let otto = session(db, "otto").await;
    assert_eq!(
        f.post(&otto, ME, &json!({ "provider": "github", "token": "tok_otto" })).await.status,
        StatusCode::CREATED
    );
    assert!(usable_for(db, "otto", "ws_own").await.unwrap().is_empty());
    assert!(usable_for(db, "nobody", "ws_own").await.unwrap().is_empty());
    f.w.drop().await;
}

async fn sql_status(f: &Fx, id: &str, status: &str) {
    common::sql(
        f.w.db(),
        &format!("UPDATE integration_connections SET status = '{status}' WHERE id = '{id}'"),
    )
    .await;
}

#[tokio::test]
async fn usable_for_follows_the_roles_of_the_workspace() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    f.post(
        &f.olivia,
        &format!("{W}/integrations"),
        &json!({ "provider": "github", "token": "tok_acme" }),
    )
    .await;
    // an admin has the permission, a viewer does not
    user(db, "ada", "Ada").await;
    member(db, "ws_own", "ada", "admin", None).await;
    user(db, "vic", "Vic").await;
    member(db, "ws_own", "vic", "viewer", None).await;
    assert_eq!(usable_for(db, "ada", "ws_own").await.unwrap().len(), 1);
    assert!(usable_for(db, "vic", "ws_own").await.unwrap().is_empty());
    f.w.drop().await;
}

// ───────────────────────────── tokens ─────────────────────────────

#[tokio::test]
async fn personal_connections_are_for_browser_sessions_and_workspace_ones_for_admin_tokens() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    // an API token belongs to one workspace, a personal connection to a person
    let admin = token(db, "ws_own", "olivia", TokenScope::Admin, None).await;
    assert_eq!(f.w.send(Req::get(ME).bearer(&admin)).await.status, StatusCode::FORBIDDEN);
    // admin tokens reach the workspace's connections, write tokens do not
    assert_eq!(
        f.w.send(Req::get(&format!("{W}/integrations")).bearer(&admin)).await.status,
        StatusCode::OK
    );
    let write = token(db, "ws_own", "olivia", TokenScope::Write, None).await;
    assert_eq!(
        f.w.send(Req::get(&format!("{W}/integrations")).bearer(&write)).await.status,
        StatusCode::FORBIDDEN
    );
    // a custom token needs `integrations:*`
    let reader =
        token(db, "ws_own", "olivia", TokenScope::Custom, Some(&["integrations:read"])).await;
    assert_eq!(
        f.w.send(Req::get(&format!("{W}/integrations")).bearer(&reader)).await.status,
        StatusCode::OK
    );
    let res =
        f.w.send(
            Req::post(&format!("{W}/integrations"))
                .bearer(&reader)
                .json(&json!({ "provider": "github", "token": "tok_x" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    f.w.drop().await;
}

#[tokio::test]
async fn lists_connection_summaries_for_the_snapshot() {
    let Some(f) = fx().await else { return };
    f.post(
        &f.olivia,
        &format!("{W}/integrations"),
        &json!({ "provider": "github", "token": "tok_acme" }),
    )
    .await;
    f.mia_connection("mia").await;
    let rows = integration_connections::Entity::find().all(f.w.db()).await.unwrap();
    let views = service::summarize(f.w.db(), &rows).await.unwrap();
    assert_eq!(views.len(), 2);
    let personal = views.iter().find(|v| v.owner_user_id.is_some()).unwrap();
    assert_eq!(personal.owner_name.as_deref(), Some("Mia"));
    let list = service::list(&f.w.state, &ConnectionScope::workspace("ws_own"), "https://x.test")
        .await
        .unwrap();
    assert_eq!(list.len(), 1);
    assert!(
        list[0]
            .webhook_url
            .as_deref()
            .unwrap()
            .starts_with("https://x.test/api/webhooks/github/ic_")
    );
    f.w.drop().await;
}
