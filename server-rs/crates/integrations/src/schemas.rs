//! Request and response bodies of the connection routes, validated with the wording and order of
//! the class-validator rules of `CreateIntegrationDto`, `UpdateIntegrationDto` and
//! `RemoteReposQuery`.
//!
//! Body fields are read as JSON values and checked by hand rather than typed by serde, so a
//! wrong type is reported as `token must be a string` like NestJS, and the messages of one
//! property come in class-validator's order (the last decorator first).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::integrations::{ConnectionProvider, IntegrationConnection};
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::{Checks, Patch, js_len};
use utoipa::ToSchema;

/// The contract connection plus the webhook URL and the last delivery time (`PresentedConnection`).
/// Never secrets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresentedConnection {
    /// The connection.
    #[serde(flatten)]
    pub connection: IntegrationConnection,
    /// Where the provider posts its webhooks to (absent for Delta).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
    /// Last webhook delivery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_webhook_at: Option<String>,
}

/// What to enter in the git host to deliver webhooks (`WebhookSetup`). The secret is plain text
/// and only ever returned by create and rotate-webhook-secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSetup {
    /// Payload URL.
    pub url: String,
    /// Signing secret, shown once.
    pub secret: String,
    /// Always `application/json`.
    pub content_type: &'static str,
    /// Events to subscribe to.
    pub events: Vec<&'static str>,
}

/// Answer of `POST /integrations` and `/me/connections`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct ConnectionCreated {
    /// The new connection.
    pub connection: PresentedConnection,
    /// Webhook instructions; absent for Delta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook: Option<WebhookSetup>,
}

/// Answer of `POST …/rotate-webhook-secret`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct WebhookRotated {
    /// The connection.
    pub connection: PresentedConnection,
    /// The new webhook instructions.
    pub webhook: WebhookSetup,
}

/// Body of `POST /api/w/{slug}/integrations` and `POST /api/me/connections`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionBody {
    /// `github`, `gitlab`, `bitbucket` or `delta`.
    #[schema(value_type = ConnectionProvider)]
    provider: Option<Value>,
    /// The access token, 1 to 500 characters.
    #[schema(value_type = String, min_length = 1, max_length = 500)]
    token: Option<Value>,
    /// Base URL of a self-hosted GitHub or GitLab (required for Delta), up to 500 characters.
    #[schema(value_type = Option<String>, max_length = 500)]
    base_url: Option<Value>,
    /// Display name, 1 to 80 characters; defaults to `<Provider> · <account>`.
    #[schema(value_type = Option<String>, min_length = 1, max_length = 80)]
    label: Option<Value>,
}

/// A validated [`CreateConnectionBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateConnection {
    /// What it talks to.
    pub provider: ConnectionProvider,
    /// The credential.
    pub token: String,
    /// Base URL as sent.
    pub base_url: Option<String>,
    /// Display name as sent.
    pub label: Option<String>,
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

/// `@IsOptional()`: skipped while absent or `null`.
fn optional<T>(value: Option<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    value.and_then(|v| check(&v))
}

/// `@Clearable()`: skipped while absent or `null` (`null` clears the field).
fn clearable<T>(patch: Patch<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Patch<T> {
    match patch {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(v) => check(&v).map_or(Patch::Missing, Patch::Value),
    }
}

/// `@OptionalNotNull()`: skipped while absent; `null` is validated (and fails).
fn not_null<T>(patch: Patch<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    match patch {
        Patch::Missing => None,
        Patch::Null => check(&Value::Null),
        Patch::Value(v) => check(&v),
    }
}

impl CreateConnectionBody {
    /// Runs the DTO rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<CreateConnection, AppError> {
        let mut c = Checks::new();
        let names: Vec<&str> = ConnectionProvider::ALL.iter().map(|p| p.as_str()).collect();
        let provider =
            self.provider.as_ref().and_then(Value::as_str).and_then(ConnectionProvider::parse);
        c.check(
            provider.is_some(),
            format!("provider must be one of the following values: {}", names.join(", ")),
        );
        let token =
            text(&mut c, "token", self.token.as_ref().unwrap_or(&Value::Null), Some(1), 500);
        let base_url = optional(self.base_url, |v| text(&mut c, "baseUrl", v, None, 500));
        let label = optional(self.label, |v| text(&mut c, "label", v, Some(1), 80));
        c.finish()?;
        match (provider, token) {
            (Some(provider), Some(token)) => {
                Ok(CreateConnection { provider, token, base_url, label })
            }
            _ => Err(AppError::bad_request("Invalid connection")),
        }
    }
}

/// Body of `PATCH …/{id}`.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionBody {
    /// A new access token, 1 to 500 characters (re-validates the connection).
    #[serde(default)]
    #[schema(value_type = Option<String>, min_length = 1, max_length = 500)]
    token: Patch<Value>,
    /// A new base URL; `null` goes back to the provider's public host.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 500)]
    base_url: Patch<Value>,
    /// A new display name, 1 to 80 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, min_length = 1, max_length = 80)]
    label: Patch<Value>,
}

/// A validated [`UpdateConnectionBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateConnection {
    /// New token.
    pub token: Option<String>,
    /// New base URL, `Null` for the public host.
    pub base_url: Patch<String>,
    /// New label (trimmed by the service).
    pub label: Option<String>,
}

impl UpdateConnectionBody {
    /// Runs the DTO rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<UpdateConnection, AppError> {
        let mut c = Checks::new();
        let token = not_null(self.token, |v| text(&mut c, "token", v, Some(1), 500));
        let base_url = clearable(self.base_url, |v| text(&mut c, "baseUrl", v, None, 500));
        let label = not_null(self.label, |v| text(&mut c, "label", v, Some(1), 80));
        c.finish()?;
        Ok(UpdateConnection { token, base_url, label })
    }
}

/// `?page=&perPage=` of `GET …/remote-repositories` (`RemoteReposQuery`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteReposQuery {
    /// Page, from 1 (default 1).
    pub page: u32,
    /// Page size, 1 to 100 (default 30).
    pub per_page: u32,
}

impl RemoteReposQuery {
    /// Reads the raw query string the way Express, class-transformer (`Number()`) and
    /// class-validator do.
    ///
    /// # Errors
    ///
    /// 400 with every message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut c = Checks::new();
        let page = number(raw, "page");
        if let Some(n) = page {
            c.check(n >= 1.0, "page must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "page must be an integer number");
        }
        let per_page = number(raw, "perPage");
        if let Some(n) = per_page {
            c.check(n <= 100.0, "perPage must not be greater than 100")
                .check(n >= 1.0, "perPage must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "perPage must be an integer number");
        }
        c.finish()?;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let int = |n: Option<f64>, default: u32| n.map_or(default, |n| n as u32);
        Ok(Self { page: int(page, 1), per_page: int(per_page, 30) })
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

    fn create(body: Value) -> Result<CreateConnection, String> {
        serde_json::from_value::<CreateConnectionBody>(body)
            .unwrap()
            .validate()
            .map_err(|e| e.to_string().replace("400 Bad Request: ", ""))
    }

    fn update(body: Value) -> Result<UpdateConnection, String> {
        serde_json::from_value::<UpdateConnectionBody>(body)
            .unwrap()
            .validate()
            .map_err(|e| e.to_string().replace("400 Bad Request: ", ""))
    }

    #[test]
    fn create_needs_a_known_provider_and_a_token() {
        let ok = create(json!({ "provider": "github", "token": "t", "label": "L" })).unwrap();
        assert_eq!(
            (ok.provider, ok.token.as_str(), ok.label.as_deref()),
            (ConnectionProvider::Github, "t", Some("L"))
        );
        assert!(
            create(json!({ "provider": "delta", "token": "t", "baseUrl": "https://d.dev" }))
                .is_ok()
        );
        let providers =
            "provider must be one of the following values: github, gitlab, bitbucket, delta";
        assert_eq!(create(json!({ "provider": "svn", "token": "t" })).unwrap_err(), providers);
        assert_eq!(
            create(json!({})).unwrap_err(),
            format!(
                "{providers}; token must be shorter than or equal to 500 characters; token must be longer than or equal to 1 characters; token must be a string"
            )
        );
        assert_eq!(
            create(json!({ "provider": "github", "token": "t", "label": "" })).unwrap_err(),
            "label must be longer than or equal to 1 characters"
        );
        assert_eq!(
            create(json!({ "provider": "github", "token": "t", "label": "x".repeat(81) }))
                .unwrap_err(),
            "label must be shorter than or equal to 80 characters"
        );
        assert_eq!(
            create(json!({ "provider": "github", "token": "t", "baseUrl": 5 })).unwrap_err(),
            "baseUrl must be shorter than or equal to 500 characters; baseUrl must be a string"
        );
        // optional fields may be null
        assert!(
            create(json!({ "provider": "github", "token": "t", "label": null, "baseUrl": null }))
                .is_ok()
        );
        assert_eq!(
            create(json!({ "provider": "github", "token": "x".repeat(501) })).unwrap_err(),
            "token must be shorter than or equal to 500 characters"
        );
    }

    #[test]
    fn update_distinguishes_absent_null_and_values() {
        assert_eq!(update(json!({})).unwrap(), UpdateConnection::default());
        let patch = update(json!({ "token": "n", "baseUrl": null, "label": "L" })).unwrap();
        assert_eq!(patch.token.as_deref(), Some("n"));
        assert_eq!(patch.base_url, Patch::Null);
        assert_eq!(patch.label.as_deref(), Some("L"));
        assert_eq!(
            update(json!({ "baseUrl": "https://x.dev" })).unwrap().base_url,
            Patch::Value("https://x.dev".to_owned())
        );
        // token and label cannot be cleared
        assert_eq!(
            update(json!({ "token": null })).unwrap_err(),
            "token must be shorter than or equal to 500 characters; token must be longer than or equal to 1 characters; token must be a string"
        );
        assert_eq!(
            update(json!({ "label": "" })).unwrap_err(),
            "label must be longer than or equal to 1 characters"
        );
    }

    #[test]
    fn the_repositories_query_has_defaults_and_bounds() {
        let ok = RemoteReposQuery::parse(None).unwrap();
        assert_eq!((ok.page, ok.per_page), (1, 30));
        let ok = RemoteReposQuery::parse(Some("page=3&perPage=100")).unwrap();
        assert_eq!((ok.page, ok.per_page), (3, 100));
        let message = |raw: &str| {
            RemoteReposQuery::parse(Some(raw))
                .unwrap_err()
                .to_string()
                .replace("400 Bad Request: ", "")
        };
        assert_eq!(message("page=0"), "page must not be less than 1");
        assert_eq!(message("page=1.5"), "page must be an integer number");
        assert_eq!(
            message("page=abc"),
            "page must not be less than 1; page must be an integer number"
        );
        assert_eq!(message("perPage=101"), "perPage must not be greater than 100");
        assert_eq!(message("perPage=0"), "perPage must not be less than 1");
        assert_eq!(
            message("page=0&perPage=101"),
            "page must not be less than 1; perPage must not be greater than 100"
        );
    }
}
