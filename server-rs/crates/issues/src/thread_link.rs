//! One task links at most one thread (`server/src/issues/thread-link.ts`).

use axum::http::StatusCode;
use serde_json::json;
use trama_contracts::threads::THREAD_ALREADY_LINKED;
use trama_core::AppError;

/// The 409 for a task that already links `current`
/// (`{ statusCode, error, code, message, threadUrl }`).
#[must_use]
pub fn thread_already_linked(key: &str, current: &str) -> AppError {
    AppError::with_body(
        StatusCode::CONFLICT,
        json!({
            "statusCode": 409,
            "error": "Conflict",
            "code": THREAD_ALREADY_LINKED,
            "message": format!(
                "{key} is already linked to a thread ({current}). Unlink it first, or create a subtask and link that."
            ),
            "threadUrl": current,
        }),
    )
}

/// One task links at most one thread. Linking the same URL again is a no-op, unlinking (or not
/// sending a URL) is fine, and a different URL is refused while one is linked.
///
/// # Errors
///
/// 409 `thread_already_linked`, with the current thread in the body.
pub fn assert_thread_linkable(
    key: &str,
    current: Option<&str>,
    next: Option<&str>,
) -> Result<(), AppError> {
    let (Some(next), Some(current)) = (next, current) else { return Ok(()) };
    if current.is_empty() || current == next {
        return Ok(());
    }
    Err(thread_already_linked(key, current))
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;
    use serde_json::Value;

    use super::*;

    const A: &str = "https://delta.dev/t/a";
    const B: &str = "https://delta.dev/t/b";

    #[test]
    fn allows_a_first_link_the_same_link_again_and_unlinking() {
        assert!(assert_thread_linkable("TRM-1", None, Some(A)).is_ok());
        assert!(assert_thread_linkable("TRM-1", Some(A), Some(A)).is_ok());
        assert!(assert_thread_linkable("TRM-1", Some(A), None).is_ok());
        assert!(assert_thread_linkable("TRM-1", None, None).is_ok());
    }

    #[tokio::test]
    async fn refuses_a_different_thread_with_the_current_one_in_the_body() {
        let error = assert_thread_linkable("TRM-1", Some(A), Some(B)).unwrap_err();
        assert_eq!(error.status_code(), StatusCode::CONFLICT);
        let response = error.into_response();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["statusCode"], 409);
        assert_eq!(body["error"], "Conflict");
        assert_eq!(body["code"], "thread_already_linked");
        assert_eq!(body["threadUrl"], A);
        assert_eq!(
            body["message"],
            format!(
                "TRM-1 is already linked to a thread ({A}). Unlink it first, or create a subtask and link that."
            )
        );
    }
}
