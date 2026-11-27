//! App-to-provider half of two-way routing rules (`two-way-sync.service.ts`).
//!
//! When a person (or an agent) closes or reopens a task that a rule created from an external
//! issue, the issue is closed or reopened on the host through the rule's connection. The other
//! direction (the host closing the issue) is [`crate::inbound::route_issue`]. Changes made by the
//! system itself never go back out, so the two directions cannot echo each other.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Notify, watch};
use trama_contracts::common::GitProvider;
use trama_contracts::js;
use trama_contracts::status::{StatusEntry, load_status_catalog, status_type_of};
use trama_core::config::js_number;
use trama_core::{AppError, AppState};
use trama_entities::{domain_events, integration_connections, routing_rule_items, routing_rules};
use trama_events::Events;
use trama_integrations::providers::ProviderError;
use trama_integrations::{candidates::StateReason, service};

/// Longest `lastError` a rule keeps (`message.slice(0, 500)`).
const LAST_ERROR_MAX: usize = 500;

/// Result of considering one recorded issue status change (`TwoWayOutcome`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The external issue was updated.
    Synced {
        /// External issue state written.
        state: &'static str,
    },
    /// No outbound change was required or the event was ineligible.
    Skipped(&'static str),
    /// The change could not be delivered; the reason is also on the rule.
    Failed(String),
}

/// The listener of recorded `issue.status_changed` events (`TwoWaySyncService`).
///
/// Changes of one task run in order, so a quick close and reopen ends in the state the person
/// left; changes of different tasks run side by side. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Outbound {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    /// Task id -> changes waiting behind the one being sent. A key exists while its worker runs.
    chains: Mutex<HashMap<String, VecDeque<domain_events::Model>>>,
    /// Woken when a worker has sent everything queued for its task.
    idle: Notify,
    /// The last recorded event taken off the bus.
    last_seen: watch::Sender<Option<String>>,
}

impl Default for Outbound {
    fn default() -> Self {
        Self::new()
    }
}

impl Outbound {
    /// A listener with nothing queued.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                chains: Mutex::new(HashMap::new()),
                idle: Notify::new(),
                last_seen: watch::channel(None).0,
            }),
        }
    }

    /// Starts listening to the events recorded by this server instance (`onModuleInit`). The
    /// subscription is taken before this returns, so no event recorded afterwards is missed.
    /// Abort the handle to stop (`onModuleDestroy`).
    #[must_use]
    pub fn spawn(&self, state: &AppState) -> tokio::task::JoinHandle<()> {
        let mut events = Events::of(state).subscribe_recorded();
        let this = self.clone();
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let id = event.id.clone();
                        if event.r#type == "issue.status_changed"
                            && event.actor.get("type").and_then(serde_json::Value::as_str)
                                != Some("system")
                        {
                            this.enqueue(&state, event);
                        }
                        this.inner.last_seen.send_replace(Some(id));
                    }
                    Err(RecvError::Lagged(count)) => {
                        tracing::warn!(
                            "two-way sync fell behind and skipped {count} recorded events"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        })
    }

    /// Resolves when every change queued so far has been sent (`idle`, for tests).
    pub async fn idle(&self) {
        loop {
            let woken = self.inner.idle.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if self.chains().is_empty() {
                return;
            }
            woken.await;
        }
    }

    /// Resolves once the listener has taken the recorded event `event_id` off the bus and queued
    /// it if it qualifies (for tests; follow with [`Outbound::idle`]).
    pub async fn caught_up(&self, event_id: &str) {
        let mut seen = self.inner.last_seen.subscribe();
        let _ = seen.wait_for(|last| last.as_deref() == Some(event_id)).await;
    }

    fn chains(&self) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<domain_events::Model>>> {
        self.inner.chains.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn enqueue(&self, state: &AppState, event: domain_events::Model) {
        let key = subject_id(&event).to_owned();
        {
            let mut chains = self.chains();
            if let Some(queue) = chains.get_mut(&key) {
                queue.push_back(event);
                return;
            }
            chains.insert(key.clone(), VecDeque::new());
        }
        let this = self.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let mut next = Some(event);
            while let Some(event) = next {
                if let Err(error) = apply(&state, &event).await {
                    tracing::warn!("two-way sync failed: {error}");
                }
                let mut chains = this.chains();
                next = chains.get_mut(&key).and_then(VecDeque::pop_front);
                if next.is_none() {
                    chains.remove(&key);
                }
            }
            this.inner.idle.notify_waiters();
        });
    }
}

/// Starts outbound sync for the events recorded by this server instance.
#[must_use]
pub fn spawn(state: &AppState) -> tokio::task::JoinHandle<()> {
    Outbound::new().spawn(state)
}

fn subject_id(event: &domain_events::Model) -> &str {
    event.subject.get("id").and_then(serde_json::Value::as_str).unwrap_or_default()
}

/// Applies one app-originated status change. Provider writes go through the protected integration
/// HTTP client and the saved connection of the rule; this function never accepts a caller-supplied
/// URL.
///
/// A failed write is recorded on the rule (`lastError`) and returned as [`Outcome::Failed`]; the
/// task keeps its status.
///
/// # Errors
///
/// Database errors while looking up the item, the rule or the connection.
pub async fn apply(state: &AppState, event: &domain_events::Model) -> Result<Outcome, AppError> {
    let issue_id = subject_id(event);
    let from = event.data.get("from").and_then(serde_json::Value::as_str).unwrap_or_default();
    let to = event.data.get("to").and_then(serde_json::Value::as_str).unwrap_or_default();
    let item = routing_rule_items::Entity::find()
        .filter(routing_rule_items::Column::IssueId.eq(issue_id))
        .filter(routing_rule_items::Column::Kind.eq("issue"))
        .filter(routing_rule_items::Column::WorkspaceId.eq(&event.workspace_id))
        .one(&state.db)
        .await?;
    let Some(item) = item else { return Ok(Outcome::Skipped("not routed by a rule")) };
    let Some(rule_id) = item.rule_id.clone().filter(|id| !id.is_empty()) else {
        return Ok(Outcome::Skipped("not routed by a rule"));
    };
    let rule = routing_rules::Entity::find_by_id(&rule_id).one(&state.db).await?;
    let Some(rule) = rule.filter(|rule| rule.direction == "two_way") else {
        return Ok(Outcome::Skipped("the rule is inbound only"));
    };

    let catalog = load_status_catalog(&state.db, &event.workspace_id).await.issue;
    if finished(&catalog, from) == finished(&catalog, to) {
        return Ok(Outcome::Skipped("open or closed did not change"));
    }
    let closing = finished(&catalog, to);
    let next = if closing { "closed" } else { "open" };
    if item.external_state.as_deref() == Some(next) {
        return Ok(Outcome::Skipped("the issue is already there"));
    }

    let connection = match rule.connection_id.as_deref() {
        Some(id) => integration_connections::Entity::find_by_id(id).one(&state.db).await?,
        None => None,
    };
    // `connectionView` is null for a connection that is not a git host; only `connected` works
    let usable = connection.and_then(|row| {
        let provider = GitProvider::parse(&row.provider)?;
        (row.status == "connected").then_some((row, provider))
    });
    let Some((connection, provider)) = usable else {
        let reason = format!(
            "The connection is not working, so {}{} was not {}.",
            item.repository,
            item.external_id,
            if closing { "closed" } else { "reopened" }
        );
        record_error(state, &rule.id, &reason).await?;
        return Ok(Outcome::Failed(reason));
    };

    let label = connection_label(provider, &connection);
    let canceled = status_type_of(&catalog, Some(to)) == Some("canceled");
    let sent =
        send(state, &item, &connection, &label, closing, canceled).await.map_err(
            |error| match error {
                Failure::Provider(message) => format!("{label} refused the change ({message})"),
                Failure::Other(message) => message,
            },
        );
    let outcome = match sent {
        Ok(()) => finish(state, &item.id, &rule.id, next).await.map(|()| next),
        Err(reason) => Err(reason),
    };
    match outcome {
        Ok(next) => Ok(Outcome::Synced { state: next }),
        Err(reason) => {
            record_error(
                state,
                &rule.id,
                &format!(
                    "Could not {} {}{}: {reason}",
                    if closing { "close" } else { "reopen" },
                    item.repository,
                    item.external_id
                ),
            )
            .await?;
            Ok(Outcome::Failed(reason))
        }
    }
}

/// Why a provider write did not happen.
enum Failure {
    /// The provider answered with an error status (`ProviderHttpError`).
    Provider(String),
    /// Anything else: the request did not complete, or the client could not be built.
    Other(String),
}

/// Builds the client of the connection and closes or reopens the external issue.
async fn send(
    state: &AppState,
    item: &routing_rule_items::Model,
    connection: &integration_connections::Model,
    label: &str,
    closing: bool,
    canceled: bool,
) -> Result<(), Failure> {
    let client = service::connection_client(state, connection)
        .map_err(|error| Failure::Other(message_of(&error)))?;
    if !client.can_set_issue_state() {
        return Err(Failure::Other(format!("{label} cannot close issues")));
    }
    // `Number(externalId.slice(1))`, which must be an integer
    let number = js_number(&item.external_id.chars().skip(1).collect::<String>())
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0);
    let Some(number) = number else {
        return Err(Failure::Other(format!("Not an issue number: {}", item.external_id)));
    };
    let reason = if canceled { StateReason::NotPlanned } else { StateReason::Completed };
    #[allow(clippy::cast_possible_truncation)]
    client.set_issue_state(&item.repository, number as i64, !closing, Some(reason)).await.map_err(
        |error| match error {
            ProviderError::Status(error) => Failure::Provider(error.message),
            ProviderError::Unreachable(message) => Failure::Other(message),
        },
    )
}

/// The write went through: remember the state the host is in, and clear the rule's error.
async fn finish(state: &AppState, item_id: &str, rule_id: &str, next: &str) -> Result<(), String> {
    routing_rule_items::Entity::update_many()
        .col_expr(routing_rule_items::Column::ExternalState, Expr::value(next))
        .filter(routing_rule_items::Column::Id.eq(item_id))
        .exec(&state.db)
        .await
        .map_err(|error| error.to_string())?;
    record_success(state, rule_id).await.map_err(|error| error.to_string())
}

/// `RoutingRulesService.recordSuccess`.
async fn record_success(state: &AppState, rule_id: &str) -> Result<(), sea_orm::DbErr> {
    routing_rules::Entity::update_many()
        .col_expr(routing_rules::Column::LastSyncAt, Expr::value(chrono::Utc::now().fixed_offset()))
        .col_expr(routing_rules::Column::LastError, Expr::value(Option::<String>::None))
        .filter(routing_rules::Column::Id.eq(rule_id))
        .exec(&state.db)
        .await
        .map(|_| ())
}

/// `RoutingRulesService.recordError`.
async fn record_error(state: &AppState, rule_id: &str, message: &str) -> Result<(), AppError> {
    routing_rules::Entity::update_many()
        .col_expr(
            routing_rules::Column::LastError,
            Expr::value(js::truncate(message, LAST_ERROR_MAX)),
        )
        .filter(routing_rules::Column::Id.eq(rule_id))
        .exec(&state.db)
        .await?;
    Ok(())
}

/// `connectionView(row).label`: the saved label, else `<Provider> · <account>`.
fn connection_label(provider: GitProvider, row: &integration_connections::Model) -> String {
    if row.label.is_empty() {
        format!("{} · {}", provider.meta().label, row.account)
    } else {
        row.label.clone()
    }
}

/// What a caller sees as the message of an error (`e.message`), without the status prefix.
fn message_of(error: &AppError) -> String {
    let text = error.to_string();
    let prefix = format!("{}: ", error.status_code());
    text.strip_prefix(&prefix).map_or(text.clone(), str::to_owned)
}

/// Is the status a closed one (`done` or `canceled`) in the workspace's catalog?
fn finished(entries: &[StatusEntry], status: &str) -> bool {
    matches!(status_type_of(entries, Some(status)), Some("done" | "canceled"))
}

#[cfg(test)]
mod tests {
    use trama_contracts::status::{StatusEntry, default_status_catalog};

    use super::{finished, message_of};

    fn custom(id: &str, kind: &str) -> StatusEntry {
        StatusEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            icon: "circle".to_owned(),
            color: "#123456".to_owned(),
            kind: kind.to_owned(),
        }
    }

    #[test]
    fn status_sync_uses_semantic_catalog_types_and_ignores_same_open_closed_class() {
        let mut entries = default_status_catalog().issue;
        entries.push(custom("st_shipped", "done"));
        entries.push(custom("st_wont_do", "canceled"));
        entries.push(custom("st_review", "in_progress"));
        assert!(finished(&entries, "st_shipped"));
        assert!(finished(&entries, "st_wont_do"));
        assert!(!finished(&entries, "st_review"));
        assert!(!finished(&entries, "unknown"));
        assert_eq!(finished(&entries, "st_shipped"), finished(&entries, "st_wont_do"));
    }

    #[test]
    fn status_sync_filters_transitions_that_do_not_change_open_vs_closed() {
        let entries = default_status_catalog().issue;
        assert_eq!(finished(&entries, "todo"), finished(&entries, "in_progress"));
        assert_ne!(finished(&entries, "todo"), finished(&entries, "done"));
    }

    #[test]
    fn an_error_message_loses_its_status_prefix() {
        let error =
            trama_core::AppError::bad_request("Delta connections have no repository API yet");
        assert_eq!(message_of(&error), "Delta connections have no repository API yet");
    }
}
