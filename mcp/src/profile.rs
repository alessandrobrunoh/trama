//! Tool profiles: which tools a client sees.
//!
//! `tools.json` stays the FULL catalog (one entry per REST route; the CLI derives its commands from
//! it). A profile is a view over it:
//!
//! - `full`: every catalog tool, as before (about a hundred).
//! - `core` (default): a short list of task-level tools defined in `curated.json`: composite
//!   tools that orchestrate several catalog calls (`composite.rs`) and a few catalog tools with
//!   sharper descriptions. The long tail stays reachable on demand through `list_capabilities` +
//!   `run_tool` (and `api_request`), so nothing is lost, it only stops costing context.
//!
//! A profile changes what is listed, never what a key may do: permissions are checked by the API.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::catalog::{Method, Tool};

pub const CURATED_JSON: &str = include_str!("curated.json");

/// Env var that chooses the default profile of a server.
pub const PROFILE_ENV: &str = "TRAMA_MCP_PROFILE";

/// Composite tools that need no upstream call or are special-cased by the protocol layer.
pub const LOCAL: &[&str] = &["list_capabilities", "run_tool"];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Profile {
    #[default]
    Core,
    Full,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Profile> {
        match s.trim().to_ascii_lowercase().as_str() {
            "core" => Some(Profile::Core),
            "full" => Some(Profile::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Core => "core",
            Profile::Full => "full",
        }
    }

    /// `TRAMA_MCP_PROFILE`, or the default (`core`) when unset.
    pub fn from_env() -> Result<Profile, String> {
        match std::env::var(PROFILE_ENV).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            None => Ok(Profile::default()),
            Some(v) => Profile::parse(&v).ok_or_else(|| format!("{PROFILE_ENV} must be 'core' or 'full' (got '{v}')")),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    /// A catalog tool, listed with a sharper description.
    Catalog,
    /// A task-level tool implemented in `composite.rs` (or `local`, in the protocol layer).
    Composite,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    /// One line for docs and the capability index.
    pub summary: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
    pub read_only: bool,
    pub local: bool,
    /// A composite is listed when the key has at least one of these permissions (none = always).
    pub visible_if: Vec<String>,
    /// Catalog tools a composite may call.
    pub uses: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEntry {
    name: String,
    kind: String,
    summary: Option<String>,
    description: Option<String>,
    input_schema: Option<Value>,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    local: bool,
    #[serde(default)]
    visible_if: Vec<String>,
    #[serde(default)]
    uses: Vec<String>,
}

pub fn load(catalog: &[Tool]) -> Result<Vec<Entry>, String> {
    parse(CURATED_JSON, catalog)
}

/// Parses and validates `curated.json` against the catalog: every catalog entry and every `uses`
/// must name an existing tool, every composite needs a schema and a handler.
pub fn parse(json: &str, catalog: &[Tool]) -> Result<Vec<Entry>, String> {
    let raw: Vec<RawEntry> = serde_json::from_str(json).map_err(|e| format!("curated.json: {e}"))?;
    let by_name = |n: &str| catalog.iter().find(|t| t.name == n);
    let permissions: std::collections::HashSet<&str> = catalog.iter().map(|t| t.permission.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(raw.len());
    for r in raw {
        let ctx = |e: &str| format!("curated.json, tool {}: {e}", r.name);
        if !seen.insert(r.name.clone()) {
            return Err(ctx("duplicate name"));
        }
        if matches!(r.name.as_str(), "whoami" | "list_accounts" | "api_request") {
            return Err(ctx("reserved name"));
        }
        let summary = r.summary.clone().filter(|s| !s.trim().is_empty() && s.len() <= 120).ok_or_else(|| ctx("needs a `summary` of at most 120 characters"))?;
        let kind = match r.kind.as_str() {
            "catalog" => EntryKind::Catalog,
            "composite" => EntryKind::Composite,
            other => return Err(ctx(&format!("unknown kind {other}"))),
        };
        match kind {
            EntryKind::Catalog => {
                if by_name(&r.name).is_none() {
                    return Err(ctx("not in tools.json"));
                }
                if r.input_schema.is_some() || !r.uses.is_empty() || r.local {
                    return Err(ctx("a catalog entry only overrides the description"));
                }
            }
            EntryKind::Composite => {
                let schema = r.input_schema.as_ref().ok_or_else(|| ctx("composite needs inputSchema"))?;
                if schema["type"] != "object" || schema["additionalProperties"] != json!(false) {
                    return Err(ctx("inputSchema must be an object with additionalProperties:false"));
                }
                if r.description.as_deref().is_none_or(str::is_empty) {
                    return Err(ctx("composite needs a description"));
                }
                if r.local != LOCAL.contains(&r.name.as_str()) {
                    return Err(ctx("`local` must be set exactly for the protocol-level tools"));
                }
                if !r.local && !crate::composite::HANDLERS.contains(&r.name.as_str()) {
                    return Err(ctx("no handler in composite.rs"));
                }
                for u in &r.uses {
                    if by_name(u).is_none() {
                        return Err(ctx(&format!("uses unknown catalog tool {u}")));
                    }
                }
                for p in &r.visible_if {
                    if !permissions.contains(p.as_str()) {
                        return Err(ctx(&format!("visibleIf names unknown permission {p}")));
                    }
                }
            }
        }
        out.push(Entry {
            name: r.name,
            kind,
            summary,
            description: r.description,
            input_schema: r.input_schema,
            read_only: r.read_only,
            local: r.local,
            visible_if: r.visible_if,
            uses: r.uses,
        });
    }
    for h in crate::composite::HANDLERS {
        if !out.iter().any(|e| e.name == *h && e.kind == EntryKind::Composite) {
            return Err(format!("curated.json: handler {h} has no entry"));
        }
    }
    Ok(out)
}

impl Entry {
    /// Whether any of the given permission sets lets this entry be listed.
    pub fn visible(&self, catalog: &[Tool], permissions: &[&std::collections::HashSet<String>]) -> bool {
        match self.kind {
            EntryKind::Catalog => catalog
                .iter()
                .find(|t| t.name == self.name)
                .is_some_and(|t| permissions.iter().any(|p| p.contains(&t.permission))),
            EntryKind::Composite => self.visible_if.is_empty() || self.visible_if.iter().any(|v| permissions.iter().any(|p| p.contains(v))),
        }
    }

    /// Permissions of the write steps of a composite (what to ask a workspace admin for).
    fn write_permissions(&self, catalog: &[Tool]) -> Vec<String> {
        let mut perms: Vec<String> = self
            .uses
            .iter()
            .filter_map(|u| catalog.iter().find(|t| &t.name == u))
            .filter(|t| t.method != Method::Get)
            .map(|t| t.permission.clone())
            .collect();
        perms.sort();
        perms.dedup();
        perms
    }

    /// The `tools/list` entry.
    pub fn listing(&self, catalog: &[Tool]) -> Value {
        match self.kind {
            EntryKind::Catalog => {
                let tool = catalog.iter().find(|t| t.name == self.name).expect("validated at load");
                tool.listing_with(self.description.as_deref().unwrap_or(&tool.description))
            }
            EntryKind::Composite => {
                let mut desc = self.description.clone().unwrap_or_default();
                let writes = self.write_permissions(catalog);
                if !self.read_only && !writes.is_empty() {
                    desc.push_str(&format!(" [writes need: {}]", writes.join(", ")));
                }
                json!({
                    "name": self.name,
                    "description": desc,
                    "inputSchema": self.input_schema,
                    "annotations": {
                        "readOnlyHint": self.read_only,
                        "destructiveHint": self.name == "run_tool",
                        "openWorldHint": false,
                    },
                })
            }
        }
    }
}

/// Names of the core profile in listing order: `whoami`, the curated entries, `api_request`
/// (`list_accounts` joins them only when several keys are connected).
pub fn core_names(entries: &[Entry]) -> Vec<String> {
    let mut v = vec!["whoami".to_string()];
    v.extend(entries.iter().map(|e| e.name.clone()));
    v.push("api_request".to_string());
    v
}

/// One-line summary of a tool description: its first sentence, shortened.
pub fn summary(description: &str) -> String {
    let first = description.split(". ").next().unwrap_or(description).trim_end_matches('.');
    if first.chars().count() > 140 {
        let cut: String = first.chars().take(137).collect();
        format!("{cut}…")
    } else {
        first.to_string()
    }
}

#[cfg(test)]
const WHOAMI_SUMMARY: &str = "Which workspace and permissions this API key has, its caps and expiry";
#[cfg(test)]
const API_REQUEST_SUMMARY: &str = "Escape hatch: call any workspace REST route that has no tool (path-restricted)";

/// Markdown table of the core profile (generated into `mcp/README.md` by the docs test).
#[cfg(test)]
pub fn core_table(entries: &[Entry]) -> String {
    let mut out = String::from("| Tool | What it does |\n|---|---|\n");
    out.push_str(&format!("| `whoami` | {WHOAMI_SUMMARY} |\n"));
    for e in entries {
        out.push_str(&format!("| `{}` | {} |\n", e.name, e.summary.replace('|', "\\|")));
    }
    out.push_str(&format!("| `api_request` | {API_REQUEST_SUMMARY} |\n"));
    out
}

/// Placeholder arguments for the call example of `list_capabilities { tool }`.
fn example_arguments(tool: &Tool) -> Value {
    let mut args = serde_json::Map::new();
    for p in tool.params.iter().filter(|p| p.required) {
        let v = match p.ty.as_str() {
            "number" | "integer" => json!(0),
            "boolean" => json!(true),
            "object" => json!({}),
            "string[]" | "object[]" => json!([]),
            _ => json!(p.choices.first().cloned().unwrap_or_else(|| "…".to_string())),
        };
        args.insert(p.name.clone(), v);
    }
    Value::Object(args)
}

fn group_of(tool: &Tool) -> &str {
    tool.permission.split(':').next().unwrap_or("")
}

/// `list_capabilities`: the full catalog on demand. No arguments gives the groups; `q` / `group`
/// narrow to matching tools; `tool` returns one tool's schema and how to call it. Only tools the
/// connected keys may use are listed unless `all` is set.
pub fn capabilities(
    catalog: &[Tool],
    entries: &[Entry],
    profile: Profile,
    permissions: &std::collections::HashSet<String>,
    args: &Value,
) -> Result<Value, String> {
    let empty = serde_json::Map::new();
    let obj = match args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return Err("arguments must be an object".into()),
    };
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "q" | "group" | "tool" | "all")) {
        return Err(format!("Invalid arguments: unknown argument '{k}'"));
    }
    let get = |k: &str| obj.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let all = obj.get("all").and_then(Value::as_bool).unwrap_or(false);
    let core: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    if let Some(name) = get("tool") {
        let t = catalog.iter().find(|t| t.name == name).ok_or_else(|| {
            format!("Unknown tool '{name}'. Call list_capabilities with q or group to find the exact name.")
        })?;
        let available = permissions.contains(&t.permission);
        let mut out = json!({
            "name": t.name,
            "description": t.description,
            "method": t.method.as_str(),
            "route": format!("/w/<workspace>{}", t.path),
            "permission": t.permission,
            "available": available,
            "inputSchema": t.input_schema(),
            "call": { "tool": "run_tool", "arguments": { "name": t.name, "arguments": example_arguments(t) } },
        });
        if !available {
            out["note"] = json!(format!("this key lacks {}; ask a workspace admin to grant it", t.permission));
        } else if core.contains(&t.name.as_str()) && profile == Profile::Core {
            out["note"] = json!("a task-level tool with this name is also listed directly; run_tool runs the plain catalog tool");
        }
        return Ok(out);
    }

    let (q, group) = (get("q").map(str::to_lowercase), get("group").map(str::to_lowercase));
    let visible: Vec<&Tool> = catalog.iter().filter(|t| all || permissions.contains(&t.permission)).collect();
    if q.is_none() && group.is_none() {
        let mut groups: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for t in &visible {
            *groups.entry(group_of(t)).or_default() += 1;
        }
        return Ok(json!({
            "tools": visible.len(),
            "groups": groups,
            "listedDirectly": entries.iter().map(|e| json!({ "name": e.name, "summary": e.summary })).collect::<Vec<_>>(),
            "next": "Narrow with {\"group\":\"<group>\"} or {\"q\":\"<words>\"}, then {\"tool\":\"<name>\"} for the schema, and run it with run_tool.",
        }));
    }
    let tokens: Vec<String> = q.iter().flat_map(|q| q.split_whitespace().map(str::to_string)).collect();
    let matches: Vec<&&Tool> = visible
        .iter()
        .filter(|t| group.as_ref().is_none_or(|g| group_of(t).eq_ignore_ascii_case(g) || t.path.trim_start_matches('/').split('/').next() == Some(g.as_str())))
        .filter(|t| {
            let hay = format!("{} {} {}", t.name, t.description, t.path).to_lowercase();
            tokens.iter().all(|w| hay.contains(w))
        })
        .collect();
    const CAP: usize = 60;
    let rows: Vec<Value> = matches
        .iter()
        .take(CAP)
        .map(|t| {
            let mut row = json!({ "name": t.name, "summary": summary(&t.description), "group": group_of(t), "writes": t.method != Method::Get });
            if !permissions.contains(&t.permission) {
                row["available"] = json!(false);
            }
            row
        })
        .collect();
    let mut out = json!({ "matches": matches.len(), "tools": rows });
    if matches.len() > CAP {
        out["truncated"] = json!(format!("showing {CAP} of {}; narrow with q or group", matches.len()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;

    fn catalog() -> Vec<Tool> {
        catalog::load().unwrap()
    }

    #[test]
    fn profiles_parse_and_default_to_core() {
        assert_eq!(Profile::parse("Core"), Some(Profile::Core));
        assert_eq!(Profile::parse(" full "), Some(Profile::Full));
        assert_eq!(Profile::parse("all"), None);
        assert_eq!(Profile::default(), Profile::Core);
    }

    #[test]
    fn the_embedded_curated_profile_is_valid_and_short() {
        let cat = catalog();
        let entries = load(&cat).unwrap();
        let names = core_names(&entries);
        assert!((15..=25).contains(&names.len()), "core has {} tools: {names:?}", names.len());
        assert!(names.len() < 25,"with list_accounts the core must still fit 25");
        for must in ["get_context", "find_work", "create_issue", "start_work", "report_progress", "ask_human", "record_decision", "attach_artifact", "search", "list_capabilities", "run_tool", "api_request"] {
            assert!(names.iter().any(|n| n == must), "core misses {must}");
        }
    }

    #[test]
    fn every_curated_tool_maps_to_existing_endpoints() {
        let cat = catalog();
        for e in load(&cat).unwrap() {
            match e.kind {
                EntryKind::Catalog => assert!(cat.iter().any(|t| t.name == e.name), "{}", e.name),
                EntryKind::Composite => {
                    for u in &e.uses {
                        let t = cat.iter().find(|t| &t.name == u).unwrap_or_else(|| panic!("{} uses unknown {u}", e.name));
                        assert!(!t.path.is_empty() || t.name == "get_workspace", "{u} has no route");
                    }
                    // a composite that writes must say which permissions it needs
                    if !e.read_only && !e.local {
                        assert!(!e.write_permissions(&cat).is_empty(), "{} writes nothing?", e.name);
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_broken_curated_files() {
        let cat = catalog();
        let bad = |s: &str| assert!(parse(s, &cat).is_err(), "{s}");
        bad(r#"[{"summary":"s","name":"nope","kind":"catalog"}]"#);
        bad(r#"[{"summary":"s","name":"search","kind":"catalog","uses":["search"]}]"#);
        bad(r#"[{"summary":"s","name":"get_context","kind":"composite","description":"d","inputSchema":{"type":"object"},"uses":[]}]"#);
        bad(r#"[{"summary":"s","name":"get_context","kind":"composite","description":"d","inputSchema":{"type":"object","additionalProperties":false},"uses":["no_such_tool"]}]"#);
        bad(r#"[{"summary":"s","name":"search","kind":"catalog"},{"summary":"s","name":"search","kind":"catalog"}]"#);
        bad(r#"[{"summary":"s","name":"whoami","kind":"catalog"}]"#);
        // handlers without an entry are rejected too
        bad(r#"[{"summary":"s","name":"search","kind":"catalog"}]"#);
        // a summary is required
        bad(r#"[{"name":"search","kind":"catalog"}]"#);
    }

    #[test]
    fn core_descriptions_are_helpful_but_bounded() {
        let cat = catalog();
        for e in load(&cat).unwrap() {
            let l = e.listing(&cat);
            let d = l["description"].as_str().unwrap();
            assert!(d.len() > 80, "{} description too thin", e.name);
            assert!(d.len() < 1700, "{} description too long ({} bytes)", e.name, d.len());
            assert_eq!(l["inputSchema"]["type"], "object", "{}", e.name);
        }
    }

    #[test]
    fn the_core_listing_is_a_fraction_of_the_full_catalog() {
        let cat = catalog();
        let core: usize = load(&cat).unwrap().iter().map(|e| e.listing(&cat).to_string().len()).sum();
        let full: usize = cat.iter().map(|t| t.listing().to_string().len()).sum();
        eprintln!("tools/list size: core {core} bytes, full {full} bytes");
        assert!(core * 2 < full, "core {core} bytes vs full {full} bytes");
    }

    #[test]
    fn skills_name_core_tools_and_reach_the_rest_through_run_tool() {
        let cat = catalog();
        let mut core: Vec<String> = core_names(&load(&cat).unwrap());
        core.push("list_accounts".into());
        let skills = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
        let mut checked = 0;
        let mut dirs: Vec<_> = std::fs::read_dir(&skills).unwrap().flatten().map(|e| e.path()).collect();
        dirs.sort();
        for dir in dirs {
            // the CLI skill speaks shell commands, which always cover the full catalog
            if !dir.is_dir() || dir.ends_with("trama-cli") {
                continue;
            }
            let Ok(doc) = std::fs::read_to_string(dir.join("SKILL.md")) else { continue };
            for (n, line) in doc.lines().enumerate() {
                // every `snake_case_name` token (inside backticks or code blocks) that is a catalog tool
                for word in line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| w.contains('_') && w.chars().all(|c| c.is_ascii_lowercase() || c == '_')) {
                    let is_tool = cat.iter().any(|t| t.name == word);
                    if is_tool && !core.iter().any(|c| c == word) {
                        assert!(
                            line.contains("run_tool") || line.contains("list_capabilities") || line.contains("`full` profile"),
                            "{}:{} names `{word}`, which the default tool list does not have; reach it through run_tool",
                            dir.join("SKILL.md").display(),
                            n + 1
                        );
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 20, "the scan found almost nothing ({checked})");
    }

    // ── docs: the tool count and table in the READMEs are generated, not typed ──

    fn read(rel: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    /// Replaces what sits between `<!-- {tag}:start -->` and `<!-- {tag}:end -->`.
    fn splice(doc: &str, tag: &str, content: &str) -> String {
        let (start, end) = (format!("<!-- {tag}:start -->"), format!("<!-- {tag}:end -->"));
        let a = doc.find(&start).unwrap_or_else(|| panic!("marker {start} missing")) + start.len();
        let b = doc.find(&end).unwrap_or_else(|| panic!("marker {end} missing"));
        // `-count` markers sit inside a sentence; the others hold a block.
        if tag.ends_with("-count") {
            format!("{}{}{}", &doc[..a], content.trim(), &doc[b..])
        } else {
            format!("{}\n{}\n{}", &doc[..a], content.trim_end(), &doc[b..])
        }
    }

    fn check_doc(rel: &str, tag: &str, content: &str) {
        // A Windows checkout may have CRLF line endings; compare on LF.
        let doc = read(rel).replace("\r\n", "\n");
        let want = splice(&doc, tag, content);
        if want == doc {
            return;
        }
        if std::env::var("UPDATE_MCP_DOCS").is_ok() {
            std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel), want).unwrap();
        } else {
            panic!("{rel} is out of date: run `UPDATE_MCP_DOCS=1 cargo test generated_tool_docs` in mcp/ and commit it");
        }
    }

    #[test]
    fn generated_tool_docs_are_current() {
        let cat = catalog();
        let entries = load(&cat).unwrap();
        let n = core_names(&entries).len();
        let sentence = format!("{n} task-oriented tools by default (the `core` profile; the whole catalog stays one switch away)");
        check_doc("../README.md", "mcp-tools-count", &sentence);
        check_doc("../mcp/README.md", "mcp-tools-count", &sentence);
        check_doc("../mcp/README.md", "mcp-tools-table", &core_table(&entries));
    }
}
