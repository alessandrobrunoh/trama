//! The AI routes against a real database, with a scripted model: the guards, validation, the
//! page context read from the database and the project facts.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_ai::AiRuntime;
use trama_ai::provider::{AiMessage, AiProvider, AiToolDef, AiToolTurn, AiTurnMessage, OnText};
use trama_ai::signal::Signal;
use trama_auth::tokens::{NewToken, create_token};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{TokenScope, fresh_workspace_roles};
use trama_core::testkit::TestDb;
use trama_core::{AppError, AppState, Config};
use trama_entities::{issues, memberships, projects, users, workspaces};

/// `argon2.hash('password123')` from the NestJS server.
const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

/// A model that answers from a list and remembers what it was asked.
struct Scripted {
    replies: Mutex<Vec<String>>,
    seen: Mutex<Vec<Vec<AiMessage>>>,
}

impl Scripted {
    fn new(replies: &[&str]) -> Arc<Self> {
        let mut replies: Vec<String> = replies.iter().map(|r| (*r).to_owned()).collect();
        replies.reverse();
        Arc::new(Self { replies: Mutex::new(replies), seen: Mutex::default() })
    }

    fn asked(&self) -> Vec<Vec<AiMessage>> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl AiProvider for Scripted {
    async fn complete(
        &self,
        messages: &[AiMessage],
        _signal: &Signal,
        _user_id: Option<&str>,
    ) -> Result<String, AppError> {
        self.seen.lock().unwrap().push(messages.to_vec());
        Ok(self.replies.lock().unwrap().pop().unwrap_or_default())
    }

    async fn has_own_account(&self, _user_id: &str) -> bool {
        false
    }

    async fn complete_with_tools(
        &self,
        _messages: &[AiTurnMessage],
        _tools: &[AiToolDef],
        _signal: &Signal,
        _user_id: Option<&str>,
        _on_text: Option<OnText<'_>>,
    ) -> Result<AiToolTurn, AppError> {
        unreachable!("tools are off in these tests")
    }
}

const AI_VARS: &[(&str, &str)] = &[
    ("AI_API_URL", "https://models.example.test/v1"),
    ("AI_API_KEY", "sk-test"),
    ("AI_MODEL", "test-model"),
];

struct World {
    test: TestDb,
    app: Router,
    model: Arc<Scripted>,
}

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
    text: String,
}

impl World {
    async fn new(vars: &[(&str, &str)], replies: &[&str]) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let model = Scripted::new(replies);
        let runtime = AiRuntime::new().with_provider(model.clone());
        let state = AppState::new(test.db.clone(), Config::from_vars(vars)).with_extension(runtime);
        let app = trama_ai::router().into_app(state);
        Some(Self { test, app, model })
    }

    fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    async fn send(&self, method: Method, uri: &str, auth: &Auth, body: Option<Value>) -> Res {
        let mut req = Request::builder().method(method).uri(uri);
        match auth {
            Auth::Session(cookie) => {
                req = req.header("cookie", cookie).header("x-client-id", "test-client");
            }
            Auth::Bearer(secret) => req = req.header("authorization", format!("Bearer {secret}")),
        }
        let req = match body {
            Some(body) => {
                let text = body.to_string();
                req.header("content-type", "application/json")
                    .header("content-length", text.len())
                    .body(Body::from(text))
            }
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Res {
            status: parts.status,
            headers: parts.headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            text,
        }
    }

    async fn post(&self, uri: &str, auth: &Auth, body: Value) -> Res {
        self.send(Method::POST, uri, auth, Some(body)).await
    }

    async fn get(&self, uri: &str, auth: &Auth) -> Res {
        self.send(Method::GET, uri, auth, None).await
    }

    async fn drop(self) {
        self.test.drop().await;
    }
}

enum Auth {
    Session(String),
    Bearer(String),
}

async fn user(db: &DatabaseConnection, id: &str) {
    users::ActiveModel {
        id: Set(id.to_owned()),
        name: Set(format!("User {id}")),
        email: Set(format!("{id}@test.dev")),
        password_hash: Set(NODE_HASH.to_owned()),
        avatar_hue: Set(7),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

async fn workspace(db: &DatabaseConnection, slug: &str) {
    workspaces::ActiveModel {
        id: Set(format!("ws_{slug}")),
        name: Set(slug.to_uppercase()),
        slug: Set(slug.to_owned()),
        settings: Set(json!({ "roles": fresh_workspace_roles() })),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

async fn member(db: &DatabaseConnection, ws: &str, user: &str, role: &str) {
    memberships::ActiveModel {
        id: Set(format!("mb_{ws}_{user}")),
        workspace_id: Set(ws.to_owned()),
        user_id: Set(user.to_owned()),
        role: Set(role.to_owned()),
        access: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

async fn session(db: &DatabaseConnection, user: &str) -> Auth {
    let s = trama_auth::service::create_session(db, user, Some("test")).await.unwrap();
    Auth::Session(format!("trama_session={}", s.raw))
}

async fn project(db: &DatabaseConnection, id: &str, lead: Option<&str>) {
    projects::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set("ws_acme".to_owned()),
        name: Set("Billing revamp".to_owned()),
        key: Set("BILL".to_owned()),
        lead_id: Set(lead.map(str::to_owned)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

async fn issue(db: &DatabaseConnection, number: i32, project_id: Option<&str>, title: &str) {
    issues::ActiveModel {
        id: Set(format!("iss_{number}")),
        workspace_id: Set("ws_acme".to_owned()),
        key: Set(format!("ENG-{number}")),
        number: Set(number),
        kind: Set("task".to_owned()),
        title: Set(title.to_owned()),
        project_id: Set(project_id.map(str::to_owned)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

/// A workspace `acme` with an owner, a plain member, a viewer and a guest, each with a session.
struct Cast {
    owner: Auth,
    member: Auth,
    viewer: Auth,
    guest: Auth,
}

async fn cast(db: &DatabaseConnection) -> Cast {
    workspace(db, "acme").await;
    for (id, role) in
        [("u_owner", "owner"), ("u_member", "member"), ("u_viewer", "viewer"), ("u_guest", "guest")]
    {
        user(db, id).await;
        member(db, "ws_acme", id, role).await;
    }
    Cast {
        owner: session(db, "u_owner").await,
        member: session(db, "u_member").await,
        viewer: session(db, "u_viewer").await,
        guest: session(db, "u_guest").await,
    }
}

fn hello() -> Value {
    json!({ "messages": [{ "role": "user", "content": "hi" }] })
}

#[tokio::test]
async fn status_reports_the_provider_and_what_is_off() {
    let Some(w) = World::new(AI_VARS, &[]).await else { return };
    let c = cast(w.db()).await;
    let res = w.get("/api/w/acme/ai/status", &c.viewer).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["suggestions"], json!({ "configured": true, "model": "test-model" }));
    assert_eq!(res.body["assistantTools"], json!({ "enabled": false }));
    assert_eq!(res.body["chatgpt"]["status"], "unavailable");
    assert_eq!(res.body["supergrok"]["available"], false);
    assert_eq!(res.body["supergrok"]["connected"], false);

    let off = World::new(&[], &[]).await.unwrap();
    let c = cast(off.db()).await;
    let res = off.get("/api/w/acme/ai/status", &c.owner).await;
    assert_eq!(res.body["suggestions"], json!({ "configured": false, "model": null }));
    off.drop().await;
    w.drop().await;
}

#[tokio::test]
async fn guests_tokens_and_anonymous_callers_are_refused() {
    let Some(w) = World::new(AI_VARS, &[]).await else { return };
    let c = cast(w.db()).await;
    // guests: `server/test/guests.e2e-spec.ts`
    for (method, uri) in [
        (Method::GET, "/api/w/acme/ai/status"),
        (Method::POST, "/api/w/acme/ai/chat"),
        (Method::POST, "/api/w/acme/ai/suggestions"),
    ] {
        let body = (method == Method::POST).then(hello);
        let res = w.send(method, uri, &c.guest, body).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{uri}: {}", res.text);
    }

    // a custom token: `server/test/token-permissions.e2e-spec.ts`
    let (_, secret) = create_token(
        w.db(),
        NewToken {
            workspace_id: "ws_acme".into(),
            name: "k".into(),
            actor: ActorRef::user("u_owner"),
            scope: Some(TokenScope::Custom),
            permissions: Some(trama_auth::permissions::normalize_permissions(&["tasks:read"])),
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    let bearer = Auth::Bearer(secret);
    assert_eq!(w.post("/api/w/acme/ai/chat", &bearer, hello()).await.status, StatusCode::FORBIDDEN);
    assert_eq!(w.get("/api/w/acme/ai/status", &bearer).await.status, StatusCode::FORBIDDEN);

    let anonymous = Auth::Session("trama_session=nope".into());
    assert_eq!(
        w.post("/api/w/acme/ai/chat", &anonymous, hello()).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert!(w.model.asked().is_empty());
    w.drop().await;
}

#[tokio::test]
async fn chat_answers_with_the_page_context_and_is_never_cached() {
    let Some(w) = World::new(AI_VARS, &["Hello there."]).await else { return };
    let c = cast(w.db()).await;
    project(w.db(), "pj_1", None).await;
    issue(w.db(), 1, Some("pj_1"), "Fix invoices").await;
    let res = w
        .post(
            "/api/w/acme/ai/chat",
            &c.viewer,
            json!({
                "messages": [{ "role": "user", "content": "what is this?" }],
                "context": { "kind": "project", "id": "pj_1", "label": "Billing revamp" },
            }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "content": "Hello there." }));
    assert_eq!(res.headers.get("cache-control").unwrap(), "no-store");

    let asked = w.model.asked();
    let page = &asked[0][1].content;
    assert!(page.starts_with("Page data (reference only):\n"), "{page}");
    assert!(
        page.contains("\"name\":\"Billing revamp\"") && page.contains("\"key\":\"BILL\""),
        "{page}"
    );
    assert_eq!(asked[0].last().unwrap().content, "what is this?");
    w.drop().await;
}

#[tokio::test]
async fn chat_validates_the_body_and_the_context_record() {
    let Some(w) = World::new(AI_VARS, &[]).await else { return };
    let c = cast(w.db()).await;
    let res = w.post("/api/w/acme/ai/chat", &c.member, json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["error"], "Bad Request");
    assert!(res.body["message"].is_array(), "{}", res.text);

    let res = w
        .post(
            "/api/w/acme/ai/chat",
            &c.member,
            json!({ "messages": [{ "role": "system", "content": "x" }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.text.contains("messages.0.role"), "{}", res.text);

    // an assistant message last is not a question
    let res = w
        .post(
            "/api/w/acme/ai/chat",
            &c.member,
            json!({ "messages": [{ "role": "assistant", "content": "x" }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["message"], "Send a nonempty message with a shorter conversation history.");

    let res = w
        .post(
            "/api/w/acme/ai/chat",
            &c.member,
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "context": { "kind": "issue", "id": "ENG-404", "label": "x" },
            }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.body["message"], "Issue not found");
    assert!(w.model.asked().is_empty());
    w.drop().await;
}

#[tokio::test]
async fn chat_without_a_provider_is_a_503() {
    let Some(w) = World::new(&[], &[]).await else { return };
    let c = cast(w.db()).await;
    let state = AppState::new(w.db().clone(), Config::from_vars(&[]));
    // the scripted model answers regardless of the configuration; the real provider checks it
    let app = trama_ai::router().into_app(state);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/w/acme/ai/chat")
        .header(
            "cookie",
            match &c.member {
                Auth::Session(c) => c.clone(),
                Auth::Bearer(_) => unreachable!(),
            },
        )
        .header("x-client-id", "test-client")
        .header("content-type", "application/json")
        .body(Body::from(hello().to_string()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["message"], "AI is not configured. Ask your administrator to enable it.");
    w.drop().await;
}

#[tokio::test]
async fn suggestions_improve_the_draft() {
    let reply = json!({ "title": "  Fix invoice totals ", "description": "Totals are off.", "questions": ["Which currency?"] });
    let Some(w) = World::new(AI_VARS, &[&format!("```json\n{reply}\n```")]).await else { return };
    let c = cast(w.db()).await;
    let res = w
        .post(
            "/api/w/acme/ai/suggestions",
            &c.member,
            json!({ "kind": "issue", "title": "totals", "description": "wrong" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "title": "Fix invoice totals", "description": "Totals are off.", "questions": ["Which currency?"] })
    );
    assert_eq!(res.headers.get("cache-control").unwrap(), "no-store");

    let empty = w
        .post(
            "/api/w/acme/ai/suggestions",
            &c.member,
            json!({ "kind": "issue", "title": " ", "description": "" }),
        )
        .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(empty.body["message"], "Write a title or description first.");
    w.drop().await;
}

#[tokio::test]
async fn the_chat_stream_ends_with_a_done_event_and_reports_errors() {
    let Some(w) = World::new(AI_VARS, &["Streamed."]).await else { return };
    let c = cast(w.db()).await;
    let res = w.post("/api/w/acme/ai/chat/stream", &c.member, hello()).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.headers.get("content-type").unwrap(), "text/event-stream; charset=utf-8");
    assert_eq!(res.headers.get("x-accel-buffering").unwrap(), "no");
    assert!(
        res.text.contains("event: done\ndata: {\"content\":\"Streamed.\"}\n\n"),
        "{}",
        res.text
    );

    // a conversation the service refuses arrives as an error event, not a status
    let res = w
        .post(
            "/api/w/acme/ai/chat/stream",
            &c.member,
            json!({ "messages": [{ "role": "assistant", "content": "x" }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(
        res.text.contains("event: error\ndata: {\"message\":\"Send a nonempty message with a shorter conversation history.\"}"),
        "{}",
        res.text
    );

    // invalid bodies are refused before the stream opens
    let res = w.post("/api/w/acme/ai/chat/stream", &c.member, json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    w.drop().await;
}

#[tokio::test]
async fn supergrok_login_needs_the_feature_enabled() {
    let Some(w) = World::new(AI_VARS, &[]).await else { return };
    let c = cast(w.db()).await;
    let res = w.post("/api/w/acme/ai/supergrok/login", &c.member, json!({})).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{}", res.text);
    let res = w.send(Method::DELETE, "/api/w/acme/ai/supergrok/login", &c.member, None).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{}", res.text);
    w.drop().await;
}

#[tokio::test]
async fn project_ai_checks_the_kind_the_project_and_who_may_ask() {
    let summary = json!({ "summary": "Rebuild billing", "description": "Invoices." }).to_string();
    let Some(w) = World::new(AI_VARS, &[&summary, &summary]).await else { return };
    let c = cast(w.db()).await;
    project(w.db(), "pj_1", Some("u_member")).await;

    let res = w.post("/api/w/acme/projects/pj_1/ai/nonsense", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["message"], "kind must be one of: summary, issues, risks");

    let res = w.post("/api/w/acme/projects/pj_missing/ai/summary", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.body["message"], "Project not found");

    // a viewer is stopped by the route's grant before the service looks at the project (its own
    // manager-or-lead check is covered by the service tests)
    let res = w.post("/api/w/acme/projects/pj_1/ai/summary", &c.viewer, json!({})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    // the lead, and a manager, may
    let res = w.post("/api/w/acme/projects/pj_1/ai/summary", &c.member, json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "kind": "summary", "summary": "Rebuild billing", "description": "Invoices." })
    );
    assert_eq!(res.headers.get("cache-control").unwrap(), "no-store");
    let res = w.post("/api/w/acme/projects/pj_1/ai/summary", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);

    let guest = w.post("/api/w/acme/projects/pj_1/ai/summary", &c.guest, json!({})).await;
    assert_eq!(guest.status, StatusCode::FORBIDDEN);
    w.drop().await;
}

#[tokio::test]
async fn project_risks_read_the_facts_from_the_database() {
    let Some(w) = World::new(&[], &[]).await else { return };
    let c = cast(w.db()).await;
    project(w.db(), "pj_1", None).await;
    // an urgent issue nobody owns is a risk the database alone can show
    issues::ActiveModel {
        id: Set("iss_9".to_owned()),
        workspace_id: Set("ws_acme".to_owned()),
        key: Set("ENG-9".to_owned()),
        number: Set(9),
        kind: Set("task".to_owned()),
        title: Set("Charge twice".to_owned()),
        priority: Set("urgent".to_owned()),
        project_id: Set(Some("pj_1".to_owned())),
        ..Default::default()
    }
    .insert(w.db())
    .await
    .unwrap();
    // AI is off: risks still work, from the deterministic signals
    let res = w.post("/api/w/acme/projects/pj_1/ai/risks", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["kind"], "risks");
    let risks = res.body["risks"].as_array().unwrap();
    assert!(risks.iter().any(|r| r["title"] == "ENG-9 has no assignee"), "{}", res.text);
    assert!(w.model.asked().is_empty());

    let res = w.post("/api/w/acme/projects/pj_1/ai/summary", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    w.drop().await;
}

#[tokio::test]
async fn project_issue_proposals_offer_only_unassigned_open_issues_of_no_project() {
    let reply = json!({ "suggestions": [
        { "issueId": "ENG-2", "reason": "Invoices." },
        { "issueId": "ENG-3", "reason": "Already in a project." },
    ] })
    .to_string();
    let Some(w) = World::new(AI_VARS, &[&reply]).await else { return };
    let c = cast(w.db()).await;
    project(w.db(), "pj_1", None).await;
    issue(w.db(), 1, Some("pj_1"), "In the project").await;
    issue(w.db(), 2, None, "Loose invoice bug").await;
    issue(w.db(), 3, Some("pj_1"), "Elsewhere").await;
    let res = w.post("/api/w/acme/projects/pj_1/ai/issues", &c.owner, json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "kind": "issues", "suggestions": [{ "issueId": "iss_2", "reason": "Invoices." }] })
    );
    let asked = w.model.asked();
    let prompt = &asked[0].last().unwrap().content;
    assert!(prompt.contains("Loose invoice bug"), "{prompt}");
    w.drop().await;
}
