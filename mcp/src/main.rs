//! Trama MCP server: exposes the Trama REST API as MCP tools, authenticated by a per-client
//! API key (Settings → API tokens). Streamable HTTP (stateless) by default, `--stdio` for local use.

mod catalog;
mod generic;
mod protocol;
mod upstream;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use protocol::Server;
use upstream::{AuthError, Upstream};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

struct Config {
    api_url: String,
    bind: SocketAddr,
    allowed_origins: Vec<String>,
    max_output: usize,
    timeout: Duration,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let api_url = env("TRAMA_API_URL").unwrap_or_else(|| "http://localhost:3000/api".into());
        if !(api_url.starts_with("http://") || api_url.starts_with("https://")) {
            return Err("TRAMA_API_URL must start with http:// or https://".into());
        }
        let bind = env("MCP_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()).parse().map_err(|e| format!("MCP_BIND: {e}"))?;
        let number = |name: &str, default: u64| -> Result<u64, String> {
            env(name).map_or(Ok(default), |v| v.parse().map_err(|_| format!("{name} must be a number")))
        };
        Ok(Self {
            api_url,
            bind,
            allowed_origins: env("MCP_ALLOWED_ORIGINS").map(|v| v.split(',').map(|o| o.trim().to_string()).collect()).unwrap_or_default(),
            max_output: number("MCP_MAX_OUTPUT_BYTES", 200_000)? as usize,
            timeout: Duration::from_secs(number("MCP_UPSTREAM_TIMEOUT_SECS", 30)?),
        })
    }
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

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, key) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && key.starts_with("nbl_") && key.len() <= 256 && !key.contains(' ')).then_some(key)
}

async fn mcp_post(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    // Browsers always send Origin; MCP clients don't. Reject unless explicitly allowed (DNS rebinding).
    if let Some(origin) = headers.get(header::ORIGIN) {
        let allowed = origin.to_str().is_ok_and(|o| app.allowed_origins.iter().any(|a| a == o));
        if !allowed {
            return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
        }
    }
    let Some(key) = bearer(&headers) else {
        return unauthorized("Missing API key: send 'Authorization: Bearer nbl_…' (create one in Trama → Settings → API tokens)");
    };
    let who = match app.server.upstream.whoami(key).await {
        Ok(w) => w,
        Err(AuthError::Unauthorized) => return unauthorized("Invalid, revoked or expired API key"),
        Err(AuthError::Unavailable(m)) => {
            tracing::warn!("upstream unavailable: {m}");
            return (StatusCode::BAD_GATEWAY, format!("Trama API unavailable: {m}")).into_response();
        }
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }))).into_response();
        }
    };
    let reply = match message {
        Value::Array(items) if !items.is_empty() => {
            let mut replies = Vec::new();
            for item in items {
                replies.extend(app.server.handle(key, &who, item).await);
            }
            (!replies.is_empty()).then(|| Value::Array(replies))
        }
        Value::Array(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid Request" } })),
        other => app.server.handle(key, &who, other).await,
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
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

async fn run_http(app: Arc<App>, bind: SocketAddr) -> Result<(), String> {
    let router = Router::new()
        .route("/mcp", post(mcp_post).get(mcp_unsupported).delete(mcp_unsupported))
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(bind).await.map_err(|e| format!("bind {bind}: {e}"))?;
    tracing::info!("listening on http://{bind}/mcp");
    axum::serve(listener, router).with_graceful_shutdown(shutdown_signal()).await.map_err(|e| e.to_string())
}

/// Newline-delimited JSON-RPC on stdin/stdout, authenticated by `TRAMA_API_KEY`.
async fn run_stdio(app: Arc<App>) -> Result<(), String> {
    let key = env("TRAMA_API_KEY").ok_or("--stdio needs TRAMA_API_KEY")?;
    if !key.starts_with("nbl_") {
        return Err("TRAMA_API_KEY must start with nbl_".into());
    }
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
            Ok(msg) => match app.server.upstream.whoami(&key).await {
                Ok(who) => app.server.handle(&key, &who, msg).await,
                Err(e) => msg.get("id").map(|id| {
                    let text = match e {
                        AuthError::Unauthorized => "Invalid, revoked or expired API key".to_string(),
                        AuthError::Unavailable(m) => format!("Trama API unavailable: {m}"),
                    };
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": text } })
                }),
            },
        };
        if let Some(r) = reply {
            stdout.write_all(r.to_string().as_bytes()).await.map_err(|e| e.to_string())?;
            stdout.write_all(b"\n").await.map_err(|e| e.to_string())?;
            stdout.flush().await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    // Logs go to stderr so stdout stays clean for the stdio transport.
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    if let Err(e) = start().await {
        eprintln!("trama-mcp: {e}");
        std::process::exit(1);
    }
}

async fn start() -> Result<(), String> {
    let cfg = Config::from_env()?;
    let upstream = Upstream::new(&cfg.api_url, cfg.timeout, cfg.max_output).map_err(|e| e.to_string())?;
    let server = Server::new(upstream)?;
    tracing::info!(tools = server.tool_count(), api = %cfg.api_url, "trama-mcp {}", env!("CARGO_PKG_VERSION"));
    let app = Arc::new(App { server, allowed_origins: cfg.allowed_origins });
    if std::env::args().any(|a| a == "--stdio") { run_stdio(app).await } else { run_http(app, cfg.bind).await }
}
