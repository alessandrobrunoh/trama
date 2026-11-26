//! `ExternalIdentitiesController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Auth, Gate, Routes};
use trama_contracts::identity::{ExternalIdentityProvider, ExternalIdentitySource};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{AddExternalIdentityDto, ExternalIdentityView};
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, add, remove),
    components(schemas(
        AddExternalIdentityDto,
        ExternalIdentityProvider,
        ExternalIdentitySource,
        ExternalIdentityView,
    ))
)]
pub struct ApiDoc;

/// `@RequireUser()` on the controller: the logins are personal, so agent tokens get 403.
const PERSONAL: Gate = Gate::authenticated().require_user();

/// Routes of this module. Nobody can read or change another person's list.
pub fn router() -> Routes {
    Routes::new()
        .get("/me/external-identities", PERSONAL, list)
        .post("/me/external-identities", PERSONAL, add)
        .delete("/me/external-identities/{id}", PERSONAL, remove)
}

/// The logins the current person has in other tools, oldest first.
#[utoipa::path(
    get,
    path = "/api/me/external-identities",
    tag = "external-identities",
    responses(
        (status = 200, description = "The caller's identities, oldest first", body = [ExternalIdentityView]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no identities"),
    )
)]
async fn list(
    auth: Auth,
    State(state): State<AppState>,
) -> Result<Json<Vec<ExternalIdentityView>>, AppError> {
    let rows = service::list(&state.db, &auth.require_user()?.id).await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// Adds a login by hand.
#[utoipa::path(
    post,
    path = "/api/me/external-identities",
    tag = "external-identities",
    request_body = AddExternalIdentityDto,
    responses(
        (status = 201, description = "The new identity", body = ExternalIdentityView),
        (status = 400, description = "Invalid body, an unusable login or host, a provider that needs a host, or the list is full"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no identities"),
        (status = 409, description = "The login is already linked to an account"),
    )
)]
async fn add(
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<AddExternalIdentityDto>,
) -> Result<(StatusCode, Json<ExternalIdentityView>), AppError> {
    let input = dto.validate()?;
    let row = service::add(&state.db, &auth.require_user()?.id, &input).await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// Removes one of the caller's identities.
#[utoipa::path(
    delete,
    path = "/api/me/external-identities/{id}",
    tag = "external-identities",
    params(("id" = String, Path, description = "Identity id")),
    responses(
        (status = 204, description = "Removed"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no identities"),
        (status = 404, description = "No such identity, or it is someone else's"),
    )
)]
async fn remove(
    auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::remove(&state.db, &auth.require_user()?.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
