//! Request and response bodies of the outgoing webhook routes, validated with the wording and
//! order of the class-validator rules of `CreateWebhookDto`, `UpdateWebhookDto` and
//! `DeliveriesQuery`.
//!
//! Body fields are read as JSON values and checked by hand rather than typed by serde, so a
//! wrong type is reported as `name must be a string` like NestJS, and the messages of one
//! property come in class-validator's order (the last decorator first).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::integrations::OutgoingWebhook;
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::{Checks, Patch, js_len};
use utoipa::ToSchema;

/// Most events one webhook can subscribe to.
const MAX_EVENTS: usize = 60;
/// `EVENT_MESSAGE`.
const EVENT_MESSAGE: &str =
    r#"events must be "*", "<entity>.*" or an event type like "issue.created""#;

/// Answer of create and rotate-secret: the webhook and its signing secret, shown once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct WebhookWithSecret {
    /// The webhook (never carries the secret).
    pub webhook: OutgoingWebhook,
    /// The signing secret, `whsec_…`; it cannot be read again.
    pub secret: String,
}

/// Body of `POST /api/w/{slug}/outgoing-webhooks`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateWebhookBody {
    /// Display name, 1 to 80 characters.
    #[schema(value_type = String, min_length = 1, max_length = 80)]
    name: Option<Value>,
    /// Target URL, up to 500 characters; must be a public `http(s)` address.
    #[schema(value_type = String, max_length = 500)]
    url: Option<Value>,
    /// Event types to deliver: `*`, `<entity>.*` or `<entity>.<event>`; 1 to 60 of them.
    #[schema(value_type = Vec<String>, min_items = 1, max_items = 60)]
    events: Option<Value>,
    /// Defaults to `true`.
    #[schema(value_type = Option<bool>)]
    enabled: Option<Value>,
}

/// A validated [`CreateWebhookBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewWebhook {
    /// Display name as sent.
    pub name: String,
    /// Target URL as sent.
    pub url: String,
    /// Subscribed event patterns as sent (the service removes duplicates).
    pub events: Vec<String>,
    /// `None` means enabled.
    pub enabled: Option<bool>,
}

/// Body of `PATCH /api/w/{slug}/outgoing-webhooks/{id}`; every field is optional but not
/// nullable.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWebhookBody {
    /// New display name, 1 to 80 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, min_length = 1, max_length = 80)]
    name: Patch<Value>,
    /// New target URL, up to 500 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 500)]
    url: Patch<Value>,
    /// New event types, 1 to 60 of them.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>, min_items = 1, max_items = 60)]
    events: Patch<Value>,
    /// Pause or resume deliveries.
    #[serde(default)]
    #[schema(value_type = Option<bool>)]
    enabled: Patch<Value>,
}

/// A validated [`UpdateWebhookBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WebhookPatch {
    /// New name (trimmed by the service).
    pub name: Option<String>,
    /// New URL.
    pub url: Option<String>,
    /// New event patterns (the service removes duplicates).
    pub events: Option<Vec<String>>,
    /// New state.
    pub enabled: Option<bool>,
}

/// `@IsString() @MinLength(min) @MaxLength(max)`: the length rules also fail on a non-string, so
/// they report before `IsString`.
fn text(
    c: &mut Checks,
    name: &str,
    value: &Value,
    min: Option<usize>,
    max: usize,
) -> Option<String> {
    let s = value.as_str();
    c.check(
        s.is_some_and(|s| js_len(s) <= max),
        format!("{name} must be shorter than or equal to {max} characters"),
    );
    if let Some(min) = min {
        c.check(
            s.is_some_and(|s| js_len(s) >= min),
            format!("{name} must be longer than or equal to {min} characters"),
        );
    }
    c.check(s.is_some(), format!("{name} must be a string"));
    s.map(str::to_owned)
}

/// `EVENT_PATTERN`: `^(\*|[a-z_]+\.(\*|[a-z_]+))$`.
fn is_event_pattern(value: &str) -> bool {
    let word = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    value == "*"
        || value
            .split_once('.')
            .is_some_and(|(entity, rest)| word(entity) && (rest == "*" || word(rest)))
}

/// `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @Matches(EVENT_PATTERN, { each: true })`.
fn events(c: &mut Checks, value: &Value) -> Option<Vec<String>> {
    let list = value.as_array();
    // `each` validates the elements of an array, anything else is validated as the value itself
    let matches = list.map_or_else(
        || value.as_str().is_some_and(is_event_pattern),
        |list| list.iter().all(|e| e.as_str().is_some_and(is_event_pattern)),
    );
    c.check(matches, EVENT_MESSAGE);
    c.check(
        list.is_some_and(|l| l.len() <= MAX_EVENTS),
        format!("events must contain no more than {MAX_EVENTS} elements"),
    );
    c.check(list.is_some_and(|l| !l.is_empty()), "events must contain at least 1 elements");
    c.check(list.is_some(), "events must be an array");
    let list = list?;
    let all: Vec<String> = list.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect();
    (all.len() == list.len()).then_some(all)
}

/// `@IsBoolean()`.
fn boolean(c: &mut Checks, value: &Value) -> Option<bool> {
    let b = value.as_bool();
    c.check(b.is_some(), "enabled must be a boolean value");
    b
}

/// `@IsOptional()`: skipped while absent or `null`.
fn optional<T>(value: Option<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    value.filter(|v| !v.is_null()).and_then(|v| check(&v))
}

/// `@OptionalNotNull()`: skipped while absent; `null` is validated (and fails).
fn not_null<T>(patch: Patch<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    match patch {
        Patch::Missing => None,
        Patch::Null => check(&Value::Null),
        Patch::Value(v) => check(&v),
    }
}

impl CreateWebhookBody {
    /// Runs the DTO rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<NewWebhook, AppError> {
        let null = Value::Null;
        let mut c = Checks::new();
        let name = text(&mut c, "name", self.name.as_ref().unwrap_or(&null), Some(1), 80);
        let url = text(&mut c, "url", self.url.as_ref().unwrap_or(&null), None, 500);
        let events = events(&mut c, self.events.as_ref().unwrap_or(&null));
        let enabled = optional(self.enabled, |v| boolean(&mut c, v));
        c.finish()?;
        match (name, url, events) {
            (Some(name), Some(url), Some(events)) => Ok(NewWebhook { name, url, events, enabled }),
            _ => Err(AppError::bad_request("Invalid webhook")),
        }
    }
}

impl UpdateWebhookBody {
    /// Runs the DTO rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<WebhookPatch, AppError> {
        let mut c = Checks::new();
        let name = not_null(self.name, |v| text(&mut c, "name", v, Some(1), 80));
        let url = not_null(self.url, |v| text(&mut c, "url", v, None, 500));
        let events = not_null(self.events, |v| events(&mut c, v));
        let enabled = not_null(self.enabled, |v| boolean(&mut c, v));
        c.finish()?;
        Ok(WebhookPatch { name, url, events, enabled })
    }
}

/// `?limit=` of `GET …/deliveries` (`DeliveriesQuery`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeliveriesQuery {
    /// How many to return, 1 to 50 (default 20).
    pub limit: u64,
}

impl DeliveriesQuery {
    /// Reads the raw query string the way Express, class-transformer (`Number()`) and
    /// class-validator do.
    ///
    /// # Errors
    ///
    /// 400 with every message.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut c = Checks::new();
        let limit = number(raw, "limit");
        if let Some(n) = limit {
            c.check(n <= 50.0, "limit must not be greater than 50")
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        c.finish()?;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(Self { limit: limit.map_or(20, |n| n as u64) })
    }
}

/// `@Type(() => Number)` of one query key: `NaN` for a repeated key or a non-number.
fn number(raw: Option<&str>, name: &str) -> Option<f64> {
    let mut values = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned());
    let first = values.next()?;
    if values.next().is_some() {
        return Some(f64::NAN);
    }
    Some(js_number(&first).unwrap_or(f64::NAN))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn create(body: Value) -> Result<NewWebhook, String> {
        serde_json::from_value::<CreateWebhookBody>(body)
            .unwrap()
            .validate()
            .map_err(|e| e.to_string().replace("400 Bad Request: ", ""))
    }

    fn update(body: Value) -> Result<WebhookPatch, String> {
        serde_json::from_value::<UpdateWebhookBody>(body)
            .unwrap()
            .validate()
            .map_err(|e| e.to_string().replace("400 Bad Request: ", ""))
    }

    #[test]
    fn accepts_exact_types_entity_wildcards_and_star() {
        let ok = create(json!({
            "name": "n", "url": "https://a.example.com", "events": ["issue.created", "project.*", "*"],
        }))
        .unwrap();
        assert_eq!(ok.events, ["issue.created", "project.*", "*"]);
        assert_eq!(ok.enabled, None);
        let off = create(json!({ "name": "n", "url": "u", "events": ["*"], "enabled": false }));
        assert_eq!(off.unwrap().enabled, Some(false));
        // `enabled: null` counts as absent
        assert_eq!(
            create(json!({ "name": "n", "url": "u", "events": ["*"], "enabled": null }))
                .unwrap()
                .enabled,
            None
        );
    }

    #[test]
    fn checks_the_event_patterns() {
        for bad in
            ["Issue Created", "issue", "issue.", ".created", "issue.*.x", "*.created", "a.b.c", ""]
        {
            assert_eq!(
                create(json!({ "name": "n", "url": "u", "events": [bad] })).unwrap_err(),
                EVENT_MESSAGE,
                "{bad:?}"
            );
        }
        for good in ["*", "issue.*", "issue.created", "work_item.status_changed"] {
            assert!(create(json!({ "name": "n", "url": "u", "events": [good] })).is_ok(), "{good}");
        }
        assert_eq!(
            create(json!({ "name": "n", "url": "u", "events": [] })).unwrap_err(),
            "events must contain at least 1 elements"
        );
        let many: Vec<String> = (0..61).map(|_| "*".to_owned()).collect();
        assert_eq!(
            create(json!({ "name": "n", "url": "u", "events": many })).unwrap_err(),
            "events must contain no more than 60 elements"
        );
        assert!(create(json!({ "name": "n", "url": "u", "events": vec!["*"; 60] })).is_ok());
    }

    #[test]
    fn reports_every_failed_rule_in_declaration_order() {
        assert_eq!(
            create(json!({})).unwrap_err(),
            [
                "name must be shorter than or equal to 80 characters",
                "name must be longer than or equal to 1 characters",
                "name must be a string",
                "url must be shorter than or equal to 500 characters",
                "url must be a string",
                EVENT_MESSAGE,
                "events must contain no more than 60 elements",
                "events must contain at least 1 elements",
                "events must be an array",
            ]
            .join("; ")
        );
        assert_eq!(
            create(json!({ "name": "n", "url": "u", "events": ["*"], "enabled": "yes" }))
                .unwrap_err(),
            "enabled must be a boolean value"
        );
        assert_eq!(
            create(json!({ "name": "x".repeat(81), "url": "u".repeat(501), "events": ["*"] }))
                .unwrap_err(),
            "name must be shorter than or equal to 80 characters; url must be shorter than or equal to 500 characters"
        );
        assert_eq!(
            create(json!({ "name": "", "url": "u", "events": ["*"] })).unwrap_err(),
            "name must be longer than or equal to 1 characters"
        );
    }

    #[test]
    fn an_update_may_leave_fields_out_but_not_null_them() {
        assert_eq!(update(json!({})).unwrap(), WebhookPatch::default());
        let patch =
            update(json!({ "name": "N", "enabled": false, "events": ["issue.*"] })).unwrap();
        assert_eq!(
            patch,
            WebhookPatch {
                name: Some("N".into()),
                url: None,
                events: Some(vec!["issue.*".into()]),
                enabled: Some(false),
            }
        );
        assert_eq!(
            update(json!({ "name": null })).unwrap_err(),
            "name must be shorter than or equal to 80 characters; name must be longer than or equal to 1 characters; name must be a string"
        );
        assert_eq!(
            update(json!({ "enabled": null })).unwrap_err(),
            "enabled must be a boolean value"
        );
        assert_eq!(
            update(json!({ "events": [] })).unwrap_err(),
            "events must contain at least 1 elements"
        );
        assert_eq!(
            update(json!({ "url": 5 })).unwrap_err(),
            "url must be shorter than or equal to 500 characters; url must be a string"
        );
    }

    #[test]
    fn reads_the_deliveries_limit_like_class_validator() {
        let limit = |raw: Option<&str>| DeliveriesQuery::parse(raw).map(|q| q.limit);
        assert_eq!(limit(None).unwrap(), 20);
        assert_eq!(limit(Some("limit=5")).unwrap(), 5);
        assert_eq!(limit(Some("limit=50")).unwrap(), 50);
        let err =
            |raw: &str| limit(Some(raw)).unwrap_err().to_string().replace("400 Bad Request: ", "");
        assert_eq!(err("limit=51"), "limit must not be greater than 50");
        assert_eq!(err("limit=0"), "limit must not be less than 1");
        assert_eq!(err("limit=2.5"), "limit must be an integer number");
        assert_eq!(
            err("limit=abc"),
            "limit must not be greater than 50; limit must not be less than 1; limit must be an integer number"
        );
        assert_eq!(
            err("limit=1&limit=2"),
            "limit must not be greater than 50; limit must not be less than 1; limit must be an integer number"
        );
    }
}
