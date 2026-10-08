//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`. Stateless: no
//! sessions and no server-initiated messages, so the same dispatcher serves Streamable HTTP and stdio.
//!
//! A connection carries one or more API keys. Each key is bound to exactly one workspace, so a
//! connection with several keys can read across those workspaces. With a single key nothing changes:
//! tools have no `workspace` argument and writes behave as before.

use serde_json::{Map, Value, json};

use crate::catalog::{Tool, load};
use crate::generic;
use crate::upstream::{ToolOutput, Upstream, Whoami};

const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const WHOAMI: &str = "whoami";
const ACCOUNTS: &str = "list_accounts";
/// Extra argument added to every tool when more than one key is connected. It is not an API field:
/// it only chooses which connected key the call runs with.
const WORKSPACE_ARG: &str = "workspace";

const INSTRUCTIONS: &str = "Trama (coordination for human + AI engineering teams). \
Items can be addressed by id (iss_…, wk_…) or by key (BUG-142, AUTH-42, ADR-21, team key AUTH). \
Tools you are not permitted to use are hidden; writes are limited by per-key caps (HTTP 429 means stop and report, never retry in a loop). \
In update_* tools, null clears an optional field. Start with `whoami` if unsure what this key can do.";

const ONE_WORKSPACE: &str =
    "The API key you connected with is bound to one workspace, so no workspace argument is needed.";
const MANY_WORKSPACES: &str = "Several API keys are connected, each bound to one workspace. Every tool takes an optional `workspace` argument (a slug, or several separated by commas). \
Omit it on a read to run across every connected workspace; each result is stamped with the workspace it came from. \
A write needs exactly one workspace. `list_accounts` shows the connected workspaces.";

/// One connected key. `profile` is set when the key came from a saved CLI profile; empty otherwise.
#[derive(Clone)]
pub struct Account {
    pub key: String,
    pub profile: String,
    pub who: Whoami,
}

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
    tool_result(ToolOutput {
        text: message,
        is_error: true,
    })
}

impl Server {
    pub fn new(upstream: Upstream) -> Result<Self, String> {
        Ok(Self {
            tools: load()?,
            upstream,
        })
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }

    fn whoami_listing() -> Value {
        json!({
            "name": WHOAMI,
            "description": "Which workspace and permissions this API key has, its usage caps and expiry. With several keys connected, one entry per key.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        })
    }

    fn accounts_listing() -> Value {
        json!({
            "name": ACCOUNTS,
            "description": "The workspaces this connection can reach, one per connected API key. Pass a slug to the `workspace` argument of any other tool.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        })
    }

    /// The tools these keys may use. A tool is listed when at least one key has its permission.
    /// With more than one key every tool also takes `workspace`, and `list_accounts` is added.
    /// With exactly one key the schemas stay exactly as the catalog defines them.
    pub fn list_tools(&self, accounts: &[Account]) -> Vec<Value> {
        let multi = accounts.len() > 1;
        let mut out = vec![Self::whoami_listing()];
        if multi {
            out.push(Self::accounts_listing());
        }
        out.extend(
            self.tools
                .iter()
                .filter(|t| {
                    accounts
                        .iter()
                        .any(|a| a.who.permissions.contains(&t.permission))
                })
                .map(|t| with_workspace(t.listing(), multi)),
        );
        out.push(with_workspace(generic::listing(), multi));
        out
    }

    /// Handles one JSON-RPC message for the keys connected to this request. `None` = notification (no reply).
    pub async fn handle(&self, accounts: &[Account], msg: Value) -> Option<Value> {
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            return msg
                .get("id")
                .map(|id| rpc_error(id.clone(), -32600, "Invalid Request"));
        };
        let Some(id) = msg.get("id").cloned() else {
            return None; // notification (notifications/initialized, notifications/cancelled, …)
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let Some(first) = accounts.first() else {
            return Some(rpc_error(id, -32001, "no API key is connected"));
        };
        Some(match method {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = SUPPORTED
                    .iter()
                    .find(|v| **v == requested)
                    .copied()
                    .unwrap_or(SUPPORTED[0]);
                let (note, where_) = if accounts.len() == 1 {
                    (
                        ONE_WORKSPACE,
                        format!(" Workspace: {}.", first.who.workspace_name),
                    )
                } else {
                    let slugs: Vec<&str> = accounts.iter().map(|a| a.who.slug.as_str()).collect();
                    (
                        MANY_WORKSPACES,
                        format!(" Connected workspaces: {}.", slugs.join(", ")),
                    )
                };
                rpc_result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "trama-mcp", "title": "Trama", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": format!("{INSTRUCTIONS} {note}{where_}"),
                    }),
                )
            }
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": self.list_tools(accounts) })),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "tools/call needs a tool name"));
                };
                let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                match self.call_tool(accounts, name, &args).await {
                    Some(result) => rpc_result(id, result),
                    None => rpc_error(id, -32602, &format!("Unknown tool: {name}")),
                }
            }
            _ => rpc_error(id, -32601, "Method not found"),
        })
    }

    /// `None` = no such tool.
    async fn call_tool(&self, accounts: &[Account], name: &str, args: &Value) -> Option<Value> {
        if name == WHOAMI {
            return Some(tool_result(ToolOutput {
                text: whoami_text(accounts).to_string(),
                is_error: false,
            }));
        }
        if name == ACCOUNTS {
            return (accounts.len() > 1).then(|| {
                tool_result(ToolOutput {
                    text: accounts_text(accounts).to_string(),
                    is_error: false,
                })
            });
        }
        let (workspace, args) = match strip_workspace(args) {
            Ok(v) => v,
            Err(e) => return Some(tool_error(e)),
        };
        let targets = match select(accounts, workspace.as_deref()) {
            Ok(v) => v,
            Err(e) => return Some(tool_error(e)),
        };
        let known = name == generic::NAME || self.tools.iter().any(|t| t.name == name);
        if !known {
            return None;
        }
        let call = if name == generic::NAME {
            generic::build_call(&args)
        } else {
            let tool = self.tools.iter().find(|t| t.name == name)?;
            if targets
                .iter()
                .all(|a| !a.who.permissions.contains(&tool.permission))
            {
                return Some(tool_error(format!(
                    "None of the connected API keys has the \"{}\" permission. Ask a workspace admin to grant it in Settings → API tokens.",
                    tool.permission
                )));
            }
            tool.build_call(&args)
        };
        let call = match call {
            Ok(c) => c,
            Err(e) => return Some(tool_error(format!("Invalid arguments: {e}"))),
        };
        // A write names one object. Running it everywhere would create or edit it in every workspace.
        if targets.len() > 1 && call.method != crate::catalog::Method::Get {
            let slugs: Vec<&str> = targets.iter().map(|a| a.who.slug.as_str()).collect();
            return Some(tool_error(format!(
                "this changes data, so it needs exactly one workspace (it matched {}). Pass `workspace` with one slug.",
                slugs.join(", ")
            )));
        }
        if targets.len() <= 1 {
            let Some(account) = targets.first() else {
                return Some(tool_error("no workspace matched".into()));
            };
            if let Some(tool) = self.tools.iter().find(|t| t.name == name)
                && !account.who.permissions.contains(&tool.permission)
            {
                return Some(tool_error(format!(
                    "The key for '{}' lacks the \"{}\" permission.",
                    account.who.slug, tool.permission
                )));
            }
            tracing::info!(tool = name, method = call.method.as_str(), workspace = %account.who.slug, "tool call");
            return Some(tool_result(
                self.upstream
                    .call(&account.key, &account.who.slug, &call)
                    .await,
            ));
        }
        Some(tool_result(self.call_across(name, &call, &targets).await))
    }

    /// One read per connected workspace, merged. A workspace that fails is reported, not fatal, as
    /// long as another one answered.
    async fn call_across(
        &self,
        name: &str,
        call: &crate::catalog::Call,
        targets: &[&Account],
    ) -> ToolOutput {
        let mut rows: Vec<Value> = vec![];
        let mut errors: Vec<Value> = vec![];
        for account in targets {
            if let Some(tool) = self.tools.iter().find(|t| t.name == name)
                && !account.who.permissions.contains(&tool.permission)
            {
                errors.push(json!({ "workspace": account.who.slug, "error": format!("lacks the {} permission", tool.permission) }));
                continue;
            }
            tracing::info!(tool = name, method = call.method.as_str(), workspace = %account.who.slug, "tool call");
            let out = self
                .upstream
                .call(&account.key, &account.who.slug, call)
                .await;
            if out.is_error {
                errors.push(json!({ "workspace": account.who.slug, "error": out.text }));
                continue;
            }
            match serde_json::from_str::<Value>(&out.text) {
                Ok(Value::Array(items)) => {
                    rows.extend(items.into_iter().map(|item| stamp(item, &account.who.slug)))
                }
                Ok(other) => rows.push(stamp(other, &account.who.slug)),
                Err(_) => rows.push(json!({ "workspace": account.who.slug, "result": out.text })),
            }
        }
        if rows.is_empty() {
            return ToolOutput {
                text: format!("every workspace failed: {errors:?}"),
                is_error: true,
            };
        }
        let merged = if errors.is_empty() {
            Value::Array(rows)
        } else {
            json!({ "results": rows, "errors": errors })
        };
        ToolOutput {
            text: merged.to_string(),
            is_error: false,
        }
    }
}

/// Adds the `workspace` argument to a tool listing, only when more than one key is connected.
fn with_workspace(mut listing: Value, multi: bool) -> Value {
    if !multi {
        return listing;
    }
    if let Some(props) = listing
        .pointer_mut("/inputSchema/properties")
        .and_then(Value::as_object_mut)
    {
        props.insert(
            WORKSPACE_ARG.to_string(),
            json!({ "type": "string", "description": "Workspace slug to run this in, or several separated by commas. Omit on a read to run across every connected workspace. A write needs exactly one." }),
        );
    }
    if let Some(desc) = listing.get("description").and_then(Value::as_str) {
        listing["description"] = json!(format!(
            "{desc} Pass `workspace` to choose which connected workspace; omit it on a read to cover all of them."
        ));
    }
    listing
}

/// Removes the `workspace` argument so catalog validation never sees it, and returns what it asked for.
fn strip_workspace(args: &Value) -> Result<(Option<String>, Value), String> {
    let Some(obj) = args.as_object() else {
        return Ok((None, args.clone()));
    };
    if let Some(value) = obj.get(WORKSPACE_ARG)
        && !value.is_null()
        && value.as_str().is_none_or(|s| s.trim().is_empty())
    {
        return Err("workspace must be a slug, or several slugs separated by commas".into());
    }
    let workspace = obj
        .get(WORKSPACE_ARG)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut rest = obj.clone();
    rest.remove(WORKSPACE_ARG);
    Ok((workspace, Value::Object(rest)))
}

/// The connected keys a `workspace` argument selects. `None` means all of them.
fn select<'a>(
    accounts: &'a [Account],
    workspace: Option<&str>,
) -> Result<Vec<&'a Account>, String> {
    let Some(workspace) = workspace else {
        return Ok(accounts.iter().collect());
    };
    let wanted: Vec<&str> = workspace
        .split([',', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let mut out = vec![];
    for slug in wanted {
        match accounts
            .iter()
            .find(|a| a.who.slug == slug || (!a.profile.is_empty() && a.profile == slug))
        {
            Some(a) => out.push(a),
            None => {
                let known: Vec<&str> = accounts.iter().map(|a| a.who.slug.as_str()).collect();
                return Err(format!(
                    "no connected key is bound to workspace '{slug}'. Connected: {}",
                    known.join(", ")
                ));
            }
        }
    }
    Ok(out)
}

fn stamp(value: Value, workspace: &str) -> Value {
    match value {
        Value::Object(mut map) => {
            map.insert("workspace".into(), json!(workspace));
            Value::Object(map)
        }
        other => json!({ "workspace": workspace, "result": other }),
    }
}

/// One entry per connected key, or the bare entry when only one key is connected (as before).
fn whoami_text(accounts: &[Account]) -> Value {
    let rows: Vec<Value> = accounts.iter().map(account_info).collect();
    if rows.len() == 1 {
        rows.into_iter().next().unwrap_or(Value::Null)
    } else {
        Value::Array(rows)
    }
}

fn account_info(account: &Account) -> Value {
    let mut permissions: Vec<&String> = account.who.permissions.iter().collect();
    permissions.sort();
    let mut info = Map::new();
    info.insert(
        "workspace".into(),
        account
            .who
            .raw
            .get("workspace")
            .cloned()
            .unwrap_or(Value::Null),
    );
    info.insert(
        "actor".into(),
        account.who.raw.get("actor").cloned().unwrap_or(Value::Null),
    );
    info.insert(
        "token".into(),
        account.who.raw.get("token").cloned().unwrap_or(Value::Null),
    );
    info.insert("permissions".into(), json!(permissions));
    if !account.profile.is_empty() {
        info.insert("profile".into(), json!(account.profile));
    }
    Value::Object(info)
}

fn accounts_text(accounts: &[Account]) -> Value {
    Value::Array(
        accounts
            .iter()
            .map(|a| json!({ "workspace": a.who.slug, "workspaceName": a.who.workspace_name, "profile": a.profile }))
            .collect(),
    )
}

/// One key, the way every caller worked before several keys could share a connection.
pub fn one(key: &str, who: Whoami) -> Vec<Account> {
    vec![Account {
        key: key.to_string(),
        profile: String::new(),
        who,
    }]
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::time::Duration;

    use super::*;

    fn server() -> Server {
        // The upstream is never reached in these tests.
        Server::new(Upstream::new("http://127.0.0.1:1", Duration::from_secs(1), 1000).unwrap())
            .unwrap()
    }

    fn who(perms: &[&str]) -> Whoami {
        Whoami {
            slug: "acme".into(),
            workspace_name: "Acme".into(),
            permissions: perms.iter().map(|s| s.to_string()).collect::<HashSet<_>>(),
            raw: json!({ "workspace": { "slug": "acme" }, "permissions": perms }),
        }
    }

    fn who_in(slug: &str, perms: &[&str]) -> Whoami {
        Whoami {
            slug: slug.into(),
            workspace_name: slug.into(),
            permissions: perms.iter().map(|s| s.to_string()).collect::<HashSet<_>>(),
            raw: json!({ "workspace": { "slug": slug }, "permissions": perms }),
        }
    }

    fn names(tools: &[Value]) -> Vec<String> {
        tools
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn hides_tools_without_permission() {
        let s = server();
        let accounts = one("k", who(&["issues:read", "issues:write"]));
        let n = names(&s.list_tools(&accounts));
        assert!(n.contains(&"list_issues".to_string()) && n.contains(&"create_issue".to_string()));
        assert!(!n.contains(&"delete_issue".to_string()) && !n.contains(&"list_teams".to_string()));
        assert!(n.contains(&"whoami".to_string()) && n.contains(&"api_request".to_string()));
        assert!(
            !n.contains(&"list_accounts".to_string()),
            "a single key needs no account list"
        );
        assert!(
            s.list_tools(&accounts)
                .iter()
                .all(|t| t["inputSchema"]["properties"].get("workspace").is_none())
        );
        assert_eq!(
            names(&s.list_tools(&one("k", who(&[])))),
            vec!["whoami", "api_request"]
        );
    }

    #[test]
    fn several_keys_share_tools_and_gain_a_workspace_argument() {
        let s = server();
        let accounts = vec![
            Account {
                key: "a".into(),
                profile: "acme".into(),
                who: who_in("acme", &["issues:read"]),
            },
            Account {
                key: "b".into(),
                profile: "beta".into(),
                who: who_in("beta", &["issues:write"]),
            },
        ];
        let tools = s.list_tools(&accounts);
        let n = names(&tools);
        assert!(n.contains(&"list_issues".to_string()) && n.contains(&"create_issue".to_string()));
        assert!(n.contains(&"list_accounts".to_string()));
        let list = tools.iter().find(|t| t["name"] == "list_issues").unwrap();
        assert!(list["inputSchema"]["properties"].get("workspace").is_some());
        assert!(
            list["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r != "workspace")
        );
    }

    #[tokio::test]
    async fn initialize_negotiates_version_and_notifications_get_no_reply() {
        let s = server();
        let accounts = one("k", who(&[]));
        let r = s.handle(&accounts, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(
            r["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("Acme")
        );
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let r = s.handle(&accounts, json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED[0]);
        assert!(
            s.handle(
                &accounts,
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .await
            .is_none()
        );
    }

    #[tokio::test]
    async fn initialize_names_every_connected_workspace() {
        let s = server();
        let accounts = vec![
            Account {
                key: "a".into(),
                profile: String::new(),
                who: who_in("acme", &[]),
            },
            Account {
                key: "b".into(),
                profile: String::new(),
                who: who_in("beta", &[]),
            },
        ];
        let r = s
            .handle(
                &accounts,
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
            )
            .await
            .unwrap();
        let text = r["result"]["instructions"].as_str().unwrap();
        assert!(text.contains("acme") && text.contains("beta"));
        assert!(text.contains("list_accounts"));
    }

    #[tokio::test]
    async fn tool_errors_are_results_and_protocol_errors_are_rpc_errors() {
        let s = server();
        let accounts = one("k", who(&["issues:read"]));
        let call = |name: &str, args: Value| json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } });

        let r = s
            .handle(
                &accounts,
                call("delete_issue", json!({ "idOrKey": "BUG-1" })),
            )
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(
            r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("issues:delete")
        );

        let r = s
            .handle(&accounts, call("get_issue", json!({})))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(
            r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("idOrKey")
        );

        let r = s.handle(&accounts, call("nope", json!({}))).await.unwrap();
        assert_eq!(r["error"]["code"], -32602);
        let r = s
            .handle(
                &accounts,
                json!({ "jsonrpc": "2.0", "id": 8, "method": "resources/list" }),
            )
            .await
            .unwrap();
        assert_eq!(r["error"]["code"], -32601);

        let r = s
            .handle(&accounts, call("whoami", json!({})))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert!(
            !r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with('['),
            "one key still returns a single object"
        );
    }

    #[tokio::test]
    async fn a_write_with_several_keys_refuses_to_guess() {
        let s = server();
        let accounts = vec![
            Account {
                key: "a".into(),
                profile: "acme".into(),
                who: who_in("acme", &["issues:write"]),
            },
            Account {
                key: "b".into(),
                profile: "beta".into(),
                who: who_in("beta", &["issues:write"]),
            },
        ];
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "create_issue", "arguments": { "kind": "bug", "title": "x" } } });
        let r = s.handle(&accounts, call).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(
            r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("exactly one workspace")
        );
    }

    #[test]
    fn workspace_selects_by_slug_or_profile_and_rejects_unknown_ones() {
        let accounts = vec![
            Account {
                key: "a".into(),
                profile: "work-acme".into(),
                who: who_in("acme", &[]),
            },
            Account {
                key: "b".into(),
                profile: "work-beta".into(),
                who: who_in("beta", &[]),
            },
        ];
        assert_eq!(select(&accounts, None).unwrap().len(), 2);
        assert_eq!(select(&accounts, Some("beta")).unwrap()[0].key, "b");
        assert_eq!(select(&accounts, Some("work-acme")).unwrap()[0].key, "a");
        assert_eq!(select(&accounts, Some("acme,beta")).unwrap().len(), 2);
        assert!(select(&accounts, Some("nope")).is_err());
    }
}
