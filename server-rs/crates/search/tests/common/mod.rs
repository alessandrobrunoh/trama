//! Fixtures shared by the database tests: rows inserted directly, the search router behind the
//! real access guard, and a request helper.

#![allow(dead_code, missing_docs)]

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_contracts::roles::{WorkspaceRole, fresh_workspace_roles};
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub app: Router,
}

impl World {
    pub async fn new() -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]));
        let app = trama_search::router().into_app(state.clone());
        Some(Self { test, state, app })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status: parts.status, body: json }
    }

    pub async fn drop(self) {
        self.test.drop().await;
    }
}

pub struct Res {
    pub status: StatusCode,
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

    /// `results[*].id`.
    pub fn ids(&self) -> Vec<String> {
        self.body["results"]
            .as_array()
            .unwrap_or_else(|| panic!("no results in {}", self.body))
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
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
    /// A browser session: the cookie and the CSRF header the web app sends.
    pub fn session(mut self, cookie: &str) -> Self {
        self.headers.push(("cookie".to_owned(), cookie.to_owned()));
        self.headers.push(("x-client-id".to_owned(), "test-client".to_owned()));
        self
    }
    fn build(self) -> Request<Body> {
        let mut req = Request::builder().method(self.method).uri(self.uri);
        for (name, value) in &self.headers {
            req = req.header(name, value);
        }
        req.body(Body::empty()).unwrap()
    }
}

// ───────────────────────────── rows ─────────────────────────────

pub async fn workspace(db: &DatabaseConnection, slug: &str) {
    workspace_with_roles(db, slug, &fresh_workspace_roles()).await;
}

pub async fn workspace_with_roles(db: &DatabaseConnection, slug: &str, roles: &[WorkspaceRole]) {
    workspaces::ActiveModel {
        id: Set(format!("ws_{slug}")),
        name: Set(slug.to_uppercase()),
        slug: Set(slug.to_owned()),
        settings: Set(json!({ "roles": roles })),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
}

/// A user, their membership of `ws_<slug>` with `role` and optional member access, and a
/// session cookie.
pub async fn person(
    db: &DatabaseConnection,
    slug: &str,
    id: &str,
    role: &str,
    access: Option<Value>,
) -> String {
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
    memberships::ActiveModel {
        id: Set(format!("mb_{slug}_{id}")),
        workspace_id: Set(format!("ws_{slug}")),
        user_id: Set(id.to_owned()),
        role: Set(role.to_owned()),
        access: Set(access),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let s = trama_auth::service::create_session(db, id, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

/// A project limit as the members route stores it.
pub fn only_projects(ids: &[&str], include_unassigned: bool) -> Value {
    json!({
        "projects": { "all": false, "projectIds": ids },
        "includeUnassigned": include_unassigned,
        "grants": [],
    })
}

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

/// `id`'s name is `name`; `summary` and `description` may be absent.
pub async fn project(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    name: &str,
    summary: Option<&str>,
    description: Option<&str>,
) {
    let quote = |v: Option<&str>| v.map_or("NULL".to_owned(), |v| format!("'{v}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, summary, description, color, status, priority, key)
               VALUES ('{id}', '{ws}', '{name}', {}, {}, 'blue', 'planned', 'none', left(md5('{id}'), 4))"#,
            quote(summary),
            quote(description)
        ),
    )
    .await;
}

pub async fn issue(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    key: &str,
    title: &str,
    project: Option<&str>,
) {
    let project = project.map_or("NULL".to_owned(), |p| format!("'{p}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", aliases)
               VALUES ('{id}', '{ws}', '{key}', 1, 'bug', '{title}', 'manual', 'none', 'todo', {project}, '[]')"#
        ),
    )
    .await;
}

/// An artifact of an issue (or none, with a legacy workstream key as its owner).
pub async fn artifact(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    title: &str,
    external_id: Option<&str>,
    issue: Option<&str>,
    legacy: Option<&str>,
) {
    let quote = |v: Option<&str>| v.map_or("NULL".to_owned(), |v| format!("'{v}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "externalId", "issueId", "legacyWorkstreamKey")
               VALUES ('{id}', '{ws}', 'build', 'github', '{title}', 'open', {}, {}, {})"#,
            quote(external_id),
            quote(issue),
            quote(legacy)
        ),
    )
    .await;
}
