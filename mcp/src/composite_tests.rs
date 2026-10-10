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

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| panic!("not json: {text}"))
}

fn workstream() -> Value {
    json!({
        "id": "wk_1", "key": "AUTH-42", "title": "Stabilize auth", "status": "working", "delivery": "none",
        "acceptanceCriteria": [
            { "id": "cr_1", "text": "OAuth login passes on Safari 18", "state": "pending" },
            { "id": "cr_2", "text": "Refresh tokens rotate", "state": "pending" }
        ]
    })
}

fn all() -> [Account; 1] {
    [account("acme", &all_permissions())]
}

// ── validation and references ──

#[test]
fn normalize_drops_blanks_and_checks_types() {
    let entries = crate::profile::load(&catalog::load().unwrap()).unwrap();
    let schema = entries.iter().find(|e| e.name == "report_progress").unwrap().input_schema.clone().unwrap();
    let ok = normalize(&schema, &json!({ "workstream": "AUTH-42", "issue": null, "comment": "  ", "criteria": [{ "criterion": "1", "state": "met" }] })).unwrap();
    assert_eq!(ok, json!({ "workstream": "AUTH-42", "criteria": [{ "criterion": "1", "state": "met" }] }));
    let err = |v: Value| normalize(&schema, &v).unwrap_err();
    assert!(err(json!({ "wat": 1 })).contains("unknown argument 'wat'"));
    assert!(err(json!({ "criteria": [{ "criterion": "1", "state": "done" }] })).contains("criteria[0].state"));
    assert!(err(json!({ "criteria": [{ "state": "met" }] })).contains("criteria[0].criterion"));
    assert!(err(json!({ "artifact": { "kind": "pull_request" } })).contains("artifact.title"));
    assert!(err(json!({ "comment": 5 })).contains("must be a string"));
    assert!(err(json!("x")).contains("must be an object"));
}

#[test]
fn references_are_classified_by_id_prefix_and_key_shape() {
    assert_eq!(candidates("BUG-142", None), vec![Kind::Issue]);
    assert_eq!(candidates("fb-3", None), vec![Kind::Issue]);
    assert_eq!(candidates("ADR-21", None), vec![Kind::Decision]);
    assert_eq!(candidates("AUTH-42", None), vec![Kind::Workstream, Kind::Issue]);
    assert_eq!(candidates("wk_abc", None), vec![Kind::Workstream]);
    assert_eq!(candidates("in_abc", None), vec![Kind::Issue]);
    assert_eq!(candidates("pj_abc", None), vec![Kind::Project]);
    assert_eq!(candidates("ir_abc", None), vec![Kind::InputRequest]);
    assert!(candidates("something", None).is_empty());
    assert_eq!(candidates("AUTH-42", Some(Kind::Issue)), vec![Kind::Issue]);
}

#[test]
fn criteria_match_by_id_position_or_text() {
    let list = criteria_of(&workstream());
    assert_eq!(match_criterion(&list, "cr_2"), Ok(1));
    assert_eq!(match_criterion(&list, "#1"), Ok(0));
    assert_eq!(match_criterion(&list, "2"), Ok(1));
    assert_eq!(match_criterion(&list, "safari"), Ok(0));
    assert!(match_criterion(&list, "3").is_err());
    assert!(match_criterion(&list, "o").unwrap_err().contains("matches 2"));
    assert!(match_criterion(&list, "zzz").is_err());
}

// ── get_context ──

#[tokio::test]
async fn get_context_returns_the_workstream_briefing_in_one_call() {
    let mock = Mock::spawn(|r| if r.is("GET", "/workstreams/AUTH-42/context") { (200, "# AUTH-42\nObjective".into()) } else { not_found() });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "AUTH-42" })).await;
    assert!(!err);
    assert_eq!(text, "# AUTH-42\nObjective");
    assert_eq!(mock.calls().len(), 1);
}

#[tokio::test]
async fn get_context_falls_back_to_an_issue_when_a_team_key_is_not_a_workstream() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/OPS-7") => j(json!({ "id": "in_7", "key": "OPS-7", "title": "Old key", "workstreamIds": ["wk_1"] })),
        ("GET", "/workstreams/wk_1") => j(workstream()),
        ("GET", "/issues/OPS-7/artifacts") => j(json!([{ "id": "ar_1", "kind": "pull_request", "title": "Fix", "state": "open" }])),
        ("GET", "/comments") => j(json!([{ "id": "cm_1", "body": "hi" }])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "OPS-7", "comments": true })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["type"], "issue");
    assert_eq!(v["workstreams"][0]["key"], "AUTH-42");
    assert_eq!(v["artifacts"][0]["id"], "ar_1");
    assert_eq!(v["comments"][0]["body"], "hi");
    let paths: Vec<String> = mock.calls().iter().map(|r| format!("{} {}", r.method, r.path)).collect();
    assert_eq!(paths[0], "GET /workstreams/OPS-7/context", "workstream is tried first");
    assert!(mock.calls().iter().any(|r| r.path == "/comments" && r.query.contains("subjectType=issue") && r.query.contains("subjectId=in_7")));
}

#[tokio::test]
async fn get_context_reports_a_missing_thing_clearly() {
    let mock = Mock::spawn(|_| not_found());
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "BUG-999" })).await;
    assert!(err);
    assert!(text.contains("no issue 'BUG-999'"), "{text}");
}

// ── report_progress ──

#[tokio::test]
async fn report_progress_maps_criteria_artifact_and_comment_onto_api_calls() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/AUTH-42") | ("GET", "/workstreams/wk_1") => j(workstream()),
        ("GET", "/artifacts") => j(json!([])),
        ("PATCH", "/workstreams/wk_1/criteria/cr_1") => j(json!({ "ok": true })),
        ("POST", "/artifacts") => j(json!({ "id": "ar_1", "kind": "pull_request", "title": "Rotate", "state": "open", "ci": "pending" })),
        ("POST", "/comments") => j(json!({ "id": "cm_1" })),
        _ => not_found(),
    });
    let args = json!({
        "workstream": "AUTH-42",
        "criteria": [{ "criterion": "1", "state": "met" }],
        "artifact": { "kind": "pull_request", "title": "Rotate", "url": "https://github.com/o/r/pull/318", "externalId": "318", "state": "open", "ci": "pending" },
        "comment": "PR #318 open."
    });
    let (err, text) = call(&server(&mock), &all(), "report_progress", args).await;
    assert!(!err, "{text}");
    let writes = mock.writes();
    assert_eq!(writes.len(), 3, "{writes:?}");
    assert!(writes[0].is("PATCH", "/workstreams/wk_1/criteria/cr_1"));
    assert_eq!(writes[0].body, json!({ "state": "met" }));
    assert!(writes[1].is("POST", "/artifacts"));
    assert_eq!(writes[1].body["workstreamId"], "wk_1");
    assert_eq!(writes[1].body["externalId"], "318");
    assert_eq!(writes[1].body["kind"], "pull_request");
    assert!(writes[2].is("POST", "/comments"));
    assert_eq!(writes[2].body, json!({ "subject": { "type": "workstream", "id": "wk_1" }, "body": "PR #318 open." }));
    let v = parsed(&text);
    assert_eq!(v["applied"].as_array().unwrap().len(), 3);
    assert_eq!(v["workstream"]["key"], "AUTH-42", "the reply shows the resulting workstream");
}

#[tokio::test]
async fn report_progress_updates_an_existing_artifact_instead_of_duplicating_it() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/wk_1") => j(workstream()),
        ("GET", "/artifacts") => j(json!([{ "id": "ar_9", "kind": "pull_request", "externalId": "318", "url": "u", "state": "open" }])),
        ("PATCH", "/artifacts/ar_9") => j(json!({ "id": "ar_9", "kind": "pull_request", "title": "t", "state": "open", "ci": "passing" })),
        _ => not_found(),
    });
    let args = json!({ "workstream": "wk_1", "artifact": { "kind": "pull_request", "title": "t", "externalId": "318", "ci": "passing", "description": "ignored on update" } });
    let (err, text) = call(&server(&mock), &all(), "report_progress", args).await;
    assert!(!err, "{text}");
    let writes = mock.writes();
    assert_eq!(writes.len(), 1);
    assert!(writes[0].is("PATCH", "/artifacts/ar_9"));
    assert_eq!(writes[0].body["ci"], "passing");
    assert!(writes[0].body.get("description").is_none(), "update_artifact has no description");
}

#[tokio::test]
async fn report_progress_reports_partial_failure_without_hiding_what_worked() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/wk_1") => j(workstream()),
        ("PATCH", "/workstreams/wk_1/criteria/cr_1") => j(json!({})),
        ("POST", "/comments") => (403, json!({ "message": "no" }).to_string()),
        _ => not_found(),
    });
    let args = json!({ "workstream": "wk_1", "criteria": [{ "criterion": "1", "state": "met" }, { "criterion": "9", "state": "met" }], "comment": "x" });
    let (err, text) = call(&server(&mock), &all(), "report_progress", args).await;
    assert!(err, "a failed step makes the call an error");
    let v = parsed(&text);
    assert_eq!(v["applied"], json!(["criterion 1 is met"]));
    assert_eq!(v["failed"].as_array().unwrap().len(), 2);
    assert!(v["note"].as_str().unwrap().contains("Do not repeat"));
}

#[tokio::test]
async fn report_progress_needs_something_to_do_and_the_right_anchor() {
    let mock = Mock::spawn(|_| not_found());
    let s = server(&mock);
    let a = all();
    assert!(call(&s, &a, "report_progress", json!({})).await.1.contains("nothing to report"));
    assert!(call(&s, &a, "report_progress", json!({ "criteria": [{ "criterion": "1", "state": "met" }] })).await.1.contains("need `workstream`"));
    assert!(call(&s, &a, "report_progress", json!({ "issueStatus": "done" })).await.1.contains("needs `issue`"));
    assert!(mock.calls().is_empty(), "validation happens before any API call");
}

// ── attach_artifact ──

#[tokio::test]
async fn attach_artifact_creates_on_the_issue_when_none_matches() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1" })),
        ("GET", "/issues/in_1/artifacts") => j(json!([])),
        ("POST", "/artifacts") => j(json!({ "id": "ar_2", "kind": "link", "title": "Spec" })),
        _ => not_found(),
    });
    let args = json!({ "issue": "BUG-1", "kind": "link", "title": "Spec", "url": "https://x.test/spec", "description": "Design doc" });
    let (err, text) = call(&server(&mock), &all(), "attach_artifact", args).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["action"], "created");
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "issueId": "in_1", "kind": "link", "title": "Spec", "url": "https://x.test/spec", "description": "Design doc" }));
}

// ── ask_human ──

#[tokio::test]
async fn ask_human_asks_once() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/AUTH-42") => j(workstream()),
        ("GET", "/input-requests") => j(json!([{ "id": "ir_1", "question": "Drop  Safari 16?", "state": "open" }])),
        ("POST", "/input-requests") => j(json!({ "id": "ir_2", "question": "Keep the polyfill?", "state": "open", "options": ["yes", "no"] })),
        _ => not_found(),
    });
    let s = server(&mock);
    let a = all();
    let (err, text) = call(&s, &a, "ask_human", json!({ "workstream": "AUTH-42", "question": "drop safari 16?" })).await;
    assert!(!err);
    assert_eq!(parsed(&text)["created"], false);
    assert!(mock.writes().is_empty());

    let (err, text) = call(&s, &a, "ask_human", json!({ "workstream": "AUTH-42", "question": "Keep the polyfill?", "options": ["yes", "no"], "assignee": "usr_2" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["inputRequest"]["id"], "ir_2");
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "workstreamId": "wk_1", "question": "Keep the polyfill?", "options": ["yes", "no"], "assigneeUserId": "usr_2" }));
    assert!(mock.calls().iter().any(|r| r.path == "/input-requests" && r.query.contains("workstreamId=wk_1") && r.query.contains("state=open")));
}

// ── record_decision ──

#[tokio::test]
async fn record_decision_proposes_and_never_accepts() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/AUTH-42") => j(workstream()),
        ("GET", "/workstreams/AUTH-43") => j(json!({ "id": "wk_3", "key": "AUTH-43" })),
        ("GET", "/decisions") => j(json!([])),
        ("POST", "/decisions") => j(json!({ "id": "dc_1", "key": "ADR-23", "title": "T", "status": "proposed" })),
        _ => not_found(),
    });
    let args = json!({ "title": "T", "statement": "S", "rationale": "R", "workstream": "AUTH-42", "related": ["AUTH-43"], "tags": ["auth"] });
    let (err, text) = call(&server(&mock), &all(), "record_decision", args).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["decision"]["key"], "ADR-23");
    let w = mock.writes();
    assert_eq!(w.len(), 1);
    assert_eq!(
        w[0].body,
        json!({ "title": "T", "statement": "S", "rationale": "R", "tags": ["auth"], "status": "proposed", "originWorkstreamId": "wk_1", "relatedWorkstreamIds": ["wk_3"] })
    );
    assert!(!mock.calls().iter().any(|r| r.path.contains("accept")));
}

#[tokio::test]
async fn record_decision_does_not_duplicate_an_existing_title() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/decisions") => j(json!([{ "id": "dc_1", "key": "ADR-5", "title": "Use  OAuth", "status": "accepted" }])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "record_decision", json!({ "title": "use oauth", "statement": "S" })).await;
    assert!(!err);
    assert_eq!(parsed(&text)["created"], false);
    assert!(mock.writes().is_empty());
}

// ── create_issue ──

#[tokio::test]
async fn create_issue_blocks_exact_duplicates_unless_forced() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/search") => j(json!({ "results": [{ "type": "issue", "id": "in_1", "key": "BUG-1", "title": "Login times out", "subtitle": "bug · backlog" }] })),
        ("POST", "/issues") => j(json!({ "id": "in_2", "key": "BUG-2", "title": "Login times out", "kind": "bug", "status": "backlog" })),
        _ => not_found(),
    });
    let s = server(&mock);
    let a = all();
    let (err, text) = call(&s, &a, "create_issue", json!({ "kind": "bug", "title": "login times out" })).await;
    assert!(!err);
    let v = parsed(&text);
    assert_eq!(v["created"], false);
    assert_eq!(v["existing"]["key"], "BUG-1");
    assert!(mock.writes().is_empty());

    let (err, text) = call(&s, &a, "create_issue", json!({ "kind": "bug", "title": "login times out", "force": true })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["created"], true);
    assert_eq!(v["similarOpenIssues"][0]["key"], "BUG-1");
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "title": "login times out", "kind": "bug", "source": "agent" }), "source defaults to agent and force is not sent");
}

#[tokio::test]
async fn create_issue_can_link_to_a_workstream_by_key() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/search") => j(json!({ "results": [] })),
        ("POST", "/issues") => j(json!({ "id": "in_2", "key": "BUG-2", "title": "x", "kind": "bug", "status": "backlog" })),
        ("GET", "/workstreams/AUTH-42") => j(workstream()),
        ("POST", "/issues/in_2/link") => j(json!({ "id": "in_2", "workstreamIds": ["wk_1"] })),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "create_issue", json!({ "kind": "bug", "title": "x", "workstream": "AUTH-42", "priority": "high" })).await;
    assert!(!err, "{text}");
    let w = mock.writes();
    assert_eq!(w[0].body["priority"], "high");
    assert!(w[1].is("POST", "/issues/in_2/link"));
    assert_eq!(w[1].body, json!({ "workstreamIds": ["wk_1"] }));
    assert_eq!(parsed(&text)["linked"]["workstreamIds"], json!(["wk_1"]));
}

// ── start_work ──

fn start_mock(workstream_status: &'static str, issue_status: &'static str) -> Mock {
    Mock::spawn(move |r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/BUG-1") => j(json!({ "id": "in_1", "key": "BUG-1", "title": "t", "status": issue_status, "workstreamIds": ["wk_1"] })),
        ("GET", "/workstreams/wk_1") => {
            let mut w = workstream();
            w["status"] = json!(workstream_status);
            j(w)
        }
        ("GET", "/workstreams/wk_1/context") => (200, "# briefing".into()),
        ("GET", "/input-requests") => j(json!([{ "id": "ir_1", "question": "Keep v1?" }])),
        ("GET", "/decisions") => j(json!([])),
        ("PATCH", _) | ("POST", _) => j(json!({})),
        _ => not_found(),
    })
}

#[tokio::test]
async fn start_work_marks_the_start_and_returns_the_briefing() {
    let mock = start_mock("planned", "backlog");
    let (err, text) = call(&server(&mock), &all(), "start_work", json!({ "key": "BUG-1", "plan": "Fixing the timeout." })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["ready"], true);
    assert_eq!(v["briefing"], "# briefing");
    assert!(v["cautions"][0].as_str().unwrap().contains("ir_1"), "open input requests are surfaced");
    let w = mock.writes();
    assert!(w[0].is("PATCH", "/workstreams/wk_1/criteria/cr_1"));
    assert_eq!(w[0].body, json!({ "state": "in_progress" }));
    assert!(w[1].is("PATCH", "/issues/in_1"));
    assert_eq!(w[1].body, json!({ "status": "in_progress" }));
    assert!(w[2].is("POST", "/comments"));
    assert_eq!(w[2].body["subject"], json!({ "type": "workstream", "id": "wk_1" }));
}

#[tokio::test]
async fn start_work_writes_nothing_on_a_blocked_workstream() {
    let mock = start_mock("blocked", "backlog");
    let (err, text) = call(&server(&mock), &all(), "start_work", json!({ "key": "BUG-1", "plan": "go" })).await;
    assert!(!err);
    let v = parsed(&text);
    assert_eq!(v["ready"], false);
    assert!(v["stopBecause"][0].as_str().unwrap().contains("blocked"));
    assert!(v["briefing"].is_string(), "the briefing is still returned");
    assert!(mock.writes().is_empty());
}

// ── triage_issues, add_comment, find_work ──

#[tokio::test]
async fn triage_issues_applies_each_item_independently() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/BUG-150") => j(json!({ "id": "in_150", "key": "BUG-150" })),
        ("GET", "/issues/BUG-151") => j(json!({ "id": "in_151", "key": "BUG-151" })),
        ("GET", "/workstreams/AUTH-42") => j(workstream()),
        ("PATCH", "/issues/in_150") | ("PATCH", "/issues/in_151") | ("POST", "/issues/in_151/link") => j(json!({})),
        _ => not_found(),
    });
    let args = json!({ "items": [
        { "issue": "BUG-150", "duplicateOf": "BUG-142" },
        { "issue": "BUG-404", "priority": "low" },
        { "issue": "BUG-151", "priority": "high", "workstream": "AUTH-42" }
    ] });
    let (err, text) = call(&server(&mock), &all(), "triage_issues", args).await;
    assert!(err, "one item failed");
    let results = parsed(&text)["results"].clone();
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[1]["ok"], false);
    assert_eq!(results[2]["applied"], json!(["updated", "linked to a workstream"]));
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "duplicateOfId": "BUG-142" }));
    assert_eq!(w[1].body, json!({ "priority": "high" }));
    assert_eq!(w[2].body, json!({ "workstreamIds": ["wk_1"] }));
}

#[tokio::test]
async fn add_comment_resolves_keys_to_the_ids_the_api_wants() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/BUG-142") => j(json!({ "id": "in_142", "key": "BUG-142" })),
        ("POST", "/comments") => j(json!({ "id": "cm_1" })),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "add_comment", json!({ "on": "BUG-142", "body": "Reproduced." })).await;
    assert!(!err, "{text}");
    assert_eq!(mock.writes()[0].body, json!({ "subject": { "type": "issue", "id": "in_142" }, "body": "Reproduced." }));
}

#[tokio::test]
async fn find_work_filters_by_me_and_hides_finished_work() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues") => j(json!([{ "id": "in_1", "key": "BUG-1", "title": "t", "status": "todo", "body": "long text that must not be echoed" }])),
        ("GET", "/workstreams") => j(json!([workstream(), { "id": "wk_2", "key": "AUTH-1", "status": "shipped" }])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "find_work", json!({ "assignee": "me" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert_eq!(v["issues"][0]["key"], "BUG-1");
    assert!(v["issues"][0].get("body").is_none(), "rows are compact");
    assert_eq!(v["workstreams"].as_array().unwrap().len(), 1, "shipped work is hidden by default");
    let q: Vec<String> = mock.calls().iter().map(|r| format!("{} ?{}", r.path, r.query)).collect();
    assert!(q.iter().any(|s| s.starts_with("/issues ?") && s.contains("assigneeId=usr_me") && s.contains("open=true")), "{q:?}");
    assert!(q.iter().any(|s| s.starts_with("/workstreams ?") && s.contains("accountableUserId=usr_me")), "{q:?}");
}

#[tokio::test]
async fn find_work_skips_the_scope_a_status_does_not_fit() {
    let mock = Mock::spawn(|r| match r.path.as_str() {
        "/workstreams" => j(json!([workstream()])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "find_work", json!({ "status": "needs_input" })).await;
    assert!(!err, "{text}");
    let v = parsed(&text);
    assert!(v.get("issues").is_none() && v["workstreams"].is_array());
    assert!(mock.calls().iter().all(|r| r.path != "/issues"));
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
    for hidden in ["create_issue", "report_progress", "ask_human", "record_decision", "attach_artifact", "add_comment", "triage_issues", "update_issue"] {
        assert!(!listed.contains(&hidden.to_string()), "{hidden} must be hidden for a read-only key");
    }
    let (err, text) = call(&s, &a, "ask_human", json!({ "workstream": "wk_1", "question": "q" })).await;
    assert!(err, "calling a hidden tool by name is still refused");
    assert!(text.contains("input-requests:write"), "{text}");
    assert!(mock.calls().is_empty(), "refused before any API call");
}

#[tokio::test]
async fn a_step_the_key_may_not_do_is_reported_not_attempted() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/wk_1") => j(workstream()),
        ("PATCH", _) => j(json!({})),
        _ => not_found(),
    });
    let perms: Vec<String> = ["workstreams:read", "workstreams:write"].iter().map(|s| s.to_string()).collect();
    let args = json!({ "workstream": "wk_1", "criteria": [{ "criterion": "1", "state": "met" }], "comment": "done" });
    let (err, text) = call(&server(&mock), &[account("acme", &perms)], "report_progress", args).await;
    assert!(err);
    let v = parsed(&text);
    assert_eq!(v["applied"], json!(["criterion 1 is met"]));
    assert!(v["failed"][0].as_str().unwrap().contains("comments:write"));
    assert!(mock.writes().iter().all(|w| w.path != "/comments"));
}

// ── several workspaces ──

#[tokio::test]
async fn composite_reads_span_workspaces_and_writes_need_one() {
    let mock = Mock::spawn(|r| match r.path.as_str() {
        "/issues" => j(json!([{ "id": "in_1", "key": "BUG-1", "title": "t", "status": "todo" }])),
        "/workstreams" => j(json!([])),
        "/comments" => j(json!({ "id": "cm_1" })),
        _ => not_found(),
    });
    let s = server(&mock);
    let both = [account("acme", &all_permissions()), account("beta", &all_permissions())];
    let (err, text) = call(&s, &both, "find_work", json!({})).await;
    assert!(!err, "{text}");
    let rows = parsed(&text);
    let workspaces: Vec<&str> = rows.as_array().unwrap().iter().map(|r| r["workspace"].as_str().unwrap()).collect();
    assert_eq!(workspaces, vec!["acme", "beta"]);

    let (err, text) = call(&s, &both, "add_comment", json!({ "on": "wk_1", "body": "x" })).await;
    assert!(err && text.contains("exactly one workspace"), "{text}");
    let (err, text) = call(&s, &both, "add_comment", json!({ "on": "wk_1", "body": "x", "workspace": "beta" })).await;
    assert!(!err, "{text}");
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

    let (_, text) = call(&s, &a, "list_capabilities", json!({ "group": "teams" })).await;
    let names: Vec<String> = parsed(&text)["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"create_team".to_string()));

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
    let mock = Mock::spawn(|r| if r.is("GET", "/teams") { j(json!([{ "id": "tm_1" }])) } else { not_found() });
    let s = server(&mock);
    let (err, text) = call(&s, &all(), "list_teams", json!({})).await;
    assert!(!err, "{text}");
    assert!(!s.list_tools(&all()).iter().any(|t| t["name"] == "list_teams"));
}

#[tokio::test]
async fn report_progress_passes_criterion_evidence_through_and_warns_without_it() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/workstreams/wk_1") => {
            let mut w = workstream();
            w["completion"] = json!({ "achieved": false, "gaps": ["criteria_pending"] });
            j(w)
        }
        ("PATCH", _) => j(json!({})),
        _ => not_found(),
    });
    let args = json!({ "workstream": "wk_1", "criteria": [
        { "criterion": "1", "state": "met", "evidence": { "artifactIds": ["ar_1"], "note": "tested on staging" } },
        { "criterion": "2", "state": "met" }
    ] });
    let (err, text) = call(&server(&mock), &all(), "report_progress", args).await;
    assert!(!err, "{text}");
    let w = mock.writes();
    assert_eq!(w[0].body, json!({ "state": "met", "evidence": { "artifactIds": ["ar_1"], "note": "tested on staging" } }));
    assert_eq!(w[1].body, json!({ "state": "met" }));
    let v = parsed(&text);
    assert_eq!(v["warnings"].as_array().unwrap().len(), 1, "only the met without evidence is flagged");
    assert!(v["warnings"][0].as_str().unwrap().contains("criterion 2"));
    assert_eq!(v["workstream"]["completion"]["gaps"], json!(["criteria_pending"]), "the result carries completion");
}

#[tokio::test]
async fn get_context_on_an_issue_carries_each_workstreams_completion() {
    let mock = Mock::spawn(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/issues/OPS-7") => j(json!({ "id": "in_7", "key": "OPS-7", "title": "t", "workstreamIds": ["wk_1"] })),
        ("GET", "/workstreams/wk_1") => {
            let mut w = workstream();
            w["completion"] = json!({ "achieved": false, "gaps": ["no_delivery"] });
            w["statusSource"] = json!("override");
            j(w)
        }
        ("GET", "/issues/OPS-7/artifacts") => j(json!([])),
        _ => not_found(),
    });
    let (err, text) = call(&server(&mock), &all(), "get_context", json!({ "id": "OPS-7", "type": "issue" })).await;
    assert!(!err, "{text}");
    assert_eq!(parsed(&text)["workstreams"][0]["completion"]["gaps"], json!(["no_delivery"]));
    assert_eq!(parsed(&text)["workstreams"][0]["statusSource"], json!("override"), "a pin is never mistaken for a derived status");
}
