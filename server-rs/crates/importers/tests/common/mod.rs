//! Fixtures of the database tests: rows inserted directly, the importers router behind the real
//! access guard, a fake tracker and a request helper.

#![allow(dead_code, missing_docs, clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;
use trama_contracts::imports::{ExternalProvider, ImportOptions, ImportSource};
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{memberships, users, workspaces};
use trama_events::Events;
use trama_importers::SourceFactory;
use trama_importers::types::{
    DiscoveredEntity, Discovery, DiscoveryCounts, ExternalComment, ExternalIssue, ExternalLabel,
    ExternalMilestone, ExternalState, ExternalUser, ImportSourceAdapter, Page, SourceError,
};

pub const NODE_HASH: &str = "$argon2id$v=19$m=65536,p=4,t=3$xV+4DNQq8ppsv6u/pifM1Q$oli1O6AARXzBwvEyabPrnDfW3iozierTQTNYkbYmuAU";

pub struct World {
    pub test: TestDb,
    pub state: AppState,
    pub app: Router,
    pub fake: Arc<Fake>,
}

impl World {
    /// A migrated database, the importers router and a fake tracker the runner reads from.
    pub async fn new(fake: Fake) -> Option<Self> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let fake = Arc::new(fake);
        let source = Arc::clone(&fake);
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]))
            .with_extension(Events::local())
            .with_extension(SourceFactory::new(move |_, _| {
                Arc::new(Shared(Arc::clone(&source))) as Arc<dyn ImportSourceAdapter>
            }));
        let state = trama_importers::with_services(state);
        let app = trama_importers::router().into_app(state.clone());
        Some(Self { test, state, app, fake })
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.test.db
    }

    pub async fn send(&self, req: Req) -> Res {
        let res = self.app.clone().oneshot(req.build()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        Res { status: parts.status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
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
    pub fn delete(uri: &str) -> Self {
        Self::new(Method::DELETE, uri)
    }
    pub fn session(mut self, cookie: &str) -> Self {
        self.headers.push(("cookie".into(), cookie.to_owned()));
        self.headers.push(("x-client-id".into(), "test-client".into()));
        self
    }
    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(body.to_string());
        self.headers.push(("content-type".into(), "application/json".into()));
        self
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

/// A user with a membership and a session; returns the cookie.
pub async fn person(db: &DatabaseConnection, ws: &str, id: &str, role: &str) -> String {
    user(db, id).await;
    memberships::ActiveModel {
        id: Set(format!("mb_{ws}_{id}")),
        workspace_id: Set(ws.to_owned()),
        user_id: Set(id.to_owned()),
        role: Set(role.to_owned()),
        access: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let s = trama_auth::service::create_session(db, id, Some("test")).await.unwrap();
    format!("trama_session={}", s.raw)
}

pub async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

/// Polls `check` until it answers `Some`, failing the test after 20 seconds.
pub async fn eventually<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let started = Instant::now();
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

// ───────────────────────────── a fake tracker ─────────────────────────────

pub fn state_of(kind: &str) -> ExternalState {
    let name = if kind == "open" { "Open" } else { "Closed" };
    ExternalState { id: kind.into(), name: name.into(), kind: kind.into() }
}

pub fn ada() -> ExternalUser {
    ExternalUser { id: "ada".into(), login: Some("ada".into()), ..ExternalUser::default() }
}

pub fn gh_issue(n: u32) -> ExternalIssue {
    ExternalIssue {
        id: format!("acme/api#{n}"),
        key: format!("#{n}"),
        url: format!("https://github.com/acme/api/issues/{n}"),
        title: format!("Issue {n}"),
        body: Some(format!("Body of {n}")),
        state: state_of("open"),
        priority: None,
        estimate: None,
        labels: Vec::new(),
        assignee: None,
        creator: Some(ExternalUser {
            id: "ada".into(),
            login: Some("ada".into()),
            ..ExternalUser::default()
        }),
        team_id: None,
        project_id: None,
        milestone: None,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-02T00:00:00Z".into(),
        started_at: None,
        closed_at: None,
    }
}

pub fn gh_comment(id: &str, issue: u32, body: &str) -> ExternalComment {
    ExternalComment {
        id: id.into(),
        issue_id: format!("acme/api#{issue}"),
        author: Some(ExternalUser {
            id: "ada".into(),
            login: Some("ada".into()),
            ..ExternalUser::default()
        }),
        body: body.into(),
        created_at: "2026-02-03T10:00:00Z".into(),
    }
}

pub fn discovery(issues: usize) -> Discovery {
    Discovery {
        provider: ExternalProvider::Github,
        account: "ada".into(),
        source_label: "acme/api".into(),
        source_url: Some("https://github.com/acme/api".into()),
        counts: DiscoveryCounts {
            issues: Some(i64::try_from(issues).unwrap()),
            open: Some(i64::try_from(issues).unwrap()),
            closed: Some(0),
        },
        teams: vec![],
        projects: vec![],
        labels: vec![],
        milestones: vec![],
        users: vec![],
        statuses: vec![],
        sample: vec![],
        warnings: vec![],
    }
}

pub fn entity(id: &str, name: &str, color: Option<&str>) -> DiscoveredEntity {
    DiscoveredEntity {
        id: id.into(),
        name: name.into(),
        color: color.map(str::to_owned),
        ..DiscoveredEntity::default()
    }
}

pub fn label(id: &str, name: &str, color: &str) -> ExternalLabel {
    ExternalLabel { id: id.into(), name: name.into(), color: Some(color.into()) }
}

pub fn milestone(id: &str, name: &str, project: &str) -> ExternalMilestone {
    ExternalMilestone {
        id: id.into(),
        name: name.into(),
        project_id: Some(project.into()),
        description: Some("First release".into()),
        due_on: Some("2026-12-31T00:00:00Z".into()),
    }
}

/// A tracker with pages of 2 issues and 2 comments. Calls to `issues` can be scripted to fail
/// or to wait for the test.
pub struct Fake {
    pub discovery: Mutex<Discovery>,
    pub issues: Mutex<Vec<ExternalIssue>>,
    pub comments: Mutex<Vec<ExternalComment>>,
    pub discover_calls: AtomicUsize,
    pub issue_calls: AtomicUsize,
    failures: Mutex<HashMap<usize, SourceError>>,
    gate: Mutex<Option<Gate>>,
}

/// The call that waits, the permits it waits for and the signal that it arrived.
type Gate = (usize, Arc<Semaphore>, Arc<Notify>);

impl Fake {
    pub fn new(issues: Vec<ExternalIssue>, comments: Vec<ExternalComment>) -> Self {
        Self {
            discovery: Mutex::new(discovery(issues.len())),
            issues: Mutex::new(issues),
            comments: Mutex::new(comments),
            discover_calls: AtomicUsize::new(0),
            issue_calls: AtomicUsize::new(0),
            failures: Mutex::new(HashMap::new()),
            gate: Mutex::new(None),
        }
    }

    /// The `call`-th request for issues (1-based, counted over the whole test) fails with `error`.
    pub fn fail_call(&self, call: usize, error: SourceError) {
        self.failures.lock().unwrap().insert(call, error);
    }

    pub fn clear_failures(&self) {
        self.failures.lock().unwrap().clear();
    }

    /// The `call`-th request for issues announces itself on the returned `Notify` and waits for a
    /// permit of the returned semaphore.
    pub fn gate_call(&self, call: usize) -> (Arc<Semaphore>, Arc<Notify>) {
        let (permits, entered) = (Arc::new(Semaphore::new(0)), Arc::new(Notify::new()));
        *self.gate.lock().unwrap() = Some((call, Arc::clone(&permits), Arc::clone(&entered)));
        (permits, entered)
    }

    /// Every request for issues waits for a permit.
    pub fn gate_every_call(&self) -> (Arc<Semaphore>, Arc<Notify>) {
        self.gate_call(usize::MAX)
    }
}

/// Lets the factory hand out clones of one `Fake`.
pub struct Shared(pub Arc<Fake>);

fn page<T: Clone>(all: &[T], cursor: Option<&str>) -> Page<T> {
    let from: usize = cursor.map_or(0, |c| c.parse().unwrap());
    Page {
        items: all.iter().skip(from).take(2).cloned().collect(),
        next: (from + 2 < all.len()).then(|| (from + 2).to_string()),
    }
}

#[async_trait]
impl ImportSourceAdapter for Shared {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Github
    }

    async fn discover(&self) -> Result<Discovery, SourceError> {
        self.0.discover_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = self.0.failures.lock().unwrap().get(&0) {
            return Err(error.clone());
        }
        Ok(self.0.discovery.lock().unwrap().clone())
    }

    async fn issues(
        &self,
        cursor: Option<&str>,
        _options: &ImportOptions,
    ) -> Result<Page<ExternalIssue>, SourceError> {
        let call = self.0.issue_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let gate = self.0.gate.lock().unwrap().clone();
        if let Some((at, permits, entered)) = gate
            && (at == call || at == usize::MAX)
        {
            entered.notify_one();
            permits.acquire().await.unwrap().forget();
        }
        if let Some(error) = self.0.failures.lock().unwrap().get(&call) {
            return Err(error.clone());
        }
        Ok(page(&self.0.issues.lock().unwrap(), cursor))
    }

    async fn comments(&self, cursor: Option<&str>) -> Result<Page<ExternalComment>, SourceError> {
        Ok(page(&self.0.comments.lock().unwrap(), cursor))
    }

    async fn get_issue(&self, _id: &str) -> Result<ExternalIssue, SourceError> {
        Err(SourceError::Unexpected("not used".into()))
    }
}

pub fn source() -> ImportSource {
    ImportSource { repository: Some("acme/api".into()), team_ids: None }
}
