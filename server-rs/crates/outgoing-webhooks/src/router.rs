//! `OutgoingWebhooksController` (`outgoing-webhooks.controller.ts`), mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::integrations::{OutgoingWebhook, WebhookDeliveryLog};
use trama_contracts::roles::Capability;
use trama_core::{ApiJson, AppError, AppState};
use trama_events::{Events, LiveChange};
use utoipa::OpenApi;

use crate::schemas::{CreateWebhookBody, DeliveriesQuery, UpdateWebhookBody, WebhookWithSecret};
use crate::service::{self, MAX_WEBHOOKS_PER_WORKSPACE};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, create, get, update, remove, rotate, test, deliveries),
    components(schemas(
        CreateWebhookBody,
        OutgoingWebhook,
        UpdateWebhookBody,
        WebhookDeliveryLog,
        WebhookWithSecret,
    ))
)]
pub struct ApiDoc;

/// `@Can('manageIntegrations')` on the controller.
const MANAGE: Gate = Gate::authenticated().can(Capability::ManageIntegrations);

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/outgoing-webhooks", MANAGE, list)
        .post("/w/{slug}/outgoing-webhooks", MANAGE, create)
        .get("/w/{slug}/outgoing-webhooks/{id}", MANAGE, get)
        .patch("/w/{slug}/outgoing-webhooks/{id}", MANAGE, update)
        .delete("/w/{slug}/outgoing-webhooks/{id}", MANAGE, remove)
        .post("/w/{slug}/outgoing-webhooks/{id}/rotate-secret", MANAGE, rotate)
        .post("/w/{slug}/outgoing-webhooks/{id}/test", MANAGE, test)
        .get("/w/{slug}/outgoing-webhooks/{id}/deliveries", MANAGE, deliveries)
}

/// The workspace's outgoing webhooks, oldest first. The signing secret is never part of them.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/outgoing-webhooks",
    tag = "outgoing-webhooks",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "The webhooks", body = [OutgoingWebhook]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<OutgoingWebhook>>, AppError> {
    Ok(Json(service::list(&state, &ctx.workspace.id).await?))
}

/// Creates a webhook. The signing secret is returned once.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/outgoing-webhooks",
    tag = "outgoing-webhooks",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateWebhookBody,
    responses(
        (status = 201, description = "The webhook and its signing secret", body = WebhookWithSecret),
        (status = 400, description = "Invalid body, or a URL that is not a public http(s) address"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 409, description = "The workspace already has 20 outgoing webhooks"),
    )
)]
async fn create(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateWebhookBody>,
) -> Result<(StatusCode, Json<WebhookWithSecret>), AppError> {
    let input = body.validate()?;
    service::assert_url(&state, &input.url).await?;
    if service::count(&state, &ctx.workspace.id).await? >= MAX_WEBHOOKS_PER_WORKSPACE {
        return Err(AppError::conflict(format!(
            "A workspace can have at most {MAX_WEBHOOKS_PER_WORKSPACE} outgoing webhooks"
        )));
    }
    let res = service::create(&state, &ctx.workspace.id, input).await?;
    Events::of(&state)
        .publish(&ctx.workspace.id, LiveChange::created(LiveEventEntity::Webhook, &res.webhook.id));
    Ok((StatusCode::CREATED, Json(res)))
}

/// One webhook.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/outgoing-webhooks/{id}",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
    ),
    responses(
        (status = 200, description = "The webhook", body = OutgoingWebhook),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn get(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<OutgoingWebhook>, AppError> {
    Ok(Json(service::get(&state, &ctx.workspace.id, &id).await?))
}

/// Renames a webhook, changes its URL or events, or pauses and resumes it.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/outgoing-webhooks/{id}",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
    ),
    request_body = UpdateWebhookBody,
    responses(
        (status = 200, description = "The webhook after the change", body = OutgoingWebhook),
        (status = 400, description = "Invalid body, or a URL that is not a public http(s) address"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn update(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateWebhookBody>,
) -> Result<Json<OutgoingWebhook>, AppError> {
    let patch = body.validate()?;
    if let Some(url) = &patch.url {
        service::assert_url(&state, url).await?;
    }
    let row = service::update(&state, &ctx.workspace.id, &id, patch).await?;
    Events::of(&state)
        .publish(&ctx.workspace.id, LiveChange::updated(LiveEventEntity::Webhook, &id));
    Ok(Json(row))
}

/// Deletes a webhook and its delivery log.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/outgoing-webhooks/{id}",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &id).await?;
    Events::of(&state)
        .publish(&ctx.workspace.id, LiveChange::deleted(LiveEventEntity::Webhook, &id));
    Ok(StatusCode::NO_CONTENT)
}

/// A new signing secret, returned once; the old one stops working immediately.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/outgoing-webhooks/{id}/rotate-secret",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
    ),
    responses(
        (status = 200, description = "The webhook and its new signing secret", body = WebhookWithSecret),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn rotate(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<WebhookWithSecret>, AppError> {
    Ok(Json(service::rotate_secret(&state, &ctx.workspace.id, &id).await?))
}

/// Sends a `ping` event now (even when the webhook is disabled) and answers with the delivery
/// result: status, duration and error. A test is never retried.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/outgoing-webhooks/{id}/test",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
    ),
    responses(
        (status = 200, description = "The delivery, whether or not the receiver accepted it", body = WebhookDeliveryLog),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn test(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<WebhookDeliveryLog>, AppError> {
    Ok(Json(service::ping(&state, &ctx.workspace.id, &id).await?))
}

/// The newest delivery attempts of a webhook, newest first.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/outgoing-webhooks/{id}/deliveries",
    tag = "outgoing-webhooks",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Webhook id"),
        ("limit" = Option<u32>, Query, description = "How many, 1 to 50 (default 20)"),
    ),
    responses(
        (status = 200, description = "The attempts", body = [WebhookDeliveryLog]),
        (status = 400, description = "Invalid limit"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs the integrations permission"),
        (status = 404, description = "No such webhook in this workspace"),
    )
)]
async fn deliveries(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<WebhookDeliveryLog>>, AppError> {
    let query = DeliveriesQuery::parse(raw.as_deref())?;
    Ok(Json(service::recent_deliveries(&state, &ctx.workspace.id, &id, query.limit).await?))
}
