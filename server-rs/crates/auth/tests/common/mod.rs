//! Fixtures shared by the database tests: rows inserted directly, a gated test router standing in
//! for the workspace modules, and a request helper.

#![allow(dead_code, missing_docs)]

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use trama_auth::member_access::current_access;
use trama_auth::tokens::{NewToken, create_token};
use trama_auth::upload_caller::current_upload_caller;
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{
    ApiPermission, Capability, LegacyRole, TokenScope, fresh_workspace_roles,
};
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{agents, memberships, users, workspaces};

/// `argon2.hash('password123')` from the NestJS server (node `argon2` 0.45).
pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

pub struct World {
    pub test: TestDb,
    pub app: Router,
}

impl World {
    pub async fn new() -> Option<Self> {
        Self::with_config(Config::from_vars(&[])).await
    }

    pub async fn with_config(config: Config) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let state = AppState::new(test.db.clone(), config);
        let app = trama_auth::router().merge(test_routes()).into_app(state);
        Some(Self { test, app })
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
        self.body["message"].as_str().unwrap_or_default().to_owned()
    }

    pub fn set_cookies(&self) -> Vec<String> {
        self.headers.get_all("set-cookie").iter().map(|v| v.to_str().unwrap().to_owned()).collect()
    }

    /// `name=value; …` of every Set-Cookie, as a browser would send them back.
    pub fn cookie_header(&self) -> String {
        self.set_cookies()
            .iter()
            .map(|c| c.split(';').next().unwrap().to_owned())
            .collect::<Vec<_>>()
            .join("; ")
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
    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(body.to_string());
        self.header("content-type", "application/json")
    }
    pub fn raw(mut self, content_type: &str, body: &str) -> Self {
        self.body = Some(body.to_owned());
        self.header("content-type", content_type)
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

pub struct Tok {
    pub ws: String,
    pub actor: ActorRef,
    pub scope: Option<TokenScope>,
    pub permissions: Option<Vec<&'static str>>,
    pub limits: Option<Value>,
}

impl Tok {
    pub fn user(ws: &str, user: &str, scope: TokenScope) -> Self {
        Self {
            ws: ws.to_owned(),
            actor: ActorRef::user(user),
            scope: Some(scope),
            permissions: None,
            limits: None,
        }
    }
    pub fn custom(ws: &str, user: &str, permissions: &[&'static str]) -> Self {
        Self { permissions: Some(permissions.to_vec()), ..Self::user(ws, user, TokenScope::Custom) }
    }
    pub fn agent(ws: &str, agent: &str, scope: TokenScope) -> Self {
        Self { actor: ActorRef::agent(agent), ..Self::user(ws, "", scope) }
    }
    pub fn limits(mut self, limits: Value) -> Self {
        self.limits = Some(limits);
        self
    }
    pub async fn mint(
        self,
        db: &DatabaseConnection,
    ) -> (trama_entities::api_tokens::Model, String) {
        let permissions =
            self.permissions.map(|p| trama_auth::permissions::normalize_permissions(&p));
        create_token(
            db,
            NewToken {
                workspace_id: self.ws,
                name: "k".into(),
                actor: self.actor,
                scope: self.scope,
                permissions: permissions.map(|p: Vec<ApiPermission>| p),
                limits: self.limits,
                created_by_user_id: None,
                expires_at: None,
            },
        )
        .await
        .unwrap()
    }
}

// ───────────────────────────── a stand-in for the workspace modules ─────────────────────────────

/// What the handler saw: the workspace context and the task-locals.
async fn echo(ctx: Ctx) -> Json<Value> {
    Json(json!({
        "workspace": ctx.workspace.slug,
        "role": ctx.role,
        "owner": ctx.owner,
        "tokenScope": ctx.token_scope,
        "capabilities": ctx.capabilities,
        "access": ctx.access,
        "currentAccess": current_access().map(|a| serde_json::to_value(&*a).unwrap()),
        "uploadPermissions": current_upload_caller().and_then(|c| c.permissions.clone()),
        "actor": ctx.actor,
    }))
}

async fn created(ctx: Ctx) -> (StatusCode, Json<Value>) {
    (StatusCode::CREATED, echo(ctx).await)
}

async fn no_content(_: Ctx) -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn account(auth: Auth) -> Json<Value> {
    Json(json!({ "actor": auth.actor }))
}

async fn account_created(auth: Auth) -> (StatusCode, Json<Value>) {
    (StatusCode::CREATED, account(auth).await)
}

const ADMIN: Gate = Gate::authenticated().roles(LegacyRole::Admin);

/// The routes of the NestJS controllers the e2e tests call, with their decorators and handlers
/// that only echo what the guard resolved.
pub fn test_routes() -> Routes {
    let w = Gate::authenticated();
    Routes::new()
        .get("/workspaces", w.require_user(), account)
        .post("/workspaces", w.require_user().session_only(), account_created)
        .get("/w/{slug}", w, echo)
        .patch("/w/{slug}", ADMIN, echo)
        .get("/w/{slug}/snapshot", w.require_user(), echo)
        .get("/w/{slug}/tasks", w, echo)
        .post("/w/{slug}/tasks", w.can(Capability::CreateIssues), created)
        .patch("/w/{slug}/tasks/{idOrKey}", w, echo)
        .delete("/w/{slug}/tasks/{idOrKey}", w.can(Capability::DeleteIssues), no_content)
        .get("/w/{slug}/tasks/{idOrKey}/artifacts", w, echo)
        .post("/w/{slug}/tasks/{idOrKey}/artifacts", w, created)
        .get("/w/{slug}/projects", w, echo)
        .post("/w/{slug}/projects", w.can(Capability::ManageProjects), created)
        .post("/w/{slug}/agents", ADMIN.can(Capability::ManageAgents), created)
        .get("/w/{slug}/integrations", w.can(Capability::ManageIntegrations), echo)
        .get("/w/{slug}/tokens", w.no_guests(), echo)
        .post("/w/{slug}/ai/chat", w.require_user().no_guests(), created)
        .get("/w/{slug}/uploads/{id}", w, echo)
        .post("/w/{slug}/uploads", w.multipart(), created)
}
