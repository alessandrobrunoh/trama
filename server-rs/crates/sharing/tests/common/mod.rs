//! Fixtures shared by the database tests: rows inserted directly (the workspaces, members and
//! projects crates are not ported yet), the sharing router behind the real access guard and a
//! request helper.

#![allow(dead_code, missing_docs)]

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{TokenScope, fresh_workspace_roles};
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
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let events = Events::local();
        let state =
            AppState::new(test.db.clone(), Config::from_vars(&[])).with_extension(events.clone());
        let app = trama_sharing::router().into_app(state.clone());
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
    pub fn put(uri: &str) -> Self {
        Self::new(Method::PUT, uri)
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

/// A workspace `ws_<slug>` named `name`, with `settings` merged over the default roles.
pub async fn workspace_with(
    db: &DatabaseConnection,
    slug: &str,
    name: &str,
    settings: Value,
) -> workspaces::Model {
    let mut stored = json!({ "roles": fresh_workspace_roles() });
    for (key, value) in settings.as_object().cloned().unwrap_or_default() {
        stored[key] = value;
    }
    workspaces::ActiveModel {
        id: Set(format!("ws_{slug}")),
        name: Set(name.to_owned()),
        slug: Set(slug.to_owned()),
        settings: Set(stored),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

pub async fn workspace(db: &DatabaseConnection, slug: &str) -> workspaces::Model {
    workspace_with(db, slug, &slug.to_uppercase(), json!({})).await
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
pub fn only_projects(ids: &[&str]) -> Value {
    json!({
        "projects": { "all": false, "projectIds": ids },
        "includeUnassigned": false,
        "grants": [],
    })
}

/// `trama_session=<raw>` for a new session of `user`.
pub async fn session(db: &DatabaseConnection, user: &str) -> String {
    let s = trama_auth::service::create_session(db, user, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

/// A new API token; returns the secret to send as a bearer.
pub async fn token(db: &DatabaseConnection, ws: &str, user: &str) -> String {
    trama_auth::tokens::create_token(
        db,
        trama_auth::tokens::NewToken {
            workspace_id: ws.to_owned(),
            name: "cli".into(),
            actor: ActorRef::user(user),
            scope: Some(TokenScope::Admin),
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

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

pub async fn project(db: &DatabaseConnection, ws: &str, id: &str, name: &str, key: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
               VALUES ('{id}', '{ws}', '{name}', '#6b7280', 'in_progress', 'none', '{key}')"#
        ),
    )
    .await;
}

/// Reads one column of the first row of `select`, as JSON text.
pub async fn scalar(db: &DatabaseConnection, select: &str) -> Option<String> {
    use sea_orm::Statement;
    let row = db
        .query_one_raw(Statement::from_string(db.get_database_backend(), select.to_owned()))
        .await
        .unwrap()?;
    row.try_get::<Option<String>>("", "v").unwrap()
}
