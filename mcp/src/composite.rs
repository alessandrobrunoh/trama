//! Composite (task-level) tools of the curated profile. Each one orchestrates several catalog
//! calls (`tools.json`) so an agent expresses an intent ("report progress", "file a task") in one
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
    "create_task",
    "start_work",
    "report_progress",
    "attach_artifact",
    "add_comment",
    "triage_tasks",
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
    pick(
        v,
        &[
            "key",
            "id",
            "title",
            "kind",
            "status",
            "priority",
            "assigneeId",
            "projectId",
            "parentId",
            "duplicateOfId",
        ],
    )
}

// ───────────────────────────── resolving keys and ids ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Issue,
    Project,
    Artifact,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "issue" | "task" => Kind::Issue,
            "project" => Kind::Project,
            "artifact" => Kind::Artifact,
            _ => return None,
        })
    }
    fn subject(self) -> &'static str {
        match self {
            Kind::Issue => "issue",
            Kind::Project => "project",
            Kind::Artifact => "artifact",
        }
    }
    /// What a person calls it (a task's wire type is `issue`).
    fn label(self) -> &'static str {
        match self {
            Kind::Issue => "task",
            Kind::Project => "project",
            Kind::Artifact => "artifact",
        }
    }
    /// The catalog tool that reads one, and the name of its path argument.
    fn getter(self) -> (&'static str, &'static str) {
        match self {
            Kind::Issue => ("get_task", "idOrKey"),
            Kind::Project => ("get_project", "id"),
            Kind::Artifact => ("get_artifact", "id"),
        }
    }
}

fn kind_by_id_prefix(r: &str) -> Option<Kind> {
    match r.split_once('_')?.0 {
        "in" | "iss" => Some(Kind::Issue),
        "pj" | "prj" => Some(Kind::Project),
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
        && prefix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric())
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
    {
        return vec![Kind::Issue];
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
        return Err(format!("'{r}' is not an id or a key (expected e.g. AUTH-42, CORA-142, iss_…, in_…)"));
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
            Err(e) if e.not_found() => missing = format!("no {} '{r}' (or it is not visible to this key)", kind.label()),
            Err(e) => return Err(e.message()),
        }
    }
    Err(missing)
}

// ───────────────────────────── dispatch ─────────────────────────────

/// Runs the composite `name`. `None` = not a composite handled here.
pub async fn run(name: &str, args: &Value, ex: &Exec<'_>) -> Option<Res> {
    let empty = Map::new();
    let a = args.as_object().unwrap_or(&empty);
    Some(match name {
        "get_context" => get_context(a, ex).await,
        "find_work" => find_work(a, ex).await,
        "create_task" => create_task(a, ex).await,
        "start_work" => start_work(a, ex).await,
        "report_progress" => report_progress(a, ex).await,
        "attach_artifact" => attach_artifact(a, ex).await,
        "add_comment" => add_comment(a, ex).await,
        "triage_tasks" => triage_tasks(a, ex).await,
        _ => return None,
    })
}

// ───────────────────────────── get_context ─────────────────────────────

async fn get_context(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let id = text(a, "id").ok_or("id is required")?;
    let hint = text(a, "type").and_then(Kind::parse);
    let cands = candidates(id, hint);
    if cands.is_empty() {
        return Err(format!("'{id}' is not an id or a key (expected e.g. AUTH-42, CORA-142, iss_…, in_…, ar_…)"));
    }
    let mut missing = String::new();
    for kind in cands {
        match context_of(kind, id, flag(a, "comments").unwrap_or(false), ex).await {
            Ok(out) => return Ok(out),
            Err(e) if e.not_found() => missing = format!("no {} '{id}' (or it is not visible to this key)", kind.label()),
            Err(e) => return Err(e.message()),
        }
    }
    Err(missing)
}

async fn context_of(kind: Kind, id: &str, comments: bool, ex: &Exec<'_>) -> Result<Outcome, StepError> {
    match kind {
        Kind::Project => Err(StepError::Invalid("get_context reads tasks and artifacts; read a project with run_tool get_project".into())),
        Kind::Issue => {
            let issue = ex.call("get_task_context", json!({ "idOrKey": id })).await?;
            let mut warnings: Vec<String> = vec![];
            let artifacts = match ex.call("list_task_artifacts", json!({ "idOrKey": id })).await {
                Ok(v) => rows(&v).iter().map(|x| pick(x, &["id", "kind", "title", "state", "ci", "review", "url", "externalId"])).collect::<Vec<_>>(),
                Err(e) => {
                    warnings.push(format!("artifacts: {}", e.message()));
                    vec![]
                }
            };
            let mut out = json!({ "type": "issue", "issue": issue, "artifacts": artifacts });
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
        Kind::Artifact => {
            let (tool, arg) = kind.getter();
            let v = ex.call(tool, json!({ arg: id })).await?;
            Ok(Outcome::ok(json!({ "type": kind.subject(), "record": v })))
        }
    }
}

// ───────────────────────────── find_work ─────────────────────────────

async fn find_work(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 100) as usize;
    let open = flag(a, "open").unwrap_or(true);
    let status = text(a, "status");
    let assignee = match text(a, "assignee") {
        Some("me") => Some(ex.me()?),
        Some(other) => Some(other.to_string()),
        None => None,
    };
    let mut out = Map::new();
    let mut hint = vec![];
    let mut failed = false;

    // A status unsupported by the task endpoint should not produce a misleading empty result.
    let fits = status.is_none_or(|s| ex.accepts("list_tasks", "status", s));
    if fits {
        let mut q = Map::new();
        for (k, v) in [("q", text(a, "q")), ("priority", text(a, "priority")), ("kind", text(a, "kind")), ("projectId", text(a, "projectId")), ("status", status)] {
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
        match ex.call("list_tasks", Value::Object(q)).await {
            Ok(v) => {
                let list = rows(&v);
                out.insert("tasks".into(), Value::Array(list.iter().take(limit).map(issue_summary).collect()));
                if list.len() >= limit {
                    hint.push(format!("tasks capped at {limit}: narrow with q, status or projectId"));
                }
            }
            Err(e) => {
                failed = true;
                out.insert("tasksError".into(), json!(e.message()));
            }
        }
    }
    if !hint.is_empty() {
        out.insert("hint".into(), json!(hint));
    }
    Ok(Outcome::with(Value::Object(out), failed))
}

// ───────────────────────────── create_task ─────────────────────────────

async fn create_task(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let title = text(a, "title").ok_or("title is required")?;
    let force = flag(a, "force").unwrap_or(false);
    let mut similar: Vec<Value> = vec![];

    // Search first: an open task with the very same title is a duplicate, not a new task.
    // The search type token stays `issue`.
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
                    "reason": "an open task with this title already exists",
                    "existing": pick(&r, &["key", "id", "title", "subtitle"]),
                    "hint": "Update or comment on it (update_task, add_comment), or pass force:true to create anyway.",
                })));
            }
            if open {
                similar.push(pick(&r, &["key", "id", "title", "subtitle"]));
            }
        }
    }

    let mut body = Map::new();
    for k in [
        "title",
        "body",
        "reporterName",
        "assigneeId",
        "projectId",
        "parentId",
        "priority",
        "status",
        "externalUrl",
        "estimate",
        "kind",
        "source",
        "labels",
    ] {
        if let Some(v) = a.get(k) {
            body.insert(k.into(), v.clone());
        }
    }
    body.entry("source").or_insert(json!("agent"));
    let created = ex.call("create_task", Value::Object(body)).await.map_err(|e| e.message())?;
    let mut out = json!({ "created": true, "task": issue_summary(&created) });

    if !similar.is_empty() {
        similar.truncate(5);
        out["similarOpenTasks"] = json!(similar);
    }
    Ok(Outcome::ok(out))
}

// ───────────────────────────── start_work ─────────────────────────────

async fn start_work(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let key = text(a, "key").ok_or("key is required")?;
    let issue = resolve(ex, key, Some(Kind::Issue), true).await?;
    let status = issue.raw()["status"].as_str().unwrap_or("");
    let ready = !matches!(status, "done" | "canceled");
    let mut actions = Vec::new();
    if ready && status != "in_progress" {
        ex.call("update_task", json!({ "idOrKey": issue.id, "status": "in_progress" })).await.map_err(|e| e.message())?;
        actions.push("task set to in_progress");
    }
    if ready && let Some(plan) = text(a, "plan") {
        ex.call("create_comment", json!({ "subject": issue.subject(), "body": plan })).await.map_err(|e| e.message())?;
        actions.push("plan comment added");
    }
    Ok(Outcome::ok(json!({
        "ready": ready,
        "stopBecause": if ready { Value::Null } else { json!([format!("the task is already {status}")]) },
        "task": issue_summary(issue.raw()),
        "actions": actions,
        "briefing": ex.call("get_task_context", json!({ "idOrKey": issue.id })).await.unwrap_or(Value::Null),
    })))
}

// ───────────────────────────── artifacts ─────────────────────────────

const ARTIFACT_FIELDS: &[&str] = &["kind", "title", "url", "externalId", "provider", "state", "ci", "review", "hasConflicts", "environment", "repository", "description"];

/// Creates the artifact, or updates the one already attached to the task `issue` with the same
/// kind and externalId / url.
async fn upsert_artifact(ex: &Exec<'_>, issue: &str, fields: &Map<String, Value>) -> Result<(&'static str, Value), String> {
    if issue.is_empty() {
        return Err("an artifact needs a task to attach to".into());
    }
    let existing = ex.call("list_task_artifacts", json!({ "idOrKey": issue })).await.map_err(|e| e.message())?;
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
    body.insert("issueId".into(), json!(issue));
    for (k, v) in fields {
        body.insert(k.clone(), v.clone());
    }
    let created = ex.call("create_artifact", Value::Object(body)).await.map_err(|e| e.message())?;
    Ok(("created", created))
}

fn artifact_summary(v: &Value) -> Value {
    pick(v, &["id", "kind", "title", "state", "ci", "review", "hasConflicts", "url", "externalId"])
}

async fn attach_artifact(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let issue = match text(a, "issue") {
        Some(i) => resolve(ex, i, Some(Kind::Issue), false).await?.id,
        None => return Err("pass issue (the task)".into()),
    };
    let mut fields = Map::new();
    for k in ARTIFACT_FIELDS {
        if let Some(v) = a.get(*k) {
            fields.insert((*k).into(), v.clone());
        }
    }
    let (action, artifact) = upsert_artifact(ex, &issue, &fields).await?;
    Ok(Outcome::ok(json!({ "action": action, "artifact": artifact_summary(&artifact) })))
}

// ───────────────────────────── report_progress ─────────────────────────────

async fn report_progress(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let has = |k: &str| a.get(k).is_some();
    if !(has("artifact") || has("issueStatus") || has("comment")) {
        return Err("nothing to report: pass artifact, issueStatus and/or comment".into());
    }
    if (has("artifact") || has("issueStatus") || has("comment")) && text(a, "issue").is_none() {
        return Err("artifact, issueStatus and comment need a task (`issue`)".into());
    }

    let issue = match text(a, "issue") {
        Some(i) => Some(resolve(ex, i, Some(Kind::Issue), false).await?),
        None => None,
    };

    let mut applied: Vec<String> = vec![];
    let mut failed: Vec<String> = vec![];

    let mut artifact_out = Value::Null;
    if let Some(Value::Object(art)) = a.get("artifact") {
        let owner = issue.as_ref().map(|i| i.id.clone()).unwrap_or_default();
        match upsert_artifact(ex, &owner, art).await {
            Ok((action, artifact)) => {
                applied.push(format!("artifact {action}"));
                artifact_out = artifact_summary(&artifact);
            }
            Err(e) => failed.push(format!("artifact: {e}")),
        }
    }

    if let (Some(status), Some(i)) = (text(a, "issueStatus"), &issue) {
        match ex.call("update_task", json!({ "idOrKey": i.id, "status": status })).await {
            Ok(_) => applied.push(format!("task status {status}")),
            Err(e) => failed.push(format!("task status: {}", e.message())),
        }
    }

    if let (Some(body), Some(i)) = (text(a, "comment"), &issue) {
        match ex.call("create_comment", json!({ "subject": i.subject(), "body": body })).await {
            Ok(_) => applied.push("comment added".into()),
            Err(e) => failed.push(format!("comment: {}", e.message())),
        }
    }

    let mut out = Map::new();
    out.insert("applied".into(), json!(applied));
    if !failed.is_empty() {
        out.insert("failed".into(), json!(failed));
        out.insert("note".into(), json!("Do not repeat the applied steps; fix and resend only the failed ones."));
    }
    if !artifact_out.is_null() {
        out.insert("artifact".into(), artifact_out);
    }
    Ok(Outcome::with(Value::Object(out), !failed.is_empty()))
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

// ───────────────────────────── triage_tasks ─────────────────────────────

async fn triage_tasks(a: &Map<String, Value>, ex: &Exec<'_>) -> Res {
    let items = a.get("items").and_then(Value::as_array).ok_or("items is required")?;
    if items.is_empty() || items.len() > 25 {
        return Err("items must hold 1 to 25 tasks".into());
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
        for k in ["priority", "kind", "status", "labels", "assigneeId", "projectId", "estimate", "title"] {
            if let Some(v) = item.get(k) {
                patch.insert(k.into(), v.clone());
            }
        }
        if let Some(original) = text(item, "duplicateOf") {
            patch.insert("duplicateOfId".into(), json!(original));
        }
        if patch.len() > 1 {
            match ex.call("update_task", Value::Object(patch)).await {
                Ok(_) => applied.push("updated".into()),
                Err(e) => error = Some(format!("update: {}", e.message())),
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
