//! `IntegrationsController` and `MyConnectionsController` (`integrations.controller.ts`),
//! mounted under `/api`.

use axum::Json;
use axum::extract::{FromRequestParts, Path, RawQuery, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use trama_auth::{Actor, Auth, Ctx, Gate, Routes};
use trama_common::proxy::public_base_url;
use trama_contracts::roles::Capability;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::providers::{RemoteRepository, RemoteRepositoryPage};
use crate::schemas::{
    ConnectionCreated, CreateConnectionBody, PresentedConnection, RemoteReposQuery,
    UpdateConnectionBody, WebhookRotated, WebhookSetup,
};
use crate::service::{self, ConnectionScope};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(
        list, get, create, update, revoke, remove, rotate, remote, my_list, my_get, my_create,
        my_update, my_revoke, my_remove, my_rotate, my_remote,
    ),
    components(schemas(
        ConnectionCreated,
        CreateConnectionBody,
        PresentedConnection,
        RemoteRepository,
        RemoteRepositoryPage,
        UpdateConnectionBody,
        WebhookRotated,
        WebhookSetup,
    ))
)]
pub struct ApiDoc;

/// `@Can('manageIntegrations')` on `IntegrationsController`.
const MANAGE: Gate = Gate::authenticated().can(Capability::ManageIntegrations);

/// `@RequireUser() @SessionOnly()` on `MyConnectionsController`: an API token belongs to one
/// workspace, a personal connection to a person.
const PERSONAL: Gate = Gate::authenticated().require_user().session_only();

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/integrations", MANAGE, list)
        .get("/w/{slug}/integrations/{id}", MANAGE, get)
        .post("/w/{slug}/integrations", MANAGE, create)
        .patch("/w/{slug}/integrations/{id}", MANAGE, update)
        .post("/w/{slug}/integrations/{id}/revoke", MANAGE, revoke)
        .delete("/w/{slug}/integrations/{id}", MANAGE, remove)
        .post("/w/{slug}/integrations/{id}/rotate-webhook-secret", MANAGE, rotate)
        .get("/w/{slug}/integrations/{id}/remote-repositories", MANAGE, remote)
        .get("/me/connections", PERSONAL, my_list)
        .get("/me/connections/{id}", PERSONAL, my_get)
        .post("/me/connections", PERSONAL, my_create)
        .patch("/me/connections/{id}", PERSONAL, my_update)
        .post("/me/connections/{id}/revoke", PERSONAL, my_revoke)
        .delete("/me/connections/{id}", PERSONAL, my_remove)
        .post("/me/connections/{id}/rotate-webhook-secret", PERSONAL, my_rotate)
        .get("/me/connections/{id}/remote-repositories", PERSONAL, my_remote)
}

/// `IntegrationsService.publicUrl(req)`: `PUBLIC_URL`, else derived from the request.
struct Origin(String);

impl FromRequestParts<AppState> for Origin {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> {
        std::future::ready(Ok(Self(public_base_url(&state.config, Some(parts)))))
    }
}

fn workspace(ctx: &Ctx) -> ConnectionScope {
    ConnectionScope::workspace(&ctx.workspace.id)
}

fn person(auth: &Auth) -> Result<ConnectionScope, AppError> {
    Ok(ConnectionScope::user(&auth.require_user()?.id))
}

// ───────────────────────────── workspace connections ─────────────────────────────

/// The workspace's connections, oldest first. Personal connections never show up here.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/integrations",
    tag = "integrations",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "The workspace's connections", body = [PresentedConnection]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    Origin(origin): Origin,
    State(state): State<AppState>,
) -> Result<Json<Vec<PresentedConnection>>, AppError> {
    Ok(Json(service::list(&state, &workspace(&ctx), &origin).await?))
}

/// One connection of the workspace.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/integrations/{id}",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
    ),
    responses(
        (status = 200, description = "The connection", body = PresentedConnection),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
    )
)]
async fn get(
    ctx: Ctx,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<PresentedConnection>, AppError> {
    Ok(Json(service::get(&state, &workspace(&ctx), &id, &origin).await?))
}

/// Connects a git host or Delta for the workspace. The webhook secret is returned once.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/integrations",
    tag = "integrations",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateConnectionBody,
    responses(
        (status = 201, description = "The connection and its webhook setup", body = ConnectionCreated),
        (status = 400, description = "Invalid body or base URL, or a credential the provider rejects"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 409, description = "That account is already connected"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn create(
    ctx: Ctx,
    Actor(actor): Actor,
    Origin(origin): Origin,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateConnectionBody>,
) -> Result<(StatusCode, Json<ConnectionCreated>), AppError> {
    let input = body.validate()?;
    let out = service::create(&state, &workspace(&ctx), &actor, input, &origin).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// Renames a connection, and/or gives it a new token or base URL.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/integrations/{id}",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
    ),
    request_body = UpdateConnectionBody,
    responses(
        (status = 200, description = "The connection after the change", body = PresentedConnection),
        (status = 400, description = "Invalid body or base URL, or a credential the provider rejects"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn update(
    ctx: Ctx,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateConnectionBody>,
) -> Result<Json<PresentedConnection>, AppError> {
    let patch = body.validate()?;
    Ok(Json(service::update(&state, &workspace(&ctx), &id, patch, &origin).await?))
}

/// Withdraws the credential: status `revoked`, token wiped. A new token via PATCH reconnects it.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/integrations/{id}/revoke",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
    ),
    responses(
        (status = 200, description = "The revoked connection", body = PresentedConnection),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
    )
)]
async fn revoke(
    ctx: Ctx,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<PresentedConnection>, AppError> {
    Ok(Json(service::revoke(&state, &workspace(&ctx), &id, &origin).await?))
}

/// Deletes a connection.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/integrations/{id}",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &workspace(&ctx), &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replaces the webhook secret; the new one is returned once.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/integrations/{id}/rotate-webhook-secret",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
    ),
    responses(
        (status = 200, description = "The connection and its new webhook setup", body = WebhookRotated),
        (status = 400, description = "Delta connections have no webhook"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
    )
)]
async fn rotate(
    ctx: Ctx,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<WebhookRotated>, AppError> {
    Ok(Json(service::rotate_webhook_secret(&state, &workspace(&ctx), &id, &origin).await?))
}

/// One page of the repositories the connection can see.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/integrations/{id}/remote-repositories",
    tag = "integrations",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Connection id"),
        ("page" = Option<u32>, Query, description = "Page, from 1"),
        ("perPage" = Option<u32>, Query, description = "Page size, 1 to 100 (default 30)"),
    ),
    responses(
        (status = 200, description = "The page", body = RemoteRepositoryPage),
        (status = 400, description = "Invalid query, a revoked or Delta connection, or a rejected credential"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such connection in this workspace"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn remote(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<RemoteRepositoryPage>, AppError> {
    let q = RemoteReposQuery::parse(raw.as_deref())?;
    Ok(Json(service::remote_repositories(&state, &workspace(&ctx), &id, q.page, q.per_page).await?))
}

// ───────────────────────────── personal connections ─────────────────────────────

/// The signed-in person's own connections, the same in every workspace.
#[utoipa::path(
    get,
    path = "/api/me/connections",
    tag = "integrations",
    responses(
        (status = 200, description = "The caller's connections", body = [PresentedConnection]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
    )
)]
async fn my_list(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
) -> Result<Json<Vec<PresentedConnection>>, AppError> {
    Ok(Json(service::list(&state, &person(&auth)?, &origin).await?))
}

/// One of the caller's connections. Someone else's is a 404, never the row.
#[utoipa::path(
    get,
    path = "/api/me/connections/{id}",
    tag = "integrations",
    params(("id" = String, Path, description = "Connection id")),
    responses(
        (status = 200, description = "The connection", body = PresentedConnection),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
    )
)]
async fn my_get(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PresentedConnection>, AppError> {
    Ok(Json(service::get(&state, &person(&auth)?, &id, &origin).await?))
}

/// Connects a personal account. Its login becomes one of the caller's external identities.
#[utoipa::path(
    post,
    path = "/api/me/connections",
    tag = "integrations",
    request_body = CreateConnectionBody,
    responses(
        (status = 201, description = "The connection and its webhook setup", body = ConnectionCreated),
        (status = 400, description = "Invalid body or base URL, or a credential the provider rejects"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 409, description = "That account is already connected"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn my_create(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateConnectionBody>,
) -> Result<(StatusCode, Json<ConnectionCreated>), AppError> {
    let input = body.validate()?;
    let out = service::create(&state, &person(&auth)?, &auth.actor, input, &origin).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// Renames one of the caller's connections, and/or gives it a new token or base URL.
#[utoipa::path(
    patch,
    path = "/api/me/connections/{id}",
    tag = "integrations",
    params(("id" = String, Path, description = "Connection id")),
    request_body = UpdateConnectionBody,
    responses(
        (status = 200, description = "The connection after the change", body = PresentedConnection),
        (status = 400, description = "Invalid body or base URL, or a credential the provider rejects"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn my_update(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateConnectionBody>,
) -> Result<Json<PresentedConnection>, AppError> {
    let patch = body.validate()?;
    Ok(Json(service::update(&state, &person(&auth)?, &id, patch, &origin).await?))
}

/// Withdraws the credential of one of the caller's connections.
#[utoipa::path(
    post,
    path = "/api/me/connections/{id}/revoke",
    tag = "integrations",
    params(("id" = String, Path, description = "Connection id")),
    responses(
        (status = 200, description = "The revoked connection", body = PresentedConnection),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
    )
)]
async fn my_revoke(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PresentedConnection>, AppError> {
    Ok(Json(service::revoke(&state, &person(&auth)?, &id, &origin).await?))
}

/// Deletes one of the caller's connections.
#[utoipa::path(
    delete,
    path = "/api/me/connections/{id}",
    tag = "integrations",
    params(("id" = String, Path, description = "Connection id")),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
    )
)]
async fn my_remove(
    auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &person(&auth)?, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replaces the webhook secret of one of the caller's connections.
#[utoipa::path(
    post,
    path = "/api/me/connections/{id}/rotate-webhook-secret",
    tag = "integrations",
    params(("id" = String, Path, description = "Connection id")),
    responses(
        (status = 200, description = "The connection and its new webhook setup", body = WebhookRotated),
        (status = 400, description = "Delta connections have no webhook"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
    )
)]
async fn my_rotate(
    auth: Auth,
    Origin(origin): Origin,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<WebhookRotated>, AppError> {
    Ok(Json(service::rotate_webhook_secret(&state, &person(&auth)?, &id, &origin).await?))
}

/// One page of the repositories one of the caller's connections can see.
#[utoipa::path(
    get,
    path = "/api/me/connections/{id}/remote-repositories",
    tag = "integrations",
    params(
        ("id" = String, Path, description = "Connection id"),
        ("page" = Option<u32>, Query, description = "Page, from 1"),
        ("perPage" = Option<u32>, Query, description = "Page size, 1 to 100 (default 30)"),
    ),
    responses(
        (status = 200, description = "The page", body = RemoteRepositoryPage),
        (status = 400, description = "Invalid query, a revoked or Delta connection, or a rejected credential"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Browser sessions only"),
        (status = 404, description = "No such connection, or it is someone else's"),
        (status = 502, description = "The provider failed or is unreachable"),
    )
)]
async fn my_remote(
    auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<RemoteRepositoryPage>, AppError> {
    let q = RemoteReposQuery::parse(raw.as_deref())?;
    Ok(Json(service::remote_repositories(&state, &person(&auth)?, &id, q.page, q.per_page).await?))
}
