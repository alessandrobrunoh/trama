//! The API permission a route needs, for `custom` API tokens. The port of
//! `server/src/auth/api-permissions.ts`.
//!
//! The permission is derived from the matched route pattern in its NestJS form
//! (`/api/w/:slug/tasks/:idOrKey`) and the HTTP method, so a new route is covered without a list
//! to maintain. A route outside the catalog yields `None`, and custom tokens are refused there:
//! new routes fail closed until their resource is in `API_RESOURCES`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use trama_contracts::roles::{ApiAction, ApiPermission, ApiResource, api_permissions};

static WORKSPACE_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/w/:slug(?:/([^/]+))?(.*)$").unwrap_or_else(|e| unreachable!("{e}"))
});
static NESTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/:[^/]+/([^/]+)").unwrap_or_else(|e| unreachable!("{e}")));
static UPLOAD_BYTES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/w/:slug/uploads(?:/|$)").unwrap_or_else(|e| unreachable!("{e}"))
});

/// `/w/:slug/<segment>` routes whose segment is not the resource name (`SEGMENT_RESOURCE`).
fn segment_resource(segment: &str) -> Option<ApiResource> {
    match segment {
        "settings" | "labels" | "statuses" => Some(ApiResource::Workspace),
        // importing from GitHub / Linear is an integration (admin); linking one task is a task edit
        "imports" => Some(ApiResource::Integrations),
        // decisions an agent recorded on tasks (`trama decisions`): read with the tasks they belong to
        "decisions" => Some(ApiResource::Tasks),
        _ => None,
    }
}

/// Sub-resources under another resource that carry their own permission (`NESTED_RESOURCE`):
/// `tasks/:id/artifacts` needs `artifacts:*`, not `tasks:*`.
fn nested_resource(segment: &str) -> Option<ApiResource> {
    (segment == "artifacts").then_some(ApiResource::Artifacts)
}

/// Nested segments that stay under their parent's permission (`PARENT_OWNED`, empty today). Any
/// other nested segment naming a catalog resource is refused for custom tokens until mapped.
const PARENT_OWNED: &[&str] = &[];

/// `POST …/<verb>` routes that need a more specific permission than a plain write
/// (`ACTION_OVERRIDES`).
fn action_override(target: ApiResource, last: &str) -> Option<ApiPermission> {
    match (target, last) {
        (ApiResource::Tasks, "bulk-delete") => {
            Some(ApiPermission::new(ApiResource::Tasks, ApiAction::Delete))
        }
        _ => None,
    }
}

fn action_for(method: &str) -> ApiAction {
    match method {
        "GET" | "HEAD" => ApiAction::Read,
        "DELETE" => ApiAction::Delete,
        _ => ApiAction::Write,
    }
}

/// `GET|POST|DELETE /w/:slug/uploads…`. File bytes are not their own permission: the uploads
/// service checks the parent record (and whether the token may write) itself.
#[must_use]
pub fn is_upload_bytes_route(route_path: &str) -> bool {
    UPLOAD_BYTES.is_match(route_path)
}

/// The permission a request needs, from the matched route pattern (NestJS form, e.g.
/// `/api/w/:slug/tasks/:idOrKey`) and the HTTP method. `None` means the route is outside the
/// permission catalog (not workspace-scoped, an unknown resource, or an action the resource does
/// not offer), and `custom` tokens are denied there.
#[must_use]
pub fn required_permission(method: &str, route_path: &str) -> Option<ApiPermission> {
    let caps = WORKSPACE_ROUTE.captures(route_path)?;
    let resource = match caps.get(1).map(|m| m.as_str()) {
        None => ApiResource::Workspace,
        Some(segment) => segment_resource(segment).or_else(|| ApiResource::parse(segment))?,
    };
    let rest = caps.get(2).map_or("", |m| m.as_str());
    let mut target = resource;
    if let Some(nested) = NESTED.captures(rest).and_then(|c| c.get(1)).map(|m| m.as_str()) {
        if let Some(own) = nested_resource(nested) {
            target = own;
        } else if ApiResource::parse(nested).is_some() && !PARENT_OWNED.contains(&nested) {
            return None;
        }
    }
    let last = route_path.rsplit('/').next().unwrap_or("");
    let overridden = if method == "POST" { action_override(target, last) } else { None };
    let permission = overridden.unwrap_or(ApiPermission::new(target, action_for(method)));
    target.meta().actions.contains(&permission.action).then_some(permission)
}

/// Drops unknown entries, de-duplicates, and makes every write, delete or accept imply `read`
/// (`normalizePermissions`). The result is in catalog order.
#[must_use]
pub fn normalize_permissions<S: AsRef<str>>(input: &[S]) -> Vec<ApiPermission> {
    let mut out = HashSet::new();
    for raw in input {
        let Some(permission) = ApiPermission::parse(raw.as_ref()) else { continue };
        out.insert(permission);
        out.insert(ApiPermission::new(permission.resource, ApiAction::Read));
    }
    api_permissions().into_iter().filter(|p| out.contains(p)).collect()
}

/// An axum route path (`/w/{slug}/tasks/{idOrKey}`, `/files/{*rest}`) in the NestJS form the
/// rules above read (`/w/:slug/tasks/:idOrKey`, `/files/*rest`).
#[must_use]
pub fn nest_pattern(axum_path: &str) -> String {
    let mut out = String::with_capacity(axum_path.len());
    let mut chars = axum_path.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '{' {
            out.push(c);
            continue;
        }
        let mut name = String::new();
        for n in chars.by_ref() {
            if n == '}' {
                break;
            }
            name.push(n);
        }
        if let Some(rest) = name.strip_prefix('*') {
            out.push('*');
            out.push_str(rest);
        } else {
            out.push(':');
            out.push_str(&name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perm(method: &str, route: &str) -> Option<String> {
        required_permission(method, route).map(|p| p.to_string())
    }

    #[test]
    fn maps_method_and_resource() {
        assert_eq!(perm("GET", "/api/w/:slug/tasks").as_deref(), Some("tasks:read"));
        assert_eq!(perm("POST", "/api/w/:slug/tasks").as_deref(), Some("tasks:write"));
        assert_eq!(perm("PATCH", "/api/w/:slug/tasks/:idOrKey").as_deref(), Some("tasks:write"));
        assert_eq!(perm("DELETE", "/api/w/:slug/tasks/:idOrKey").as_deref(), Some("tasks:delete"));
        assert_eq!(perm("POST", "/api/w/:slug/tasks/bulk").as_deref(), Some("tasks:write"));
        assert_eq!(perm("POST", "/api/w/:slug/tasks/bulk-delete").as_deref(), Some("tasks:delete"));
        assert_eq!(perm("GET", "/api/w/:slug/workstreams/:idOrKey/graph"), None);
        assert_eq!(perm("POST", "/api/w/:slug/workstreams/:idOrKey/criteria"), None);
        assert_eq!(
            perm("GET", "/api/w/:slug/outgoing-webhooks/:id/deliveries").as_deref(),
            Some("outgoing-webhooks:read")
        );
        assert_eq!(perm("POST", "/api/w/:slug/releases"), None);
    }

    #[test]
    fn keeps_the_insights_routes_read_only() {
        assert_eq!(perm("GET", "/api/w/:slug/insights").as_deref(), Some("insights:read"));
        assert_eq!(
            perm("GET", "/api/w/:slug/insights/signals/:id").as_deref(),
            Some("insights:read")
        );
    }

    #[test]
    fn maps_the_workspace_itself_and_its_settings() {
        assert_eq!(perm("GET", "/api/w/:slug").as_deref(), Some("workspace:read"));
        assert_eq!(perm("PATCH", "/api/w/:slug").as_deref(), Some("workspace:write"));
        assert_eq!(perm("PATCH", "/api/w/:slug/settings").as_deref(), Some("workspace:write"));
        assert_eq!(perm("DELETE", "/api/w/:slug").as_deref(), Some("workspace:delete"));
    }

    #[test]
    fn maps_imports_to_integrations_and_task_external_links_to_tasks() {
        let table = [
            ("GET", "/api/w/:slug/imports", "integrations:read"),
            ("GET", "/api/w/:slug/imports/credentials", "integrations:read"),
            ("POST", "/api/w/:slug/imports/preview", "integrations:write"),
            ("POST", "/api/w/:slug/imports", "integrations:write"),
            ("POST", "/api/w/:slug/imports/:id/cancel", "integrations:write"),
            ("DELETE", "/api/w/:slug/imports/credentials/:id", "integrations:delete"),
            ("POST", "/api/w/:slug/tasks/:idOrKey/external-ref", "tasks:write"),
            ("POST", "/api/w/:slug/tasks/:idOrKey/external-ref/refresh", "tasks:write"),
            ("DELETE", "/api/w/:slug/tasks/:idOrKey/external-ref", "tasks:delete"),
        ];
        for (method, route, expected) in table {
            assert_eq!(perm(method, route).as_deref(), Some(expected), "{method} {route}");
        }
    }

    #[test]
    fn maps_the_thread_record_routes_to_the_task_permissions() {
        let table = [
            ("POST", "/api/w/:slug/tasks/:idOrKey/thread/sync", "tasks:write"),
            ("GET", "/api/w/:slug/tasks/:idOrKey/thread", "tasks:read"),
            ("GET", "/api/w/:slug/tasks/:idOrKey/estimate-suggestion", "tasks:read"),
            ("GET", "/api/w/:slug/decisions", "tasks:read"),
        ];
        for (method, route, expected) in table {
            assert_eq!(perm(method, route).as_deref(), Some(expected), "{method} {route}");
        }
    }

    #[test]
    fn maps_nested_artifact_routes_to_artifacts() {
        let table = [
            ("GET", "/api/w/:slug/tasks/:idOrKey/artifacts", "artifacts:read"),
            ("POST", "/api/w/:slug/tasks/:idOrKey/artifacts", "artifacts:write"),
            ("GET", "/api/w/:slug/artifacts/:id", "artifacts:read"),
            ("DELETE", "/api/w/:slug/artifacts/:id", "artifacts:delete"),
            ("POST", "/api/w/:slug/tasks/:idOrKey/artifacts/upload", "artifacts:write"),
        ];
        for (method, route, expected) in table {
            assert_eq!(perm(method, route).as_deref(), Some(expected), "{method} {route}");
        }
        assert_eq!(perm("GET", "/api/w/:slug/uploads/:id"), None);
        assert!(is_upload_bytes_route("/api/w/:slug/uploads/:id"));
        assert!(is_upload_bytes_route("/api/w/:slug/uploads"));
        assert!(!is_upload_bytes_route("/api/w/:slug/tasks/:idOrKey/artifacts/upload"));
    }

    #[test]
    fn no_longer_knows_the_removed_documents_resource() {
        assert_eq!(perm("GET", "/api/w/:slug/documents"), None);
        assert!(normalize_permissions(&["documents:write"]).is_empty());
    }

    #[test]
    fn keeps_the_other_nested_routes_under_their_parent() {
        assert_eq!(
            perm("POST", "/api/w/:slug/tasks/:idOrKey/link").as_deref(),
            Some("tasks:write")
        );
    }

    #[test]
    fn fails_closed_on_an_unmapped_nested_catalog_resource() {
        assert_eq!(perm("GET", "/api/w/:slug/tasks/:idOrKey/comments"), None);
        assert_eq!(perm("POST", "/api/w/:slug/workstreams/:idOrKey/issues"), None);
        assert_eq!(perm("DELETE", "/api/w/:slug/projects/:id/tokens/:tokenId"), None);
    }

    #[test]
    fn fails_closed_outside_the_catalog() {
        for (method, route) in [
            ("GET", "/api/workspaces"),
            ("GET", "/api/auth/me"),
            ("POST", "/api/invites/:token/accept"),
            ("PATCH", "/api/me/notification-settings"),
            ("PUT", "/api/me/push/subscription"),
            ("POST", "/api/w/:slug/ai/chat"),
            ("GET", "/api/w/:slug/something-new"),
            // actions a resource does not offer
            ("POST", "/api/w/:slug/search"),
            ("DELETE", "/api/w/:slug/attention/:id"),
        ] {
            assert_eq!(perm(method, route), None, "{method} {route}");
        }
    }

    #[test]
    fn normalizes_permission_lists() {
        let out = normalize_permissions(&[
            "tasks:write",
            "tasks:write",
            "bogus:read",
            "tasks:fly",
            "teams:read",
            "issues:read",
        ]);
        assert_eq!(
            out.iter().map(ToString::to_string).collect::<Vec<_>>(),
            ["tasks:read", "tasks:write"]
        );
    }

    #[test]
    fn translates_axum_paths() {
        assert_eq!(nest_pattern("/api/w/{slug}/tasks/{idOrKey}"), "/api/w/:slug/tasks/:idOrKey");
        assert_eq!(nest_pattern("/files/{*rest}"), "/files/*rest");
        assert_eq!(nest_pattern("/auth/me"), "/auth/me");
    }

    /// The MCP server declares a permission per tool; it must be the one the API derives.
    #[test]
    fn mcp_tool_catalog_declares_the_derived_permission() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../mcp/src/tools.json"
        ))
        .expect("mcp/src/tools.json");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert!(tools.len() > 50);
        let removed = Regex::new(
            r"^/(teams|customers|customer-|releases|input-requests|repositories|intake)",
        )
        .unwrap();
        let param = Regex::new(r"\{(\w+)\}").unwrap();
        for tool in &tools {
            let path = tool["path"].as_str().unwrap();
            if removed.is_match(path) {
                continue;
            }
            let path =
                path.strip_prefix("/issues").map_or(path.to_owned(), |r| format!("/tasks{r}"));
            let route = format!("/api/w/:slug{}", param.replace_all(&path, ":$1"));
            let permission = tool["permission"].as_str().unwrap();
            let permission = permission
                .strip_prefix("issues:")
                .map_or(permission.to_owned(), |r| format!("tasks:{r}"));
            let method = tool["method"].as_str().unwrap();
            assert_eq!(
                perm(method, &route).as_deref(),
                Some(permission.as_str()),
                "{} ({method} {path})",
                tool["name"]
            );
        }
    }
}
