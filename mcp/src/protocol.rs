//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`. Stateless: no
//! sessions and no server-initiated messages, so the same dispatcher serves Streamable HTTP and stdio.
//!
//! A connection carries one or more API keys. Each key is bound to exactly one workspace, so a
//! connection with several keys can read across those workspaces. With a single key nothing changes:
//! tools have no `workspace` argument and writes behave as before.

use serde_json::{Map, Value, json};

use crate::catalog::{Tool, load};
use crate::composite::{self, Exec};
use crate::generic;
use crate::profile::{self, Entry, EntryKind, Profile};
use crate::upstream::{ToolOutput, Upstream, Whoami};

const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const WHOAMI: &str = "whoami";
const ACCOUNTS: &str = "list_accounts";
const RUN_TOOL: &str = "run_tool";
const LIST_CAPABILITIES: &str = "list_capabilities";
/// Extra argument added to every tool when more than one key is connected. It is not an API field:
/// it only chooses which connected key the call runs with.
const WORKSPACE_ARG: &str = "workspace";

const INSTRUCTIONS_COMMON: &str = "Trama (coordination for human + AI engineering teams). \
Items can be addressed by id (in_…, wk_…) or by key (BUG-142, AUTH-42, ADR-21, team key AUTH). \
Tools you are not permitted to use are hidden; writes are limited by per-key caps (HTTP 429 means stop and report, never retry in a loop). \
In update_* tools, null clears an optional field. Start with `whoami` if unsure what this key can do.";

const INSTRUCTIONS_CORE: &str = "This is the compact tool set: read with get_context before you act, find existing work with find_work or search, \
start with start_work, record facts with report_progress / attach_artifact, ask a person with ask_human, propose lasting choices with record_decision. \
For anything else (teams, projects, milestones, customers, members, webhooks…) call list_capabilities to find the operation, then run_tool to execute it; api_request covers routes without a tool.";

fn instructions(profile: Profile) -> String {
    match profile {
        Profile::Core => format!("{INSTRUCTIONS_COMMON} {INSTRUCTIONS_CORE}"),
        Profile::Full => INSTRUCTIONS_COMMON.to_string(),
    }
}

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
    curated: Vec<Entry>,
    /// The profile used when a request does not choose one.
    profile: Profile,
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
    /// A server on the default profile (`core`).
    pub fn new(upstream: Upstream) -> Result<Self, String> {
        let tools = load()?;
        let curated = profile::load(&tools)?;
        Ok(Self {
            tools,
            curated,
            profile: Profile::default(),
            upstream,
        })
    }

    /// Chooses the profile used when a request does not name one.
    pub fn with_profile(mut self, profile: Profile) -> Self {
        self.profile = profile;
        self
    }

    pub fn profile(&self) -> Profile {
        self.profile
    }

    /// Size of the full catalog.
    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }

    /// How many tools `profile` lists to a key that may use everything (`list_accounts` excluded).
    pub fn listed_count(&self, profile: Profile) -> usize {
        match profile {
            Profile::Full => self.tools.len() + 2,
            Profile::Core => profile::core_names(&self.curated).len(),
        }
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

    /// The tools these keys may use, on the server's default profile. See `list_tools_for`.
    #[cfg(test)]
    pub fn list_tools(&self, accounts: &[Account]) -> Vec<Value> {
        self.list_tools_for(self.profile, accounts)
    }

    /// The tools these keys may use under `profile`. A tool is listed when at least one key has its
    /// permission. With more than one key every tool also takes `workspace`, and `list_accounts` is
    /// added. With exactly one key the schemas stay exactly as the catalog defines them.
    pub fn list_tools_for(&self, profile: Profile, accounts: &[Account]) -> Vec<Value> {
        let multi = accounts.len() > 1;
        let permissions: Vec<&std::collections::HashSet<String>> = accounts.iter().map(|a| &a.who.permissions).collect();
        let mut out = vec![Self::whoami_listing()];
        if multi {
            out.push(Self::accounts_listing());
        }
        match profile {
            Profile::Full => out.extend(
                self.tools
                    .iter()
                    .filter(|t| accounts.iter().any(|a| a.who.permissions.contains(&t.permission)))
                    .map(|t| with_workspace(t.listing(), multi)),
            ),
            Profile::Core => out.extend(
                self.curated
                    .iter()
                    .filter(|e| e.visible(&self.tools, &permissions))
                    .map(|e| with_workspace(e.listing(&self.tools), multi)),
            ),
        }
        out.push(with_workspace(generic::listing(), multi));
        out
    }

    /// Handles one JSON-RPC message on the server's default profile.
    pub async fn handle(&self, accounts: &[Account], msg: Value) -> Option<Value> {
        self.handle_with(self.profile, accounts, msg).await
    }

    /// Handles one JSON-RPC message for the keys connected to this request, listing the tools of
    /// `profile`. `None` = notification (no reply).
    pub async fn handle_with(&self, profile: Profile, accounts: &[Account], msg: Value) -> Option<Value> {
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
                        "instructions": format!("{} {note}{where_}", instructions(profile)),
                    }),
                )
            }
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": self.list_tools_for(profile, accounts) })),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "tools/call needs a tool name"));
                };
                let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                match self.call_tool(profile, accounts, name, &args).await {
                    Some(result) => rpc_result(id, result),
                    None => rpc_error(id, -32602, &format!("Unknown tool: {name}")),
                }
            }
            _ => rpc_error(id, -32601, "Method not found"),
        })
    }

    /// `None` = no such tool.
    async fn call_tool(&self, profile: Profile, accounts: &[Account], name: &str, args: &Value) -> Option<Value> {
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
        // `run_tool` runs a catalog tool by name, whatever the profile lists.
        let (name, args, via_run_tool) = if name == RUN_TOOL {
            match unwrap_run_tool(&args) {
                Ok((inner, inner_args)) => (inner, inner_args, true),
                Err(e) => return Some(tool_error(e)),
            }
        } else {
            (name.to_string(), args, false)
        };
        let name = name.as_str();
        if name == LIST_CAPABILITIES && !via_run_tool {
            let mut permissions = std::collections::HashSet::new();
            for a in &targets {
                permissions.extend(a.who.permissions.iter().cloned());
            }
            return Some(match profile::capabilities(&self.tools, &self.curated, profile, &permissions, &args) {
                Ok(v) => tool_result(ToolOutput { text: self.upstream.clip(v.to_string()), is_error: false }),
                Err(e) => tool_error(e),
            });
        }
        let Some(target) = self.find_target(profile, name, via_run_tool) else {
            return if via_run_tool {
                Some(tool_error(format!(
                    "Unknown tool '{name}'. Use list_capabilities (q or group) to find the exact name; routes without a tool go through api_request."
                )))
            } else {
                None
            };
        };
        if let Target::Composite(entry) = target {
            return Some(tool_result(self.call_composite(entry, &args, &targets).await));
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

    /// What a tool name means under `profile`. The curated profile prefers its task-level tool when
    /// a catalog tool has the same name (`create_issue`); the full profile prefers the catalog. Tools
    /// that a profile does not list stay callable by name, so older prompts and skills keep working.
    fn find_target(&self, profile: Profile, name: &str, via_run_tool: bool) -> Option<Target<'_>> {
        if name == generic::NAME {
            return (!via_run_tool).then_some(Target::Generic);
        }
        let catalog = self.tools.iter().any(|t| t.name == name);
        if via_run_tool {
            return catalog.then_some(Target::Catalog);
        }
        let composite = self
            .curated
            .iter()
            .find(|e| e.kind == EntryKind::Composite && !e.local && e.name == name);
        match (profile, catalog, composite) {
            (Profile::Core, _, Some(e)) => Some(Target::Composite(e)),
            (_, true, _) => Some(Target::Catalog),
            (_, false, Some(e)) => Some(Target::Composite(e)),
            _ => None,
        }
    }

    /// Runs a task-level tool. It acts in exactly one workspace unless it only reads.
    async fn call_composite(&self, entry: &Entry, args: &Value, targets: &[&Account]) -> ToolOutput {
        let Some(schema) = entry.input_schema.as_ref() else {
            return ToolOutput { text: "tool has no schema".into(), is_error: true };
        };
        let args = match composite::normalize(schema, args) {
            Ok(v) => v,
            Err(e) => return ToolOutput { text: format!("Invalid arguments: {e}"), is_error: true },
        };
        if !entry.read_only && targets.len() > 1 {
            let slugs: Vec<&str> = targets.iter().map(|a| a.who.slug.as_str()).collect();
            return ToolOutput {
                text: format!(
                    "this changes data, so it needs exactly one workspace (it matched {}). Pass `workspace` with one slug.",
                    slugs.join(", ")
                ),
                is_error: true,
            };
        }
        let mut rows: Vec<Value> = vec![];
        let mut errors: Vec<Value> = vec![];
        for account in targets {
            if !entry.visible(&self.tools, &[&account.who.permissions]) {
                let needs = if entry.visible_if.is_empty() { "the permissions of its steps".to_string() } else { format!("one of {}", entry.visible_if.join(", ")) };
                let text = format!(
                    "The key for '{}' cannot use {}: it needs {needs}. Ask a workspace admin to grant it in Settings → API tokens.",
                    account.who.slug, entry.name
                );
                if targets.len() == 1 {
                    return ToolOutput { text, is_error: true };
                }
                errors.push(json!({ "workspace": account.who.slug, "error": text }));
                continue;
            }
            tracing::info!(tool = %entry.name, workspace = %account.who.slug, "composite call");
            let out = self.run_composite(entry, &args, account).await;
            if targets.len() == 1 {
                return out;
            }
            if out.is_error {
                errors.push(json!({ "workspace": account.who.slug, "error": out.text }));
                continue;
            }
            match serde_json::from_str::<Value>(&out.text) {
                Ok(Value::Array(items)) => rows.extend(items.into_iter().map(|item| stamp(item, &account.who.slug))),
                Ok(other) => rows.push(stamp(other, &account.who.slug)),
                Err(_) => rows.push(json!({ "workspace": account.who.slug, "result": out.text })),
            }
        }
        merge(rows, errors)
    }

    async fn run_composite(&self, entry: &Entry, args: &Value, account: &Account) -> ToolOutput {
        let exec = Exec { upstream: &self.upstream, tools: &self.tools, account, uses: &entry.uses };
        match composite::run(&entry.name, args, &exec).await {
            Some(Ok(done)) => {
                let text = match &done.value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                ToolOutput { text: self.upstream.clip(text), is_error: done.failed }
            }
            Some(Err(message)) => ToolOutput { text: message, is_error: true },
            None => ToolOutput { text: format!("{} has no implementation", entry.name), is_error: true },
        }
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
        merge(rows, errors)
    }
}

/// Rows from several workspaces, plus the workspaces that failed. All failed = an error.
fn merge(rows: Vec<Value>, errors: Vec<Value>) -> ToolOutput {
    // Nothing found everywhere is an answer; only failures everywhere are an error.
    if rows.is_empty() && !errors.is_empty() {
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

enum Target<'a> {
    Generic,
    Catalog,
    Composite(&'a Entry),
}

/// `run_tool { name, arguments }` -> the catalog tool to run and its arguments.
fn unwrap_run_tool(args: &Value) -> Result<(String, Value), String> {
    let obj = args.as_object().ok_or("arguments must be an object")?;
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "name" | "arguments")) {
        return Err(format!("Invalid arguments: unknown argument '{k}'"));
    }
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or("Invalid arguments: missing required argument 'name'")?;
    if name == RUN_TOOL {
        return Err("run_tool cannot run itself".into());
    }
    let inner = match obj.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(v @ Value::Object(_)) => v.clone(),
        Some(_) => return Err("Invalid arguments: arguments must be an object".into()),
    };
    Ok((name.to_string(), inner))
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

    /// The full catalog profile, which the tests below were written for.
    fn server() -> Server {
        core_server().with_profile(Profile::Full)
    }

    /// The default (curated) profile. The upstream is never reached in these tests.
    fn core_server() -> Server {
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

    fn everything() -> Whoami {
        let perms: Vec<String> = load().unwrap().into_iter().map(|t| t.permission).collect();
        let refs: Vec<&str> = perms.iter().map(String::as_str).collect();
        who(&refs)
    }

    #[test]
    fn the_default_profile_is_core_and_is_short() {
        let s = core_server();
        assert_eq!(s.profile(), Profile::Core);
        let accounts = one("k", everything());
        let tools = s.list_tools(&accounts);
        let n = names(&tools);
        assert!((15..=25).contains(&n.len()), "{} tools: {n:?}", n.len());
        assert_eq!(n.first().map(String::as_str), Some("whoami"));
        assert_eq!(n.last().map(String::as_str), Some("api_request"));
        for must in ["get_context", "find_work", "start_work", "report_progress", "ask_human", "record_decision", "list_capabilities", "run_tool"] {
            assert!(n.contains(&must.to_string()), "{must}");
        }
        assert!(!n.contains(&"list_teams".to_string()) && !n.contains(&"create_milestone".to_string()));
        assert_eq!(n.len(), s.listed_count(Profile::Core));
    }

    #[test]
    fn full_lists_the_whole_catalog_and_core_a_fraction() {
        let s = core_server();
        let accounts = one("k", everything());
        let full = s.list_tools_for(Profile::Full, &accounts);
        let core = s.list_tools_for(Profile::Core, &accounts);
        assert_eq!(full.len(), s.tool_count() + 2, "catalog + whoami + api_request");
        assert_eq!(full.len(), s.listed_count(Profile::Full));
        let bytes = |v: &[Value]| v.iter().map(|t| t.to_string().len()).sum::<usize>();
        assert!(bytes(&core) * 2 < bytes(&full), "core {} vs full {} bytes", bytes(&core), bytes(&full));
        assert!(!names(&full).contains(&"get_context".to_string()), "full is the plain catalog");
    }

    #[test]
    fn the_core_profile_hides_tools_the_key_cannot_use() {
        let s = core_server();
        let n = names(&s.list_tools(&one("k", who(&["issues:read", "search:read"]))));
        assert!(n.contains(&"get_context".to_string()) && n.contains(&"find_work".to_string()) && n.contains(&"search".to_string()));
        assert!(!n.contains(&"create_issue".to_string()) && !n.contains(&"update_issue".to_string()) && !n.contains(&"ask_human".to_string()));
        assert_eq!(names(&s.list_tools(&one("k", who(&[])))), vec!["whoami", "list_capabilities", "run_tool", "api_request"]);
    }

    #[test]
    fn several_keys_add_the_workspace_argument_to_core_tools_too() {
        let s = core_server();
        let accounts = vec![
            Account { key: "a".into(), profile: String::new(), who: everything() },
            Account { key: "b".into(), profile: String::new(), who: who_in("beta", &["issues:read"]) },
        ];
        let tools = s.list_tools(&accounts);
        assert!(names(&tools).contains(&"list_accounts".to_string()));
        for t in tools.iter().filter(|t| t["name"] != "whoami" && t["name"] != "list_accounts") {
            assert!(t["inputSchema"]["properties"].get("workspace").is_some(), "{}", t["name"]);
        }
    }

    #[tokio::test]
    async fn the_request_profile_decides_what_tools_list() {
        let s = core_server();
        let accounts = one("k", everything());
        let list = |profile: Profile| {
            let s = &s;
            let accounts = &accounts;
            async move {
                let r = s.handle_with(profile, accounts, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.unwrap();
                names(r["result"]["tools"].as_array().unwrap())
            }
        };
        assert!(list(Profile::Core).await.contains(&"start_work".to_string()));
        assert!(list(Profile::Full).await.contains(&"list_teams".to_string()));
        // `handle` uses the server default, which can be switched
        let full_default = core_server().with_profile(Profile::Full);
        let r = full_default.handle(&accounts, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.unwrap();
        assert!(names(r["result"]["tools"].as_array().unwrap()).contains(&"list_teams".to_string()));
    }

    #[tokio::test]
    async fn instructions_describe_the_profile_in_use() {
        let s = core_server();
        let accounts = one("k", who(&[]));
        let init = |profile: Profile| {
            let s = &s;
            let accounts = &accounts;
            async move {
                let r = s.handle_with(profile, accounts, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })).await.unwrap();
                r["result"]["instructions"].as_str().unwrap().to_string()
            }
        };
        let core = init(Profile::Core).await;
        assert!(core.contains("list_capabilities") && core.contains("run_tool") && core.contains("Acme"));
        let full = init(Profile::Full).await;
        assert!(!full.contains("list_capabilities") && full.contains("Acme"));
    }

    #[test]
    fn the_curated_names_never_shadow_the_protocol_tools() {
        let s = core_server();
        for e in &s.curated {
            assert!(!["whoami", "list_accounts", "api_request"].contains(&e.name.as_str()), "{}", e.name);
        }
    }
}
