//! `api_request`: escape hatch for workspace routes that have no curated tool (integrations,
//! outgoing webhooks, token minting, settings…). It can only reach `/w/{slug}/…` of the key's own
//! workspace and the API still enforces the key's permissions, role and caps on every call.

use serde_json::{Value, json};

use crate::catalog::{Call, Method};

pub const NAME: &str = "api_request";

pub fn listing() -> Value {
    json!({
        "name": NAME,
        "description": "Call any workspace REST route not covered by a dedicated tool. `path` is relative to the workspace (e.g. '/integrations'). The API checks your key's permissions on every call. Prefer the dedicated tools when one exists.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "method": { "type": "string", "enum": ["GET", "POST", "PATCH", "DELETE"] },
                "path": { "type": "string", "description": "Workspace-relative path starting with '/', e.g. '/outgoing-webhooks/ow_123/test'. No query string, no '..'." },
                "query": { "type": "object", "description": "Query parameters (string, number or boolean values)." },
                "body": { "type": "object", "description": "JSON body for POST/PATCH." },
            },
            "required": ["method", "path"],
            "additionalProperties": false,
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false },
    })
}

/// Only plain path segments: letters, digits and `_ - . ~ :`. No `%` (no encoded dots/slashes),
/// no empty or dot segments, no query or fragment.
fn valid_path(path: &str) -> bool {
    if path == "/" {
        return true;
    }
    path.starts_with('/')
        && path.len() <= 512
        && path[1..].split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'~' | b':'))
        })
}

pub fn build_call(args: &Value) -> Result<Call, String> {
    let obj = args.as_object().ok_or("arguments must be an object")?;
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "method" | "path" | "query" | "body")) {
        return Err(format!("unknown argument '{k}'"));
    }
    let method = obj
        .get("method")
        .and_then(Value::as_str)
        .and_then(Method::parse)
        .ok_or("method must be one of GET, POST, PATCH, DELETE")?;
    let path = obj.get("path").and_then(Value::as_str).ok_or("path is required")?;
    if !valid_path(path) {
        return Err("path must be workspace-relative like '/issues/BUG-1' (letters, digits and _-.~: only)".into());
    }
    let mut query = Vec::new();
    if let Some(q) = obj.get("query") {
        let q = q.as_object().ok_or("query must be an object")?;
        for (k, v) in q {
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => return Err(format!("query.{k} must be a string, number or boolean")),
            };
            query.push((k.clone(), s));
        }
    }
    let body = match obj.get("body") {
        None | Some(Value::Null) => None,
        Some(b @ Value::Object(_)) if method != Method::Get => Some(b.clone()),
        Some(_) => return Err("body must be an object and is not allowed on GET".into()),
    };
    // The workspace root is "" in the catalog; "/" means the same here.
    let path = if path == "/" { String::new() } else { path.to_string() };
    Ok(Call { method, path, query, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_workspace_paths() {
        let c = build_call(&json!({ "method": "post", "path": "/outgoing-webhooks/ow_1/test", "body": {} })).unwrap();
        assert_eq!(c.method, Method::Post);
        assert_eq!(c.path, "/outgoing-webhooks/ow_1/test");
        assert_eq!(build_call(&json!({ "method": "GET", "path": "/" })).unwrap().path, "");
    }

    #[test]
    fn blocks_traversal_and_smuggling() {
        for p in ["/../auth/me", "/a/../b", "//x", "/a//b", "/x?y=1", "/x#f", "/%2e%2e/x", "/a\\b", "x", "", "/a b", "/ä"] {
            assert!(build_call(&json!({ "method": "GET", "path": p })).is_err(), "{p}");
        }
        assert!(build_call(&json!({ "method": "PUT", "path": "/x" })).is_err());
        assert!(build_call(&json!({ "method": "GET", "path": "/x", "body": {} })).is_err());
        assert!(build_call(&json!({ "method": "GET", "path": "/x", "extra": 1 })).is_err());
    }
}
