//! Helpers for the parts of a task that the REST catalog (`tools.json`) cannot express on its own:
//! the subtask tree, a person's timer and the repository match of a project.
//!
//! Shared by the MCP composites (`composite.rs`) and the `trama` CLI, so both build the same requests
//! and apply the same validation as the API (limits copied from the server DTOs). Nothing here talks to
//! the network.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::catalog::{Call, Method, encode_segment};

// ───────────────────────────── subtasks ─────────────────────────────

/// What the API returns at most from `GET /tasks` (`limit` is capped at 500).
pub const LIST_TASKS_MAX: usize = 500;

/// Guards against a malformed parent chain; a real tree is never this deep.
const MAX_TREE_DEPTH: usize = 100;

const NODE_FIELDS: &[&str] = &["key", "id", "title", "kind", "status", "priority", "assigneeId", "estimate", "threadUrl"];

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

/// The fields of a task that a tree shows.
pub fn summary(row: &Value) -> Value {
    pick(row, NODE_FIELDS)
}

/// The tasks whose parent is `parent_id`, in the order of `rows` (the API lists newest first).
pub fn children_of(rows: &[Value], parent_id: &str) -> Vec<Value> {
    rows.iter().filter(|r| r["parentId"].as_str() == Some(parent_id)).cloned().collect()
}

/// Everything below `root_id` as nested nodes (`subtasks` holds a node's children), to any depth, or to
/// `max_depth` levels when given (1 = direct children only).
pub fn subtree(rows: &[Value], root_id: &str, max_depth: Option<usize>) -> Vec<Value> {
    let mut by_parent: HashMap<&str, Vec<&Value>> = HashMap::new();
    for row in rows {
        if let Some(parent) = row["parentId"].as_str() {
            by_parent.entry(parent).or_default().push(row);
        }
    }
    for kids in by_parent.values_mut() {
        kids.sort_by(|a, b| (a["createdAt"].as_str(), a["key"].as_str()).cmp(&(b["createdAt"].as_str(), b["key"].as_str())));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    seen.insert(root_id);
    build(&by_parent, root_id, 1, max_depth.unwrap_or(MAX_TREE_DEPTH).min(MAX_TREE_DEPTH), &mut seen)
}

fn build<'a>(by_parent: &HashMap<&'a str, Vec<&'a Value>>, parent: &str, depth: usize, max: usize, seen: &mut HashSet<&'a str>) -> Vec<Value> {
    if depth > max {
        return vec![];
    }
    let Some(kids) = by_parent.get(parent) else { return vec![] };
    let mut out = Vec::with_capacity(kids.len());
    for kid in kids {
        let Some(id) = kid["id"].as_str() else { continue };
        if !seen.insert(id) {
            continue; // a cycle: never expand a task twice
        }
        let mut node = pick(kid, NODE_FIELDS);
        let below = build(by_parent, id, depth + 1, max, seen);
        if !below.is_empty() {
            node["subtasks"] = Value::Array(below);
        }
        out.push(node);
    }
    out
}

/// How many tasks a nested list holds.
pub fn count_nodes(nodes: &[Value]) -> usize {
    nodes.iter().map(|n| 1 + n["subtasks"].as_array().map_or(0, |k| count_nodes(k))).sum()
}

/// A story-point estimate without a trailing `.0`.
fn points(v: &Value) -> Option<String> {
    let n = v.as_f64()?;
    Some(if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") })
}

fn line(node: &Value, depth: usize) -> String {
    let mut s = format!("{}{}  {}  {}", "  ".repeat(depth), node["key"].as_str().unwrap_or("?"), node["status"].as_str().unwrap_or("-"), node["title"].as_str().unwrap_or(""));
    if let Some(p) = points(&node["estimate"]) {
        s.push_str(&format!("  ({p} pt)"));
    }
    s
}

fn walk(nodes: &[Value], depth: usize, out: &mut Vec<String>) {
    for node in nodes {
        out.push(line(node, depth));
        if let Some(kids) = node["subtasks"].as_array() {
            walk(kids, depth + 1, out);
        }
    }
}

/// The tree as text, two spaces per level: `KEY  status  title  (3 pt)`. `root` is the task itself.
pub fn render_tree(root: &Value, nodes: &[Value]) -> String {
    let mut lines = vec![line(root, 0)];
    walk(nodes, 1, &mut lines);
    lines.join("\n")
}

/// Only the subtasks as text, one level in, two more spaces per generation: `KEY  status  title  (3 pt)`.
pub fn render_subtasks(nodes: &[Value]) -> String {
    let mut lines = vec![];
    walk(nodes, 1, &mut lines);
    lines.join("\n")
}

// ───────────────────────────── project repository ─────────────────────────────

/// `https://user@github.com/Owner/Name.git`, `git@github.com:Owner/Name` and `github.com/owner/name/`
/// all become `github.com/owner/name`. A bare `owner/name` stays as it is, lowercased.
pub fn normalize_repository(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    let had_scheme = s.contains("://");
    if let Some((_, rest)) = s.split_once("://") {
        s = rest.to_string();
    }
    if let Some((creds, rest)) = s.split_once('@')
        && !creds.contains('/')
    {
        s = rest.to_string();
    }
    // scp-like `host:owner/name`
    if !had_scheme
        && let Some((host, path)) = s.split_once(':')
        && !host.contains('/')
    {
        s = format!("{host}/{path}");
    }
    let s = s.trim_end_matches('/');
    s.strip_suffix(".git").unwrap_or(s).trim_end_matches('/').to_string()
}

/// Whether a project's repository string names `wanted` (case-insensitive; `owner/name` matches the
/// same repository written with its host or as a URL).
pub fn repository_matches(project: &str, wanted: &str) -> bool {
    let (a, b) = (normalize_repository(project), normalize_repository(wanted));
    !a.is_empty() && !b.is_empty() && (a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}")))
}

/// The projects of `rows` whose `repository` matches `wanted`.
pub fn filter_by_repository(rows: Vec<Value>, wanted: &str) -> Vec<Value> {
    rows.into_iter().filter(|p| p["repository"].as_str().is_some_and(|r| repository_matches(r, wanted))).collect()
}

// ───────────────────────────── the timer ─────────────────────────────

/// The server refuses longer descriptions.
pub const TIME_DESCRIPTION_MAX: usize = 500;
const ID_MAX: usize = 100;

fn call(method: Method, path: impl Into<String>, body: Option<Value>) -> Call {
    Call { method, path: path.into(), query: vec![], body }
}

/// Days since 1970-01-01 of a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// An ISO-8601 / RFC 3339 instant with an explicit zone (`2026-05-01T09:30:00Z`, `…+02:00`) as epoch
/// milliseconds. A missing zone is refused: the API would read it in its own time zone.
pub fn parse_instant(raw: &str) -> Result<i64, String> {
    let bad = || format!("'{raw}' is not a date and time with a zone, e.g. 2026-05-01T09:30:00Z or 2026-05-01T11:30:00+02:00");
    let s = raw.trim();
    let b = s.as_bytes();
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) { None } else { part.parse().ok() }
    };
    if b.len() < 17 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' {
        return Err(bad());
    }
    let (y, mo, d) = (num(0, 4).ok_or_else(bad)?, num(5, 7).ok_or_else(bad)?, num(8, 10).ok_or_else(bad)?);
    let (h, mi) = (num(11, 13).ok_or_else(bad)?, num(14, 16).ok_or_else(bad)?);
    let mut i = 16;
    let mut sec = 0;
    let mut ms = 0;
    if b.get(i) == Some(&b':') {
        sec = num(i + 1, i + 3).ok_or_else(bad)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while b.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return Err(bad());
            }
            let digits = &s[start..end.min(start + 3)];
            ms = format!("{digits:0<3}").parse::<i64>().map_err(|_| bad())?;
            i = end;
        }
    }
    let offset_min = match s.get(i..).ok_or_else(bad)? {
        "Z" | "z" => 0,
        zone if zone.len() >= 3 && (zone.starts_with('+') || zone.starts_with('-')) => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let digits: String = zone[1..].chars().filter(|c| *c != ':').collect();
            if !digits.bytes().all(|c| c.is_ascii_digit()) || !(digits.len() == 2 || digits.len() == 4) {
                return Err(bad());
            }
            let oh: i64 = digits[..2].parse().map_err(|_| bad())?;
            let om: i64 = if digits.len() == 4 { digits[2..].parse().map_err(|_| bad())? } else { 0 };
            if oh > 23 || om > 59 {
                return Err(bad());
            }
            sign * (oh * 60 + om)
        }
        _ => return Err(bad()),
    };
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || sec > 59 {
        return Err(bad());
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Ok(secs * 1000 + ms)
}

fn checked_id(what: &str, v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.is_empty() || v.len() > ID_MAX {
        return Err(format!("{what} must be 1 to {ID_MAX} characters"));
    }
    Ok(v.to_string())
}

fn target_body(issue_id: Option<&str>, project_id: Option<&str>, description: Option<&str>) -> Result<Map<String, Value>, String> {
    let mut body = Map::new();
    if let Some(id) = issue_id {
        body.insert("issueId".into(), json!(checked_id("the task id", id)?));
    }
    if let Some(id) = project_id {
        body.insert("projectId".into(), json!(checked_id("the project id", id)?));
    }
    if let Some(text) = description.map(str::trim).filter(|t| !t.is_empty()) {
        if text.chars().count() > TIME_DESCRIPTION_MAX {
            return Err(format!("the description is at most {TIME_DESCRIPTION_MAX} characters"));
        }
        body.insert("description".into(), json!(text));
    }
    Ok(body)
}

/// `GET /time-entries`: the signed-in person's 100 latest entries.
pub fn timer_list_call() -> Call {
    call(Method::Get, "/time-entries", None)
}

/// `POST /time-entries/start`. The API stops a timer that is already running. `issue_id` must be the
/// task's id (`in_…`), not its key.
pub fn timer_start_call(issue_id: Option<&str>, project_id: Option<&str>, description: Option<&str>) -> Result<Call, String> {
    Ok(call(Method::Post, "/time-entries/start", Some(Value::Object(target_body(issue_id, project_id, description)?))))
}

/// `POST /time-entries/stop`.
pub fn timer_stop_call() -> Call {
    call(Method::Post, "/time-entries/stop", None)
}

/// `POST /time-entries`: a finished entry. Both instants need a zone and the end must follow the start.
pub fn timer_add_call(issue_id: Option<&str>, project_id: Option<&str>, description: Option<&str>, started_at: &str, ended_at: &str) -> Result<Call, String> {
    let (start, end) = (parse_instant(started_at)?, parse_instant(ended_at)?);
    if end <= start {
        return Err("The end must be after the start".into());
    }
    let mut body = target_body(issue_id, project_id, description)?;
    body.insert("startedAt".into(), json!(started_at.trim()));
    body.insert("endedAt".into(), json!(ended_at.trim()));
    Ok(call(Method::Post, "/time-entries", Some(Value::Object(body))))
}

/// `DELETE /time-entries/{id}`: only the caller's own entries exist for the API.
pub fn timer_delete_call(id: &str) -> Result<Call, String> {
    Ok(call(Method::Delete, format!("/time-entries/{}", encode_segment(&checked_id("the time entry id", id)?)), None))
}

/// The current time as epoch milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `1h 05m`, `12m 30s` or `45s`.
pub fn format_duration(secs: i64) -> String {
    let secs = secs.max(0);
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    match (h, m) {
        (0, 0) => format!("{s}s"),
        (0, _) => format!("{m}m {s:02}s"),
        _ => format!("{h}h {m:02}m"),
    }
}

/// An entry with `durationSeconds` and `duration` when it is finished, or `running: true` with
/// `elapsedSeconds` and `elapsed` while its timer runs (`now_ms` = the current time).
pub fn annotate_entry(entry: &Value, now_ms: i64) -> Value {
    let mut out = entry.clone();
    let Some(map) = out.as_object_mut() else { return out };
    let Some(start) = entry["startedAt"].as_str().and_then(|s| parse_instant(s).ok()) else { return out };
    match entry["endedAt"].as_str() {
        Some(end) => {
            if let Ok(end) = parse_instant(end) {
                let secs = (end - start) / 1000;
                map.insert("durationSeconds".into(), json!(secs));
                map.insert("duration".into(), json!(format_duration(secs)));
            }
        }
        None => {
            let secs = ((now_ms - start) / 1000).max(0);
            map.insert("running".into(), json!(true));
            map.insert("elapsedSeconds".into(), json!(secs));
            map.insert("elapsed".into(), json!(format_duration(secs)));
        }
    }
    out
}

/// The entry whose timer is running, if any.
pub fn running_entry(entries: &[Value]) -> Option<&Value> {
    entries.iter().find(|e| e["endedAt"].is_null() && e["startedAt"].is_string())
}

/// Seconds booked on the finished entries of an annotated list.
pub fn total_seconds(annotated: &[Value]) -> i64 {
    annotated.iter().filter_map(|e| e["durationSeconds"].as_i64()).sum()
}

/// A length of time as whole minutes: `1h15`, `1h15m`, `1h`, `45m`, `1:15`, or a bare `90` (minutes).
/// At least one minute and at most 24 hours: a finished entry covers one stretch of work.
pub fn parse_minutes(raw: &str) -> Result<i64, String> {
    let bad = || format!("'{raw}' is not a duration: use 1h15, 1h, 45m, 90 (minutes) or 1:15");
    let digits = |s: &str| -> Option<i64> { if s.is_empty() || s.len() > 6 || !s.bytes().all(|c| c.is_ascii_digit()) { None } else { s.parse().ok() } };
    let s: String = raw.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    if s.is_empty() {
        return Err(bad());
    }
    let minutes_part = |m: &str| -> Option<i64> { if m.is_empty() { Some(0) } else { digits(m).filter(|n| *n < 60) } };
    let parsed: Option<i64> = if let Some((h, m)) = s.split_once(':') {
        digits(h).zip(digits(m).filter(|n| *n < 60)).map(|(h, m)| h * 60 + m)
    } else if let Some((h, rest)) = s.split_once('h') {
        let minutes = match rest.strip_suffix('m') {
            Some(m) => digits(m).filter(|n| *n < 60),
            None => minutes_part(rest),
        };
        digits(h).zip(minutes).map(|(h, m)| h * 60 + m)
    } else if let Some(m) = s.strip_suffix('m') {
        digits(m)
    } else {
        digits(&s)
    };
    let total = parsed.ok_or_else(bad)?;
    if total < 1 {
        return Err(bad());
    }
    if total > 24 * 60 {
        return Err(format!("'{raw}' is more than 24h: log one stretch of work per entry"));
    }
    Ok(total)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Epoch milliseconds as a UTC instant the API takes: `2026-05-01T09:30:00.000Z`.
pub fn format_instant(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, tod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", tod / 3600, tod % 3600 / 60, tod % 60, ms.rem_euclid(1000))
}

/// `POST /time-entries` for `minutes` of work that ended at `end_ms` (epoch milliseconds).
pub fn timer_log_call(issue_id: Option<&str>, project_id: Option<&str>, description: Option<&str>, minutes: i64, end_ms: i64) -> Result<Call, String> {
    timer_add_call(issue_id, project_id, description, &format_instant(end_ms - minutes * 60_000), &format_instant(end_ms))
}

/// `GET /time-entries?source=suggested`: the entries `trama sync` suggested, waiting for a person.
pub fn time_suggestions_call() -> Call {
    Call { method: Method::Get, path: "/time-entries".into(), query: vec![("source".into(), "suggested".into())], body: None }
}

/// `POST /time-entries/{id}/accept`: turns a suggestion into a normal entry (only its owner may).
pub fn time_accept_call(id: &str) -> Result<Call, String> {
    Ok(call(Method::Post, format!("/time-entries/{}/accept", encode_segment(&checked_id("the time entry id", id)?)), None))
}

// ───────────────────────────── thread records (/trama) ─────────────────────────────
//
// One task links at most one thread. The agent in that thread keeps a record of it with `sync`: a summary,
// the files it touched, its decisions, the PR it opened and the active time it suggests. Limits are the
// server's (`contracts/domain.ts`, "Thread records").

/// Error code of the 409 when a task already links a different thread.
pub const THREAD_ALREADY_LINKED: &str = "thread_already_linked";
pub const THREAD_SUMMARY_MAX: usize = 4000;
pub const THREAD_FILES_MAX: usize = 500;
pub const THREAD_PATH_MAX: usize = 512;
pub const DECISION_TEXT_MAX: usize = 1000;
pub const DECISIONS_PER_SYNC_MAX: usize = 20;
pub const DECISION_PATHS_MAX: usize = 50;
pub const THREAD_SUGGESTED_MINUTES_MAX: i64 = 720;
pub const THREAD_URL_MAX: usize = 2048;
const TURNS_MAX: i64 = 1_000_000;

/// A plain `http(s)` link the API accepts for a thread or a pull request.
pub fn check_http_url(what: &str, raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    match rest {
        Some(r) if !r.is_empty() && !url.chars().any(char::is_whitespace) && url.len() <= THREAD_URL_MAX => Ok(url.to_string()),
        _ => Err(format!("{what} must be an http(s) URL of at most {THREAD_URL_MAX} characters without spaces, got '{raw}'")),
    }
}

fn without_suffix_noise(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/')
}

/// The link of a thread from what a person or an agent typed: a full URL stays as it is; a bare id
/// (`th_d93f10`) is joined to `base` (`TRAMA_THREAD_URL_BASE`), or replaces the last segment of the
/// `current` thread URL (`DELTA_THREAD_URL`), which names where this host keeps its threads.
pub fn thread_url_from(raw: &str, base: Option<&str>, current: Option<&str>) -> Result<String, String> {
    let raw = raw.trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return check_http_url("the thread URL", raw);
    }
    if raw.is_empty() || raw.contains(['/', ':', ' ', '?', '#']) {
        return Err(format!("'{raw}' is neither a thread URL nor a thread id"));
    }
    if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
        return check_http_url("the thread URL", &format!("{}/{raw}", base.trim_end_matches('/')));
    }
    if let Some(cur) = current.map(without_suffix_noise).filter(|c| !c.is_empty())
        && let Some((head, last)) = cur.rsplit_once('/')
        && head.contains("://")
    {
        let url = if last == raw { cur.to_string() } else { format!("{head}/{raw}") };
        return check_http_url("the thread URL", &url);
    }
    Err(format!("'{raw}' is a thread id, not a URL: pass the full thread URL, or set TRAMA_THREAD_URL_BASE (for example https://delta.example/threads)"))
}

/// A repository path as the record stores it: relative to the repository root, no `..`, at most 512
/// characters. A leading `./` is dropped.
pub fn repo_path(raw: &str) -> Result<String, String> {
    let mut p = raw.trim();
    while let Some(rest) = p.strip_prefix("./") {
        p = rest.trim_start();
    }
    let bytes = p.as_bytes();
    if p.is_empty() || p == "." {
        return Err(format!("'{raw}' is not a path"));
    }
    if p.starts_with('/') || p.starts_with('\\') || (bytes.len() > 1 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()) {
        return Err(format!("'{raw}' is an absolute path: use a path relative to the repository root"));
    }
    if p.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(format!("'{raw}' goes up with '..': use a path inside the repository"));
    }
    if p.chars().count() > THREAD_PATH_MAX {
        return Err(format!("a path is at most {THREAD_PATH_MAX} characters: '{raw}'"));
    }
    Ok(p.to_string())
}

/// A decision as the API wants it: `{ text, paths? }`.
pub fn decision_json(text: &str, paths: &[String]) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("a decision needs its text".into());
    }
    if text.chars().count() > DECISION_TEXT_MAX {
        return Err(format!("a decision is at most {DECISION_TEXT_MAX} characters"));
    }
    let mut seen = HashSet::new();
    let mut clean = Vec::with_capacity(paths.len());
    for p in paths {
        let p = repo_path(p)?;
        if seen.insert(p.clone()) {
            clean.push(p);
        }
    }
    if clean.len() > DECISION_PATHS_MAX {
        return Err(format!("a decision names at most {DECISION_PATHS_MAX} paths"));
    }
    let mut out = Map::new();
    out.insert("text".into(), json!(text));
    if !clean.is_empty() {
        out.insert("paths".into(), json!(clean));
    }
    Ok(Value::Object(out))
}

/// `TEXT` or `TEXT@path,path`: what follows the last `@` (when it has no space) are the paths the decision
/// covers (files, directories like `src/auth/`, or globs like `src/auth/*`). A text that must end in a
/// handle ends with a lone `@`.
pub fn parse_decision(spec: &str) -> Result<(String, Vec<String>), String> {
    let spec = spec.trim();
    let (text, tail) = match spec.rsplit_once('@') {
        Some((text, tail)) if !text.trim().is_empty() && !tail.chars().any(char::is_whitespace) => (text.trim(), tail),
        _ => (spec, ""),
    };
    let paths: Vec<String> = tail.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_string).collect();
    decision_json(text, &paths)?;
    Ok((text.to_string(), paths))
}

/// Deduplicated, validated paths (first occurrence wins), cut at the most one record keeps.
pub fn clean_files(files: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for f in files {
        let f = repo_path(f)?;
        if seen.insert(f.clone()) {
            out.push(f);
        }
    }
    out.truncate(THREAD_FILES_MAX);
    Ok(out)
}

/// What one `sync` sends. Every part is optional.
#[derive(Default, Debug, Clone)]
pub struct SyncParts {
    pub summary: Option<String>,
    /// `(text, paths)`.
    pub decisions: Vec<(String, Vec<String>)>,
    pub files: Vec<String>,
    pub pull_request_url: Option<String>,
    pub active_minutes: Option<i64>,
    pub turns: Option<i64>,
    pub thread_url: Option<String>,
}

/// The body of `POST …/thread/sync`, validated like the server does.
pub fn sync_body(parts: &SyncParts) -> Result<Value, String> {
    let mut body = Map::new();
    if let Some(summary) = parts.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if summary.chars().count() > THREAD_SUMMARY_MAX {
            return Err(format!("the summary is at most {THREAD_SUMMARY_MAX} characters"));
        }
        body.insert("summary".into(), json!(summary));
    }
    if parts.decisions.len() > DECISIONS_PER_SYNC_MAX {
        return Err(format!("one sync adds at most {DECISIONS_PER_SYNC_MAX} decisions"));
    }
    if !parts.decisions.is_empty() {
        let items = parts.decisions.iter().map(|(text, paths)| decision_json(text, paths)).collect::<Result<Vec<_>, _>>()?;
        body.insert("decisions".into(), Value::Array(items));
    }
    let files = clean_files(&parts.files)?;
    if !files.is_empty() {
        body.insert("files".into(), json!(files));
    }
    if let Some(url) = &parts.pull_request_url {
        body.insert("pullRequestUrl".into(), json!(check_http_url("the pull request URL", url)?));
    }
    if let Some(minutes) = parts.active_minutes {
        if !(1..=THREAD_SUGGESTED_MINUTES_MAX).contains(&minutes) {
            return Err(format!("the active minutes are 1 to {THREAD_SUGGESTED_MINUTES_MAX}"));
        }
        body.insert("activeMinutes".into(), json!(minutes));
    }
    if let Some(turns) = parts.turns {
        if !(0..=TURNS_MAX).contains(&turns) {
            return Err("the turns are a number of 0 or more".into());
        }
        body.insert("turns".into(), json!(turns));
    }
    if let Some(url) = &parts.thread_url {
        body.insert("threadUrl".into(), json!(check_http_url("the thread URL", url)?));
    }
    Ok(Value::Object(body))
}

/// `owner/repo#123` or a URL as the link of a pull request. The short form is read as GitHub, and only
/// when the project's repository is on GitHub (a bare `owner/name` counts); otherwise a URL is needed.
pub fn pull_request_url(spec: &str, project_repository: Option<&str>) -> Result<String, String> {
    let s = spec.trim();
    if s.starts_with("http://") || s.starts_with("https://") {
        return check_http_url("the pull request URL", s);
    }
    let bad = || format!("'{spec}' is neither a URL nor owner/repo#123");
    let (repo, number) = s.rsplit_once('#').ok_or_else(bad)?;
    let (owner, name) = repo.split_once('/').ok_or_else(bad)?;
    let ident = |p: &str| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'));
    if !ident(owner) || !ident(name) || number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) || number.trim_start_matches('0').is_empty() {
        return Err(bad());
    }
    let repository = normalize_repository(project_repository.unwrap_or(""));
    if repository.is_empty() {
        return Err(format!("the project has no repository, so '{spec}' cannot be turned into a link: pass the full pull request URL"));
    }
    let host = repository.split('/').next().unwrap_or("");
    if host.contains('.') && host != "github.com" {
        return Err(format!("the project repository is on {host}, not GitHub: pass the full pull request URL"));
    }
    Ok(format!("https://github.com/{owner}/{name}/pull/{number}"))
}

/// The wire statuses of a task.
pub const STATUS_TYPES: &[&str] = &["draft", "backlog", "todo", "in_progress", "in_review", "done", "canceled"];

/// `In Progress`, `in-progress` and `in progress` all become `in_progress`.
fn status_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_end_matches('_').to_string()
}

/// The wire status for what was typed: a status as the API names it (`in-progress` works), or the name
/// or id of one of the workspace's status entries (`settings.statuses.issue`, each `{ id, name, type }`).
pub fn status_type(raw: &str, catalog: &[Value]) -> Option<String> {
    let key = status_key(raw);
    if let Some(t) = STATUS_TYPES.iter().find(|t| **t == key) {
        return Some((*t).to_string());
    }
    let entry_type = |e: &Value| e["type"].as_str().map(str::to_string);
    let exact = catalog.iter().find(|e| e["id"].as_str().is_some_and(|id| status_key(id) == key) || e["name"].as_str().is_some_and(|n| status_key(n) == key));
    if let Some(e) = exact {
        return entry_type(e);
    }
    let starting: Vec<&Value> = catalog.iter().filter(|e| e["name"].as_str().is_some_and(|n| !key.is_empty() && status_key(n).starts_with(&format!("{key}_")))).collect();
    match starting.as_slice() {
        [one] => entry_type(one),
        _ => None,
    }
}

/// `in_progress` as people say it: `In progress`.
pub fn humanize_status(status: &str) -> String {
    let words = status.replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn task_path(reference: &str, tail: &str) -> Result<String, String> {
    Ok(format!("/tasks/{}{tail}", encode_segment(&checked_id("the task", reference)?)))
}

/// `PATCH /tasks/{id}` with only `threadUrl`: `Some` links it, `None` unlinks. The API answers 409
/// `thread_already_linked` when the task links a different thread.
pub fn link_call(reference: &str, thread_url: Option<&str>) -> Result<Call, String> {
    let url = match thread_url {
        Some(u) => json!(check_http_url("the thread URL", u)?),
        None => Value::Null,
    };
    Ok(call(Method::Patch, task_path(reference, "")?, Some(json!({ "threadUrl": url }))))
}

/// `PATCH /tasks/{id}` with only the status (a wire status: see [`status_type`]).
pub fn status_call(reference: &str, status: &str) -> Result<Call, String> {
    Ok(call(Method::Patch, task_path(reference, "")?, Some(json!({ "status": status }))))
}

/// `POST /tasks`: a subtask of `parent` (a task as the API returns it) in the parent's project and of
/// its kind, linked to `thread_url` when given.
pub fn subtask_call(parent: &Value, title: &str, thread_url: Option<&str>) -> Result<Call, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("the subtask needs a title".into());
    }
    let parent_id = parent["id"].as_str().ok_or("the parent task has no id")?;
    let mut body = Map::new();
    body.insert("title".into(), json!(title));
    body.insert("parentId".into(), json!(parent_id));
    body.insert("kind".into(), json!(parent["kind"].as_str().unwrap_or("feature")));
    if let Some(project) = parent["projectId"].as_str() {
        body.insert("projectId".into(), json!(project));
    }
    if let Some(url) = thread_url {
        body.insert("threadUrl".into(), json!(check_http_url("the thread URL", url)?));
    }
    Ok(call(Method::Post, "/tasks", Some(Value::Object(body))))
}

/// `POST /tasks/{id}/thread/sync`.
pub fn thread_sync_call(reference: &str, body: Value) -> Result<Call, String> {
    Ok(call(Method::Post, task_path(reference, "/thread/sync")?, Some(body)))
}

/// `GET /tasks/{id}/thread`: the record of the task's thread (404 when it was never synced).
pub fn thread_record_call(reference: &str) -> Result<Call, String> {
    Ok(call(Method::Get, task_path(reference, "/thread")?, None))
}

/// `GET /tasks/{id}/estimate-suggestion`.
pub fn estimate_call(reference: &str) -> Result<Call, String> {
    Ok(call(Method::Get, task_path(reference, "/estimate-suggestion")?, None))
}

/// `GET /decisions`, newest first. `path` matches decisions whose paths equal the file, are a directory
/// prefix of it or match it as a glob; `issue` limits them to one task.
pub fn decisions_call(path: Option<&str>, issue: Option<&str>, limit: Option<usize>) -> Result<Call, String> {
    let mut query = vec![];
    if let Some(p) = path.map(str::trim).filter(|p| !p.is_empty()) {
        let mut p = p;
        while let Some(rest) = p.strip_prefix("./") {
            p = rest;
        }
        query.push(("path".to_string(), p.to_string()));
    }
    if let Some(i) = issue {
        query.push(("issue".to_string(), checked_id("the task", i)?));
    }
    if let Some(n) = limit {
        if !(1..=200).contains(&n) {
            return Err("the limit is 1 to 200".into());
        }
        query.push(("limit".to_string(), n.to_string()));
    }
    Ok(Call { method: Method::Get, path: "/decisions".into(), query, body: None })
}

/// `GET /search` over the decisions and thread records.
pub fn ask_call(question: &str, limit: usize) -> Result<Call, String> {
    let q = question.trim();
    if q.is_empty() {
        return Err("the question is empty".into());
    }
    Ok(Call {
        method: Method::Get,
        path: "/search".into(),
        query: vec![("q".into(), q.chars().take(200).collect()), ("types".into(), "decision,record".into()), ("limit".into(), limit.clamp(1, 100).to_string())],
        body: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(key: &str, id: &str, parent: Option<&str>, created: &str) -> Value {
        let mut t = json!({ "key": key, "id": id, "title": format!("Task {key}"), "status": "todo", "createdAt": created });
        if let Some(p) = parent {
            t["parentId"] = json!(p);
        }
        t
    }

    fn rows() -> Vec<Value> {
        vec![
            task("A-5", "in_5", Some("in_3"), "2026-01-05T00:00:00.000Z"),
            task("A-1", "in_1", None, "2026-01-01T00:00:00.000Z"),
            task("A-3", "in_3", Some("in_1"), "2026-01-03T00:00:00.000Z"),
            task("A-2", "in_2", Some("in_1"), "2026-01-02T00:00:00.000Z"),
            task("A-6", "in_6", Some("in_5"), "2026-01-06T00:00:00.000Z"),
            task("B-1", "in_9", None, "2026-01-09T00:00:00.000Z"),
        ]
    }

    #[test]
    fn the_subtree_has_any_depth_and_keeps_creation_order() {
        let nodes = subtree(&rows(), "in_1", None);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0]["key"], "A-2");
        assert_eq!(nodes[1]["key"], "A-3");
        assert_eq!(nodes[1]["subtasks"][0]["key"], "A-5");
        assert_eq!(nodes[1]["subtasks"][0]["subtasks"][0]["key"], "A-6");
        assert_eq!(count_nodes(&nodes), 4);
        assert!(nodes[0].get("subtasks").is_none());
    }

    #[test]
    fn depth_limits_the_tree_and_a_cycle_does_not_loop() {
        assert_eq!(count_nodes(&subtree(&rows(), "in_1", Some(1))), 2);
        assert_eq!(count_nodes(&subtree(&rows(), "in_1", Some(2))), 3);
        let looped = vec![task("A-1", "in_1", Some("in_2"), "1"), task("A-2", "in_2", Some("in_1"), "2")];
        assert_eq!(count_nodes(&subtree(&looped, "in_1", None)), 1);
        assert!(subtree(&rows(), "in_9", None).is_empty());
    }

    #[test]
    fn children_of_filters_by_parent() {
        let kids = children_of(&rows(), "in_1");
        assert_eq!(kids.iter().map(|k| k["key"].as_str().unwrap()).collect::<Vec<_>>(), ["A-3", "A-2"], "the order of the rows");
        assert!(children_of(&rows(), "in_2").is_empty());
    }

    #[test]
    fn the_tree_renders_with_two_spaces_per_level() {
        let mut all = rows();
        all[2]["estimate"] = json!(3.0);
        let root = all[1].clone();
        let text = render_tree(&root, &subtree(&all, "in_1", None));
        assert_eq!(
            text,
            "A-1  todo  Task A-1\n  A-2  todo  Task A-2\n  A-3  todo  Task A-3  (3 pt)\n    A-5  todo  Task A-5\n      A-6  todo  Task A-6"
        );
    }

    #[test]
    fn repositories_match_across_spellings() {
        for (a, b) in [
            ("alessandrobrunoh/trama", "https://github.com/AlessandroBrunoh/trama.git"),
            ("github.com/owner/name", "git@github.com:Owner/Name.git"),
            ("https://user:pw@github.com/owner/name/", "owner/name"),
            ("OWNER/NAME", "owner/name"),
        ] {
            assert!(repository_matches(a, b), "{a} vs {b}");
        }
        assert!(!repository_matches("owner/name", "owner/other"));
        assert!(!repository_matches("owner/name", "other-owner/name2"));
        assert!(!repository_matches("", "owner/name"));
        let found = filter_by_repository(vec![json!({ "id": "p1", "repository": "https://github.com/o/n" }), json!({ "id": "p2" }), json!({ "id": "p3", "repository": "o/x" })], "o/n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], "p1");
    }

    #[test]
    fn instants_need_a_zone_and_a_real_date() {
        assert_eq!(parse_instant("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(parse_instant("2026-05-01T09:30:00.250Z").unwrap(), 1_777_627_800_250);
        assert_eq!(parse_instant("2026-05-01T11:30:00+02:00").unwrap(), 1_777_627_800_000);
        assert_eq!(parse_instant("2026-05-01T06:30-03").unwrap(), 1_777_627_800_000);
        for bad in ["2026-05-01T09:30:00", "2026-05-01", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-05-01T24:00:00Z", "yesterday", "2026-05-01T09:30:00+25:00", "2026-05-01T09:30:00.Z"] {
            assert!(parse_instant(bad).is_err(), "{bad}");
        }
        assert_eq!(parse_instant("2024-02-29T00:00:00Z").unwrap() - parse_instant("2024-02-28T00:00:00Z").unwrap(), 86_400_000);
    }

    #[test]
    fn timer_requests_mirror_the_server_validation() {
        let c = timer_start_call(Some("in_1"), None, Some("  deep work ")).unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Post, "/time-entries/start"));
        assert_eq!(c.body, Some(json!({ "issueId": "in_1", "description": "deep work" })));
        assert_eq!(timer_start_call(None, None, None).unwrap().body, Some(json!({})));
        assert!(timer_start_call(None, None, Some(&"x".repeat(501))).is_err());
        assert!(timer_start_call(Some(""), None, None).is_err());
        assert_eq!(timer_stop_call().path, "/time-entries/stop");
        assert_eq!(timer_list_call().method, Method::Get);

        let c = timer_add_call(Some("in_1"), None, None, "2026-05-01T09:00:00Z", "2026-05-01T10:15:00Z").unwrap();
        assert_eq!(c.body, Some(json!({ "issueId": "in_1", "startedAt": "2026-05-01T09:00:00Z", "endedAt": "2026-05-01T10:15:00Z" })));
        assert!(timer_add_call(None, None, None, "2026-05-01T10:00:00Z", "2026-05-01T10:00:00Z").is_err());
        assert!(timer_add_call(None, None, None, "2026-05-01T10:00:00Z", "2026-05-01T09:00:00Z").is_err());
        assert!(timer_add_call(None, None, None, "2026-05-01 10:00", "2026-05-01T11:00:00Z").is_err());

        let c = timer_delete_call("te_1").unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Delete, "/time-entries/te_1"));
        assert_eq!(timer_delete_call("a/b").unwrap().path, "/time-entries/a%2Fb");
        assert!(timer_delete_call(" ").is_err());
    }

    #[test]
    fn entries_get_durations_and_the_running_one_is_found() {
        let now = parse_instant("2026-05-01T10:30:00Z").unwrap();
        let done = json!({ "id": "te_1", "startedAt": "2026-05-01T09:00:00.000Z", "endedAt": "2026-05-01T10:15:00.000Z" });
        let live = json!({ "id": "te_2", "startedAt": "2026-05-01T10:00:00.000Z", "endedAt": null });
        let done_a = annotate_entry(&done, now);
        assert_eq!(done_a["durationSeconds"], 4500);
        assert_eq!(done_a["duration"], "1h 15m");
        let live_a = annotate_entry(&live, now);
        assert_eq!(live_a["running"], true);
        assert_eq!(live_a["elapsedSeconds"], 1800);
        assert_eq!(live_a["elapsed"], "30m 00s");
        let all = [done.clone(), live];
        assert_eq!(running_entry(&all).unwrap()["id"], "te_2");
        assert!(running_entry(&[done]).is_none());
        assert_eq!(total_seconds(&[done_a, live_a]), 4500);
        assert_eq!(format_duration(45), "45s");
    }

    #[test]
    fn durations_are_read_the_way_people_write_them() {
        for (raw, minutes) in [("1h15", 75), ("1h15m", 75), ("1h", 60), ("45m", 45), ("90", 90), ("1:15", 75), (" 2H 05 ", 125), ("0:30", 30), ("24h", 1440)] {
            assert_eq!(parse_minutes(raw).unwrap(), minutes, "{raw}");
        }
        for bad in ["", "0", "0m", "h", "1h75", "1:75", "1.5h", "abc", "-5", "25h", "1h15x", "1h m"] {
            assert!(parse_minutes(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn instants_round_trip_through_the_formatter() {
        assert_eq!(format_instant(0), "1970-01-01T00:00:00.000Z");
        let ms = parse_instant("2026-05-01T09:30:00.250Z").unwrap();
        assert_eq!(format_instant(ms), "2026-05-01T09:30:00.250Z");
        assert_eq!(parse_instant(&format_instant(1_777_627_800_000)).unwrap(), 1_777_627_800_000);
        assert_eq!(format_instant(parse_instant("2024-02-29T23:59:59Z").unwrap()), "2024-02-29T23:59:59.000Z");
    }

    #[test]
    fn a_logged_entry_ends_at_the_given_instant() {
        let end = parse_instant("2026-05-01T10:15:00Z").unwrap();
        let c = timer_log_call(Some("in_1"), None, Some("login"), 75, end).unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Post, "/time-entries"));
        assert_eq!(c.body, Some(json!({ "issueId": "in_1", "description": "login", "startedAt": "2026-05-01T09:00:00.000Z", "endedAt": "2026-05-01T10:15:00.000Z" })));
        let s = time_suggestions_call();
        assert_eq!((s.method, s.path.as_str(), s.query), (Method::Get, "/time-entries", vec![("source".to_string(), "suggested".to_string())]));
        let a = time_accept_call("te_9").unwrap();
        assert_eq!((a.method, a.path.as_str(), a.body), (Method::Post, "/time-entries/te_9/accept", None));
        assert!(time_accept_call(" ").is_err());
    }

    #[test]
    fn thread_links_come_from_urls_or_bare_ids() {
        let t = |raw: &str, base: Option<&str>, current: Option<&str>| thread_url_from(raw, base, current);
        assert_eq!(t("https://delta.example/t/th_1", None, None).unwrap(), "https://delta.example/t/th_1");
        assert_eq!(t("th_1", Some("https://delta.example/t/"), None).unwrap(), "https://delta.example/t/th_1");
        assert_eq!(t("th_2", None, Some("https://delta.example/t/th_1?x=1")).unwrap(), "https://delta.example/t/th_2");
        assert_eq!(t("th_1", None, Some("https://delta.example/t/th_1")).unwrap(), "https://delta.example/t/th_1");
        assert_eq!(t("th_2", Some("https://a.example/x"), Some("https://b.example/y/th_1")).unwrap(), "https://a.example/x/th_2", "the explicit base wins");
        let err = t("th_1", None, None).unwrap_err();
        assert!(err.contains("TRAMA_THREAD_URL_BASE"), "{err}");
        for bad in ["", "a/b", "ftp://x/y", "th 1"] {
            assert!(t(bad, None, None).is_err(), "{bad}");
        }
        assert!(t("https://delta.example/a b", None, None).is_err());
    }

    #[test]
    fn paths_stay_inside_the_repository() {
        assert_eq!(repo_path(" ./src/auth/*.ts ").unwrap(), "src/auth/*.ts");
        assert_eq!(repo_path("src/auth/").unwrap(), "src/auth/");
        for bad in ["", ".", "/etc/passwd", "../x", "a/../b", "C:/x", "\\\\host\\x"] {
            assert!(repo_path(bad).is_err(), "{bad}");
        }
        assert!(repo_path(&"a".repeat(513)).is_err());
        assert!(repo_path("..hidden/file").is_ok());
    }

    #[test]
    fn decisions_split_their_paths_off_the_last_at() {
        assert_eq!(parse_decision("Use rotating tokens@src/auth/*,src/session.ts").unwrap(), ("Use rotating tokens".to_string(), vec!["src/auth/*".to_string(), "src/session.ts".to_string()]));
        assert_eq!(parse_decision("No paths here").unwrap(), ("No paths here".to_string(), vec![]));
        assert_eq!(parse_decision("Ask @bob first @").unwrap(), ("Ask @bob first".to_string(), vec![]));
        assert_eq!(parse_decision("mail me @ home").unwrap().1, Vec::<String>::new(), "a tail with a space is text");
        assert!(parse_decision("").is_err());
        assert_eq!(parse_decision("@src/a.ts").unwrap(), ("@src/a.ts".to_string(), vec![]), "no text before the @: it is all text");
        assert!(parse_decision("x@/abs/path").is_err());
        assert!(parse_decision(&"x".repeat(1001)).is_err());
    }

    #[test]
    fn a_sync_body_carries_only_what_was_sent_and_is_validated() {
        assert_eq!(sync_body(&SyncParts::default()).unwrap(), json!({}));
        let parts = SyncParts {
            summary: Some("  Added retries  ".into()),
            decisions: vec![("Retry twice".into(), vec!["src/net/".into()]), ("Keep it simple".into(), vec![])],
            files: vec!["./a.ts".into(), "b.ts".into(), "a.ts".into()],
            pull_request_url: Some("https://github.com/acme/web/pull/423".into()),
            active_minutes: Some(47),
            turns: Some(12),
            thread_url: Some("https://delta.example/t/1".into()),
        };
        assert_eq!(
            sync_body(&parts).unwrap(),
            json!({
                "summary": "Added retries",
                "decisions": [{ "text": "Retry twice", "paths": ["src/net/"] }, { "text": "Keep it simple" }],
                "files": ["a.ts", "b.ts"],
                "pullRequestUrl": "https://github.com/acme/web/pull/423",
                "activeMinutes": 47,
                "turns": 12,
                "threadUrl": "https://delta.example/t/1"
            })
        );
        let with = |f: fn(&mut SyncParts)| {
            let mut p = SyncParts::default();
            f(&mut p);
            sync_body(&p)
        };
        assert!(with(|p| p.summary = Some("x".repeat(4001))).is_err());
        assert!(with(|p| p.decisions = vec![("d".into(), vec![]); 21]).is_err());
        assert!(with(|p| p.files = vec!["../x".into()]).is_err());
        assert!(with(|p| p.active_minutes = Some(0)).is_err());
        assert!(with(|p| p.active_minutes = Some(721)).is_err());
        assert!(with(|p| p.turns = Some(-1)).is_err());
        assert!(with(|p| p.pull_request_url = Some("not a url".into())).is_err());
        assert!(with(|p| p.thread_url = Some("th_1".into())).is_err());
        let many = SyncParts { files: (0..600).map(|i| format!("f{i}.ts")).collect(), ..SyncParts::default() };
        assert_eq!(sync_body(&many).unwrap()["files"].as_array().unwrap().len(), THREAD_FILES_MAX);
    }

    #[test]
    fn pull_requests_become_github_links_only_for_github_projects() {
        let url = "https://github.com/acme/web/pull/423";
        assert_eq!(pull_request_url("acme/web#423", Some("https://github.com/acme/web.git")).unwrap(), url);
        assert_eq!(pull_request_url("acme/web#423", Some("acme/web")).unwrap(), url, "a bare owner/name is GitHub");
        assert_eq!(pull_request_url("acme/web#423", Some("git@github.com:acme/web")).unwrap(), url);
        assert_eq!(pull_request_url("https://gitlab.com/a/b/-/merge_requests/3", None).unwrap(), "https://gitlab.com/a/b/-/merge_requests/3");
        assert!(pull_request_url("acme/web#423", Some("https://gitlab.com/acme/web")).unwrap_err().contains("gitlab.com"));
        assert!(pull_request_url("acme/web#423", None).unwrap_err().contains("no repository"));
        for bad in ["acme/web", "acme#4", "acme/web#", "acme/web#0", "acme/web#x", "a b/c#1", "/web#1"] {
            assert!(pull_request_url(bad, Some("acme/web")).is_err(), "{bad}");
        }
    }

    #[test]
    fn statuses_accept_dashes_and_the_workspace_labels() {
        let catalog = vec![
            json!({ "id": "backlog", "name": "Backlog", "type": "backlog" }),
            json!({ "id": "todo", "name": "Planning", "type": "todo" }),
            json!({ "id": "in_review", "name": "In Review / Waiting Input", "type": "in_review" }),
            json!({ "id": "done", "name": "Merged", "type": "done" }),
            json!({ "id": "st_blocked", "name": "Blocked by legal", "type": "in_progress" }),
        ];
        let s = |raw: &str| status_type(raw, &catalog);
        assert_eq!(s("in-progress").as_deref(), Some("in_progress"));
        assert_eq!(s("In Progress").as_deref(), Some("in_progress"));
        assert_eq!(s("IN_REVIEW").as_deref(), Some("in_review"));
        assert_eq!(s("planning").as_deref(), Some("todo"));
        assert_eq!(s("Merged").as_deref(), Some("done"));
        assert_eq!(s("st_blocked").as_deref(), Some("in_progress"));
        assert_eq!(s("blocked").as_deref(), Some("in_progress"), "a unique name prefix");
        assert_eq!(s("waiting"), None);
        assert_eq!(s(""), None);
        assert_eq!(status_type("done", &[]).as_deref(), Some("done"), "the wire names need no catalog");
        assert_eq!(humanize_status("in_progress"), "In progress");
        assert_eq!(humanize_status("todo"), "Todo");
    }

    #[test]
    fn thread_requests_use_the_task_routes() {
        let c = link_call("TRM-128", Some("https://delta.example/t/1")).unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Patch, "/tasks/TRM-128"));
        assert_eq!(c.body, Some(json!({ "threadUrl": "https://delta.example/t/1" })));
        assert_eq!(link_call("TRM-128", None).unwrap().body, Some(json!({ "threadUrl": null })));
        assert!(link_call("TRM-128", Some("th_1")).is_err());
        assert_eq!(status_call("TRM-1.3", "in_progress").unwrap().body, Some(json!({ "status": "in_progress" })));

        let parent = json!({ "id": "in_1", "key": "TRM-128", "kind": "feature", "projectId": "pj_1" });
        let c = subtask_call(&parent, "  Retry metrics ", Some("https://delta.example/t/2")).unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Post, "/tasks"));
        assert_eq!(c.body, Some(json!({ "title": "Retry metrics", "parentId": "in_1", "kind": "feature", "projectId": "pj_1", "threadUrl": "https://delta.example/t/2" })));
        assert_eq!(subtask_call(&json!({ "id": "in_1", "kind": "bug" }), "t", None).unwrap().body, Some(json!({ "title": "t", "parentId": "in_1", "kind": "bug" })));
        assert!(subtask_call(&parent, " ", None).is_err());

        assert_eq!(thread_sync_call("TRM-128", json!({})).unwrap().path, "/tasks/TRM-128/thread/sync");
        assert_eq!(thread_record_call("in_1").unwrap().path, "/tasks/in_1/thread");
        assert_eq!(estimate_call("a/b").unwrap().path, "/tasks/a%2Fb/estimate-suggestion");
        assert!(estimate_call(" ").is_err());

        let d = decisions_call(Some("./src/auth/login.ts"), Some("TRM-128"), Some(5)).unwrap();
        assert_eq!(d.path, "/decisions");
        assert_eq!(d.query, vec![("path".to_string(), "src/auth/login.ts".to_string()), ("issue".to_string(), "TRM-128".to_string()), ("limit".to_string(), "5".to_string())]);
        assert!(decisions_call(None, None, None).unwrap().query.is_empty());
        assert!(decisions_call(None, None, Some(0)).is_err());
        assert!(decisions_call(None, None, Some(201)).is_err());

        let q = ask_call("  why tokens? ", 10).unwrap();
        assert_eq!(q.path, "/search");
        assert_eq!(q.query, vec![("q".to_string(), "why tokens?".to_string()), ("types".to_string(), "decision,record".to_string()), ("limit".to_string(), "10".to_string())]);
        assert!(ask_call(" ", 10).is_err());
    }
}
