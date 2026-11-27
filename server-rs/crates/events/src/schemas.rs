//! Request and response bodies of the events routes.

use serde::Serialize;
use serde_json::Value;
use trama_contracts::activity::DomainEvent;
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::time::to_iso;
use trama_core::validation::Checks;
use trama_entities::domain_events;
use utoipa::{IntoParams, ToSchema};

/// One row of `GET /api/w/:slug/events` (the `DomainEventEntity` JSON): a [`DomainEvent`],
/// with the stored JSON passed through as it is so retired subject types still round-trip.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = DomainEventRow)]
pub struct EventView {
    /// Event id.
    pub id: String,
    /// Workspace id.
    pub workspace_id: String,
    /// When it happened.
    pub at: String,
    /// Who did it.
    #[schema(value_type = trama_contracts::common::ActorRef)]
    pub actor: Value,
    /// Event type, e.g. `issue.status_changed`.
    #[serde(rename = "type")]
    pub kind: String,
    /// What it is about.
    #[schema(value_type = trama_contracts::common::LegacySubjectRef)]
    pub subject: Value,
    /// Provenance for events retained from a retired Workstream association.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_workstream_key: Option<String>,
    /// Event payload.
    #[schema(value_type = Object)]
    pub data: Value,
}

impl From<domain_events::Model> for EventView {
    fn from(row: domain_events::Model) -> Self {
        Self {
            at: to_iso(&row.at),
            id: row.id,
            workspace_id: row.workspace_id,
            actor: row.actor,
            kind: row.r#type,
            subject: row.subject,
            legacy_workstream_key: row.legacy_workstream_key,
            data: row.data,
        }
    }
}

impl EventView {
    /// The contract type, when the stored subject and actor are in the contract.
    #[must_use]
    pub fn to_domain_event(&self) -> Option<DomainEvent> {
        serde_json::to_value(self).ok().and_then(|v| serde_json::from_value(v).ok())
    }
}

/// `ListEventsQuery`. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListEventsQuery {
    /// Filter legacy history by its former Workstream key; this is not a live resource lookup.
    #[param(rename = "legacyWorkstreamKey")]
    pub legacy_workstream_key: Option<String>,
    /// `<type>:<id>`, e.g. `execution:ex_abc`.
    pub subject: Option<String>,
    /// Event type or prefix, e.g. `execution.`
    #[param(rename = "type")]
    pub kind: Option<String>,
    /// ISO timestamp: only events strictly older than this.
    pub before: Option<String>,
    /// 1..=500, default 100.
    #[param(value_type = Option<u32>, minimum = 1, maximum = 500)]
    pub limit: Option<u64>,
}

impl ListEventsQuery {
    /// Reads the raw query string the way Express (`querystring`), class-transformer and
    /// class-validator do: a repeated key is an array (not a string), `limit` goes through
    /// `Number()`, unknown keys are dropped.
    ///
    /// # Errors
    ///
    /// 400 with every class-validator message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut values: Vec<(String, Vec<String>)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            match values.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(value.into_owned()),
                None => values.push((key.into_owned(), vec![value.into_owned()])),
            }
        }
        let get = |name: &str| values.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice());
        let mut checks = Checks::new();
        let mut string = |name: &str| -> Option<String> {
            let list = get(name)?;
            checks.check(list.len() == 1, format!("{name} must be a string"));
            (list.len() == 1).then(|| list[0].clone())
        };
        let legacy_workstream_key = string("legacyWorkstreamKey");
        let subject = string("subject");
        let kind = string("type");
        let before = string("before");
        let limit = get("limit").map(|list| match list {
            [one] => js_number(one).unwrap_or(f64::NAN),
            _ => f64::NAN,
        });
        if let Some(n) = limit {
            checks
                .check(n <= 500.0, "limit must not be greater than 500")
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        checks.finish()?;
        Ok(Self {
            legacy_workstream_key,
            subject,
            kind,
            before,
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            limit: limit.map(|n| n as u64),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(raw: &str) -> String {
        ListEventsQuery::parse(Some(raw)).unwrap_err().to_string()
    }

    #[test]
    fn reads_every_field() {
        let q = ListEventsQuery::parse(Some(
            "subject=issue%3Ain_1&type=issue.&before=2026-01-01&limit=0x10&legacyWorkstreamKey=wk&x=1",
        ))
        .unwrap();
        assert_eq!(q.subject.as_deref(), Some("issue:in_1"));
        assert_eq!(q.kind.as_deref(), Some("issue."));
        assert_eq!(q.before.as_deref(), Some("2026-01-01"));
        assert_eq!(q.legacy_workstream_key.as_deref(), Some("wk"));
        assert_eq!(q.limit, Some(16));
        assert_eq!(ListEventsQuery::parse(None).unwrap(), ListEventsQuery::default());
        assert_eq!(ListEventsQuery::parse(Some("limit=1e2")).unwrap().limit, Some(100));
    }

    #[test]
    fn validates_like_class_validator() {
        let all = "limit must not be greater than 500; limit must not be less than 1; limit must be an integer number";
        assert!(messages("limit=abc").contains(all), "{}", messages("limit=abc"));
        assert!(messages("limit=1&limit=2").contains(all));
        assert!(messages("limit=").contains("limit must not be less than 1"));
        assert!(!messages("limit=").contains("integer"));
        assert!(messages("limit=1.5").contains("limit must be an integer number"));
        assert!(messages("limit=501").contains("limit must not be greater than 500"));
        let both = messages("type=a&type=b&subject=x&subject=y");
        assert!(both.contains("subject must be a string; type must be a string"), "{both}");
    }
}
