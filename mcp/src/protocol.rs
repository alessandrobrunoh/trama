//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`. Stateless: no
//! sessions and no server-initiated messages, so the same dispatcher serves Streamable HTTP and stdio.

use serde_json::{Value, json};

use crate::catalog::{Tool, load};
use crate::generic;
use crate::upstream::{ToolOutput, Upstream, Whoami};

const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const WHOAMI: &str = "whoami";

const INSTRUCTIONS: &str = "Nabla (coordination for human + AI engineering teams). The API key you connected with is bound to one workspace, so no workspace argument is needed. \
Items can be addressed by id (iss_…, wk_…) or by key (BUG-142, AUTH-42, ADR-21, team key AUTH). \
Tools you are not permitted to use are hidden; writes are limited by per-key caps (HTTP 429 means stop and report, never retry in a loop). \
In update_* tools, null clears an optional field. Start with `whoami` if unsure what this key can do.";

pub struct Server {
    tools: Vec<Tool>,
    pub upstream: Upstream,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_result(out: ToolOutput) -> Value {
    json!({ "content": [{ "type": "text", "text": out.text }], "isError": out.is_error })
}

fn tool_error(message: String) -> Value {
    tool_result(ToolOutput { text: message, is_error: true })
}

impl Server {
    pub fn new(upstream: Upstream) -> Result<Self, String> {
        Ok(Self { tools: load()?, upstream })
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }

    fn whoami_listing() -> Value {
        json!({
            "name": WHOAMI,
            "description": "Which workspace and permissions this API key has, its usage caps and expiry.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        })
    }

    /// The tools this key may use (everything else is hidden from the model).
    pub fn list_tools(&self, who: &Whoami) -> Vec<Value> {
        let mut out = vec![Self::whoami_listing()];
        out.extend(self.tools.iter().filter(|t| who.permissions.contains(&t.permission)).map(Tool::listing));
        out.push(generic::listing());
        out
    }

    /// Handles one JSON-RPC message. `None` = notification (no reply).
    pub async fn handle(&self, api_key: &str, who: &Whoami, msg: Value) -> Option<Value> {
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            // A response or garbage: nothing to answer.
            return msg.get("id").map(|id| rpc_error(id.clone(), -32600, "Invalid Request"));
        };
        let id = msg.get("id").cloned();
        let Some(id) = id else {
            return None; // notification (notifications/initialized, notifications/cancelled, …)
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = SUPPORTED.iter().find(|v| **v == requested).copied().unwrap_or(SUPPORTED[0]);
                rpc_result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "nabla-mcp", "title": "Nabla", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": format!("{INSTRUCTIONS} Workspace: {}.", who.workspace_name),
                    }),
                )
            }
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": self.list_tools(who) })),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "tools/call needs a tool name"));
                };
                let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                match self.call_tool(api_key, who, name, &args).await {
                    Some(result) => rpc_result(id, result),
                    None => rpc_error(id, -32602, &format!("Unknown tool: {name}")),
                }
            }
            _ => rpc_error(id, -32601, "Method not found"),
        })
    }

    /// `None` = no such tool.
    async fn call_tool(&self, api_key: &str, who: &Whoami, name: &str, args: &Value) -> Option<Value> {
        if name == WHOAMI {
            let mut permissions: Vec<&String> = who.permissions.iter().collect();
            permissions.sort();
            let info = json!({
                "workspace": who.raw.get("workspace"),
                "actor": who.raw.get("actor"),
                "token": who.raw.get("token"),
                "permissions": permissions,
            });
            return Some(tool_result(ToolOutput { text: info.to_string(), is_error: false }));
        }
        let call = if name == generic::NAME {
            generic::build_call(args)
        } else {
            let tool = self.tools.iter().find(|t| t.name == name)?;
            if !who.permissions.contains(&tool.permission) {
                return Some(tool_error(format!("This API key lacks the \"{}\" permission. Ask the workspace admin to grant it in Settings → API tokens.", tool.permission)));
            }
            tool.build_call(args)
        };
        let call = match call {
            Ok(c) => c,
            Err(e) => return Some(tool_error(format!("Invalid arguments: {e}"))),
        };
        tracing::info!(tool = name, method = call.method.as_str(), "tool call");
        Some(tool_result(self.upstream.call(api_key, &who.slug, &call).await))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::time::Duration;

    use super::*;

    fn server() -> Server {
        // The upstream is never reached in these tests.
        Server::new(Upstream::new("http://127.0.0.1:1", Duration::from_secs(1), 1000).unwrap()).unwrap()
    }

    fn who(perms: &[&str]) -> Whoami {
        Whoami {
            slug: "acme".into(),
            workspace_name: "Acme".into(),
            permissions: perms.iter().map(|s| s.to_string()).collect::<HashSet<_>>(),
            raw: json!({ "workspace": { "slug": "acme" }, "permissions": perms }),
        }
    }

    fn names(tools: &[Value]) -> Vec<String> {
        tools.iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn hides_tools_without_permission() {
        let s = server();
        let n = names(&s.list_tools(&who(&["issues:read", "issues:write"])));
        assert!(n.contains(&"list_issues".to_string()) && n.contains(&"create_issue".to_string()));
        assert!(!n.contains(&"delete_issue".to_string()) && !n.contains(&"list_teams".to_string()));
        assert!(n.contains(&"whoami".to_string()) && n.contains(&"api_request".to_string()));
        assert_eq!(names(&s.list_tools(&who(&[]))), vec!["whoami", "api_request"]);
    }

    #[tokio::test]
    async fn initialize_negotiates_version_and_notifications_get_no_reply() {
        let s = server();
        let w = who(&[]);
        let r = s.handle("k", &w, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let r = s.handle("k", &w, json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED[0]);
        assert!(s.handle("k", &w, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
    }

    #[tokio::test]
    async fn tool_errors_are_results_and_protocol_errors_are_rpc_errors() {
        let s = server();
        let w = who(&["issues:read"]);
        let call = |name: &str, args: Value| json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } });

        let r = s.handle("k", &w, call("delete_issue", json!({ "idOrKey": "BUG-1" }))).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("issues:delete"));

        let r = s.handle("k", &w, call("get_issue", json!({}))).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("idOrKey"));

        let r = s.handle("k", &w, call("nope", json!({}))).await.unwrap();
        assert_eq!(r["error"]["code"], -32602);
        let r = s.handle("k", &w, json!({ "jsonrpc": "2.0", "id": 8, "method": "resources/list" })).await.unwrap();
        assert_eq!(r["error"]["code"], -32601);

        let r = s.handle("k", &w, call("whoami", json!({}))).await.unwrap();
        assert_eq!(r["result"]["isError"], false);
    }
}
