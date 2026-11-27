//! Fixtures shared by the database tests: rows inserted directly, the outgoing webhooks router
//! behind the real access guard, a recording receiver and a request helper.

#![allow(dead_code, missing_docs)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};
use trama_events::{Events, RecordEvent};
use trama_integrations::http::{Http, HttpClient, HttpFailure, HttpRequest, HttpResponse};
use trama_outgoing_webhooks::Dispatcher;

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

/// Every request the receiver got, shared with the test.
pub type Calls = Arc<Mutex<Vec<HttpRequest>>>;

/// Records outgoing webhook calls; answers per URL path (`/ok`, `/fail`, `/flaky`, `/slow`,
/// `/down`, `/gone`).
pub struct MockReceiver {
    pub calls: Calls,
    flaky: Mutex<u32>,
}

#[async_trait]
impl HttpClient for MockReceiver {
    async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
        self.calls.lock().unwrap().push(req.clone());
        let path = url_path(&req.url);
        let reply =
            |status: u16| Ok(HttpResponse { status, headers: BTreeMap::new(), json: Value::Null });
        match path.as_str() {
            "/down" => Err(HttpFailure("error sending request: connect ECONNREFUSED".to_owned())),
            "/slow" => Err(HttpFailure("Timed out after 5000 ms".to_owned())),
            "/fail" => reply(500),
            "/gone" => reply(410),
            "/flaky" => {
                let mut seen = self.flaky.lock().unwrap();
                *seen += 1;
                reply(if *seen == 1 { 503 } else { 200 })
            }
            _ => reply(200),
        }
    }
}

pub fn url_path(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.find('/').map_or("/".to_owned(), |i| rest[i..].to_owned())
}

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub app: Router,
    pub calls: Calls,
    pub listener: tokio::task::JoinHandle<()>,
}

impl World {
    pub async fn new() -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let calls = Calls::default();
        let state =
            AppState::new(test.db.clone(), Config::from_vars(&[("TRAMA_WEBHOOK_RETRY_MS", "10")]))
                .with_extension(Events::local())
                .with_extension(Http::new(MockReceiver {
                    calls: calls.clone(),
                    flaky: Mutex::new(0),
                }));
        let state = trama_outgoing_webhooks::with_services(state);
        let listener = trama_outgoing_webhooks::spawn(&state);
        let app = trama_outgoing_webhooks::router().into_app(state.clone());
        Some(Self { test, state, app, calls, listener })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    /// Waits for every recorded event to be delivered.
    pub async fn idle(&self) {
        Dispatcher::of(&self.state).idle().await;
    }

    /// The requests sent to `path`, oldest first.
    pub fn to(&self, path: &str) -> Vec<HttpRequest> {
        self.calls.lock().unwrap().iter().filter(|c| url_path(&c.url) == path).cloned().collect()
    }

    /// Records a domain event as a handler of another module would.
    pub async fn record(&self, ws: &str, kind: &str, subject: SubjectType, id: &str) {
        Events::of(&self.state)
            .record(
                self.db(),
                RecordEvent::new(
                    format!("ws_{ws}"),
                    ActorRef::user("olivia"),
                    kind,
                    SubjectRef { kind: subject, id: id.to_owned() },
                )
                .data(json!({ "title": "Login fails" })),
            )
            .await
            .unwrap();
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status: parts.status, headers: parts.headers, body: json, raw: bytes.to_vec() }
    }

    pub async fn drop(self) {
        self.listener.abort();
        self.test.drop().await;
    }
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub raw: Vec<u8>,
}

impl Res {
    pub fn message(&self) -> String {
        match &self.body["message"] {
            Value::Array(list) => {
                list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")
            }
            other => other.as_str().unwrap_or_default().to_owned(),
        }
    }

    /// The whole body as text, to look for secrets in.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.raw).into_owned()
    }
}

pub struct Req {
    method: Method,
    uri: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

impl Req {
    pub fn new(method: Method, uri: &str) -> Self {
        Self { method, uri: uri.to_owned(), headers: Vec::new(), body: None }
    }
    pub fn get(uri: &str) -> Self {
        Self::new(Method::GET, uri)
    }
    pub fn post(uri: &str) -> Self {
        Self::new(Method::POST, uri)
    }
    pub fn patch(uri: &str) -> Self {
        Self::new(Method::PATCH, uri)
    }
    pub fn delete(uri: &str) -> Self {
        Self::new(Method::DELETE, uri)
    }
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
    /// A browser session: the cookie and the CSRF header the web app sends.
    pub fn session(self, cookie: &str) -> Self {
        self.header("cookie", cookie).header("x-client-id", "test-client")
    }
    pub fn json(mut self, body: &Value) -> Self {
        self.body = Some(body.to_string());
        self.header("content-type", "application/json")
    }
    fn build(self) -> Request<Body> {
        let mut req = Request::builder().method(self.method).uri(self.uri);
        for (name, value) in &self.headers {
            req = req.header(name, value);
        }
        match self.body {
            Some(body) => req.header("content-length", body.len()).body(Body::from(body)).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        }
    }
}

// ───────────────────────────── rows ─────────────────────────────

pub async fn user(db: &DatabaseConnection, id: &str, name: &str) -> users::Model {
    users::ActiveModel {
        id: Set(id.to_owned()),
        name: Set(name.to_owned()),
        email: Set(format!("{id}@test.dev")),
        password_hash: Set(NODE_HASH.to_owned()),
        avatar_hue: Set(7),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

pub async fn workspace(db: &DatabaseConnection, slug: &str) -> workspaces::Model {
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
    .unwrap()
}

pub async fn member(
    db: &DatabaseConnection,
    ws: &str,
    user: &str,
    role: &str,
) -> memberships::Model {
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
    .unwrap()
}

/// `trama_session=<raw>` for a new session of `user`.
pub async fn session(db: &DatabaseConnection, user: &str) -> String {
    let s = trama_auth::service::create_session(db, user, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}
