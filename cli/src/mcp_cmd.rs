//! `trama mcp`: the MCP server over stdio, authenticated by the saved profile, plus `trama mcp config`.
//!
//! It reuses the hosted server's protocol layer (`mcp/src/protocol.rs`), so the tools are identical.
//! stdout carries only JSON-RPC; everything else goes to stderr.

use clap::ArgMatches;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::Ctx;
use crate::config;
use crate::error::{CliError, Result};
use crate::output;
use crate::protocol::Server;
use crate::upstream::{AuthError, Upstream};

const MAX_OUTPUT_BYTES: usize = 200_000;

pub async fn serve(ctx: &Ctx) -> Result<()> {
    let creds = config::resolve(&ctx.ov)?;
    let upstream = Upstream::new(&creds.url, ctx.timeout, MAX_OUTPUT_BYTES).map_err(|e| CliError::internal(e.to_string()))?;
    let server = Server::new(upstream).map_err(CliError::internal)?;
    eprintln!("trama mcp: {} tools, API {}", server.tool_count(), creds.url);

    let key = creds.token;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
            Ok(msg) => match server.upstream.whoami(&key).await {
                Ok(who) => server.handle(&key, &who, msg).await,
                Err(e) => msg.get("id").map(|id| {
                    let text = match e {
                        AuthError::Unauthorized => "Invalid, revoked or expired API key (run `trama login`)".to_string(),
                        AuthError::Unavailable(m) => format!("Trama API unavailable: {m}"),
                    };
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": text } })
                }),
            },
        };
        if let Some(r) = reply {
            stdout.write_all(r.to_string().as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

/// Hosted MCP endpoint that belongs to an API URL (`…/api` → `…/mcp`).
fn mcp_url(api_url: &str) -> String {
    match api_url.strip_suffix("/api") {
        Some(origin) => format!("{origin}/mcp"),
        None => format!("{api_url}/mcp"),
    }
}

/// The text to paste into the MCP client's configuration.
pub fn snippet(client: &str, transport: &str, api_url: &str) -> String {
    if transport == "http" {
        let url = mcp_url(api_url);
        return match client {
            "claude" => format!("claude mcp add --transport http trama {url} \\\n  --header \"Authorization: Bearer nbl_YOUR_TOKEN\""),
            "cursor" | "json" => serde_json::to_string_pretty(&json!({ "mcpServers": { "trama": { "url": url, "headers": { "Authorization": "Bearer nbl_YOUR_TOKEN" } } } })).unwrap_or_default(),
            "vscode" => serde_json::to_string_pretty(&json!({ "servers": { "trama": { "type": "http", "url": url, "headers": { "Authorization": "Bearer nbl_YOUR_TOKEN" } } } })).unwrap_or_default(),
            _ => format!("[mcp_servers.trama]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"Bearer nbl_YOUR_TOKEN\" }}"),
        };
    }
    match client {
        "claude" => "claude mcp add trama -- trama mcp".to_string(),
        "cursor" | "json" => serde_json::to_string_pretty(&json!({ "mcpServers": { "trama": { "command": "trama", "args": ["mcp"] } } })).unwrap_or_default(),
        "vscode" => serde_json::to_string_pretty(&json!({ "servers": { "trama": { "type": "stdio", "command": "trama", "args": ["mcp"] } } })).unwrap_or_default(),
        _ => "[mcp_servers.trama]\ncommand = \"trama\"\nargs = [\"mcp\"]".to_string(),
    }
}

pub fn config_snippet(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let client = m.get_one::<String>("client").expect("has default");
    let transport = m.get_one::<String>("transport").expect("has default");
    let url = config::resolve(&ctx.ov).map(|c| c.url).ok().or_else(|| config::env("TRAMA_API_URL")).unwrap_or_else(|| config::DEFAULT_API_URL.to_string());
    output::emit(&snippet(client, transport, &url));
    if transport == "stdio" {
        eprintln!("(`trama mcp` uses your saved login; run `trama login` first. For CI set TRAMA_API_KEY and TRAMA_API_URL instead.)");
    } else {
        eprintln!("(Create the token in Settings → API tokens and replace nbl_YOUR_TOKEN.)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_mcp_url() {
        assert_eq!(mcp_url("https://trama.example.com/api"), "https://trama.example.com/mcp");
        assert_eq!(mcp_url("http://localhost:3000/api"), "http://localhost:3000/mcp");
    }

    #[test]
    fn snippets_cover_every_client() {
        assert_eq!(snippet("claude", "stdio", "https://x/api"), "claude mcp add trama -- trama mcp");
        assert!(snippet("claude", "http", "https://x/api").contains("--transport http trama https://x/mcp"));
        let v: Value = serde_json::from_str(&snippet("cursor", "stdio", "")).unwrap();
        assert_eq!(v["mcpServers"]["trama"]["args"][0], "mcp");
        let v: Value = serde_json::from_str(&snippet("vscode", "http", "https://x/api")).unwrap();
        assert_eq!(v["servers"]["trama"]["url"], "https://x/mcp");
        assert!(snippet("codex", "stdio", "").contains("[mcp_servers.trama]"));
    }
}
