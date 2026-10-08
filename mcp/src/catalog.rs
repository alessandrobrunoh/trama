//! Declarative tool catalog (`tools.json`): one entry per REST route the MCP server exposes.
//!
//! Parameters are described with a compact spec, `"<in> <type>[!][(a|b|c)] <description>"`:
//! `in` is `path`, `query` or `body`; `type` is `string`, `number`, `integer`, `boolean`, `object`,
//! `string[]` or `object[]`; `!` marks it required; `(a|b)` restricts a string to those values.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};

pub const TOOLS_JSON: &str = include_str!("tools.json");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }

    pub fn parse(s: &str) -> Option<Method> {
        match s.to_ascii_uppercase().as_str() {
            "GET" => Some(Method::Get),
            "POST" => Some(Method::Post),
            "PATCH" => Some(Method::Patch),
            "DELETE" => Some(Method::Delete),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Loc {
    Path,
    Query,
    Body,
}

#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub loc: Loc,
    pub ty: String,
    pub required: bool,
    pub choices: Vec<String>,
    pub description: String,
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub method: Method,
    /// Relative to `/w/{slug}`; `{name}` placeholders are path params.
    pub path: String,
    /// `<resource>:<action>` the API key needs (enforced by the API; used here to hide tools).
    pub permission: String,
    pub params: Vec<Param>,
}

/// A fully resolved upstream request (path relative to the workspace).
#[derive(Debug, PartialEq)]
pub struct Call {
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
}

#[derive(Deserialize)]
struct RawTool {
    name: String,
    method: String,
    path: String,
    permission: String,
    description: String,
    #[serde(default)]
    params: BTreeMap<String, String>,
}

const TYPES: &[&str] = &["string", "number", "integer", "boolean", "object", "string[]", "object[]"];

fn parse_param(name: &str, spec: &str) -> Result<Param, String> {
    let mut it = spec.splitn(3, ' ');
    let loc = match it.next() {
        Some("path") => Loc::Path,
        Some("query") => Loc::Query,
        Some("body") => Loc::Body,
        other => return Err(format!("{name}: bad location {other:?}")),
    };
    let ty_token = it.next().ok_or_else(|| format!("{name}: missing type"))?;
    let description = it.next().unwrap_or("").to_string();
    let required = ty_token.contains('!') || loc == Loc::Path;
    let cleaned = ty_token.replace('!', "");
    let (ty, choices) = match cleaned.split_once('(') {
        Some((ty, rest)) => {
            let inner = rest.strip_suffix(')').ok_or_else(|| format!("{name}: unclosed enum"))?;
            (ty.to_string(), inner.split('|').map(str::to_string).collect())
        }
        None => (cleaned, Vec::new()),
    };
    if !TYPES.contains(&ty.as_str()) {
        return Err(format!("{name}: unknown type {ty}"));
    }
    if !choices.is_empty() && ty != "string" {
        return Err(format!("{name}: enum on non-string"));
    }
    Ok(Param { name: name.to_string(), loc, ty, required, choices, description })
}

fn placeholders(path: &str) -> Vec<&str> {
    path.split('{').skip(1).filter_map(|s| s.split_once('}').map(|(n, _)| n)).collect()
}

/// Parses and validates the embedded catalog. Called once at startup (and in tests).
pub fn load() -> Result<Vec<Tool>, String> {
    parse(TOOLS_JSON)
}

pub fn parse(json: &str) -> Result<Vec<Tool>, String> {
    let raw: Vec<RawTool> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut tools = Vec::with_capacity(raw.len());
    for r in raw {
        let ctx = |e: String| format!("tool {}: {e}", r.name);
        if !seen.insert(r.name.clone()) {
            return Err(ctx("duplicate name".into()));
        }
        let method = Method::parse(&r.method).ok_or_else(|| ctx(format!("bad method {}", r.method)))?;
        let Some((resource, action)) = r.permission.split_once(':') else {
            return Err(ctx("permission must be <resource>:<action>".into()));
        };
        if resource.is_empty() || action.is_empty() {
            return Err(ctx("empty permission part".into()));
        }
        let mut params = Vec::new();
        for (name, spec) in &r.params {
            params.push(parse_param(name, spec).map_err(&ctx)?);
        }
        let in_path: Vec<&str> = placeholders(&r.path);
        for p in params.iter().filter(|p| p.loc == Loc::Path) {
            if !in_path.contains(&p.name.as_str()) {
                return Err(ctx(format!("path param {} not in path", p.name)));
            }
        }
        for ph in in_path {
            if !params.iter().any(|p| p.loc == Loc::Path && p.name == ph) {
                return Err(ctx(format!("placeholder {{{ph}}} has no param")));
            }
        }
        if method == Method::Get && params.iter().any(|p| p.loc == Loc::Body) {
            return Err(ctx("GET with body params".into()));
        }
        tools.push(Tool {
            name: r.name.clone(),
            description: r.description.clone(),
            method,
            path: r.path.clone(),
            permission: r.permission.clone(),
            params,
        });
    }
    Ok(tools)
}

fn schema_for(p: &Param, nullable: bool) -> Value {
    let mut s = Map::new();
    let base = match p.ty.as_str() {
        "string[]" => {
            s.insert("items".into(), json!({ "type": "string" }));
            "array"
        }
        "object[]" => {
            s.insert("items".into(), json!({ "type": "object" }));
            "array"
        }
        other => other,
    };
    s.insert("type".into(), if nullable { json!([base, "null"]) } else { json!(base) });
    if !p.choices.is_empty() {
        let mut choices: Vec<Value> = p.choices.iter().map(|c| json!(c)).collect();
        if nullable {
            choices.push(Value::Null);
        }
        s.insert("enum".into(), Value::Array(choices));
    }
    if !p.description.is_empty() {
        s.insert("description".into(), json!(p.description));
    }
    Value::Object(s)
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// RFC 3986 unreserved characters pass through; everything else (including `/`) is escaped.
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn type_ok(p: &Param, v: &Value) -> bool {
    match p.ty.as_str() {
        "string" => v.as_str().is_some_and(|s| p.choices.is_empty() || p.choices.iter().any(|c| c == s)),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64(),
        "boolean" => v.is_boolean(),
        "object" => v.is_object(),
        "string[]" => v.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        "object[]" => v.as_array().is_some_and(|a| a.iter().all(Value::is_object)),
        _ => false,
    }
}

impl Tool {
    pub fn input_schema(&self) -> Value {
        let mut props = Map::new();
        let mut required = Vec::new();
        for p in &self.params {
            let nullable = self.method == Method::Patch && p.loc == Loc::Body && !p.required;
            props.insert(p.name.clone(), schema_for(p, nullable));
            if p.required {
                required.push(json!(p.name));
            }
        }
        json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
    }

    pub fn listing(&self) -> Value {
        let mut desc = self.description.clone();
        if self.method != Method::Get {
            desc.push_str(" [requires permission ");
            desc.push_str(&self.permission);
            desc.push(']');
        }
        json!({
            "name": self.name,
            "description": desc,
            "inputSchema": self.input_schema(),
            "annotations": {
                "readOnlyHint": self.method == Method::Get,
                "destructiveHint": self.method == Method::Delete,
                "openWorldHint": false,
            },
        })
    }

    /// Validates `args` against the tool's parameters and resolves them into an upstream request.
    pub fn build_call(&self, args: &Value) -> Result<Call, String> {
        let empty = Map::new();
        let args = match args {
            Value::Null => &empty,
            Value::Object(m) => m,
            _ => return Err("arguments must be an object".into()),
        };
        if let Some(unknown) = args.keys().find(|k| !self.params.iter().any(|p| &p.name == *k)) {
            return Err(format!("unknown argument '{unknown}'"));
        }
        let mut path = self.path.clone();
        let mut query = Vec::new();
        let mut body = Map::new();
        for p in &self.params {
            let value = args.get(&p.name);
            let Some(value) = value else {
                if p.required {
                    return Err(format!("missing required argument '{}'", p.name));
                }
                continue;
            };
            let clearing = value.is_null() && self.method == Method::Patch && p.loc == Loc::Body && !p.required;
            if !clearing && !type_ok(p, value) {
                let expected = if p.choices.is_empty() { p.ty.clone() } else { format!("one of {}", p.choices.join("|")) };
                return Err(format!("argument '{}' must be {expected}", p.name));
            }
            match p.loc {
                Loc::Path => {
                    let raw = scalar(value).filter(|s| !s.is_empty()).ok_or_else(|| format!("argument '{}' must not be empty", p.name))?;
                    path = path.replace(&format!("{{{}}}", p.name), &encode_segment(&raw));
                }
                Loc::Query => {
                    let joined = match value {
                        Value::Array(a) => a.iter().filter_map(scalar).collect::<Vec<_>>().join(","),
                        other => scalar(other).unwrap_or_default(),
                    };
                    query.push((p.name.clone(), joined));
                }
                Loc::Body => {
                    body.insert(p.name.clone(), value.clone());
                }
            }
        }
        let has_body_params = self.params.iter().any(|p| p.loc == Loc::Body);
        Ok(Call { method: self.method, path, query, body: has_body_params.then(|| Value::Object(body)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Tool {
        load().unwrap().into_iter().find(|t| t.name == name).unwrap()
    }

    #[test]
    fn embedded_catalog_is_valid() {
        let tools = load().unwrap();
        assert!(tools.len() > 80);
        for t in &tools {
            assert!(t.description.len() < 400, "{} description too long", t.name);
            // every schema must be serializable and object-typed
            assert_eq!(t.input_schema()["type"], "object");
        }
    }

    #[test]
    fn rejects_broken_catalogs() {
        let bad = |s: &str| assert!(parse(s).is_err(), "{s}");
        bad(r#"[{"name":"a","method":"GET","path":"/x/{id}","permission":"x:read","description":"d","params":{}}]"#);
        bad(r#"[{"name":"a","method":"GET","path":"/x","permission":"xread","description":"d","params":{}}]"#);
        bad(r#"[{"name":"a","method":"PUT","path":"/x","permission":"x:read","description":"d","params":{}}]"#);
        bad(r#"[{"name":"a","method":"GET","path":"/x","permission":"x:read","description":"d","params":{"q":"query date d"}}]"#);
        bad(
            r#"[{"name":"a","method":"GET","path":"/x","permission":"x:read","description":"d","params":{}},
                {"name":"a","method":"GET","path":"/y","permission":"x:read","description":"d","params":{}}]"#,
        );
    }

    #[test]
    fn builds_path_query_and_body() {
        let call = tool("update_issue").build_call(&json!({ "idOrKey": "BUG 1/2", "status": "done", "estimate": null })).unwrap();
        assert_eq!(call.method, Method::Patch);
        assert_eq!(call.path, "/issues/BUG%201%2F2");
        assert_eq!(call.body, Some(json!({ "status": "done", "estimate": null })));

        let call = tool("list_issues").build_call(&json!({ "kind": "bug", "q": "login" })).unwrap();
        assert_eq!(call.path, "/issues");
        assert_eq!(call.query, vec![("kind".into(), "bug".into()), ("q".into(), "login".into())]);
        assert!(call.body.is_none());
    }

    #[test]
    fn validates_arguments() {
        let t = tool("create_issue");
        assert!(t.build_call(&json!({ "title": "x" })).unwrap_err().contains("kind"));
        assert!(t.build_call(&json!({ "kind": "nope", "title": "x" })).unwrap_err().contains("one of"));
        assert!(t.build_call(&json!({ "kind": "bug", "title": "x", "wat": 1 })).unwrap_err().contains("unknown argument"));
        assert!(t.build_call(&json!({ "kind": "bug", "title": 5 })).unwrap_err().contains("title"));
        // null is only a "clear" on optional PATCH body fields
        assert!(t.build_call(&json!({ "kind": "bug", "title": "x", "body": null })).is_err());
        assert!(tool("get_issue").build_call(&json!({ "idOrKey": "" })).is_err());
    }

    #[test]
    fn encodes_colons_in_attention_ids() {
        let call = tool("dismiss_attention").build_call(&json!({ "id": "triage:tm_1" })).unwrap();
        assert_eq!(call.path, "/attention/triage%3Atm_1/dismiss");
    }

    #[test]
    fn nullable_only_on_optional_patch_fields() {
        let s = tool("update_issue").input_schema();
        assert_eq!(s["properties"]["status"]["type"], json!(["string", "null"]));
        assert_eq!(s["properties"]["idOrKey"]["type"], json!("string"));
        let s = tool("create_issue").input_schema();
        assert_eq!(s["properties"]["status"]["type"], json!("string"));
        assert!(s["required"].as_array().unwrap().contains(&json!("kind")));
    }
}
