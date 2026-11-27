//! Inbound webhook HTTP contract tests against a throwaway PostgreSQL database.
#![allow(clippy::large_futures, clippy::too_many_lines)]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use ring::hmac;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_common::Secrets;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{integration_connections, users, webhook_deliveries, workspaces};
use trama_migration::Migrator;

const SIGNING_SECRET: &str = "webhook-test-secret";

async fn connection(
    db: &sea_orm::DatabaseConnection,
    secrets: &Secrets,
    id: &str,
    provider: &str,
    workspace: &str,
) {
    integration_connections::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(Some(workspace.to_owned())),
        provider: Set(provider.to_owned()),
        account: Set("test-account".to_owned()),
        base_url: Set(None),
        secret: Set(None),
        webhook_secret: Set(Some(
            secrets.encrypt(SIGNING_SECRET, &trama_integrations::service::webhook_aad(id)),
        )),
        status: Set("connected".to_owned()),
        last_sync_at: Set(None),
        last_error: Set(None),
        config: Set(json!({})),
        created_at: Set(chrono::Utc::now().fixed_offset()),
        owner_type: Set("workspace".to_owned()),
        owner_user_id: Set(None),
        label: Set(provider.to_owned()),
        host: Set(format!("{provider}.example.test")),
    }
    .insert(db)
    .await
    .unwrap();
}

fn github_signature(raw: &[u8]) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, SIGNING_SECRET.as_bytes());
    format!("sha256={}", hex::encode(hmac::sign(&key, raw)))
}

async fn send(
    app: &axum::Router,
    uri: &str,
    event_headers: &[(&str, &str)],
    raw: &str,
) -> (StatusCode, Value) {
    let mut builder =
        Request::builder().method("POST").uri(uri).header("content-type", "application/json");
    for (key, value) in event_headers {
        builder = builder.header(*key, *value);
    }
    let response =
        app.clone().oneshot(builder.body(Body::from(raw.to_owned())).unwrap()).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn postgres_endpoints_verify_dispatch_deduplicate_and_release_failed_claims() {
    let Some(test) = TestDb::create().await else { return };
    Migrator::up(&test.db, None).await.unwrap();

    let config =
        Config::from_vars(&[("TRAMA_ENCRYPTION_KEY", "inbound-webhook-tests-encryption-key")]);
    let secrets = Secrets::from_config(&config).unwrap();
    users::ActiveModel {
        id: Set("u_webhook_test".to_owned()),
        name: Set("Webhook tester".to_owned()),
        email: Set("webhook@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(1),
        ..Default::default()
    }
    .insert(&test.db)
    .await
    .unwrap();
    workspaces::ActiveModel {
        id: Set("ws_webhook_test".to_owned()),
        name: Set("Webhook test".to_owned()),
        slug: Set("webhook-test".to_owned()),
        settings: Set(json!({})),
        primary_owner_id: Set(Some("u_webhook_test".to_owned())),
        personal: Set(false),
        ..Default::default()
    }
    .insert(&test.db)
    .await
    .unwrap();
    connection(&test.db, &secrets, "ic_gh_test", "github", "ws_webhook_test").await;
    connection(&test.db, &secrets, "ic_gl_test", "gitlab", "ws_webhook_test").await;
    connection(&test.db, &secrets, "ic_bb_test", "bitbucket", "ws_webhook_test").await;

    let app = trama_webhooks::router().into_app(AppState::new(test.db.clone(), config));

    let github_body = r#"{"zen":"keep it logically awesome"}"#;
    let gh_sig = github_signature(github_body.as_bytes());
    let (status, body) = send(
        &app,
        "/api/webhooks/github/ic_gh_test",
        &[
            ("x-hub-signature-256", &gh_sig),
            ("x-github-event", "ping"),
            ("x-github-delivery", "gh-once"),
        ],
        github_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status":"pong"}));
    let (status, body) = send(
        &app,
        "/api/webhooks/github/ic_gh_test",
        &[
            ("x-hub-signature-256", &gh_sig),
            ("x-github-event", "ping"),
            ("x-github-delivery", "gh-once"),
        ],
        github_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status":"duplicate"}));

    let malformed = r#"{"object_kind":"pipeline","project":{}}"#;
    let (status, _) = send(
        &app,
        "/api/webhooks/gitlab/ic_gl_test",
        &[("x-gitlab-token", SIGNING_SECRET), ("x-gitlab-event-uuid", "gl-retry")],
        malformed,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        webhook_deliveries::Entity::find_by_id("ic_gl_test:gl-retry")
            .one(&test.db)
            .await
            .unwrap()
            .is_none()
    );

    let pipeline = r#"{"object_kind":"pipeline","project":{"path_with_namespace":"team/repo"},"object_attributes":{"sha":"deadbeef","status":"success"}}"#;
    let (status, body) = send(
        &app,
        "/api/webhooks/gitlab/ic_gl_test",
        &[("x-gitlab-token", SIGNING_SECRET), ("x-gitlab-event-uuid", "gl-retry")],
        pipeline,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["reason"], "no matching pull/merge request");
    let (status, body) = send(
        &app,
        "/api/webhooks/gitlab/ic_gl_test",
        &[("x-gitlab-token", SIGNING_SECRET), ("x-gitlab-event-uuid", "gl-retry")],
        pipeline,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status":"duplicate"}));

    let bb_body = "{}";
    let bb_sig = github_signature(bb_body.as_bytes());
    let (status, body) = send(
        &app,
        "/api/webhooks/bitbucket/ic_bb_test",
        &[
            ("x-hub-signature", &bb_sig),
            ("x-event-key", "diagnostics:ping"),
            ("x-request-uuid", "bb-ping"),
        ],
        bb_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status":"pong"}));

    let bb_pr = r#"{"repository":{"full_name":"team/repo","links":{"html":{"href":"https://bitbucket.org/team/repo"}}},"pullrequest":{"id":42,"title":"Inbound task","state":"OPEN","source":{"branch":{"name":"feature/INBOX-7"},"commit":{"hash":"01234567"}},"links":{"html":{"href":"https://bitbucket.org/team/repo/pull-requests/42"}},"reviewers":[]}}"#;
    let bb_pr_sig = github_signature(bb_pr.as_bytes());
    let (status, body) = send(
        &app,
        "/api/webhooks/bitbucket/ic_bb_test",
        &[
            ("x-hub-signature", &bb_pr_sig),
            ("x-event-key", "pullrequest:created"),
            ("x-request-uuid", "bb-pr-once"),
        ],
        bb_pr,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["reason"], "no issue key found");
    let (status, body) = send(
        &app,
        "/api/webhooks/bitbucket/ic_bb_test",
        &[
            ("x-hub-signature", &bb_pr_sig),
            ("x-event-key", "pullrequest:created"),
            ("x-request-uuid", "bb-pr-once"),
        ],
        bb_pr,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status":"duplicate"}));

    test.drop().await;
}
