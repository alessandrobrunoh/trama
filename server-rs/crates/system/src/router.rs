//! Routes of the system module, mounted under `/api`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::ConnectionTrait;
use trama_core::time::now_iso;
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{HealthDown, HealthUp};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(paths(health), components(schemas(HealthUp, HealthDown)))]
pub struct ApiDoc;

/// Routes of this module.
pub fn router() -> Router<AppState> {
    Router::new().route("/health", get(health))
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
            .with_state(state)
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
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

    #[tokio::test]
    async fn reports_down() {
        let (status, body) =
            get_health(AppState::new(sea_orm::DatabaseConnection::default(), config())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, json!({"status": "error", "db": "down"}));
    }
}
