//! Fixtures shared by the database tests: rows inserted directly, the views router behind the
//! real access guard, and a request helper.

#![allow(dead_code, missing_docs)]

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_auth::tokens::{NewToken, create_token};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{Capability, TokenScope, fresh_workspace_roles};
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{agents, memberships, users, workspaces};
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
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let events = Events::local();
        let state =
            AppState::new(test.db.clone(), Config::from_vars(&[])).with_extension(events.clone());
        let app = trama_views::router().into_app(state.clone());
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
    pub fn bearer(self, secret: &str) -> Self {
        self.header("authorization", &format!("Bearer {secret}"))
    }
    #[allow(clippy::needless_pass_by_value)] // call sites read better with `json!(...)` by value
    pub fn json(mut self, body: Value) -> Self {
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

pub async fn workspace_with(
    db: &DatabaseConnection,
    slug: &str,
    settings: Value,
) -> workspaces::Model {
    workspaces::ActiveModel {
        id: Set(format!("ws_{slug}")),
        name: Set(slug.to_uppercase()),
        slug: Set(slug.to_owned()),
        settings: Set(settings),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

pub async fn workspace(db: &DatabaseConnection, slug: &str) -> workspaces::Model {
    workspace_with(db, slug, json!({ "roles": fresh_workspace_roles() })).await
}

/// A workspace whose `member` role cannot share views (`manageSharedViews` removed).
pub async fn workspace_without_sharing(db: &DatabaseConnection, slug: &str) -> workspaces::Model {
    let mut roles = fresh_workspace_roles();
    for role in &mut roles {
        if role.id == "member" {
            role.capabilities.retain(|c| *c != Capability::ManageSharedViews);
        }
    }
    workspace_with(db, slug, json!({ "roles": roles })).await
}

pub async fn member(db: &DatabaseConnection, ws: &str, user: &str, role: &str) {
    memberships::ActiveModel {
        id: Set(format!("mb_{ws}_{user}")),
        workspace_id: Set(ws.to_owned()),
        user_id: Set(user.to_owned()),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

/// A user with a membership and a session; returns the cookie.
pub async fn person(db: &DatabaseConnection, ws: &str, id: &str, role: &str) -> String {
    user(db, id).await;
    member(db, ws, id, role).await;
    session(db, id).await
}

/// `trama_session=<raw>` for a new session of `user`.
pub async fn session(db: &DatabaseConnection, user: &str) -> String {
    let s = trama_auth::service::create_session(db, user, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

/// A write token of a new agent; returns the secret to send as a bearer.
pub async fn agent_token(db: &DatabaseConnection, ws: &str, id: &str) -> String {
    agents::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(ws.to_owned()),
        name: Set("Bot".to_owned()),
        provider: Set("claude_code".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let (_, secret) = create_token(
        db,
        NewToken {
            workspace_id: ws.to_owned(),
            name: "k".into(),
            actor: ActorRef::agent(id),
            scope: Some(TokenScope::Write),
            permissions: None,
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    secret
}

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

pub async fn project(db: &DatabaseConnection, ws: &str, id: &str, name: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
               VALUES ('{id}', '{ws}', '{name}', 'blue', 'planned', 'none', left(md5('{id}'), 4))"#
        ),
    )
    .await;
}

/// One issue with the columns the public view can show.
pub async fn issue(db: &DatabaseConnection, ws: &str, n: i32, extra: &[(&str, &str)]) {
    let mut columns = vec![
        ("id".to_owned(), format!("'in_{}_{n}'", ws.trim_start_matches("ws_"))),
        ("\"workspaceId\"".to_owned(), format!("'{ws}'")),
        ("key".to_owned(), format!("'BUG-{n}'")),
        ("number".to_owned(), n.to_string()),
        ("kind".to_owned(), "'bug'".to_owned()),
        ("title".to_owned(), format!("'Issue {n}'")),
        ("body".to_owned(), "'PRIVATE BODY'".to_owned()),
        ("\"reporterName\"".to_owned(), "'Secret Reporter'".to_owned()),
        ("\"reporterId\"".to_owned(), "'u9'".to_owned()),
        ("\"externalUrl\"".to_owned(), "'https://internal.example/secret'".to_owned()),
        ("source".to_owned(), "'manual'".to_owned()),
        ("priority".to_owned(), "'high'".to_owned()),
        ("status".to_owned(), "'todo'".to_owned()),
        ("labels".to_owned(), "'[\"lb_ui\",\"lb_gone\"]'".to_owned()),
        ("\"updatedAt\"".to_owned(), "'2026-02-01T00:00:00Z'".to_owned()),
        ("\"createdAt\"".to_owned(), "'2026-01-01T00:00:00Z'".to_owned()),
    ];
    for (column, value) in extra {
        columns.retain(|(name, _)| name.trim_matches('"') != *column);
        columns.push((format!("\"{column}\""), (*value).to_owned()));
    }
    let names: Vec<&str> = columns.iter().map(|(n, _)| n.as_str()).collect();
    let values: Vec<&str> = columns.iter().map(|(_, v)| v.as_str()).collect();
    sql(db, &format!("INSERT INTO issues ({}) VALUES ({})", names.join(", "), values.join(", ")))
        .await;
}

/// `count` plain issues in one statement.
pub async fn many_issues(db: &DatabaseConnection, ws: &str, count: usize) {
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status)
               SELECT 'bulk_{ws}_' || n, '{ws}', 'BUG-' || n, n, 'bug', 'Issue ' || n, 'manual', 'none', 'todo'
               FROM generate_series(1, {count}) AS n"#
        ),
    )
    .await;
}
