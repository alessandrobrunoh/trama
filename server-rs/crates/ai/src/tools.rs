//! The assistant's tools (`server/src/ai/assistant-tools.service.ts`): the same MCP server
//! external clients use, reached with a temporary API token that acts as the person.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use sea_orm::DatabaseConnection;
use serde_json::{Map, Value, json};
use trama_auth::tokens::{NewToken, create_token, revoke};
use trama_contracts::common::{ASSISTANT_TOKEN_NAME, ActorRef};
use trama_contracts::js;
use trama_contracts::roles::{ApiPermission, TokenScope, api_permissions};
use trama_core::AppError;

use crate::context::ChatScope;
use crate::provider::{AiToolDef, record};
use crate::signal::Signal;

/// Access management, workspace configuration and agent management stay out of the model's
/// reach, whatever the user's role: text it reads (an issue body, a comment) may carry a prompt
/// injection, so it must not be able to rewrite the permission policy (`PATCH /settings`), rename
/// the workspace, edit labels or customer tiers (all `workspace:write`), or create and edit
/// agents. Reading stays open.
pub const WITHHELD: [&str; 13] = [
    "tokens:read",
    "tokens:write",
    "tokens:delete",
    "members:write",
    "members:delete",
    "integrations:write",
    "integrations:delete",
    "outgoing-webhooks:write",
    "outgoing-webhooks:delete",
    "workspace:write",
    "workspace:delete",
    "agents:write",
    "agents:delete",
];

/// `ASSISTANT_PERMISSIONS`: every permission of the catalog except the withheld ones.
#[must_use]
pub fn assistant_permissions() -> Vec<ApiPermission> {
    api_permissions().into_iter().filter(|p| !WITHHELD.contains(&p.to_string().as_str())).collect()
}

/// Per-token burst caps for one chat turn (the daily cap is enforced per user by the service).
fn token_limits() -> Value {
    json!({ "requestsPerMinute": 120, "writesPerMinute": 20, "writesPerDay": 200 })
}

const TOKEN_TTL: chrono::TimeDelta = chrono::TimeDelta::minutes(10);
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TOOL_RESULT_CHARS: usize = 16_000;
/// Long free-text and bookkeeping fields the model rarely needs when scanning a list.
const BULKY_FIELDS: [&str; 9] = [
    "body",
    "description",
    "context",
    "objective",
    "rationale",
    "statement",
    "workspaceId",
    "aliases",
    "acceptanceCriteria",
];
/// The generic REST escape hatch is not offered to the model; dedicated tools cover the product.
const HIDDEN_TOOLS: [&str; 1] = ["api_request"];

/// Lists are slimmed (bulky fields dropped) so more rows fit in the model's window, and prefixed
/// with their length because models miscount long lists. Details: use `get_*`.
#[must_use]
pub fn compact_result(text: &str) -> String {
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    let slim: Vec<Value> = rows
        .into_iter()
        .map(|row| match row {
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .filter(|(key, _)| !BULKY_FIELDS.contains(&key.as_str()))
                    .collect(),
            ),
            other => other,
        })
        .collect();
    let plural = if slim.len() == 1 { "" } else { "s" };
    format!("{} result{plural}:\n{}", slim.len(), Value::Array(slim))
}

/// One tool of the MCP server.
#[derive(Clone, Debug, PartialEq)]
pub struct McpTool {
    /// Tool name.
    pub name: String,
    /// What it does.
    pub description: String,
    /// JSON Schema of the arguments.
    pub parameters: Value,
    /// `annotations.readOnlyHint`.
    pub read_only: bool,
}

impl McpTool {
    /// The definition offered to the model.
    #[must_use]
    pub fn definition(&self) -> AiToolDef {
        AiToolDef {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        }
    }
}

/// What a tool returned, for the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResult {
    /// The text.
    pub text: String,
    /// Whether the tool reported a failure.
    pub is_error: bool,
}

/// An open conversation with the tools.
#[async_trait]
pub trait McpSession: Send + Sync {
    /// The tools on offer.
    fn tools(&self) -> &[McpTool];

    /// Runs a tool.
    ///
    /// # Errors
    ///
    /// The server could not be reached or answered something unusable (or `signal` fired).
    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        signal: &Signal,
    ) -> Result<ToolResult, AppError>;

    /// Ends the session (deletes the temporary token).
    async fn close(self: Box<Self>);
}

/// Gives the assistant its tools.
#[async_trait]
pub trait AssistantTools: Send + Sync {
    /// Whether `MCP_URL` is set.
    fn enabled(&self) -> bool;

    /// Opens a session acting as the person in `scope`.
    ///
    /// # Errors
    ///
    /// The token could not be created or the server did not list its tools.
    async fn open(
        &self,
        scope: &ChatScope,
        signal: &Signal,
    ) -> Result<Box<dyn McpSession>, AppError>;
}

/// The MCP server over HTTP with a temporary `custom` API token per chat turn.
#[derive(Clone)]
pub struct McpTools {
    db: DatabaseConnection,
    url: Option<String>,
    client: Client,
}

impl McpTools {
    /// Tools at `url` (`MCP_URL`; `None` disables them).
    #[must_use]
    pub fn new(db: DatabaseConnection, url: Option<String>, client: Client) -> Self {
        Self { db, url, client }
    }
}

#[async_trait]
impl AssistantTools for McpTools {
    fn enabled(&self) -> bool {
        self.url.is_some()
    }

    async fn open(
        &self,
        scope: &ChatScope,
        signal: &Signal,
    ) -> Result<Box<dyn McpSession>, AppError> {
        let Some(url) = self.url.clone() else {
            return Err(AppError::internal("MCP_URL is not set"));
        };
        let user_id = scope.user_id.clone().unwrap_or_default();
        let (token, secret) = create_token(
            &self.db,
            NewToken {
                workspace_id: scope.workspace_id.clone(),
                name: ASSISTANT_TOKEN_NAME.to_owned(),
                actor: ActorRef::user(user_id.clone()),
                scope: Some(TokenScope::Custom),
                permissions: Some(assistant_permissions()),
                limits: Some(token_limits()),
                created_by_user_id: Some(user_id),
                expires_at: Some((Utc::now() + TOKEN_TTL).fixed_offset()),
            },
        )
        .await?;
        let mut session = HttpSession {
            db: self.db.clone(),
            token_id: token.id,
            client: self.client.clone(),
            url,
            secret,
            next_id: AtomicU64::new(0),
            tools: Vec::new(),
        };
        match session.list_tools(signal).await {
            Ok(tools) => {
                session.tools = tools;
                Ok(Box::new(session))
            }
            Err(error) => {
                Box::new(session).close().await;
                Err(error)
            }
        }
    }
}

struct HttpSession {
    db: DatabaseConnection,
    token_id: String,
    client: Client,
    url: String,
    secret: String,
    next_id: AtomicU64,
    tools: Vec<McpTool>,
}

/// `String(value)` of a JSON value, as JavaScript writes it.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

impl HttpSession {
    /// One JSON-RPC call; the result object.
    async fn rpc(
        &self,
        method: &str,
        params: Value,
        signal: &Signal,
    ) -> Result<Map<String, Value>, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let request = async {
            let response = self
                .client
                .post(&self.url)
                .header("Authorization", format!("Bearer {}", self.secret))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .body(body.to_string())
                .send()
                .await
                .map_err(AppError::internal)?;
            if !response.status().is_success() {
                return Err(AppError::internal(format!(
                    "MCP server answered HTTP {}",
                    response.status().as_u16()
                )));
            }
            let bytes = response.bytes().await.map_err(AppError::internal)?;
            serde_json::from_slice::<Value>(&bytes).map_err(AppError::internal)
        };
        let reply = tokio::select! {
            () = signal.cancelled() => return Err(AppError::internal("The tool request was cancelled.")),
            done = tokio::time::timeout(RPC_TIMEOUT, request) => match done {
                Ok(reply) => reply?,
                Err(_) => return Err(AppError::internal("The tool request timed out.")),
            },
        };
        let body = record(&reply);
        if let Some(error) = body.and_then(|b| b.get("error")).and_then(record) {
            return Err(AppError::internal(format!(
                "MCP error: {}",
                js_string(error.get("message"))
            )));
        }
        body.and_then(|b| b.get("result"))
            .and_then(record)
            .cloned()
            .ok_or_else(|| AppError::internal("MCP server sent an invalid reply"))
    }

    async fn list_tools(&self, signal: &Signal) -> Result<Vec<McpTool>, AppError> {
        let result = self.rpc("tools/list", json!({}), signal).await?;
        let mut tools = Vec::new();
        for entry in result.get("tools").and_then(Value::as_array).into_iter().flatten() {
            let Some(tool) = record(entry) else { continue };
            let Some(name) = tool.get("name").and_then(Value::as_str) else { continue };
            if HIDDEN_TOOLS.contains(&name) {
                continue;
            }
            tools.push(McpTool {
                name: name.to_owned(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                parameters: tool
                    .get("inputSchema")
                    .filter(|s| s.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                read_only: tool
                    .get("annotations")
                    .and_then(record)
                    .and_then(|a| a.get("readOnlyHint"))
                    == Some(&Value::Bool(true)),
            });
        }
        Ok(tools)
    }
}

#[async_trait]
impl McpSession for HttpSession {
    fn tools(&self) -> &[McpTool] {
        &self.tools
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        signal: &Signal,
    ) -> Result<ToolResult, AppError> {
        let result =
            self.rpc("tools/call", json!({ "name": name, "arguments": args }), signal).await?;
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(record)
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .map(|c| match c.get("text") {
                None | Some(Value::Null) => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let is_error = result.get("isError") == Some(&Value::Bool(true));
        let slim = if is_error { text } else { compact_result(&text) };
        let text = if js::len(&slim) > MAX_TOOL_RESULT_CHARS {
            format!(
                "{}\n… [truncated; use filters to narrow the query]",
                js::truncate(&slim, MAX_TOOL_RESULT_CHARS)
            )
        } else {
            slim
        };
        Ok(ToolResult { text, is_error })
    }

    async fn close(self: Box<Self>) {
        if let Err(error) = revoke(&self.db, &self.token_id).await {
            tracing::warn!("could not delete temporary token: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use trama_auth::permissions::required_permission;

    use super::*;

    fn has(permissions: &[ApiPermission], wanted: &str) -> bool {
        permissions.iter().any(|p| p.to_string() == wanted)
    }

    #[test]
    fn the_assistant_token_cannot_rewrite_configuration_manage_agents_or_touch_access_management() {
        let permissions = assistant_permissions();
        for p in [
            "workspace:write",
            "workspace:delete",
            "agents:write",
            "agents:delete",
            "tokens:read",
            "tokens:write",
            "members:write",
            "integrations:write",
            "outgoing-webhooks:write",
        ] {
            assert!(!has(&permissions, p), "{p}");
        }
    }

    #[test]
    fn the_assistant_token_keeps_what_it_needs_to_read_and_manage_work_items() {
        let permissions = assistant_permissions();
        for p in [
            "workspace:read",
            "agents:read",
            "tasks:write",
            "projects:write",
            "artifacts:write",
            "comments:write",
            "search:read",
        ] {
            assert!(has(&permissions, p), "{p}");
        }
    }

    #[test]
    fn the_assistant_token_cannot_call_the_routes_that_hold_policy_or_workspace_identity() {
        let permissions = assistant_permissions();
        for (method, route) in [
            ("PATCH", "/api/w/:slug/settings"),
            ("PATCH", "/api/w/:slug"),
            ("POST", "/api/w/:slug/labels"),
            ("POST", "/api/w/:slug/agents"),
            ("PATCH", "/api/w/:slug/agents/:id"),
        ] {
            let needed = required_permission(method, route);
            let needed = needed.unwrap_or_else(|| panic!("{method} {route} needs a permission"));
            assert!(!permissions.contains(&needed), "{method} {route}");
        }
    }

    #[test]
    fn only_lists_permissions_from_the_catalog() {
        let catalog = api_permissions();
        for p in assistant_permissions() {
            assert!(catalog.contains(&p));
        }
        assert_eq!(assistant_permissions().len(), catalog.len() - WITHHELD.len());
    }

    #[test]
    fn compact_result_drops_bulky_fields_from_lists_but_leaves_records_and_non_json_alone() {
        let list = json!([
            { "key": "BUG-1", "title": "a", "priority": "high", "body": "x".repeat(500), "workspaceId": "ws_1" },
            { "key": "BUG-2", "title": "b", "priority": "low", "body": "y" },
        ])
        .to_string();
        let out = compact_result(&list);
        assert!(out.starts_with("2 results:\n"));
        let rows: Value = serde_json::from_str(&out[out.find('\n').unwrap() + 1..]).unwrap();
        assert_eq!(
            rows,
            json!([
                { "key": "BUG-1", "title": "a", "priority": "high" },
                { "key": "BUG-2", "title": "b", "priority": "low" },
            ])
        );
        assert_eq!(compact_result("[]"), "0 results:\n[]");
        assert_eq!(compact_result("[{\"key\":\"A\"}]"), "1 result:\n[{\"key\":\"A\"}]");
        let one = json!({ "key": "BUG-1", "body": "keep" }).to_string();
        assert_eq!(compact_result(&one), one);
        assert_eq!(compact_result("# markdown"), "# markdown");
    }
}
