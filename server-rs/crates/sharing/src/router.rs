//! `SharingController` and `ProjectTransferController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Actor, Auth, Ctx, Gate, Routes};
use trama_contracts::projects::{
    ProjectPlacement, ProjectTransferPreview, ProjectTransferResult, SharedProject,
};
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{PlaceProjectBody, Placement, TransferProjectBody, parse_target_query};
use crate::{service, transfer};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, place, clear, leave, preview, transfer_project),
    components(schemas(
        PlaceProjectBody,
        TransferProjectBody,
        SharedProject,
        ProjectPlacement,
        ProjectTransferPreview,
        ProjectTransferResult
    ))
)]
pub struct ApiDoc;

/// `@RequireUser() @SessionOnly()`: account-level and personal. Every route acts on the caller's
/// own rows and needs a browser session (an API token belongs to one workspace and cannot see
/// across them).
const ACCOUNT: Gate = Gate::authenticated().require_user().session_only();

/// `@Roles('admin')` on a handler of the same controller.
const TRANSFER: Gate = ACCOUNT.roles(LegacyRole::Admin);

/// Routes of this module, relative to `/api`.
pub fn router() -> Routes {
    Routes::new()
        .get("/shared/projects", ACCOUNT, list)
        .put("/shared/projects/{projectId}/placement", ACCOUNT, place)
        .delete("/shared/projects/{projectId}/placement", ACCOUNT, clear)
        .post("/shared/projects/{projectId}/leave", ACCOUNT, leave)
        .get("/w/{slug}/projects/{id}/transfer-preview", TRANSFER, preview)
        .post("/w/{slug}/projects/{id}/transfer", TRANSFER, transfer_project)
}

/// Projects shared with me, from every workspace where I am a guest.
#[utoipa::path(
    get,
    path = "/api/shared/projects",
    tag = "sharing",
    responses(
        (status = 200, description = "Shared projects, by workspace name then project name", body = [SharedProject]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "API token or agent"),
    )
)]
async fn list(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<Vec<SharedProject>>, AppError> {
    let user = auth.require_user()?;
    Ok(Json(service::list(&state.db, &user.id).await?))
}

/// Show in a workspace of mine (`workspaceId`), or hide from Shared with me (`null`).
#[utoipa::path(
    put,
    path = "/api/shared/projects/{projectId}/placement",
    tag = "sharing",
    params(("projectId" = String, Path, description = "Project id")),
    request_body = PlaceProjectBody,
    responses(
        (status = 200, description = "The stored placement", body = ProjectPlacement),
        (status = 400, description = "Invalid body, or the project already lives in that workspace"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "API token or agent"),
        (status = 404, description = "Not shared with me, or not my workspace"),
    )
)]
async fn place(
    State(state): State<AppState>,
    auth: Auth,
    Path(project_id): Path<String>,
    ApiJson(body): ApiJson<PlaceProjectBody>,
) -> Result<Json<ProjectPlacement>, AppError> {
    let user = auth.require_user()?;
    let placement = match body.validate()? {
        Placement::Hidden => service::hide(&state.db, &user.id, &project_id).await?,
        Placement::In { workspace_id, position } => {
            service::place(&state.db, &user.id, &project_id, &workspace_id, position).await?
        }
    };
    Ok(Json(placement))
}

/// Back to Shared with me.
#[utoipa::path(
    delete,
    path = "/api/shared/projects/{projectId}/placement",
    tag = "sharing",
    params(("projectId" = String, Path, description = "Project id")),
    responses(
        (status = 204, description = "Placement removed (also when there was none)"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "API token or agent"),
    )
)]
async fn clear(
    State(state): State<AppState>,
    auth: Auth,
    Path(project_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let user = auth.require_user()?;
    service::clear(&state.db, &user.id, &project_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Give up my access to the project.
#[utoipa::path(
    post,
    path = "/api/shared/projects/{projectId}/leave",
    tag = "sharing",
    params(("projectId" = String, Path, description = "Project id")),
    responses(
        (status = 204, description = "Access removed"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "API token or agent"),
        (status = 404, description = "Not shared with me"),
    )
)]
async fn leave(
    State(state): State<AppState>,
    auth: Auth,
    Path(project_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let user = auth.require_user()?;
    service::leave(&state, &user.id, &project_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a transfer would do: status and label mapping, guests carried over, blockers. Changes
/// nothing.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{id}/transfer-preview",
    tag = "sharing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
        ("target" = String, Query, description = "Slug of the workspace the project would move to"),
    ),
    responses(
        (status = 200, description = "The dry run", body = ProjectTransferPreview),
        (status = 400, description = "Invalid target, or the project already lives there"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not an admin of both workspaces, or an API token"),
        (status = 404, description = "Unknown project, or a target the caller does not belong to"),
    )
)]
async fn preview(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<ProjectTransferPreview>, AppError> {
    let target = parse_target_query(raw.as_deref())?;
    Ok(Json(transfer::preview(&state, &ctx, &id, &target).await?))
}

/// Moves the project, with its issues, time, comments and history, to another workspace.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/projects/{id}/transfer",
    tag = "sharing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    request_body = TransferProjectBody,
    responses(
        (status = 200, description = "The moved project", body = ProjectTransferResult),
        (status = 400, description = "Invalid body, or the project already lives there"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not an admin of both workspaces, or an API token"),
        (status = 404, description = "Unknown project, or a target the caller does not belong to"),
        (status = 409, description = "The plan has blockers, or something already exists in the target"),
    )
)]
async fn transfer_project(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<TransferProjectBody>,
) -> Result<Json<ProjectTransferResult>, AppError> {
    let target = body.validate()?;
    Ok(Json(transfer::transfer(&state, &ctx, actor, &id, &target).await?))
}
