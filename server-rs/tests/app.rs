//! The assembled application, without a database.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_core::{AppState, Config};

fn app(production: bool) -> axum::Router {
    let config = Config { production, ..Config::from_lookup(|_| None).unwrap() };
    trama_api::app(AppState::new(sea_orm::DatabaseConnection::default(), config))
}

async fn send(app: axum::Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = app.oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (parts.status, parts.headers, json)
}

#[tokio::test]
async fn unknown_routes_answer_like_nest() {
    let req = Request::post("/api/nope?x=1").body(Body::empty()).unwrap();
    let (status, headers, body) = send(app(false), req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        json!({"statusCode": 404, "message": "Cannot POST /api/nope", "error": "Not Found"})
    );
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn health_is_mounted_under_api() {
    let req = Request::get("/api/health").body(Body::empty()).unwrap();
    let (status, _, body) = send(app(false), req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["db"], "down");
}

#[tokio::test]
async fn public_config_is_mounted_under_api() {
    let req = Request::get("/api/config").body(Body::empty()).unwrap();
    let (status, _, body) = send(app(false), req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"demoLogin": true, "roadmapViewToken": null, "changelogViewToken": null})
    );
}

#[tokio::test]
async fn rate_limited_answers_carry_cors_and_security_headers() {
    let config = Config::from_vars(&[("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1")]);
    let app = trama_api::app(AppState::new(sea_orm::DatabaseConnection::default(), config));
    let login = || {
        Request::post("/api/auth/login")
            .header(header::ORIGIN, "http://localhost:4300")
            .body(Body::empty())
            .unwrap()
    };
    // the first login reaches the handler (an empty body is a 400), the second is refused
    // before routing
    assert_eq!(send(app.clone(), login()).await.0, StatusCode::BAD_REQUEST);
    let (status, headers, body) = send(app, login()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key(header::RETRY_AFTER));
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://localhost:4300");
    assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(body["statusCode"], 429);
}

#[tokio::test]
async fn nul_in_the_query_is_a_400() {
    let req = Request::get("/api/config?q=%00").body(Body::empty()).unwrap();
    let (status, _, body) = send(app(false), req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["message"], "Text must not contain NUL characters");
}

#[tokio::test]
async fn openapi_lists_module_paths_outside_production() {
    let req = Request::get("/api/openapi.json").body(Body::empty()).unwrap();
    let (status, _, body) = send(app(false), req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["paths"]["/api/health"]["get"].is_object(), "{body}");
    assert!(body["paths"]["/api/w/{slug}/events"]["get"].is_object(), "{body}");
    assert!(body["paths"]["/api/w/{slug}/events/stream"]["get"].is_object(), "{body}");

    let req = Request::get("/api/docs").body(Body::empty()).unwrap();
    assert_eq!(send(app(false), req).await.0, StatusCode::OK);

    let req = Request::get("/api/openapi.json").body(Body::empty()).unwrap();
    assert_eq!(send(app(true), req).await.0, StatusCode::NOT_FOUND);
}
