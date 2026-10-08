//! Output formatting. Machine-friendly by default: compact JSON when stdout is not a terminal,
//! a table for lists and indented JSON for single objects when it is.

use serde_json::{Map, Value};

use crate::error::{CliError, Result};
use crate::http::Reply;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Auto,
    /// Compact JSON, always.
    Json,
    /// Indented JSON, always.
    Pretty,
    /// One compact JSON document per line (arrays are split into their elements).
    Jsonl,
    Table,
    /// The reply body exactly as the API sent it.
    Raw,
}

impl Mode {
    pub const NAMES: [&'static str; 6] = ["auto", "json", "pretty", "jsonl", "table", "raw"];

    pub fn parse(s: &str) -> Option<Mode> {
        Some(match s {
            "auto" => Mode::Auto,
            "json" => Mode::Json,
            "pretty" => Mode::Pretty,
            "jsonl" => Mode::Jsonl,
            "table" => Mode::Table,
            "raw" => Mode::Raw,
            _ => return None,
        })
    }

    /// Does the user want JSON back (so `Accept` can stay `application/json`)?
    pub fn wants_json(self) -> bool {
        matches!(self, Mode::Json | Mode::Pretty | Mode::Jsonl)
    }
}

#[derive(Clone, Debug)]
pub struct Format {
    pub mode: Mode,
    pub fields: Vec<String>,
    pub tty: bool,
}

/// Follows a dotted path; arrays are traversed element-wise. `None` when nothing matches.
fn pick(value: &Value, path: &[&str]) -> Option<Value> {
    let Some((head, rest)) = path.split_first() else {
        return Some(value.clone());
    };
    match value {
        Value::Array(items) => Some(Value::Array(items.iter().filter_map(|i| pick(i, path)).collect())),
        Value::Object(map) => {
            let inner = pick(map.get(*head)?, rest)?;
            let mut out = Map::new();
            out.insert((*head).to_string(), inner);
            Some(Value::Object(out))
        }
        _ => None,
    }
}

fn merge(into: &mut Value, from: Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        a.insert(k, v);
                    }
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for (slot, v) in a.iter_mut().zip(b) {
                merge(slot, v);
            }
        }
        (slot, v) => *slot = v,
    }
}

/// Keeps only the requested (dot-separated) fields of an object or of every element of an array.
pub fn project(value: &Value, fields: &[String]) -> Value {
    if fields.is_empty() {
        return value.clone();
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|i| project(i, fields)).collect()),
        Value::Object(_) => {
            let mut out = Value::Object(Map::new());
            for f in fields {
                let parts: Vec<&str> = f.split('.').collect();
                if let Some(p) = pick(value, &parts) {
                    merge(&mut out, p);
                }
            }
            out
        }
        other => other.clone(),
    }
}

const MAX_CELL: usize = 60;
const PREFERRED: [&str; 12] = ["key", "id", "name", "title", "status", "state", "kind", "priority", "role", "email", "slug", "updatedAt"];

fn cell(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(items) if items.iter().all(|i| !i.is_object() && !i.is_array()) => items.iter().map(cell).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    };
    let text = text.replace(['\n', '\r', '\t'], " ");
    if text.chars().count() > MAX_CELL {
        let mut short: String = text.chars().take(MAX_CELL - 1).collect();
        short.push('…');
        short
    } else {
        text
    }
}

fn is_scalar(v: &Value) -> bool {
    !v.is_object() && !v.is_array()
}

fn auto_columns(rows: &[Value]) -> Vec<String> {
    let sample: Vec<&Map<String, Value>> = rows.iter().take(20).filter_map(Value::as_object).collect();
    let present = |k: &str| sample.iter().any(|m| m.get(k).is_some_and(|v| !v.is_null()));
    let mut cols: Vec<String> = PREFERRED.iter().filter(|k| present(k)).map(|k| k.to_string()).collect();
    if let Some(first) = sample.first() {
        for (k, v) in first.iter() {
            if cols.len() >= 6 {
                break;
            }
            if !cols.contains(k) && is_scalar(v) && !k.ends_with("Id") && !matches!(k.as_str(), "description" | "body" | "summary" | "createdAt") {
                cols.push(k.clone());
            }
        }
    }
    cols.truncate(6);
    cols
}

pub fn table(value: &Value, fields: &[String]) -> String {
    let (headers, rows): (Vec<String>, Vec<Vec<String>>) = match value {
        Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object) => {
            let cols = if fields.is_empty() { auto_columns(items) } else { fields.to_vec() };
            let rows = items
                .iter()
                .map(|row| {
                    cols.iter()
                        .map(|c| {
                            let parts: Vec<&str> = c.split('.').collect();
                            let mut cur = Some(row);
                            for p in &parts {
                                cur = cur.and_then(|v| v.get(*p));
                            }
                            cur.map(cell).unwrap_or_default()
                        })
                        .collect()
                })
                .collect();
            (cols, rows)
        }
        Value::Object(map) => {
            let keys: Vec<(&String, &Value)> = map.iter().filter(|(k, _)| fields.is_empty() || fields.contains(k)).collect();
            (vec!["field".into(), "value".into()], keys.into_iter().map(|(k, v)| vec![k.clone(), cell(v)]).collect())
        }
        Value::Array(items) if items.is_empty() => return "(no results)".into(),
        other => return serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let widths: Vec<usize> = (0..headers.len())
        .map(|i| rows.iter().map(|r| r[i].chars().count()).chain(std::iter::once(headers[i].chars().count())).max().unwrap_or(0))
        .collect();
    let line = |cells: &[String]| {
        let mut s = String::new();
        for (i, c) in cells.iter().enumerate() {
            if i + 1 == cells.len() {
                s.push_str(c);
            } else {
                s.push_str(c);
                s.push_str(&" ".repeat(widths[i] - c.chars().count() + 2));
            }
        }
        s.trim_end().to_string()
    };
    let upper: Vec<String> = headers.iter().map(|h| h.to_uppercase()).collect();
    let mut out = vec![line(&upper)];
    out.extend(rows.iter().map(|r| line(r)));
    out.join("\n")
}

/// `{ "results": [..] }`: an object whose only property is an array. Tables and `--fields` look through it.
fn envelope(value: &Value) -> Option<(&String, &Vec<Value>)> {
    let map = value.as_object().filter(|m| m.len() == 1)?;
    let (key, inner) = map.iter().next()?;
    inner.as_array().map(|items| (key, items))
}

/// Renders a JSON value.
pub fn render(value: &Value, fmt: &Format) -> String {
    // See through a single-array envelope unless the user addressed its key explicitly.
    let wrapped = envelope(value).filter(|(key, _)| !fmt.fields.iter().any(|f| f.split('.').next() == Some(key.as_str())));
    let (wrap_key, body) = match wrapped {
        Some((key, items)) => (Some(key.clone()), project(&Value::Array(items.clone()), &fmt.fields)),
        None => (None, project(value, &fmt.fields)),
    };
    let mode = match fmt.mode {
        Mode::Auto if !fmt.tty => Mode::Json,
        Mode::Auto => match &body {
            Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object) => Mode::Table,
            _ => Mode::Pretty,
        },
        other => other,
    };
    // Data-shaped modes keep the envelope; list-shaped modes show the rows.
    let rewrap = |v: Value| match &wrap_key {
        Some(key) => {
            let mut m = Map::new();
            m.insert(key.clone(), v);
            Value::Object(m)
        }
        None => v,
    };
    match mode {
        Mode::Pretty | Mode::Raw => serde_json::to_string_pretty(&rewrap(body)).unwrap_or_default(),
        Mode::Jsonl => match &body {
            Value::Array(items) => items.iter().map(Value::to_string).collect::<Vec<_>>().join("\n"),
            other => other.to_string(),
        },
        Mode::Table => table(&body, &fmt.fields),
        Mode::Json | Mode::Auto => rewrap(body).to_string(),
    }
}

/// Writes a line to stdout. A closed pipe (`trama … | head`) is not an error worth a panic.
pub fn emit(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes()).and_then(|_| if text.ends_with('\n') { Ok(()) } else { out.write_all(b"\n") });
    let _ = out.flush();
}

pub fn print(value: &Value, fmt: &Format) {
    let text = render(value, fmt);
    if !text.is_empty() {
        emit(&text);
    }
}

/// Prints an API reply. Non-JSON replies (the markdown briefing) are passed through untouched.
pub fn print_reply(reply: &Reply, fmt: &Format) -> Result<()> {
    if fmt.mode == Mode::Raw || (!reply.is_json() && !reply.body.trim().is_empty()) {
        emit(&reply.body);
        return Ok(());
    }
    if reply.body.trim().is_empty() {
        if fmt.tty {
            eprintln!("OK");
        } else {
            emit("{\"ok\":true}");
        }
        return Ok(());
    }
    let value = reply.json().map_err(|e| e.hint("Use `-o raw` to see the reply."))?;
    print(&value, fmt);
    Ok(())
}

pub fn parse_fields(raw: Option<&str>) -> Result<Vec<String>> {
    let Some(raw) = raw else { return Ok(vec![]) };
    let fields: Vec<String> = raw.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if let Some(bad) = fields.iter().find(|f| f.split('.').any(str::is_empty)) {
        return Err(CliError::usage(format!("invalid field path '{bad}' in --fields")));
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fmt(mode: Mode, tty: bool, fields: &[&str]) -> Format {
        Format { mode, tty, fields: fields.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn projects_nested_fields_and_arrays() {
        let v = json!([{ "id": "a", "title": "T", "assignee": { "id": "u", "name": "Ann", "x": 1 }, "criteria": [{ "text": "c1", "state": "met" }, { "text": "c2", "state": "pending" }] }]);
        let p = project(&v, &["id".into(), "assignee.name".into(), "criteria.text".into(), "nope".into()]);
        assert_eq!(p, json!([{ "id": "a", "assignee": { "name": "Ann" }, "criteria": [{ "text": "c1" }, { "text": "c2" }] }]));
    }

    #[test]
    fn auto_is_compact_json_when_piped_and_table_on_a_tty() {
        let v = json!([{ "key": "BUG-1", "title": "Crash", "status": "todo", "workspaceId": "ws_1" }, { "key": "BUG-2", "title": "Slow", "status": "done" }]);
        assert_eq!(render(&v, &fmt(Mode::Auto, false, &[])), v.to_string());
        let t = render(&v, &fmt(Mode::Auto, true, &[]));
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines[0], "KEY    TITLE  STATUS");
        assert_eq!(lines[1], "BUG-1  Crash  todo");
        assert_eq!(lines.len(), 3);
        assert!(!t.contains("workspaceId") && !t.contains("ws_1"));
    }

    #[test]
    fn looks_through_single_array_envelopes() {
        let v = json!({ "results": [{ "id": "1", "title": "A", "type": "issue", "score": 3 }, { "id": "2", "title": "B", "type": "team", "score": 1 }] });
        assert_eq!(render(&v, &fmt(Mode::Json, false, &["id", "type"])), r#"{"results":[{"id":"1","type":"issue"},{"id":"2","type":"team"}]}"#);
        let t = render(&v, &fmt(Mode::Table, true, &["id", "type"]));
        assert_eq!(t.lines().next().unwrap(), "ID  TYPE");
        assert_eq!(render(&v, &fmt(Mode::Jsonl, false, &["id"])), "{\"id\":\"1\"}\n{\"id\":\"2\"}");
        // two properties: not an envelope, fields apply to the object itself
        let n = json!({ "items": [{ "id": "1" }], "unread": 4 });
        assert_eq!(render(&n, &fmt(Mode::Json, false, &["unread"])), r#"{"unread":4}"#);
    }

    #[test]
    fn jsonl_splits_arrays() {
        let v = json!([{ "a": 1 }, { "a": 2 }]);
        assert_eq!(render(&v, &fmt(Mode::Jsonl, false, &[])), "{\"a\":1}\n{\"a\":2}");
        assert_eq!(render(&json!({ "a": 1 }), &fmt(Mode::Jsonl, false, &[])), "{\"a\":1}");
    }

    #[test]
    fn table_handles_objects_empty_lists_and_long_cells() {
        let t = table(&json!({ "name": "Acme", "labels": ["a", "b"] }), &[]);
        assert!(t.contains("FIELD") && t.contains("labels") && t.contains("a, b"));
        assert_eq!(table(&json!([]), &[]), "(no results)");
        let long = "x".repeat(200);
        let t = table(&json!([{ "id": "1", "title": long }]), &[]);
        assert!(t.lines().nth(1).unwrap().chars().count() < 80 && t.contains('…'));
    }

    #[test]
    fn explicit_fields_drive_table_columns() {
        let v = json!([{ "id": "1", "owner": { "name": "Ann" }, "title": "T" }]);
        let t = render(&v, &fmt(Mode::Table, true, &["id", "owner.name"]));
        assert_eq!(t.lines().next().unwrap(), "ID  OWNER.NAME");
        assert_eq!(t.lines().nth(1).unwrap(), "1   Ann");
    }

    #[test]
    fn validates_field_lists() {
        assert_eq!(parse_fields(Some("id, title ,a.b")).unwrap(), vec!["id", "title", "a.b"]);
        assert!(parse_fields(Some("a..b")).is_err());
        assert!(parse_fields(None).unwrap().is_empty());
    }
}
