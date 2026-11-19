//! Helpers for the parts of a task that the REST catalog (`tools.json`) cannot express on its own:
//! the subtask tree, a person's timer, the LunaGest import and the repository match of a project.
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

// ───────────────────────────── LunaGest import ─────────────────────────────

/// Most remote projects one import request may carry (the server rejects more).
pub const LUNAGEST_IMPORT_MAX_PROJECTS: usize = 25;
const LUNAGEST_ID_MAX: usize = 200;

/// `GET /lunagest/import/projects`: the remote projects with task counts and whether each is already
/// bound to a Trama project. Needs the project-management capability.
pub fn lunagest_list_call() -> Call {
    call(Method::Get, "/lunagest/import/projects", None)
}

/// `POST /lunagest/import`: imports the chosen remote projects and their tasks. Idempotent. The caller
/// needs the project-management capability (it creates projects) and permission to create tasks.
pub fn lunagest_import_call(remote_project_ids: &[String]) -> Result<Call, String> {
    let mut ids: Vec<String> = vec![];
    for raw in remote_project_ids {
        let id = raw.trim();
        if id.is_empty() || id.chars().count() > LUNAGEST_ID_MAX {
            return Err(format!("each LunaGest project id must be 1 to {LUNAGEST_ID_MAX} characters"));
        }
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        return Err("pass at least one LunaGest project id (list them first)".into());
    }
    if ids.len() > LUNAGEST_IMPORT_MAX_PROJECTS {
        return Err(format!("an import carries at most {LUNAGEST_IMPORT_MAX_PROJECTS} projects; split it"));
    }
    Ok(call(Method::Post, "/lunagest/import", Some(json!({ "remoteProjectIds": ids }))))
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
    fn lunagest_requests_mirror_the_server_limits() {
        assert_eq!(lunagest_list_call().path, "/lunagest/import/projects");
        let c = lunagest_import_call(&["rp_1".into(), " rp_2 ".into(), "rp_1".into()]).unwrap();
        assert_eq!((c.method, c.path.as_str()), (Method::Post, "/lunagest/import"));
        assert_eq!(c.body, Some(json!({ "remoteProjectIds": ["rp_1", "rp_2"] })));
        assert!(lunagest_import_call(&[]).is_err());
        assert!(lunagest_import_call(&["".into()]).is_err());
        assert!(lunagest_import_call(&["x".repeat(201)]).is_err());
        let many: Vec<String> = (0..26).map(|i| format!("rp_{i}")).collect();
        assert!(lunagest_import_call(&many).is_err());
        assert!(lunagest_import_call(&many[..25]).is_ok());
    }
}
