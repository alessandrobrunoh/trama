//! Fixtures shared by the database tests: rows inserted directly, the snapshot router behind the
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
use trama_auth::tokens::{NewToken, create_token};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{TokenScope, WorkspaceRole, fresh_workspace_roles};
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{agents, memberships, users, workspaces};

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
        let app = trama_snapshot::router().into_app(state.clone());
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
        self.headers.push(("cookie".into(), format!("trama_session={cookie}")));
        self.headers.push(("x-client-id".into(), "test-client".into()));
        self
    }
    pub fn bearer(mut self, secret: &str) -> Self {
        self.headers.push(("authorization".into(), format!("Bearer {secret}")));
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

pub async fn user(db: &DatabaseConnection, id: &str) {
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

pub async fn workspace(db: &DatabaseConnection, slug: &str) {
    workspace_with_roles(db, slug, &fresh_workspace_roles()).await;
}

/// A user, their membership of `ws_<slug>` with `role` and optional member access, and a session
/// cookie.
pub async fn person(
    db: &DatabaseConnection,
    slug: &str,
    id: &str,
    role: &str,
    access: Option<Value>,
) -> String {
    user(db, id).await;
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
    s.raw
}

/// A project limit as the members route stores it.
pub fn only_projects(ids: &[&str], include_unassigned: bool) -> Value {
    json!({
        "projects": { "all": false, "projectIds": ids },
        "includeUnassigned": include_unassigned,
        "grants": [],
    })
}

/// A write token of a new agent; returns the secret to send as a bearer.
pub async fn agent_token(db: &DatabaseConnection, ws: &str, id: &str) -> String {
    agents::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(ws.to_owned()),
        name: Set("Bot".into()),
        provider: Set("claude_code".into()),
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

/// An agent, with the `users` row its task assignments point at (`issues.assigneeId`
/// references `users`).
pub async fn agent(db: &DatabaseConnection, ws: &str, id: &str) {
    user(db, id).await;
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

/// An issue of `project` (`None`: no project) assigned to `assignee` (`None`: nobody).
pub async fn issue(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    project: Option<&str>,
    assignee: Option<&str>,
    parent: Option<&str>,
) {
    let opt = |v: Option<&str>| v.map_or("NULL".to_owned(), |v| format!("'{v}'"));
    sql(
        db,
        &format!(
            r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", "assigneeId", "parentId", aliases)
               VALUES ('{id}', '{ws}', 'K-{id}', 1, 'bug', 'Issue {id}', 'manual', 'none', 'backlog', {}, {}, {}, '[]')"#,
            opt(project),
            opt(assignee),
            opt(parent)
        ),
    )
    .await;
}

/// An artifact of `issue` with the given review result.
pub async fn artifact(db: &DatabaseConnection, ws: &str, id: &str, issue: &str, review: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, review, ci, "issueId")
               VALUES ('{id}', '{ws}', 'pull_request', 'github', 'PR {id}', 'open', '{review}', NULL, '{issue}')"#
        ),
    )
    .await;
}

/// A comment on a subject, by an author.
pub async fn comment(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    subject: &Value,
    author: &Value,
    body: &str,
) {
    sql(
        db,
        &format!(
            r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
               VALUES ('{id}', '{ws}', '{subject}', '{author}', '{body}')"#
        ),
    )
    .await;
}

/// A domain event about a subject.
pub async fn event(
    db: &DatabaseConnection,
    ws: &str,
    id: &str,
    kind: &str,
    subject: &Value,
    data: &Value,
) {
    sql(
        db,
        &format!(
            r#"INSERT INTO domain_events (id, "workspaceId", at, actor, type, subject, data)
               VALUES ('{id}', '{ws}', now(), '{{"type":"system"}}', '{kind}', '{subject}', '{data}')"#
        ),
    )
    .await;
}

/// A workspace-owned git connection.
pub async fn connection(db: &DatabaseConnection, ws: &str, id: &str, account: &str) {
    sql(
        db,
        &format!(
            r#"INSERT INTO integration_connections (id, "workspaceId", "ownerType", label, provider, account, host, status, config)
               VALUES ('{id}', '{ws}', 'workspace', 'GitHub · {account}', 'github', '{account}', 'github.com', 'connected', '{{}}')"#
        ),
    )
    .await;
}
