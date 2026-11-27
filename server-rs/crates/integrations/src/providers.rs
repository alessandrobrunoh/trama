//! Git provider clients (`providers.ts`): the slice of the GitHub, GitLab and Bitbucket APIs the
//! integrations need. Every call goes through [`Http`], hence through the SSRF guard.

use async_trait::async_trait;
use axum::http::Method;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Duration, Utc};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::{Value, json};
use trama_contracts::common::GitProvider;
use trama_core::config::js_number;
use utoipa::ToSchema;

use crate::candidates::StateReason;
use crate::http::{Http, HttpFailure, HttpRequest, HttpResponse, ProviderHttpError};

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// A repository of a provider, as the picker shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepository {
    /// `owner/name`.
    pub full_name: String,
    /// Web URL.
    pub url: String,
    /// Default branch.
    pub default_branch: String,
    /// Private repository.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One page of [`RemoteRepository`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepositoryPage {
    /// The repositories of this page.
    pub items: Vec<RemoteRepository>,
    /// Page number, from 1.
    pub page: u32,
    /// Page size.
    pub per_page: u32,
    /// Is there a next page?
    pub has_more: bool,
}

/// Why a provider call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    /// The provider answered with a non-2xx status (or something unusable).
    Status(ProviderHttpError),
    /// The request did not complete: blocked, timed out, refused, redirected.
    Unreachable(String),
}

impl From<HttpFailure> for ProviderError {
    fn from(value: HttpFailure) -> Self {
        Self::Unreachable(value.0)
    }
}

impl From<ProviderHttpError> for ProviderError {
    fn from(value: ProviderHttpError) -> Self {
        Self::Status(value)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(e) => write!(f, "{e}"),
            Self::Unreachable(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ProviderError {}

/// The slice of a git provider API the integrations need today.
#[async_trait]
pub trait GitProviderClient: Send + Sync {
    /// Validates the credential; returns the account (login / username).
    async fn current_user(&self) -> Result<String, ProviderError>;

    /// One page of the repositories the credential can see.
    async fn list_repositories(
        &self,
        page: u32,
        per_page: u32,
    ) -> Result<RemoteRepositoryPage, ProviderError>;

    /// One repository by `owner/name`.
    async fn get_repository(&self, full_name: &str) -> Result<RemoteRepository, ProviderError>;

    /// Does this host implement [`GitProviderClient::set_issue_state`]? Only hosts whose issues
    /// Trama mirrors do.
    fn can_set_issue_state(&self) -> bool {
        false
    }

    /// Closes or reopens one issue (not a pull request) of a repository. Routing rules in
    /// two-way mode call it.
    ///
    /// # Errors
    ///
    /// [`ProviderError`] when the host does not support it or the call fails.
    async fn set_issue_state(
        &self,
        _full_name: &str,
        _number: i64,
        _open: bool,
        _reason: Option<StateReason>,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::Status(ProviderHttpError::new(
            501,
            "This provider does not support changing issues",
        )))
    }
}

fn describe_error(res: &HttpResponse) -> String {
    let text = |key: &str| res.json.get(key).and_then(Value::as_str).map(str::to_owned);
    match text("message").or_else(|| text("error")) {
        Some(m) if !m.is_empty() => format!("{}: {m}", res.status),
        _ => res.status.to_string(),
    }
}

/// `Number(header)` when it is a finite number.
fn finite(res: &HttpResponse, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|n| res.header(n)).and_then(js_number).filter(|n| n.is_finite())
}

/// Errors with [`ProviderHttpError`] (with rate-limit info) for non-2xx responses.
///
/// # Errors
///
/// See above.
pub fn ensure_ok(res: &HttpResponse) -> Result<(), ProviderHttpError> {
    if (200..300).contains(&res.status) {
        return Ok(());
    }
    let remaining =
        res.header("x-ratelimit-remaining").or_else(|| res.header("ratelimit-remaining"));
    let retry_after = finite(res, &["retry-after"]);
    let reset = finite(res, &["x-ratelimit-reset", "ratelimit-reset"]);
    if res.status == 429 || (res.status == 403 && (remaining == Some("0") || retry_after.is_some()))
    {
        let fallback = Utc::now() + Duration::seconds(60);
        #[allow(clippy::cast_possible_truncation)]
        let until: DateTime<Utc> = match (retry_after, reset) {
            (Some(seconds), _) => DateTime::from_timestamp_millis(
                Utc::now().timestamp_millis() + (seconds * 1000.0) as i64,
            )
            .unwrap_or(fallback),
            (None, Some(epoch)) => {
                DateTime::from_timestamp_millis((epoch * 1000.0) as i64).unwrap_or(fallback)
            }
            (None, None) => fallback,
        };
        return Err(ProviderHttpError {
            status: res.status,
            message: format!("Rate limited ({})", describe_error(res)),
            rate_limited_until: Some(until),
        });
    }
    Err(ProviderHttpError::new(res.status, describe_error(res)))
}

/// Normalizes a base URL: `origin + path` without trailing slashes. `None` for blank input.
///
/// # Errors
///
/// The message of the problem (`Invalid URL`, `baseUrl must be http(s)`, `baseUrl must not
/// contain credentials`), as `new URL` and `normalizeBaseUrl` word it.
pub fn normalize_base_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(trama_contracts::js::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let url = url::Url::parse(raw).map_err(|_| "Invalid URL".to_owned())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("baseUrl must be http(s)".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return Err("baseUrl must not contain credentials".to_owned());
    }
    Ok(Some(format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/'))))
}

/// JavaScript's `String(value)` for a JSON value that may be missing.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(_) | Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// JavaScript truthiness of a JSON value (`Boolean(x)`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn user_agent(req: HttpRequest) -> HttpRequest {
    req.header("User-Agent", "trama")
}

async fn send(http: &Http, req: HttpRequest) -> Result<HttpResponse, ProviderError> {
    let res = http.request(req).await?;
    ensure_ok(&res)?;
    Ok(res)
}

// ───────────────────────────── GitHub ─────────────────────────────

/// GitHub and GitHub Enterprise (REST).
pub struct GithubClient {
    http: Http,
    token: String,
    api: String,
}

impl GithubClient {
    /// A client for `base_url` (`None` or github.com: the public API).
    #[must_use]
    pub fn new(http: Http, token: impl Into<String>, base_url: Option<&str>) -> Self {
        let base = base_url.unwrap_or("https://github.com");
        let host = base.strip_prefix("https://").or_else(|| base.strip_prefix("http://"));
        let api = if host.is_some_and(|h| h.strip_prefix("www.").unwrap_or(h) == "github.com") {
            "https://api.github.com".to_owned()
        } else if base.ends_with("/api/v3") {
            base.to_owned()
        } else {
            format!("{base}/api/v3")
        };
        Self { http, token: token.into(), api }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<HttpResponse, ProviderError> {
        let mut req = user_agent(
            HttpRequest::new(method, format!("{}{path}", self.api))
                .header("Authorization", format!("Bearer {}", self.token))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28"),
        );
        if let Some(body) = body {
            req = req.json(body);
        }
        send(&self.http, req).await
    }

    fn map(r: &Value) -> RemoteRepository {
        RemoteRepository {
            full_name: js_string(r.get("full_name")),
            url: js_string(r.get("html_url")),
            default_branch: str_of(r, "default_branch").unwrap_or("main").to_owned(),
            private: Some(truthy(r.get("private"))),
            description: str_of(r, "description").map(str::to_owned),
        }
    }
}

#[async_trait]
impl GitProviderClient for GithubClient {
    async fn current_user(&self) -> Result<String, ProviderError> {
        let res = self.call(Method::GET, "/user", None).await?;
        match str_of(&res.json, "login").filter(|l| !l.is_empty()) {
            Some(login) => Ok(login.to_owned()),
            None => {
                Err(ProviderHttpError::new(502, "Unexpected response from GitHub /user").into())
            }
        }
    }

    async fn list_repositories(
        &self,
        page: u32,
        per_page: u32,
    ) -> Result<RemoteRepositoryPage, ProviderError> {
        let res = self
            .call(
                Method::GET,
                &format!("/user/repos?per_page={per_page}&page={page}&sort=pushed"),
                None,
            )
            .await?;
        let items =
            res.json.as_array().map(|l| l.iter().map(Self::map).collect()).unwrap_or_default();
        Ok(RemoteRepositoryPage {
            items,
            page,
            per_page,
            has_more: res.header("link").is_some_and(|l| l.contains("rel=\"next\"")),
        })
    }

    async fn get_repository(&self, full_name: &str) -> Result<RemoteRepository, ProviderError> {
        Ok(Self::map(&self.call(Method::GET, &format!("/repos/{full_name}"), None).await?.json))
    }

    fn can_set_issue_state(&self) -> bool {
        true
    }

    async fn set_issue_state(
        &self,
        full_name: &str,
        number: i64,
        open: bool,
        reason: Option<StateReason>,
    ) -> Result<(), ProviderError> {
        let state_reason =
            if open { "reopened" } else { reason.unwrap_or(StateReason::Completed).as_str() };
        let state = if open { "open" } else { "closed" };
        self.call(
            Method::PATCH,
            &format!("/repos/{full_name}/issues/{number}"),
            Some(json!({ "state": state, "state_reason": state_reason })),
        )
        .await?;
        Ok(())
    }
}

// ───────────────────────────── GitLab ─────────────────────────────

/// GitLab and self-hosted GitLab (API v4).
pub struct GitlabClient {
    http: Http,
    token: String,
    api: String,
}

impl GitlabClient {
    /// A client for `base_url` (`None`: gitlab.com).
    #[must_use]
    pub fn new(http: Http, token: impl Into<String>, base_url: Option<&str>) -> Self {
        Self {
            http,
            token: token.into(),
            api: format!("{}/api/v4", base_url.unwrap_or("https://gitlab.com")),
        }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<HttpResponse, ProviderError> {
        let mut req = user_agent(
            HttpRequest::new(method, format!("{}{path}", self.api))
                .header("PRIVATE-TOKEN", self.token.clone())
                .header("Accept", "application/json"),
        );
        if let Some(body) = body {
            req = req.json(body);
        }
        send(&self.http, req).await
    }

    fn map(r: &Value) -> RemoteRepository {
        RemoteRepository {
            full_name: js_string(r.get("path_with_namespace")),
            url: js_string(r.get("web_url")),
            default_branch: str_of(r, "default_branch").unwrap_or("main").to_owned(),
            private: r.get("visibility").map(|v| v.as_str() != Some("public")),
            description: str_of(r, "description").map(str::to_owned),
        }
    }
}

#[async_trait]
impl GitProviderClient for GitlabClient {
    async fn current_user(&self) -> Result<String, ProviderError> {
        let res = self.call(Method::GET, "/user", None).await?;
        match str_of(&res.json, "username").filter(|l| !l.is_empty()) {
            Some(name) => Ok(name.to_owned()),
            None => {
                Err(ProviderHttpError::new(502, "Unexpected response from GitLab /user").into())
            }
        }
    }

    async fn list_repositories(
        &self,
        page: u32,
        per_page: u32,
    ) -> Result<RemoteRepositoryPage, ProviderError> {
        let res = self
            .call(
                Method::GET,
                &format!(
                    "/projects?membership=true&simple=true&per_page={per_page}&page={page}&order_by=last_activity_at"
                ),
                None,
            )
            .await?;
        let items =
            res.json.as_array().map(|l| l.iter().map(Self::map).collect()).unwrap_or_default();
        Ok(RemoteRepositoryPage {
            items,
            page,
            per_page,
            has_more: res.header("x-next-page").is_some_and(|v| !v.is_empty()),
        })
    }

    async fn get_repository(&self, full_name: &str) -> Result<RemoteRepository, ProviderError> {
        let path = format!("/projects/{}", encode_component(full_name));
        Ok(Self::map(&self.call(Method::GET, &path, None).await?.json))
    }

    fn can_set_issue_state(&self) -> bool {
        true
    }

    async fn set_issue_state(
        &self,
        full_name: &str,
        number: i64,
        open: bool,
        _reason: Option<StateReason>,
    ) -> Result<(), ProviderError> {
        self.call(
            Method::PUT,
            &format!("/projects/{}/issues/{number}", encode_component(full_name)),
            Some(json!({ "state_event": if open { "reopen" } else { "close" } })),
        )
        .await?;
        Ok(())
    }
}

// ───────────────────────────── Bitbucket ─────────────────────────────

/// Bitbucket Cloud (API 2.0). The credential is either an Atlassian API token, entered as
/// `email:token` (HTTP Basic), or a repository / workspace access token (Bearer).
pub struct BitbucketClient {
    http: Http,
    credential: String,
}

impl BitbucketClient {
    const API: &'static str = "https://api.bitbucket.org/2.0";

    /// A client for `credential`.
    #[must_use]
    pub fn new(http: Http, credential: impl Into<String>) -> Self {
        Self { http, credential: credential.into() }
    }

    fn authorization(&self) -> String {
        if self.credential.contains(':') {
            format!("Basic {}", STANDARD.encode(&self.credential))
        } else {
            format!("Bearer {}", self.credential)
        }
    }

    async fn get(&self, path: &str) -> Result<HttpResponse, ProviderError> {
        let req = user_agent(
            HttpRequest::get(format!("{}{path}", Self::API))
                .header("Authorization", self.authorization())
                .header("Accept", "application/json"),
        );
        send(&self.http, req).await
    }

    fn map(r: &Value) -> RemoteRepository {
        let full_name = js_string(r.get("full_name"));
        let url = r
            .get("links")
            .and_then(|l| l.get("html"))
            .and_then(|h| h.get("href"))
            .and_then(Value::as_str)
            .map_or_else(|| format!("https://bitbucket.org/{full_name}"), str::to_owned);
        RemoteRepository {
            url,
            default_branch: r
                .get("mainbranch")
                .and_then(|m| m.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("main")
                .to_owned(),
            private: r.get("is_private").and_then(Value::as_bool),
            description: str_of(r, "description").filter(|d| !d.is_empty()).map(str::to_owned),
            full_name,
        }
    }
}

#[async_trait]
impl GitProviderClient for BitbucketClient {
    async fn current_user(&self) -> Result<String, ProviderError> {
        let res = self.get("/user").await?;
        let account = str_of(&res.json, "nickname")
            .filter(|n| !n.is_empty())
            .or_else(|| str_of(&res.json, "display_name").filter(|n| !n.is_empty()));
        match account {
            Some(account) => Ok(account.to_owned()),
            None => {
                Err(ProviderHttpError::new(502, "Unexpected response from Bitbucket /user").into())
            }
        }
    }

    async fn list_repositories(
        &self,
        page: u32,
        per_page: u32,
    ) -> Result<RemoteRepositoryPage, ProviderError> {
        let res = self
            .get(&format!("/user/permissions/repositories?pagelen={per_page}&page={page}"))
            .await?;
        let items = res
            .json
            .get("values")
            .and_then(Value::as_array)
            .map(|values| {
                values.iter().filter_map(|v| v.get("repository")).map(Self::map).collect()
            })
            .unwrap_or_default();
        Ok(RemoteRepositoryPage {
            items,
            page,
            per_page,
            has_more: res.json.get("next").is_some_and(Value::is_string),
        })
    }

    async fn get_repository(&self, full_name: &str) -> Result<RemoteRepository, ProviderError> {
        let path: Vec<String> = full_name.split('/').map(encode_component).collect();
        Ok(Self::map(&self.get(&format!("/repositories/{}", path.join("/"))).await?.json))
    }
}

/// The client for a provider (`createGitClient`). Bitbucket Cloud has no custom base URL.
#[must_use]
pub fn create_git_client(
    provider: GitProvider,
    http: &Http,
    token: &str,
    base_url: Option<&str>,
) -> Box<dyn GitProviderClient> {
    match provider {
        GitProvider::Github => Box::new(GithubClient::new(http.clone(), token, base_url)),
        GitProvider::Gitlab => Box::new(GitlabClient::new(http.clone(), token, base_url)),
        GitProvider::Bitbucket => Box::new(BitbucketClient::new(http.clone(), token)),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::http::HttpClient;

    type Seen = Arc<Mutex<Vec<HttpRequest>>>;

    struct Canned {
        seen: Seen,
        status: u16,
        headers: Vec<(&'static str, &'static str)>,
        json: Value,
    }

    #[async_trait]
    impl HttpClient for Canned {
        async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            self.seen.lock().unwrap().push(req);
            Ok(HttpResponse {
                status: self.status,
                headers: self
                    .headers
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect::<BTreeMap<_, _>>(),
                json: self.json.clone(),
            })
        }
    }

    fn http(status: u16, headers: Vec<(&'static str, &'static str)>, json: Value) -> (Http, Seen) {
        let seen = Seen::default();
        (Http::new(Canned { seen: seen.clone(), status, headers, json }), seen)
    }

    fn response(status: u16, headers: &[(&str, &str)], json: Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            json,
        }
    }

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(normalize_base_url(None), Ok(None));
        assert_eq!(normalize_base_url(Some("  ")), Ok(None));
        assert_eq!(
            normalize_base_url(Some(" https://GHE.example.com/sub/// ")),
            Ok(Some("https://ghe.example.com/sub".to_owned()))
        );
        assert_eq!(
            normalize_base_url(Some("https://x.dev:8443/?a=1#h")),
            Ok(Some("https://x.dev:8443".to_owned()))
        );
        assert_eq!(normalize_base_url(Some("not a url")), Err("Invalid URL".to_owned()));
        assert_eq!(
            normalize_base_url(Some("ftp://x.dev")),
            Err("baseUrl must be http(s)".to_owned())
        );
        assert_eq!(
            normalize_base_url(Some("https://u:p@x.dev")),
            Err("baseUrl must not contain credentials".to_owned())
        );
    }

    #[test]
    fn ensure_ok_describes_failures_and_rate_limits() {
        assert!(ensure_ok(&response(204, &[], Value::Null)).is_ok());
        let err =
            ensure_ok(&response(401, &[], json!({ "message": "Bad credentials" }))).unwrap_err();
        assert_eq!((err.status, err.message.as_str()), (401, "401: Bad credentials"));
        assert!(!err.rate_limited());
        assert_eq!(ensure_ok(&response(500, &[], Value::Null)).unwrap_err().message, "500");
        assert_eq!(
            ensure_ok(&response(404, &[], json!({ "error": "gone" }))).unwrap_err().message,
            "404: gone"
        );

        let limited =
            ensure_ok(&response(429, &[("retry-after", "30")], json!({ "message": "slow" })))
                .unwrap_err();
        assert!(limited.rate_limited());
        assert_eq!(limited.message, "Rate limited (429: slow)");
        let until = limited.rate_limited_until.unwrap();
        let wait = (until - Utc::now()).num_seconds();
        assert!((28..=30).contains(&wait), "{wait}");

        let exhausted =
            ensure_ok(&response(403, &[("x-ratelimit-remaining", "0")], Value::Null)).unwrap_err();
        assert!(exhausted.rate_limited(), "403 with no quota left is rate limiting");
        let forbidden =
            ensure_ok(&response(403, &[("x-ratelimit-remaining", "9")], Value::Null)).unwrap_err();
        assert!(!forbidden.rate_limited());
        let reset = ensure_ok(&response(429, &[("x-ratelimit-reset", "4102444800")], Value::Null))
            .unwrap_err();
        assert_eq!(reset.rate_limited_until.unwrap().timestamp(), 4_102_444_800);
    }

    #[tokio::test]
    async fn github_talks_to_the_public_api_or_an_enterprise_host() {
        let (http, seen) = http(200, vec![], json!({ "login": "octo" }));
        for (base, expected) in [
            (None, "https://api.github.com/user"),
            (Some("https://github.com"), "https://api.github.com/user"),
            (Some("https://www.github.com"), "https://api.github.com/user"),
            (Some("https://ghe.example.com"), "https://ghe.example.com/api/v3/user"),
            (Some("https://ghe.example.com/api/v3"), "https://ghe.example.com/api/v3/user"),
        ] {
            let client = GithubClient::new(http.clone(), "tok", base);
            assert_eq!(client.current_user().await.unwrap(), "octo");
            assert_eq!(seen.lock().unwrap().last().unwrap().url, expected);
        }
        let last = seen.lock().unwrap().last().unwrap().clone();
        assert!(last.headers.contains(&("Authorization".to_owned(), "Bearer tok".to_owned())));
        assert!(last.headers.contains(&("User-Agent".to_owned(), "trama".to_owned())));
    }

    #[tokio::test]
    async fn github_lists_repositories_and_reports_the_next_page() {
        let (http, seen) = http(
            200,
            vec![("link", "<https://api.github.com/x?page=2>; rel=\"next\"")],
            json!([{
                "full_name": "octo/app", "html_url": "https://github.com/octo/app",
                "default_branch": "trunk", "private": true, "description": "An app"
            }, { "full_name": "octo/lib", "html_url": "https://github.com/octo/lib" }]),
        );
        let page = GithubClient::new(http, "tok", None).list_repositories(1, 30).await.unwrap();
        assert!(page.has_more);
        assert_eq!(page.items[0].default_branch, "trunk");
        assert_eq!(page.items[0].private, Some(true));
        assert_eq!(page.items[0].description.as_deref(), Some("An app"));
        assert_eq!(page.items[1].default_branch, "main");
        assert_eq!(page.items[1].private, Some(false));
        assert_eq!(
            seen.lock().unwrap()[0].url,
            "https://api.github.com/user/repos?per_page=30&page=1&sort=pushed"
        );
    }

    #[tokio::test]
    async fn github_changes_the_state_of_an_issue() {
        let (http, seen) = http(200, vec![], json!({}));
        let client = GithubClient::new(http, "tok", None);
        client.set_issue_state("octo/app", 7, false, None).await.unwrap();
        client.set_issue_state("octo/app", 7, false, Some(StateReason::NotPlanned)).await.unwrap();
        client.set_issue_state("octo/app", 7, true, Some(StateReason::NotPlanned)).await.unwrap();
        let bodies: Vec<Value> =
            seen.lock().unwrap().iter().map(|r| r.body.clone().unwrap()).collect();
        assert_eq!(bodies[0], json!({ "state": "closed", "state_reason": "completed" }));
        assert_eq!(bodies[1], json!({ "state": "closed", "state_reason": "not_planned" }));
        assert_eq!(bodies[2], json!({ "state": "open", "state_reason": "reopened" }));
        assert_eq!(seen.lock().unwrap()[0].method, Method::PATCH);
    }

    #[tokio::test]
    async fn github_reports_a_failed_state_change_from_the_mock_transport() {
        let (http, seen) = http(500, vec![], json!({ "message": "provider unavailable" }));
        let error = GithubClient::new(http, "placeholder-token", None)
            .set_issue_state("octo/app", 7, false, None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("provider unavailable"));
        let request = seen.lock().unwrap().pop().unwrap();
        assert_eq!(request.method, Method::PATCH);
        assert_eq!(request.url, "https://api.github.com/repos/octo/app/issues/7");
        assert_eq!(
            request.headers.iter().find(|(key, _)| key == "Authorization").unwrap().1,
            "Bearer placeholder-token"
        );
    }

    #[tokio::test]
    async fn gitlab_encodes_project_paths() {
        let (http, seen) = http(
            200,
            vec![("x-next-page", "2")],
            json!([{ "path_with_namespace": "grp/sub/app", "web_url": "https://gitlab.com/grp/sub/app",
                "visibility": "private" }]),
        );
        let client = GitlabClient::new(http, "tok", Some("https://git.acme.dev"));
        let page = client.list_repositories(2, 10).await.unwrap();
        assert!(page.has_more);
        assert_eq!(page.items[0].private, Some(true));
        client.get_repository("grp/sub/app").await.unwrap();
        client.set_issue_state("grp/sub/app", 3, true, None).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen[0].url,
            "https://git.acme.dev/api/v4/projects?membership=true&simple=true&per_page=10&page=2&order_by=last_activity_at"
        );
        assert_eq!(seen[1].url, "https://git.acme.dev/api/v4/projects/grp%2Fsub%2Fapp");
        assert_eq!(seen[2].method, Method::PUT);
        assert_eq!(seen[2].url, "https://git.acme.dev/api/v4/projects/grp%2Fsub%2Fapp/issues/3");
        assert_eq!(seen[2].body, Some(json!({ "state_event": "reopen" })));
        assert!(seen[0].headers.contains(&("PRIVATE-TOKEN".to_owned(), "tok".to_owned())));
    }

    #[tokio::test]
    async fn bitbucket_uses_basic_or_bearer_auth() {
        let (http, seen) = http(200, vec![], json!({ "nickname": "bb", "display_name": "B B" }));
        assert_eq!(
            BitbucketClient::new(http.clone(), "me@x.dev:tok").current_user().await.unwrap(),
            "bb"
        );
        assert_eq!(BitbucketClient::new(http, "repo-token").current_user().await.unwrap(), "bb");
        let seen = seen.lock().unwrap();
        let auth = |i: usize| {
            seen[i].headers.iter().find(|(k, _)| k == "Authorization").unwrap().1.clone()
        };
        assert_eq!(auth(0), format!("Basic {}", STANDARD.encode("me@x.dev:tok")));
        assert_eq!(auth(1), "Bearer repo-token");
        assert_eq!(seen[0].url, "https://api.bitbucket.org/2.0/user");
    }

    #[tokio::test]
    async fn bitbucket_maps_repositories() {
        let (http, _) = http(
            200,
            vec![],
            json!({ "values": [{ "repository": {
                "full_name": "ws/app", "is_private": false, "description": "",
                "mainbranch": { "name": "develop" },
                "links": { "html": { "href": "https://bitbucket.org/ws/app" } } } }],
              "next": "https://api.bitbucket.org/2.0/x?page=2" }),
        );
        let page = BitbucketClient::new(http, "t").list_repositories(1, 30).await.unwrap();
        assert!(page.has_more);
        assert_eq!(
            page.items[0],
            RemoteRepository {
                full_name: "ws/app".into(),
                url: "https://bitbucket.org/ws/app".into(),
                default_branch: "develop".into(),
                private: Some(false),
                description: None,
            }
        );
    }

    #[tokio::test]
    async fn a_credential_the_provider_refuses_is_a_status_error() {
        let (refusing, _) = http(401, vec![], json!({ "message": "Bad credentials" }));
        let err = GithubClient::new(refusing, "bad", None).current_user().await.unwrap_err();
        assert_eq!(err, ProviderError::Status(ProviderHttpError::new(401, "401: Bad credentials")));
        let (http, _) = http(200, vec![], json!({}));
        let err = GitlabClient::new(http, "t", None).current_user().await.unwrap_err();
        assert_eq!(err.to_string(), "Unexpected response from GitLab /user");
    }

    #[tokio::test]
    async fn bitbucket_has_no_issue_api() {
        let (http, _) = http(200, vec![], json!({}));
        let client = create_git_client(GitProvider::Bitbucket, &http, "t", None);
        assert!(!client.can_set_issue_state());
        assert!(client.set_issue_state("a/b", 1, true, None).await.is_err());
    }
}
