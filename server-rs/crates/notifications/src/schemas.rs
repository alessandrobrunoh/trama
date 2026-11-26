//! Request and response bodies of the notifications routes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::identity::{NOTIFICATION_KINDS, NotificationKind, NotificationSettings};
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::time::to_iso;
use trama_core::validation::Checks;
use trama_entities::notifications;
use utoipa::{IntoParams, ToSchema};

use crate::validation::{is_https_url, string_with_max};

/// The most ids one `POST /read` takes.
pub const MAX_READ_IDS: usize = 500;
/// The longest push endpoint.
pub const MAX_ENDPOINT_LENGTH: usize = 2000;

/// One notification of `GET /api/w/:slug/notifications` (`NotificationEntity` as JSON: the
/// recipient is not part of it and nulls are left out). Stored JSON passes through as it is, so
/// retired kinds and subject types still round-trip.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = NotificationRow)]
pub struct NotificationView {
    /// Notification id (`ntf_…`).
    pub id: String,
    /// Workspace id.
    pub workspace_id: String,
    /// Why it was sent: `assigned`, `review_requested`, `ci_failed`, `comment` or the retired
    /// `workstream_update`.
    pub kind: String,
    /// Headline.
    pub title: String,
    /// A short excerpt, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Who caused it.
    #[schema(value_type = trama_contracts::common::ActorRef)]
    pub actor: Value,
    /// The record it is about.
    #[schema(value_type = trama_contracts::common::LegacySubjectRef)]
    pub subject: Value,
    /// Where it leads, relative to the workspace, e.g. `tasks/AUTH-142`.
    pub link: String,
    /// Creation time.
    pub created_at: String,
    /// Absent while unread.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

impl From<notifications::Model> for NotificationView {
    fn from(row: notifications::Model) -> Self {
        Self {
            created_at: to_iso(&row.created_at),
            read_at: row.read_at.as_ref().map(to_iso),
            id: row.id,
            workspace_id: row.workspace_id,
            kind: row.kind,
            title: row.title,
            body: row.body,
            actor: row.actor,
            subject: row.subject,
            link: row.link,
        }
    }
}

/// Response of `GET /api/w/:slug/notifications`.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct NotificationListView {
    /// The page, newest first.
    pub items: Vec<NotificationView>,
    /// Unread in this workspace, whatever the page size.
    pub unread: i64,
}

/// Response of `POST /api/w/:slug/notifications/read`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct UnreadCount {
    /// Unread notifications left in the workspace.
    pub unread: i64,
}

/// Response of the notification settings routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// Per kind and channel, defaults applied.
    pub settings: NotificationSettings,
    /// Whether the server sends email at all (`SMTP_URL` is set).
    pub email_available: bool,
}

/// Response of `GET /api/me/push`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushStatus {
    /// Whether the server has VAPID keys.
    pub enabled: bool,
    /// What the browser subscribes with; `null` when the server has no VAPID keys.
    pub public_key: Option<String>,
}

/// Response of `PUT /api/me/push/subscription`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct PushEnabled {
    /// Always `true`.
    pub enabled: bool,
}

// ───────────────────────────── requests ─────────────────────────────

/// `ListQuery`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListQuery {
    /// 1..=200, default 50.
    #[param(value_type = Option<u32>, minimum = 1, maximum = 200)]
    pub limit: Option<i64>,
    /// Only unread notifications.
    #[param(value_type = Option<bool>)]
    pub unread: Option<bool>,
}

impl ListQuery {
    /// Reads the raw query string the way Express, class-transformer and class-validator do: a
    /// repeated key is an array, `limit` goes through `Number()`, `unread` accepts `true` and
    /// `false` only, unknown keys are dropped.
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
        let limit = get("limit").map(|list| match list {
            [one] => js_number(one).unwrap_or(f64::NAN),
            _ => f64::NAN,
        });
        if let Some(n) = limit {
            checks
                .check(n <= 200.0, "limit must not be greater than 200")
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        // `true` / `false` are read as booleans; anything else (or a repeated key) stays a
        // string (or array) and fails `@IsBoolean()`
        let unread = get("unread").map(|list| match list {
            [one] if one == "true" => Some(true),
            [one] if one == "false" => Some(false),
            _ => None,
        });
        checks.check(unread.is_none_or(|u| u.is_some()), "unread must be a boolean value");
        checks.finish()?;
        Ok(Self {
            #[allow(clippy::cast_possible_truncation)]
            limit: limit.map(|n| n as i64),
            unread: unread.flatten(),
        })
    }
}

/// Body of `POST /api/w/:slug/notifications/read`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct MarkReadBody {
    /// Omit to mark everything in the workspace as read.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>, max_items = 500)]
    pub ids: Option<Value>,
}

impl MarkReadBody {
    /// `@IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids`.
    ///
    /// # Errors
    ///
    /// 400 with the class-validator messages (bottom decorator first).
    pub fn ids(&self) -> Result<Option<Vec<String>>, AppError> {
        let Some(value) = self.ids.as_ref().filter(|v| !v.is_null()) else { return Ok(None) };
        let items = value.as_array();
        let mut problems = Vec::new();
        // `each` checks every element of a list and the value itself otherwise
        let each_string = match items {
            Some(items) => items.iter().all(Value::is_string),
            None => value.is_string(),
        };
        if !each_string {
            problems.push("each value in ids must be a string".to_owned());
        }
        if items.is_none_or(|i| i.len() > MAX_READ_IDS) {
            problems.push(format!("ids must contain no more than {MAX_READ_IDS} elements"));
        }
        if items.is_none() {
            problems.push("ids must be an array".to_owned());
        }
        if !problems.is_empty() {
            return Err(AppError::validation(problems));
        }
        Ok(items.map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()))
    }
}

/// What `PATCH /api/me/notification-settings` changes in one kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChannelPatch {
    /// `inApp`.
    pub in_app: Option<bool>,
    /// `email`.
    pub email: Option<bool>,
    /// `push`.
    pub push: Option<bool>,
}

/// Body of `PATCH /api/me/notification-settings`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct UpdateSettingsBody {
    /// Per kind, the channels to switch: `{ "assigned": { "email": true } }`.
    #[serde(default)]
    #[schema(value_type = Object)]
    pub settings: Option<Value>,
}

impl UpdateSettingsBody {
    /// `@IsObject() settings`, then the controller's own checks, in the same order.
    ///
    /// # Errors
    ///
    /// 400 `settings must be an object`, `Unknown notification kind "x"`, `Settings for "x" must
    /// be an object`, `Unknown channel "x"` or `kind.channel must be true or false`.
    pub fn patch(&self) -> Result<Vec<(NotificationKind, ChannelPatch)>, AppError> {
        let settings =
            self.settings.as_ref().and_then(Value::as_object).ok_or_else(|| {
                AppError::validation(vec!["settings must be an object".to_owned()])
            })?;
        let mut patch = Vec::new();
        for (name, channels) in settings {
            let kind = NOTIFICATION_KINDS.iter().copied().find(|k| k.as_str() == name).ok_or_else(
                || AppError::bad_request(format!("Unknown notification kind \"{name}\"")),
            )?;
            let entries: Vec<(String, &Value)> = match channels {
                Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
                // `Object.entries` of an array lists its indices
                Value::Array(items) => {
                    items.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect()
                }
                _ => {
                    return Err(AppError::bad_request(format!(
                        "Settings for \"{name}\" must be an object"
                    )));
                }
            };
            let mut entry = ChannelPatch::default();
            for (channel, value) in entries {
                let slot = match channel.as_str() {
                    "inApp" => &mut entry.in_app,
                    "email" => &mut entry.email,
                    "push" => &mut entry.push,
                    other => {
                        return Err(AppError::bad_request(format!("Unknown channel \"{other}\"")));
                    }
                };
                let Value::Bool(flag) = value else {
                    return Err(AppError::bad_request(format!(
                        "{name}.{channel} must be true or false"
                    )));
                };
                *slot = Some(*flag);
            }
            patch.push((kind, entry));
        }
        Ok(patch)
    }
}

/// What the browser sends to `PUT /api/me/push/subscription` (`PushSubscription.toJSON()`).
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct PushSubscriptionBody {
    /// The push service URL (https).
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 2000)]
    pub endpoint: Option<Value>,
    /// `{ p256dh, auth }`.
    #[serde(default)]
    #[schema(value_type = Option<PushKeys>)]
    pub keys: Option<Value>,
}

/// `PushSubscription.toJSON().keys`.
#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct PushKeys {
    /// The browser's public key (base64url).
    pub p256dh: String,
    /// The browser's auth secret (base64url).
    pub auth: String,
}

/// A validated `PUT /api/me/push/subscription` body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushSubscriptionParts {
    /// The endpoint.
    pub endpoint: String,
    /// `keys.p256dh`, when sent and not empty.
    pub p256dh: Option<String>,
    /// `keys.auth`, when sent and not empty.
    pub auth: Option<String>,
}

impl PushSubscriptionBody {
    /// `@MaxLength(2000) @IsUrl(...) endpoint` and `@IsObject() keys`.
    ///
    /// # Errors
    ///
    /// 400 with the class-validator messages.
    pub fn validate(&self) -> Result<PushSubscriptionParts, AppError> {
        let mut problems = Vec::new();
        let endpoint = self.endpoint.as_ref().and_then(Value::as_str);
        let long_enough =
            endpoint.is_some_and(|e| trama_core::validation::js_len(e) <= MAX_ENDPOINT_LENGTH);
        if !long_enough {
            problems.push(format!(
                "endpoint must be shorter than or equal to {MAX_ENDPOINT_LENGTH} characters"
            ));
        }
        if !endpoint.is_some_and(is_https_url) {
            problems.push("endpoint must be a URL address".to_owned());
        }
        let keys = self.keys.as_ref().and_then(Value::as_object);
        if keys.is_none() {
            problems.push("keys must be an object".to_owned());
        }
        if !problems.is_empty() {
            return Err(AppError::validation(problems));
        }
        let key = |name: &str| {
            keys.and_then(|k| k.get(name))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        };
        Ok(PushSubscriptionParts {
            endpoint: endpoint.unwrap_or_default().to_owned(),
            p256dh: key("p256dh"),
            auth: key("auth"),
        })
    }
}

/// Body of `DELETE /api/me/push/subscription`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct PushEndpointBody {
    /// The endpoint to forget.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 2000)]
    pub endpoint: Option<Value>,
}

impl PushEndpointBody {
    /// `@IsString() @MaxLength(2000) endpoint`.
    ///
    /// # Errors
    ///
    /// 400 with the class-validator messages.
    pub fn endpoint(&self) -> Result<String, AppError> {
        let mut problems = Vec::new();
        string_with_max("endpoint", self.endpoint.as_ref(), MAX_ENDPOINT_LENGTH, &mut problems);
        if problems.is_empty() {
            Ok(self.endpoint.as_ref().and_then(Value::as_str).unwrap_or_default().to_owned())
        } else {
            Err(AppError::validation(problems))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message(err: &AppError) -> String {
        err.to_string().trim_start_matches("400 Bad Request: ").to_owned()
    }

    #[test]
    fn reads_unread_false_as_false_not_as_a_truthy_string() {
        let q = ListQuery::parse(Some("unread=false")).unwrap();
        assert_eq!(q.unread, Some(false));
    }

    #[test]
    fn reads_unread_true_as_true_and_leaves_it_unset_when_absent() {
        assert_eq!(ListQuery::parse(Some("unread=true")).unwrap().unread, Some(true));
        assert_eq!(ListQuery::parse(None).unwrap(), ListQuery::default());
        assert_eq!(ListQuery::parse(Some("")).unwrap().unread, None);
    }

    #[test]
    fn rejects_junk_values() {
        for raw in ["unread=maybe", "unread=true&unread=false", "unread=", "unread=1"] {
            let err = ListQuery::parse(Some(raw)).unwrap_err();
            assert!(message(&err).contains("unread must be a boolean value"), "{raw}");
        }
    }

    #[test]
    fn validates_the_limit_like_class_validator() {
        let all = "limit must not be greater than 200; limit must not be less than 1; limit must be an integer number";
        for raw in ["limit=abc", "limit=1&limit=2"] {
            assert!(message(&ListQuery::parse(Some(raw)).unwrap_err()).contains(all), "{raw}");
        }
        assert!(
            message(&ListQuery::parse(Some("limit=0")).unwrap_err()).contains("not be less than 1")
        );
        assert!(
            message(&ListQuery::parse(Some("limit=201")).unwrap_err())
                .contains("limit must not be greater than 200")
        );
        assert!(
            message(&ListQuery::parse(Some("limit=1.5")).unwrap_err())
                .contains("limit must be an integer number")
        );
        assert_eq!(ListQuery::parse(Some("limit=200&unread=true&x=1")).unwrap().limit, Some(200));
    }

    #[test]
    fn checks_the_ids_to_mark_read() {
        let ids = |v: Value| MarkReadBody { ids: Some(v) }.ids();
        assert_eq!(MarkReadBody::default().ids().unwrap(), None);
        assert_eq!(ids(Value::Null).unwrap(), None);
        assert_eq!(ids(json!(["a", "b"])).unwrap(), Some(vec!["a".into(), "b".into()]));
        assert_eq!(ids(json!([])).unwrap(), Some(Vec::new()));
        assert_eq!(message(&ids(json!([1])).unwrap_err()), "each value in ids must be a string");
        assert_eq!(
            message(&ids(json!("a")).unwrap_err()),
            "ids must contain no more than 500 elements; ids must be an array"
        );
        assert!(
            message(&ids(json!(5)).unwrap_err()).starts_with("each value in ids must be a string")
        );
        let many: Vec<String> = (0..501).map(|i| i.to_string()).collect();
        assert_eq!(
            message(&ids(json!(many)).unwrap_err()),
            "ids must contain no more than 500 elements"
        );
    }

    fn patch(settings: Value) -> Result<Vec<(NotificationKind, ChannelPatch)>, AppError> {
        UpdateSettingsBody { settings: Some(settings) }.patch()
    }

    #[test]
    fn parses_a_settings_patch() {
        let p = patch(
            json!({ "assigned": { "inApp": false }, "comment": { "email": true, "push": false } }),
        )
        .unwrap();
        assert!(p.contains(&(
            NotificationKind::Assigned,
            ChannelPatch { in_app: Some(false), email: None, push: None }
        )));
        assert!(p.contains(&(
            NotificationKind::Comment,
            ChannelPatch { in_app: None, email: Some(true), push: Some(false) }
        )));
        assert_eq!(patch(json!({})).unwrap(), []);
    }

    #[test]
    fn refuses_a_bad_settings_patch_with_the_nest_messages() {
        let err = |v: Value| message(&patch(v).unwrap_err());
        assert_eq!(
            err(json!({ "nonsense": { "inApp": true } })),
            "Unknown notification kind \"nonsense\""
        );
        assert_eq!(err(json!({ "assigned": { "sms": true } })), "Unknown channel \"sms\"");
        assert_eq!(
            err(json!({ "assigned": { "inApp": "yes" } })),
            "assigned.inApp must be true or false"
        );
        assert_eq!(err(json!({ "assigned": null })), "Settings for \"assigned\" must be an object");
        assert_eq!(err(json!({ "assigned": true })), "Settings for \"assigned\" must be an object");
        assert_eq!(err(json!({ "assigned": ["x"] })), "Unknown channel \"0\"");
        for missing in [None, Some(json!(null)), Some(json!([])), Some(json!("x"))] {
            let body = UpdateSettingsBody { settings: missing };
            assert_eq!(message(&body.patch().unwrap_err()), "settings must be an object");
        }
    }

    #[test]
    fn validates_a_push_subscription() {
        let body = |endpoint: Value, keys: Value| PushSubscriptionBody {
            endpoint: Some(endpoint),
            keys: Some(keys),
        };
        let ok = body(json!("https://push.example/a"), json!({ "p256dh": "k", "auth": "a" }));
        assert_eq!(
            ok.validate().unwrap(),
            PushSubscriptionParts {
                endpoint: "https://push.example/a".into(),
                p256dh: Some("k".into()),
                auth: Some("a".into()),
            }
        );
        let missing = body(json!("https://push.example/a"), json!({ "p256dh": "x" }));
        assert_eq!(missing.validate().unwrap().auth, None);
        assert_eq!(
            message(&body(json!("http://insecure.example/x"), json!({})).validate().unwrap_err()),
            "endpoint must be a URL address"
        );
        assert_eq!(
            message(&body(json!("https://push.example/a"), json!("no")).validate().unwrap_err()),
            "keys must be an object"
        );
        assert_eq!(
            message(&PushSubscriptionBody::default().validate().unwrap_err()),
            "endpoint must be shorter than or equal to 2000 characters; endpoint must be a URL address; keys must be an object"
        );
    }

    #[test]
    fn validates_an_endpoint_to_forget() {
        assert_eq!(
            PushEndpointBody { endpoint: Some(json!("https://x")) }.endpoint().unwrap(),
            "https://x"
        );
        assert_eq!(
            message(&PushEndpointBody::default().endpoint().unwrap_err()),
            "endpoint must be shorter than or equal to 2000 characters; endpoint must be a string"
        );
    }
}
