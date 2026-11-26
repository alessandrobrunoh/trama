//! Fixtures shared by the database tests: rows inserted directly, the insights router behind the
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
use trama_contracts::roles::fresh_workspace_roles;
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
        let app = trama_insights::router().into_app(state.clone());
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

pub async fn user(db: &DatabaseConnection, id: &str, name: &str) {
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
    user(db, id, &format!("User {id}")).await;
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

/// Inserts a row with the given columns (`("name", "<sql literal>")`).
async fn insert(db: &DatabaseConnection, table: &str, columns: Vec<(&str, String)>) {
    let names: Vec<String> = columns.iter().map(|(n, _)| format!("\"{n}\"")).collect();
    let values: Vec<&str> = columns.iter().map(|(_, v)| v.as_str()).collect();
    sql(db, &format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), values.join(", ")))
        .await;
}

fn with(
    mut columns: Vec<(&'static str, String)>,
    extra: &[(&'static str, &str)],
) -> Vec<(&'static str, String)> {
    for (name, value) in extra {
        columns.retain(|(n, _)| n != name);
        columns.push((name, (*value).to_owned()));
    }
    columns
}

pub async fn project(db: &DatabaseConnection, ws: &str, id: &str, status: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
               VALUES ('{id}', '{ws}', 'Project {id}', 'blue', '{status}', 'none', left(md5('{id}'), 4))"#
        ),
    )
    .await;
}

/// An issue in `todo` created 40 days ago, updated now, in `project`; `extra` overrides columns
/// with SQL literals (`("status", "'in_progress'")`).
pub async fn issue(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    project: Option<&str>,
    extra: &[(&'static str, &str)],
) {
    let columns = vec![
        ("id", format!("'{id}'")),
        ("workspaceId", format!("'{ws}'")),
        ("key", format!("'K-{id}'")),
        ("number", "1".to_owned()),
        ("kind", "'bug'".to_owned()),
        ("title", format!("'Issue {id}'")),
        ("source", "'manual'".to_owned()),
        ("priority", "'none'".to_owned()),
        ("status", "'todo'".to_owned()),
        ("projectId", project.map_or("NULL".to_owned(), |p| format!("'{p}'"))),
        ("aliases", "'[]'".to_owned()),
        ("createdAt", "now() - interval '40 days'".to_owned()),
        ("updatedAt", "now()".to_owned()),
    ];
    insert(db, "issues", with(columns, extra)).await;
}

/// An open pull request of `issue`, last updated `days` ago.
pub async fn pull_request(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    issue: &str,
    days: u32,
    extra: &[(&'static str, &str)],
) {
    let columns = vec![
        ("id", format!("'{id}'")),
        ("workspaceId", format!("'{ws}'")),
        ("kind", "'pull_request'".to_owned()),
        ("provider", "'github'".to_owned()),
        ("title", format!("'PR {id}'")),
        ("state", "'open'".to_owned()),
        ("issueId", format!("'{issue}'")),
        ("updatedAt", format!("now() - interval '{days} days'")),
    ];
    insert(db, "artifacts", with(columns, extra)).await;
}

pub async fn milestone(db: &DatabaseConnection, ws: &str, id: &str, project: &str, days_ago: i32) {
    insert(
        db,
        "milestones",
        vec![
            ("id", format!("'{id}'")),
            ("workspaceId", format!("'{ws}'")),
            ("name", format!("'Milestone {id}'")),
            ("projectId", format!("'{project}'")),
            ("targetDate", format!("now() - interval '{days_ago} days'")),
        ],
    )
    .await;
}

/// A domain event of `actor` ("user" or "agent") about `subject`, `days` ago.
pub async fn event(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    actor: (&str, &str),
    kind: &str,
    subject: &str,
    days: u32,
) {
    insert(
        db,
        "domain_events",
        vec![
            ("id", format!("'{id}'")),
            ("workspaceId", format!("'{ws}'")),
            ("at", format!("now() - interval '{days} days'")),
            ("actor", format!(r#"'{{"type":"{}","id":"{}"}}'"#, actor.0, actor.1)),
            ("type", format!("'{kind}'")),
            ("subject", format!(r#"'{{"type":"issue","id":"{subject}"}}'"#)),
        ],
    )
    .await;
}

pub async fn agent(db: &DatabaseConnection, ws: &str, id: &str, name: &str) {
    insert(
        db,
        "agents",
        vec![
            ("id", format!("'{id}'")),
            ("workspaceId", format!("'{ws}'")),
            ("name", format!("'{name}'")),
            ("provider", "'claude_code'".to_owned()),
        ],
    )
    .await;
}
