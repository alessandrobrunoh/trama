//! `TimeEntriesController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{ManualTimeEntryDto, TargetDto, TimeEntry};
use crate::service;

/// This module's OpenAPI document.
#[derive(OpenApi)]
#[openapi(
    paths(list, start, stop, add, remove),
    components(schemas(ManualTimeEntryDto, TargetDto, TimeEntry))
)]
pub struct ApiDoc;

/// `@RequireUser()` and `@Roles('viewer')` on the controller.
const USER: Gate =
    Gate::authenticated().require_user().roles(trama_contracts::roles::LegacyRole::Viewer);

/// The workspace's time-entry routes.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/time-entries", USER, list)
        .post("/w/{slug}/time-entries/start", USER, start)
        .post("/w/{slug}/time-entries/stop", USER, stop)
        .post("/w/{slug}/time-entries", USER, add)
        .delete("/w/{slug}/time-entries/{id}", USER, remove)
}

/// Lists the signed-in user's recent entries.
#[utoipa::path(get, path = "/api/w/{slug}/time-entries", tag = "time-entries",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses((status = 200, description = "The caller's time entries", body = [TimeEntry]),
        (status = 401, description = "Not signed in"), (status = 404, description = "Unknown workspace or not a member")))]
async fn list(ctx: Ctx, State(state): State<AppState>) -> Result<Json<Vec<TimeEntry>>, AppError> {
    service::list(
        &state,
        &ctx.workspace.id,
        ctx.user_id.as_deref().ok_or_else(AppError::unauthorized)?,
    )
    .await
    .map(Json)
}

/// Stops the caller's active timer and starts another.
#[utoipa::path(post, path = "/api/w/{slug}/time-entries/start", tag = "time-entries",
    params(("slug" = String, Path, description = "Workspace slug")), request_body = TargetDto,
    responses((status = 201, description = "The running timer", body = TimeEntry),
        (status = 400, description = "Invalid target"), (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown target or workspace")))]
async fn start(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<TargetDto>,
) -> Result<(StatusCode, Json<TimeEntry>), AppError> {
    let row = service::start(
        &state,
        &ctx.workspace.id,
        ctx.user_id.as_deref().ok_or_else(AppError::unauthorized)?,
        dto.validate()?,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// Stops the caller's running timer.
#[utoipa::path(post, path = "/api/w/{slug}/time-entries/stop", tag = "time-entries",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses((status = 201, description = "The stopped timer", body = TimeEntry),
        (status = 400, description = "No timer is running"), (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace")))]
async fn stop(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<TimeEntry>), AppError> {
    service::stop(
        &state,
        &ctx.workspace.id,
        ctx.user_id.as_deref().ok_or_else(AppError::unauthorized)?,
    )
    .await
    .map(|entry| (StatusCode::CREATED, Json(entry)))
}

/// Adds a manual time entry.
#[utoipa::path(post, path = "/api/w/{slug}/time-entries", tag = "time-entries",
    params(("slug" = String, Path, description = "Workspace slug")), request_body = ManualTimeEntryDto,
    responses((status = 201, description = "The new time entry", body = TimeEntry),
        (status = 400, description = "Invalid interval or target"), (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown target or workspace")))]
async fn add(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<ManualTimeEntryDto>,
) -> Result<(StatusCode, Json<TimeEntry>), AppError> {
    let row = service::add(
        &state,
        &ctx.workspace.id,
        ctx.user_id.as_deref().ok_or_else(AppError::unauthorized)?,
        dto.validate()?,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// Deletes one of the caller's entries.
#[utoipa::path(delete, path = "/api/w/{slug}/time-entries/{id}", tag = "time-entries",
    params(("slug" = String, Path, description = "Workspace slug"), ("id" = String, Path, description = "Entry id")),
    responses((status = 204, description = "Deleted"), (status = 401, description = "Not signed in"),
        (status = 404, description = "Entry absent or owned by another person")))]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(
        &state,
        &ctx.workspace.id,
        ctx.user_id.as_deref().ok_or_else(AppError::unauthorized)?,
        &id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use sea_orm_migration::MigratorTrait;
    use tower::ServiceExt;
    use trama_core::Config;
    use trama_core::testkit::TestDb;

    use super::*;

    #[tokio::test]
    async fn http_route_requires_a_signed_in_user() {
        let Some(test) = TestDb::create().await else {
            return;
        };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let response = router()
            .into_app(AppState::new(test.db.clone(), Config::from_lookup(|_| None).unwrap()))
            .oneshot(Request::get("/api/w/test/time-entries").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["message"], "Authentication required");
        test.drop().await;
    }

    #[tokio::test]
    async fn http_list_returns_only_the_authenticated_users_entries() {
        use trama_auth::service::{NewUser, create_session, create_user};
        use trama_workspaces::schemas::NewWorkspace;

        let Some(test) = TestDb::create().await else {
            return;
        };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let user = create_user(
            &test.db,
            NewUser { name: "Timer user", email: "timer@example.test", password: "not-a-secret" },
        )
        .await
        .unwrap();
        let workspace = trama_workspaces::service::create_workspace(
            &test.db,
            &user,
            &NewWorkspace {
                name: "Timer workspace".to_owned(),
                slug: Some("timer-workspace".to_owned()),
            },
        )
        .await
        .unwrap();
        let added = service::add(
            &AppState::new(test.db.clone(), Config::from_lookup(|_| None).unwrap()),
            &workspace.workspace.id,
            &user.id,
            crate::service::ManualTimeEntry {
                target: crate::service::Target {
                    description: Some("review".to_owned()),
                    project_id: None,
                    issue_id: None,
                },
                started_at: trama_milestones::dates::parse("2026-10-28T10:00:00Z").unwrap(),
                ended_at: trama_milestones::dates::parse("2026-10-28T11:00:00Z").unwrap(),
            },
        )
        .await
        .unwrap();
        let session = create_session(&test.db, &user.id, None).await.unwrap();
        let response = router()
            .into_app(AppState::new(test.db.clone(), Config::from_lookup(|_| None).unwrap()))
            .oneshot(
                Request::get("/api/w/timer-workspace/time-entries")
                    .header("cookie", format!("trama_session={}", session.raw))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body.as_array().unwrap().len(), 1);
        assert_eq!(body[0]["id"], added.id);
        assert_eq!(body[0]["workspaceId"], workspace.workspace.id);
        assert_eq!(body[0]["userId"], user.id);
        assert_eq!(body[0]["description"], "review");
        assert_eq!(workspace.workspace.slug, "timer-workspace");
        test.drop().await;
    }
}
