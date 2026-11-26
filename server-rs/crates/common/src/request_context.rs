//! Per-request values any code below a handler can read without threading them through: the
//! `X-Client-Id` of the request (echoed on live events so the tab that made a change can skip
//! its own echo). The port of `server/src/events/request-store.ts`.
//!
//! The value lives in a tokio task-local set by [`layer`] for the duration of the handler. It
//! does not follow work moved to another task: read [`client_id`] before `tokio::spawn` and
//! pass it along (or wrap the spawned future in [`scope`]).

use std::future::Future;

use axum::Router;
use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;

/// The longest client id kept, in characters (the NestJS `slice(0, 64)`).
pub const MAX_CLIENT_ID_LEN: usize = 64;

tokio::task_local! {
    static CLIENT_ID: Option<String>;
}

/// The `X-Client-Id` of the request being handled, if it sent one.
#[must_use]
pub fn client_id() -> Option<String> {
    CLIENT_ID.try_with(Clone::clone).ok().flatten()
}

/// Runs `fut` with `client_id` as the current client id.
pub async fn scope<F: Future>(client_id: Option<String>, fut: F) -> F::Output {
    CLIENT_ID.scope(client_id, fut).await
}

/// The client id a request carries: its `X-Client-Id` header (repeated headers joined with
/// `, `, bytes read as Latin-1 like Node does), cut to [`MAX_CLIENT_ID_LEN`] characters.
#[must_use]
pub fn client_id_of(headers: &axum::http::HeaderMap) -> Option<String> {
    let mut values = headers.get_all("x-client-id").iter().peekable();
    values.peek()?;
    let joined: String = values
        .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect::<String>())
        .collect::<Vec<_>>()
        .join(", ");
    Some(joined.chars().take(MAX_CLIENT_ID_LEN).collect())
}

async fn set_client_id(req: Request, next: Next) -> Response {
    let id = client_id_of(req.headers());
    scope(id, next.run(req)).await
}

/// Adds the middleware that sets [`client_id`] for every request to `router`.
pub fn layer<S: Clone + Send + Sync + 'static>(router: Router<S>) -> Router<S> {
    router.layer(middleware::from_fn(set_client_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn echo(header: Option<&str>) -> String {
        let app =
            layer(Router::new().route("/", get(|| async { client_id().unwrap_or_default() })));
        let mut req = Request::get("/");
        if let Some(h) = header {
            req = req.header("x-client-id", h);
        }
        let res = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn exposes_the_header_to_the_handler() {
        assert_eq!(echo(Some("tab-1")).await, "tab-1");
        assert_eq!(echo(None).await, "");
        assert_eq!(echo(Some(&"x".repeat(100))).await.len(), MAX_CLIENT_ID_LEN);
    }

    #[tokio::test]
    async fn is_unset_outside_a_request_and_scoped_inside() {
        assert_eq!(client_id(), None);
        let inner = scope(Some("a".into()), async { client_id() }).await;
        assert_eq!(inner.as_deref(), Some("a"));
        assert_eq!(client_id(), None);
    }
}
