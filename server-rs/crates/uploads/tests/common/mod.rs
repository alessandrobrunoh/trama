//! Fixtures shared by the database tests: rows inserted directly, the uploads router behind the
//! real access guard and the HTTP layers, and request helpers (multipart included).

#![allow(dead_code, missing_docs)]

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

pub const PNG: [u8; 10] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub app: Router,
}

impl World {
    pub async fn new() -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let state =
            AppState::new(test.db.clone(), Config::from_vars(&[])).with_extension(Events::local());
        // the same layers as the real server, so the body limit of the route is what is tested
        let api = trama_uploads::router().into_router(&state);
        let app = Router::new().nest("/api", api).with_state(state.clone());
        let app = trama_core::http::with_http_layers(app, &state.config);
        Some(Self { test, state, app })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes().to_vec();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status: parts.status, headers: parts.headers, body: json, bytes }
    }

    pub async fn drop(self) {
        self.test.drop().await;
    }
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub bytes: Vec<u8>,
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

    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).map(|v| v.to_str().unwrap()).unwrap_or_default()
    }
}

const BOUNDARY: &str = "----trama-test-boundary";

/// One part of a multipart body.
pub enum Part<'a> {
    File { field: &'a str, filename: &'a str, bytes: &'a [u8] },
    Text { field: &'a str, value: &'a str },
}

pub struct Req {
    method: Method,
    uri: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
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
        self.body = Some(body.to_string().into_bytes());
        self.header("content-type", "application/json")
    }
    /// A `multipart/form-data` body of `parts`.
    pub fn multipart(mut self, parts: &[Part]) -> Self {
        let mut body: Vec<u8> = Vec::new();
        for part in parts {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            match part {
                Part::File { field, filename, bytes } => {
                    body.extend_from_slice(
                        format!(
                            "Content-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    body.extend_from_slice(bytes);
                }
                Part::Text { field, value } => {
                    body.extend_from_slice(
                        format!("Content-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}")
                            .as_bytes(),
                    );
                }
            }
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        self.body = Some(body);
        self.header("content-type", &format!("multipart/form-data; boundary={BOUNDARY}"))
    }
    /// The usual upload: one file in the `file` field.
    pub fn file(self, filename: &str, bytes: &[u8]) -> Self {
        self.multipart(&[Part::File { field: "file", filename, bytes }])
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

/// A user, their membership of `ws_<slug>` with `role`, and a session cookie.
pub async fn person(
    db: &DatabaseConnection,
    slug: &str,
    id: &str,
    role: &str,
    access: Option<Value>,
) -> String {
    user(db, id).await;
    member(db, &format!("ws_{slug}"), id, role, access).await;
    session(db, id).await
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

/// An issue with an explicit key and optional aliases.
pub async fn issue(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    key: &str,
    project: Option<&str>,
    aliases: &[&str],
) {
    let project = project.map_or("NULL".to_owned(), |p| format!("'{p}'"));
    let aliases = json!(aliases);
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", aliases)
               VALUES ('{id}', '{ws}', '{key}', 1, 'bug', 'Issue {id}', 'manual', 'none', 'backlog', {project}, '{aliases}')"#
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

pub async fn comment(db: &DatabaseConnection, ws: &str, id: &str, subject: &Value, body: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
               VALUES ('{id}', '{ws}', '{subject}', '{{"type":"system"}}', '{body}')"#
        ),
    )
    .await;
}

/// A new API token; returns its secret to send as a bearer.
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
