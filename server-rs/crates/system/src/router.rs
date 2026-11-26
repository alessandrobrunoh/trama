//! Routes of the system module, mounted under `/api`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use sea_orm::ConnectionTrait;
use trama_auth::{Gate, Routes};
use trama_core::time::now_iso;
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{HealthDown, HealthUp, PublicConfig};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(paths(health, public_config), components(schemas(HealthUp, HealthDown, PublicConfig)))]
pub struct ApiDoc;

/// Routes of this module; both are public.
pub fn router() -> Routes {
    Routes::new().get("/health", Gate::public(), health).get(
        "/config",
        Gate::public(),
        public_config,
    )
}

/// Unauthenticated settings the sign-in page needs before a session exists. Public.
#[utoipa::path(
    get,
    path = "/api/config",
    tag = "system",
    responses((status = 200, description = "Public settings", body = PublicConfig))
)]
async fn public_config(State(state): State<AppState>) -> Json<PublicConfig> {
    let views = &state.config.public_views;
    Json(PublicConfig {
        demo_login: state.config.demo_login,
        roadmap_view_token: views.roadmap_view_token.clone(),
        changelog_view_token: views.changelog_view_token.clone(),
    })
}

/// Liveness and database check (Docker healthcheck). Public.
#[utoipa::path(
    get,
    path = "/api/health",
    tag = "system",
    responses(
        (status = 200, description = "API and database are up", body = HealthUp),
        (status = 503, description = "The database does not answer", body = HealthDown),
    )
)]
async fn health(State(state): State<AppState>) -> Result<Json<HealthUp>, AppError> {
    match state.db.execute_unprepared("SELECT 1").await {
        Ok(_) => Ok(Json(HealthUp { status: "ok", db: "up", time: now_iso() })),
        Err(_) => Err(AppError::with_body(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::to_value(HealthDown { status: "error", db: "down" }).unwrap_or_default(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;
    use trama_core::Config;
    use trama_core::testkit::TestDb;

    async fn get_health(state: AppState) -> (StatusCode, Value) {
        let res = router()
            .into_app(state)
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn config() -> Config {
        Config::from_lookup(|_| None).unwrap()
    }

    #[tokio::test]
    async fn reports_up() {
        let Some(test) = TestDb::create().await else { return };
        let (status, body) = get_health(AppState::new(test.db.clone(), config())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["db"], "up");
        let time = body["time"].as_str().unwrap();
        assert!(time.ends_with('Z') && time.len() == 24, "{time}");
        test.drop().await;
    }

    async fn get_config(vars: &[(&str, &str)]) -> Value {
        let state = AppState::new(sea_orm::DatabaseConnection::default(), Config::from_vars(vars));
        let res = router()
            .into_app(state)
            .oneshot(Request::get("/api/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn public_config_reports_demo_login_and_view_tokens() {
        assert_eq!(
            get_config(&[]).await,
            json!({"demoLogin": true, "roadmapViewToken": null, "changelogViewToken": null})
        );
        assert_eq!(
            get_config(&[
                ("NODE_ENV", "production"),
                ("PUBLIC_ROADMAP_VIEW_TOKEN", " roadmap-token "),
                ("PUBLIC_CHANGELOG_VIEW_TOKEN", "changelog-token"),
            ])
            .await,
            json!({
                "demoLogin": false,
                "roadmapViewToken": "roadmap-token",
                "changelogViewToken": "changelog-token"
            })
        );
        let shown = get_config(&[("NODE_ENV", "production"), ("DEMO_LOGIN", "on")]).await;
        assert_eq!(shown["demoLogin"], true);
    }

    #[tokio::test]
    async fn reports_down() {
        let (status, body) =
            get_health(AppState::new(sea_orm::DatabaseConnection::default(), config())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, json!({"status": "error", "db": "down"}));
    }
}
