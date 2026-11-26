//! The management half of `OutgoingWebhooksService` (`list`, `get`, `create`, `update`,
//! `rotateSecret`, `remove`, `recentDeliveries`, `ping`) and the checks the controller makes
//! before calling it.
//!
//! Signing secrets are stored encrypted with [`trama_common::Secrets`] (`v2`, bound to
//! `<id>:outgoing`) and only ever returned by [`create`] and [`rotate_secret`].

use std::collections::HashSet;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use serde_json::{Value, json};
use trama_common::Secrets;
use trama_common::crypto::generate_webhook_secret;
use trama_common::safe_fetch::outbound_url_problem;
use trama_contracts::integrations::{OutgoingWebhook, WebhookDeliveryLog};
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{outgoing_webhook_deliveries, outgoing_webhooks};

use crate::delivery::{DELIVERY_LOG_KEEP, DeliveryPayload, Dispatcher, deliver, now, secret_aad};
use crate::schemas::{NewWebhook, WebhookPatch, WebhookWithSecret};

/// Most webhooks one workspace can have.
pub const MAX_WEBHOOKS_PER_WORKSPACE: u64 = 20;

/// A webhook as the API shows it: no secret.
#[must_use]
pub fn present(row: &outgoing_webhooks::Model) -> OutgoingWebhook {
    OutgoingWebhook {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        name: row.name.clone(),
        url: row.url.clone(),
        events: serde_json::from_value(row.events.clone()).unwrap_or_default(),
        enabled: row.enabled,
        created_at: to_iso(&row.created_at),
        last_delivery_at: row.last_delivery_at.as_ref().map(to_iso),
        last_status: row.last_status,
    }
}

/// A delivery as the API shows it (`toLog`).
#[must_use]
pub fn present_delivery(row: &outgoing_webhook_deliveries::Model) -> WebhookDeliveryLog {
    WebhookDeliveryLog {
        id: row.id.clone(),
        webhook_id: row.webhook_id.clone(),
        event: row.event.clone(),
        status: row.status,
        ok: row.ok,
        duration_ms: row.duration_ms,
        error: row.error.clone().filter(|e| !e.is_empty()),
        attempt: row.attempt,
        at: to_iso(&row.at),
    }
}

/// The URL check of the controller (`assertUrl`): a public `http(s)` address.
///
/// # Errors
///
/// 400 with the reason when the URL is not allowed.
pub async fn assert_url(state: &AppState, url: &str) -> Result<(), AppError> {
    match outbound_url_problem(url, &state.config.outbound).await {
        Some(problem) => Err(AppError::bad_request(problem)),
        None => Ok(()),
    }
}

/// How many webhooks the workspace has.
///
/// # Errors
///
/// Database errors.
pub async fn count(state: &AppState, workspace_id: &str) -> Result<u64, AppError> {
    Ok(outgoing_webhooks::Entity::find()
        .filter(outgoing_webhooks::Column::WorkspaceId.eq(workspace_id))
        .count(&state.db)
        .await?)
}

/// The workspace's webhooks, oldest first.
///
/// # Errors
///
/// Database errors.
pub async fn list(state: &AppState, workspace_id: &str) -> Result<Vec<OutgoingWebhook>, AppError> {
    let rows = outgoing_webhooks::Entity::find()
        .filter(outgoing_webhooks::Column::WorkspaceId.eq(workspace_id))
        .order_by_asc(outgoing_webhooks::Column::CreatedAt)
        .order_by_asc(outgoing_webhooks::Column::Id)
        .all(&state.db)
        .await?;
    Ok(rows.iter().map(present).collect())
}

/// The stored row of a webhook of the workspace.
///
/// # Errors
///
/// 404 `Webhook "<id>" not found` for another workspace's webhook too.
pub async fn get_row(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<outgoing_webhooks::Model, AppError> {
    outgoing_webhooks::Entity::find_by_id(id)
        .filter(outgoing_webhooks::Column::WorkspaceId.eq(workspace_id))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Webhook", id))
}

/// One webhook of the workspace.
///
/// # Errors
///
/// 404 when it does not exist in this workspace.
pub async fn get(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<OutgoingWebhook, AppError> {
    Ok(present(&get_row(state, workspace_id, id).await?))
}

/// `[...new Set(events)]`: duplicates removed, first occurrence kept.
fn unique(events: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    events.into_iter().filter(|e| seen.insert(e.clone())).collect()
}

/// Creates a webhook with a fresh signing secret.
///
/// # Errors
///
/// Database errors.
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    input: NewWebhook,
) -> Result<WebhookWithSecret, AppError> {
    let id = uid("wh");
    let secret = generate_webhook_secret();
    let encrypted = Secrets::of(state)?.encrypt(&secret, &secret_aad(&id));
    let row = outgoing_webhooks::ActiveModel {
        id: Set(id),
        workspace_id: Set(workspace_id.to_owned()),
        name: Set(input.name.trim().to_owned()),
        url: Set(input.url),
        secret: Set(encrypted),
        events: Set(json!(unique(input.events))),
        enabled: Set(input.enabled.unwrap_or(true)),
        created_at: Set(now()),
        last_delivery_at: Set(None),
        last_status: Set(None),
    }
    .insert(&state.db)
    .await?;
    Dispatcher::invalidate(state, workspace_id);
    Ok(WebhookWithSecret { webhook: present(&row), secret })
}

/// Changes a webhook.
///
/// # Errors
///
/// 404 when it does not exist in this workspace.
pub async fn update(
    state: &AppState,
    workspace_id: &str,
    id: &str,
    patch: WebhookPatch,
) -> Result<OutgoingWebhook, AppError> {
    let row = get_row(state, workspace_id, id).await?;
    let mut active = row.into_active_model();
    if let Some(name) = patch.name {
        active.name = Set(name.trim().to_owned());
    }
    if let Some(url) = patch.url {
        active.url = Set(url);
    }
    if let Some(events) = patch.events {
        active.events = Set(Value::from(unique(events)));
    }
    if let Some(enabled) = patch.enabled {
        active.enabled = Set(enabled);
    }
    let row = active.update(&state.db).await?;
    Dispatcher::invalidate(state, workspace_id);
    Ok(present(&row))
}

/// Gives a webhook a new signing secret; the old one stops working at once.
///
/// # Errors
///
/// 404 when it does not exist in this workspace.
pub async fn rotate_secret(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<WebhookWithSecret, AppError> {
    let row = get_row(state, workspace_id, id).await?;
    let secret = generate_webhook_secret();
    let mut active = row.into_active_model();
    active.secret = Set(Secrets::of(state)?.encrypt(&secret, &secret_aad(id)));
    let row = active.update(&state.db).await?;
    Dispatcher::invalidate(state, workspace_id);
    Ok(WebhookWithSecret { webhook: present(&row), secret })
}

/// Deletes a webhook and its delivery log.
///
/// # Errors
///
/// 404 when it does not exist in this workspace.
pub async fn remove(state: &AppState, workspace_id: &str, id: &str) -> Result<(), AppError> {
    get_row(state, workspace_id, id).await?;
    outgoing_webhooks::Entity::delete_by_id(id).exec(&state.db).await?;
    Dispatcher::invalidate(state, workspace_id);
    Ok(())
}

/// The newest deliveries of a webhook, newest first (`limit` is clamped to 1..=50).
///
/// # Errors
///
/// 404 when the webhook does not exist in this workspace.
pub async fn recent_deliveries(
    state: &AppState,
    workspace_id: &str,
    id: &str,
    limit: u64,
) -> Result<Vec<WebhookDeliveryLog>, AppError> {
    get_row(state, workspace_id, id).await?;
    let rows = outgoing_webhook_deliveries::Entity::find()
        .filter(outgoing_webhook_deliveries::Column::WebhookId.eq(id))
        .order_by_desc(outgoing_webhook_deliveries::Column::At)
        .order_by_desc(outgoing_webhook_deliveries::Column::Id)
        .limit(limit.clamp(1, DELIVERY_LOG_KEEP))
        .all(&state.db)
        .await?;
    Ok(rows.iter().map(present_delivery).collect())
}

/// Sends a `ping` event now (even when the webhook is disabled, never retried) and returns the
/// delivery result.
///
/// # Errors
///
/// 404 when the webhook does not exist in this workspace.
pub async fn ping(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<WebhookDeliveryLog, AppError> {
    let hook = get_row(state, workspace_id, id).await?;
    let payload = DeliveryPayload {
        id: uid("ev"),
        event: "ping".to_owned(),
        workspace_id: workspace_id.to_owned(),
        at: trama_core::time::now_iso(),
        actor: json!({ "type": "system" }),
        subject: json!({ "type": "webhook", "id": hook.id }),
        data: json!({ "message": format!("Test delivery for webhook \"{}\"", hook.name) }),
    };
    Ok(present_delivery(&deliver(state, &hook, &payload, false).await))
}
