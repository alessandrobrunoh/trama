//! End-to-end tests: the real `trama` binary against a tiny in-process HTTP server that plays the API.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{Value, json};

// ───────────────────────────── mock API ─────────────────────────────

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Recorded {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

struct Route {
    method: &'static str,
    path: &'static str,
    status: u16,
    content_type: &'static str,
    body: String,
    headers: Vec<(&'static str, String)>,
}

fn route(method: &'static str, path: &'static str, status: u16, body: Value) -> Route {
    Route {
        method,
        path,
        status,
        content_type: "application/json",
        body: body.to_string(),
        headers: vec![],
    }
}

struct Mock {
    port: u16,
    log: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
}

impl Mock {
    fn start(routes: Vec<Route>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log2, stop2) = (log.clone(), stop.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                handle(stream, &routes, &log2);
            }
        });
        Mock { port, log, stop }
    }

    fn api(&self) -> String {
        format!("http://127.0.0.1:{}/api", self.port)
    }

    fn requests(&self) -> Vec<Recorded> {
        self.log.lock().unwrap().clone()
    }

    fn last(&self) -> Recorded {
        self.requests()
            .last()
            .cloned()
            .expect("no request reached the mock")
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn handle(mut stream: TcpStream, routes: &[Route], log: &Arc<Mutex<Vec<Recorded>>>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (
        first.next().unwrap_or("").to_string(),
        first.next().unwrap_or("").to_string(),
    );
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let want: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + want {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
    let rec = Recorded {
        method: method.clone(),
        target,
        headers,
        body,
    };
    let found = routes
        .iter()
        .find(|r| r.method == method && r.path == rec.path());
    log.lock().unwrap().push(rec);
    let (status, ctype, body, extra) = match found {
        Some(r) => (r.status, r.content_type, r.body.clone(), r.headers.clone()),
        None => (
            404,
            "application/json",
            json!({ "statusCode": 404, "message": "no such route in the mock" }).to_string(),
            vec![],
        ),
    };
    let mut resp = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        resp.push_str(&format!("{k}: {v}\r\n"));
    }
    resp.push_str("\r\n");
    resp.push_str(&body);
    let _ = stream.write_all(resp.as_bytes());
}

fn identity(perms: &[&str]) -> Value {
    let mut id = identity_in("acme", "Acme", perms);
    id["token"]["id"] = json!("tok_1");
    id
}

fn identity_in(slug: &str, name: &str, perms: &[&str]) -> Value {
    json!({
        "token": { "id": format!("tok_{slug}"), "name": "ci", "prefix": "nbl_test", "scope": "custom", "tokenHash": "secret-hash" },
        "actor": { "type": "user", "id": "usr_1" },
        "workspace": { "id": format!("ws_{slug}"), "slug": slug, "name": name },
        "permissions": perms,
    })
}

// ───────────────────────────── harness ─────────────────────────────

fn scratch(name: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Run {
    config: PathBuf,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

impl Run {
    fn new() -> Run {
        Run {
            config: scratch("config"),
            cwd: scratch("cwd"),
            env: vec![],
        }
    }

    fn env(mut self, k: &str, v: &str) -> Run {
        self.env.push((k.to_string(), v.to_string()));
        self
    }

    /// Credentials through the environment, as an agent in CI would have them.
    fn with_key(self, api: &str) -> Run {
        self.env("TRAMA_API_KEY", "nbl_test")
            .env("TRAMA_API_URL", api)
            .env("TRAMA_WORKSPACE", "acme")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_trama"));
        c.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.cwd)
            .env("TRAMA_CONFIG_DIR", &self.config)
            .env("TRAMA_NO_INPUT", "1")
            .current_dir(&self.cwd)
            .args(args);
        // Windows needs these to initialise sockets and resolve temp paths.
        for var in ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"] {
            if let Ok(v) = std::env::var(var) {
                c.env(var, v);
            }
        }
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_stdin(args, "")
    }

    fn run_stdin(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}

fn out_json(o: &Output) -> Value {
    serde_json::from_str(&stdout(o)).unwrap_or_else(|e| {
        panic!(
            "stdout is not JSON ({e}): {:?}\nstderr: {}",
            stdout(o),
            stderr(o)
        )
    })
}

fn err_json(o: &Output) -> Value {
    serde_json::from_str(&stderr(o))
        .unwrap_or_else(|e| panic!("stderr is not JSON ({e}): {:?}", stderr(o)))
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap_or(-1)
}

// ───────────────────────────── tests ─────────────────────────────

#[test]
fn whoami_introspects_the_key_and_hides_hashes() {
    let mock = Mock::start(vec![route(
        "GET",
        "/api/auth/token",
        200,
        identity(&["issues:write", "issues:read"]),
    )]);
    let o = Run::new().with_key(&mock.api()).run(&["whoami"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["workspace"]["slug"], "acme");
    assert_eq!(v["permissions"], json!(["issues:read", "issues:write"]));
    assert!(v["token"].get("tokenHash").is_none());
    assert_eq!(mock.last().headers["authorization"], "Bearer nbl_test");
}

#[test]
fn lists_with_filters_projection_and_compact_json() {
    let issues = json!([{ "id": "iss_1", "key": "BUG-1", "title": "Crash", "status": "todo", "body": "long" }, { "id": "iss_2", "key": "BUG-2", "title": "Slow", "status": "done" }]);
    let mock = Mock::start(vec![route("GET", "/api/w/acme/issues", 200, issues)]);
    let o = Run::new().with_key(&mock.api()).run(&[
        "issue",
        "list",
        "--open",
        "--limit",
        "5",
        "--priority",
        "urgent,high",
        "--fields",
        "key,status",
    ]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        stdout(&o).trim(),
        r#"[{"key":"BUG-1","status":"todo"},{"key":"BUG-2","status":"done"}]"#
    );
    let req = mock.last();
    assert_eq!(req.method, "GET");
    for q in ["open=true", "limit=5", "priority=urgent%2Chigh"] {
        assert!(
            req.target.contains(q) || req.target.contains(&q.replace("%2C", ",")),
            "{} missing {q}",
            req.target
        );
    }
}

#[test]
fn creates_with_flags_and_text_from_a_file() {
    let mock = Mock::start(vec![route(
        "POST",
        "/api/w/acme/issues",
        201,
        json!({ "id": "iss_9", "key": "BUG-9" }),
    )]);
    let run = Run::new().with_key(&mock.api());
    std::fs::write(run.cwd.join("notes.md"), "line one\n\n**line two**\n").unwrap();
    let o = run.run(&[
        "issue",
        "create",
        "--kind",
        "bug",
        "--title",
        "Login times out",
        "--file",
        "body=notes.md",
        "--estimate",
        "3",
    ]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["key"], "BUG-9");
    let body = mock.last().json();
    assert_eq!(body["kind"], "bug");
    assert_eq!(body["title"], "Login times out");
    assert_eq!(body["body"], "line one\n\n**line two**");
    assert_eq!(body["estimate"], 3.0);
}

#[test]
fn data_from_stdin_is_the_base_and_unset_sends_null() {
    let mock = Mock::start(vec![route(
        "PATCH",
        "/api/w/acme/issues/BUG-1",
        200,
        json!({ "key": "BUG-1" }),
    )]);
    let o = Run::new().with_key(&mock.api()).run_stdin(
        &[
            "issue",
            "update",
            "BUG-1",
            "--data",
            "-",
            "--status",
            "done",
            "--unset",
            "assigneeId",
        ],
        r#"{"title":"New title","status":"todo"}"#,
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        mock.last().json(),
        json!({ "title": "New title", "status": "done", "assigneeId": null })
    );
}

#[test]
fn delete_returns_ok_and_dry_run_sends_nothing() {
    let mock = Mock::start(vec![route(
        "DELETE",
        "/api/w/acme/issues/BUG-1",
        204,
        Value::Null,
    )]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["issue", "delete", "BUG-1", "--dry-run"]);
    assert_eq!(code(&o), 0);
    assert_eq!(out_json(&o)["request"]["method"], "DELETE");
    assert!(mock.requests().is_empty(), "dry-run must not call the API");
    let o = run.run(&["issue", "delete", "BUG-1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o), json!({ "ok": true }));
}

#[test]
fn maps_http_errors_to_stable_exit_codes() {
    let cases: [(u16, i32, &str); 6] = [
        (401, 3, "auth"),
        (403, 3, "auth"),
        (404, 4, "not_found"),
        (409, 6, "conflict"),
        (429, 5, "rate_limited"),
        (400, 8, "validation"),
    ];
    for (status, exit, name) in cases {
        let mock = Mock::start(vec![route(
            "GET",
            "/api/w/acme/issues/BUG-1",
            status,
            json!({ "statusCode": status, "message": "nope here" }),
        )]);
        let o = Run::new()
            .with_key(&mock.api())
            .run(&["issue", "get", "BUG-1"]);
        assert_eq!(code(&o), exit, "status {status}: {}", stderr(&o));
        let e = err_json(&o);
        assert_eq!(e["error"]["code"], name);
        assert_eq!(e["error"]["status"], status);
        assert_eq!(e["error"]["message"], "nope here");
        assert!(stdout(&o).is_empty());
        if status == 429 {
            assert_eq!(mock.requests().len(), 1, "a 429 must never be retried");
        }
    }
}

#[test]
fn server_errors_on_reads_are_retried_but_writes_are_not() {
    let mock = Mock::start(vec![
        route(
            "GET",
            "/api/w/acme/teams",
            503,
            json!({ "message": "down" }),
        ),
        route(
            "POST",
            "/api/w/acme/comments",
            503,
            json!({ "message": "down" }),
        ),
    ]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["team", "list"]);
    assert_eq!(code(&o), 7);
    assert_eq!(mock.requests().len(), 3);
    let o = run.run(&[
        "comment",
        "create",
        "--subject",
        "issue:iss_1",
        "--body",
        "hi",
    ]);
    assert_eq!(code(&o), 7);
    assert_eq!(
        mock.requests().len(),
        4,
        "a failed write is sent exactly once"
    );
}

#[test]
fn not_signed_in_is_an_auth_error_with_a_hint() {
    let o = Run::new().run(&["issue", "list"]);
    assert_eq!(code(&o), 3);
    let e = err_json(&o);
    assert_eq!(e["error"]["code"], "auth");
    assert!(e["error"]["hint"].as_str().unwrap().contains("trama login"));
}

#[test]
fn usage_errors_are_json_and_name_what_is_missing() {
    let run = Run::new();
    let e = err_json(&run.run(&["issue", "update"]));
    assert_eq!(e["error"]["code"], "usage");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("<ID_OR_KEY>"),
        "{e}"
    );
    let e = err_json(&run.run(&["issue", "create", "--title", "x"]));
    assert_eq!(e["error"]["message"], "missing required option --kind");
    let e = err_json(&run.run(&["issue", "create", "--kind", "nope", "--title", "x"]));
    assert!(
        e["error"]["message"].as_str().unwrap().contains("nope"),
        "{e}"
    );
    assert_eq!(code(&run.run(&["no-such-command"])), 2);
    // help and version are not errors
    assert_eq!(code(&run.run(&["--help"])), 0);
    assert_eq!(code(&run.run(&["issue", "create", "--help"])), 0);
    assert!(stdout(&run.run(&["--version"])).starts_with("trama "));
}

#[test]
fn refuses_plain_http_to_remote_hosts_and_unknown_key_formats() {
    let o = Run::new()
        .env("TRAMA_API_KEY", "nbl_x")
        .env("TRAMA_API_URL", "http://trama.example.com/api")
        .run(&["whoami"]);
    assert_eq!(code(&o), 2);
    assert!(
        err_json(&o)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("plain http")
    );
    let o = Run::new()
        .env("TRAMA_API_KEY", "ghp_notmine")
        .env("TRAMA_API_URL", "https://x.example.com")
        .run(&["whoami"]);
    assert_eq!(code(&o), 3);
}

#[test]
fn workstream_context_is_markdown_by_default_and_json_on_request() {
    let md = Route {
        method: "GET",
        path: "/api/w/acme/workstreams/AUTH-42/context",
        status: 200,
        content_type: "text/markdown; charset=utf-8",
        body: "# AUTH-42\n\nBriefing\n".into(),
        headers: vec![],
    };
    let mock = Mock::start(vec![md]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["workstream", "context", "AUTH-42"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o), "# AUTH-42\n\nBriefing\n");
    assert!(mock.last().headers["accept"].starts_with("text/markdown"));
    run.run(&["workstream", "context", "AUTH-42", "-o", "json"]);
    assert_eq!(mock.last().headers["accept"], "application/json");
}

#[test]
fn project_updates_are_posted_edited_and_removed_under_the_project() {
    let mock = Mock::start(vec![
        route(
            "POST",
            "/api/w/acme/projects/prj_1/updates",
            201,
            json!({ "id": "pu_1", "health": "at_risk" }),
        ),
        route(
            "PATCH",
            "/api/w/acme/projects/prj_1/updates/pu_1",
            200,
            json!({ "id": "pu_1", "health": "on_track" }),
        ),
        route(
            "DELETE",
            "/api/w/acme/projects/prj_1/updates/pu_1",
            204,
            Value::Null,
        ),
        route(
            "GET",
            "/api/w/acme/projects/prj_1/updates",
            200,
            json!([{ "id": "pu_1" }]),
        ),
    ]);
    let run = Run::new().with_key(&mock.api());
    std::fs::write(run.cwd.join("update.md"), "Shipped the importer.\n").unwrap();
    let o = run.run(&[
        "project-update",
        "post",
        "prj_1",
        "--health",
        "at_risk",
        "--file",
        "body=update.md",
    ]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        mock.last().json(),
        json!({ "health": "at_risk", "body": "Shipped the importer." })
    );
    let o = run.run(&[
        "project-update",
        "edit",
        "prj_1",
        "pu_1",
        "--health",
        "on_track",
    ]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(mock.last().json(), json!({ "health": "on_track" }));
    assert_eq!(
        code(&run.run(&["project-update", "rm", "prj_1", "pu_1"])),
        0
    );
    assert_eq!(
        out_json(&run.run(&["project-updates", "ls", "prj_1"])),
        json!([{ "id": "pu_1" }])
    );
    // health is an enum
    assert_eq!(
        code(&run.run(&[
            "project-update",
            "create",
            "prj_1",
            "--health",
            "fine",
            "--body",
            "x"
        ])),
        2
    );
}

#[test]
fn project_context_is_markdown_and_artifacts_attach_to_any_owner() {
    let md = Route {
        method: "GET",
        path: "/api/w/acme/projects/prj_1/context.md",
        status: 200,
        content_type: "text/markdown; charset=utf-8",
        body: "# Project\n\nMega context\n".into(),
        headers: vec![],
    };
    let mock = Mock::start(vec![
        md,
        route(
            "POST",
            "/api/w/acme/artifacts",
            201,
            json!({ "id": "art_1" }),
        ),
        route("GET", "/api/w/acme/issues/BUG-1/artifacts", 200, json!([])),
    ]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["project", "context", "prj_1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o), "# Project\n\nMega context\n");
    assert!(mock.last().headers["accept"].starts_with("text/markdown"));
    let o = run.run(&[
        "artifact",
        "add",
        "--project-id",
        "prj_1",
        "--issue-id",
        "BUG-1",
        "--kind",
        "link",
        "--title",
        "Spec",
        "--url",
        "https://x.test",
    ]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        mock.last().json(),
        json!({ "projectId": "prj_1", "issueId": "BUG-1", "kind": "link", "title": "Spec", "url": "https://x.test" })
    );
    assert_eq!(code(&run.run(&["issue", "artifacts", "BUG-1"])), 0);
}

#[test]
fn api_escape_hatch_validates_paths() {
    let mock = Mock::start(vec![route(
        "GET",
        "/api/w/acme/integrations",
        200,
        json!([{ "id": "int_1" }]),
    )]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["api", "get", "/integrations", "-Q", "x=1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)[0]["id"], "int_1");
    assert!(mock.last().target.ends_with("?x=1"));
    for bad in ["/../auth/me", "/issues?x=1", "issues"] {
        assert_eq!(code(&run.run(&["api", "GET", bad])), 2, "{bad}");
    }
}

#[test]
fn login_with_token_saves_a_private_profile_and_later_calls_need_no_env() {
    let mock = Mock::start(vec![
        route("GET", "/api/auth/token", 200, identity(&["issues:read"])),
        route("GET", "/api/w/acme/issues", 200, json!([])),
    ]);
    let run = Run::new();
    let o = run.run_stdin(
        &["login", "--with-token", "--api-url", &mock.api()],
        "nbl_secretvalue123\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["workspace"]["slug"], "acme");
    assert!(
        !stdout(&o).contains("secretvalue"),
        "the key must never be echoed"
    );

    let file = run.config.join("config.json");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["profiles"]["default"]["token"], "nbl_secretvalue123");
    assert_eq!(saved["profiles"]["default"]["workspace"], "acme");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let before = mock.requests().len();
    let o = run.run(&["issue", "list"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let calls: Vec<String> = mock.requests()[before..]
        .iter()
        .map(|r| r.path().to_string())
        .collect();
    assert_eq!(
        calls,
        vec!["/api/w/acme/issues"],
        "the saved slug avoids an introspection round trip"
    );

    let o = run.run(&["profile", "list"]);
    let rows = out_json(&o);
    assert_eq!(rows[0]["name"], "default");
    assert_eq!(rows[0]["token"], "nbl_secr…");
    assert!(!stdout(&o).contains("secretvalue123"));
}

#[test]
fn login_accepts_a_site_url_and_rejects_bad_keys() {
    let mock = Mock::start(vec![route(
        "GET",
        "/api/auth/token",
        401,
        json!({ "message": "Invalid token" }),
    )]);
    let run = Run::new();
    let o = run.run_stdin(
        &[
            "login",
            "--with-token",
            "--api-url",
            &mock.api().replace("/api", ""),
        ],
        "nbl_revoked\n",
    );
    assert_eq!(code(&o), 3);
    assert!(
        !run.config.join("config.json").exists(),
        "nothing is saved when the key is rejected"
    );
    let o = run.run_stdin(
        &["login", "--with-token", "--api-url", &mock.api()],
        "not-a-key\n",
    );
    assert_eq!(code(&o), 3);
}

#[test]
fn login_with_email_mints_a_token_and_closes_the_session() {
    let mut login = route(
        "POST",
        "/api/auth/login",
        200,
        json!({ "user": { "id": "usr_1" }, "workspaces": [{ "id": "ws_1", "slug": "acme", "name": "Acme", "role": "member" }] }),
    );
    login.headers.push((
        "Set-Cookie",
        "nabla_session=sess123; Path=/; HttpOnly".into(),
    ));
    let mock = Mock::start(vec![
        login,
        route(
            "POST",
            "/api/w/acme/tokens",
            201,
            json!({ "token": { "id": "tok_2" }, "secret": "nbl_minted_for_this_machine" }),
        ),
        route("POST", "/api/auth/logout", 204, Value::Null),
        route("GET", "/api/auth/token", 200, identity(&["issues:read"])),
    ]);
    let run = Run::new();
    let o = run.run_stdin(
        &[
            "login",
            "--email",
            "ann@example.com",
            "--password-stdin",
            "--api-url",
            &mock.api(),
            "--scope",
            "write",
            "--expires-in",
            "30d",
            "--token-name",
            "laptop",
        ],
        "hunter2hunter2\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let reqs = mock.requests();
    let paths: Vec<&str> = reqs.iter().map(|r| r.path()).collect();
    assert_eq!(
        paths,
        vec![
            "/api/auth/login",
            "/api/w/acme/tokens",
            "/api/auth/logout",
            "/api/auth/token"
        ]
    );
    assert_eq!(
        reqs[0].json(),
        json!({ "email": "ann@example.com", "password": "hunter2hunter2" })
    );
    assert_eq!(reqs[1].headers["cookie"], "nabla_session=sess123");
    let minted = reqs[1].json();
    assert_eq!(
        (minted["name"].as_str(), minted["scope"].as_str()),
        (Some("laptop"), Some("write"))
    );
    assert!(minted["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(reqs[2].headers["cookie"], "nabla_session=sess123");
    assert_eq!(
        reqs[3].headers["authorization"],
        "Bearer nbl_minted_for_this_machine"
    );
    let saved = std::fs::read_to_string(run.config.join("config.json")).unwrap();
    assert!(
        saved.contains("nbl_minted_for_this_machine") && !saved.contains("hunter2"),
        "the password is never stored"
    );
}

#[test]
fn login_with_a_wrong_password_fails_cleanly() {
    let mock = Mock::start(vec![route(
        "POST",
        "/api/auth/login",
        401,
        json!({ "message": "Invalid credentials" }),
    )]);
    let o = Run::new().run_stdin(
        &[
            "login",
            "--email",
            "ann@example.com",
            "--password-stdin",
            "--api-url",
            &mock.api(),
        ],
        "wrong\n",
    );
    assert_eq!(code(&o), 3);
    assert_eq!(mock.requests().len(), 1);
}

#[test]
fn logout_can_revoke_the_key_server_side() {
    let mock = Mock::start(vec![
        route("GET", "/api/auth/token", 200, identity(&["tokens:delete"])),
        route("DELETE", "/api/w/acme/tokens/tok_1", 204, Value::Null),
    ]);
    let run = Run::new();
    run.run_stdin(
        &["login", "--with-token", "--api-url", &mock.api()],
        "nbl_tobe_revoked\n",
    );
    let o = run.run(&["logout", "--revoke"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["revoked"], json!(["default"]));
    assert_eq!(mock.last().method, "DELETE");
    let o = run.run(&["profile", "list"]);
    assert_eq!(out_json(&o), json!([]));
    assert_eq!(code(&run.run(&["issue", "list"])), 3);
}

#[test]
fn doctor_reports_each_check_and_fails_on_a_bad_key() {
    let good = Mock::start(vec![
        route("GET", "/api/health", 200, json!({ "status": "ok" })),
        route("GET", "/api/auth/token", 200, identity(&["issues:read"])),
    ]);
    let o = Run::new().with_key(&good.api()).run(&["doctor"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let checks = out_json(&o);
    assert!(
        checks.as_array().unwrap().iter().all(|c| c["ok"] == true),
        "{checks}"
    );
    assert!(
        checks
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["check"] == "token")
    );

    let bad = Mock::start(vec![
        route("GET", "/api/health", 200, json!({})),
        route(
            "GET",
            "/api/auth/token",
            401,
            json!({ "message": "revoked" }),
        ),
    ]);
    let o = Run::new().with_key(&bad.api()).run(&["doctor"]);
    assert_eq!(code(&o), 3);
    assert!(
        out_json(&o)
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["check"] == "token" && c["ok"] == false)
    );
}

#[test]
fn mcp_stdio_serves_only_the_tools_the_key_may_use() {
    let mock = Mock::start(vec![
        route("GET", "/api/auth/token", 200, identity(&["issues:read"])),
        route(
            "GET",
            "/api/w/acme/issues",
            200,
            json!([{ "key": "BUG-1" }]),
        ),
    ]);
    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_issues", "arguments": {} } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let o = Run::new().with_key(&mock.api()).run_stdin(&["mcp"], &input);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let replies: Vec<Value> = stdout(&o)
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout carries only JSON-RPC"))
        .collect();
    assert_eq!(replies.len(), 3, "the notification gets no reply");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "trama-mcp");
    let names: Vec<&str> = replies[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"list_issues") && !names.contains(&"delete_issue"));
    assert!(
        replies[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("BUG-1")
    );
}

/// The mock answers `/auth/token` according to which key asked, so two workspaces can share one server.
fn handle_keyed(mut stream: TcpStream, log: &Arc<Mutex<Vec<Recorded>>>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (
        first.next().unwrap_or("").to_string(),
        first.next().unwrap_or("").to_string(),
    );
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let path = target.split('?').next().unwrap_or("").to_string();
    log.lock().unwrap().push(Recorded {
        method,
        target,
        headers: headers.clone(),
        body: String::new(),
    });
    let key = headers
        .get("authorization")
        .map(String::as_str)
        .unwrap_or("");
    let body = if path == "/api/auth/token" {
        match key {
            "Bearer nbl_acme" => identity_in("acme", "Acme", &["issues:read"]),
            "Bearer nbl_beta" => identity_in("beta", "Beta", &["issues:read"]),
            _ => json!({ "message": "unknown key" }),
        }
    } else if path == "/api/w/acme/issues" {
        json!([{ "key": "BUG-1", "title": "from acme" }])
    } else if path == "/api/w/beta/issues" {
        json!([{ "key": "BUG-2", "title": "from beta" }])
    } else {
        json!({ "message": "no such route" })
    };
    let status = if path == "/api/auth/token" && !key.starts_with("Bearer nbl_") {
        401
    } else {
        200
    };
    let text = body.to_string();
    let resp = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn mock_two_workspaces() -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (log2, stop2) = (log.clone(), stop.clone());
    thread::spawn(move || {
        for stream in listener.incoming() {
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(stream) = stream {
                handle_keyed(stream, &log2);
            }
        }
    });
    Mock { port, log, stop }
}

#[test]
fn account_add_saves_one_profile_per_token_and_reads_span_them() {
    let mock = mock_two_workspaces();
    let run = Run::new();
    let o = run.run_stdin(
        &[
            "account",
            "add",
            "--with-token",
            "--api-url",
            &mock.api(),
            "--name",
            "work",
        ],
        "nbl_acme\nnbl_beta\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let added = out_json(&o);
    assert_eq!(added["account"], "work");
    assert_eq!(added["added"].as_array().unwrap().len(), 2);

    let listed = out_json(&run.run(&["account", "list"]));
    assert_eq!(listed[0]["name"], "work");
    assert_eq!(listed[0]["profiles"], 2);

    // Without a selection only the current profile is read, exactly as before.
    let one = out_json(&run.run(&["issue", "list"]));
    assert!(
        one.as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("workspace").is_none())
    );

    let both = out_json(&run.run(&["issue", "list", "--account", "work"]));
    let keys: Vec<&str> = both
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["key"].as_str())
        .collect();
    assert_eq!(keys, vec!["BUG-1", "BUG-2"]);
    assert!(
        both.as_array()
            .unwrap()
            .iter()
            .all(|row| row["workspace"].as_str().is_some())
    );

    // A write must not be fanned out: it would create the issue in every workspace.
    let o = run.run(&[
        "issue",
        "create",
        "--account",
        "work",
        "--kind",
        "bug",
        "--title",
        "x",
    ]);
    assert_eq!(code(&o), 2);
    assert!(
        err_json(&o)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("exactly one workspace")
    );

    let o = run.run(&["account", "remove", "work"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        out_json(&run.run(&["profile", "list"]))
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn account_add_with_email_mints_one_key_per_workspace() {
    let mut login = route(
        "POST",
        "/api/auth/login",
        200,
        json!({ "workspaces": [{ "slug": "acme", "name": "Acme" }, { "slug": "beta", "name": "Beta" }] }),
    );
    login.headers.push((
        "Set-Cookie",
        "nabla_session=sess123; Path=/; HttpOnly".into(),
    ));
    let mock = Mock::start(vec![
        login,
        route(
            "POST",
            "/api/w/acme/tokens",
            201,
            json!({ "secret": "nbl_minted_acme" }),
        ),
        route(
            "POST",
            "/api/w/beta/tokens",
            201,
            json!({ "secret": "nbl_minted_beta" }),
        ),
        route("POST", "/api/auth/logout", 204, Value::Null),
        route("GET", "/api/auth/token", 200, identity(&["issues:read"])),
    ]);
    let run = Run::new();
    let o = run.run_stdin(
        &[
            "account",
            "add",
            "--email",
            "ann@example.com",
            "--password-stdin",
            "--api-url",
            &mock.api(),
            "--name",
            "work",
            "--workspace",
            "acme",
        ],
        "hunter2hunter2\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        out_json(&o)["added"].as_array().unwrap().len(),
        1,
        "--workspace keeps it to the one asked for"
    );
    let requests = mock.requests();
    let minted: Vec<&str> = requests
        .iter()
        .filter(|r| r.method == "POST" && r.path().ends_with("/tokens"))
        .map(|r| r.path())
        .collect();
    assert_eq!(minted, vec!["/api/w/acme/tokens"]);
}

#[test]
fn mcp_stdio_reads_across_every_saved_profile() {
    let mock = mock_two_workspaces();
    let run = Run::new();
    let o = run.run_stdin(
        &[
            "account",
            "add",
            "--with-token",
            "--api-url",
            &mock.api(),
            "--name",
            "work",
        ],
        "nbl_acme\nnbl_beta\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));

    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_accounts" } }),
        json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "list_issues", "arguments": {} } }),
        json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "list_issues", "arguments": { "workspace": "beta" } } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let o = run.run_stdin(&["mcp"], &input);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let replies: Vec<Value> = stdout(&o)
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout carries only JSON-RPC"))
        .collect();
    assert_eq!(replies.len(), 5);
    assert!(
        replies[0]["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("acme")
    );
    let tools = &replies[1]["result"]["tools"];
    assert!(
        tools
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "list_accounts")
    );
    assert!(
        tools
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "list_issues"
                && t["inputSchema"]["properties"].get("workspace").is_some())
    );

    let accounts: Value =
        serde_json::from_str(replies[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let slugs: Vec<&str> = accounts
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["workspace"].as_str())
        .collect();
    assert_eq!(slugs, vec!["acme", "beta"]);

    let rows: Value =
        serde_json::from_str(replies[3]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let keys: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["key"].as_str())
        .collect();
    assert_eq!(keys, vec!["BUG-1", "BUG-2"]);

    let only: Value =
        serde_json::from_str(replies[4]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(only[0]["key"], "BUG-2");
}

#[test]
fn mcp_config_prints_client_snippets() {
    let run = Run::new().env("TRAMA_API_URL", "https://trama.example.com");
    let o = run.run(&["mcp", "config"]);
    assert_eq!(stdout(&o).trim(), "claude mcp add trama -- trama mcp");
    let o = run.run(&["mcp", "config", "--client", "cursor", "--transport", "http"]);
    assert_eq!(
        out_json(&o)["mcpServers"]["trama"]["url"],
        "https://trama.example.com/mcp"
    );
}

#[test]
fn commands_and_schema_describe_the_whole_surface() {
    let run = Run::new();
    let all = out_json(&run.run(&["commands"]));
    assert!(all.as_array().unwrap().len() > 90);
    let detail = out_json(&run.run(&["commands", "issue", "--detail"]));
    let create = detail
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["command"] == "issue create")
        .unwrap();
    assert!(
        create["params"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["flag"] == "--kind" && p["required"] == true)
    );
    let s = out_json(&run.run(&["schema", "create_issue"]));
    assert_eq!(s["command"], "trama issue create");
    assert_eq!(s["inputSchema"]["required"], json!(["kind", "title"]));
    assert_eq!(code(&run.run(&["schema", "issue", "nope"])), 2);
    assert_eq!(code(&run.run(&["commands", "nope"])), 2);
}

#[test]
fn skill_installs_idempotently_and_never_clobbers_edits() {
    let run = Run::new();
    let dir = run.cwd.join("skills");
    let d = dir.to_str().unwrap();
    let o = run.run(&["skill", "install", "--dir", d]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let file = dir.join("trama-cli").join("SKILL.md");
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .replace("\r\n", "\n")
            .starts_with("---\nname: trama-cli")
    );
    assert_eq!(code(&run.run(&["skill", "install", "--dir", d])), 0);
    std::fs::write(&file, "mine").unwrap();
    assert_eq!(code(&run.run(&["skill", "install", "--dir", d])), 2);
    assert_eq!(
        code(&run.run(&["skill", "install", "--dir", d, "--force"])),
        0
    );
    assert_eq!(
        stdout(&run.run(&["skill", "show"])).trim_end(),
        std::fs::read_to_string(&file).unwrap().trim_end()
    );
}

#[test]
fn completion_scripts_are_generated() {
    for shell in ["bash", "zsh", "fish", "powershell"] {
        let o = Run::new().run(&["completion", shell]);
        assert_eq!(code(&o), 0, "{shell}");
        assert!(stdout(&o).contains("trama"), "{shell}");
    }
}

/// Splits a shell line the way the examples in SKILL.md need: single/double quotes and `#` comments.
fn shell_words(line: &str) -> Vec<String> {
    let (mut words, mut cur, mut quote, mut started) = (vec![], String::new(), None::<char>, false);
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, '#') if !started && cur.is_empty() => break,
            (None, c) if c.is_whitespace() => {
                if started || !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if started || !cur.is_empty() {
        words.push(cur);
    }
    words
}

#[test]
fn every_example_in_the_skill_is_a_valid_command() {
    let skill = include_str!("../../skills/trama-cli/SKILL.md");
    let run = Run::new();
    std::fs::write(run.cwd.join("notes.md"), "notes").unwrap();
    let skip = [
        "login", "whoami", "doctor", "commands", "schema", "skill", "mcp", "update", "event",
    ];
    let mut checked = 0;
    let mut in_code = false;
    for line in skill.lines() {
        if line.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        let words = shell_words(line);
        if !in_code
            || words.first().map(String::as_str) != Some("trama")
            || words.len() < 2
            || words[1].starts_with('<')
        {
            continue; // not a command line, or the generic `trama <resource> <verb>` syntax line
        }
        let args: Vec<&str> = words[1..].iter().map(String::as_str).collect();
        let is_help = args.contains(&"--help");
        if (skip.contains(&args[0]) && !(args[0] == "event" && args[1] == "list")) || is_help {
            continue;
        }
        let mut full = args.clone();
        full.push("--dry-run");
        let o = run.run(&full);
        assert_eq!(
            code(&o),
            0,
            "SKILL.md example does not run: `{line}`\n{}",
            stderr(&o)
        );
        checked += 1;
    }
    assert!(checked >= 15, "only {checked} examples were checked");
}
