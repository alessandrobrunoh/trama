//! Trama MCP server: exposes the Trama REST API as MCP tools, authenticated by a per-client
//! API key (Settings → API tokens). Streamable HTTP (stateless) by default, `--stdio` for local use.

mod catalog;
mod composite;
mod generic;
mod profile;
mod protocol;
mod upstream;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use profile::Profile;
use protocol::{Account, Server};
use upstream::{AuthError, Upstream};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

struct Config {
    api_url: String,
    bind: SocketAddr,
    allowed_origins: Vec<String>,
    max_output: usize,
    timeout: Duration,
    /// Tool profile when a request does not ask for one (`TRAMA_MCP_PROFILE`, then `--profile`).
    profile: Profile,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let api_url = env("TRAMA_API_URL").unwrap_or_else(|| "http://localhost:3000/api".into());
        if !(api_url.starts_with("http://") || api_url.starts_with("https://")) {
            return Err("TRAMA_API_URL must start with http:// or https://".into());
        }
        let bind = env("MCP_BIND")
            .unwrap_or_else(|| "127.0.0.1:8787".into())
            .parse()
            .map_err(|e| format!("MCP_BIND: {e}"))?;
        let number = |name: &str, default: u64| -> Result<u64, String> {
            env(name).map_or(Ok(default), |v| {
                v.parse().map_err(|_| format!("{name} must be a number"))
            })
        };
        Ok(Self {
            api_url,
            bind,
            allowed_origins: env("MCP_ALLOWED_ORIGINS")
                .map(|v| v.split(',').map(|o| o.trim().to_string()).collect())
                .unwrap_or_default(),
            max_output: number("MCP_MAX_OUTPUT_BYTES", 200_000)? as usize,
            timeout: Duration::from_secs(number("MCP_UPSTREAM_TIMEOUT_SECS", 30)?),
            profile: profile_arg()?.map_or_else(Profile::from_env, Ok)?,
        })
    }
}

/// `--profile core|full` (or `--profile=full`) on the command line.
fn profile_arg() -> Result<Option<Profile>, String> {
    let args: Vec<String> = std::env::args().collect();
    let value = args.iter().enumerate().find_map(|(i, a)| match a.strip_prefix("--profile=") {
        Some(v) => Some(v.to_string()),
        None if a == "--profile" => args.get(i + 1).cloned(),
        None => None,
    });
    match value {
        None => Ok(None),
        Some(v) => Profile::parse(&v).map(Some).ok_or_else(|| format!("--profile must be 'core' or 'full' (got '{v}')")),
    }
}

/// The profile one HTTP request asks for: `?profile=` on the URL, else the `X-Trama-Profile`
/// header, else the server default. Anything unrecognised falls back to the default.
fn request_profile(default: Profile, headers: &HeaderMap, query: &HashMap<String, String>) -> Profile {
    query
        .get("profile")
        .map(String::as_str)
        .or_else(|| headers.get("x-trama-profile").and_then(|v| v.to_str().ok()))
        .and_then(Profile::parse)
        .unwrap_or(default)
}

struct App {
    server: Server,
    allowed_origins: Vec<String>,
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"trama-mcp\""))],
        Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32001, "message": message } })),
    )
        .into_response()
}

/// The keys a request brought. One, as `Authorization: Bearer nbl_…`, or several, separated by
/// commas or in repeated headers. `X-Trama-Api-Keys` carries the rest when a client can only send
/// one Authorization header. Each key is still bound to one workspace.
fn bearer_keys(headers: &HeaderMap) -> Vec<String> {
    let mut raw: Vec<String> = vec![];
    for value in headers.get_all(header::AUTHORIZATION) {
        let Ok(value) = value.to_str() else { continue };
        let Some((scheme, rest)) = value.split_once(' ') else {
            continue;
        };
        if scheme.eq_ignore_ascii_case("bearer") {
            raw.extend(rest.split([',', ' ']).map(str::to_string));
        }
    }
    if let Some(extra) = headers
        .get("x-trama-api-keys")
        .and_then(|v| v.to_str().ok())
    {
        raw.extend(extra.split([',', ' ']).map(str::to_string));
    }
    let mut keys: Vec<String> = raw
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect();
    keys.dedup();
    keys
}

fn valid_key(key: &str) -> bool {
    key.starts_with("nbl_") && key.len() <= 256 && !key.contains(char::is_whitespace)
}

async fn mcp_post(State(app): State<Arc<App>>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap, body: Bytes) -> Response {
    // Browsers always send Origin; MCP clients don't. Reject unless explicitly allowed (DNS rebinding).
    if let Some(origin) = headers.get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|o| app.allowed_origins.iter().any(|a| a == o));
        if !allowed {
            return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
        }
    }
    let keys = bearer_keys(&headers);
    if keys.is_empty() || keys.iter().any(|k| !valid_key(k)) {
        return unauthorized(
            "Missing API key: send 'Authorization: Bearer nbl_…' (create one in Trama → Settings → API tokens). Send several, comma-separated, to cover more than one workspace.",
        );
    }
    let accounts = match resolve_keys(&app.server, &keys).await {
        Ok(a) => a,
        Err(failure) => return failure_response(failure),
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }))).into_response();
        }
    };
    let profile = request_profile(app.server.profile(), &headers, &query);
    let reply = match message {
        Value::Array(items) if !items.is_empty() => {
            let mut replies = Vec::new();
            for item in items {
                replies.extend(app.server.handle_with(profile, &accounts, item).await);
            }
            (!replies.is_empty()).then(|| Value::Array(replies))
        }
        Value::Array(_) => Some(
            json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid Request" } }),
        ),
        other => app.server.handle_with(profile, &accounts, other).await,
    };
    match reply {
        Some(r) => Json(r).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// No server-initiated stream and no sessions to terminate.
async fn mcp_unsupported() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.ok() };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

async fn run_http(app: Arc<App>, bind: SocketAddr) -> Result<(), String> {
    let router = Router::new()
        .route(
            "/mcp",
            post(mcp_post).get(mcp_unsupported).delete(mcp_unsupported),
        )
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("bind {bind}: {e}"))?;
    tracing::info!("listening on http://{bind}/mcp");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| e.to_string())
}

/// The keys `--stdio` starts with: `TRAMA_API_KEY`, plus any extra in `TRAMA_API_KEYS` (comma or newline separated).
fn stdio_keys() -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    if let Some(key) = env("TRAMA_API_KEY") {
        keys.push(key);
    }
    if let Some(more) = env("TRAMA_API_KEYS") {
        keys.extend(
            more.split([',', '\n', ' '])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        );
    }
    keys.dedup();
    if keys.is_empty() {
        return Err("--stdio needs TRAMA_API_KEY, or several keys in TRAMA_API_KEYS".into());
    }
    if let Some(bad) = keys.iter().find(|k| !valid_key(k)) {
        return Err(format!(
            "an API key must start with nbl_ (got {})",
            &bad.chars().take(12).collect::<String>()
        ));
    }
    Ok(keys)
}

enum KeyFailure {
    Unauthorized,
    Unavailable(String),
}

/// Resolves every key to the workspace it belongs to. The first key that fails rejects the whole set:
/// a connection that silently dropped a workspace would return incomplete answers.
async fn resolve_keys(server: &Server, keys: &[String]) -> Result<Vec<Account>, KeyFailure> {
    let mut accounts = Vec::new();
    for key in keys {
        match server.upstream.whoami(key).await {
            Ok(who) => accounts.push(Account {
                key: key.clone(),
                profile: String::new(),
                who: (*who).clone(),
            }),
            Err(AuthError::Unauthorized) => return Err(KeyFailure::Unauthorized),
            Err(AuthError::Unavailable(m)) => return Err(KeyFailure::Unavailable(m)),
        }
    }
    Ok(accounts)
}

fn failure_response(failure: KeyFailure) -> Response {
    match failure {
        KeyFailure::Unauthorized => unauthorized("Invalid, revoked or expired API key"),
        KeyFailure::Unavailable(m) => {
            tracing::warn!("upstream unavailable: {m}");
            (
                StatusCode::BAD_GATEWAY,
                format!("Trama API unavailable: {m}"),
            )
                .into_response()
        }
    }
}

/// Newline-delimited JSON-RPC on stdin/stdout, authenticated by `TRAMA_API_KEY` (and `TRAMA_API_KEYS`).
async fn run_stdio(app: Arc<App>) -> Result<(), String> {
    let keys = stdio_keys()?;
    let accounts = resolve_keys(&app.server, &keys)
        .await
        .map_err(|f| match f {
            KeyFailure::Unauthorized => "invalid, revoked or expired API key".to_string(),
            KeyFailure::Unavailable(m) => format!("Trama API unavailable: {m}"),
        })?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(_) => Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }),
            ),
            Ok(msg) => app.server.handle(&accounts, msg).await,
        };
        if let Some(r) = reply {
            stdout
                .write_all(r.to_string().as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            stdout.write_all(b"\n").await.map_err(|e| e.to_string())?;
            stdout.flush().await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    // Logs go to stderr so stdout stays clean for the stdio transport.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    if let Err(e) = start().await {
        eprintln!("trama-mcp: {e}");
        std::process::exit(1);
    }
}

/// `trama-mcp --healthcheck`: exits 0 when the local server answers `/healthz` (for container
/// healthchecks in an image without a shell or curl).
fn healthcheck() -> Result<(), String> {
    use std::io::{Read, Write};
    let bind = env("MCP_BIND").unwrap_or_else(|| "127.0.0.1:8787".into());
    let port = bind.rsplit(':').next().unwrap_or("8787");
    let mut stream =
        std::net::TcpStream::connect(format!("127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream
        .write_all(b"GET /healthz HTTP/1.0\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut reply = String::new();
    stream
        .read_to_string(&mut reply)
        .map_err(|e| e.to_string())?;
    if reply.starts_with("HTTP/1.1 200") || reply.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!("unhealthy: {}", reply.lines().next().unwrap_or("")))
    }
}

async fn start() -> Result<(), String> {
    if std::env::args().any(|a| a == "--healthcheck") {
        return tokio::task::spawn_blocking(healthcheck)
            .await
            .map_err(|e| e.to_string())?;
    }
    let cfg = Config::from_env()?;
    let upstream =
        Upstream::new(&cfg.api_url, cfg.timeout, cfg.max_output).map_err(|e| e.to_string())?;
    let server = Server::new(upstream)?.with_profile(cfg.profile);
    tracing::info!(
        profile = cfg.profile.as_str(),
        listed = server.listed_count(cfg.profile),
        catalog = server.tool_count(),
        api = %cfg.api_url,
        "trama-mcp {}",
        env!("CARGO_PKG_VERSION")
    );
    let app = Arc::new(App {
        server,
        allowed_origins: cfg.allowed_origins,
    });
    if std::env::args().any(|a| a == "--stdio") {
        run_stdio(app).await
    } else {
        run_http(app, cfg.bind).await
    }
}
