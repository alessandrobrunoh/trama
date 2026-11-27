//! App-to-provider half of two-way routing rules.
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, Set};
use tokio::sync::broadcast::error::RecvError;
use trama_contracts::common::GitProvider;
use trama_contracts::status::{load_status_catalog, status_type_of};
use trama_core::{AppError, AppState};
use trama_entities::{domain_events, integration_connections, routing_rule_items, routing_rules};
use trama_events::Events;
use trama_integrations::{candidates::StateReason, service};

/// Result of considering one recorded issue status change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The external issue was updated.
    Synced {
        /// External issue state written.
        state: &'static str,
    },
    /// No outbound change was required or the event was ineligible.
    Skipped(&'static str),
    /// The change could not be delivered.
    Failed(String),
}

/// Starts outbound sync for the events recorded by this server instance.
pub fn spawn(state: &AppState) -> tokio::task::JoinHandle<()> {
    let mut events = Events::of(state).subscribe_recorded();
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.r#type != "issue.status_changed"
                        || event.actor.get("type").and_then(serde_json::Value::as_str)
                            == Some("system")
                    {
                        continue;
                    }
                    if let Err(error) = apply(&state, &event).await {
                        tracing::warn!("two-way tracker sync failed: {error}");
                    }
                }
                Err(RecvError::Lagged(count)) => {
                    tracing::warn!("Two-way tracker sync fell behind and skipped {count} events");
                }
                Err(RecvError::Closed) => break,
            }
        }
    })
}

/// Applies one app-originated status change. Provider writes go through the protected integration
/// HTTP client and the saved workspace connection; this function never accepts a caller-supplied URL.
pub async fn apply(state: &AppState, event: &domain_events::Model) -> Result<Outcome, AppError> {
    let issue_id = event.subject.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
    let from = event.data.get("from").and_then(serde_json::Value::as_str).unwrap_or_default();
    let to = event.data.get("to").and_then(serde_json::Value::as_str).unwrap_or_default();
    let item = routing_rule_items::Entity::find()
        .filter(routing_rule_items::Column::IssueId.eq(issue_id))
        .filter(routing_rule_items::Column::WorkspaceId.eq(&event.workspace_id))
        .filter(routing_rule_items::Column::Kind.eq("issue"))
        .one(&state.db)
        .await?;
    let Some(item) = item.filter(|item| item.rule_id.is_some()) else {
        return Ok(Outcome::Skipped("not routed by a rule"));
    };
    let rule_id = item.rule_id.as_deref().unwrap_or_default();
    let Some(rule) = routing_rules::Entity::find_by_id(rule_id).one(&state.db).await? else {
        return Ok(Outcome::Skipped("rule no longer exists"));
    };
    if rule.direction != "two_way" {
        return Ok(Outcome::Skipped("the rule is inbound only"));
    }
    let catalog = load_status_catalog(&state.db, &event.workspace_id).await;
    let was_finished = finished(&catalog.issue, from);
    let finished = finished(&catalog.issue, to);
    if was_finished == finished {
        return Ok(Outcome::Skipped("open or closed did not change"));
    }
    let next = if finished { "closed" } else { "open" };
    if item.external_state.as_deref() == Some(next) {
        return Ok(Outcome::Skipped("the issue is already there"));
    }
    let Some(connection_id) = rule.connection_id.as_deref() else {
        return fail(
            state,
            rule,
            format!(
                "The connection is not working, so {}{} was not {next}.",
                item.repository, item.external_id
            ),
        )
        .await;
    };
    let connection =
        integration_connections::Entity::find_by_id(connection_id).one(&state.db).await?;
    let Some(connection) = connection.filter(|c| {
        c.workspace_id.as_deref() == Some(event.workspace_id.as_str())
            && c.owner_type == "workspace"
            && c.status == "connected"
    }) else {
        return fail(
            state,
            rule,
            format!(
                "The connection is not working, so {}{} was not {next}.",
                item.repository, item.external_id
            ),
        )
        .await;
    };
    let number = item.external_id.strip_prefix('#').and_then(|n| n.parse::<i64>().ok());
    let Some(number) = number else {
        return fail(state, rule, format!("Not an issue number: {}", item.external_id)).await;
    };
    let provider = GitProvider::parse(&connection.provider)
        .ok_or_else(|| AppError::internal("Routing connection has an unknown provider"))?;
    let client = service::connection_client(state, &connection)?;
    if !client.can_set_issue_state() {
        return fail(state, rule, format!("{} cannot close issues", connection.label)).await;
    }
    let reason = (status_type_of(&catalog.issue, Some(to)) == Some("canceled"))
        .then_some(StateReason::NotPlanned);
    if let Err(error) = client.set_issue_state(&item.repository, number, !finished, reason).await {
        return fail(
            state,
            rule,
            format!(
                "Could not {} {}{}: {} refused the change ({error})",
                if finished { "close" } else { "reopen" },
                item.repository,
                item.external_id,
                provider.meta().label
            ),
        )
        .await;
    }
    let mut updated = item.into_active_model();
    updated.external_state = Set(Some(next.to_owned()));
    updated.update(&state.db).await?;
    let mut updated_rule = rule.into_active_model();
    updated_rule.last_sync_at = Set(Some(chrono::Utc::now().fixed_offset()));
    updated_rule.last_error = Set(None);
    updated_rule.update(&state.db).await?;
    Ok(Outcome::Synced { state: next })
}

fn finished(entries: &[trama_contracts::status::StatusEntry], status: &str) -> bool {
    matches!(status_type_of(entries, Some(status)), Some("done" | "canceled"))
}

async fn fail(
    state: &AppState,
    rule: routing_rules::Model,
    reason: String,
) -> Result<Outcome, AppError> {
    let mut updated = rule.into_active_model();
    updated.last_error = Set(Some(reason.clone().chars().take(500).collect()));
    updated.update(&state.db).await?;
    Ok(Outcome::Failed(reason))
}

#[cfg(test)]
mod tests {
    use trama_contracts::status::{StatusEntry, default_status_catalog};

    use super::finished;

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
}
