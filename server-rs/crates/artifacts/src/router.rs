//! `ArtifactsController` (`server/src/artifacts/artifacts.controller.ts`), mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::issues::{Artifact, ArtifactKind, ArtifactProvider, ArtifactState};
use trama_core::{ApiJson, AppError, AppState};
use trama_uploads::schemas::artifact_view;
use utoipa::OpenApi;

use crate::schemas::{
    CreateArtifactBody, ListArtifactsQuery, ListOwnedArtifactsQuery, UpdateArtifactBody,
    parse_filter,
};
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, get, create, update, remove, list_for_issue, create_for_issue),
    components(schemas(
        Artifact,
        ArtifactKind,
        ArtifactProvider,
        ArtifactState,
        CreateArtifactBody,
        UpdateArtifactBody,
    ))
)]
pub struct ApiDoc;

/// Routes of this module. The controller has no decorators: members read, `member` and up
/// write, and the member grants on `artifacts` apply (`trama-auth`'s guard reads them from the
/// path). `POST /w/{slug}/tasks/{idOrKey}/artifacts/upload` belongs to `trama-uploads`.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/artifacts", Gate::authenticated(), list)
        .get("/w/{slug}/artifacts/{id}", Gate::authenticated(), get)
        .post("/w/{slug}/artifacts", Gate::authenticated(), create)
        .patch("/w/{slug}/artifacts/{id}", Gate::authenticated(), update)
        .delete("/w/{slug}/artifacts/{id}", Gate::authenticated(), remove)
        .get("/w/{slug}/tasks/{idOrKey}/artifacts", Gate::authenticated(), list_for_issue)
        .post("/w/{slug}/tasks/{idOrKey}/artifacts", Gate::authenticated(), create_for_issue)
}

fn views(rows: &[trama_entities::artifacts::Model]) -> Vec<Artifact> {
    rows.iter().map(artifact_view).collect()
}

/// The workspace's artifacts, newest first, without those of tasks in projects the caller
/// cannot reach.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/artifacts",
    tag = "artifacts",
    params(("slug" = String, Path, description = "Workspace slug"), ListArtifactsQuery),
    responses(
        (status = 200, description = "Visible artifacts, newest first", body = [Artifact]),
        (status = 400, description = "Invalid filter"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot read artifacts"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let filter = parse_filter(raw.as_deref(), true)?;
    let rows = service::list(&state.db, &ctx.workspace.id, &filter).await?;
    Ok(Json(views(&rows)))
}

/// One artifact.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/artifacts/{id}",
    tag = "artifacts",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Artifact id"),
    ),
    responses(
        (status = 200, description = "The artifact", body = Artifact),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot read artifacts"),
        (status = 404, description = "Unknown artifact, or one of a task the caller cannot reach"),
    )
)]
async fn get(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Artifact>, AppError> {
    let row = service::get(&state.db, &ctx.workspace.id, &id).await?;
    Ok(Json(artifact_view(&row)))
}

/// Attaches an artifact to a task named by `issueId`.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/artifacts",
    tag = "artifacts",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateArtifactBody,
    responses(
        (status = 201, description = "The new artifact", body = Artifact),
        (status = 400, description = "Invalid body, no task, or a task the caller cannot reach"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot attach artifacts"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn create(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateArtifactBody>,
) -> Result<(StatusCode, Json<Artifact>), AppError> {
    let (kind, input) = body.validate()?;
    let row = service::create(&state, &ctx.workspace.id, &actor, kind, input).await?;
    Ok((StatusCode::CREATED, Json(artifact_view(&row))))
}

/// Changes an artifact; a field left out stays, `null` clears a nullable one.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/artifacts/{id}",
    tag = "artifacts",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Artifact id"),
    ),
    request_body = UpdateArtifactBody,
    responses(
        (status = 200, description = "The artifact after the change", body = Artifact),
        (status = 400, description = "Invalid body, no task left, or a task the caller cannot reach"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot update artifacts"),
        (status = 404, description = "Unknown artifact, or one of a task the caller cannot reach"),
    )
)]
async fn update(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateArtifactBody>,
) -> Result<Json<Artifact>, AppError> {
    let patch = body.validate()?;
    let row = service::update(&state, &ctx.workspace.id, &actor, &id, patch).await?;
    Ok(Json(artifact_view(&row)))
}

/// Deletes an artifact, the comments on it and its uploaded file.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/artifacts/{id}",
    tag = "artifacts",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Artifact id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot delete artifacts"),
        (status = 404, description = "Unknown artifact, or one of a task the caller cannot reach"),
    )
)]
async fn remove(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The artifacts of one task, named by id, key (`CORA-12`) or alias.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks/{idOrKey}/artifacts",
    tag = "artifacts",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key or alias"),
        ListOwnedArtifactsQuery,
    ),
    responses(
        (status = 200, description = "The task's artifacts, newest first (empty for a task the caller cannot reach)", body = [Artifact]),
        (status = 400, description = "Invalid filter"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot read artifacts"),
        (status = 404, description = "Unknown task"),
    )
)]
async fn list_for_issue(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Artifact>>, AppError> {
    let mut filter = parse_filter(raw.as_deref(), false)?;
    filter.issue_id =
        Some(service::resolve_issue_id(&state.db, &ctx.workspace.id, &id_or_key).await?);
    let rows = service::list(&state.db, &ctx.workspace.id, &filter).await?;
    Ok(Json(views(&rows)))
}

/// Attaches an artifact to the task named in the path; the path wins over `issueId` in the body.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks/{idOrKey}/artifacts",
    tag = "artifacts",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key or alias"),
    ),
    request_body = CreateArtifactBody,
    responses(
        (status = 201, description = "The new artifact", body = Artifact),
        (status = 400, description = "Invalid body, or a task the caller cannot reach"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot attach artifacts"),
        (status = 404, description = "Unknown task"),
    )
)]
async fn create_for_issue(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    ApiJson(body): ApiJson<CreateArtifactBody>,
) -> Result<(StatusCode, Json<Artifact>), AppError> {
    let (kind, mut input) = body.validate()?;
    let issue_id = service::resolve_issue_id(&state.db, &ctx.workspace.id, &id_or_key).await?;
    input.issue_id = trama_core::validation::Patch::Value(issue_id);
    let row = service::create(&state, &ctx.workspace.id, &actor, kind, input).await?;
    Ok((StatusCode::CREATED, Json(artifact_view(&row))))
}
