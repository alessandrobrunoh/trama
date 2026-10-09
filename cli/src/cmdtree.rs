//! Turns the shared tool catalog (`mcp/src/tools.json`) into a `trama <resource> <verb>` command tree.
//!
//! Every catalog entry becomes one command, so the CLI can never drift from the MCP server: a new
//! route added to `tools.json` shows up here with its flags, types, enums and permission.
//!
//! * path parameters → positional arguments, in the order they appear in the route
//! * query / body parameters → `--kebab-case` options with the declared type and allowed values
//! * `--data <json|@file|->` supplies a whole JSON body; explicit flags win over it
//! * `--file name=path` reads a long text value from a file (`-` = stdin)
//! * `--unset a,b` sends `null` for optional fields of a PATCH (clears them)

use std::collections::BTreeMap;

use clap::builder::PossibleValuesParser;
use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
use serde_json::{Map, Number, Value};

use crate::catalog::{self, Loc, Method, Param, Tool};
use crate::error::{CliError, Result};
use crate::util;

pub struct Entry {
    pub group: String,
    /// `None` for single-word tools such as `search`: the group itself is the command.
    pub verb: Option<String>,
    pub tool: Tool,
    /// Path parameter names in route order.
    pub positionals: Vec<String>,
}

impl Entry {
    pub fn command_name(&self) -> String {
        match &self.verb {
            Some(v) => format!("{} {v}", self.group),
            None => self.group.clone(),
        }
    }
}

pub struct Registry {
    pub entries: Vec<Entry>,
}

/// Tool names whose `<verb>_<noun>` split would not give the command we want.
const OVERRIDES: &[(&str, &str, &str)] = &[
    ("change_member_role", "member", "set-role"),
    ("get_workstream_context", "workstream", "context"),
    ("get_workstream_graph", "workstream", "graph"),
    ("get_project_context", "project", "context"),
    ("list_project_artifacts", "project", "artifacts"),
    ("list_issue_artifacts", "issue", "artifacts"),
    ("list_webhook_deliveries", "outgoing-webhook", "deliveries"),
];

/// One-line descriptions for groups whose first tool description reads badly as a heading.
const GROUP_ABOUT: &[(&str, &str)] = &[
    ("criterion", "Acceptance criteria of a workstream"),
    ("issue", "Bugs, features, incidents, debt, feedback, ideas and security items"),
    ("workstream", "Units of work an AI/human team ships"),
    ("member", "Workspace members and their roles"),
    ("team", "Teams and their keys"),
    ("project-update", "Status updates (health + write-up) posted on a project"),
    ("token", "API tokens (never their secrets)"),
    ("event", "Activity log of every change"),
];

/// Short names people actually type.
const GROUP_ALIASES: &[(&str, &str)] = &[("workstream", "ws"), ("repository", "repo"), ("outgoing-webhook", "webhook")];

/// Extra verbs for commands people already have a word for: `(group, verb, alias)`.
const VERB_ALIASES: &[(&str, &str, &str)] = &[("project-update", "create", "post"), ("project-update", "update", "edit"), ("artifact", "create", "add")];

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        format!("{stem}y")
    } else if word.ends_with('s') && !word.ends_with("ss") {
        word[..word.len() - 1].to_string()
    } else {
        word.to_string()
    }
}

/// `list_input_requests` → (`input-request`, `list`). Single-word tools return `(name, None)`.
pub fn route(tool: &str) -> (String, Option<String>) {
    if let Some((_, group, verb)) = OVERRIDES.iter().find(|(n, _, _)| *n == tool) {
        return (group.to_string(), Some(verb.to_string()));
    }
    let Some((verb, noun)) = tool.split_once('_') else {
        return (tool.to_string(), None);
    };
    let mut words: Vec<String> = noun.split('_').map(str::to_string).collect();
    if let Some(last) = words.last_mut() {
        *last = singular(last);
    }
    (words.join("-"), Some(verb.to_string()))
}

fn placeholders(path: &str) -> Vec<String> {
    path.split('{').skip(1).filter_map(|s| s.split_once('}').map(|(n, _)| n.to_string())).collect()
}

impl Registry {
    pub fn load() -> std::result::Result<Registry, String> {
        let entries = catalog::load()?
            .into_iter()
            .map(|tool| {
                let (group, verb) = route(&tool.name);
                let positionals = placeholders(&tool.path);
                Entry { group, verb, tool, positionals }
            })
            .collect();
        Ok(Registry { entries })
    }

    pub fn find(&self, group: &str, verb: Option<&str>) -> Option<&Entry> {
        self.entries.iter().find(|e| e.group == group && e.verb.as_deref() == verb)
    }

    pub fn is_group(&self, name: &str) -> bool {
        self.entries.iter().any(|e| e.group == name)
    }

    /// Generated top-level commands (resource groups, plus single-word tools).
    pub fn commands(&self) -> Vec<Command> {
        let mut groups: BTreeMap<&str, Vec<&Entry>> = BTreeMap::new();
        for e in &self.entries {
            groups.entry(&e.group).or_default().push(e);
        }
        let verb_rank = |e: &&Entry| {
            let v = e.verb.as_deref().unwrap_or("");
            (["list", "get", "create", "add", "update", "delete", "remove"].iter().position(|x| *x == v).unwrap_or(99), v.to_string())
        };
        groups
            .into_iter()
            .map(|(group, mut entries)| {
                entries.sort_by_key(verb_rank);
                if entries.len() == 1 && entries[0].verb.is_none() {
                    return tool_command(entries[0], group);
                }
                let about = GROUP_ABOUT
                    .iter()
                    .find(|(g, _)| *g == group)
                    .map(|(_, a)| a.to_string())
                    .or_else(|| entries.iter().find(|e| matches!(e.verb.as_deref(), Some("get" | "list"))).map(|e| first_sentence(&e.tool.description)))
                    .unwrap_or_else(|| format!("{group} commands"));
                let mut cmd = Command::new(group.to_string()).about(about).subcommand_required(true).arg_required_else_help(true);
                if let Some((_, alias)) = GROUP_ALIASES.iter().find(|(g, _)| *g == group) {
                    cmd = cmd.visible_alias(*alias);
                }
                // `issues`, `repositories`: the plural people type for the list.
                if let Some(list) = entries.iter().find(|e| e.verb.as_deref() == Some("list")) {
                    let plural = list.tool.name.strip_prefix("list_").unwrap_or("").replace('_', "-");
                    if !plural.is_empty() && plural != group {
                        cmd = cmd.alias(plural);
                    }
                }
                for e in entries {
                    let verb = e.verb.clone().unwrap_or_default();
                    let mut sub = tool_command(e, &verb);
                    sub = match verb.as_str() {
                        "list" => sub.visible_alias("ls"),
                        "get" => sub.visible_alias("show"),
                        "delete" => sub.visible_alias("rm"),
                        _ => sub,
                    };
                    if let Some((_, _, alias)) = VERB_ALIASES.iter().find(|(g, v, _)| *g == group && *v == verb) {
                        sub = sub.visible_alias(*alias);
                    }
                    cmd = cmd.subcommand(sub);
                }
                cmd
            })
            .collect()
    }
}

pub fn first_sentence(text: &str) -> String {
    let end = text.find(". ").map(|i| i + 1).unwrap_or(text.len());
    text[..end].trim_end_matches('.').to_string()
}

pub fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else if c == '_' {
            out.push('-');
        } else {
            out.push(c);
        }
    }
    out
}

fn value_name(name: &str) -> String {
    kebab(name).to_uppercase().replace('-', "_")
}

fn is_json_type(ty: &str) -> bool {
    matches!(ty, "object" | "object[]")
}

fn option_arg(p: &Param) -> Arg {
    let mut help = String::new();
    if p.required {
        help.push_str("(required) ");
    }
    help.push_str(&p.description);
    match p.ty.as_str() {
        "object" if p.name == "subject" => help.push_str(" [type:id, k=v,k=v, JSON or @file]"),
        "object" => help.push_str(" [k=v,k=v, JSON or @file]"),
        "object[]" => help.push_str(" [JSON array or @file]"),
        _ => {}
    }
    let mut arg = Arg::new(p.name.clone())
        .long(kebab(&p.name))
        .value_name(if is_json_type(&p.ty) { "JSON".to_string() } else { value_name(&p.name) })
        .help(help)
        .help_heading(if p.loc == Loc::Query { "Filters" } else { "Fields" });
    arg = match p.ty.as_str() {
        "boolean" => arg.num_args(0..=1).default_missing_value("true").value_parser(["true", "false"]),
        "integer" => arg.value_parser(value_parser!(i64)).allow_negative_numbers(true),
        "number" => arg.value_parser(value_parser!(f64)).allow_negative_numbers(true),
        "string[]" => arg.value_delimiter(',').action(ArgAction::Append).allow_hyphen_values(true),
        "string" if !p.choices.is_empty() => arg.value_parser(PossibleValuesParser::new(p.choices.clone())),
        _ => arg.allow_hyphen_values(true),
    };
    arg
}

fn tool_command(entry: &Entry, name: &str) -> Command {
    let t = &entry.tool;
    let mut cmd = Command::new(name.to_string()).about(first_sentence(&t.description)).long_about(t.description.clone());
    for ph in &entry.positionals {
        if let Some(p) = t.params.iter().find(|p| &p.name == ph) {
            cmd = cmd.arg(Arg::new(p.name.clone()).value_name(value_name(&p.name)).required(true).help(p.description.clone()));
        }
    }
    for p in t.params.iter().filter(|p| p.loc != Loc::Path) {
        cmd = cmd.arg(option_arg(p));
    }
    if t.params.iter().any(|p| p.loc == Loc::Body) {
        cmd = cmd
            .arg(Arg::new("__data").long("data").short('d').value_name("JSON").help("Whole request body as JSON: inline, @file.json, or - for stdin. Flags override it.").help_heading("Input"))
            .arg(Arg::new("__file").long("file").value_name("FIELD=PATH").action(ArgAction::Append).help("Read a text field from a file (- = stdin), e.g. --file body=notes.md").help_heading("Input"));
        if t.method == Method::Patch {
            cmd = cmd.arg(Arg::new("__unset").long("unset").value_name("FIELD").value_delimiter(',').action(ArgAction::Append).help("Send null for these optional fields (clears them)").help_heading("Input"));
        }
    }
    cmd.after_help(after_help(entry))
}

fn after_help(entry: &Entry) -> String {
    let t = &entry.tool;
    let mut example = format!("trama {}", entry.command_name());
    for ph in &entry.positionals {
        example.push_str(&format!(" <{}>", value_name(ph)));
    }
    for p in t.params.iter().filter(|p| p.required && p.loc != Loc::Path) {
        example.push_str(&format!(" --{} <{}>", kebab(&p.name), value_name(&p.name)));
    }
    let mut text = format!("Example:\n  {example}\n\nRequires permission `{}` · {} /w/<workspace>{}", t.permission, t.method.as_str(), t.path);
    if t.method == Method::Patch {
        text.push_str("\nOptional fields can be cleared with --unset <field>.");
    }
    text
}

/// Reads a JSON argument: inline text, `@path` or `-` (stdin).
pub fn parse_json_arg(raw: &str, what: &str) -> Result<Value> {
    let text = if raw == "-" {
        util::read_stdin()?
    } else if let Some(path) = raw.strip_prefix('@') {
        util::read_path_or_stdin(path)?
    } else {
        raw.to_string()
    };
    serde_json::from_str(&text).map_err(|e| CliError::usage(format!("{what} is not valid JSON: {e}")))
}

/// Objects are JSON, `@file` or `-`; for convenience also `k=v,k=v` and, for `subject`, `type:id`.
fn parse_object_arg(raw: &str, p: &Param) -> Result<Value> {
    let what = format!("--{}", kebab(&p.name));
    let t = raw.trim_start();
    if t.starts_with(['{', '[', '@']) || raw == "-" {
        return parse_json_arg(raw, &what);
    }
    if p.name == "subject"
        && let Some((kind, id)) = raw.split_once(':')
        && !kind.is_empty()
        && !id.is_empty()
        && !kind.contains('=')
    {
        return Ok(serde_json::json!({ "type": kind, "id": id }));
    }
    if raw.contains('=') {
        let mut map = Map::new();
        for pair in raw.split(',') {
            let (k, v) = pair.split_once('=').filter(|(k, _)| !k.trim().is_empty()).ok_or_else(|| CliError::usage(format!("{what}: '{pair}' is not key=value")))?;
            map.insert(k.trim().to_string(), Value::String(v.trim().to_string()));
        }
        return Ok(Value::Object(map));
    }
    parse_json_arg(raw, &what)
}

fn scalar_from(p: &Param, m: &ArgMatches) -> Result<Option<Value>> {
    let id = p.name.as_str();
    if !m.contains_id(id) {
        return Ok(None);
    }
    Ok(Some(match p.ty.as_str() {
        "integer" => Value::from(*m.get_one::<i64>(id).expect("parsed by clap")),
        "number" => {
            let n = *m.get_one::<f64>(id).expect("parsed by clap");
            Number::from_f64(n).map(Value::Number).ok_or_else(|| CliError::usage(format!("--{} must be a finite number", kebab(id))))?
        }
        "boolean" => Value::Bool(m.get_one::<String>(id).is_some_and(|v| v == "true")),
        "string[]" => Value::Array(m.get_many::<String>(id).into_iter().flatten().map(|s| Value::String(s.clone())).collect()),
        "object" => parse_object_arg(m.get_one::<String>(id).expect("parsed by clap"), p)?,
        ty if is_json_type(ty) => parse_json_arg(m.get_one::<String>(id).expect("parsed by clap"), &format!("--{}", kebab(id)))?,
        _ => Value::String(m.get_one::<String>(id).expect("parsed by clap").clone()),
    }))
}

/// Gathers the tool's arguments from the parsed command line, ready for `Tool::build_call`.
pub fn extract(entry: &Entry, m: &ArgMatches) -> Result<Value> {
    let t = &entry.tool;
    let mut args = Map::new();
    if let Some(raw) = m.try_get_one::<String>("__data").ok().flatten() {
        match parse_json_arg(raw, "--data")? {
            Value::Object(o) => args = o,
            _ => return Err(CliError::usage("--data must be a JSON object")),
        }
    }
    for p in &t.params {
        if let Some(v) = scalar_from(p, m)? {
            args.insert(p.name.clone(), v);
        }
    }
    for spec in m.try_get_many::<String>("__file").ok().flatten().into_iter().flatten() {
        let (name, path) = spec.split_once('=').ok_or_else(|| CliError::usage(format!("--file expects FIELD=PATH, got '{spec}'")))?;
        let p = t
            .params
            .iter()
            .find(|p| p.name == name || kebab(&p.name) == name)
            .filter(|p| p.loc != Loc::Path)
            .ok_or_else(|| CliError::usage(format!("--file: '{name}' is not a field of `trama {}`", entry.command_name())))?;
        let text = util::read_path_or_stdin(path)?;
        let value = match p.ty.as_str() {
            "string" => Value::String(text.trim_end_matches('\n').to_string()),
            ty if is_json_type(ty) => serde_json::from_str(&text).map_err(|e| CliError::usage(format!("{path} is not valid JSON: {e}")))?,
            _ => return Err(CliError::usage(format!("--file works for text and JSON fields; '{name}' is a {}", p.ty))),
        };
        args.insert(p.name.clone(), value);
    }
    for name in m.try_get_many::<String>("__unset").ok().flatten().into_iter().flatten() {
        let p = t
            .params
            .iter()
            .find(|p| p.name == *name || kebab(&p.name) == *name)
            .filter(|p| p.loc == Loc::Body && !p.required)
            .ok_or_else(|| CliError::usage(format!("--unset: '{name}' is not an optional field of `trama {}`", entry.command_name())))?;
        args.insert(p.name.clone(), Value::Null);
    }
    Ok(Value::Object(args))
}

/// `missing required argument 'kind'` → `missing required option --kind` (the catalog speaks in parameter names).
pub fn friendly(entry: &Entry, message: &str) -> String {
    let flag = |name: &str| match entry.tool.params.iter().find(|p| p.name == name) {
        Some(p) if p.loc == Loc::Path => format!("<{}>", value_name(name)),
        Some(_) => format!("--{}", kebab(name)),
        None => name.to_string(),
    };
    for (marker, text) in [("missing required argument '", "missing required option "), ("unknown argument '", "unknown field "), ("argument '", "")] {
        if let Some(rest) = message.strip_prefix(marker)
            && let Some((name, tail)) = rest.split_once('\'')
        {
            return format!("{text}{}{tail}", flag(name));
        }
    }
    message.to_string()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;

    use super::*;

    fn registry() -> Registry {
        Registry::load().unwrap()
    }

    fn root() -> Command {
        Command::new("trama").subcommands(registry().commands())
    }

    fn parse(args: &[&str]) -> (Entry, ArgMatches) {
        let m = root().try_get_matches_from(std::iter::once("trama").chain(args.iter().copied())).unwrap();
        let (group, gm) = m.subcommand().unwrap();
        let reg = registry();
        let (verb, vm) = match gm.subcommand() {
            Some((v, vm)) => (Some(v), vm.clone()),
            None => (None, gm.clone()),
        };
        let entry = reg.entries.into_iter().find(|e| e.group == group && e.verb.as_deref() == verb).unwrap();
        (entry, vm)
    }

    #[test]
    fn routes_tool_names_to_commands() {
        let r = |n| route(n);
        assert_eq!(r("list_issues"), ("issue".into(), Some("list".into())));
        assert_eq!(r("list_repositories"), ("repository".into(), Some("list".into())));
        assert_eq!(r("list_dependencies"), ("dependency".into(), Some("list".into())));
        assert_eq!(r("create_input_request"), ("input-request".into(), Some("create".into())));
        assert_eq!(r("get_outgoing_webhook"), ("outgoing-webhook".into(), Some("get".into())));
        assert_eq!(r("list_attention"), ("attention".into(), Some("list".into())));
        assert_eq!(r("get_workstream_context"), ("workstream".into(), Some("context".into())));
        assert_eq!(r("change_member_role"), ("member".into(), Some("set-role".into())));
        assert_eq!(r("add_criterion"), ("criterion".into(), Some("add".into())));
        assert_eq!(r("reorder_milestones"), ("milestone".into(), Some("reorder".into())));
        assert_eq!(r("search"), ("search".into(), None));
    }

    #[test]
    fn every_tool_gets_a_unique_command() {
        let reg = registry();
        let mut seen = HashSet::new();
        for e in &reg.entries {
            assert!(seen.insert(e.command_name()), "duplicate command {}", e.command_name());
        }
        assert!(reg.entries.len() > 80);
    }

    #[test]
    fn the_tree_is_a_valid_clap_command() {
        // Runs clap's debug assertions: duplicate ids/longs, bad value names, positional rules…
        root().debug_assert();
    }

    #[test]
    fn builds_a_body_from_flags() {
        let (e, m) = parse(&["issue", "create", "--kind", "bug", "--title", "-x crashes", "--estimate", "3", "--priority", "high"]);
        let args = extract(&e, &m).unwrap();
        assert_eq!(args, json!({ "kind": "bug", "title": "-x crashes", "estimate": 3.0, "priority": "high" }));
        let call = e.tool.build_call(&args).unwrap();
        assert_eq!(call.path, "/issues");
        assert_eq!(call.body.unwrap()["title"], "-x crashes");
    }

    #[test]
    fn positionals_follow_route_order_and_are_encoded() {
        let (e, m) = parse(&["criterion", "update", "AUTH-42", "crit_1", "--state", "met"]);
        assert_eq!(e.positionals, vec!["idOrKey", "criterionId"]);
        let call = e.tool.build_call(&extract(&e, &m).unwrap()).unwrap();
        assert_eq!(call.path, "/workstreams/AUTH-42/criteria/crit_1");
        assert_eq!(call.body, Some(json!({ "state": "met" })));
    }

    #[test]
    fn criterion_update_carries_evidence_without_touching_state() {
        let evidence = r#"{"artifactIds":["art_1"],"note":"tested on staging"}"#;
        let (e, m) = parse(&["criterion", "update", "AUTH-42", "crit_1", "--evidence", evidence]);
        let call = e.tool.build_call(&extract(&e, &m).unwrap()).unwrap();
        assert_eq!(call.path, "/workstreams/AUTH-42/criteria/crit_1");
        assert_eq!(call.body, Some(json!({ "evidence": { "artifactIds": ["art_1"], "note": "tested on staging" } })));
    }

    #[test]
    fn lists_filters_booleans_and_arrays() {
        let (e, m) = parse(&["issue", "list", "--open", "--priority", "urgent,high", "--q", "login"]);
        let call = e.tool.build_call(&extract(&e, &m).unwrap()).unwrap();
        assert!(call.query.contains(&("open".into(), "true".into())));
        assert!(call.query.contains(&("q".into(), "login".into())));
        let (e, m) = parse(&["team", "create", "--name", "Auth", "--key", "AUTH", "--member-ids", "usr_1,usr_2"]);
        assert_eq!(extract(&e, &m).unwrap()["memberIds"], json!(["usr_1", "usr_2"]));
    }

    #[test]
    fn unset_sends_null_only_for_optional_patch_fields() {
        let (e, m) = parse(&["issue", "update", "BUG-1", "--status", "done", "--unset", "estimate,assigneeId"]);
        let call = e.tool.build_call(&extract(&e, &m).unwrap()).unwrap();
        assert_eq!(call.body, Some(json!({ "status": "done", "estimate": null, "assigneeId": null })));
        let (e, m) = parse(&["issue", "update", "BUG-1", "--unset", "idOrKey"]);
        assert!(extract(&e, &m).is_err());
    }

    #[test]
    fn data_is_the_base_and_flags_win() {
        let (e, m) = parse(&["issue", "create", "--data", r#"{"kind":"bug","title":"from json","priority":"low"}"#, "--title", "from flag"]);
        let args = extract(&e, &m).unwrap();
        assert_eq!(args, json!({ "kind": "bug", "title": "from flag", "priority": "low" }));
        let (e, m) = parse(&["issue", "create", "--data", "[1]"]);
        assert!(extract(&e, &m).is_err());
    }

    #[test]
    fn object_flags_accept_shorthand_json_and_files() {
        let (e, m) = parse(&["comment", "create", "--subject", "issue:iss_1", "--body", "hi"]);
        assert_eq!(extract(&e, &m).unwrap()["subject"], json!({ "type": "issue", "id": "iss_1" }));
        let (e, m) = parse(&["comment", "create", "--subject", "type=decision,id=dec_1", "--body", "hi"]);
        assert_eq!(extract(&e, &m).unwrap()["subject"], json!({ "type": "decision", "id": "dec_1" }));
        let (e, m) = parse(&["comment", "create", "--subject", r#"{"type":"team","id":"tm_1"}"#, "--body", "hi"]);
        assert_eq!(extract(&e, &m).unwrap()["subject"], json!({ "type": "team", "id": "tm_1" }));
        let (e, m) = parse(&["comment", "create", "--subject", "nonsense", "--body", "hi"]);
        assert!(extract(&e, &m).is_err());
        let (e, m) = parse(&["comment", "create", "--subject", "a=1,b", "--body", "hi"]);
        assert!(extract(&e, &m).is_err());
    }

    #[test]
    fn rejects_bad_enum_values_at_parse_time() {
        let r = root().try_get_matches_from(["trama", "issue", "create", "--kind", "nope", "--title", "x"]);
        assert!(r.is_err());
    }

    #[test]
    fn aliases_work() {
        for args in [["issues", "ls"], ["ws", "ls"], ["repo", "ls"], ["repositories", "list"], ["webhook", "list"]] {
            assert!(root().try_get_matches_from(["trama", args[0], args[1]]).is_ok(), "{args:?}");
        }
    }

    #[test]
    fn friendly_messages_use_flag_names() {
        let reg = registry();
        let e = reg.find("issue", Some("create")).unwrap();
        assert_eq!(friendly(e, "missing required argument 'kind'"), "missing required option --kind");
        assert_eq!(friendly(e, "argument 'title' must be string"), "--title must be string");
        assert_eq!(friendly(e, "unknown argument 'zzz'"), "unknown field zzz");
        assert_eq!(kebab("includeArtifacts"), "include-artifacts");
        assert_eq!(kebab("idOrKey"), "id-or-key");
    }
}
