//! Fixtures shared by the database tests: rows inserted directly, the events router behind the
//! real access guard, a request helper and a reader for the SSE stream.

#![allow(dead_code, missing_docs)]

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};
use trama_events::Events;

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub events: Events,
    pub app: Router,
}

impl World {
    pub async fn new() -> Option<Self> {
        Self::with_config(Config::from_vars(&[])).await
    }

    /// An app whose streams re-check their credentials every 100 ms.
    pub async fn fast_recheck() -> Option<Self> {
        Self::with_config(Config::from_vars(&[("TRAMA_SSE_RECHECK_MS", "100")])).await
    }

    pub async fn with_config(config: Config) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let events = Events::local();
        let state = AppState::new(test.db.clone(), config).with_extension(events.clone());
        let app = trama_events::router().into_app(state.clone());
        Some(Self { test, state, events, app })
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

    /// Opens a stream and returns it without waiting for the body to end.
    pub async fn open_stream(&self, req: Req) -> (StatusCode, HeaderMap, Sse) {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        (parts.status, parts.headers, Sse { body, buffer: String::new() })
    }

    pub async fn drop(self) {
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
}

impl Req {
    pub fn get(uri: &str) -> Self {
        Self { method: Method::GET, uri: uri.to_owned(), headers: Vec::new() }
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
        req.body(Body::empty()).unwrap()
    }
}

/// One server-sent message.
#[derive(Debug, PartialEq)]
pub enum Frame {
    /// `data:` lines joined, with the `event:` name when there is one.
    Message {
        event: Option<String>,
        id: Option<u64>,
        data: String,
    },
    Closed,
    Timeout,
}

impl Frame {
    pub fn json(&self) -> Value {
        match self {
            Self::Message { data, .. } => serde_json::from_str(data).unwrap(),
            other => panic!("not a message: {other:?}"),
        }
    }
}

/// The body of an open SSE response.
pub struct Sse {
    body: Body,
    buffer: String,
}

impl Sse {
    /// The next frame that carries data (the blank line that opens the stream is skipped).
    pub async fn next(&mut self, wait: Duration) -> Frame {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let raw: String = self.buffer.drain(..end + 2).collect();
                let mut event = None;
                let mut id = None;
                let mut data = Vec::new();
                for line in raw.trim_end_matches('\n').lines() {
                    if let Some(name) = line.strip_prefix("event:") {
                        event = Some(name.trim().to_owned());
                    } else if let Some(n) = line.strip_prefix("id:") {
                        id = n.trim().parse().ok();
                    } else if let Some(d) = line.strip_prefix("data:") {
                        data.push(d.trim_start().to_owned());
                    }
                }
                if data.is_empty() {
                    continue;
                }
                return Frame::Message { event, id, data: data.join("\n") };
            }
            match tokio::time::timeout(wait, self.body.frame()).await {
                Err(_) => return Frame::Timeout,
                Ok(None | Some(Err(_))) => return Frame::Closed,
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        self.buffer.push_str(&String::from_utf8_lossy(&data).replace("\r\n", "\n"));
                    }
                }
            }
        }
    }

    /// The raw text received so far, without waiting.
    pub fn buffered(&self) -> &str {
        &self.buffer
    }
}

// ───────────────────────────── rows ─────────────────────────────

pub async fn user(db: &DatabaseConnection, id: &str) -> users::Model {
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

pub async fn issue(db: &DatabaseConnection, ws: &str, id: &str, project: Option<&str>) {
    let project = project.map_or("NULL".to_owned(), |p| format!("'{p}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId")
               VALUES ('{id}', '{ws}', left(md5('{id}'), 4), 1, 'bug', 'Issue {id}', 'manual', 'none', 'backlog', {project})"#
        ),
    )
    .await;
}

pub async fn milestone(db: &DatabaseConnection, ws: &str, id: &str, project: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO milestones (id, "workspaceId", name, "projectId")
               VALUES ('{id}', '{ws}', 'Milestone {id}', '{project}')"#
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
               VALUES ('{id}', '{ws}', 'pull_request', 'github', 'Artifact {id}', 'open', {issue})"#
        ),
    )
    .await;
}

pub async fn comment(db: &DatabaseConnection, ws: &str, id: &str, subject: Value) {
    sql(
        db,
        &format!(
            r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
               VALUES ('{id}', '{ws}', '{subject}', '{{"type":"system"}}', 'body')"#
        ),
    )
    .await;
}

pub async fn agent(db: &DatabaseConnection, ws: &str, id: &str) {
    trama_entities::agents::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(ws.to_owned()),
        name: Set("Bot".to_owned()),
        provider: Set("claude_code".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

/// A new API token; returns its row and the secret to send as a bearer.
pub async fn token(
    db: &DatabaseConnection,
    ws: &str,
    actor: trama_contracts::common::ActorRef,
    scope: trama_contracts::roles::TokenScope,
    permissions: Option<&[&str]>,
    expires_at: Option<chrono::DateTime<chrono::FixedOffset>>,
) -> (trama_entities::api_tokens::Model, String) {
    trama_auth::tokens::create_token(
        db,
        trama_auth::tokens::NewToken {
            workspace_id: ws.to_owned(),
            name: "k".into(),
            actor,
            scope: Some(scope),
            permissions: permissions.map(trama_auth::permissions::normalize_permissions),
            limits: None,
            created_by_user_id: None,
            expires_at,
        },
    )
    .await
    .unwrap()
}
