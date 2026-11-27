#![allow(missing_docs)]

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_auth::service::create_session;
use trama_contracts::issues::{ArtifactKind, ArtifactState};
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{integration_connections, memberships, projects, users, workspaces};
use trama_integrations::ArtifactCandidate;
use trama_integrations::candidates::IssueCandidateState;
use trama_integrations::{IssueCandidate, RepoMeta};
use trama_migration::Migrator;

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .header("x-client-id", "routing-http-test");
    let body = if let Some(body) = body {
        let body = body.to_string();
        request = request.header("content-length", body.len());
        request = request.header("content-type", "application/json");
        Body::from(body)
    } else {
        Body::empty()
    };
    let response = app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
    let (parts, body) = response.into_parts();
    let json =
        serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap_or(Value::Null);
    (parts.status, json)
}

#[tokio::test]
#[allow(clippy::large_futures, clippy::too_many_lines)]
async fn postgres_routes_scope_rules_and_enforce_crud_permissions() {
    let Some(test) = TestDb::create().await else { return };
    Migrator::up(&test.db, None).await.unwrap();
    let db = &test.db;
    let now = chrono::Utc::now().fixed_offset();
    let workspace_id = "ws_route_test";
    let user_id = "u_route_test";
    let project_id = "pj_route_test";

    users::ActiveModel {
        id: Set(user_id.to_owned()),
        name: Set("Routing tester".to_owned()),
        email: Set("routing@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    workspaces::ActiveModel {
        id: Set(workspace_id.to_owned()),
        name: Set("Routing".to_owned()),
        slug: Set("routing-http-test".to_owned()),
        settings: Set(json!({ "roles": fresh_workspace_roles() })),
        primary_owner_id: Set(Some(user_id.to_owned())),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    memberships::ActiveModel {
        id: Set("mb_route_test".to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        role: Set("owner".to_owned()),
        access: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    projects::ActiveModel {
        id: Set(project_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        name: Set("Web".to_owned()),
        color: Set("#ffffff".to_owned()),
        status: Set("active".to_owned()),
        priority: Set("none".to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        labels: Set(json!([])),
        key: Set("WEB".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    integration_connections::ActiveModel {
        id: Set("ic_route_test".to_owned()),
        workspace_id: Set(Some(workspace_id.to_owned())),
        owner_type: Set("workspace".to_owned()),
        provider: Set("github".to_owned()),
        account: Set("acme".to_owned()),
        host: Set("github.com".to_owned()),
        label: Set("GitHub · Acme".to_owned()),
        status: Set("connected".to_owned()),
        secret: Set(Some("encrypted-placeholder".to_owned())),
        webhook_secret: Set(Some("encrypted-placeholder".to_owned())),
        config: Set(json!({})),
        created_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();

    let viewer_id = "u_route_viewer";
    users::ActiveModel {
        id: Set(viewer_id.to_owned()),
        name: Set("Routing viewer".to_owned()),
        email: Set("routing-viewer@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(2),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    memberships::ActiveModel {
        id: Set("mb_route_viewer".to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(viewer_id.to_owned()),
        role: Set("viewer".to_owned()),
        access: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let limited_id = "u_route_limited";
    users::ActiveModel {
        id: Set(limited_id.to_owned()),
        name: Set("Limited member".to_owned()),
        email: Set("limited@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(3),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    memberships::ActiveModel {
        id: Set("mb_route_limited".to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(limited_id.to_owned()),
        role: Set("member".to_owned()),
        access: Set(Some(json!({
            "projects": { "all": false, "projectIds": [project_id] },
            "includeUnassigned": false,
            "grants": []
        }))),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let hidden_id = "u_route_hidden";
    users::ActiveModel {
        id: Set(hidden_id.to_owned()),
        name: Set("Hidden member".to_owned()),
        email: Set("hidden@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(4),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    memberships::ActiveModel {
        id: Set("mb_route_hidden".to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(hidden_id.to_owned()),
        role: Set("member".to_owned()),
        access: Set(Some(json!({
            "projects": { "all": false, "projectIds": [] },
            "includeUnassigned": false,
            "grants": []
        }))),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let session = create_session(db, user_id, Some("routing-http-test")).await.unwrap();
    let cookie = format!("trama_session={}", session.raw);
    let viewer_session = create_session(db, viewer_id, Some("routing-http-test")).await.unwrap();
    let viewer_cookie = format!("trama_session={}", viewer_session.raw);
    let limited_session = create_session(db, limited_id, Some("routing-http-test")).await.unwrap();
    let limited_cookie = format!("trama_session={}", limited_session.raw);
    let hidden_session = create_session(db, hidden_id, Some("routing-http-test")).await.unwrap();
    let hidden_cookie = format!("trama_session={}", hidden_session.raw);
    let state = AppState::new(db.clone(), Config::from_vars(&[]));
    let app = trama_routing::router().into_app(state.clone());
    let base = format!("/api/w/routing-http-test/projects/{project_id}/routing-rules");
    let payload = json!({
        "provider": "github",
        "sourcePath": "https://github.com/acme/web.git",
        "connectionId": "ic_route_test"
    });

    let (status, created) = send(&app, Method::POST, &base, &cookie, Some(payload)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["sourcePath"], "acme/web");
    assert_eq!(created["connection"]["label"], "GitHub · Acme");
    let (status, _) = send(
        &app,
        Method::POST,
        &base,
        &cookie,
        Some(json!({
            "provider": "github",
            "sourcePath": "ACME/Web",
            "connectionId": "ic_route_test"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = send(
        &app,
        Method::POST,
        &base,
        &viewer_cookie,
        Some(json!({
            "provider": "github",
            "sourcePath": "acme/api",
            "connectionId": "ic_route_test"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(&app, Method::GET, &base, &hidden_cookie, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, Method::GET, &base, &viewer_cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, Method::GET, &base, &limited_cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = send(
        &app,
        Method::POST,
        &base,
        &limited_cookie,
        Some(json!({
            "provider": "github",
            "sourcePath": "acme/api",
            "connectionId": "ic_route_test"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "limited writer: {error}");

    let (status, overview) = send(&app, Method::GET, &base, &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(overview["rules"].as_array().unwrap().len(), 1);
    let (status, options) =
        send(&app, Method::GET, &format!("{base}/connections?provider=github"), &cookie, None)
            .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(options[0]["id"], "ic_route_test");
    assert_eq!(options[0]["suggested"], true);

    let candidate = IssueCandidate {
        provider: trama_contracts::common::GitProvider::Github,
        external_id: "#11".to_owned(),
        number: 11,
        title: "Routed issue".to_owned(),
        body: Some("Created from a webhook".to_owned()),
        url: Some("https://github.com/acme/web/issues/11".to_owned()),
        state: IssueCandidateState::Open,
        state_reason: None,
        labels: vec!["bug".to_owned()],
        milestone: None,
        author: Some("contributor".to_owned()),
    };
    let repo = RepoMeta {
        full_name: "acme/web".to_owned(),
        url: Some("https://github.com/acme/web".to_owned()),
        default_branch: Some("main".to_owned()),
    };
    let routed = trama_routing::inbound::route_issue(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &candidate,
    )
    .await
    .unwrap();
    assert_eq!(routed.status, trama_routing::inbound::RoutedIssueStatus::Created);
    let replay = trama_routing::inbound::route_issue(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &candidate,
    )
    .await
    .unwrap();
    assert_eq!(replay.status, trama_routing::inbound::RoutedIssueStatus::Unchanged);
    assert_eq!(replay.key, routed.key);
    let mut closed = candidate.clone();
    closed.state = IssueCandidateState::Closed;
    let followed = trama_routing::inbound::route_issue(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &closed,
    )
    .await
    .unwrap();
    assert_eq!(followed.status, trama_routing::inbound::RoutedIssueStatus::Updated);
    let task =
        trama_issues::service::get(db, workspace_id, routed.key.as_deref().unwrap()).await.unwrap();
    assert_eq!(task.status, "done");

    let mut pull_request = ArtifactCandidate::new(
        ArtifactKind::PullRequest,
        trama_contracts::common::GitProvider::Github,
        "#12",
        "Refactor login",
    );
    pull_request.url = Some("https://github.com/acme/web/pull/12".to_owned());
    pull_request.state = Some(ArtifactState::Open);
    pull_request.texts = vec!["Refactor login".to_owned(), "PR description".to_owned()];
    let placed = trama_routing::inbound::route_pull_request(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &pull_request,
        &trama_integrations::ItemMeta::default(),
    )
    .await
    .unwrap();
    assert!(placed.placed);
    let replay = trama_routing::inbound::route_pull_request(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &pull_request,
        &trama_integrations::ItemMeta::default(),
    )
    .await
    .unwrap();
    assert!(!replay.placed);
    assert_eq!(replay.key, placed.key);
    let mut keyed_pr = ArtifactCandidate::new(
        ArtifactKind::PullRequest,
        trama_contracts::common::GitProvider::Github,
        "#13",
        "Fix task",
    );
    keyed_pr.texts =
        vec!["Fix task".to_owned(), format!("Implements {}", routed.key.as_deref().unwrap())];
    let linked = trama_routing::inbound::route_pull_request(
        &state,
        "ic_route_test",
        trama_contracts::common::GitProvider::Github,
        &repo,
        &keyed_pr,
        &trama_integrations::ItemMeta::default(),
    )
    .await
    .unwrap();
    assert!(!linked.placed);
    assert_eq!(linked.key, routed.key);

    let (status, updated) = send(
        &app,
        Method::PATCH,
        &format!("{base}/{}", created["id"].as_str().unwrap()),
        &cookie,
        Some(json!({ "direction": "two_way", "filters": { "labels": ["bug"] } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["direction"], "two_way", "{updated}");
    assert_eq!(updated["filters"]["labels"][0], "bug");
    let (status, _) = send(
        &app,
        Method::PATCH,
        &format!("{base}/{}", created["id"].as_str().unwrap()),
        &cookie,
        Some(json!({ "filters": null })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("{base}/{}", created["id"].as_str().unwrap()),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("{base}/{}", created["id"].as_str().unwrap()),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    test.drop().await;
}
