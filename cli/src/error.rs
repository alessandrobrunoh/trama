//! One error type for the whole CLI, with stable machine-readable codes and exit statuses.
//!
//! | exit | code           | meaning                                              |
//! |------|----------------|------------------------------------------------------|
//! | 0    |                | success                                              |
//! | 1    | `internal`     | unexpected failure                                   |
//! | 2    | `usage`        | bad command line (clap) or invalid local input       |
//! | 3    | `auth`         | no/invalid credentials (401) or missing permission (403) |
//! | 4    | `not_found`    | 404                                                  |
//! | 5    | `rate_limited` | 429: stop, do not retry in a loop                    |
//! | 6    | `conflict`     | 409                                                  |
//! | 7    | `network`      | API unreachable, timeout or 5xx                      |
//! | 8    | `validation`   | 400/415/422: the API rejected the input              |

use std::fmt;
use std::io::IsTerminal;

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Internal,
    Usage,
    Auth,
    NotFound,
    RateLimited,
    Conflict,
    Network,
    Validation,
}

impl Kind {
    pub fn exit_code(self) -> u8 {
        match self {
            Kind::Internal => 1,
            Kind::Usage => 2,
            Kind::Auth => 3,
            Kind::NotFound => 4,
            Kind::RateLimited => 5,
            Kind::Conflict => 6,
            Kind::Network => 7,
            Kind::Validation => 8,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Kind::Internal => "internal",
            Kind::Usage => "usage",
            Kind::Auth => "auth",
            Kind::NotFound => "not_found",
            Kind::RateLimited => "rate_limited",
            Kind::Conflict => "conflict",
            Kind::Network => "network",
            Kind::Validation => "validation",
        }
    }
}

#[derive(Debug)]
pub struct CliError {
    pub kind: Kind,
    pub message: String,
    pub status: Option<u16>,
    pub hint: Option<String>,
}

pub type Result<T> = std::result::Result<T, CliError>;

impl CliError {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), status: None, hint: None }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(Kind::Usage, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Kind::Internal, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(Kind::Network, message).hint("Check the API URL and your connection; `trama doctor` runs the checks for you.")
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(Kind::Auth, message)
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn not_logged_in() -> Self {
        Self::auth("not signed in: no API key found")
            .hint("Run `trama login`, or set TRAMA_API_KEY (and TRAMA_API_URL) in the environment.")
    }

    /// Maps a non-success API reply to an error. `body` is the raw reply text.
    pub fn from_http(status: u16, body: &str) -> Self {
        let message = api_error_message(body);
        let (kind, hint) = match status {
            401 => (Kind::Auth, Some("The API key is invalid, revoked or expired. Run `trama login` again.")),
            403 => (
                Kind::Auth,
                Some("The key (or your role) does not allow this. `trama whoami` lists the key's permissions; ask an admin to grant the missing one."),
            ),
            404 => (Kind::NotFound, Some("Not found, or not visible to this key (a workspace you are not a member of also answers 404).")),
            409 => (Kind::Conflict, None),
            429 => (Kind::RateLimited, Some("Usage cap of this API key reached. Stop and report it; do not retry in a loop. Wait a minute, or raise the caps on the token.")),
            400 | 415 | 422 => (Kind::Validation, Some("`trama schema <command>` shows the accepted fields.")),
            500..=599 => (Kind::Network, Some("The API failed on its side; try again shortly.")),
            _ => (Kind::Internal, None),
        };
        let mut e = Self::new(kind, message).status(status);
        e.hint = hint.map(str::to_string);
        e
    }

    pub fn to_json(&self) -> Value {
        let mut err = json!({ "code": self.kind.code(), "message": self.message });
        if let Some(s) = self.status {
            err["status"] = json!(s);
        }
        if let Some(h) = &self.hint {
            err["hint"] = json!(h);
        }
        json!({ "error": err })
    }

    pub fn report(&self) {
        let as_json = match std::env::var("TRAMA_ERRORS").ok().as_deref() {
            Some("json") => true,
            Some("text") => false,
            _ => !std::io::stderr().is_terminal(),
        };
        if as_json {
            eprintln!("{}", self.to_json());
        } else {
            eprintln!("error: {}", self.message);
            if let Some(h) = &self.hint {
                eprintln!("hint: {h}");
            }
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(format!("I/O error: {e}"))
    }
}

impl From<serde_json::Error> for CliError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(format!("invalid JSON: {e}"))
    }
}

/// Nest errors look like `{ statusCode, message: string | string[], error }`.
pub fn api_error_message(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(|v| v.get("message")).map(|m| match m {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    });
    let text = message.unwrap_or_else(|| body.trim().to_string());
    if text.is_empty() {
        return "the API returned an error without a message".into();
    }
    let mut text = text;
    if text.len() > 2000 {
        let mut cut = 2000;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_nest_errors() {
        assert_eq!(api_error_message(r#"{"statusCode":400,"message":["a is required","b must be x"]}"#), "a is required; b must be x");
        assert_eq!(api_error_message(r#"{"statusCode":403,"message":"nope"}"#), "nope");
        assert_eq!(api_error_message("gateway down"), "gateway down");
        assert!(api_error_message("").contains("without a message"));
    }

    #[test]
    fn maps_statuses_to_stable_exit_codes() {
        let code = |s| CliError::from_http(s, "{}").kind.exit_code();
        assert_eq!((code(401), code(403), code(404), code(409), code(429), code(400), code(502)), (3, 3, 4, 6, 5, 8, 7));
        let e = CliError::from_http(429, r#"{"message":"writesPerMinute exceeded"}"#);
        assert!(e.hint.unwrap().contains("do not retry"));
    }

    #[test]
    fn error_json_is_stable() {
        let v = CliError::from_http(404, r#"{"message":"Issue not found"}"#).to_json();
        assert_eq!(v["error"]["code"], "not_found");
        assert_eq!(v["error"]["status"], 404);
        assert_eq!(v["error"]["message"], "Issue not found");
    }
}
