//! HTTP client for the Nabla REST API. The caller's API key is forwarded as a bearer token and
//! never stored (the introspection cache is keyed by its sha256) or logged.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::catalog::{Call, Method};

const WHOAMI_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX: usize = 1000;

/// What `GET /auth/token` says about the key.
#[derive(Debug)]
pub struct Whoami {
    pub slug: String,
    pub workspace_name: String,
    pub permissions: HashSet<String>,
    pub raw: Value,
}

#[derive(Debug)]
pub enum AuthError {
    /// The API rejected the key (unknown, revoked or expired).
    Unauthorized,
    /// The API could not be reached or answered unexpectedly.
    Unavailable(String),
}

pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

pub struct Upstream {
    client: reqwest::Client,
    base: String,
    max_output: usize,
    cache: Mutex<HashMap<String, (Instant, Arc<Whoami>)>>,
}

fn cache_key(api_key: &str) -> String {
    hex::encode(Sha256::digest(api_key.as_bytes()))
}

impl Upstream {
    pub fn new(base: &str, timeout: Duration, max_output: usize) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            // The key must only ever go to NABLA_API_URL, never to a redirect target.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("nabla-mcp/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { client, base: base.trim_end_matches('/').to_string(), max_output, cache: Mutex::default() })
    }

    /// Resolves a key to its workspace and permissions (cached for 30 s).
    pub async fn whoami(&self, api_key: &str) -> Result<Arc<Whoami>, AuthError> {
        let ck = cache_key(api_key);
        if let Some((at, who)) = self.cache.lock().unwrap().get(&ck) {
            if at.elapsed() < WHOAMI_TTL {
                return Ok(who.clone());
            }
        }
        let res = self
            .client
            .get(format!("{}/auth/token", self.base))
            .bearer_auth(api_key)
            .header("X-Client-Id", "nabla-mcp")
            .send()
            .await
            .map_err(|e| AuthError::Unavailable(describe_transport(&e)))?;
        match res.status().as_u16() {
            200 => {}
            401 => return Err(AuthError::Unauthorized),
            429 => return Err(AuthError::Unavailable("the API key hit its request cap; retry in a minute".into())),
            s => return Err(AuthError::Unavailable(format!("the API answered HTTP {s} to key introspection"))),
        }
        let raw: Value = res.json().await.map_err(|_| AuthError::Unavailable("the API sent an invalid introspection reply".into()))?;
        let who = Arc::new(parse_whoami(raw).ok_or_else(|| AuthError::Unavailable("unexpected introspection reply".into()))?);
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_MAX {
            cache.retain(|_, (at, _)| at.elapsed() < WHOAMI_TTL);
            if cache.len() >= CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(ck, (Instant::now(), who.clone()));
        Ok(who)
    }

    /// Executes a resolved call inside the key's workspace and renders it as tool output.
    pub async fn call(&self, api_key: &str, slug: &str, call: &Call) -> ToolOutput {
        let url = format!("{}/w/{}{}", self.base, crate::catalog::encode_segment(slug), call.path);
        let mut req = match call.method {
            Method::Get => self.client.get(&url),
            Method::Post => self.client.post(&url),
            Method::Patch => self.client.patch(&url),
            Method::Delete => self.client.delete(&url),
        }
        .bearer_auth(api_key)
        .header("X-Client-Id", "nabla-mcp")
        .header("Accept", "application/json, text/markdown;q=0.9");
        if !call.query.is_empty() {
            req = req.query(&call.query);
        }
        if let Some(body) = &call.body {
            req = req.json(body);
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => return ToolOutput { text: format!("Could not reach the Nabla API: {}", describe_transport(&e)), is_error: true },
        };
        let status = res.status();
        let text = match res.text().await {
            Ok(t) => t,
            Err(e) => return ToolOutput { text: format!("Could not read the API reply: {}", describe_transport(&e)), is_error: true },
        };
        if status.is_success() {
            let text = if status.as_u16() == 204 || text.is_empty() { "OK (no content)".to_string() } else { truncate(text, self.max_output) };
            return ToolOutput { text, is_error: false };
        }
        let mut message = api_error_message(&text);
        if status.as_u16() == 429 {
            message.push_str(" (usage cap of this API key: wait before retrying; do not loop)");
        }
        ToolOutput { text: format!("HTTP {}: {message}", status.as_u16()), is_error: true }
    }
}

fn parse_whoami(raw: Value) -> Option<Whoami> {
    let slug = raw.pointer("/workspace/slug")?.as_str()?.to_string();
    let workspace_name = raw.pointer("/workspace/name")?.as_str()?.to_string();
    let permissions = raw.get("permissions")?.as_array()?.iter().filter_map(|p| p.as_str().map(str::to_string)).collect();
    Some(Whoami { slug, workspace_name, permissions, raw })
}

fn describe_transport(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "connection failed".into()
    } else {
        "request failed".into()
    }
}

/// Nest errors look like `{ statusCode, message: string | string[], error }`.
fn api_error_message(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(|v| v.get("message")).map(|m| match m {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    });
    truncate(message.unwrap_or_else(|| body.trim().to_string()), 2000)
}

fn truncate(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let total = text.len();
    text.truncate(cut);
    text.push_str(&format!("\n… [truncated: showing {cut} of {total} bytes; narrow the query with filters]"));
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_nest_errors() {
        assert_eq!(api_error_message(r#"{"statusCode":400,"message":["a is required","b must be x"],"error":"Bad Request"}"#), "a is required; b must be x");
        assert_eq!(api_error_message(r#"{"statusCode":403,"message":"nope"}"#), "nope");
        assert_eq!(api_error_message("gateway down"), "gateway down");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        let out = truncate("è".repeat(100), 51);
        assert!(out.starts_with("è"));
        assert!(out.contains("truncated"));
        assert_eq!(truncate("short".into(), 100), "short");
    }

    #[test]
    fn parses_introspection() {
        let who = parse_whoami(json!({ "workspace": { "slug": "acme", "name": "Acme", "id": "ws_1" }, "permissions": ["issues:read", 3], "token": {} })).unwrap();
        assert_eq!(who.slug, "acme");
        assert!(who.permissions.contains("issues:read") && who.permissions.len() == 1);
        assert!(parse_whoami(json!({ "workspace": {} })).is_none());
    }
}
