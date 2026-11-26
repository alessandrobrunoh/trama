//! Fixtures shared by the database tests: rows inserted directly, the integrations router behind
//! the real access guard, a fake GitHub and a request helper.

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
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};
use trama_events::Events;
use trama_integrations::http::{Http, HttpClient, HttpFailure, HttpRequest, HttpResponse};

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

/// Every request the fake sent, shared with the test.
pub type Seen = Arc<Mutex<Vec<HttpRequest>>>;

/// GitHub answers `GET /user` with the login encoded in the token: `tok_<login>`; anything else
/// is refused. `GET /user/repos` lists two repositories. A token `boom` makes GitHub fail with
/// a 500 and `offline` makes the request fail before an answer.
pub struct MockGithub {
    pub seen: Seen,
}

#[async_trait]
impl HttpClient for MockGithub {
    async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
        self.seen.lock().unwrap().push(req.clone());
        let auth = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.trim_start_matches("Bearer ").to_owned())
            .unwrap_or_default();
        let reply =
            |status: u16, json: Value| Ok(HttpResponse { status, headers: BTreeMap::new(), json });
        if auth == "offline" {
            return Err(HttpFailure("connect ECONNREFUSED".to_owned()));
        }
        if auth == "boom" {
            return reply(500, json!({ "message": "Server Error" }));
        }
        let Some(login) = auth.strip_prefix("tok_") else {
            return reply(401, json!({ "message": "Bad credentials" }));
        };
        if req.url.contains("/user/repos") {
            return Ok(HttpResponse {
                status: 200,
                headers: BTreeMap::from([(
                    "link".to_owned(),
                    "<https://api.github.com/x?page=2>; rel=\"next\"".to_owned(),
                )]),
                json: json!([
                    { "full_name": format!("{login}/app"), "html_url": format!("https://github.com/{login}/app"),
                      "default_branch": "main", "private": false },
                    { "full_name": format!("{login}/lib"), "html_url": format!("https://github.com/{login}/lib") },
                ]),
            });
        }
        reply(200, json!({ "login": login }))
    }
}

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub app: Router,
    pub seen: Seen,
}

impl World {
    pub async fn new() -> Option<Self> {
        Self::with_vars(&[("PUBLIC_URL", "https://trama.test")]).await
    }

    pub async fn with_vars(vars: &[(&str, &str)]) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let seen = Seen::default();
        let state = AppState::new(test.db.clone(), Config::from_vars(vars))
            .with_extension(Events::local())
            .with_extension(Http::new(MockGithub { seen: seen.clone() }));
        let app = trama_integrations::router().into_app(state.clone());
        Some(Self { test, state, app, seen })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status: parts.status, headers: parts.headers, body: json, raw: bytes.to_vec() }
    }

    pub async fn drop(self) {
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

/// A new API token acting as `user`; returns its secret to send as a bearer.
pub async fn token(
    db: &DatabaseConnection,
    ws: &str,
    user: &str,
    scope: trama_contracts::roles::TokenScope,
    permissions: Option<&[&str]>,
) -> String {
    trama_auth::tokens::create_token(
        db,
        trama_auth::tokens::NewToken {
            workspace_id: ws.to_owned(),
            name: "k".into(),
            actor: trama_contracts::common::ActorRef::user(user),
            scope: Some(scope),
            permissions: permissions.map(trama_auth::permissions::normalize_permissions),
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap()
    .1
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

/// An issue with an explicit key.
pub async fn issue(db: &DatabaseConnection, ws: &str, id: &str, key: &str, project: Option<&str>) {
    let project = project.map_or("NULL".to_owned(), |p| format!("'{p}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", aliases)
               VALUES ('{id}', '{ws}', '{key}', 1, 'bug', 'Issue {id}', 'manual', 'none', 'backlog', {project}, '[]')"#
        ),
    )
    .await;
}
