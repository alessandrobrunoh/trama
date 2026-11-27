//! Picking the tracker adapter and turning its failures into HTTP errors
//! (`createAdapter` / `providerFailure` of `importers/credentials.service.ts`).

use std::fmt::Write as _;

use axum::http::StatusCode;
use serde_json::Value;
use trama_contracts::imports::{ExternalProvider, ImportSource};
use trama_core::AppError;
use trama_integrations::Http;

use crate::credentials::ResolvedCredential;
use crate::github_adapter::GithubAdapter;
use crate::linear_adapter::LinearAdapter;
use crate::mapping::redact_secrets;
use crate::types::{ImportSourceAdapter, SourceError};

/// `str(v)` of the adapters: a non-empty string, else nothing.
pub(crate) fn non_empty(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// JavaScript's `String(value)` for a JSON value that may be missing.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), js_number_string),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| if v.is_null() { String::new() } else { js_string(Some(v)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// A number the way JavaScript prints it: whole numbers without a fraction.
pub(crate) fn js_number_string(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 { format!("{n:.0}") } else { n.to_string() }
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The adapter for `provider`, reading `source` with `cred`.
///
/// # Errors
///
/// 400 when a GitHub source has no repository or a Linear import has no API key.
pub fn create_adapter(
    http: Http,
    provider: ExternalProvider,
    cred: &ResolvedCredential,
    source: &ImportSource,
) -> Result<Box<dyn ImportSourceAdapter>, AppError> {
    match provider {
        ExternalProvider::Github => {
            let repository =
                source.repository.clone().filter(|r| !r.is_empty()).ok_or_else(|| {
                    AppError::bad_request("source.repository is required (owner/name)")
                })?;
            Ok(Box::new(GithubAdapter::new(
                http,
                cred.token.clone(),
                repository,
                cred.base_url.clone(),
            )))
        }
        ExternalProvider::Linear => {
            let token = cred
                .token
                .clone()
                .ok_or_else(|| AppError::bad_request("A Linear API key is required"))?;
            Ok(Box::new(LinearAdapter::new(
                http,
                token,
                source.team_ids.clone().unwrap_or_default(),
            )))
        }
    }
}

/// Turns a failed provider call into the HTTP error the caller should see. The message never
/// carries a token.
#[must_use]
pub fn provider_failure(label: &str, e: &SourceError, secrets: &[Option<&str>]) -> AppError {
    match e {
        SourceError::Provider(p) => {
            let message = redact_secrets(&p.message, secrets);
            if let Some(until) = p.rate_limited_until {
                return AppError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!(
                        "{label} rate limit reached; try again after {}",
                        trama_core::time::to_iso(&until)
                    ),
                );
            }
            if matches!(p.status, 401 | 403 | 404) {
                return AppError::bad_request(format!("{label} rejected the request ({message})"));
            }
            AppError::new(StatusCode::BAD_GATEWAY, format!("{label} failed: {message}"))
        }
        SourceError::Transport(_) | SourceError::Unexpected(_) => AppError::new(
            StatusCode::BAD_GATEWAY,
            format!("{label} is unreachable: {}", redact_secrets(&e.to_string(), secrets)),
        ),
    }
}

/// A mocked [`trama_integrations::HttpClient`] for the adapter tests: answers from a function
/// and records every request. No network.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::Value;
    use trama_integrations::{Http, HttpClient, HttpFailure, HttpRequest, HttpResponse};

    /// The requests a [`FakeHttp`] has seen.
    pub(crate) type Calls = Arc<Mutex<Vec<HttpRequest>>>;

    type Route = dyn Fn(&HttpRequest) -> Option<HttpResponse> + Send + Sync;

    pub(crate) struct FakeHttp {
        calls: Calls,
        route: Box<Route>,
    }

    impl FakeHttp {
        /// A client answering with `route`; `None` is a failed request.
        #[allow(clippy::new_ret_no_self)]
        pub(crate) fn new(
            route: impl Fn(&HttpRequest) -> Option<HttpResponse> + Send + Sync + 'static,
        ) -> (Http, Calls) {
            let calls = Calls::default();
            let fake = Self { calls: Arc::clone(&calls), route: Box::new(route) };
            (Http::new(fake), calls)
        }
    }

    #[async_trait]
    impl HttpClient for FakeHttp {
        async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            let answer = (self.route)(&req);
            let url = req.url.clone();
            self.calls.lock().unwrap().push(req);
            answer.ok_or_else(|| HttpFailure(format!("unexpected request {url}")))
        }
    }

    /// A 200 answer.
    pub(crate) fn reply(json: Value) -> HttpResponse {
        reply_with(200, json, &[])
    }

    /// An answer with a status and headers.
    pub(crate) fn reply_with(status: u16, json: Value, headers: &[(&str, &str)]) -> HttpResponse {
        HttpResponse {
            status,
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect::<BTreeMap<_, _>>(),
            json,
        }
    }
}
