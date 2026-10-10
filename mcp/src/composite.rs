//! Composite (task-level) tools of the curated profile. Each one orchestrates several catalog
//! calls (`tools.json`) so an agent expresses an intent ("report progress", "ask a human") in one
//! tool call instead of choosing among dozens of CRUD endpoints.
//!
//! They add no authority: every step goes through the same catalog validation, the same permission
//! check and the same upstream API as the plain tools, with the caller's own key. Which catalog
//! tools a composite may call is declared in `curated.json` (`uses`) and enforced at run time.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::catalog::Tool;
use crate::protocol::Account;
use crate::upstream::Upstream;

/// Composite tools implemented here (the others are `local` to the protocol layer).
pub const HANDLERS: &[&str] = &[
    "get_context",
    "find_work",
    "create_issue",
    "start_work",
    "report_progress",
    "ask_human",
    "record_decision",
    "attach_artifact",
    "add_comment",
    "triage_issues",
];

/// What a composite returns: a value to render, and whether any step failed.
pub struct Outcome {
    pub value: Value,
    pub failed: bool,
}

impl Outcome {
    fn ok(value: Value) -> Self {
        Self { value, failed: false }
    }
    fn with(value: Value, failed: bool) -> Self {
        Self { value, failed }
    }
}

type Res = Result<Outcome, String>;

// ───────────────────────────── executing catalog calls ─────────────────────────────

#[derive(Debug)]
pub enum StepError {
    Denied(String),
    Invalid(String),
    Api { status: Option<u16>, message: String },
}

impl StepError {
    fn from_text(text: String) -> Self {
        let status = text
            .strip_prefix("HTTP ")
            .and_then(|r| r.split(':').next())
            .and_then(|n| n.trim().parse().ok());
        StepError::Api { status, message: text }
    }
    pub fn message(&self) -> String {
        match self {
            StepError::Denied(p) => format!("your API key lacks the \"{p}\" permission"),
            StepError::Invalid(m) => format!("invalid arguments: {m}"),
            StepError::Api { message, .. } => message.clone(),
        }
    }
    fn not_found(&self) -> bool {
        matches!(self, StepError::Api { status: Some(404), .. })
    }
}

/// One composite run against one workspace.
pub struct Exec<'a> {
    pub upstream: &'a Upstream,
    pub tools: &'a [Tool],
    pub account: &'a Account,
    /// The catalog tools this composite declared in `curated.json`.
    pub uses: &'a [String],
}

impl Exec<'_> {
    pub fn tool(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|t| t.name == name)
    }

    /// Runs one catalog tool with the caller's key and returns its parsed reply (text replies,
    /// such as markdown briefings, come back as a JSON string).
    pub async fn call(&self, name: &str, args: Value) -> Result<Value, StepError> {
        if !self.uses.iter().any(|u| u == name) {
            return Err(StepError::Invalid(format!("internal error: {name} is not declared in `uses`")));
        }
        let tool = self.tool(name).ok_or_else(|| StepError::Invalid(format!("unknown catalog tool {name}")))?;
        if !self.account.who.permissions.contains(&tool.permission) {
            return Err(StepError::Denied(tool.permission.clone()));
        }
        let call = tool.build_call(&args).map_err(StepError::Invalid)?;
        let out = self.upstream.call(&self.account.key, &self.account.who.slug, &call).await;
        if out.is_error {
            return Err(StepError::from_text(out.text));
        }
        Ok(serde_json::from_str(&out.text).unwrap_or(Value::String(out.text)))
    }

    /// Whether `value` is one of the declared choices of `param` of `tool` (true when it has none).
    fn accepts(&self, tool: &str, param: &str, value: &str) -> bool {
        self.tool(tool)
            .and_then(|t| t.params.iter().find(|p| p.name == param))
            .is_some_and(|p| p.choices.is_empty() || p.choices.iter().any(|c| c == value))
    }

    /// The user behind the key (`assignee: "me"`). Agent tokens have no user.
    fn me(&self) -> Result<String, String> {
        let actor = self.account.who.raw.get("actor");
        match (actor.and_then(|a| a["type"].as_str()), actor.and_then(|a| a["id"].as_str())) {
            (Some("user"), Some(id)) => Ok(id.to_string()),
            _ => Err("assignee 'me' needs a key that acts as a user; pass a user id instead".into()),
        }
    }
}

// ───────────────────────────── argument validation ─────────────────────────────

fn is_unset(v: &Value) -> bool {
    v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty())
}

/// Validates `args` against a composite's JSON schema (the small subset curated.json uses) and drops
/// the null / blank optional values models like to send. Returns the cleaned object.
pub fn normalize(schema: &Value, args: &Value) -> Result<Value, String> {
    let empty = Map::new();
    let obj = match args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return Err("arguments must be an object".into()),
    };
    check_object(schema, obj, "")
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}

fn check_object(schema: &Value, obj: &Map<String, Value>, path: &str) -> Result<Value, String> {
    let props = schema.get("properties").and_then(Value::as_object);
    let required: Vec<&str> =
        schema.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut out = Map::new();
    for (k, v) in obj {
        let Some(prop) = props.and_then(|p| p.get(k)) else {
            if props.is_some() {
                return Err(format!("unknown argument '{}'", join(path, k)));
            }
            out.insert(k.clone(), v.clone());
            continue;
        };
        if is_unset(v) {
            continue; // reported below when required
        }
        out.insert(k.clone(), check_value(prop, v, &join(path, k))?);
    }
    for r in required {
        if !out.contains_key(r) {
            return Err(format!("missing required argument '{}'", join(path, r)));
        }
    }
    Ok(Value::Object(out))
}

fn check_value(prop: &Value, v: &Value, path: &str) -> Result<Value, String> {
    let ty = prop.get("type").and_then(Value::as_str).unwrap_or("");
    let bad = |expected: &str| Err(format!("argument '{path}' must be {expected}"));
    match ty {
        "string" => {
            let Some(s) = v.as_str() else { return bad("a string") };
            if let Some(choices) = prop.get("enum").and_then(Value::as_array)
                && !choices.iter().any(|c| c.as_str() == Some(s))
            {
                let list: Vec<&str> = choices.iter().filter_map(Value::as_str).collect();
                return bad(&format!("one of {}", list.join("|")));
            }
            Ok(v.clone())
        }
        "number" if v.is_number() => Ok(v.clone()),
        "number" => bad("a number"),
        "integer" if v.is_i64() || v.is_u64() => Ok(v.clone()),
        "integer" => bad("an integer"),
        "boolean" if v.is_boolean() => Ok(v.clone()),
        "boolean" => bad("a boolean"),
        "object" => {
            let Some(m) = v.as_object() else { return bad("an object") };
            if prop.get("properties").is_some() { check_object(prop, m, path) } else { Ok(v.clone()) }
        }
        "array" => {
            let Some(items) = v.as_array() else { return bad("an array") };
            if let Some(max) = prop.get("maxItems").and_then(Value::as_u64)
                && items.len() as u64 > max
            {
                return bad(&format!("an array of at most {max} items"));
            }
            let item_schema = prop.get("items").cloned().unwrap_or(Value::Null);
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                out.push(check_value(&item_schema, item, &format!("{path}[{i}]"))?);
            }
            Ok(Value::Array(out))
        }
        _ => Ok(v.clone()),
    }
}

// ───────────────────────────── small helpers ─────────────────────────────

fn text<'a>(a: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn strings(a: &Map<String, Value>, k: &str) -> Vec<String> {
    a.get(k).and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn flag(a: &Map<String, Value>, k: &str) -> Option<bool> {
    a.get(k).and_then(Value::as_bool)
}

fn pick(v: &Value, fields: &[&str]) -> Value {
    let mut out = Map::new();
    for f in fields {
        if let Some(x) = v.get(*f)
            && !x.is_null()
        {
            out.insert((*f).to_string(), x.clone());
        }
    }
    Value::Object(out)
}

/// Rows of a list reply (a bare array, or `{ results | items: [...] }`).
fn rows(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => ["results", "items"].iter().find_map(|k| o.get(*k).and_then(Value::as_array)).cloned().unwrap_or_default(),
        _ => vec![],
    }
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn issue_summary(v: &Value) -> Value {
    pick(v, &["key", "id", "title", "kind", "status", "priority", "assigneeId", "projectId", "teamId", "workstreamIds", "duplicateOfId"])
}

fn criteria_of(ws: &Value) -> Vec<Value> {
    ws.get("acceptanceCriteria").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn numbered_criteria(ws: &Value) -> Value {
    Value::Array(
        criteria_of(ws)
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut row = json!({ "n": i + 1, "id": c["id"], "text": c["text"], "state": c["state"] });
                for k in ["evidence", "verifiedBy", "verifiedAt"] {
                    if !c[k].is_null() {
                        row[k] = c[k].clone();
                    }
                }
                row
            })
            .collect(),
    )
}

/// `update_criterion` arguments; `evidence` is passed through only when it holds something.
fn criterion_args(workstream: &str, criterion: &Value, state: &str, evidence: Option<&Value>) -> Value {
    let mut args = json!({ "idOrKey": workstream, "criterionId": criterion, "state": state });
    if has_evidence(evidence) {
        args["evidence"] = evidence.cloned().unwrap_or(Value::Null);
    }
    args
}

fn has_evidence(evidence: Option<&Value>) -> bool {
    evidence.is_some_and(|e| e.get("note").and_then(Value::as_str).is_some_and(|n| !n.trim().is_empty()) || e.get("artifactIds").and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
}

fn workstream_summary(ws: &Value) -> Value {
    let criteria = criteria_of(ws);
    let met = criteria.iter().filter(|c| c["state"] == "met").count();
    let mut v = pick(ws, &["key", "id", "title", "status", "derivedStatus", "statusSource", "delivery", "completion", "priority", "projectId", "ownerTeamId"]);
    v["criteria"] = json!({ "met": met, "total": criteria.len() });
    v
}

// ───────────────────────────── resolving keys and ids ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Issue,
    Workstream,
    Project,
    Decision,
    InputRequest,
    Artifact,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "issue" => Kind::Issue,
            "workstream" => Kind::Workstream,
            "project" => Kind::Project,
            "decision" => Kind::Decision,
            "input_request" => Kind::InputRequest,
            "artifact" => Kind::Artifact,
            _ => return None,
        })
    }
    fn subject(self) -> &'static str {
        match self {
            Kind::Issue => "issue",
            Kind::Workstream => "workstream",
            Kind::Project => "project",
            Kind::Decision => "decision",
            Kind::InputRequest => "input_request",
            Kind::Artifact => "artifact",
        }
    }
    /// The catalog tool that reads one, and the name of its path argument.
    fn getter(self) -> (&'static str, &'static str) {
        match self {
            Kind::Issue => ("get_issue", "idOrKey"),
            Kind::Workstream => ("get_workstream", "idOrKey"),
            Kind::Project => ("get_project", "id"),
            Kind::Decision => ("get_decision", "idOrKey"),
            Kind::InputRequest => ("get_input_request", "id"),
            Kind::Artifact => ("get_artifact", "id"),
        }
    }
}

const ISSUE_PREFIXES: &[&str] = &["BUG", "FEAT", "INC", "DEBT", "FB", "IDEA", "SEC"];

fn kind_by_id_prefix(r: &str) -> Option<Kind> {
    match r.split_once('_')?.0 {
        "in" | "iss" => Some(Kind::Issue),
        "wk" => Some(Kind::Workstream),
        "pj" | "prj" => Some(Kind::Project),
        "dc" | "dec" => Some(Kind::Decision),
        "ir" => Some(Kind::InputRequest),
        "ar" => Some(Kind::Artifact),
        _ => None,
    }
}

/// Which kinds a reference can be, most likely first.
fn candidates(r: &str, hint: Option<Kind>) -> Vec<Kind> {
    if let Some(k) = hint {
        return vec![k];
    }
    if let Some(k) = kind_by_id_prefix(r) {
        return vec![k];
    }
    if let Some((prefix, number)) = r.rsplit_once('-')
        && !prefix.is_empty()
        && prefix.chars().all(|c| c.is_ascii_alphabetic())
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
    {
        let up = prefix.to_ascii_uppercase();
        if ISSUE_PREFIXES.contains(&up.as_str()) {
            return vec![Kind::Issue];
        }
        if up == "ADR" {
            return vec![Kind::Decision];
        }
        // Team keys name workstreams; an old issue key can have any kind prefix.
        return vec![Kind::Workstream, Kind::Issue];
    }
    vec![]
}

struct Entity {
    kind: Kind,
    id: String,
    raw: Option<Value>,
}

impl Entity {
    fn raw(&self) -> &Value {
        self.raw.as_ref().unwrap_or(&Value::Null)
    }
    fn subject(&self) -> Value {
        json!({ "type": self.kind.subject(), "id": self.id })
    }
}

/// Turns a key or id into an entity. Ids need no round trip unless `fetch` (the record is wanted);
/// keys always do, because the API wants ids in bodies.
async fn resolve(ex: &Exec<'_>, r: &str, hint: Option<Kind>, fetch: bool) -> Result<Entity, String> {
    let cands = candidates(r, hint);
    if cands.is_empty() {
        return Err(format!("'{r}' is not an id or a key (expected e.g. AUTH-42, BUG-142, ADR-21, wk_…, in_…)"));
    }
    let by_id = kind_by_id_prefix(r).is_some();
    if by_id && !fetch {
        return Ok(Entity { kind: cands[0], id: r.to_string(), raw: None });
    }
    let mut missing = String::new();
    for kind in &cands {
        let (tool, arg) = kind.getter();
        match ex.call(tool, json!({ arg: r })).await {
            Ok(v) => {
                let id = v["id"].as_str().unwrap_or(r).to_string();
                return Ok(Entity { kind: *kind, id, raw: Some(v) });
            }
            Err(e) if e.not_found() => missing = format!("no {} '{r}' (or it is not visible to this key)", kind.subject().replace('_', " ")),
            Err(e) => return Err(e.message()),
        }
    }
    Err(missing)
}

async fn resolve_workstream_id(ex: &Exec<'_>, r: &str) -> Result<String, String> {
    Ok(resolve(ex, r, Some(Kind::Workstream), false).await?.id)
}

async fn resolve_workstream_ids(ex: &Exec<'_>, refs: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for r in refs {
        out.push(resolve(ex, r, Some(Kind::Workstream), false).await?.id);
    }
    Ok(out)
}

// ───────────────────────────── dispatch ─────────────────────────────

/// Runs the composite `name`. `None` = not a composite handled here.
pub async fn run(name: &str, args: &Value, ex: &Exec<'_>) -> Option<Res> {
    let empty = Map::new();
    let a = args.as_object().unwrap_or(&empty);
    Some(match name {
        "get_context" => get_context(a, ex).await,
        "find_work" => find_work(a, ex).await,
        "create_issue" => create_issue(a, ex).await,
        "start_work" => start_work(a, ex).await,
        "report_progress" => report_progress(a, ex).await,
        "ask_human" => ask_human(a, ex).await,
        "record_decision" => record_decision(a, ex).await,
        "attach_artifact" => attach_artifact(a, ex).await,
        "add_comment" => add_comment(a, ex).await,
        "triage_issues" => triage_issues(a, ex).await,
        _ => return None,
    })
}

// ───────────────────────────── get_context ─────────────────────────────

async fn get_context(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let id = text(a, "id").ok_or("id is required")?;
    let hint = text(a, "type").and_then(Kind::parse);
    let cands = candidates(id, hint);
    if cands.is_empty() {
        return Err(format!("'{id}' is not an id or a key (expected e.g. AUTH-42, BUG-142, ADR-21, wk_…, in_…, pj_…)"));
    }
    let mut missing = String::new();
    for kind in cands {
        match context_of(kind, id, flag(a, "comments").unwrap_or(false), ex).await {
            Ok(out) => return Ok(out),
            Err(e) if e.not_found() => missing = format!("no {} '{id}' (or it is not visible to this key)", kind.subject().replace('_', " ")),
            Err(e) => return Err(e.message()),
        }
    }
    Err(missing)
}

async fn context_of(kind: Kind, id: &str, comments: bool, ex: &Exec<'_>) -> Result<Outcome, StepError> {
    match kind {
        Kind::Workstream => Ok(Outcome::ok(ex.call("get_workstream_context", json!({ "idOrKey": id })).await?)),
        Kind::Project => Ok(Outcome::ok(ex.call("get_project_context", json!({ "id": id })).await?)),
        Kind::Issue => {
            let issue = ex.call("get_issue", json!({ "idOrKey": id })).await?;
            let mut warnings: Vec<String> = vec![];
            let mut workstreams = vec![];
            let ids: Vec<String> = issue["workstreamIds"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            for wid in ids.iter().take(5) {
                match ex.call("get_workstream", json!({ "idOrKey": wid })).await {
                    Ok(ws) => workstreams.push(workstream_summary(&ws)),
                    Err(e) => warnings.push(format!("workstream {wid}: {}", e.message())),
                }
            }
            let artifacts = match ex.call("list_issue_artifacts", json!({ "idOrKey": id })).await {
                Ok(v) => rows(&v).iter().map(|x| pick(x, &["id", "kind", "title", "state", "ci", "review", "url", "externalId", "workstreamId"])).collect::<Vec<_>>(),
                Err(e) => {
                    warnings.push(format!("artifacts: {}", e.message()));
                    vec![]
                }
            };
            let mut out = json!({ "type": "issue", "issue": issue, "workstreams": workstreams, "artifacts": artifacts });
            if comments {
                let subject_id = out["issue"]["id"].as_str().unwrap_or(id).to_string();
                match ex.call("list_comments", json!({ "subjectType": "issue", "subjectId": subject_id })).await {
                    Ok(v) => {
                        let all = rows(&v);
                        let skip = all.len().saturating_sub(20);
                        out["comments"] = Value::Array(all.into_iter().skip(skip).collect());
                    }
                    Err(e) => warnings.push(format!("comments: {}", e.message())),
                }
            }
            if !warnings.is_empty() {
                out["warnings"] = json!(warnings);
            }
            Ok(Outcome::ok(out))
        }
        Kind::Decision | Kind::InputRequest | Kind::Artifact => {
            let (tool, arg) = kind.getter();
            let v = ex.call(tool, json!({ arg: id })).await?;
            Ok(Outcome::ok(json!({ "type": kind.subject(), "record": v })))
        }
    }
}

// ───────────────────────────── find_work ─────────────────────────────

async fn find_work(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let scope = text(a, "scope").unwrap_or("all");
    let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 100) as usize;
    let open = flag(a, "open").unwrap_or(true);
    let status = text(a, "status");
    let assignee = match text(a, "assignee") {
        Some("me") => Some(ex.me()?),
        Some(other) => Some(other.to_string()),
        None => None,
    };
    let all = scope == "all";
    let mut out = Map::new();
    let mut hint = vec![];
    let mut failed = false;

    if scope == "issues" || all {
        // In `all`, a status or filter that only fits workstreams silently skips the issues.
        let fits = status.is_none_or(|s| ex.accepts("list_issues", "status", s));
        if fits {
            let mut q = Map::new();
            for (k, v) in [("q", text(a, "q")), ("priority", text(a, "priority")), ("kind", text(a, "kind")), ("projectId", text(a, "projectId")), ("teamId", text(a, "teamId")), ("status", status)] {
                if let Some(v) = v {
                    q.insert(k.into(), json!(v));
                }
            }
            if let Some(u) = &assignee {
                q.insert("assigneeId".into(), json!(u));
            }
            if open && status.is_none() {
                q.insert("open".into(), json!(true));
            }
            q.insert("limit".into(), json!(limit));
            match ex.call("list_issues", Value::Object(q)).await {
                Ok(v) => {
                    let list = rows(&v);
                    out.insert("issues".into(), Value::Array(list.iter().take(limit).map(issue_summary).collect()));
                    if list.len() >= limit {
                        hint.push(format!("issues capped at {limit}: narrow with q, status or projectId"));
                    }
                }
                Err(e) => {
                    failed = true;
                    out.insert("issuesError".into(), json!(e.message()));
                }
            }
        }
    }
    if scope == "workstreams" || all {
        let fits = status.is_none_or(|s| ex.accepts("list_workstreams", "status", s)) && (!all || text(a, "kind").is_none());
        if fits {
            let mut q = Map::new();
            for (k, v) in [("q", text(a, "q")), ("projectId", text(a, "projectId")), ("teamId", text(a, "teamId")), ("repositoryId", text(a, "repositoryId")), ("status", status)] {
                if let Some(v) = v {
                    q.insert(k.into(), json!(v));
                }
            }
            if let Some(p) = text(a, "priority")
                && ex.accepts("list_workstreams", "priority", p)
            {
                q.insert("priority".into(), json!(p));
            }
            if let Some(u) = &assignee {
                q.insert("accountableUserId".into(), json!(u));
            }
            match ex.call("list_workstreams", Value::Object(q)).await {
                Ok(v) => {
                    let mut list = rows(&v);
                    if open && status.is_none() {
                        list.retain(|w| !matches!(w["status"].as_str(), Some("shipped" | "canceled")));
                    }
                    let total = list.len();
                    out.insert("workstreams".into(), Value::Array(list.iter().take(limit).map(workstream_summary).collect()));
                    if total > limit {
                        hint.push(format!("{total} workstreams matched, showing {limit}: narrow with q, status or projectId"));
                    }
                }
                Err(e) => {
                    failed = true;
                    out.insert("workstreamsError".into(), json!(e.message()));
                }
            }
        }
    }
    if scope == "input_requests" {
        let mut q = Map::new();
        q.insert("state".into(), json!(status.unwrap_or("open")));
        if let Some(u) = &assignee {
            q.insert("assigneeUserId".into(), json!(u));
        }
        let v = ex.call("list_input_requests", Value::Object(q)).await.map_err(|e| e.message())?;
        let list = rows(&v);
        out.insert("inputRequests".into(), Value::Array(list.into_iter().take(limit).collect()));
    }
    if scope == "decisions" {
        let mut q = Map::new();
        for (k, v) in [("q", text(a, "q")), ("status", status)] {
            if let Some(v) = v {
                q.insert(k.into(), json!(v));
            }
        }
        let v = ex.call("list_decisions", Value::Object(q)).await.map_err(|e| e.message())?;
        let list = rows(&v);
        out.insert("decisions".into(), Value::Array(list.iter().take(limit).map(|d| pick(d, &["key", "id", "title", "status", "originWorkstreamId", "tags"])).collect()));
    }
    if !hint.is_empty() {
        out.insert("hint".into(), json!(hint));
    }
    Ok(Outcome::with(Value::Object(out), failed))
}

// ───────────────────────────── create_issue ─────────────────────────────

async fn create_issue(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let title = text(a, "title").ok_or("title is required")?;
    let force = flag(a, "force").unwrap_or(false);
    let mut similar: Vec<Value> = vec![];

    // Search first: an open issue with the very same title is a duplicate, not a new issue.
    if ex.uses.iter().any(|u| u == "search")
        && let Ok(found) = ex.call("search", json!({ "q": title, "types": "issue", "limit": 10 })).await
    {
        for r in rows(&found) {
            if r["type"] != "issue" {
                continue;
            }
            let status = r["subtitle"].as_str().and_then(|s| s.rsplit(" · ").next()).unwrap_or("");
            let open = !matches!(status, "done" | "canceled");
            if open && norm(r["title"].as_str().unwrap_or("")) == norm(title) && !force {
                return Ok(Outcome::ok(json!({
                    "created": false,
                    "reason": "an open issue with this title already exists",
                    "existing": pick(&r, &["key", "id", "title", "subtitle"]),
                    "hint": "Update or comment on it (update_issue, add_comment), or pass force:true to create anyway.",
                })));
            }
            if open {
                similar.push(pick(&r, &["key", "id", "title", "subtitle"]));
            }
        }
    }

    let mut body = Map::new();
    for k in ["title", "body", "reporterName", "assigneeId", "teamId", "projectId", "priority", "status", "externalUrl", "estimate", "kind", "source", "labels"] {
        if let Some(v) = a.get(k) {
            body.insert(k.into(), v.clone());
        }
    }
    body.entry("source").or_insert(json!("agent"));
    let created = ex.call("create_issue", Value::Object(body)).await.map_err(|e| e.message())?;
    let id = created["id"].as_str().unwrap_or("").to_string();
    let mut out = json!({ "created": true, "issue": issue_summary(&created) });
    let mut failed = false;

    let link = if let Some(ws) = text(a, "workstream") {
        match resolve_workstream_id(ex, ws).await {
            Ok(wid) => Some(json!({ "idOrKey": id, "workstreamIds": [wid] })),
            Err(e) => {
                out["linkError"] = json!(e);
                failed = true;
                None
            }
        }
    } else {
        a.get("createWorkstream").map(|cw| json!({ "idOrKey": id, "createWorkstream": cw }))
    };
    if let Some(args) = link {
        match ex.call("link_issue", args).await {
            Ok(linked) => {
                out["linked"] = pick(&linked, &["workstreamIds", "status"]);
                if let Some(ws) = linked.get("workstream").or_else(|| linked.get("createdWorkstream")) {
                    out["workstream"] = pick(ws, &["key", "id", "title"]);
                }
            }
            Err(e) => {
                out["linkError"] = json!(e.message());
                failed = true;
            }
        }
    }
    if !similar.is_empty() {
        similar.truncate(5);
        out["similarOpenIssues"] = json!(similar);
    }
    Ok(Outcome::with(out, failed))
}

// ───────────────────────────── start_work ─────────────────────────────

fn match_criterion(list: &[Value], sel: &str) -> Result<usize, String> {
    let s = sel.trim();
    if let Some(i) = list.iter().position(|c| c["id"].as_str() == Some(s)) {
        return Ok(i);
    }
    let digits = s.trim_start_matches('#');
    if !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
        && let Ok(n) = digits.parse::<usize>()
    {
        return if (1..=list.len()).contains(&n) { Ok(n - 1) } else { Err(format!("criterion '{s}': there are {} criteria", list.len())) };
    }
    let needle = norm(s);
    let hits: Vec<usize> = list.iter().enumerate().filter(|(_, c)| norm(c["text"].as_str().unwrap_or("")).contains(&needle)).map(|(i, _)| i).collect();
    match hits.as_slice() {
        [one] => Ok(*one),
        [] => Err(format!("criterion '{s}' matches no criterion (use its id or position 1-{})", list.len())),
        _ => Err(format!("criterion '{s}' matches {} criteria; use its id or position", hits.len())),
    }
}

async fn start_work(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let key = text(a, "key").ok_or("key is required")?;
    let target = resolve(ex, key, None, true).await?;
    let mut stop: Vec<String> = vec![];
    let mut cautions: Vec<String> = vec![];
    let mut actions: Vec<String> = vec![];
    let mut failures: Vec<String> = vec![];

    let (issue, ws): (Option<Entity>, Option<Entity>) = match target.kind {
        Kind::Workstream => (None, Some(target)),
        Kind::Issue => {
            let wanted = match text(a, "workstream") {
                Some(w) => Some(w.to_string()),
                None => target.raw()["workstreamIds"].as_array().and_then(|ids| ids.first()).and_then(Value::as_str).map(str::to_string),
            };
            let others = target.raw()["workstreamIds"].as_array().map_or(0, Vec::len);
            if others > 1 && text(a, "workstream").is_none() {
                cautions.push(format!("the issue is on {others} workstreams; working for the first one (pass `workstream` to choose)"));
            }
            let ws = match wanted {
                Some(w) => Some(resolve(ex, &w, Some(Kind::Workstream), true).await?),
                None => {
                    cautions.push("the issue is on no workstream: fine for a small fix; group related issues with link_issue".into());
                    None
                }
            };
            (Some(target), ws)
        }
        other => return Err(format!("start_work takes a workstream or an issue, not a {}", other.subject().replace('_', " "))),
    };

    if let Some(i) = &issue
        && let Some(s @ ("done" | "canceled")) = i.raw()["status"].as_str()
    {
        stop.push(format!("the issue is already {s}"));
    }
    let mut briefing = Value::Null;
    if let Some(w) = &ws {
        match w.raw()["status"].as_str() {
            Some("blocked") => stop.push("the workstream is blocked (a dependency has not shipped, or a PR has failing CI or conflicts); tell the user".into()),
            Some(s @ ("shipped" | "canceled")) => stop.push(format!("the workstream is {s}")),
            _ => {}
        }
        match ex.call("get_workstream_context", json!({ "idOrKey": w.id })).await {
            Ok(v) => briefing = v,
            Err(e) => cautions.push(format!("could not load the briefing: {}", e.message())),
        }
        match ex.call("list_input_requests", json!({ "workstreamId": w.id, "state": "open" })).await {
            Ok(v) => {
                for r in rows(&v) {
                    cautions.push(format!("open input request {}: \"{}\" (its answer may change the approach)", r["id"].as_str().unwrap_or("?"), r["question"].as_str().unwrap_or("")));
                }
            }
            Err(e) => cautions.push(format!("could not check input requests: {}", e.message())),
        }
        match ex.call("list_decisions", json!({ "workstreamId": w.id, "status": "proposed" })).await {
            Ok(v) => {
                for d in rows(&v) {
                    cautions.push(format!("proposed decision {} \"{}\" is not accepted yet; ask before touching that area", d["key"].as_str().unwrap_or("?"), d["title"].as_str().unwrap_or("")));
                }
            }
            Err(e) => cautions.push(format!("could not check decisions: {}", e.message())),
        }
        if criteria_of(w.raw()).is_empty() && strings(a, "addCriteria").is_empty() {
            cautions.push("the workstream has no acceptance criteria: propose observable ones with addCriteria and confirm them with the user".into());
        }
    }

    let ready = stop.is_empty();
    let mut criteria_view = ws.as_ref().map(|w| numbered_criteria(w.raw())).unwrap_or(Value::Null);
    if ready {
        if let Some(w) = &ws {
            for text_ in strings(a, "addCriteria") {
                match ex.call("add_criterion", json!({ "idOrKey": w.id, "text": text_ })).await {
                    Ok(_) => actions.push(format!("added criterion \"{text_}\"")),
                    Err(e) => failures.push(format!("add criterion \"{text_}\": {}", e.message())),
                }
            }
            let list = criteria_of(w.raw());
            let mut chosen: Vec<usize> = vec![];
            let selectors = strings(a, "criteria");
            if selectors.is_empty() {
                let started = list.iter().any(|c| c["state"] == "in_progress");
                if !started && let Some(i) = list.iter().position(|c| c["state"] != "met") {
                    chosen.push(i);
                }
            } else {
                for s in &selectors {
                    match match_criterion(&list, s) {
                        Ok(i) => chosen.push(i),
                        Err(e) => failures.push(e),
                    }
                }
            }
            for i in chosen {
                let c = &list[i];
                if c["state"] != "pending" {
                    continue;
                }
                match ex.call("update_criterion", json!({ "idOrKey": w.id, "criterionId": c["id"], "state": "in_progress" })).await {
                    Ok(_) => {
                        actions.push(format!("criterion {} set to in_progress", i + 1));
                        if let Some(row) = criteria_view.get_mut(i) {
                            row["state"] = json!("in_progress");
                        }
                    }
                    Err(e) => failures.push(format!("criterion {}: {}", i + 1, e.message())),
                }
            }
        }
        if let Some(i) = &issue
            && i.raw()["status"] != "in_progress"
        {
            match ex.call("update_issue", json!({ "idOrKey": i.id, "status": "in_progress" })).await {
                Ok(_) => actions.push("issue set to in_progress".into()),
                Err(e) => failures.push(format!("issue status: {}", e.message())),
            }
        }
        if let Some(plan) = text(a, "plan") {
            let subject = ws.as_ref().or(issue.as_ref()).map(Entity::subject);
            if let Some(subject) = subject {
                match ex.call("create_comment", json!({ "subject": subject, "body": plan })).await {
                    Ok(_) => actions.push("plan comment added".into()),
                    Err(e) => failures.push(format!("plan comment: {}", e.message())),
                }
            }
        }
    }

    let mut out = Map::new();
    out.insert("ready".into(), json!(ready));
    if !stop.is_empty() {
        out.insert("stopBecause".into(), json!(stop));
    }
    if let Some(i) = &issue {
        out.insert("issue".into(), issue_summary(i.raw()));
    }
    if let Some(w) = &ws {
        let mut s = workstream_summary(w.raw());
        s["criteriaList"] = criteria_view;
        out.insert("workstream".into(), s);
    }
    if !cautions.is_empty() {
        out.insert("cautions".into(), json!(cautions));
    }
    out.insert("actions".into(), json!(actions));
    if !failures.is_empty() {
        out.insert("failed".into(), json!(failures));
    }
    if !briefing.is_null() {
        out.insert("briefing".into(), briefing);
    }
    Ok(Outcome::with(Value::Object(out), !failures.is_empty()))
}

// ───────────────────────────── artifacts ─────────────────────────────

const ARTIFACT_FIELDS: &[&str] = &["kind", "title", "url", "externalId", "provider", "state", "ci", "review", "hasConflicts", "environment", "repositoryId", "description"];

struct Owners {
    workstream: Option<String>,
    issue: Option<String>,
    project: Option<String>,
}

/// Creates the artifact, or updates the one already attached with the same kind and externalId / url.
async fn upsert_artifact(ex: &Exec<'_>, owners: &Owners, fields: &Map<String, Value>) -> Result<(&'static str, Value), String> {
    let existing = if let Some(w) = &owners.workstream {
        ex.call("list_artifacts", json!({ "workstreamId": w })).await
    } else if let Some(i) = &owners.issue {
        ex.call("list_issue_artifacts", json!({ "idOrKey": i })).await
    } else if let Some(p) = &owners.project {
        ex.call("list_project_artifacts", json!({ "id": p })).await
    } else {
        return Err("an artifact needs a workstream, an issue or a project to attach to".into());
    }
    .map_err(|e| e.message())?;
    let kind = fields.get("kind").and_then(Value::as_str);
    let external = fields.get("externalId").and_then(Value::as_str);
    let url = fields.get("url").and_then(Value::as_str);
    let found = rows(&existing).into_iter().find(|x| {
        x["kind"].as_str() == kind && ((external.is_some() && x["externalId"].as_str() == external) || (url.is_some() && x["url"].as_str() == url))
    });
    if let Some(found) = found {
        let id = found["id"].as_str().unwrap_or("").to_string();
        let mut body = Map::new();
        body.insert("id".into(), json!(id));
        let allowed = ex.tool("update_artifact").map(|t| t.params.iter().map(|p| p.name.as_str()).collect::<HashSet<_>>()).unwrap_or_default();
        for (k, v) in fields {
            if allowed.contains(k.as_str()) {
                body.insert(k.clone(), v.clone());
            }
        }
        let updated = ex.call("update_artifact", Value::Object(body)).await.map_err(|e| e.message())?;
        return Ok(("updated", updated));
    }
    let mut body = Map::new();
    for (k, v) in [("workstreamId", &owners.workstream), ("issueId", &owners.issue), ("projectId", &owners.project)] {
        if let Some(v) = v {
            body.insert(k.into(), json!(v));
        }
    }
    for (k, v) in fields {
        body.insert(k.clone(), v.clone());
    }
    let created = ex.call("create_artifact", Value::Object(body)).await.map_err(|e| e.message())?;
    Ok(("created", created))
}

fn artifact_summary(v: &Value) -> Value {
    pick(v, &["id", "kind", "title", "state", "ci", "review", "hasConflicts", "url", "externalId"])
}

async fn owners_from(a: &Map<String, Value>, ex: &Exec<'_>) -> Result<Owners, String> {
    let workstream = match text(a, "workstream") {
        Some(w) => Some(resolve(ex, w, Some(Kind::Workstream), false).await?.id),
        None => None,
    };
    let issue = match text(a, "issue") {
        Some(i) => Some(resolve(ex, i, Some(Kind::Issue), false).await?.id),
        None => None,
    };
    let project = match text(a, "project") {
        Some(p) => Some(resolve(ex, p, Some(Kind::Project), false).await?.id),
        None => None,
    };
    Ok(Owners { workstream, issue, project })
}

async fn attach_artifact(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let owners = owners_from(a, ex).await?;
    if owners.workstream.is_none() && owners.issue.is_none() && owners.project.is_none() {
        return Err("pass at least one of workstream, issue, project".into());
    }
    let mut fields = Map::new();
    for k in ARTIFACT_FIELDS {
        if let Some(v) = a.get(*k) {
            fields.insert((*k).into(), v.clone());
        }
    }
    let (action, artifact) = upsert_artifact(ex, &owners, &fields).await?;
    Ok(Outcome::ok(json!({ "action": action, "artifact": artifact_summary(&artifact) })))
}

// ───────────────────────────── report_progress ─────────────────────────────

async fn report_progress(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let has = |k: &str| a.get(k).is_some();
    if !(has("criteria") || has("addCriteria") || has("artifact") || has("issueStatus") || has("projectUpdate") || has("comment")) {
        return Err("nothing to report: pass criteria, addCriteria, artifact, issueStatus, projectUpdate and/or comment".into());
    }
    if (has("criteria") || has("addCriteria")) && text(a, "workstream").is_none() {
        return Err("criteria and addCriteria need `workstream`".into());
    }
    if has("issueStatus") && text(a, "issue").is_none() {
        return Err("issueStatus needs `issue`".into());
    }
    if has("projectUpdate") && text(a, "project").is_none() {
        return Err("projectUpdate needs `project`".into());
    }
    if (has("artifact") || has("comment")) && text(a, "workstream").is_none() && text(a, "issue").is_none() && text(a, "project").is_none() {
        return Err("artifact and comment need a workstream, an issue or a project".into());
    }

    let ws = match text(a, "workstream") {
        Some(w) => Some(resolve(ex, w, Some(Kind::Workstream), true).await?),
        None => None,
    };
    let issue = match text(a, "issue") {
        Some(i) => Some(resolve(ex, i, Some(Kind::Issue), false).await?),
        None => None,
    };
    let project = match text(a, "project") {
        Some(p) => Some(resolve(ex, p, Some(Kind::Project), false).await?),
        None => None,
    };

    let mut applied: Vec<String> = vec![];
    let mut warnings: Vec<String> = vec![];
    let mut failed: Vec<String> = vec![];

    if let Some(w) = &ws {
        for t in strings(a, "addCriteria") {
            match ex.call("add_criterion", json!({ "idOrKey": w.id, "text": t })).await {
                Ok(_) => applied.push(format!("criterion added: {t}")),
                Err(e) => failed.push(format!("add criterion \"{t}\": {}", e.message())),
            }
        }
        if let Some(items) = a.get("criteria").and_then(Value::as_array) {
            let list = criteria_of(w.raw());
            for item in items {
                let (sel, state) = (item["criterion"].as_str().unwrap_or(""), item["state"].as_str().unwrap_or(""));
                match match_criterion(&list, sel) {
                    Ok(i) => match ex.call("update_criterion", criterion_args(&w.id, &list[i]["id"], state, item.get("evidence"))).await {
                        Ok(_) => {
                            applied.push(format!("criterion {} is {state}", i + 1));
                            if state == "met" && !has_evidence(item.get("evidence")) {
                                warnings.push(format!("criterion {} was set met without evidence; attach a test report, deployment or PR via `evidence` (artifactIds and/or note)", i + 1));
                            }
                        }
                        Err(e) => failed.push(format!("criterion {}: {}", i + 1, e.message())),
                    },
                    Err(e) => failed.push(e),
                }
            }
        }
    }

    let mut artifact_out = Value::Null;
    if let Some(Value::Object(art)) = a.get("artifact") {
        let owners = Owners { workstream: ws.as_ref().map(|w| w.id.clone()), issue: issue.as_ref().map(|i| i.id.clone()), project: project.as_ref().map(|p| p.id.clone()) };
        match upsert_artifact(ex, &owners, art).await {
            Ok((action, artifact)) => {
                applied.push(format!("artifact {action}"));
                artifact_out = artifact_summary(&artifact);
            }
            Err(e) => failed.push(format!("artifact: {e}")),
        }
    }

    if let (Some(status), Some(i)) = (text(a, "issueStatus"), &issue) {
        match ex.call("update_issue", json!({ "idOrKey": i.id, "status": status })).await {
            Ok(_) => applied.push(format!("issue status {status}")),
            Err(e) => failed.push(format!("issue status: {}", e.message())),
        }
    }

    if let (Some(Value::Object(pu)), Some(p)) = (a.get("projectUpdate"), &project) {
        match ex.call("create_project_update", json!({ "projectId": p.id, "health": pu["health"], "body": pu["body"] })).await {
            Ok(_) => applied.push("project update posted".into()),
            Err(e) => failed.push(format!("project update: {}", e.message())),
        }
    }

    if let Some(body) = text(a, "comment") {
        let subject = ws.as_ref().or(issue.as_ref()).or(project.as_ref()).map(Entity::subject);
        if let Some(subject) = subject {
            match ex.call("create_comment", json!({ "subject": subject, "body": body })).await {
                Ok(_) => applied.push("comment added".into()),
                Err(e) => failed.push(format!("comment: {}", e.message())),
            }
        }
    }

    let mut out = Map::new();
    out.insert("applied".into(), json!(applied));
    if !warnings.is_empty() {
        out.insert("warnings".into(), json!(warnings));
    }
    if !failed.is_empty() {
        out.insert("failed".into(), json!(failed));
        out.insert("note".into(), json!("Do not repeat the applied steps; fix and resend only the failed ones."));
    }
    if !artifact_out.is_null() {
        out.insert("artifact".into(), artifact_out);
    }
    // The resulting state, so the agent sees what its facts did to the derived status.
    if let Some(w) = &ws
        && !applied.is_empty()
        && let Ok(fresh) = ex.call("get_workstream", json!({ "idOrKey": w.id })).await
    {
        let mut s = workstream_summary(&fresh);
        s["criteriaList"] = numbered_criteria(&fresh);
        out.insert("workstream".into(), s);
    }
    Ok(Outcome::with(Value::Object(out), !failed.is_empty()))
}

// ───────────────────────────── ask_human ─────────────────────────────

async fn ask_human(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let question = text(a, "question").ok_or("question is required")?;
    let ws = resolve(ex, text(a, "workstream").ok_or("workstream is required")?, Some(Kind::Workstream), false).await?;
    let open = ex.call("list_input_requests", json!({ "workstreamId": ws.id, "state": "open" })).await.map_err(|e| e.message())?;
    let open = rows(&open);
    if let Some(same) = open.iter().find(|r| norm(r["question"].as_str().unwrap_or("")) == norm(question)) {
        return Ok(Outcome::ok(json!({
            "created": false,
            "reason": "this question is already open on the workstream; ask once",
            "inputRequest": pick(same, &["id", "question", "options", "state", "assigneeUserId"]),
        })));
    }
    let mut body = Map::new();
    body.insert("workstreamId".into(), json!(ws.id));
    body.insert("question".into(), json!(question));
    if let Some(o) = a.get("options") {
        body.insert("options".into(), o.clone());
    }
    if let Some(u) = text(a, "assignee") {
        body.insert("assigneeUserId".into(), json!(u));
    }
    let created = ex.call("create_input_request", Value::Object(body)).await.map_err(|e| e.message())?;
    let id = created["id"].as_str().unwrap_or("").to_string();
    Ok(Outcome::ok(json!({
        "created": true,
        "inputRequest": pick(&created, &["id", "question", "options", "state", "assigneeUserId"]),
        "alsoOpenOnWorkstream": open.len(),
        "next": format!("The workstream now shows needs_input. Keep working on anything the answer does not affect; read the answer later with get_context {{\"id\":\"{id}\"}}. Do not answer it yourself."),
    })))
}

// ───────────────────────────── record_decision ─────────────────────────────

async fn record_decision(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    if let Some(existing) = text(a, "decision") {
        let mut body = Map::new();
        body.insert("idOrKey".into(), json!(existing));
        for k in ["title", "statement", "rationale", "tags"] {
            if let Some(v) = a.get(k) {
                body.insert(k.into(), v.clone());
            }
        }
        if body.len() == 1 {
            return Err("pass at least one of title, statement, rationale, tags to change".into());
        }
        let updated = ex.call("update_decision", Value::Object(body)).await.map_err(|e| e.message())?;
        return Ok(Outcome::ok(json!({ "created": false, "updated": true, "decision": pick(&updated, &["key", "id", "title", "status"]) })));
    }
    let title = text(a, "title").ok_or("title is required to record a decision")?;
    let statement = text(a, "statement").ok_or("statement is required to record a decision")?;
    // Same title already on record (and not rejected): point at it instead of duplicating.
    if let Ok(found) = ex.call("list_decisions", json!({ "q": title })).await
        && let Some(same) = rows(&found).into_iter().find(|d| norm(d["title"].as_str().unwrap_or("")) == norm(title) && d["status"] != "rejected")
    {
        return Ok(Outcome::ok(json!({
            "created": false,
            "reason": "a decision with this title already exists",
            "decision": pick(&same, &["key", "id", "title", "status"]),
            "hint": "Edit it with decision:'<key>' if you proposed it, or propose a new one with a different title.",
        })));
    }
    let mut body = Map::new();
    body.insert("title".into(), json!(title));
    body.insert("statement".into(), json!(statement));
    for k in ["rationale", "tags"] {
        if let Some(v) = a.get(k) {
            body.insert(k.into(), v.clone());
        }
    }
    body.insert("status".into(), json!(text(a, "status").unwrap_or("proposed")));
    if let Some(w) = text(a, "workstream") {
        body.insert("originWorkstreamId".into(), json!(resolve_workstream_id(ex, w).await?));
    }
    let related = strings(a, "related");
    if !related.is_empty() {
        body.insert("relatedWorkstreamIds".into(), json!(resolve_workstream_ids(ex, &related).await?));
    }
    let created = ex.call("create_decision", Value::Object(body)).await.map_err(|e| e.message())?;
    Ok(Outcome::ok(json!({
        "created": true,
        "decision": pick(&created, &["key", "id", "title", "status"]),
        "next": "A person must accept, reject or supersede it; until then its workstream shows needs_input. Tell the user the key.",
    })))
}

// ───────────────────────────── add_comment ─────────────────────────────

async fn add_comment(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let on = text(a, "on").ok_or("on is required")?;
    let body = text(a, "body").ok_or("body is required")?;
    let hint = text(a, "type").and_then(Kind::parse);
    let target = resolve(ex, on, hint, false).await?;
    let created = ex.call("create_comment", json!({ "subject": target.subject(), "body": body })).await.map_err(|e| e.message())?;
    Ok(Outcome::ok(json!({ "commented": true, "on": target.subject(), "comment": pick(&created, &["id", "createdAt"]) })))
}

// ───────────────────────────── triage_issues ─────────────────────────────

async fn triage_issues(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let items = a.get("items").and_then(Value::as_array).ok_or("items is required")?;
    if items.is_empty() || items.len() > 25 {
        return Err("items must hold 1 to 25 issues".into());
    }
    let mut results = vec![];
    let mut any_failed = false;
    for item in items {
        let Some(item) = item.as_object() else { continue };
        let reference = text(item, "issue").unwrap_or("");
        let mut applied: Vec<String> = vec![];
        let mut error: Option<String> = None;
        let issue = match resolve(ex, reference, Some(Kind::Issue), true).await {
            Ok(i) => i,
            Err(e) => {
                any_failed = true;
                results.push(json!({ "issue": reference, "ok": false, "error": e }));
                continue;
            }
        };
        let mut patch = Map::new();
        patch.insert("idOrKey".into(), json!(issue.id));
        for k in ["priority", "kind", "status", "labels", "assigneeId", "teamId", "projectId", "estimate", "title"] {
            if let Some(v) = item.get(k) {
                patch.insert(k.into(), v.clone());
            }
        }
        if let Some(original) = text(item, "duplicateOf") {
            patch.insert("duplicateOfId".into(), json!(original));
        }
        if patch.len() > 1 {
            match ex.call("update_issue", Value::Object(patch)).await {
                Ok(_) => applied.push("updated".into()),
                Err(e) => error = Some(format!("update: {}", e.message())),
            }
        }
        if error.is_none() {
            let link = if let Some(w) = text(item, "workstream") {
                match resolve_workstream_id(ex, w).await {
                    Ok(wid) => Some(json!({ "idOrKey": issue.id, "workstreamIds": [wid] })),
                    Err(e) => {
                        error = Some(format!("link: {e}"));
                        None
                    }
                }
            } else {
                item.get("createWorkstream").map(|cw| json!({ "idOrKey": issue.id, "createWorkstream": cw }))
            };
            if let Some(args) = link {
                match ex.call("link_issue", args).await {
                    Ok(_) => applied.push("linked to a workstream".into()),
                    Err(e) => error = Some(format!("link: {}", e.message())),
                }
            }
        }
        if error.is_none()
            && let Some(c) = text(item, "comment")
        {
            match ex.call("create_comment", json!({ "subject": issue.subject(), "body": c })).await {
                Ok(_) => applied.push("commented".into()),
                Err(e) => error = Some(format!("comment: {}", e.message())),
            }
        }
        let key = issue.raw()["key"].as_str().unwrap_or(reference).to_string();
        match error {
            None => results.push(json!({ "issue": key, "ok": true, "applied": applied })),
            Some(e) => {
                any_failed = true;
                results.push(json!({ "issue": key, "ok": false, "applied": applied, "error": e }));
            }
        }
    }
    Ok(Outcome::with(json!({ "results": results }), any_failed))
}

#[cfg(test)]
#[path = "composite_tests.rs"]
mod tests;
