//! `AttentionController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::activity::{AttentionItem, AttentionKind, AttentionSeverity, AttentionState};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::SnoozeBody;
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, dismiss, dismiss_post, snooze, restore),
    components(schemas(
        AttentionItem,
        AttentionKind,
        AttentionSeverity,
        AttentionState,
        SnoozeBody,
    ))
)]
pub struct ApiDoc;

/// `@RequireUser()` on the controller: an agent token has no attention of its own.
const USER: Gate = Gate::authenticated().require_user();

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/attention", USER, list)
        .delete("/w/{slug}/attention/{id}", USER, dismiss)
        .post("/w/{slug}/attention/{id}/dismiss", USER, dismiss_post)
        .post("/w/{slug}/attention/{id}/snooze", USER, snooze)
        .post("/w/{slug}/attention/{id}/restore", USER, restore)
}

/// The caller's attention items: open, snoozed and dismissed ones, most severe first.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/attention",
    tag = "attention",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Attention items", body = [AttentionItem]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
) -> Result<Json<Vec<AttentionItem>>, AppError> {
    let user = auth.require_user()?;
    service::list(&state.db, &ctx.workspace.id, &user.id, None).await.map(Json)
}

/// Dismisses an item for the caller.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/attention/{id}",
    tag = "attention",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Attention item id, e.g. `ci_failed:ar_1`"),
    ),
    responses(
        (status = 200, description = "Dismissed; empty body"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or no such attention item"),
    )
)]
async fn dismiss(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let user = auth.require_user()?;
    service::dismiss(&state.db, &ctx.workspace.id, &user.id, &id).await?;
    Ok(StatusCode::OK)
}

/// `DELETE /attention/{id}` for clients that cannot send a DELETE.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/attention/{id}/dismiss",
    tag = "attention",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Attention item id"),
    ),
    responses(
        (status = 201, description = "Dismissed; empty body"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or no such attention item"),
    )
)]
async fn dismiss_post(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let user = auth.require_user()?;
    service::dismiss(&state.db, &ctx.workspace.id, &user.id, &id).await?;
    Ok(StatusCode::CREATED)
}

/// Hides an item for the caller until a future date.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/attention/{id}/snooze",
    tag = "attention",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Attention item id"),
    ),
    request_body = SnoozeBody,
    responses(
        (status = 201, description = "Snoozed; empty body"),
        (status = 400, description = "`until` is not an ISO date, or not in the future"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or no such attention item"),
    )
)]
async fn snooze(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<SnoozeBody>,
) -> Result<StatusCode, AppError> {
    let user = auth.require_user()?;
    let until = body.validate()?;
    service::snooze(&state.db, &ctx.workspace.id, &user.id, &id, &until).await?;
    Ok(StatusCode::CREATED)
}

/// Brings a dismissed or snoozed item back.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/attention/{id}/restore",
    tag = "attention",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Attention item id"),
    ),
    responses(
        (status = 201, description = "The item, open again", body = AttentionItem),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or no such attention item"),
    )
)]
async fn restore(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<AttentionItem>), AppError> {
    let user = auth.require_user()?;
    let item = service::restore(&state.db, &ctx.workspace.id, &user.id, &id).await?;
    Ok((StatusCode::CREATED, Json(item)))
}
