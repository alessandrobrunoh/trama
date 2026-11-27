//! Delivering events: the background half of `OutgoingWebhooksService` (`onModuleInit`,
//! `dispatch`, `enqueue`, `deliver`, `attempt`, `prune`, `idle`).
//!
//! [`spawn`] subscribes to [`Events::subscribe_recorded`] and hands each recorded event to the
//! [`Dispatcher`], which finds the enabled webhooks of its workspace that subscribe to it and
//! queues one delivery per webhook. The deliveries of one webhook run one after the other, so
//! receivers see events in order; different webhooks do not wait for each other.
//!
//! A delivery is one signed `POST` through [`Http`] (the SSRF-safe client). A network error,
//! timeout, 429 or 5xx is retried once after `TRAMA_WEBHOOK_RETRY_MS`; every attempt is stored
//! in `outgoing_webhook_deliveries`, which keeps the newest [`DELIVERY_LOG_KEEP`] per webhook.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::Method;
use chrono::{DateTime, Utc};
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    sea_query::Expr,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use trama_common::Secrets;
use trama_contracts::integrations::webhook_event_matches;
use trama_core::AppState;
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_entities::{domain_events, outgoing_webhook_deliveries, outgoing_webhooks};
use trama_events::Events;
use trama_integrations::{Http, HttpRequest};

use crate::signature::sign_body;

/// Deadline of one delivery request.
pub const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
/// Newest deliveries kept per webhook.
pub const DELIVERY_LOG_KEEP: u64 = 50;
/// Response bytes read; the body is only discarded, the status is what counts.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Queued deliveries per webhook; further events are dropped (with a warning).
pub const MAX_QUEUE: usize = 200;
/// How long a workspace's enabled webhooks are remembered.
const CACHE_TTL: Duration = Duration::from_secs(10);
/// Rows deleted per prune.
const PRUNE_BATCH: u64 = 100;

/// The JSON body of a delivery (`DeliveryPayload`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPayload {
    /// The domain event id (a fresh `ev_…` for a test ping); sent as `X-Trama-Delivery`.
    pub id: String,
    /// Event type, e.g. `issue.created`, or `ping`.
    pub event: String,
    /// Workspace id.
    pub workspace_id: String,
    /// When the event happened.
    pub at: String,
    /// Who did it.
    pub actor: Value,
    /// What it is about.
    pub subject: Value,
    /// The event's payload.
    pub data: Value,
}

impl DeliveryPayload {
    /// The payload of a recorded domain event.
    #[must_use]
    pub fn of_event(event: &domain_events::Model) -> Self {
        Self {
            id: event.id.clone(),
            event: event.r#type.clone(),
            workspace_id: event.workspace_id.clone(),
            at: to_iso(&event.at),
            actor: event.actor.clone(),
            subject: event.subject.clone(),
            data: event.data.clone(),
        }
    }
}

/// `aad` the signing secret of webhook `id` is encrypted with.
#[must_use]
pub fn secret_aad(id: &str) -> String {
    format!("{id}:outgoing")
}

/// The current time, truncated to milliseconds as a JavaScript `Date` is.
#[must_use]
pub fn now() -> DateTimeWithTimeZone {
    let at = Utc::now();
    DateTime::from_timestamp_millis(at.timestamp_millis()).unwrap_or(at).fixed_offset()
}

#[derive(Clone)]
struct Job {
    hook: Arc<outgoing_webhooks::Model>,
    payload: Arc<DeliveryPayload>,
}

/// The enabled webhooks of a workspace and when they were read.
type Remembered = (Instant, Arc<Vec<outgoing_webhooks::Model>>);

#[derive(Default)]
struct Inner {
    /// Enabled webhooks per workspace.
    cache: Mutex<HashMap<String, Remembered>>,
    /// Queued and running deliveries per webhook; the front one is running.
    chains: Mutex<HashMap<String, VecDeque<Job>>>,
    /// Events received and not yet turned into deliveries.
    dispatching: AtomicUsize,
}

/// The process-wide delivery queue: a cheap handle registered on the `AppState` by
/// [`crate::with_services`].
#[derive(Clone, Default)]
pub struct Dispatcher(Arc<Inner>);

impl std::fmt::Debug for Dispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Dispatcher(..)")
    }
}

impl Dispatcher {
    /// The dispatcher registered on `state`, else a new one (not shared: the management routes
    /// then cannot invalidate its cache).
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state.extension::<Self>().cloned().unwrap_or_default()
    }

    /// Forgets the remembered webhooks of a workspace after a change (`invalidate`); a no-op
    /// when no dispatcher is registered.
    pub fn invalidate(state: &AppState, workspace_id: &str) {
        if let Some(dispatcher) = state.extension::<Self>()
            && let Ok(mut cache) = dispatcher.0.cache.lock()
        {
            cache.remove(workspace_id);
        }
    }

    /// Waits for every received event to be queued and every queued delivery to finish (tests,
    /// graceful shutdown).
    pub async fn idle(&self) {
        loop {
            // let the listener task take the events that were just recorded
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            let busy = self.0.dispatching.load(Ordering::SeqCst) > 0
                || self.0.chains.lock().is_ok_and(|chains| !chains.is_empty());
            if !busy {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    /// The enabled webhooks of a workspace, remembered for ten seconds (`activeFor`).
    async fn active_for(
        &self,
        state: &AppState,
        workspace_id: &str,
    ) -> Result<Arc<Vec<outgoing_webhooks::Model>>, sea_orm::DbErr> {
        if let Ok(cache) = self.0.cache.lock()
            && let Some((at, rows)) = cache.get(workspace_id)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(Arc::clone(rows));
        }
        let rows = Arc::new(
            outgoing_webhooks::Entity::find()
                .filter(outgoing_webhooks::Column::WorkspaceId.eq(workspace_id))
                .filter(outgoing_webhooks::Column::Enabled.eq(true))
                .all(&state.db)
                .await?,
        );
        if let Ok(mut cache) = self.0.cache.lock() {
            cache.insert(workspace_id.to_owned(), (Instant::now(), Arc::clone(&rows)));
        }
        Ok(rows)
    }

    /// Queues a delivery of `event` to every enabled webhook that subscribes to it (`dispatch`).
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn dispatch(
        &self,
        state: &AppState,
        event: &domain_events::Model,
    ) -> Result<(), sea_orm::DbErr> {
        let hooks = self.active_for(state, &event.workspace_id).await?;
        let mut payload = None;
        for hook in hooks.iter() {
            let events = events_of(&hook.events);
            if !webhook_event_matches(&events, &event.r#type) {
                continue;
            }
            let payload =
                payload.get_or_insert_with(|| Arc::new(DeliveryPayload::of_event(event))).clone();
            self.enqueue(state, Job { hook: Arc::new(hook.clone()), payload });
        }
        Ok(())
    }

    fn enqueue(&self, state: &AppState, job: Job) {
        let id = job.hook.id.clone();
        let start = {
            let Ok(mut chains) = self.0.chains.lock() else { return };
            let queue = chains.entry(id.clone()).or_default();
            if queue.len() >= MAX_QUEUE {
                tracing::warn!("webhook {id}: delivery queue full, dropping {}", job.payload.event);
                return;
            }
            let start = queue.is_empty();
            queue.push_back(job);
            start
        };
        if start {
            tokio::spawn(self.clone().run_chain(state.clone(), id));
        }
    }

    /// Runs the queued deliveries of one webhook, oldest first, until none is left.
    async fn run_chain(self, state: AppState, id: String) {
        loop {
            let job = self
                .0
                .chains
                .lock()
                .ok()
                .and_then(|chains| chains.get(&id).and_then(|queue| queue.front().cloned()));
            let Some(job) = job else { return };
            deliver(&state, &job.hook, &job.payload, true).await;
            let Ok(mut chains) = self.0.chains.lock() else { return };
            let Some(queue) = chains.get_mut(&id) else { return };
            queue.pop_front();
            if queue.is_empty() {
                chains.remove(&id);
                return;
            }
        }
    }
}

/// `row.events` as a list of patterns.
fn events_of(value: &Value) -> Vec<String> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

/// Starts delivering the domain events this instance records. The task ends when the events
/// service is dropped; abort the handle to stop it earlier.
///
/// Must be called inside a Tokio runtime. The subscription is made before this returns, so no
/// event recorded afterwards is missed. Call [`crate::with_services`] first so the management
/// routes can invalidate the dispatcher's cache.
#[must_use]
pub fn spawn(state: &AppState) -> JoinHandle<()> {
    let dispatcher = Dispatcher::of(state);
    let mut recorded = Events::of(state).subscribe_recorded();
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            match recorded.recv().await {
                Ok(event) => {
                    // one event at a time: queuing is quick, and it keeps events in order
                    // (NestJS lets the lookups race)
                    dispatcher.0.dispatching.fetch_add(1, Ordering::SeqCst);
                    if let Err(e) = dispatcher.dispatch(&state, &event).await {
                        tracing::warn!("dispatch failed: {e}");
                    }
                    dispatcher.0.dispatching.fetch_sub(1, Ordering::SeqCst);
                }
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("Outgoing webhooks fell behind and skipped {missed} events");
                }
                Err(RecvError::Closed) => break,
            }
        }
    })
}

/// POSTs `payload` to the webhook once, then (when `retry`) once more after
/// `TRAMA_WEBHOOK_RETRY_MS` if it failed with a network error, 429 or 5xx. Returns the last
/// attempt as stored.
pub async fn deliver(
    state: &AppState,
    hook: &outgoing_webhooks::Model,
    payload: &DeliveryPayload,
    retry: bool,
) -> outgoing_webhook_deliveries::Model {
    let mut last = attempt(state, hook, payload, 1).await;
    if retry && !last.ok && (last.status == 0 || last.status == 429 || last.status >= 500) {
        tokio::time::sleep(Duration::from_millis(state.config.webhook_retry_ms)).await;
        last = attempt(state, hook, payload, 2).await;
    }
    last
}

async fn attempt(
    state: &AppState,
    hook: &outgoing_webhooks::Model,
    payload: &DeliveryPayload,
    attempt: i32,
) -> outgoing_webhook_deliveries::Model {
    let started = Instant::now();
    let (status, error) = match send(state, hook, payload).await {
        Ok(status) if (200..300).contains(&status) => (i32::from(status), None),
        Ok(status) => (i32::from(status), Some(format!("HTTP {status}"))),
        Err(message) => (0, Some(describe_error(&message))),
    };
    let log = outgoing_webhook_deliveries::Model {
        id: uid("wd"),
        webhook_id: hook.id.clone(),
        event: payload.event.clone(),
        status,
        ok: (200..300).contains(&status),
        duration_ms: i32::try_from(started.elapsed().as_millis()).unwrap_or(i32::MAX),
        error,
        attempt,
        at: now(),
    };
    if let Err(e) = record(state, hook, &log).await {
        // the webhook may have been deleted while the delivery was in flight
        tracing::debug!("delivery log not saved: {e}");
    }
    log
}

/// One signed request; the status, or why there was none.
async fn send(
    state: &AppState,
    hook: &outgoing_webhooks::Model,
    payload: &DeliveryPayload,
) -> Result<u16, String> {
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let secret = Secrets::of(state)
        .map_err(|e| e.to_string())?
        .decrypt(&hook.secret, &secret_aad(&hook.id))
        .map_err(|e| e.to_string())?;
    let signature = sign_body(&secret, &body);
    let request = HttpRequest::new(Method::POST, hook.url.clone())
        .raw(body)
        .timeout(DELIVERY_TIMEOUT)
        .max_bytes(MAX_RESPONSE_BYTES)
        .truncate()
        .header("User-Agent", "Trama-Webhooks/1")
        .header("X-Trama-Event", payload.event.clone())
        .header("X-Trama-Delivery", payload.id.clone())
        .header("X-Trama-Signature", signature.clone())
        // Pre-rename headers, still sent so existing receivers keep verifying deliveries.
        .header("X-Nabla-Event", payload.event.clone())
        .header("X-Nabla-Delivery", payload.id.clone())
        .header("X-Nabla-Signature", signature);
    Http::of(state).request(request).await.map(|res| res.status).map_err(|e| e.0)
}

/// `describeError`: a short reason for the log.
fn describe_error(message: &str) -> String {
    if message.starts_with("Timed out after") {
        return format!("Timed out after {}s", DELIVERY_TIMEOUT.as_secs());
    }
    if message.is_empty() {
        return "Request failed".to_owned();
    }
    message.chars().take(300).collect()
}

/// Stores the attempt, marks the webhook's last delivery and prunes the log.
async fn record(
    state: &AppState,
    hook: &outgoing_webhooks::Model,
    log: &outgoing_webhook_deliveries::Model,
) -> Result<(), sea_orm::DbErr> {
    outgoing_webhook_deliveries::ActiveModel {
        id: Set(log.id.clone()),
        webhook_id: Set(log.webhook_id.clone()),
        event: Set(log.event.clone()),
        status: Set(log.status),
        ok: Set(log.ok),
        duration_ms: Set(log.duration_ms),
        error: Set(log.error.clone()),
        attempt: Set(log.attempt),
        at: Set(log.at),
    }
    .insert(&state.db)
    .await?;
    outgoing_webhooks::Entity::update_many()
        .col_expr(outgoing_webhooks::Column::LastDeliveryAt, Expr::value(log.at))
        .col_expr(outgoing_webhooks::Column::LastStatus, Expr::value(log.status))
        .filter(outgoing_webhooks::Column::Id.eq(hook.id.as_str()))
        .exec(&state.db)
        .await?;
    if let Err(e) = prune(state, &hook.id).await {
        tracing::debug!("delivery log not pruned: {e}");
    }
    Ok(())
}

/// Deletes the deliveries of a webhook beyond the newest [`DELIVERY_LOG_KEEP`].
///
/// # Errors
///
/// Database errors.
pub async fn prune(state: &AppState, webhook_id: &str) -> Result<(), sea_orm::DbErr> {
    use outgoing_webhook_deliveries::{Column, Entity};
    let old: Vec<String> = Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::WebhookId.eq(webhook_id))
        .order_by_desc(Column::At)
        .order_by_desc(Column::Id)
        .offset(DELIVERY_LOG_KEEP)
        .limit(PRUNE_BATCH)
        .into_tuple()
        .all(&state.db)
        .await?;
    if !old.is_empty() {
        Entity::delete_many().filter(Column::Id.is_in(old)).exec(&state.db).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_failures_for_the_log() {
        assert_eq!(describe_error("Timed out after 5000 ms"), "Timed out after 5s");
        assert_eq!(describe_error(""), "Request failed");
        assert_eq!(describe_error("connect ECONNREFUSED"), "connect ECONNREFUSED");
        assert_eq!(describe_error(&"x".repeat(400)).len(), 300);
    }

    #[test]
    fn binds_the_secret_to_the_webhook() {
        assert_eq!(secret_aad("wh_1"), "wh_1:outgoing");
    }
}
