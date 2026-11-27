//! `FavoritesController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::identity::{Favorite, FavoriteType};
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{AddFavoriteDto, favorite};
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(paths(list, add, remove), components(schemas(AddFavoriteDto, Favorite, FavoriteType)))]
pub struct ApiDoc;

/// `@RequireUser()` on the controller: favorites are personal, so agent tokens get 403.
const PERSONAL: Gate = Gate::authenticated().require_user();

/// Routes of this module. Viewers may keep favorites too (`@Roles('viewer')` on the writes).
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/favorites", PERSONAL, list)
        .post("/w/{slug}/favorites", PERSONAL.roles(LegacyRole::Viewer), add)
        .delete(
            "/w/{slug}/favorites/{kind}/{subject_id}",
            PERSONAL.roles(LegacyRole::Viewer),
            remove,
        )
}

/// The caller's id; routes behind `require_user` always have one.
fn user_id(ctx: &Ctx) -> Result<&str, AppError> {
    ctx.user_id.as_deref().ok_or_else(|| AppError::forbidden(trama_auth::guard::REQUIRE_USER))
}

/// The caller's favorites in this workspace, oldest first.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/favorites",
    tag = "favorites",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "The caller's favorites, oldest first", body = [Favorite]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no favorites"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(ctx: Ctx, State(state): State<AppState>) -> Result<Json<Vec<Favorite>>, AppError> {
    let rows = service::list(&state, &ctx.workspace.id, user_id(&ctx)?).await?;
    Ok(Json(rows.into_iter().filter_map(favorite).collect()))
}

/// Pins an issue, project or view; pinning something already pinned returns the existing favorite.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/favorites",
    tag = "favorites",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = AddFavoriteDto,
    responses(
        (status = 201, description = "The favorite", body = Favorite),
        (status = 400, description = "Invalid body"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no favorites"),
        (status = 404, description = "Unknown workspace, or a subject that does not exist or is not visible to the caller"),
        (status = 409, description = "The caller already keeps the most favorites allowed"),
    )
)]
async fn add(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<AddFavoriteDto>,
) -> Result<(StatusCode, Json<Favorite>), AppError> {
    let (kind, subject_id) = dto.validate()?;
    let row = service::add(&state, &ctx.workspace.id, user_id(&ctx)?, kind, &subject_id).await?;
    let saved = favorite(row).ok_or_else(|| AppError::internal("favorite of an unknown type"))?;
    Ok((StatusCode::CREATED, Json(saved)))
}

/// Unpins. Idempotent.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/favorites/{kind}/{subject_id}",
    tag = "favorites",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("kind" = FavoriteType, Path, description = "`issue`, `project` or `view`"),
        ("subject_id" = String, Path, description = "Id of the pinned record"),
    ),
    responses(
        (status = 204, description = "Unpinned (or it was not pinned)"),
        (status = 400, description = "Unknown type"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no favorites"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, kind, subject_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AppError> {
    // `ParseEnumPipe(FAVORITE_TYPES)`
    let kind = FavoriteType::parse(&kind)
        .ok_or_else(|| AppError::bad_request("Validation failed (enum string is expected)"))?;
    service::remove(&state, &ctx.workspace.id, user_id(&ctx)?, kind, &subject_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
