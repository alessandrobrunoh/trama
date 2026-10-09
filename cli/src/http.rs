//! HTTP client for the Trama REST API.
//!
//! The key goes only to the configured API URL: redirects are never followed. Reads are retried on
//! transport failures and 502/503/504; writes and 429s are never retried.

use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, HeaderMap};
use serde_json::Value;

use crate::catalog::{Call, Method, encode_segment};
use crate::error::{CliError, Result};

pub const USER_AGENT: &str = concat!("trama-cli/", env!("CARGO_PKG_VERSION"));
const CLIENT_ID: &str = "trama-cli";

pub const ACCEPT_JSON: &str = "application/json";
pub const ACCEPT_MARKDOWN: &str = "text/markdown, application/json;q=0.5";

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub content_type: String,
    pub body: String,
    pub headers: HeaderMap,
}

impl Reply {
    pub fn is_json(&self) -> bool {
        self.content_type.contains("json")
    }

    /// Parsed JSON body; `204`/empty → `Null`.
    pub fn json(&self) -> Result<Value> {
        if self.body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&self.body).map_err(|_| CliError::internal("the API sent a reply that is not JSON"))
    }

    pub fn into_result(self) -> Result<Reply> {
        if (200..300).contains(&self.status) { Ok(self) } else { Err(CliError::from_http(self.status, &self.body)) }
    }
}

/// What to send; `path` is relative to the API base (starts with `/`).
pub struct Request<'a> {
    pub method: Method,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub body: Option<&'a Value>,
    pub token: Option<&'a str>,
    pub accept: &'a str,
    pub cookie: Option<&'a str>,
}

impl<'a> Request<'a> {
    pub fn get(path: &'a str) -> Self {
        Self { method: Method::Get, path, query: &[], body: None, token: None, accept: ACCEPT_JSON, cookie: None }
    }

    pub fn token(mut self, token: &'a str) -> Self {
        self.token = Some(token);
        self
    }
}

pub struct Api {
    client: reqwest::Client,
    base: String,
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the request timed out".into()
    } else if e.is_connect() {
        "could not connect to the API".into()
    } else if e.is_builder() {
        "invalid request".into()
    } else {
        "the request failed".into()
    }
}

impl Api {
    pub fn new(base: &str, timeout: Duration) -> Result<Api> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| CliError::internal(format!("cannot build the HTTP client: {e}")))?;
        Ok(Api { client, base: base.trim_end_matches('/').to_string() })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Workspace route (`/w/{slug}{call.path}`).
    pub async fn workspace(&self, token: &str, slug: &str, call: &Call, accept: &str) -> Result<Reply> {
        let path = format!("/w/{}{}", encode_segment(slug), call.path);
        self.send(&Request { method: call.method, path: &path, query: &call.query, body: call.body.as_ref(), token: Some(token), accept, cookie: None }).await
    }

    /// One request, with bounded retries for idempotent reads. Non-2xx replies are returned, not raised.
    pub async fn send(&self, r: &Request<'_>) -> Result<Reply> {
        let attempts = if r.method == Method::Get { 3 } else { 1 };
        let mut last: Option<CliError> = None;
        for attempt in 0..attempts {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(250 * 3u64.pow(attempt as u32 - 1))).await;
            }
            match self.once(r).await {
                Ok(reply) if matches!(reply.status, 502..=504) && attempt + 1 < attempts => {
                    last = Some(CliError::from_http(reply.status, &reply.body));
                }
                Ok(reply) => return Ok(reply),
                Err(e) if attempt + 1 < attempts => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| CliError::network("the request failed")))
    }

    async fn once(&self, r: &Request<'_>) -> Result<Reply> {
        let url = format!("{}{}", self.base, r.path);
        let mut req = match r.method {
            Method::Get => self.client.get(&url),
            Method::Post => self.client.post(&url),
            Method::Patch => self.client.patch(&url),
            Method::Delete => self.client.delete(&url),
        }
        .header(ACCEPT, r.accept)
        .header("X-Client-Id", CLIENT_ID);
        if let Some(t) = r.token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        if let Some(c) = r.cookie {
            req = req.header(COOKIE, c);
        }
        if !r.query.is_empty() {
            req = req.query(r.query);
        }
        if let Some(body) = r.body {
            req = req.json(body);
        }
        let res = req.send().await.map_err(|e| CliError::network(format!("{}: {}", describe(&e), self.base)))?;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let body = res.text().await.map_err(|e| CliError::network(format!("could not read the reply: {}", describe(&e))))?;
        Ok(Reply { status, content_type, body, headers })
    }

    /// Opens a streaming GET (Server-Sent Events). The caller reads chunks.
    pub async fn stream(&self, token: &str, path: &str) -> Result<reqwest::Response> {
        let url = format!("{}{}", self.base, path);
        // No overall timeout on a stream: build a dedicated client.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| CliError::internal(format!("cannot build the HTTP client: {e}")))?;
        let res = client
            .get(&url)
            .header(ACCEPT, "text/event-stream")
            .header("X-Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| CliError::network(format!("{}: {}", describe(&e), self.base)))?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(CliError::from_http(status, &body));
        }
        Ok(res)
    }
}

/// Extracts `name=value` from the `Set-Cookie` headers of a reply.
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(reqwest::header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).find_map(|line| {
        let first = line.split(';').next()?.trim();
        let (k, v) = first.split_once('=')?;
        (k == name && !v.is_empty()).then(|| format!("{k}={v}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, SET_COOKIE};

    #[test]
    fn reads_session_cookie() {
        let mut h = HeaderMap::new();
        h.append(SET_COOKIE, HeaderValue::from_static("other=1; Path=/"));
        h.append(SET_COOKIE, HeaderValue::from_static("trama_session=abc123; HttpOnly; Path=/; SameSite=Lax"));
        assert_eq!(cookie_value(&h, "trama_session").as_deref(), Some("trama_session=abc123"));
        assert_eq!(cookie_value(&h, "missing"), None);
        h.clear();
        h.append(SET_COOKIE, HeaderValue::from_static("trama_session=; Max-Age=0"));
        assert_eq!(cookie_value(&h, "trama_session"), None);
    }
}
