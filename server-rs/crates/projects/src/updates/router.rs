//! `ProjectUpdatesController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::projects::ProjectUpdate;
use trama_contracts::roles::Capability;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use super::schemas::{CreateProjectUpdateDto, UpdateProjectUpdateDto};
use super::service;

/// OpenAPI document of the update routes.
#[derive(OpenApi)]
#[openapi(
    paths(list, create, update, remove),
    components(schemas(CreateProjectUpdateDto, ProjectUpdate, UpdateProjectUpdateDto))
)]
pub struct ApiDoc;

/// `@Can('manageProjects')` on `POST` and `PATCH`.
const MANAGE: Gate = Gate::authenticated().can(Capability::ManageProjects);

/// Routes of the updates of a project. `GET` is open to every member who can see the project;
/// the token scope rules are the ones of `/projects` (`GET` reads, the rest writes).
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/projects/{id}/updates", Gate::authenticated(), list)
        .post("/w/{slug}/projects/{id}/updates", MANAGE, create)
        .patch("/w/{slug}/projects/{id}/updates/{updateId}", MANAGE, update)
        .delete("/w/{slug}/projects/{id}/updates/{updateId}", Gate::authenticated(), remove)
}

/// The updates of a project, newest first (at most 200).
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{id}/updates",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    responses(
        (status = 200, description = "Updates, newest first", body = [ProjectUpdate]),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or project, or outside the caller's access"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Vec<ProjectUpdate>>, AppError> {
    service::list(&state.db, &ctx.workspace.id, &id).await.map(Json)
}

/// Posts an update; a reported health also becomes the project's health.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/projects/{id}/updates",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    request_body = CreateProjectUpdateDto,
    responses(
        (status = 201, description = "The new update", body = ProjectUpdate),
        (status = 400, description = "Invalid body, or unknown health"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace or project, or outside the caller's access"),
    )
)]
async fn create(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(dto): ApiJson<CreateProjectUpdateDto>,
) -> Result<(StatusCode, Json<ProjectUpdate>), AppError> {
    let input = dto.validate()?;
    let posted = service::create(&state, &ctx, &id, &input.body, input.health.as_deref()).await?;
    Ok((StatusCode::CREATED, Json(posted)))
}

/// Edits the text and/or the reported health of an update. Author only; the project's own
/// health is not touched.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/projects/{id}/updates/{updateId}",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
        ("updateId" = String, Path, description = "Project update id"),
    ),
    request_body = UpdateProjectUpdateDto,
    responses(
        (status = 200, description = "The updated update", body = ProjectUpdate),
        (status = 400, description = "Invalid body, or unknown health"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not the author, or no right to manage projects"),
        (status = 404, description = "Unknown workspace, project or update"),
    )
)]
async fn update(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id, update_id)): Path<(String, String, String)>,
    ApiJson(dto): ApiJson<UpdateProjectUpdateDto>,
) -> Result<Json<ProjectUpdate>, AppError> {
    let patch = dto.validate()?;
    service::update(&state, &ctx, &id, &update_id, patch).await.map(Json)
}

/// Deletes an update. The author, or anyone who can manage projects.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/projects/{id}/updates/{updateId}",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
        ("updateId" = String, Path, description = "Project update id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Neither the author nor someone who manages projects"),
        (status = 404, description = "Unknown workspace, project or update"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id, update_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx, &id, &update_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
