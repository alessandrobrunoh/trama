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
        identity(&["tasks:write", "tasks:read"]),
    )]);
    let o = Run::new().with_key(&mock.api()).run(&["whoami"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["workspace"]["slug"], "acme");
    assert_eq!(v["permissions"], json!(["tasks:read", "tasks:write"]));
    assert!(v["token"].get("tokenHash").is_none());
    assert_eq!(mock.last().headers["authorization"], "Bearer nbl_test");
}

#[test]
fn lists_with_filters_projection_and_compact_json() {
    let issues = json!([{ "id": "iss_1", "key": "BUG-1", "title": "Crash", "status": "todo", "body": "long" }, { "id": "iss_2", "key": "BUG-2", "title": "Slow", "status": "done" }]);
    let mock = Mock::start(vec![route("GET", "/api/w/acme/tasks", 200, issues)]);
    let o = Run::new().with_key(&mock.api()).run(&[
        "task",
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
        "/api/w/acme/tasks",
        201,
        json!({ "id": "iss_9", "key": "BUG-9" }),
    )]);
    let run = Run::new().with_key(&mock.api());
    std::fs::write(run.cwd.join("notes.md"), "line one\n\n**line two**\n").unwrap();
    let o = run.run(&[
        "task",
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
        "/api/w/acme/tasks/BUG-1",
        200,
        json!({ "key": "BUG-1" }),
    )]);
    let o = Run::new().with_key(&mock.api()).run_stdin(
        &[
            "task",
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
        "/api/w/acme/tasks/BUG-1",
        204,
        Value::Null,
    )]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["task", "delete", "BUG-1", "--dry-run"]);
    assert_eq!(code(&o), 0);
    assert_eq!(out_json(&o)["request"]["method"], "DELETE");
    assert!(mock.requests().is_empty(), "dry-run must not call the API");
    let o = run.run(&["task", "delete", "BUG-1"]);
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
            "/api/w/acme/tasks/BUG-1",
            status,
            json!({ "statusCode": status, "message": "nope here" }),
        )]);
        let o = Run::new()
            .with_key(&mock.api())
            .run(&["task", "get", "BUG-1"]);
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
fn issue_get_reports_artifact_count_without_an_artifact_request() {
    let mock = Mock::start(vec![route(
        "GET",
        "/api/w/acme/tasks/BUG-1",
        200,
        json!({ "key": "BUG-1", "title": "A bug", "status": "todo", "artifactCount": 0 }),
    )]);
    let o = Run::new().with_key(&mock.api()).run(&[
        "task",
        "get",
        "BUG-1",
        "--fields",
        "key,title,status,artifactCount",
    ]);

    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        out_json(&o),
        json!({ "key": "BUG-1", "title": "A bug", "status": "todo", "artifactCount": 0 })
    );
    assert_eq!(mock.requests().len(), 1);
}

#[test]
fn server_errors_on_reads_are_retried_but_writes_are_not() {
    let mock = Mock::start(vec![
        route(
            "GET",
            "/api/w/acme/projects",
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
    let o = run.run(&["project", "list"]);
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
    let o = Run::new().run(&["task", "list"]);
    assert_eq!(code(&o), 3);
    let e = err_json(&o);
    assert_eq!(e["error"]["code"], "auth");
    assert!(e["error"]["hint"].as_str().unwrap().contains("trama login"));
}

#[test]
fn usage_errors_are_json_and_name_what_is_missing() {
    let run = Run::new();
    let e = err_json(&run.run(&["task", "update"]));
    assert_eq!(e["error"]["code"], "usage");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("<ID_OR_KEY>"),
        "{e}"
    );
    let e = err_json(&run.run(&["task", "create", "--title", "x"]));
    assert_eq!(e["error"]["message"], "missing required option --kind");
    let e = err_json(&run.run(&["task", "create", "--kind", "nope", "--title", "x"]));
    assert!(
        e["error"]["message"].as_str().unwrap().contains("nope"),
        "{e}"
    );
    assert_eq!(code(&run.run(&["no-such-command"])), 2);
    // help and version are not errors
    assert_eq!(code(&run.run(&["--help"])), 0);
    assert_eq!(code(&run.run(&["task", "create", "--help"])), 0);
    assert!(stdout(&run.run(&["--version"])).starts_with("trama "));
}

#[test]
fn refuses_plain_http_to_remote_hosts_and_unknown_key_formats() {
    let o = Run::new()
        .env("TRAMA_API_KEY", "trm_x")
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
fn issue_context_is_markdown_by_default_and_json_on_request() {
    let md = Route {
        method: "GET",
        path: "/api/w/acme/tasks/BUG-42/context",
        status: 200,
        content_type: "text/markdown; charset=utf-8",
        body: "# BUG-42\n\nBriefing\n".into(),
        headers: vec![],
    };
    let mock = Mock::start(vec![md]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["task", "context", "BUG-42"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o), "# BUG-42\n\nBriefing\n");
    assert!(mock.last().headers["accept"].starts_with("text/markdown"));
    run.run(&["task", "context", "BUG-42", "-o", "json"]);
    assert_eq!(mock.last().headers["accept"], "application/json");
}

#[test]
fn artifacts_attach_to_a_task_and_project_level_commands_are_gone() {
    let mock = Mock::start(vec![
        route(
            "POST",
            "/api/w/acme/artifacts",
            201,
            json!({ "id": "art_1" }),
        ),
        route("GET", "/api/w/acme/tasks/BUG-1/artifacts", 200, json!([])),
    ]);
    let run = Run::new().with_key(&mock.api());
    for gone in [
        &["project", "context", "prj_1"][..],
        &["project", "artifacts", "prj_1"],
        &["project-update", "list", "prj_1"],
        &["document", "list"],
    ] {
        assert_eq!(code(&run.run(gone)), 2, "{gone:?}");
    }
    let o = run.run(&[
        "artifact",
        "add",
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
        json!({ "issueId": "BUG-1", "kind": "link", "title": "Spec", "url": "https://x.test" })
    );
    assert_eq!(code(&run.run(&["task", "artifacts", "BUG-1"])), 0);
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
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
        route("GET", "/api/w/acme/tasks", 200, json!([])),
    ]);
    let run = Run::new();
    let o = run.run_stdin(
        &["login", "--with-token", "--api-url", &mock.api()],
        "trm_secretvalue123\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["workspace"]["slug"], "acme");
    assert!(
        !stdout(&o).contains("secretvalue"),
        "the key must never be echoed"
    );

    let file = run.config.join("config.json");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["profiles"]["default"]["token"], "trm_secretvalue123");
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
    let o = run.run(&["task", "list"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let calls: Vec<String> = mock.requests()[before..]
        .iter()
        .map(|r| r.path().to_string())
        .collect();
    assert_eq!(
        calls,
        vec!["/api/w/acme/tasks"],
        "the saved slug avoids an introspection round trip"
    );

    let o = run.run(&["profile", "list"]);
    let rows = out_json(&o);
    assert_eq!(rows[0]["name"], "default");
    assert_eq!(rows[0]["token"], "trm_secr…");
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
        "trm_revoked\n",
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
        "trama_session=sess123; Path=/; HttpOnly".into(),
    ));
    let mock = Mock::start(vec![
        login,
        route(
            "POST",
            "/api/w/acme/tokens",
            201,
            json!({ "token": { "id": "tok_2" }, "secret": "trm_minted_for_this_machine" }),
        ),
        route("POST", "/api/auth/logout", 204, Value::Null),
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
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
    assert_eq!(reqs[1].headers["cookie"], "trama_session=sess123");
    let minted = reqs[1].json();
    assert_eq!(
        (minted["name"].as_str(), minted["scope"].as_str()),
        (Some("laptop"), Some("write"))
    );
    assert!(minted["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(reqs[2].headers["cookie"], "trama_session=sess123");
    assert_eq!(
        reqs[3].headers["authorization"],
        "Bearer trm_minted_for_this_machine"
    );
    let saved = std::fs::read_to_string(run.config.join("config.json")).unwrap();
    assert!(
        saved.contains("trm_minted_for_this_machine") && !saved.contains("hunter2"),
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
        "trm_tobe_revoked\n",
    );
    let o = run.run(&["logout", "--revoke"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["revoked"], json!(["default"]));
    assert_eq!(mock.last().method, "DELETE");
    let o = run.run(&["profile", "list"]);
    assert_eq!(out_json(&o), json!([]));
    assert_eq!(code(&run.run(&["task", "list"])), 3);
}

#[test]
fn doctor_reports_each_check_and_fails_on_a_bad_key() {
    let good = Mock::start(vec![
        route("GET", "/api/health", 200, json!({ "status": "ok" })),
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
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
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
        route(
            "GET",
            "/api/w/acme/tasks",
            200,
            json!([{ "key": "BUG-1" }]),
        ),
    ]);
    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_tasks", "arguments": {} } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    // `--tools full` lists every catalog tool; the default is the curated core set (next test).
    let o = Run::new()
        .with_key(&mock.api())
        .run_stdin(&["mcp", "--tools", "full"], &input);
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
    assert!(names.contains(&"list_tasks") && !names.contains(&"delete_task"));
    assert!(
        replies[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("BUG-1")
    );
}

#[test]
fn mcp_stdio_lists_the_curated_core_tools_by_default_and_full_on_request() {
    let mock = Mock::start(vec![
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
        route(
            "GET",
            "/api/w/acme/tasks",
            200,
            json!([{ "key": "BUG-1", "title": "t", "status": "todo" }]),
        ),
    ]);
    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "find_work", "arguments": {} } }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "run_tool", "arguments": { "name": "list_tasks" } } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let tool_names = |reply: &Value| -> Vec<String> {
        reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    };
    let replies = |o: &Output| -> Vec<Value> {
        stdout(o)
            .lines()
            .map(|l| serde_json::from_str(l).expect("stdout carries only JSON-RPC"))
            .collect()
    };

    // default: the core profile, from the same shared protocol layer
    let o = Run::new().with_key(&mock.api()).run_stdin(&["mcp"], &input);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stderr(&o).contains("core profile"), "{}", stderr(&o));
    let r = replies(&o);
    let names = tool_names(&r[0]);
    assert!(names.len() < 25, "{names:?}");
    assert!(names.contains(&"get_context".to_string()) && names.contains(&"find_work".to_string()));
    assert!(!names.contains(&"list_tasks".to_string()));
    assert!(r[1]["result"]["content"][0]["text"].as_str().unwrap().contains("BUG-1"));
    assert!(r[2]["result"]["content"][0]["text"].as_str().unwrap().contains("BUG-1"), "run_tool reaches the long tail");

    // the environment switches the profile too, and the flag beats it
    let o = Run::new()
        .with_key(&mock.api())
        .env("TRAMA_MCP_PROFILE", "full")
        .run_stdin(&["mcp"], &input);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(tool_names(&replies(&o)[0]).contains(&"list_tasks".to_string()));
    let o = Run::new()
        .with_key(&mock.api())
        .env("TRAMA_MCP_PROFILE", "full")
        .run_stdin(&["mcp", "--tools", "core"], &input);
    assert!(!tool_names(&replies(&o)[0]).contains(&"list_tasks".to_string()));

    // a typo is a usage error, not a silent fallback
    let o = Run::new()
        .with_key(&mock.api())
        .env("TRAMA_MCP_PROFILE", "everything")
        .run_stdin(&["mcp"], &input);
    assert_eq!(code(&o), 2, "{}", stderr(&o));
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
            "Bearer trm_acme" => identity_in("acme", "Acme", &["tasks:read"]),
            "Bearer trm_beta" => identity_in("beta", "Beta", &["tasks:read"]),
            _ => json!({ "message": "unknown key" }),
        }
    } else if path == "/api/w/acme/tasks" {
        json!([{ "key": "BUG-1", "title": "from acme" }])
    } else if path == "/api/w/beta/tasks" {
        json!([{ "key": "BUG-2", "title": "from beta" }])
    } else {
        json!({ "message": "no such route" })
    };
    let status = if path == "/api/auth/token" && !key.starts_with("Bearer trm_") {
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
        "trm_acme\ntrm_beta\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let added = out_json(&o);
    assert_eq!(added["account"], "work");
    assert_eq!(added["added"].as_array().unwrap().len(), 2);

    let listed = out_json(&run.run(&["account", "list"]));
    assert_eq!(listed[0]["name"], "work");
    assert_eq!(listed[0]["profiles"], 2);

    // Without a selection only the current profile is read, exactly as before.
    let one = out_json(&run.run(&["task", "list"]));
    assert!(
        one.as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("workspace").is_none())
    );

    let both = out_json(&run.run(&["task", "list", "--account", "work"]));
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
        "task",
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
        "trama_session=sess123; Path=/; HttpOnly".into(),
    ));
    let mock = Mock::start(vec![
        login,
        route(
            "POST",
            "/api/w/acme/tokens",
            201,
            json!({ "secret": "trm_minted_acme" }),
        ),
        route(
            "POST",
            "/api/w/beta/tokens",
            201,
            json!({ "secret": "trm_minted_beta" }),
        ),
        route("POST", "/api/auth/logout", 204, Value::Null),
        route("GET", "/api/auth/token", 200, identity(&["tasks:read"])),
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
        "trm_acme\ntrm_beta\n",
    );
    assert_eq!(code(&o), 0, "{}", stderr(&o));

    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_accounts" } }),
        json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "list_tasks", "arguments": {} } }),
        json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "list_tasks", "arguments": { "workspace": "beta" } } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let o = run.run_stdin(&["mcp", "--tools", "full"], &input);
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
            .any(|t| t["name"] == "list_tasks"
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
    assert!(all.as_array().unwrap().len() > 70);
    let detail = out_json(&run.run(&["commands", "task", "--detail"]));
    let create = detail
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["command"] == "task create")
        .unwrap();
    assert!(
        create["params"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["flag"] == "--kind" && p["required"] == true)
    );
    let s = out_json(&run.run(&["schema", "create_task"]));
    assert_eq!(s["command"], "trama task create");
    assert_eq!(s["inputSchema"]["required"], json!(["kind", "title"]));
    assert_eq!(s["inputSchema"]["properties"]["parentId"]["type"], "string");
    let s = out_json(&run.run(&["schema", "update_task"]));
    assert_eq!(
        s["inputSchema"]["properties"]["parentId"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(code(&run.run(&["schema", "task", "nope"])), 2);
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

// ───────────────────────────── tasks: subtasks, estimates, thread link ─────────────────────────────

fn family() -> Value {
    json!([
        { "id": "in_3", "key": "BUG-3", "title": "Grandchild", "status": "todo", "parentId": "in_2", "createdAt": "2026-01-03T00:00:00.000Z" },
        { "id": "in_2", "key": "BUG-2", "title": "Child", "status": "in_progress", "parentId": "in_1", "estimate": 2, "createdAt": "2026-01-02T00:00:00.000Z" },
        { "id": "in_1", "key": "BUG-1", "title": "Parent", "status": "todo", "createdAt": "2026-01-01T00:00:00.000Z" },
        { "id": "in_9", "key": "BUG-9", "title": "Other", "status": "todo", "createdAt": "2026-01-09T00:00:00.000Z" }
    ])
}

fn family_routes() -> Vec<Route> {
    vec![
        route("GET", "/api/w/acme/tasks/BUG-1", 200, json!({ "id": "in_1", "key": "BUG-1", "title": "Parent", "status": "todo", "threadUrl": "https://delta.example/t/1" })),
        route("GET", "/api/w/acme/tasks", 200, family()),
    ]
}

#[test]
fn task_subtasks_prints_a_tree_of_any_depth_as_json_or_indented_text() {
    let mock = Mock::start(family_routes());
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["task", "subtasks", "BUG-1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["task"]["key"], "BUG-1");
    assert_eq!(v["task"]["threadUrl"], "https://delta.example/t/1");
    assert_eq!(v["count"], 2);
    assert_eq!(v["subtasks"][0]["key"], "BUG-2");
    assert_eq!(v["subtasks"][0]["subtasks"][0]["key"], "BUG-3");
    assert!(mock.requests().iter().any(|r| r.path() == "/api/w/acme/tasks" && r.target.contains("limit=500")));

    let o = run.run(&["task", "subtasks", "BUG-1", "-o", "table"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        stdout(&o),
        "BUG-1  todo  Parent\n  BUG-2  in_progress  Child  (2 pt)\n    BUG-3  todo  Grandchild\n"
    );
    let o = run.run(&["task", "subtasks", "BUG-1", "--depth", "1"]);
    assert_eq!(out_json(&o)["count"], 1);
}

#[test]
fn task_list_can_filter_by_parent_without_sending_a_parent_filter() {
    let mock = Mock::start(family_routes());
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["task", "list", "--parent", "BUG-1", "--fields", "key"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o).trim(), r#"[{"key":"BUG-2"}]"#);
    assert!(mock.requests().iter().all(|r| !r.target.contains("parent")), "the API has no parent filter");
    // an id needs no lookup
    let before = mock.requests().len();
    let o = run.run(&["task", "list", "--parent", "in_2", "--limit", "1", "--fields", "key"]);
    assert_eq!(stdout(&o).trim(), r#"[{"key":"BUG-3"}]"#);
    assert_eq!(mock.requests().len(), before + 1);
    // without --parent the plain command is untouched
    let o = run.run(&["task", "list", "--limit", "2", "--fields", "key"]);
    assert_eq!(out_json(&o).as_array().unwrap().len(), 4, "the mock ignores limit; nothing was filtered");
}

#[test]
fn task_threadurl_and_estimate_are_flags_that_can_be_cleared() {
    let run = Run::new();
    let o = run.run(&["task", "create", "--kind", "feature", "--title", "Sub", "--parent-id", "BUG-1", "--thread-url", "https://delta.example/t/9", "--estimate", "3", "--dry-run"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let body = &out_json(&o)["request"]["body"];
    assert_eq!(body["parentId"], "BUG-1");
    assert_eq!(body["threadUrl"], "https://delta.example/t/9");
    assert_eq!(body["estimate"], 3.0);
    let o = run.run(&["task", "update", "BUG-2", "--unset", "estimate,threadUrl,parentId", "--milestone-ids", "ms_1", "--dry-run"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["request"]["body"], json!({ "estimate": null, "threadUrl": null, "parentId": null, "milestoneIds": ["ms_1"] }));
}

#[test]
fn projects_have_no_health_flag_and_match_their_repository_here() {
    let run = Run::new();
    for args in [vec!["project", "create", "--name", "X", "--health", "at_risk"], vec!["project", "update", "pj_1", "--health", "at_risk", "--name", "X"], vec!["project", "list", "--health", "at_risk", "--q", "x"]] {
        let mut full = args.clone();
        full.push("--dry-run");
        assert_eq!(code(&run.run(&full)), 2, "{args:?}");
    }
    let o = run.run(&["project", "create", "--name", "Cora", "--key", "CORA", "--dry-run"]);
    assert_eq!(out_json(&o)["request"]["body"], json!({ "name": "Cora", "key": "CORA" }));

    let mock = Mock::start(vec![route(
        "GET",
        "/api/w/acme/projects",
        200,
        json!([
            { "id": "pj_1", "key": "CORA", "name": "Cora", "repository": "https://github.com/Acme/Cora.git" },
            { "id": "pj_2", "key": "OTH", "name": "Other", "repository": "acme/other" },
            { "id": "pj_3", "key": "NONE", "name": "No repo" }
        ]),
    )]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["project", "list", "--repository", "acme/cora", "--fields", "key"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o).trim(), r#"[{"key":"CORA"}]"#);
    assert!(!mock.last().target.contains("repository"), "{}", mock.last().target);
    let o = run.run(&["project", "list", "--fields", "key"]);
    assert_eq!(out_json(&o).as_array().unwrap().len(), 3);
}

// ───────────────────────────── timer ─────────────────────────────

fn timer_routes() -> Vec<Route> {
    vec![
        route("GET", "/api/w/acme/tasks/BUG-1", 200, json!({ "id": "in_1", "key": "BUG-1", "title": "Login", "status": "todo" })),
        route("GET", "/api/w/acme/tasks/in_1", 200, json!({ "id": "in_1", "key": "BUG-1", "title": "Login", "status": "todo" })),
        route(
            "GET",
            "/api/w/acme/time-entries",
            200,
            json!([
                { "id": "te_2", "issueId": "in_1", "startedAt": "2026-05-01T10:00:00.000Z", "endedAt": null },
                { "id": "te_1", "issueId": "in_1", "startedAt": "2026-05-01T08:00:00.000Z", "endedAt": "2026-05-01T09:30:00.000Z" },
                { "id": "te_0", "issueId": "in_7", "startedAt": "2026-04-30T08:00:00.000Z", "endedAt": "2026-04-30T08:10:00.000Z" }
            ]),
        ),
        route("POST", "/api/w/acme/time-entries/start", 201, json!({ "id": "te_3", "issueId": "in_1", "startedAt": "2026-05-01T11:00:00.000Z", "endedAt": null })),
        route("POST", "/api/w/acme/time-entries/stop", 201, json!({ "id": "te_2", "issueId": "in_1", "startedAt": "2026-05-01T10:00:00.000Z", "endedAt": "2026-05-01T10:20:00.000Z" })),
        route("POST", "/api/w/acme/time-entries", 201, json!({ "id": "te_4", "issueId": "in_1", "startedAt": "2026-05-01T09:00:00.000Z", "endedAt": "2026-05-01T10:15:00.000Z" })),
        route("DELETE", "/api/w/acme/time-entries/te_1", 204, Value::Null),
    ]
}

#[test]
fn timer_start_sends_the_task_id_and_names_the_timer_it_stopped() {
    let mock = Mock::start(timer_routes());
    let o = Run::new().with_key(&mock.api()).run(&["timer", "start", "BUG-1", "--description", "login fix"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["started"], true);
    assert_eq!(v["entry"]["running"], true);
    assert_eq!(v["stopped"]["id"], "te_2");
    let start = mock.requests().into_iter().find(|r| r.path() == "/api/w/acme/time-entries/start").unwrap();
    assert_eq!(start.json(), json!({ "issueId": "in_1", "description": "login fix" }), "the API wants the id, not the key");
}

#[test]
fn timer_stop_status_list_add_and_delete() {
    let mock = Mock::start(timer_routes());
    let run = Run::new().with_key(&mock.api());

    let v = out_json(&run.run(&["timer", "stop"]));
    assert_eq!(v["stopped"], true);
    assert_eq!(v["entry"]["durationSeconds"], 1200);

    let v = out_json(&run.run(&["timer", "status"]));
    assert_eq!(v["running"]["id"], "te_2");
    assert_eq!(v["running"]["running"], true);
    assert_eq!(v["task"]["key"], "BUG-1");

    let v = out_json(&run.run(&["timer", "list", "BUG-1", "--fields", "id,duration"]));
    assert_eq!(v, json!([{ "id": "te_2" }, { "id": "te_1", "duration": "1h 30m" }]));
    assert_eq!(out_json(&run.run(&["timer", "list"])).as_array().unwrap().len(), 3);

    let o = run.run(&["timer", "add", "BUG-1", "--started-at", "2026-05-01T09:00:00Z", "--ended-at", "2026-05-01T10:15:00Z"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["added"], true);
    let add = mock.requests().into_iter().find(|r| r.method == "POST" && r.path() == "/api/w/acme/time-entries").unwrap();
    assert_eq!(add.json(), json!({ "issueId": "in_1", "startedAt": "2026-05-01T09:00:00Z", "endedAt": "2026-05-01T10:15:00Z" }));

    let o = run.run(&["timer", "delete", "te_1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o), json!({ "ok": true }));
}

#[test]
fn timer_validates_locally_and_dry_run_sends_nothing() {
    let mock = Mock::start(timer_routes());
    let run = Run::new().with_key(&mock.api());
    for args in [
        vec!["timer", "add", "in_1", "--started-at", "2026-05-01T10:00:00Z", "--ended-at", "2026-05-01T09:00:00Z"],
        vec!["timer", "add", "in_1", "--started-at", "2026-05-01 10:00", "--ended-at", "2026-05-01T11:00:00Z"],
        vec!["timer", "start", "--description", &"x".repeat(501)],
    ] {
        let o = run.run(&args);
        assert_eq!(code(&o), 2, "{args:?}: {}", stderr(&o));
    }
    assert!(mock.requests().is_empty());
    let o = run.run(&["timer", "start", "BUG-1", "--dry-run"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["request"]["method"], "POST");
    assert!(out_json(&o)["request"]["url"].as_str().unwrap().ends_with("/time-entries/start"));
    assert!(mock.requests().is_empty(), "dry-run must not call the API");
}

#[test]
fn a_custom_token_gets_the_apis_refusal_on_the_timer() {
    let mock = Mock::start(vec![route("GET", "/api/w/acme/time-entries", 403, json!({ "statusCode": 403, "message": "This route is not available to custom API tokens" }))]);
    let o = Run::new().with_key(&mock.api()).run(&["timer", "list"]);
    assert_eq!(code(&o), 3, "{}", stderr(&o));
    assert!(err_json(&o)["error"]["message"].as_str().unwrap().contains("custom API tokens"));
}

#[test]
fn the_new_commands_are_listed_by_commands() {
    let run = Run::new();
    let all = out_json(&run.run(&["commands"]));
    let names: Vec<&str> = all.as_array().unwrap().iter().map(|c| c["command"].as_str().unwrap()).collect();
    for want in ["task subtasks", "timer start", "timer stop", "timer status", "timer list", "timer add", "timer delete"] {
        assert!(names.contains(&want), "{want}");
    }
    assert_eq!(out_json(&run.run(&["commands", "timer"])).as_array().unwrap().len(), 6);
    let tools = out_json(&run.run(&["commands", "project", "--detail"]));
    let flags: Vec<String> = tools.as_array().unwrap().iter().flat_map(|c| c["params"].as_array().cloned().unwrap_or_default()).map(|p| p["name"].as_str().unwrap().to_string()).collect();
    assert!(!flags.iter().any(|f| f == "health"), "project health is not a command flag");
    assert!(flags.iter().any(|f| f == "key"));
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

// ───────────────────────────── the short verbs of /trama ─────────────────────────────

fn short_task() -> Value {
    json!({ "id": "in_1", "key": "BUG-1", "title": "Parent", "kind": "bug", "projectId": "pj_1", "status": "todo", "threadUrl": "https://delta.example/t/1" })
}

#[test]
fn link_sets_the_thread_and_a_conflict_names_the_one_already_linked() {
    let mock = Mock::start(vec![route("PATCH", "/api/w/acme/tasks/BUG-1", 200, json!({ "id": "in_1", "key": "BUG-1", "threadUrl": "https://delta.example/t/2" }))]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["link", "BUG-1", "--thread", "https://delta.example/t/2"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["linked"], true);
    assert_eq!(v["message"], "✓ linked · BUG-1 → https://delta.example/t/2");
    assert_eq!(mock.last().method, "PATCH");
    assert_eq!(mock.last().json(), json!({ "threadUrl": "https://delta.example/t/2" }));

    let o = run.run(&["link", "BUG-1", "--thread", "https://delta.example/t/2", "-o", "table"]);
    assert_eq!(stdout(&o).trim(), "✓ linked · BUG-1 → https://delta.example/t/2");

    // a bare id is joined to the base; without --thread the current thread is used
    let based = Run::new().with_key(&mock.api()).env("TRAMA_THREAD_URL_BASE", "https://delta.example/t/");
    assert_eq!(code(&based.run(&["link", "BUG-1", "--thread", "th_9"])), 0);
    assert_eq!(mock.last().json(), json!({ "threadUrl": "https://delta.example/t/th_9" }));
    let current = Run::new().with_key(&mock.api()).env("DELTA_THREAD_URL", "https://delta.example/t/5");
    assert_eq!(code(&current.run(&["link", "BUG-1"])), 0);
    assert_eq!(mock.last().json(), json!({ "threadUrl": "https://delta.example/t/5" }));

    // no thread at all: a usage error before any request, but --dry-run still shows the request
    let before = mock.requests().len();
    let o = run.run(&["link", "BUG-1"]);
    assert_eq!(code(&o), 2, "{}", stderr(&o));
    assert_eq!(mock.requests().len(), before);
    assert_eq!(code(&run.run(&["link", "BUG-1", "--dry-run"])), 0);
    assert_eq!(code(&run.run(&["link", "BUG-1", "--thread", "not a url", "--dry-run"])), 2);

    let conflict = Mock::start(vec![route(
        "PATCH",
        "/api/w/acme/tasks/BUG-1",
        409,
        json!({ "statusCode": 409, "code": "thread_already_linked", "message": "The task already links a thread", "threadUrl": "https://delta.example/t/1" }),
    )]);
    let o = Run::new().with_key(&conflict.api()).run(&["link", "BUG-1", "--thread", "https://delta.example/t/2"]);
    assert_eq!(code(&o), 6, "{}", stderr(&o));
    let e = err_json(&o);
    assert!(e["error"]["message"].as_str().unwrap().contains("https://delta.example/t/1"), "{e}");
    assert!(e["error"]["hint"].as_str().unwrap().contains("trama sub BUG-1"), "{e}");
}

#[test]
fn sub_creates_a_subtask_in_the_project_and_kind_of_its_parent() {
    let mock = Mock::start(vec![
        route("GET", "/api/w/acme/tasks/BUG-1", 200, short_task()),
        route("POST", "/api/w/acme/tasks", 201, json!({ "id": "in_10", "key": "BUG-10", "title": "Retry metrics", "status": "todo" })),
    ]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["sub", "BUG-1", "Retry metrics", "--thread", "https://delta.example/t/2"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["message"], "✓ BUG-10 created · thread linked");
    assert_eq!(
        mock.last().json(),
        json!({ "title": "Retry metrics", "parentId": "in_1", "kind": "bug", "projectId": "pj_1", "threadUrl": "https://delta.example/t/2" })
    );
    let o = run.run(&["sub", "BUG-1", "Plain"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(mock.last().json().get("threadUrl").is_none());
    assert_eq!(code(&run.run(&["sub", "BUG-1", "   ", "--dry-run"])), 2);
}

#[test]
fn status_accepts_dashes_and_workspace_labels_and_skips_a_no_op() {
    let mock = Mock::start(vec![
        route("GET", "/api/w/acme/tasks/BUG-1", 200, short_task()),
        route("PATCH", "/api/w/acme/tasks/BUG-1", 200, short_task()),
        route("GET", "/api/w/acme", 200, json!({ "settings": { "statuses": { "issue": [{ "id": "st_1", "name": "Planning", "type": "backlog" }] } } })),
    ]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["status", "BUG-1", "in-progress"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["message"], "✓ BUG-1 Todo → In progress");
    assert_eq!(mock.last().method, "PATCH");
    assert_eq!(mock.last().json(), json!({ "status": "in_progress" }));

    assert_eq!(code(&run.run(&["status", "BUG-1", "Planning"])), 0);
    assert_eq!(mock.last().json(), json!({ "status": "backlog" }));

    let patches = || mock.requests().iter().filter(|r| r.method == "PATCH").count();
    let before = patches();
    let o = run.run(&["status", "BUG-1", "todo"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["changed"], false);
    assert_eq!(patches(), before, "nothing to change");

    let o = run.run(&["status", "BUG-1", "bogus"]);
    assert_eq!(code(&o), 2, "{}", stderr(&o));
    assert!(err_json(&o)["error"]["hint"].as_str().unwrap().contains("in_progress"));
    assert_eq!(patches(), before);
}

#[test]
fn sync_sends_one_validated_request_and_prints_the_lines_of_the_skill() {
    let reply = json!({
        "linked": false,
        "decisionsAdded": 2,
        "record": { "syncCount": 3, "threadUrl": "https://delta.example/t/1" },
        "artifact": { "id": "ar_1", "kind": "pull_request" },
        "timeSuggestion": { "id": "te_1", "minutes": 47 }
    });
    let mock = Mock::start(vec![
        route("POST", "/api/w/acme/tasks/BUG-1/thread/sync", 200, reply.clone()),
        route("GET", "/api/w/acme/tasks/BUG-1", 200, short_task()),
        route("GET", "/api/w/acme/projects/pj_1", 200, json!({ "id": "pj_1", "repository": "github.com/acme/web" })),
    ]);
    let run = Run::new().with_key(&mock.api());
    let args = [
        "sync", "BUG-1", "--summary", "Alert wired", "--decision", "Alert after 3 failures@src/auth/,src/queue.ts", "--decision", "Keep it simple", "--file", "./src/a.ts", "--file", "src/a.ts", "--pr",
        "https://github.com/acme/web/pull/423", "--minutes", "47", "--turns", "9",
    ];
    let o = run.run(&args);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(
        mock.last().json(),
        json!({
            "summary": "Alert wired",
            "decisions": [{ "text": "Alert after 3 failures", "paths": ["src/auth/", "src/queue.ts"] }, { "text": "Keep it simple" }],
            "files": ["src/a.ts"],
            "pullRequestUrl": "https://github.com/acme/web/pull/423",
            "activeMinutes": 47,
            "turns": 9
        })
    );
    let v = out_json(&o);
    assert_eq!(v["message"], "✓ summary · 2 decisions · 1 file · 47m suggested\n✓ PR attached");
    assert_eq!((v["decisionsAdded"].clone(), v["syncCount"].clone(), v["artifact"]["id"].clone()), (json!(2), json!(3), json!("ar_1")));

    let mut table = args.to_vec();
    table.extend(["-o", "table"]);
    assert_eq!(stdout(&run.run(&table)).trim(), "✓ summary · 2 decisions · 1 file · 47m suggested\n✓ PR attached");

    // owner/repo#N is read as GitHub through the project's repository
    let o = run.run(&["sync", "BUG-1", "--pr", "acme/web#423"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(mock.last().json(), json!({ "pullRequestUrl": "https://github.com/acme/web/pull/423" }));

    // validation happens before any request
    let before = mock.requests().len();
    for bad in [vec!["sync", "BUG-1", "--minutes", "0"], vec!["sync", "BUG-1", "--file", "../secret"], vec!["sync", "BUG-1", "--decision", "  "], vec!["sync", "BUG-1", "--pr", "not-a-pr"]] {
        let o = run.run(&bad);
        assert!(code(&o) == 2 || code(&o) == 8, "{bad:?}: {} {}", code(&o), stderr(&o));
    }
    // --pr with a short form reads the task and project first, so only compare the writes
    assert!(mock.requests().iter().skip(before).all(|r| r.method == "GET"), "a bad sync sent nothing");

    // a task or --all, never both, and --all needs the current thread
    assert_eq!(code(&run.run(&["sync"])), 2);
    assert_eq!(code(&run.run(&["sync", "BUG-1", "--all"])), 2);
    assert_eq!(code(&run.run(&["sync", "--all", "--summary", "x"])), 2);
}

#[test]
fn sync_reports_a_thread_conflict_and_syncs_every_task_of_the_thread_with_all() {
    let conflict = Mock::start(vec![route(
        "POST",
        "/api/w/acme/tasks/BUG-1/thread/sync",
        409,
        json!({ "statusCode": 409, "code": "thread_already_linked", "message": "linked", "threadUrl": "https://delta.example/t/1" }),
    )]);
    let o = Run::new().with_key(&conflict.api()).run(&["sync", "BUG-1", "--thread", "https://delta.example/t/2", "--summary", "x"]);
    assert_eq!(code(&o), 6, "{}", stderr(&o));
    assert!(err_json(&o)["error"]["message"].as_str().unwrap().contains("https://delta.example/t/1"));

    let done = json!({ "linked": false, "decisionsAdded": 0, "record": { "syncCount": 1 }, "artifact": null, "timeSuggestion": null });
    let mock = Mock::start(vec![
        route(
            "GET",
            "/api/w/acme/tasks",
            200,
            json!([
                { "id": "in_1", "key": "BUG-1", "threadUrl": "https://delta.example/t/1/" },
                { "id": "in_2", "key": "BUG-2", "threadUrl": "https://delta.example/t/1" },
                { "id": "in_3", "key": "BUG-3", "threadUrl": "https://delta.example/t/9" },
                { "id": "in_4", "key": "BUG-4" }
            ]),
        ),
        route("POST", "/api/w/acme/tasks/BUG-1/thread/sync", 200, done.clone()),
        route("POST", "/api/w/acme/tasks/BUG-2/thread/sync", 200, done),
    ]);
    let run = Run::new().with_key(&mock.api()).env("DELTA_THREAD_URL", "https://delta.example/t/1");
    let o = run.run(&["sync", "--all", "--summary", "Wrapped up"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["synced"].as_array().unwrap().len(), 2);
    assert!(v["failed"].as_array().unwrap().is_empty());
    let posts: Vec<String> = mock.requests().iter().filter(|r| r.method == "POST").map(|r| r.path().to_string()).collect();
    assert_eq!(posts, vec!["/api/w/acme/tasks/BUG-1/thread/sync", "/api/w/acme/tasks/BUG-2/thread/sync"]);
    assert_eq!(mock.last().json(), json!({ "summary": "Wrapped up" }));
}

#[test]
fn show_reads_the_task_its_subtasks_decisions_and_record_in_one_object() {
    let mock = Mock::start(vec![
        route("GET", "/api/w/acme/tasks/BUG-1/context", 200, json!({ "issue": short_task() })),
        route("GET", "/api/w/acme/tasks", 200, family()),
        route("GET", "/api/w/acme/decisions", 200, json!([{ "id": "dc_1", "issueKey": "BUG-1", "text": "Rotate tokens", "paths": ["src/auth/"] }])),
    ]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["show", "BUG-1", "--json"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["task"]["key"], "BUG-1");
    assert_eq!(v["subtasks"][0]["key"], "BUG-2");
    assert_eq!(v["subtasks"][0]["subtasks"][0]["key"], "BUG-3");
    assert_eq!(v["decisions"][0]["text"], "Rotate tokens");
    assert!(v["record"].is_null(), "never synced");
    assert!(mock.requests().iter().any(|r| r.path() == "/api/w/acme/decisions" && r.target.contains("issue=in_1")));

    let o = run.run(&["show", "BUG-1", "-o", "table"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let text = stdout(&o);
    for want in ["BUG-1  Parent", "2 subtasks", "BUG-3  todo  Grandchild", "1 related decision", "Rotate tokens  (src/auth/)"] {
        assert!(text.contains(want), "{want} is missing from:\n{text}");
    }
}

#[test]
fn ls_mine_asks_for_the_person_behind_the_key() {
    let mock = Mock::start(vec![route("GET", "/api/auth/token", 200, identity(&["tasks:read"])), route("GET", "/api/w/acme/tasks", 200, family())]);
    let run = Run::new().with_key(&mock.api());
    let o = run.run(&["ls", "--mine"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o).as_array().unwrap().len(), 4);
    let listing = mock.requests().into_iter().rfind(|r| r.path() == "/api/w/acme/tasks").unwrap();
    assert!(listing.target.contains("assigneeId=usr_1") && listing.target.contains("open=true") && listing.target.contains("limit=50"), "{}", listing.target);

    let o = run.run(&["ls", "--all", "--limit", "5"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let listing = mock.last();
    assert!(!listing.target.contains("open=") && !listing.target.contains("assigneeId") && listing.target.contains("limit=5"), "{}", listing.target);
    assert_eq!(code(&run.run(&["ls", "--open", "--all"])), 2);
    assert_eq!(code(&run.run(&["ls", "--mine", "--dry-run"])), 0);
}

#[test]
fn decisions_ask_and_estimate_read_their_routes_and_never_write() {
    let mock = Mock::start(vec![
        route("GET", "/api/w/acme/decisions", 200, json!([{ "id": "dc_1", "issueKey": "BUG-1", "text": "Rotate tokens", "paths": ["src/auth/"] }])),
        route("GET", "/api/w/acme/search", 200, json!({ "results": [{ "type": "decision", "key": "BUG-1", "id": "in_1", "title": "Rotate tokens" }] })),
        route(
            "GET",
            "/api/w/acme/tasks/BUG-1/estimate-suggestion",
            200,
            json!({ "suggestion": 3, "reason": "Median of 2 similar tasks.", "basis": [{ "key": "BUG-7", "title": "Retry", "estimate": 3, "trackedMinutes": 130 }] }),
        ),
    ]);
    let run = Run::new().with_key(&mock.api());

    let o = run.run(&["decisions", "--path", "./src/auth/x.ts", "--issue", "BUG-1", "--limit", "5"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)[0]["text"], "Rotate tokens");
    let target = mock.last().target;
    assert!(target.contains("path=") && target.contains("src") && !target.contains("%2E%2F") && target.contains("issue=BUG-1") && target.contains("limit=5"), "{target}");
    let o = run.run(&["decisions", "-o", "table"]);
    assert_eq!(stdout(&o).trim(), "BUG-1  Rotate tokens  (src/auth/)");
    assert_eq!(code(&run.run(&["decisions", "--limit", "999"])), 2);
    assert_eq!(code(&run.run(&["decision", "--dry-run"])), 0, "`decision` is an alias");

    let o = run.run(&["ask", "refresh", "tokens"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["results"][0]["key"], "BUG-1");
    assert!(v["note"].as_str().unwrap().contains("does not generate an answer"));
    let target = mock.last().target;
    assert!(target.contains("q=refresh") && target.contains("types=") && target.contains("limit=10"), "{target}");
    assert!(stdout(&run.run(&["ask", "refresh", "-o", "table"])).contains("BUG-1  decision  Rotate tokens"));

    let o = run.run(&["estimate", "BUG-1"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let v = out_json(&o);
    assert_eq!(v["suggestion"], 3);
    assert!(v["hint"].as_str().unwrap().contains("nothing was changed"));
    let o = run.run(&["estimate", "BUG-1", "-o", "table"]);
    let text = stdout(&o);
    assert!(text.contains("suggested estimate 3 pt") && text.contains("BUG-7  Retry  3 pt · 2h 10m tracked") && text.contains("trama task update BUG-1 --estimate 3"), "{text}");

    assert!(mock.requests().iter().all(|r| r.method == "GET"), "these three only read");
}

#[test]
fn time_logs_finished_work_and_accepts_suggestions() {
    let entry = json!({ "id": "te_1", "issueId": "in_1", "startedAt": "2026-05-01T09:00:00.000Z", "endedAt": "2026-05-01T10:15:00.000Z" });
    let mock = Mock::start(vec![
        route("GET", "/api/w/acme/tasks/BUG-1", 200, short_task()),
        route("POST", "/api/w/acme/time-entries", 201, entry.clone()),
        route("GET", "/api/w/acme/time-entries", 200, json!([entry.clone()])),
        route("POST", "/api/w/acme/time-entries/te_1/accept", 200, entry),
    ]);
    let run = Run::new().with_key(&mock.api());

    let o = run.run(&["time", "log", "BUG-1", "1h15", "--at", "2026-05-01T10:15:00Z", "--description", "Alerting"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["message"], "✓ logged 1h 15m on BUG-1");
    let body = mock.last().json();
    assert_eq!(body["issueId"], "in_1");
    assert_eq!(body["description"], "Alerting");
    assert!(body["startedAt"].as_str().unwrap().starts_with("2026-05-01T09:00:00"), "{body}");
    assert!(body["endedAt"].as_str().unwrap().starts_with("2026-05-01T10:15:00"), "{body}");
    assert_eq!(code(&run.run(&["time", "log", "BUG-1", "soon"])), 2);

    let o = run.run(&["time", "suggestions"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)[0]["id"], "te_1");
    assert!(mock.last().target.contains("source=suggested"), "{}", mock.last().target);

    for args in [vec!["time", "accept", "te_1"], vec!["time", "suggestions", "accept", "te_1"]] {
        let o = run.run(&args);
        assert_eq!(code(&o), 0, "{args:?}: {}", stderr(&o));
        assert!(out_json(&o)["message"].as_str().unwrap().starts_with("✓ accepted te_1"));
        assert_eq!((mock.last().method.as_str(), mock.last().path()), ("POST", "/api/w/acme/time-entries/te_1/accept"));
    }

    // start, stop and status are the timer's own requests
    let o = run.run(&["time", "start", "BUG-1", "--dry-run"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(out_json(&o)["request"]["url"].as_str().unwrap().rsplit('/').next(), Some("start"));
    assert_eq!(code(&run.run(&["time", "stop", "--dry-run"])), 0);
    assert_eq!(code(&run.run(&["time", "status", "--dry-run"])), 0);
}

#[test]
fn the_short_verbs_are_listed_and_the_generated_decision_group_is_gone() {
    let run = Run::new();
    let o = run.run(&["commands", "-o", "json"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let listed = stdout(&o);
    for verb in ["show", "ls", "link", "sub", "status", "sync", "decisions", "ask", "estimate", "time log", "time suggestions", "time accept"] {
        assert!(listed.contains(&format!("\"command\":\"{verb}\"")), "{verb} is not listed:\n{listed}");
    }
    assert!(!listed.contains("decision list") && !listed.contains("estimate suggest"), "the generated groups stand aside");
    for args in [["decisions", "--help"], ["sync", "--help"], ["time", "--help"]] {
        assert_eq!(code(&run.run(&args)), 0);
    }
}
