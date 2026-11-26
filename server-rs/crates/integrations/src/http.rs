//! Outbound HTTP used for provider APIs (`http-client.ts`).
//!
//! [`HttpClient`] is the seam: the real [`FetchHttpClient`] goes through the SSRF-safe
//! `trama_common::safe_fetch`, tests register a fake with
//! `state.with_extension(Http::new(fake))`. Code that needs HTTP takes the registered client
//! with [`Http::of`].

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::http::Method;
use chrono::{DateTime, Utc};
use serde_json::Value;
use trama_common::safe_fetch::{OutboundPolicy, SafeRequest};
use trama_core::AppState;

/// Request deadline unless the caller sets one.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// One outgoing request.
#[derive(Clone, Debug)]
pub struct HttpRequest {
    /// Method (default `GET`).
    pub method: Method,
    /// Absolute URL; user-influenced (webhook target, integration base URL), so it always goes
    /// through the SSRF guard.
    pub url: String,
    /// Extra headers.
    pub headers: Vec<(String, String)>,
    /// JSON body, serialized by the client.
    pub body: Option<Value>,
    /// Exact bytes to send (already serialized); wins over `body`. Needed when the body is
    /// signed.
    pub raw_body: Option<String>,
    /// Deadline (default 15 s).
    pub timeout: Option<Duration>,
    /// Response body cap in bytes (default 10 MB).
    pub max_bytes: Option<usize>,
    /// With `max_bytes`: cut the body instead of failing; for callers that only need the status.
    pub truncate: bool,
}

impl HttpRequest {
    /// A `GET` of `url`.
    #[must_use]
    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::GET, url)
    }

    /// A request with `method` to `url`.
    #[must_use]
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            raw_body: None,
            timeout: None,
            max_bytes: None,
            truncate: false,
        }
    }

    /// Adds a header.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Sets a JSON body.
    #[must_use]
    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    /// Sets the exact bytes to send.
    #[must_use]
    pub fn raw(mut self, body: impl Into<String>) -> Self {
        self.raw_body = Some(body.into());
        self
    }

    /// Sets the deadline.
    #[must_use]
    pub const fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Caps the response body.
    #[must_use]
    pub const fn max_bytes(mut self, max: usize) -> Self {
        self.max_bytes = Some(max);
        self
    }

    /// Cuts the response body at the cap instead of failing.
    #[must_use]
    pub const fn truncate(mut self) -> Self {
        self.truncate = true;
        self
    }
}

/// A response: status, headers by lowercase name, and the body parsed as JSON (`null` when it is
/// empty or not JSON).
#[derive(Clone, Debug, PartialEq)]
pub struct HttpResponse {
    /// HTTP status.
    pub status: u16,
    /// Headers by lowercase name.
    pub headers: BTreeMap<String, String>,
    /// The JSON body, `Null` when there is none.
    pub json: Value,
}

impl HttpResponse {
    /// A header by (lowercase) name.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// The request did not complete: blocked by the SSRF guard, timed out, could not connect, or was
/// redirected (redirects are never followed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpFailure(pub String);

impl fmt::Display for HttpFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HttpFailure {}

/// Outbound HTTP for provider APIs.
#[async_trait]
pub trait HttpClient: Send + Sync + 'static {
    /// Sends the request. A non-2xx status is a normal [`HttpResponse`]; only a request that
    /// did not complete is an error.
    async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure>;
}

/// The client that talks to the network, through `safe_fetch`.
#[derive(Clone, Debug)]
pub struct FetchHttpClient {
    policy: OutboundPolicy,
}

impl FetchHttpClient {
    /// A client following `policy` (`state.config.outbound`).
    #[must_use]
    pub const fn new(policy: OutboundPolicy) -> Self {
        Self { policy }
    }
}

#[async_trait]
impl HttpClient for FetchHttpClient {
    async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
        let has_body = req.body.is_some() || req.raw_body.is_some();
        let mut safe =
            SafeRequest::new(req.method, req.url).timeout(req.timeout.unwrap_or(DEFAULT_TIMEOUT));
        if has_body && !req.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            safe = safe.header("Content-Type", "application/json");
        }
        for (name, value) in req.headers {
            safe = safe.header(name, value);
        }
        if let Some(raw) = req.raw_body {
            safe = safe.body(raw);
        } else if let Some(body) = req.body {
            safe = safe.body(body.to_string());
        }
        if let Some(max) = req.max_bytes {
            safe = safe.max_bytes(max);
        }
        if req.truncate {
            safe = safe.truncate();
        }
        let res = safe.send(&self.policy).await.map_err(|e| HttpFailure(e.to_string()))?;
        if (300..400).contains(&res.status) {
            return Err(HttpFailure(format!("Redirects are not followed (HTTP {})", res.status)));
        }
        let text = String::from_utf8_lossy(&res.body);
        let json = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        Ok(HttpResponse { status: res.status, headers: res.headers, json })
    }
}

/// The registered outbound client: a cheap handle, kept on the `AppState` as an extension.
#[derive(Clone)]
pub struct Http(Arc<dyn HttpClient>);

impl fmt::Debug for Http {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Http(..)")
    }
}

impl Http {
    /// Wraps a client; register it with `state.with_extension(Http::new(client))` (tests).
    pub fn new(client: impl HttpClient) -> Self {
        Self(Arc::new(client))
    }

    /// The client registered on `state`, else the real one with the configured outbound policy.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state
            .extension::<Self>()
            .cloned()
            .unwrap_or_else(|| Self::new(FetchHttpClient::new(state.config.outbound.clone())))
    }

    /// Sends a request.
    ///
    /// # Errors
    ///
    /// [`HttpFailure`] when the request did not complete.
    pub async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
        self.0.request(req).await
    }
}

/// The provider answered with a non-2xx status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderHttpError {
    /// HTTP status.
    pub status: u16,
    /// What the provider said (`403: Bad credentials`).
    pub message: String,
    /// Set when the response signals rate limiting.
    pub rate_limited_until: Option<DateTime<Utc>>,
}

impl ProviderHttpError {
    /// A failure without rate-limit information.
    #[must_use]
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), rate_limited_until: None }
    }

    /// Did the response signal rate limiting?
    #[must_use]
    pub const fn rate_limited(&self) -> bool {
        self.rate_limited_until.is_some()
    }
}

impl fmt::Display for ProviderHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderHttpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_real_client_refuses_internal_addresses() {
        let client = FetchHttpClient::new(OutboundPolicy::default());
        for url in ["http://127.0.0.1:1/x", "http://169.254.169.254/latest", "http://localhost/x"] {
            let err = client.request(HttpRequest::get(url)).await.unwrap_err();
            assert!(err.0.contains("not allowed"), "{url}: {err}");
        }
    }

    #[tokio::test]
    async fn the_registered_client_wins_over_the_real_one() {
        struct Fake;
        #[async_trait]
        impl HttpClient for Fake {
            async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::new(),
                    json: serde_json::json!({ "url": req.url }),
                })
            }
        }
        let state = AppState::new(
            sea_orm::DatabaseConnection::default(),
            trama_core::Config::from_vars(&[]),
        )
        .with_extension(Http::new(Fake));
        let res = Http::of(&state).request(HttpRequest::get("https://x.test/a")).await.unwrap();
        assert_eq!(res.json["url"], "https://x.test/a");
    }
}
