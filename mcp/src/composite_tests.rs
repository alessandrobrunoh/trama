//! Tests of the composite tools, end to end through the protocol layer against a mock Trama API.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::catalog;
use crate::upstream::Whoami;

#[derive(Clone, Debug)]
struct Req {
    method: String,
    /// Path under `/w/<slug>`, without the query.
    path: String,
    query: String,
    body: Value,
}

impl Req {
    fn is(&self, method: &str, path: &str) -> bool {
        self.method == method && self.path == path
    }
}

/// A throwaway HTTP server standing in for the Trama API.
struct Mock {
    base: String,
    log: Arc<Mutex<Vec<Req>>>,
}

impl Mock {
    fn spawn(handler: impl Fn(&Req) -> (u16, String) + Send + Sync + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, content_length) = loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break (0, 0);
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse().ok())
                            .unwrap_or(0usize);
                        break (pos + 4, len);
                    }
                };
                if head_end == 0 {
                    continue;
                }
                while buf.len() < head_end + content_length {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut parts = head.lines().next().unwrap_or("").split(' ');
                let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let (full_path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
                let path = full_path
                    .strip_prefix("/w/")
                    .and_then(|r| r.split_once('/'))
                    .map_or(String::new(), |(_, rest)| format!("/{rest}"));
                let body = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                let req = Req { method, path, query: query.to_string(), body };
                seen.lock().unwrap().push(req.clone());
                let (status, reply) = handler(&req);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        Mock { base, log }
    }

    fn calls(&self) -> Vec<Req> {
        self.log.lock().unwrap().clone()
    }

    fn writes(&self) -> Vec<Req> {
        self.calls().into_iter().filter(|r| r.method != "GET").collect()
    }
}

fn all_permissions() -> Vec<String> {
    let mut p: Vec<String> = catalog::load().unwrap().into_iter().map(|t| t.permission).collect();
    p.sort();
    p.dedup();
    p
}

fn account(slug: &str, permissions: &[String]) -> Account {
    Account {
        key: "nbl_test".into(),
        profile: String::new(),
        who: Whoami {
            slug: slug.into(),
            workspace_name: slug.into(),
            permissions: permissions.iter().cloned().collect(),
            raw: json!({ "workspace": { "slug": slug }, "actor": { "type": "user", "id": "usr_me" }, "permissions": permissions }),
        },
    }
}

fn server(mock: &Mock) -> crate::protocol::Server {
    crate::protocol::Server::new(Upstream::new(&mock.base, Duration::from_secs(5), 100_000).unwrap()).unwrap()
}

/// `tools/call` through the whole stack: (isError, text).
async fn call(server: &crate::protocol::Server, accounts: &[Account], name: &str, args: Value) -> (bool, String) {
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let r = server.handle(accounts, msg).await.unwrap();
    assert!(r.get("error").is_none(), "{r}");
    (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
}

fn j(v: Value) -> (u16, String) {
    (200, v.to_string())
}

fn not_found() -> (u16, String) {
    (404, json!({ "statusCode": 404, "message": "not found" }).to_string())
}

#[tokio::test]
async fn task_context_uses_task_routes() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1", "title": "Login", "status": "todo" })),
        ("GET", "/tasks/BUG-1/context") => j(json!({ "id": "in_1", "key": "BUG-1", "title": "Login" })),
        ("GET", "/tasks/BUG-1/artifacts") => j(json!([])),
        _ => not_found(),
    });
    let s = server(&mock);
    let a = all();
    let (err, context) = call(&s, &a, "get_context", json!({ "id": "BUG-1" })).await;
    assert!(!err, "{context}");
    assert!(mock.calls().iter().any(|r| r.is("GET", "/tasks/BUG-1/context")));
    assert!(parsed(&context)["type"] == "issue");
}

#[tokio::test]
async fn find_work_lists_tasks_without_a_team_filter() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks") => j(json!([{ "id": "in_1", "key": "BUG-1", "title": "Login", "status": "todo" }])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "find_work", json!({ "projectId": "prj_1", "q": "login" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["tasks"][0]["key"], "BUG-1");
    let call = &mock.calls()[0];
    assert_eq!(call.path, "/tasks");
    assert!(call.query.contains("projectId=prj_1"), "{}", call.query);
    assert!(!call.query.contains("teamId"));
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| panic!("not json: {text}"))
}

fn all() -> [Account; 1] {
    [account("acme", &all_permissions())]
}

// ── validation and references ──

#[test]
fn references_are_classified_by_id_prefix_and_key_shape() {
    assert_eq!(candidates("BUG-142", None), vec![Kind::Issue]);
    assert_eq!(candidates("fb-3", None), vec![Kind::Issue]);
    assert_eq!(candidates("AUTH-42", None), vec![Kind::Issue]);
    assert_eq!(candidates("A1C-42", None), vec![Kind::Issue]);
    assert!(candidates("1ABC-42", None).is_empty());
    assert!(candidates("wk_abc", None).is_empty());
    assert_eq!(candidates("in_abc", None), vec![Kind::Issue]);
    assert_eq!(candidates("pj_abc", None), vec![Kind::Project]);
    assert!(candidates("something", None).is_empty());
    assert_eq!(candidates("AUTH-42", Some(Kind::Issue)), vec![Kind::Issue]);
}

// ── get_context ──

#[tokio::test]
async fn get_context_reports_a_missing_thing_clearly() {
    let mock = Mock::spawn(|_| not_found());
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-999" })).await;
    assert!(err);
    assert!(text.contains("no task 'BUG-999'"), "{text}");
}

// ── report_progress ──

// ── attach_artifact ──

#[tokio::test]
async fn attach_artifact_creates_on_the_issue_when_none_matches() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1" })),
        ("GET", "/tasks/in_1/artifacts") => j(json!([])),
        ("POST", "/artifacts") => j(json!({ "id": "ar_2", "kind": "link", "title": "Spec" })),
        _ => not_found(),
    });
    let args = json!({ "issue": "BUG-1", "kind": "link", "title": "Spec", "url": "https://x.test/spec", "description": "Design notes" });
    let (err, text) = call(&server(&mock), &all(), "attach_artifact", args).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["action"], "created");
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "issueId": "in_1", "kind": "link", "title": "Spec", "url": "https://x.test/spec", "description": "Design notes" }));
}

#[tokio::test]
async fn report_progress_updates_issue_status_attaches_artifact_and_comments() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1" })),
        ("GET", "/tasks/in_1/artifacts") => j(json!([])),
        ("POST", "/artifacts") => j(json!({ "id": "ar_1", "kind": "pull_request", "title": "Fix", "state": "open" })),
        ("PATCH", "/tasks/in_1") => j(json!({})),
        ("POST", "/comments") => j(json!({ "id": "cm_1" })),
        _ => not_found(),
    });
    let args = json!({
        "issue": "BUG-1",
        "issueStatus": "in_progress",
        "artifact": { "kind": "pull_request", "title": "Fix", "url": "https://example.test/pr/1" },
        "comment": "Implementation is underway."
    });
    let (err, text) = call(&server(&mock), &all(), "report_progress", args).await;
    assert!(!err, "{text}");
    assert_eq!(
        parsed(&text)["applied"],
        json!(["artifact created", "task status in_progress", "comment added"])
    );
    let writes = mock.writes();
    assert_eq!(writes.len(), 3);
    assert_eq!(writes[0].body["issueId"], "in_1");
    assert_eq!(writes[1].body, json!({ "status": "in_progress" }));
    assert_eq!(writes[2].body["subject"], json!({ "type": "issue", "id": "in_1" }));
}

// ── create_task ──

#[tokio::test]
async fn create_task_blocks_exact_duplicates_unless_forced() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/search") => j(json!({ "results": [{ "type": "issue", "id": "in_1", "key": "BUG-1", "title": "Login times out", "subtitle": "bug · backlog" }] })),
        ("POST", "/tasks") => j(json!({
            "id": "in_2",
            "key": "BUG-2",
            "title": "Login times out",
            "kind": "bug",
            "status": "backlog",
            "parentId": "in_parent"
        })),
        _ => not_found(),
    });
    let s = server(&mock);
    let a = all();
    let (err, text) = call(&s, &a, "create_task", json!({ "kind": "bug", "title": "login times out" })).await;
    assert!(!err);
    let v = parsed(&text);
    assert_eq!(v["created"], false);
    assert_eq!(v["existing"]["key"], "BUG-1");
    assert!(mock.writes().is_empty());

    let (err, text) = call(
        &s,
        &a,
        "create_task",
        json!({
            "kind": "bug",
            "title": "login times out",
            "parentId": "in_parent",
            "force": true
        }),
    )
    .await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["created"], true);
    assert_eq!(v["similarOpenTasks"][0]["key"], "BUG-1");
    assert_eq!(v["task"]["parentId"], "in_parent");
    let w = mock.writes();
    assert_eq!(
        w[0].body,
        json!({
            "title": "login times out",
            "kind": "bug",
            "parentId": "in_parent",
            "source": "agent"
        }),
        "source defaults to agent and force is not sent"
    );
}

// ── start_work ──

#[tokio::test]
async fn start_work_updates_the_issue_and_returns_its_context() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1", "title": "t", "status": "backlog" })),
        ("PATCH", "/tasks/in_1") => j(json!({})),
        ("POST", "/comments") => j(json!({ "id": "cm_1" })),
        ("GET", "/tasks/in_1/context") => j(json!({ "summary": "Ship login" })),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "start_work", json!({ "key": "BUG-1", "plan": "Fixing the timeout." })).await;
    assert!(!err, "{text}");
    let value = parsed(&text);
    assert_eq!(value["ready"], true);
    assert_eq!(value["briefing"]["summary"], "Ship login");
    assert_eq!(value["task"]["key"], "BUG-1");
    let writes = mock.writes();
    assert_eq!(writes.len(), 2);
    assert!(writes[0].is("PATCH", "/tasks/in_1"));
    assert_eq!(writes[0].body, json!({ "status": "in_progress" }));
    assert_eq!(writes[1].body["subject"], json!({ "type": "issue", "id": "in_1" }));
}

// ── triage_issues, add_comment, find_work ──

#[tokio::test]
async fn add_comment_resolves_keys_to_the_ids_the_api_wants() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-142") => j(json!({ "id": "in_142", "key": "BUG-142" })),
        ("POST", "/comments") => j(json!({ "id": "cm_1" })),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "add_comment", json!({ "on": "BUG-142", "body": "Reproduced." })).await;
    assert!(!err, "{text}");
    assert_eq!(mock.writes()[0].body, json!({ "subject": { "type": "issue", "id": "in_142" }, "body": "Reproduced." }));
}

// ── permissions stay in charge ──

#[tokio::test]
async fn composites_are_hidden_and_refused_without_their_permissions() {
    let mock = Mock::spawn(|_| not_found());
    let s = server(&mock);
    let read_only: Vec<String> = all_permissions().into_iter().filter(|p| p.ends_with(":read")).collect();
    let a = [account("acme", &read_only)];
    let listed: Vec<String> = s.list_tools(&a).iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert!(listed.contains(&"get_context".to_string()) && listed.contains(&"find_work".to_string()));
    for read in ["find_decisions", "suggest_estimate"] {
        assert!(listed.contains(&read.to_string()), "{read} only reads, so a read-only key lists it");
    }
    for hidden in ["create_task", "report_progress", "attach_artifact", "add_comment", "triage_tasks", "update_task", "link_thread", "sync_thread"] {
        assert!(!listed.contains(&hidden.to_string()), "{hidden} must be hidden for a read-only key");
    }
    let (err, text) = call(&s, &a, "create_task", json!({ "kind": "bug", "title": "q" })).await;
    assert!(err, "calling a hidden tool by name is still refused");
    assert!(text.contains("tasks:write"), "{text}");
    assert!(mock.calls().is_empty(), "refused before any API call");
}

// ── discovery: list_capabilities + run_tool ──

#[tokio::test]
async fn list_capabilities_reveals_the_long_tail_with_schemas() {
    let mock = Mock::spawn(|_| not_found());
    let s = server(&mock);
    let a = all();

    let (err, text) = call(&s, &a, "list_capabilities", json!({})).await;
    assert!(!err);
    let v = parsed(&text);
    assert_eq!(v["tools"].as_u64().unwrap() as usize, catalog::load().unwrap().len());
    assert!(v["groups"]["milestones"].as_u64().unwrap() >= 5);
    assert!(v["listedDirectly"].as_array().unwrap().iter().any(|t| t["name"] == "run_tool"));

    let (_, text) = call(&s, &a, "list_capabilities", json!({ "q": "milestone reorder" })).await;
    let v = parsed(&text);
    assert_eq!(v["tools"][0]["name"], "reorder_milestones");

    let (_, text) = call(&s, &a, "list_capabilities", json!({ "group": "tasks" })).await;
    let names: Vec<String> = parsed(&text)["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"create_task".to_string()));
    assert!(!names.iter().any(|n| n.contains("team") || n.contains("customer")));

    let (_, text) = call(&s, &a, "list_capabilities", json!({ "tool": "create_milestone" })).await;
    let v = parsed(&text);
    assert_eq!(v["permission"], "milestones:write");
    assert_eq!(v["inputSchema"]["required"].as_array().unwrap().len(), 2);
    assert_eq!(v["call"]["arguments"]["arguments"]["projectId"], "…");
    assert_eq!(v["call"]["tool"], "run_tool");
    assert_eq!(v["call"]["arguments"]["name"], "create_milestone");

    let (err, text) = call(&s, &a, "list_capabilities", json!({ "tool": "nope" })).await;
    assert!(err && text.contains("Unknown tool"));
    assert!(mock.calls().is_empty(), "discovery is local");
}

#[tokio::test]
async fn list_capabilities_only_offers_what_the_key_may_use() {
    let mock = Mock::spawn(|_| not_found());
    let perms = vec!["milestones:read".to_string()];
    let (_, text) = call(&server(&mock), &[account("acme", &perms)], "list_capabilities", json!({ "q": "milestone" })).await;
    let names: Vec<String> = parsed(&text)["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"list_milestones".to_string()) && !names.contains(&"create_milestone".to_string()), "{names:?}");
    let (_, text) = call(&server(&mock), &[account("acme", &perms)], "list_capabilities", json!({ "q": "milestone", "all": true })).await;
    assert!(text.contains("create_milestone") && text.contains("\"available\":false"));
}

#[tokio::test]
async fn run_tool_runs_a_catalog_tool_by_name_with_the_usual_checks() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/milestones") => j(json!([{ "id": "ms_1" }])),
        ("POST", "/milestones") => j(json!({ "id": "ms_2" })),
        _ => not_found(),
    });
    let s = server(&mock);
    let a = all();
    let (err, text) = call(&s, &a, "run_tool", json!({ "name": "list_milestones", "arguments": { "projectId": "pj_1" } })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text), json!([{ "id": "ms_1" }]));
    assert_eq!(mock.calls()[0].query, "projectId=pj_1");

    let (err, _) = call(&s, &a, "run_tool", json!({ "name": "create_milestone", "arguments": { "projectId": "pj_1", "name": "Beta" } })).await;
    assert!(!err);
    assert_eq!(mock.writes()[0].body, json!({ "projectId": "pj_1", "name": "Beta" }));

    // argument validation is the catalog's
    let (err, text) = call(&s, &a, "run_tool", json!({ "name": "create_milestone", "arguments": { "name": "Beta" } })).await;
    assert!(err && text.contains("projectId"), "{text}");
    // unknown names, composites and itself are not runnable through it
    for name in ["nope", "run_tool", "api_request", "start_work"] {
        let (err, text) = call(&s, &a, "run_tool", json!({ "name": name })).await;
        assert!(err, "{name}: {text}");
    }
    // permissions
    let ro = [account("acme", &["milestones:read".to_string()])];
    let (err, text) = call(&s, &ro, "run_tool", json!({ "name": "create_milestone", "arguments": { "projectId": "p", "name": "n" } })).await;
    assert!(err && text.contains("milestones:write"), "{text}");
}

#[tokio::test]
async fn run_tool_on_several_workspaces_follows_the_read_write_rule() {
    let mock = Mock::spawn(|_| j(json!([])));
    let both = [account("acme", &all_permissions()), account("beta", &all_permissions())];
    let (err, text) = call(&server(&mock), &both, "run_tool", json!({ "name": "create_milestone", "arguments": { "projectId": "p", "name": "n" } })).await;
    assert!(err && text.contains("exactly one workspace"), "{text}");
    let (err, _) = call(&server(&mock), &both, "run_tool", json!({ "name": "list_milestones", "arguments": { "projectId": "pj_1" } })).await;
    assert!(!err);
}

// ── the long tail is still callable by name ──

#[tokio::test]
async fn tools_the_core_profile_does_not_list_still_answer_by_name() {
    let mock = Mock::spawn(|r| if r.is("GET", "/views") { j(json!([{ "id": "vw_1" }])) } else { not_found() });
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "list_views", json!({})).await;
    assert!(!err, "{text}");
    assert!(!s.list_tools(&all()).iter().any(|t| t["name"] == "list_views"));
}

// ── the task and project fields the API has today ──

#[test]
fn schemas_cover_the_task_fields_and_no_longer_mention_project_health() {
    let cat = catalog::load().unwrap();
    let has = |tool: &str, p: &str| cat.iter().find(|t| t.name == tool).unwrap().params.iter().any(|x| x.name == p);
    for tool in ["create_task", "update_task"] {
        for p in ["parentId", "estimate", "threadUrl"] {
            assert!(has(tool, p), "{tool} lacks {p}");
        }
    }
    assert!(has("update_task", "milestoneIds"));
    assert!(has("create_project", "key") && has("update_project", "key"));
    assert!(!has("list_projects", "repository"), "the API does not filter by it; the tool does");
    for t in cat.iter().filter(|t| t.name.ends_with("_project") || t.name == "list_projects") {
        assert!(!t.params.iter().any(|p| p.name == "health"), "{} still has health", t.name);
        let listing = t.listing().to_string();
        assert!(!listing.contains("on_track") && !listing.contains("at_risk"), "{} still mentions health", t.name);
    }
    for e in crate::profile::load(&cat).unwrap() {
        let listing = e.listing(&cat).to_string();
        assert!(!listing.contains("on_track") && !listing.contains("off_track"), "{} still mentions project health", e.name);
        if e.name == "create_task" {
            for p in ["parentId", "estimate", "threadUrl"] {
                assert!(listing.contains(p), "create_task lacks {p}");
            }
        }
    }
}

// ── subtasks ──

fn family() -> Value {
    json!([
        { "id": "in_3", "key": "BUG-3", "title": "Grandchild", "status": "todo", "parentId": "in_2", "createdAt": "2026-01-03T00:00:00.000Z" },
        { "id": "in_2", "key": "BUG-2", "title": "Child", "status": "in_progress", "parentId": "in_1", "estimate": 2, "createdAt": "2026-01-02T00:00:00.000Z" },
        { "id": "in_1", "key": "BUG-1", "title": "Parent", "status": "todo", "createdAt": "2026-01-01T00:00:00.000Z" },
        { "id": "in_9", "key": "BUG-9", "title": "Other", "status": "todo", "createdAt": "2026-01-09T00:00:00.000Z" }
    ])
}

#[tokio::test]
async fn get_context_returns_the_subtask_tree_of_any_depth() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1/context") => j(json!({ "issue": { "id": "in_1", "key": "BUG-1", "threadUrl": "https://delta.example/t/1" } })),
        ("GET", "/tasks/BUG-1/artifacts") => j(json!([])),
        ("GET", "/tasks") => j(family()),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-1", "subtasks": true })).await;
    assert!(!err, "{text}");
    let out = parsed(&text);
    assert_eq!(out["issue"]["issue"]["threadUrl"], "https://delta.example/t/1");
    assert_eq!(out["subtaskCount"], 2);
    assert_eq!(out["subtasks"][0]["key"], "BUG-2");
    assert_eq!(out["subtasks"][0]["estimate"], 2);
    assert_eq!(out["subtasks"][0]["subtasks"][0]["key"], "BUG-3");
    let list = mock.calls().into_iter().find(|r| r.is("GET", "/tasks")).unwrap();
    assert!(list.query.contains("limit=500"), "{}", list.query);

    let (_, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-1", "subtasks": true, "depth": 1 })).await;
    let out = parsed(&text);
    assert_eq!(out["subtaskCount"], 1);
    assert!(out["subtasks"][0].get("subtasks").is_none());

    let (_, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-1" })).await;
    assert!(parsed(&text).get("subtasks").is_none(), "off unless asked for");
}

#[tokio::test]
async fn find_work_filters_by_parent() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1" })),
        ("GET", "/tasks") => j(family()),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "find_work", json!({ "parentId": "BUG-1" })).await;
    assert!(!err, "{text}");
    let tasks = parsed(&text)["tasks"].as_array().unwrap().clone();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["key"], "BUG-2");
    assert_eq!(tasks[0]["estimate"], 2);
    assert!(!mock.calls().iter().any(|r| r.query.contains("parentId")), "the API has no parent filter");
}

// ── projects ──

#[tokio::test]
async fn list_projects_matches_the_repository_here_and_never_sends_it_or_health() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/projects") => j(json!([
            { "id": "pj_1", "key": "CORA", "name": "Cora", "status": "in_progress", "health": "at_risk", "repository": "https://github.com/Acme/Cora.git" },
            { "id": "pj_2", "key": "OTH", "name": "Other", "status": "backlog", "repository": "acme/other" }
        ])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "list_projects", json!({ "repository": "acme/cora" })).await;
    assert!(!err, "{text}");
    let out = parsed(&text);
    assert_eq!(out["projects"].as_array().unwrap().len(), 1);
    assert_eq!(out["projects"][0]["key"], "CORA");
    assert!(out["projects"][0].get("health").is_none());
    assert!(!mock.calls()[0].query.contains("repository"), "{}", mock.calls()[0].query);
    let (_, text) = call(&server(&mock), &all(), "list_projects", json!({})).await;
    assert_eq!(parsed(&text)["projects"].as_array().unwrap().len(), 2);
}

// ── the timer ──

fn timer_mock() -> Mock {
    Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1") | ("GET", "/tasks/in_1") => j(json!({ "id": "in_1", "key": "BUG-1", "title": "Login", "status": "todo" })),
        ("GET", "/time-entries") => j(json!([
            { "id": "te_2", "issueId": "in_1", "startedAt": "2026-05-01T10:00:00.000Z", "endedAt": null },
            { "id": "te_1", "issueId": "in_1", "startedAt": "2026-05-01T08:00:00.000Z", "endedAt": "2026-05-01T09:30:00.000Z" },
            { "id": "te_0", "issueId": "in_7", "startedAt": "2026-04-30T08:00:00.000Z", "endedAt": "2026-04-30T08:10:00.000Z" }
        ])),
        ("POST", "/time-entries/start") => j(json!({ "id": "te_3", "issueId": "in_1", "startedAt": "2026-05-01T11:00:00.000Z", "endedAt": null })),
        ("POST", "/time-entries/stop") => j(json!({ "id": "te_2", "issueId": "in_1", "startedAt": "2026-05-01T10:00:00.000Z", "endedAt": "2026-05-01T10:20:00.000Z" })),
        ("POST", "/time-entries") => (201, json!({ "id": "te_4", "startedAt": "2026-05-01T09:00:00.000Z", "endedAt": "2026-05-01T10:00:00.000Z" }).to_string()),
        ("DELETE", "/time-entries/te_1") => (204, String::new()),
        _ => not_found(),
    })
}

#[tokio::test]
async fn track_time_starts_on_a_task_key_with_its_id_and_reports_the_stopped_timer() {
    let mock = timer_mock();
    let (err, text) = call(&server(&mock), &all(), "track_time", json!({ "action": "start", "task": "BUG-1", "description": "login" })).await;
    assert!(!err, "{text}");
    let out = parsed(&text);
    assert_eq!(out["started"], true);
    assert_eq!(out["entry"]["running"], true);
    assert_eq!(out["stopped"]["id"], "te_2", "the timer that was running");
    let start = mock.calls().into_iter().find(|r| r.is("POST", "/time-entries/start")).unwrap();
    assert_eq!(start.body, json!({ "issueId": "in_1", "description": "login" }), "the API wants the id, not the key");
}

#[tokio::test]
async fn track_time_stops_shows_lists_adds_and_deletes() {
    let mock = timer_mock();
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "track_time", json!({ "action": "stop" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["entry"]["durationSeconds"], 1200);

    let (_, text) = call(&s, &all(), "track_time", json!({ "action": "status" })).await;
    let out = parsed(&text);
    assert_eq!(out["running"]["id"], "te_2");
    assert_eq!(out["task"]["key"], "BUG-1");

    let (_, text) = call(&s, &all(), "track_time", json!({ "action": "list", "task": "in_1" })).await;
    let out = parsed(&text);
    assert_eq!(out["entries"].as_array().unwrap().len(), 2, "only the entries of that task");
    assert_eq!(out["totalSeconds"], 5400);

    let (err, text) = call(&s, &all(), "track_time", json!({ "action": "add", "task": "in_1", "startedAt": "2026-05-01T09:00:00Z", "endedAt": "2026-05-01T10:00:00Z" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["added"], true);
    let add = mock.calls().into_iter().find(|r| r.is("POST", "/time-entries")).unwrap();
    assert_eq!(add.body["issueId"], "in_1");

    let (err, text) = call(&s, &all(), "track_time", json!({ "action": "delete", "entryId": "te_1" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["deleted"], "te_1");
}

#[tokio::test]
async fn track_time_validates_before_calling_and_needs_a_user_key() {
    let mock = timer_mock();
    let s = server(&mock);
    for args in [
        json!({ "action": "add", "task": "in_1", "startedAt": "2026-05-01T10:00:00Z", "endedAt": "2026-05-01T09:00:00Z" }),
        json!({ "action": "add", "task": "in_1", "startedAt": "2026-05-01 10:00", "endedAt": "2026-05-01T11:00:00Z" }),
        json!({ "action": "add", "task": "in_1", "startedAt": "2026-05-01T10:00:00Z" }),
        json!({ "action": "delete" }),
        json!({ "action": "start", "description": "x".repeat(501) }),
        json!({ "action": "fly" }),
    ] {
        let (err, text) = call(&s, &all(), "track_time", args.clone()).await;
        assert!(err, "{args}: {text}");
    }
    assert!(mock.writes().is_empty(), "nothing reached the API");

    let mut agent = account("acme", &all_permissions());
    agent.who.raw = json!({ "workspace": { "slug": "acme" }, "actor": { "type": "agent", "id": "ag_1" } });
    let (err, text) = call(&s, &[agent], "track_time", json!({ "action": "stop" })).await;
    assert!(err && text.contains("does not act as a user"), "{text}");

    let read_only: Vec<String> = all_permissions().into_iter().filter(|p| p.ends_with(":read")).collect();
    let (err, text) = call(&s, &[account("acme", &read_only)], "track_time", json!({ "action": "stop" })).await;
    assert!(err && text.contains("tasks:write"), "{text}");
}

// ── thread records ──

const THREAD: &str = "https://delta.example/t/th_1";

#[tokio::test]
async fn link_thread_links_a_task_that_has_no_thread_and_is_idempotent() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/TRM-1") => j(json!({ "id": "in_1", "key": "TRM-1", "title": "t", "status": "todo" })),
        ("GET", "/tasks/TRM-2") => j(json!({ "id": "in_2", "key": "TRM-2", "title": "t", "status": "todo", "threadUrl": THREAD })),
        ("PATCH", "/tasks/in_1") => j(json!({ "id": "in_1" })),
        _ => not_found(),
    });
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "link_thread", json!({ "issue": "TRM-1", "threadUrl": THREAD })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!((v["linked"].clone(), v["threadUrl"].clone()), (json!(true), json!(THREAD)));
    let w = mock.writes();
    assert_eq!(w.len(), 1);
    assert!(w[0].is("PATCH", "/tasks/in_1"));
    assert_eq!(w[0].body, json!({ "threadUrl": THREAD }));

    let (err, text) = call(&s, &all(), "link_thread", json!({ "issue": "TRM-2", "threadUrl": THREAD })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["alreadyLinked"], true);
    assert_eq!(mock.writes().len(), 1, "the same thread is not written again");
}

#[tokio::test]
async fn link_thread_refuses_a_task_with_another_thread_with_a_clear_payload() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/TRM-128") => j(json!({ "id": "in_128", "key": "TRM-128", "threadUrl": "https://delta.example/t/th_8f2a19" })),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "link_thread", json!({ "issue": "TRM-128", "threadUrl": THREAD })).await;
    assert!(err, "an error result, so the agent stops and asks");
    let v = parsed(&text);
    assert_eq!(v["code"], "thread_already_linked");
    assert_eq!(v["linked"], false);
    assert_eq!(v["threadUrl"], "https://delta.example/t/th_8f2a19");
    assert_eq!(v["message"], "TRM-128 already linked to https://delta.example/t/th_8f2a19");
    assert!(v["hint"].as_str().unwrap().contains("create_task"), "{text}");
    assert!(mock.writes().is_empty(), "nothing was changed");
}

#[tokio::test]
async fn link_thread_reports_a_409_raced_by_another_thread() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let reads = AtomicUsize::new(0);
    let mock = Mock::spawn(move |r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/TRM-1") => {
            let first = reads.fetch_add(1, Ordering::SeqCst) == 0;
            j(if first { json!({ "id": "in_1", "key": "TRM-1" }) } else { json!({ "id": "in_1", "key": "TRM-1", "threadUrl": "https://delta.example/t/other" }) })
        }
        ("GET", "/tasks/in_1") => j(json!({ "id": "in_1", "key": "TRM-1", "threadUrl": "https://delta.example/t/other" })),
        ("PATCH", "/tasks/in_1") => (409, json!({ "statusCode": 409, "code": "thread_already_linked", "message": "TRM-1 already linked to https://delta.example/t/other", "threadUrl": "https://delta.example/t/other" }).to_string()),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "link_thread", json!({ "issue": "TRM-1", "threadUrl": THREAD })).await;
    assert!(err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["code"], "thread_already_linked");
    assert_eq!(v["threadUrl"], "https://delta.example/t/other");
    assert_eq!(v["requestedThreadUrl"], THREAD);
}

#[tokio::test]
async fn link_thread_validates_before_calling() {
    let mock = Mock::spawn(|_| not_found());
    let s = server(&mock);
    for args in [json!({ "issue": "TRM-1", "threadUrl": "th_1" }), json!({ "issue": "TRM-1" }), json!({ "threadUrl": THREAD })] {
        let (err, text) = call(&s, &all(), "link_thread", args.clone()).await;
        assert!(err, "{args}: {text}");
    }
    assert!(mock.calls().is_empty());
}

fn sync_reply() -> Value {
    json!({
        "record": { "issueId": "in_1", "threadUrl": THREAD, "summary": "s", "files": ["a.ts", "b.ts"], "turns": 3, "syncCount": 2, "decisions": [] },
        "decisionsAdded": 1,
        "linked": true,
        "artifact": { "id": "ar_1", "kind": "pull_request", "title": "Fix", "state": "open", "url": "https://github.com/acme/web/pull/1", "createdAt": "x" },
        "timeSuggestion": { "id": "te_9", "userId": "usr_me", "minutes": 47 }
    })
}

#[tokio::test]
async fn sync_thread_sends_the_validated_parts_and_reports_the_facts() {
    let mock = Mock::spawn(|r| if r.is("POST", "/tasks/BUG-1/thread/sync") { j(sync_reply()) } else { not_found() });
    let args = json!({
        "issue": "BUG-1",
        "summary": "  Retry wired  ",
        "decisions": [{ "text": "Alert after 3 failures", "paths": ["src/auth/"] }, { "text": "Keep it simple" }],
        "files": ["./a.ts", "b.ts", "a.ts"],
        "pullRequestUrl": "https://github.com/acme/web/pull/1",
        "activeMinutes": 47,
        "turns": 3,
        "threadUrl": THREAD
    });
    let (err, text) = call(&server(&mock), &all(), "sync_thread", args).await;
    assert!(!err, "{text}");
    let w = mock.writes();
    assert_eq!(w.len(), 1);
    assert_eq!(
        w[0].body,
        json!({
            "summary": "Retry wired",
            "decisions": [{ "text": "Alert after 3 failures", "paths": ["src/auth/"] }, { "text": "Keep it simple" }],
            "files": ["a.ts", "b.ts"],
            "pullRequestUrl": "https://github.com/acme/web/pull/1",
            "activeMinutes": 47,
            "turns": 3,
            "threadUrl": THREAD
        })
    );
    let v = parsed(&text);
    assert_eq!(v["synced"], true);
    assert_eq!(v["linked"], true);
    assert_eq!(v["decisionsAdded"], 1);
    assert_eq!(v["files"], 2);
    assert_eq!(v["syncCount"], 2);
    assert_eq!(v["artifact"]["state"], "open");
    assert!(v["artifact"].get("createdAt").is_none());
    assert_eq!(v["timeSuggestion"]["minutes"], 47);
    assert!(v["note"].as_str().unwrap().contains("status"), "{text}");
}

#[tokio::test]
async fn sync_thread_may_send_nothing_but_the_task() {
    let mock = Mock::spawn(|r| if r.is("POST", "/tasks/BUG-1/thread/sync") { j(sync_reply()) } else { not_found() });
    let (err, text) = call(&server(&mock), &all(), "sync_thread", json!({ "issue": "BUG-1" })).await;
    assert!(!err, "{text}");
    assert_eq!(mock.writes()[0].body, json!({}));
}

#[tokio::test]
async fn sync_thread_validates_before_calling_and_names_a_thread_conflict() {
    let mock = Mock::spawn(|r| {
        if r.is("POST", "/tasks/BUG-1/thread/sync") {
            (409, json!({ "statusCode": 409, "code": "thread_already_linked", "message": "BUG-1 already linked to https://delta.example/t/other" }).to_string())
        } else {
            not_found()
        }
    });
    let s = server(&mock);
    for args in [
        json!({ "issue": "BUG-1", "files": ["../secret"] }),
        json!({ "issue": "BUG-1", "files": ["/etc/passwd"] }),
        json!({ "issue": "BUG-1", "decisions": [{ "text": "x", "paths": ["../y"] }] }),
        json!({ "issue": "BUG-1", "activeMinutes": 721 }),
        json!({ "issue": "BUG-1", "pullRequestUrl": "acme/web#1" }),
        json!({ "issue": "BUG-1", "threadUrl": "th_1" }),
        json!({ "issue": "BUG-1", "decisions": [{ "paths": ["a"] }] }),
        json!({ "summary": "no task" }),
    ] {
        let (err, text) = call(&s, &all(), "sync_thread", args.clone()).await;
        assert!(err, "{args}: {text}");
    }
    assert!(mock.calls().is_empty(), "nothing reached the API");

    let (err, text) = call(&s, &all(), "sync_thread", json!({ "issue": "BUG-1", "threadUrl": THREAD })).await;
    assert!(err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["code"], "thread_already_linked");
    assert!(v["message"].as_str().unwrap().contains("already linked"), "{text}");
    assert_eq!(v["requestedThreadUrl"], THREAD);
}

#[tokio::test]
async fn find_decisions_asks_for_a_path_and_a_task() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/decisions") if r.query.contains("path=") && r.query.contains("login.ts") => j(json!([
            { "id": "dc_1", "issueId": "in_1", "issueKey": "TRM-128", "text": "Rotate refresh tokens", "paths": ["src/auth/"], "threadUrl": null, "createdBy": { "type": "agent", "id": "ag_1" }, "createdAt": "2026-05-01T09:00:00.000Z" }
        ])),
        ("GET", "/decisions") => j(json!([])),
        _ => not_found(),
    });
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "find_decisions", json!({ "path": "./src/auth/login.ts", "issue": "TRM-128", "limit": 5 })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["count"], 1);
    assert_eq!(v["decisions"][0]["issueKey"], "TRM-128");
    assert_eq!(v["decisions"][0]["text"], "Rotate refresh tokens");
    assert!(v["decisions"][0].get("createdBy").is_none());
    let q = &mock.calls()[0].query;
    assert!(q.contains("issue=TRM-128") && q.contains("limit=5"), "{q}");
    assert!(!q.contains("path=.%2F"), "the leading ./ is dropped: {q}");

    let (err, text) = call(&s, &all(), "find_decisions", json!({ "path": "docs/readme.md" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["count"], 0);
    assert!(v["hint"].as_str().unwrap().contains("no recorded decision"), "{text}");
}

#[tokio::test]
async fn suggest_estimate_returns_the_suggestion_with_a_hint_and_writes_nothing() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1/estimate-suggestion") => j(json!({ "issueId": "in_1", "suggestion": 3, "scale": [1, 2, 3, 5, 8], "basis": [{ "id": "in_7", "key": "BUG-7", "title": "Retry queue", "estimate": 3, "trackedMinutes": 130 }], "reason": "Median of 2 similar tasks." })),
        ("GET", "/tasks/BUG-2/estimate-suggestion") => j(json!({ "issueId": "in_2", "suggestion": null, "scale": [1, 2, 3], "basis": [], "reason": "Only one similar task." })),
        _ => not_found(),
    });
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "suggest_estimate", json!({ "issue": "BUG-1" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["suggestion"], 3);
    assert_eq!(v["basis"][0]["key"], "BUG-7");
    assert!(v["hint"].as_str().unwrap().contains("update_task"), "{text}");
    let (_, text) = call(&s, &all(), "suggest_estimate", json!({ "issue": "BUG-2" })).await;
    assert!(parsed(&text)["hint"].as_str().unwrap().contains("Too little history"), "{text}");
    assert!(mock.writes().is_empty());
}

#[tokio::test]
async fn get_context_includes_the_decisions_of_the_task() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1/context") => j(json!({ "issue": { "id": "in_1", "key": "BUG-1" } })),
        ("GET", "/tasks/BUG-1/artifacts") => j(json!([])),
        ("GET", "/decisions") => j(json!([{ "id": "dc_1", "issueKey": "BUG-1", "text": "Use rotating tokens", "paths": ["src/auth/"], "createdAt": "2026-05-01T09:00:00.000Z", "createdBy": { "type": "user", "id": "usr_1" } }])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-1" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["decisions"][0]["text"], "Use rotating tokens");
    assert!(v["decisions"][0].get("createdBy").is_none());
    assert!(v.get("warnings").is_none(), "{text}");
    let list = mock.calls().into_iter().find(|r| r.is("GET", "/decisions")).unwrap();
    assert_eq!(list.query, "issue=in_1");
}

#[tokio::test]
async fn get_context_still_answers_when_the_api_has_no_decisions() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks/BUG-1/context") => j(json!({ "issue": { "id": "in_1", "key": "BUG-1" } })),
        ("GET", "/tasks/BUG-1/artifacts") => j(json!([])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-1" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert!(v.get("decisions").is_none() && v.get("warnings").is_none(), "{text}");
}
