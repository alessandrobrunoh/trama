//! JSON request bodies with the input checks the NestJS API applies to every route.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::AppError;

/// Longest array accepted anywhere in a body: ids end up in SQL lookups, and past 65535 bind
/// parameters Postgres fails.
pub const MAX_BODY_ARRAY: usize = 1000;

/// Request body limit (the NestJS body parser's `2mb`).
pub const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

const MAX_DEPTH: usize = 20;

/// A JSON object body deserialized into `T`.
///
/// Before `T` sees it, the body must be an object (an array is refused), hold no NUL character
/// (Postgres cannot store one in text or jsonb) and no list longer than [`MAX_BODY_ARRAY`].
/// A request without a JSON content type is read as `{}`, as NestJS does. Unknown fields are
/// dropped, matching `ValidationPipe({ whitelist: true })`.
///
/// Use plain [`axum::Json`] for the rare route whose body is a list.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let value = match Json::<Value>::from_request(req, state).await {
            Ok(Json(value)) => value,
            Err(JsonRejection::MissingJsonContentType(_)) => Value::Object(serde_json::Map::new()),
            Err(rejection) => {
                return Err(AppError::new(rejection.status(), rejection.body_text()));
            }
        };
        check_body(&value)?;
        serde_json::from_value(value)
            .map(ApiJson)
            .map_err(|err| AppError::validation(vec![err.to_string()]))
    }
}

/// The checks [`ApiJson`] runs on a parsed body.
///
/// # Errors
///
/// Returns a 400 [`AppError`] naming the first problem found.
pub fn check_body(value: &Value) -> Result<(), AppError> {
    if value.is_array() {
        return Err(AppError::bad_request("Request body must be a JSON object"));
    }
    if has_nul(value, 0) {
        return Err(AppError::bad_request("Text must not contain NUL characters"));
    }
    if has_oversized_array(value, 0) {
        return Err(AppError::bad_request(format!("Lists are limited to {MAX_BODY_ARRAY} items")));
    }
    Ok(())
}

fn has_nul(value: &Value, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => items.iter().any(|v| has_nul(v, depth + 1)),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || has_nul(v, depth + 1)),
        _ => false,
    }
}

fn has_oversized_array(value: &Value, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match value {
        Value::Array(items) => {
            items.len() > MAX_BODY_ARRAY || items.iter().any(|v| has_oversized_array(v, depth + 1))
        }
        Value::Object(map) => map.values().any(|v| has_oversized_array(v, depth + 1)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{StatusCode, header};
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    struct Input {
        name: Option<String>,
    }

    async fn extract(content_type: Option<&str>, body: &str) -> Result<Input, AppError> {
        let mut req = Request::builder().method("POST").uri("/");
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let req = req.body(Body::from(body.to_owned())).unwrap();
        ApiJson::<Input>::from_request(req, &()).await.map(|ApiJson(v)| v)
    }

    #[tokio::test]
    async fn parses_and_drops_unknown_fields() {
        let input = extract(Some("application/json"), r#"{"name":"a","extra":1}"#).await.unwrap();
        assert_eq!(input.name.as_deref(), Some("a"));
    }

    #[tokio::test]
    async fn missing_content_type_reads_as_empty_object() {
        assert!(extract(None, "ignored").await.unwrap().name.is_none());
    }

    #[tokio::test]
    async fn refuses_arrays_nul_and_long_lists() {
        for body in
            [json!([1]), json!({"name": "a\u{0}b"}), json!({"ids": vec![1; MAX_BODY_ARRAY + 1]})]
        {
            let err = extract(Some("application/json"), &body.to_string()).await.unwrap_err();
            assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[tokio::test]
    async fn wrong_types_are_a_400() {
        let err = extract(Some("application/json"), r#"{"name":3}"#).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn malformed_json_is_rejected() {
        let err = extract(Some("application/json"), "{").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    }
}
