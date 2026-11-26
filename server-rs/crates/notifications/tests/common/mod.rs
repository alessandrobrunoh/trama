//! Fixtures shared by the database tests: rows inserted directly, the notifications router
//! behind the real access guard, the listener that produces notifications, a fake push service
//! and a request helper.

#![allow(dead_code, missing_docs)]

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tower::ServiceExt;
use trama_common::Mailer;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};
use trama_events::{Events, RecordEvent};
use trama_notifications::PushService;
use trama_notifications::push::{PushError, PushRequest, SendFuture, WebPushTransport};

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

/// A key pair from `webpush.generateVAPIDKeys()`.
pub const VAPID_PUBLIC: &str =
    "BODXrduVbuNQrOUZnGQKeSq5sPxxQOtPmx1HX6J03ehUsEywbhn8bBWqABFvJhVD-C4bWM6Bg3Z0lpyXwtN6_dk";
pub const VAPID_PRIVATE: &str = "NHeMxO592vKDztwSEkdk_APEXUt6aq56IbJqsdZzR2s";

/// `vi.spyOn(webpush, 'sendNotification')`: records every request and answers as told.
#[derive(Clone, Default)]
pub struct FakePush {
    inner: Arc<Mutex<FakeState>>,
}

#[derive(Default)]
struct FakeState {
    calls: Vec<PushRequest>,
    fail_with: Option<PushError>,
}

impl FakePush {
    pub fn calls(&self) -> Vec<PushRequest> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).calls.clone()
    }

    /// From now on answer with this status (a `WebPushError`), or success for `None`.
    pub fn fail_with(&self, status: Option<u16>) {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).fail_with =
            status.map(|status| PushError { status: Some(status), message: "gone".into() });
    }

    pub fn reset(&self) {
        let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        state.calls.clear();
        state.fail_with = None;
    }
}

impl WebPushTransport for FakePush {
    fn send(&self, request: PushRequest) -> SendFuture<'_> {
        let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        state.calls.push(request);
        let result = state.fail_with.clone().map_or(Ok(()), Err);
        Box::pin(std::future::ready(result))
    }
}

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub events: Events,
    pub mailer: Mailer,
    pub push: FakePush,
    pub app: Router,
    listener: Option<JoinHandle<()>>,
}

pub struct Options {
    pub vapid: bool,
    pub listen: bool,
}

impl World {
    /// Push on, listener running.
    pub async fn new() -> Option<Self> {
        Self::with(Options { vapid: true, listen: true }).await
    }

    /// The server has no `SMTP_URL`: nothing is emailed.
    pub async fn without_mail() -> Option<Self> {
        Self::build(Options { vapid: true, listen: true }, false).await
    }

    pub async fn with(options: Options) -> Option<Self> {
        Self::build(options, true).await
    }

    async fn build(options: Options, capture_mail: bool) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let config = if options.vapid {
            Config::from_vars(&[
                ("VAPID_PUBLIC_KEY", VAPID_PUBLIC),
                ("VAPID_PRIVATE_KEY", VAPID_PRIVATE),
                ("VAPID_SUBJECT", "mailto:test@example.com"),
            ])
        } else {
            Config::from_vars(&[])
        };
        let events = Events::local();
        let mailer =
            if capture_mail { Mailer::capture(&config) } else { Mailer::from_config(&config.mail) };
        let push = FakePush::default();
        let service = PushService::from_config(&config).with_transport(Arc::new(push.clone()));
        let state = AppState::new(test.db.clone(), config)
            .with_extension(events.clone())
            .with_extension(mailer.clone())
            .with_extension(service);
        let listener = options.listen.then(|| trama_notifications::spawn(&state));
        let app = trama_notifications::router().into_app(state.clone());
        Some(Self { test, state, events, mailer, push, app, listener })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status: parts.status, headers: parts.headers, body: json }
    }

    /// Records a domain event as the code paths of the other modules do.
    pub async fn record(
        &self,
        ws: &str,
        actor: ActorRef,
        kind: &str,
        subject: SubjectRef,
        data: Value,
    ) {
        self.events
            .record(self.db(), RecordEvent::new(ws, actor, kind, subject).data(data))
            .await
            .unwrap();
    }

    pub async fn drop(self) {
        if let Some(listener) = &self.listener {
            listener.abort();
        }
        self.test.drop().await;
    }
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
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
    pub fn post(uri: &str, body: &Value) -> Self {
        Self::new(Method::POST, uri).json(body)
    }
    pub fn patch(uri: &str, body: &Value) -> Self {
        Self::new(Method::PATCH, uri).json(body)
    }
    pub fn put(uri: &str, body: &Value) -> Self {
        Self::new(Method::PUT, uri).json(body)
    }
    pub fn delete(uri: &str, body: &Value) -> Self {
        Self::new(Method::DELETE, uri).json(body)
    }
    pub fn json(mut self, body: &Value) -> Self {
        self.body = Some(body.to_string());
        self.header("content-type", "application/json")
    }
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
    pub fn session(self, cookie: &str) -> Self {
        self.header("cookie", cookie).header("x-client-id", "test-client")
    }
    pub fn bearer(self, secret: &str) -> Self {
        self.header("authorization", &format!("Bearer {secret}"))
    }
    pub fn build(self) -> Request<Body> {
        let mut req = Request::builder().method(self.method).uri(self.uri);
        for (name, value) in &self.headers {
            req = req.header(name, value);
        }
        req.body(self.body.map_or_else(Body::empty, Body::from)).unwrap()
    }
}

/// Polls until `ok` accepts what `read` returns (notifications are produced after the request
/// returns), at most about 4 seconds.
pub async fn eventually<T, F, Fut>(what: &str, mut read: F, ok: impl Fn(&T) -> bool) -> T
where
    T: std::fmt::Debug,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let mut last = read().await;
    for _ in 0..80 {
        if ok(&last) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        last = read().await;
    }
    panic!("timed out waiting for {what}; last: {last:?}");
}

/// Gives the producer time to (not) do something.
pub async fn settle() {
    tokio::time::sleep(Duration::from_millis(400)).await;
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
    access: Option<Value>,
) -> memberships::Model {
    memberships::ActiveModel {
        id: Set(format!("mb_{ws}_{user}")),
        workspace_id: Set(ws.to_owned()),
        user_id: Set(user.to_owned()),
        role: Set(role.to_owned()),
        access: Set(access),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

/// A project limit as the members route stores it.
pub fn only_projects(ids: &[&str], include_unassigned: bool) -> Value {
    json!({
        "projects": { "all": false, "projectIds": ids },
        "includeUnassigned": include_unassigned,
        "grants": [],
    })
}

/// `trama_session=<raw>` for a new session of `user`.
pub async fn session(db: &DatabaseConnection, user: &str) -> String {
    let s = trama_auth::service::create_session(db, user, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

pub async fn project(db: &DatabaseConnection, ws: &str, id: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
               VALUES ('{id}', '{ws}', 'Project {id}', 'blue', 'planned', 'none', left(md5('{id}'), 4))"#
        ),
    )
    .await;
}

/// A task `key` (`BUG-1`) with a title, assignee, reporter and project.
pub async fn issue(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    key: &str,
    title: &str,
    assignee: Option<&str>,
    project: Option<&str>,
) {
    let text = |v: Option<&str>| v.map_or("NULL".to_owned(), |v| format!("'{v}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "assigneeId", "projectId")
               VALUES ('{id}', '{ws}', '{key}', 1, 'bug', '{title}', 'manual', 'none', 'backlog', {}, {})"#,
            text(assignee),
            text(project)
        ),
    )
    .await;
}

pub async fn artifact(db: &DatabaseConnection, ws: &str, id: &str, issue: Option<&str>) {
    let issue = issue.map_or("NULL".to_owned(), |i| format!("'{i}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "issueId")
               VALUES ('{id}', '{ws}', 'pull_request', 'github', 'PR #7', 'open', {issue})"#
        ),
    )
    .await;
}

pub async fn agent(db: &DatabaseConnection, ws: &str, id: &str, name: &str) {
    trama_entities::agents::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(ws.to_owned()),
        name: Set(name.to_owned()),
        provider: Set("claude_code".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

/// A new API token; returns the secret to send as a bearer.
pub async fn token(
    db: &DatabaseConnection,
    ws: &str,
    actor: ActorRef,
    scope: trama_contracts::roles::TokenScope,
) -> String {
    trama_auth::tokens::create_token(
        db,
        trama_auth::tokens::NewToken {
            workspace_id: ws.to_owned(),
            name: "k".into(),
            actor,
            scope: Some(scope),
            permissions: None,
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap()
    .1
}

pub fn issue_subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Issue, id: id.to_owned() }
}

pub fn artifact_subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Artifact, id: id.to_owned() }
}

pub fn project_subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Project, id: id.to_owned() }
}
