//! Fixtures shared by the database tests: rows inserted directly, the real auth and workspace
//! routers over a throwaway database, and a request helper.

#![allow(dead_code, missing_docs)]

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_auth::tokens::{NewToken, create_token};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{ApiPermission, TokenScope, fresh_workspace_roles};
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{agents, memberships, users, workspaces};

/// `argon2.hash('password123')` from the NestJS server (node `argon2` 0.45).
pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

pub struct World {
    pub test: TestDb,
    pub app: Router,
    pub state: AppState,
}

impl World {
    pub async fn new() -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]));
        let app = trama_auth::router().merge(trama_workspaces::router()).into_app(state.clone());
        Some(Self { test, app, state })
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
            Value::String(s) => s.clone(),
            Value::Array(list) => {
                list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")
            }
            _ => String::new(),
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

pub async fn workspace(db: &DatabaseConnection, slug: &str) -> workspaces::Model {
    workspace_with(db, slug, json!({ "roles": fresh_workspace_roles() })).await
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

pub async fn agent(db: &DatabaseConnection, ws: &str, id: &str) -> agents::Model {
    agents::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(ws.to_owned()),
        name: Set("Bot".to_owned()),
        provider: Set("claude_code".to_owned()),
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

/// A token of `user` in `ws` with `scope`; returns its bearer secret.
pub async fn token(db: &DatabaseConnection, ws: &str, user: &str, scope: TokenScope) -> String {
    mint(db, ws, ActorRef::user(user), scope, None).await
}

/// A custom-scope token with exactly `permissions`.
pub async fn custom_token(
    db: &DatabaseConnection,
    ws: &str,
    user: &str,
    permissions: &[&'static str],
) -> String {
    let permissions = trama_auth::permissions::normalize_permissions(permissions);
    mint(db, ws, ActorRef::user(user), TokenScope::Custom, Some(permissions)).await
}

/// A token that acts as agent `agent`.
pub async fn agent_token(
    db: &DatabaseConnection,
    ws: &str,
    agent: &str,
    scope: TokenScope,
) -> String {
    mint(db, ws, ActorRef::agent(agent), scope, None).await
}

async fn mint(
    db: &DatabaseConnection,
    ws: &str,
    actor: ActorRef,
    scope: TokenScope,
    permissions: Option<Vec<ApiPermission>>,
) -> String {
    create_token(
        db,
        NewToken {
            workspace_id: ws.to_owned(),
            name: "k".into(),
            actor,
            scope: Some(scope),
            permissions,
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap()
    .1
}

/// Owner `u_owner`, admin `u_admin`, member `u_member`, viewer `u_viewer` in workspace `acme`
/// (`ws_acme`); `u_out` owns `other`. Returns the session cookie of each person.
pub struct People {
    pub owner: String,
    pub admin: String,
    pub member: String,
    pub viewer: String,
    pub out: String,
}

pub async fn people(w: &World) -> People {
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    for (id, role) in
        [("u_owner", "owner"), ("u_admin", "admin"), ("u_member", "member"), ("u_viewer", "viewer")]
    {
        user(w.db(), id).await;
        member(w.db(), "ws_acme", id, role, None).await;
    }
    user(w.db(), "u_out").await;
    member(w.db(), "ws_other", "u_out", "owner", None).await;
    People {
        owner: session(w.db(), "u_owner").await,
        admin: session(w.db(), "u_admin").await,
        member: session(w.db(), "u_member").await,
        viewer: session(w.db(), "u_viewer").await,
        out: session(w.db(), "u_out").await,
    }
}
