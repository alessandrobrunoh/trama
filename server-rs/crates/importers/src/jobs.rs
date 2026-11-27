//! The preview and job routes of `ImportsController`: preview, start, list, get, cancel, retry
//! and delete. All need `manageIntegrations` (see `router`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::Value;
use trama_auth::{Actor, Ctx};
use trama_contracts::imports::{ImportJob, ImportPreview};
use trama_core::{ApiJson, AppError, AppState};

use crate::schemas::ImportRequestDto;
use crate::service;

/// Reads the source and answers with counts plus the suggested mapping. Writes nothing.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/imports/preview",
    tag = "importers",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = ImportRequestDto,
    responses(
        (status = 200, description = "What the import would read, with the suggested mapping", body = ImportPreview),
        (status = 400, description = "Invalid body, source or credential, or the tracker rejected the request"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace, or not a member"),
        (status = 429, description = "The tracker's rate limit was reached"),
        (status = 502, description = "The tracker failed or is unreachable"),
    )
)]
pub(crate) async fn preview(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<ImportRequestDto>,
) -> Result<Json<ImportPreview>, AppError> {
    let request = dto.validate(false)?;
    service::preview(&state, &ctx.workspace.id, &request).await.map(Json)
}

/// Queues the import and returns the job (202); poll `GET /imports/{id}` for progress.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/imports",
    tag = "importers",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = ImportRequestDto,
    responses(
        (status = 202, description = "The queued job", body = ImportJob),
        (status = 400, description = "Invalid body, source, credential or mapping"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace, or not a member"),
        (status = 409, description = "Another import is still running in this workspace"),
    )
)]
pub(crate) async fn start(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<ImportRequestDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let request = dto.validate(true)?;
    let job = service::start(&state, &ctx.workspace.id, &actor, &request).await?;
    Ok((StatusCode::ACCEPTED, Json(service::present(&job))))
}

/// The workspace's imports, newest first (at most 50).
#[utoipa::path(
    get,
    path = "/api/w/{slug}/imports",
    tag = "importers",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Import jobs", body = [ImportJob]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
pub(crate) async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<Value>>, AppError> {
    let jobs = service::list(&state, &ctx.workspace.id).await?;
    Ok(Json(jobs.iter().map(service::present).collect()))
}

/// One import job.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/imports/{id}",
    tag = "importers",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Import id"),
    ),
    responses(
        (status = 200, description = "The job", body = ImportJob),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace or import"),
    )
)]
pub(crate) async fn get_one(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let job = service::get(&state, &ctx.workspace.id, &id).await?;
    Ok(Json(service::present(&job)))
}

/// Stops an import: a queued one stops now, a running one at its next page. What was imported
/// stays.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/imports/{id}/cancel",
    tag = "importers",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Import id"),
    ),
    responses(
        (status = 200, description = "The job", body = ImportJob),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace or import"),
        (status = 409, description = "The import already ended"),
    )
)]
pub(crate) async fn cancel(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let job = service::cancel(&state, &ctx.workspace.id, &id).await?;
    Ok(Json(service::present(&job)))
}

/// Continues a failed import from where it stopped. Already imported issues are skipped.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/imports/{id}/retry",
    tag = "importers",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Import id"),
    ),
    responses(
        (status = 200, description = "The job", body = ImportJob),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace or import"),
        (status = 409, description = "The import did not fail, or another import is running"),
    )
)]
pub(crate) async fn retry(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let job = service::retry(&state, &ctx.workspace.id, &id).await?;
    Ok(Json(service::present(&job)))
}

/// Deletes a finished import job (what it imported stays).
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/imports/{id}",
    tag = "importers",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Import id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage integrations"),
        (status = 404, description = "Unknown workspace or import"),
        (status = 409, description = "The import is still active"),
    )
)]
pub(crate) async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
