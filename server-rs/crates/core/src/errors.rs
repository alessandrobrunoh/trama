//! Errors returned by handlers, rendered in the NestJS `HttpException` format.
//!
//! The web app and the `trama` CLI read these bodies, so the shape is part of the contract:
//!
//! * `AppError::status(404)` → `{"statusCode":404,"message":"Not Found"}`
//! * `AppError::not_found("…")` → `{"statusCode":404,"message":"…","error":"Not Found"}`
//! * validation errors carry a list: `{"statusCode":400,"message":["…"],"error":"Bad Request"}`
//! * anything unexpected → `{"statusCode":500,"message":"Internal server error"}`, logged.

use std::error::Error as StdError;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::Value;

type BoxError = Box<dyn StdError + Send + Sync>;

/// One message or a list of them (validation reports every failed constraint).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Message {
    /// A single message.
    One(String),
    /// Several messages, one per failed check.
    Many(Vec<String>),
}

#[derive(Debug)]
enum Body {
    /// `{statusCode, message, error?}`; `error` (the reason phrase) only with a custom message.
    Standard { message: Message, with_error: bool },
    /// A handler-defined JSON body, e.g. the health check's `{status, db}`.
    Raw(Value),
}

/// An error a handler returns; converts into the HTTP response the NestJS API would send.
#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    body: Body,
    source: Option<BoxError>,
}

impl AppError {
    /// The bare status: `message` is its reason phrase and there is no `error` field.
    #[must_use]
    pub fn status(status: StatusCode) -> Self {
        Self {
            status,
            body: Body::Standard {
                message: Message::One(reason(status).to_owned()),
                with_error: false,
            },
            source: None,
        }
    }

    /// A status with a custom message.
    #[must_use]
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self::with_message(status, Message::One(message.into()))
    }

    /// A status with a message or a list of messages.
    #[must_use]
    pub fn with_message(status: StatusCode, message: Message) -> Self {
        Self { status, body: Body::Standard { message, with_error: true }, source: None }
    }

    /// A status with a body chosen by the handler, sent as is.
    #[must_use]
    pub fn with_body(status: StatusCode, body: Value) -> Self {
        Self { status, body: Body::Raw(body), source: None }
    }

    /// 400 with a message.
    #[must_use]
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    /// 400 listing every failed validation check.
    #[must_use]
    pub fn validation(messages: Vec<String>) -> Self {
        Self::with_message(StatusCode::BAD_REQUEST, Message::Many(messages))
    }

    /// 401 without details.
    #[must_use]
    pub fn unauthorized() -> Self {
        Self::status(StatusCode::UNAUTHORIZED)
    }

    /// 403 with a message.
    #[must_use]
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    /// 404 with a message.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    /// 404 in the API's usual wording: `Issue "AUTH-1" not found`.
    #[must_use]
    pub fn entity_not_found(entity: &str, id: &str) -> Self {
        Self::not_found(format!("{entity} \"{id}\" not found"))
    }

    /// 409 with a message.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    /// 500 caused by `err`; the client sees a generic message and the cause is logged.
    pub fn internal(err: impl Into<BoxError>) -> Self {
        Self { source: Some(err.into()), ..Self::status(StatusCode::INTERNAL_SERVER_ERROR) }
    }

    /// The HTTP status this error is sent with.
    #[must_use]
    pub fn status_code(&self) -> StatusCode {
        self.status
    }
}

/// The reason phrase NestJS uses as `message` and `error`.
fn reason(status: StatusCode) -> &'static str {
    match status {
        StatusCode::INTERNAL_SERVER_ERROR => "Internal server error",
        other => other.canonical_reason().unwrap_or("Error"),
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.body {
            Body::Standard { message: Message::One(m), .. } => write!(f, "{}: {m}", self.status),
            Body::Standard { message: Message::Many(m), .. } => {
                write!(f, "{}: {}", self.status, m.join("; "))
            }
            Body::Raw(body) => write!(f, "{}: {body}", self.status),
        }
    }
}

impl StdError for AppError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_deref().map(|e| e as &(dyn StdError + 'static))
    }
}

impl From<sea_orm::DbErr> for AppError {
    fn from(err: sea_orm::DbErr) -> Self {
        Self::internal(err)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StandardBody<'a> {
    status_code: u16,
    message: &'a Message,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if let Some(source) = &self.source {
            tracing::error!(status = %self.status, error = %source, "request failed");
        }
        match &self.body {
            Body::Standard { message, with_error } => {
                let body = StandardBody {
                    status_code: self.status.as_u16(),
                    message,
                    error: with_error.then(|| reason(self.status)),
                };
                (self.status, Json(body)).into_response()
            }
            Body::Raw(body) => (self.status, Json(body)).into_response(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use serde_json::json;

    async fn render(err: AppError) -> (StatusCode, Value) {
        let res = err.into_response();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn bare_status_has_no_error_field() {
        let (status, body) = render(AppError::unauthorized()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, json!({"statusCode": 401, "message": "Unauthorized"}));
    }

    #[tokio::test]
    async fn custom_message_adds_the_reason() {
        let (_, body) = render(AppError::entity_not_found("Issue", "AUTH-1")).await;
        assert_eq!(
            body,
            json!({"statusCode": 404, "message": "Issue \"AUTH-1\" not found", "error": "Not Found"})
        );
    }

    #[tokio::test]
    async fn validation_lists_messages() {
        let (_, body) = render(AppError::validation(vec!["a".into(), "b".into()])).await;
        assert_eq!(body, json!({"statusCode": 400, "message": ["a", "b"], "error": "Bad Request"}));
    }

    #[tokio::test]
    async fn internal_hides_the_cause() {
        let (status, body) = render(AppError::internal("db exploded")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({"statusCode": 500, "message": "Internal server error"}));
    }

    #[tokio::test]
    async fn raw_body_is_sent_as_is() {
        let err = AppError::with_body(StatusCode::SERVICE_UNAVAILABLE, json!({"status": "error"}));
        assert_eq!(render(err).await.1, json!({"status": "error"}));
    }
}
