//! The import loop (`importers/import-engine.ts`), free of HTTP and SQL: pages in, issues out,
//! with a checkpoint after each page.
//!
//! It is resumable (the state carries phase, cursor and plan) and idempotent (the sink refuses a
//! second copy of an external id), so a crash or a re-run never duplicates.

use std::collections::{HashMap, HashSet};
use std::error::Error as _;
use std::future::Future;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use trama_contracts::imports::{
    ExternalProvider, ExternalRef, ExternalRefOrigin, ImportErrorEntry, ImportMapping,
    ImportOptions, ImportPhase, ImportProgress,
};
use trama_contracts::js;
use trama_core::AppError;

use crate::mapping::NewIssue;
use crate::mapping::{ResolvedPlan, external_ref_of, parse_date, redact_secrets, to_new_issue};
use crate::types::{Discovery, ExternalComment, ExternalIssue, ImportSourceAdapter, SourceError};

/// Most errors kept on a job; `progress.failed` has the real count.
pub const MAX_STORED_ERRORS: usize = 100;
const MAX_RATE_WAITS_IN_A_ROW: u32 = 30;
const TRANSIENT_RETRIES: u32 = 3;
/// Longest stored error message.
const MAX_ERROR_MESSAGE: usize = 300;
/// Longest imported comment.
const MAX_COMMENT_BODY: usize = 20_000;

/// Why a step of an import failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportError {
    /// The provider told us no (bad credential, missing repository...), or a reference the
    /// import depends on is gone: retrying cannot help (`ImportFatalError`).
    Fatal(String),
    /// Anything else (a database error, a failed hook).
    Failed(String),
}

impl ImportError {
    /// A fatal error.
    #[must_use]
    pub fn fatal(message: impl Into<String>) -> Self {
        Self::Fatal(message.into())
    }

    /// The message.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Fatal(m) | Self::Failed(m) => m,
        }
    }

    /// Whether retrying cannot help.
    #[must_use]
    pub const fn is_fatal(&self) -> bool {
        matches!(self, Self::Fatal(_))
    }
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ImportError {}

impl From<sea_orm::DbErr> for ImportError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<AppError> for ImportError {
    /// The message an `HttpException` would carry: the wrapped error when there is one (a
    /// database failure), else the response message without its status prefix.
    fn from(error: AppError) -> Self {
        if let Some(source) = error.source() {
            return Self::Failed(source.to_string());
        }
        let shown = error.to_string();
        Self::Failed(
            shown.split_once(": ").map_or(shown.clone(), |(_, message)| message.to_owned()),
        )
    }
}

/// Whether `create_issue` wrote a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateOutcome {
    /// A new issue.
    Created,
    /// Another run (or a link) got there first.
    Exists,
}

/// An imported comment, written by the person who ran the import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewComment {
    /// Tracker id of the comment.
    pub external_id: String,
    /// Trama issue it goes on.
    pub issue_id: String,
    /// Body, with the original author and day in the text.
    pub body: String,
    /// When the tracker says it was written.
    pub created_at: DateTime<Utc>,
}

/// What the engine needs from persistence. Every method is scoped to one workspace by its
/// implementation.
#[async_trait]
pub trait ImportSink: Send + Sync {
    /// Creates (idempotently) what the mapping asks to create and returns Trama ids per external
    /// id.
    async fn resolve_plan(
        &self,
        discovery: &Discovery,
        mapping: &ImportMapping,
    ) -> Result<ResolvedPlan, ImportError>;

    /// External issue id → Trama issue id, for the ids that were already imported or linked.
    async fn existing_issues(
        &self,
        provider: ExternalProvider,
        ids: &[String],
    ) -> Result<HashMap<String, String>, ImportError>;

    /// `Exists` when another run (or a link) got there first.
    async fn create_issue(&self, issue: &NewIssue) -> Result<CreateOutcome, ImportError>;

    /// Refreshes the mirrored external status of an issue that was already imported.
    async fn refresh_ref(
        &self,
        provider: ExternalProvider,
        id: &str,
        reference: &ExternalRef,
    ) -> Result<(), ImportError>;

    /// Comment ids (external) already imported.
    async fn existing_comments(
        &self,
        provider: ExternalProvider,
        ids: &[String],
    ) -> Result<HashSet<String>, ImportError>;

    /// `false` when the comment was already imported.
    async fn create_comment(
        &self,
        provider: ExternalProvider,
        comment: &NewComment,
    ) -> Result<bool, ImportError>;
}

/// Where a job stands: what a checkpoint stores and a resume continues from.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineState {
    /// Current phase.
    pub phase: ImportPhase,
    /// The provider's page cursor within the phase.
    pub cursor: Option<String>,
    /// What the mapping resolved to; set once the source was described.
    pub plan: Option<ResolvedPlan>,
    /// Counters.
    pub progress: ImportProgress,
    /// First failures (capped at [`MAX_STORED_ERRORS`]).
    pub errors: Vec<ImportErrorEntry>,
}

/// `emptyProgress()`.
#[must_use]
pub const fn empty_progress() -> ImportProgress {
    ImportProgress {
        phase: ImportPhase::Setup,
        total: None,
        processed: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        comments: 0,
    }
}

impl EngineState {
    /// A job that has not started.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            phase: ImportPhase::Setup,
            cursor: None,
            plan: None,
            progress: empty_progress(),
            errors: Vec::new(),
        }
    }

    /// The state a job continues from: its stored `cursor` column (`{phase, cursor, plan}`),
    /// `progress` and `errors`. Progress fields missing from the stored object keep their
    /// empty value (`{ ...emptyProgress(), ...job.progress }`).
    #[must_use]
    pub fn resume(cursor: Option<&Value>, progress: &Value, errors: &Value) -> Self {
        let mut merged = serde_json::to_value(empty_progress()).unwrap_or(Value::Null);
        if let (Some(base), Some(stored)) = (merged.as_object_mut(), progress.as_object()) {
            for (key, value) in stored {
                base.insert(key.clone(), value.clone());
            }
        }
        let stored = cursor.and_then(Value::as_object);
        Self {
            phase: stored
                .and_then(|c| c.get("phase"))
                .and_then(Value::as_str)
                .and_then(ImportPhase::parse)
                .unwrap_or(ImportPhase::Setup),
            cursor: stored.and_then(|c| c.get("cursor")).and_then(Value::as_str).map(str::to_owned),
            plan: stored
                .and_then(|c| c.get("plan"))
                .filter(|p| !p.is_null())
                .and_then(|p| serde_json::from_value(p.clone()).ok()),
            progress: serde_json::from_value(merged).unwrap_or_else(|_| empty_progress()),
            errors: serde_json::from_value(errors.clone()).unwrap_or_default(),
        }
    }

    /// The `cursor` column: `{ phase, cursor, plan }` (`plan` left out until there is one).
    #[must_use]
    pub fn cursor_json(&self) -> Value {
        let mut out = json!({ "phase": self.phase, "cursor": self.cursor });
        if let (Some(plan), Some(object)) = (&self.plan, out.as_object_mut()) {
            object.insert("plan".into(), serde_json::to_value(plan).unwrap_or(Value::Null));
        }
        out
    }
}

impl Default for EngineState {
    fn default() -> Self {
        Self::new()
    }
}

/// What the runner lends the engine.
#[async_trait]
pub trait EngineHooks: Send + Sync {
    /// Persist progress, cursor and the heartbeat. Called after every page.
    async fn checkpoint(&self, state: &EngineState) -> Result<(), ImportError>;

    /// Right after the source was described, before anything is written (label, totals).
    async fn on_discovery(&self, _discovery: &Discovery) -> Result<(), ImportError> {
        Ok(())
    }

    /// Whether the user asked to stop.
    async fn is_canceled(&self) -> Result<bool, ImportError>;

    /// Sleep through a rate limit. `Release` hands the job back to the queue (the wait is too
    /// long to hold on).
    async fn wait(&self, until: DateTime<Utc>) -> Result<WaitOutcome, ImportError>;

    /// Sleep for `ms` milliseconds.
    async fn sleep(&self, ms: u64);

    /// The current time.
    fn now(&self) -> DateTime<Utc>;
}

/// How a rate-limit wait ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    /// The window passed (or the job was canceled): carry on.
    Resume,
    /// Give the job back to the queue.
    Release,
}

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineOutcome {
    /// Every page was read.
    Completed,
    /// The user asked to stop; what was imported stays.
    Canceled,
    /// Handed back to the queue to wait out a long rate limit.
    Released,
}

/// What interrupts a step: the job was handed back, or something failed.
enum Stop {
    Released,
    Error(ImportError),
}

impl From<ImportError> for Stop {
    fn from(error: ImportError) -> Self {
        Self::Error(error)
    }
}

/// The loop: reads pages from `source`, writes them through `sink`, checkpoints through `hooks`.
pub struct ImportEngine<'a> {
    provider: ExternalProvider,
    source: &'a dyn ImportSourceAdapter,
    sink: &'a dyn ImportSink,
    mapping: &'a ImportMapping,
    options: ImportOptions,
    hooks: &'a dyn EngineHooks,
    /// Strings to scrub from anything stored: the token.
    secrets: Vec<String>,
}

impl<'a> ImportEngine<'a> {
    /// An engine for one job.
    #[must_use]
    pub fn new(
        provider: ExternalProvider,
        source: &'a dyn ImportSourceAdapter,
        sink: &'a dyn ImportSink,
        mapping: &'a ImportMapping,
        options: ImportOptions,
        hooks: &'a dyn EngineHooks,
        secrets: Vec<String>,
    ) -> Self {
        Self { provider, source, sink, mapping, options, hooks, secrets }
    }

    /// Runs (or continues) the import described by `state`, updating it as it goes.
    ///
    /// # Errors
    ///
    /// [`ImportError::Fatal`] when the provider refused or kept failing, or a reference the
    /// import needs is gone; [`ImportError::Failed`] for a failed hook or database write.
    pub async fn run(&self, state: &mut EngineState) -> Result<EngineOutcome, ImportError> {
        match self.drive(state).await {
            Ok(outcome) => Ok(outcome),
            Err(Stop::Released) => Ok(EngineOutcome::Released),
            Err(Stop::Error(error)) => Err(error),
        }
    }

    async fn drive(&self, state: &mut EngineState) -> Result<EngineOutcome, Stop> {
        if self.hooks.is_canceled().await? {
            return Ok(EngineOutcome::Canceled);
        }
        if state.plan.is_none() {
            state.phase = ImportPhase::Setup;
            let discovery = self.call(|| self.source.discover()).await?;
            self.hooks.on_discovery(&discovery).await?;
            state.plan = Some(self.sink.resolve_plan(&discovery, self.mapping).await?);
            state.progress.total = discovery.counts.issues;
            state.phase = ImportPhase::Issues;
            state.cursor = None;
            self.save(state).await?;
        }
        while state.phase == ImportPhase::Issues {
            if self.hooks.is_canceled().await? {
                return Ok(EngineOutcome::Canceled);
            }
            let cursor = state.cursor.clone();
            let page = self.call(|| self.source.issues(cursor.as_deref(), &self.options)).await?;
            self.issue_page(state, &page.items).await?;
            state.cursor.clone_from(&page.next);
            if page.next.is_none() {
                state.phase = if self.options.include_comments {
                    ImportPhase::Comments
                } else {
                    ImportPhase::Done
                };
                state.cursor = None;
            }
            self.save(state).await?;
        }
        while state.phase == ImportPhase::Comments {
            if self.hooks.is_canceled().await? {
                return Ok(EngineOutcome::Canceled);
            }
            let cursor = state.cursor.clone();
            let page = self.call(|| self.source.comments(cursor.as_deref())).await?;
            self.comment_page(state, &page.items).await?;
            state.cursor.clone_from(&page.next);
            if page.next.is_none() {
                state.phase = ImportPhase::Done;
                state.cursor = None;
            }
            self.save(state).await?;
        }
        Ok(EngineOutcome::Completed)
    }

    async fn save(&self, state: &mut EngineState) -> Result<(), ImportError> {
        state.progress.phase = state.phase;
        self.hooks.checkpoint(state).await
    }

    fn redact(&self, text: &str) -> String {
        let secrets: Vec<Option<&str>> = self.secrets.iter().map(|s| Some(s.as_str())).collect();
        redact_secrets(text, &secrets)
    }

    fn fail(&self, state: &mut EngineState, reference: &str, message: &str) {
        state.progress.failed += 1;
        if state.errors.len() < MAX_STORED_ERRORS {
            state.errors.push(ImportErrorEntry {
                reference: reference.to_owned(),
                message: js::truncate(&self.redact(message), MAX_ERROR_MESSAGE).to_owned(),
            });
        }
    }

    async fn issue_page(
        &self,
        state: &mut EngineState,
        items: &[ExternalIssue],
    ) -> Result<(), ImportError> {
        let plan = state.plan.clone().unwrap_or_default();
        let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        let existing = self.sink.existing_issues(self.provider, &ids).await?;
        for ext in items {
            state.progress.processed += 1;
            let outcome = async {
                if existing.contains_key(&ext.id) {
                    state.progress.skipped += 1;
                    let reference = external_ref_of(
                        self.provider,
                        ext,
                        ExternalRefOrigin::Import,
                        self.hooks.now(),
                    );
                    self.sink.refresh_ref(self.provider, &ext.id, &reference).await?;
                    return Ok(None);
                }
                let issue =
                    to_new_issue(self.provider, ext, &plan, &self.options, self.hooks.now());
                Ok::<_, ImportError>(Some(self.sink.create_issue(&issue).await?))
            }
            .await;
            match outcome {
                Ok(Some(CreateOutcome::Created)) => state.progress.created += 1,
                Ok(Some(CreateOutcome::Exists)) => state.progress.skipped += 1,
                Ok(None) => {}
                Err(error) => self.fail(state, &ext.key, error.message()),
            }
        }
        Ok(())
    }

    async fn comment_page(
        &self,
        state: &mut EngineState,
        items: &[ExternalComment],
    ) -> Result<(), ImportError> {
        if items.is_empty() {
            return Ok(());
        }
        let mut issue_ids: Vec<String> = Vec::new();
        for comment in items {
            if !issue_ids.contains(&comment.issue_id) {
                issue_ids.push(comment.issue_id.clone());
            }
        }
        let issues = self.sink.existing_issues(self.provider, &issue_ids).await?;
        let ids: Vec<String> = items.iter().map(|c| c.id.clone()).collect();
        let done = self.sink.existing_comments(self.provider, &ids).await?;
        for comment in items {
            // A comment on an issue that was not imported (a pull request, a closed issue left
            // out) has nowhere to go.
            let Some(issue_id) = issues.get(&comment.issue_id) else { continue };
            if done.contains(&comment.id) {
                continue;
            }
            let new = NewComment {
                external_id: comment.id.clone(),
                issue_id: issue_id.clone(),
                body: comment_body(self.provider, comment),
                created_at: parse_date(&comment.created_at).unwrap_or_else(|| self.hooks.now()),
            };
            match self.sink.create_comment(self.provider, &new).await {
                Ok(true) => state.progress.comments += 1,
                Ok(false) => {}
                Err(error) => self.fail(state, &format!("comment {}", comment.id), error.message()),
            }
        }
        Ok(())
    }

    /// Runs one provider call, waiting out rate limits and retrying transient failures.
    async fn call<T, F, Fut>(&self, mut call: F) -> Result<T, Stop>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, SourceError>>,
    {
        let mut waits = 0;
        let mut retries = 0;
        loop {
            let error = match call().await {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            if let Some(until) = error.rate_limited_until() {
                waits += 1;
                if waits > MAX_RATE_WAITS_IN_A_ROW {
                    return Err(
                        ImportError::fatal("Still rate limited after waiting repeatedly").into()
                    );
                }
                if self.hooks.wait(until).await? == WaitOutcome::Release {
                    return Err(Stop::Released);
                }
                continue;
            }
            if let SourceError::Provider(provider) = &error
                && provider.status < 500
                && provider.status != 408
            {
                return Err(ImportError::fatal(self.redact(&provider.message)).into());
            }
            retries += 1;
            if retries > TRANSIENT_RETRIES {
                return Err(ImportError::fatal(
                    self.redact(&format!("{error} (gave up after {TRANSIENT_RETRIES} retries)")),
                )
                .into());
            }
            self.hooks.sleep(1000 * 2_u64.pow(retries - 1)).await;
        }
    }
}

/// Imported comments are written by the person who ran the import; the original author and date
/// are in the text.
#[must_use]
pub fn comment_body(provider: ExternalProvider, comment: &ExternalComment) -> String {
    let author = comment.author.as_ref();
    let who = match author.and_then(|a| a.login.as_deref()).filter(|l| !l.is_empty()) {
        Some(login) => format!("@{login}"),
        None => author.and_then(|a| a.name.clone()).unwrap_or_else(|| "someone".to_owned()),
    };
    let day = if parse_date(&comment.created_at).is_some() {
        format!(" on {}", js::truncate(&comment.created_at, 10))
    } else {
        String::new()
    };
    let from = if provider == ExternalProvider::Github { "GitHub" } else { "Linear" };
    let body = format!("_Imported from {from}: {who} wrote{day}_\n\n{}", comment.body);
    js::truncate(&body, MAX_COMMENT_BODY).to_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use chrono::TimeZone;
    use trama_contracts::imports::DEFAULT_IMPORT_OPTIONS;
    use trama_integrations::ProviderHttpError;

    use super::*;
    use crate::types::{DiscoveryCounts, ExternalLabel, ExternalState, ExternalUser, Page};

    const TOKEN: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap()
    }

    fn issue(n: u32) -> ExternalIssue {
        ExternalIssue {
            id: format!("acme/api#{n}"),
            key: format!("#{n}"),
            url: format!("https://github.com/acme/api/issues/{n}"),
            title: format!("Issue {n}"),
            body: None,
            state: ExternalState { id: "open".into(), name: "Open".into(), kind: "open".into() },
            priority: None,
            estimate: None,
            labels: Vec::<ExternalLabel>::new(),
            assignee: None,
            creator: None,
            team_id: None,
            project_id: None,
            milestone: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            started_at: None,
            closed_at: None,
        }
    }

    fn discovery() -> Discovery {
        Discovery {
            provider: ExternalProvider::Github,
            account: "ada".into(),
            source_label: "acme/api".into(),
            source_url: None,
            counts: DiscoveryCounts { issues: Some(5), open: Some(5), closed: Some(0) },
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

    fn comment(
        id: &str,
        issue: &str,
        author: Option<ExternalUser>,
        body: &str,
        at: &str,
    ) -> ExternalComment {
        ExternalComment {
            id: id.into(),
            issue_id: issue.into(),
            author,
            body: body.into(),
            created_at: at.into(),
        }
    }

    /// Pages of 2 over a fixed list of issues, cursor = start offset. Can be told to fail at a
    /// given call.
    struct FakeSource {
        all: Vec<ExternalIssue>,
        all_comments: Vec<ExternalComment>,
        discover_calls: AtomicUsize,
        issue_calls: AtomicUsize,
        failures: Mutex<Vec<(usize, SourceError)>>,
    }

    impl FakeSource {
        fn new(all: Vec<ExternalIssue>, all_comments: Vec<ExternalComment>) -> Self {
            Self {
                all,
                all_comments,
                discover_calls: AtomicUsize::new(0),
                issue_calls: AtomicUsize::new(0),
                failures: Mutex::new(Vec::new()),
            }
        }

        fn fail_at(&self, calls: &[usize], error: &SourceError) {
            *self.failures.lock().unwrap() = calls.iter().map(|at| (*at, error.clone())).collect();
        }

        fn clear_failures(&self) {
            self.failures.lock().unwrap().clear();
        }
    }

    fn offset(cursor: Option<&str>) -> usize {
        cursor.map_or(0, |c| c.parse().unwrap())
    }

    #[async_trait]
    impl ImportSourceAdapter for FakeSource {
        fn provider(&self) -> ExternalProvider {
            ExternalProvider::Github
        }
        async fn discover(&self) -> Result<Discovery, SourceError> {
            self.discover_calls.fetch_add(1, Ordering::SeqCst);
            Ok(discovery())
        }
        async fn issues(
            &self,
            cursor: Option<&str>,
            _options: &ImportOptions,
        ) -> Result<Page<ExternalIssue>, SourceError> {
            let call = self.issue_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some((_, error)) =
                self.failures.lock().unwrap().iter().find(|(at, _)| *at == call)
            {
                return Err(error.clone());
            }
            let from = offset(cursor);
            let items = self.all.iter().skip(from).take(2).cloned().collect();
            let next = (from + 2 < self.all.len()).then(|| (from + 2).to_string());
            Ok(Page { items, next })
        }
        async fn comments(
            &self,
            cursor: Option<&str>,
        ) -> Result<Page<ExternalComment>, SourceError> {
            let from = offset(cursor);
            let items = self.all_comments.iter().skip(from).take(2).cloned().collect();
            let next = (from + 2 < self.all_comments.len()).then(|| (from + 2).to_string());
            Ok(Page { items, next })
        }
        async fn get_issue(&self, _id: &str) -> Result<ExternalIssue, SourceError> {
            Err(SourceError::Unexpected("not used".into()))
        }
    }

    /// In-memory store with the same guarantees as the SQL one: one row per (workspace,
    /// provider, external id).
    struct MemorySink {
        workspace_id: String,
        issues: Mutex<BTreeMap<String, (NewIssue, String)>>,
        comments: Mutex<BTreeMap<String, String>>,
        refreshed: Mutex<Vec<String>>,
        fail_on: Mutex<HashSet<String>>,
        hide_existing: AtomicBool,
    }

    impl MemorySink {
        fn new(workspace_id: &str) -> Self {
            Self {
                workspace_id: workspace_id.into(),
                issues: Mutex::default(),
                comments: Mutex::default(),
                refreshed: Mutex::default(),
                fail_on: Mutex::default(),
                hide_existing: AtomicBool::new(false),
            }
        }

        fn key(&self, provider: ExternalProvider, id: &str) -> String {
            format!("{}|{provider}|{id}", self.workspace_id)
        }

        fn put(&self, issue: &NewIssue) -> CreateOutcome {
            let key = self.key(issue.external_ref.provider, &issue.external_ref.id);
            let mut issues = self.issues.lock().unwrap();
            if issues.contains_key(&key) {
                return CreateOutcome::Exists;
            }
            let trama = format!("in_{}", issues.len() + 1);
            issues.insert(key, (issue.clone(), trama));
            CreateOutcome::Created
        }
    }

    #[async_trait]
    impl ImportSink for MemorySink {
        async fn resolve_plan(
            &self,
            _discovery: &Discovery,
            _mapping: &ImportMapping,
        ) -> Result<ResolvedPlan, ImportError> {
            Ok(ResolvedPlan::default())
        }
        async fn existing_issues(
            &self,
            provider: ExternalProvider,
            ids: &[String],
        ) -> Result<HashMap<String, String>, ImportError> {
            if self.hide_existing.load(Ordering::SeqCst) {
                return Ok(HashMap::new());
            }
            let issues = self.issues.lock().unwrap();
            Ok(ids
                .iter()
                .filter_map(|id| {
                    issues
                        .get(&self.key(provider, id))
                        .map(|(_, trama)| (id.clone(), trama.clone()))
                })
                .collect())
        }
        async fn create_issue(&self, issue: &NewIssue) -> Result<CreateOutcome, ImportError> {
            if self.fail_on.lock().unwrap().contains(&issue.external_ref.id) {
                return Err(ImportError::Failed(format!("insert failed with {TOKEN}")));
            }
            Ok(self.put(issue))
        }
        async fn refresh_ref(
            &self,
            provider: ExternalProvider,
            id: &str,
            _reference: &ExternalRef,
        ) -> Result<(), ImportError> {
            self.refreshed.lock().unwrap().push(self.key(provider, id));
            Ok(())
        }
        async fn existing_comments(
            &self,
            provider: ExternalProvider,
            ids: &[String],
        ) -> Result<HashSet<String>, ImportError> {
            let comments = self.comments.lock().unwrap();
            Ok(ids
                .iter()
                .filter(|id| comments.contains_key(&self.key(provider, id)))
                .cloned()
                .collect())
        }
        async fn create_comment(
            &self,
            provider: ExternalProvider,
            comment: &NewComment,
        ) -> Result<bool, ImportError> {
            let key = self.key(provider, &comment.external_id);
            let mut comments = self.comments.lock().unwrap();
            if comments.contains_key(&key) {
                return Ok(false);
            }
            comments.insert(key, comment.body.clone());
            Ok(true)
        }
    }

    #[derive(Default)]
    struct Harness {
        checkpoints: Mutex<Vec<EngineState>>,
        waited: Mutex<Vec<DateTime<Utc>>>,
        waits: Mutex<Vec<WaitOutcome>>,
        pages: AtomicUsize,
        cancel_after_pages: Option<usize>,
    }

    #[async_trait]
    impl EngineHooks for Harness {
        async fn checkpoint(&self, state: &EngineState) -> Result<(), ImportError> {
            self.pages.fetch_add(1, Ordering::SeqCst);
            self.checkpoints.lock().unwrap().push(state.clone());
            Ok(())
        }
        async fn is_canceled(&self) -> Result<bool, ImportError> {
            Ok(self.cancel_after_pages.is_some_and(|n| self.pages.load(Ordering::SeqCst) >= n))
        }
        async fn wait(&self, until: DateTime<Utc>) -> Result<WaitOutcome, ImportError> {
            self.waited.lock().unwrap().push(until);
            let mut waits = self.waits.lock().unwrap();
            Ok(if waits.is_empty() { WaitOutcome::Resume } else { waits.remove(0) })
        }
        async fn sleep(&self, _ms: u64) {}
        fn now(&self) -> DateTime<Utc> {
            now()
        }
    }

    impl Harness {
        fn engine<'a>(
            &'a self,
            source: &'a FakeSource,
            sink: &'a MemorySink,
            mapping: &'a ImportMapping,
            options: ImportOptions,
        ) -> ImportEngine<'a> {
            ImportEngine::new(
                ExternalProvider::Github,
                source,
                sink,
                mapping,
                options,
                self,
                vec![TOKEN.to_owned()],
            )
        }

        fn last(&self) -> EngineState {
            self.checkpoints.lock().unwrap().last().cloned().unwrap()
        }
    }

    fn with_comments() -> ImportOptions {
        ImportOptions { include_comments: true, ..DEFAULT_IMPORT_OPTIONS }
    }

    fn five() -> Vec<ExternalIssue> {
        (1..=5).map(issue).collect()
    }

    fn provider_error(status: u16, message: &str, until: Option<DateTime<Utc>>) -> SourceError {
        SourceError::Provider(ProviderHttpError {
            status,
            message: message.into(),
            rate_limited_until: until,
        })
    }

    #[tokio::test]
    async fn imports_every_page_checkpointing_after_each_one() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let source = FakeSource::new(five(), vec![]);
        let mut state = EngineState::new();
        let outcome =
            h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await;
        assert_eq!(outcome, Ok(EngineOutcome::Completed));
        assert_eq!(sink.issues.lock().unwrap().len(), 5);
        assert_eq!(state.progress.phase, ImportPhase::Done);
        assert_eq!(
            (
                state.progress.processed,
                state.progress.created,
                state.progress.skipped,
                state.progress.failed,
                state.progress.total
            ),
            (5, 5, 0, 0, Some(5))
        );
        // setup + 3 pages
        let seen: Vec<_> =
            h.checkpoints.lock().unwrap().iter().map(|c| (c.phase, c.cursor.clone())).collect();
        assert_eq!(
            seen,
            vec![
                (ImportPhase::Issues, None),
                (ImportPhase::Issues, Some("2".to_owned())),
                (ImportPhase::Issues, Some("4".to_owned())),
                (ImportPhase::Done, None),
            ]
        );
    }

    #[tokio::test]
    async fn a_second_run_creates_nothing_and_only_refreshes_the_mirrored_status() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let source = FakeSource::new((1..=3).map(issue).collect(), vec![]);
        h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await
            .unwrap();
        let mut second = EngineState::new();
        h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut second).await.unwrap();
        assert_eq!(sink.issues.lock().unwrap().len(), 3);
        assert_eq!(
            (second.progress.created, second.progress.skipped, second.progress.processed),
            (0, 3, 3)
        );
        assert_eq!(sink.refreshed.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_row_another_run_created_in_between_counts_as_already_imported() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let source = FakeSource::new(vec![issue(1)], vec![]);
        // the page check says "new", but the insert finds the unique index taken
        sink.hide_existing.store(true, Ordering::SeqCst);
        let theirs = to_new_issue(
            ExternalProvider::Github,
            &issue(1),
            &ResolvedPlan::default(),
            &DEFAULT_IMPORT_OPTIONS,
            now(),
        );
        assert_eq!(sink.create_issue(&theirs).await, Ok(CreateOutcome::Created));
        let mut state = EngineState::new();
        h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await.unwrap();
        assert_eq!(sink.issues.lock().unwrap().len(), 1);
        assert_eq!((state.progress.created, state.progress.skipped), (0, 1));
    }

    #[tokio::test]
    async fn resumes_from_the_stored_cursor_and_plan_without_describing_the_source_again() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let source = FakeSource::new(five(), vec![]);
        // transient failures are retried; make the third call fail for good by exhausting them
        source.fail_at(&[3, 4, 5, 6], &SourceError::Unexpected("process died".into()));
        let mut state = EngineState::new();
        let error = h
            .engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut state)
            .await
            .unwrap_err();
        assert!(error.is_fatal());
        assert_eq!(sink.issues.lock().unwrap().len(), 4);
        let saved = h.last();
        assert_eq!((saved.phase, saved.cursor.as_deref()), (ImportPhase::Issues, Some("4")));

        // what the runner stores and reads back
        let mut resumed = EngineState::resume(
            Some(&saved.cursor_json()),
            &serde_json::to_value(&saved.progress).unwrap(),
            &serde_json::to_value(&saved.errors).unwrap(),
        );
        source.clear_failures();
        let before = source.discover_calls.load(Ordering::SeqCst);
        let outcome =
            h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut resumed).await;
        assert_eq!(outcome, Ok(EngineOutcome::Completed));
        // the plan was saved: no second discovery
        assert_eq!(source.discover_calls.load(Ordering::SeqCst), before);
        assert_eq!(sink.issues.lock().unwrap().len(), 5);
        assert_eq!(resumed.progress.created, 5);
    }

    #[tokio::test]
    async fn stops_at_the_next_page_when_canceled_and_keeps_what_was_imported() {
        let h = Harness { cancel_after_pages: Some(2), ..Harness::default() };
        let (sink, mapping) = (MemorySink::new("ws_1"), ImportMapping::default());
        let source = FakeSource::new(five(), vec![]);
        let mut state = EngineState::new();
        let outcome =
            h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await;
        assert_eq!(outcome, Ok(EngineOutcome::Canceled));
        assert_eq!(sink.issues.lock().unwrap().len(), 2);
        assert_eq!(state.phase, ImportPhase::Issues);
    }

    #[tokio::test]
    async fn waits_out_a_rate_limit_and_retries_the_same_page() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let source = FakeSource::new(vec![issue(1), issue(2)], vec![]);
        let until = Utc::now() + chrono::Duration::seconds(60);
        source.fail_at(&[1], &provider_error(403, "Rate limited", Some(until)));
        let sink = MemorySink::new("ws_1");
        let outcome = h
            .engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await;
        assert_eq!(outcome, Ok(EngineOutcome::Completed));
        assert_eq!(*h.waited.lock().unwrap(), vec![until]);
        assert_eq!(source.issue_calls.load(Ordering::SeqCst), 2);
        assert_eq!(sink.issues.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn hands_the_job_back_when_the_rate_limit_window_is_too_long_to_wait_for() {
        let h = Harness { waits: Mutex::new(vec![WaitOutcome::Release]), ..Harness::default() };
        let mapping = ImportMapping::default();
        let source = FakeSource::new(vec![issue(1)], vec![]);
        source.fail_at(
            &[1],
            &provider_error(429, "Rate limited", Some(Utc::now() + chrono::Duration::hours(1))),
        );
        let outcome = h
            .engine(&source, &MemorySink::new("ws_1"), &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await;
        assert_eq!(outcome, Ok(EngineOutcome::Released));
        // the plan was saved before the page was requested, so the resume continues at the issues
        let saved = h.last();
        assert_eq!((saved.phase, saved.cursor), (ImportPhase::Issues, None));
    }

    #[tokio::test]
    async fn gives_up_when_still_rate_limited_after_waiting_repeatedly() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let source = FakeSource::new(vec![issue(1)], vec![]);
        let until = Utc::now() + chrono::Duration::seconds(1);
        let calls: Vec<usize> = (1..=40).collect();
        source.fail_at(&calls, &provider_error(429, "Rate limited", Some(until)));
        let error = h
            .engine(&source, &MemorySink::new("ws_1"), &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await
            .unwrap_err();
        assert_eq!(error, ImportError::fatal("Still rate limited after waiting repeatedly"));
        assert_eq!(h.waited.lock().unwrap().len(), 30);
    }

    #[tokio::test]
    async fn fails_the_job_on_a_rejected_credential_without_retrying() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let source = FakeSource::new(vec![issue(1)], vec![]);
        source.fail_at(&[1], &provider_error(401, &format!("Bad credentials for {TOKEN}"), None));
        let error = h
            .engine(&source, &MemorySink::new("ws_1"), &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await
            .unwrap_err();
        assert!(error.is_fatal());
        assert!(!error.message().contains(TOKEN));
        assert_eq!(source.issue_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_a_server_error_with_a_growing_pause_then_gives_up() {
        struct Sleeps(Mutex<Vec<u64>>);
        #[async_trait]
        impl EngineHooks for Sleeps {
            async fn checkpoint(&self, _: &EngineState) -> Result<(), ImportError> {
                Ok(())
            }
            async fn is_canceled(&self) -> Result<bool, ImportError> {
                Ok(false)
            }
            async fn wait(&self, _: DateTime<Utc>) -> Result<WaitOutcome, ImportError> {
                Ok(WaitOutcome::Resume)
            }
            async fn sleep(&self, ms: u64) {
                self.0.lock().unwrap().push(ms);
            }
            fn now(&self) -> DateTime<Utc> {
                now()
            }
        }
        let hooks = Sleeps(Mutex::new(Vec::new()));
        let mapping = ImportMapping::default();
        let source = FakeSource::new(vec![issue(1)], vec![]);
        source.fail_at(&[1, 2, 3, 4], &provider_error(502, "Bad gateway", None));
        let sink = MemorySink::new("ws_1");
        let engine = ImportEngine::new(
            ExternalProvider::Github,
            &source,
            &sink,
            &mapping,
            DEFAULT_IMPORT_OPTIONS,
            &hooks,
            vec![],
        );
        let error = engine.run(&mut EngineState::new()).await.unwrap_err();
        assert_eq!(error, ImportError::fatal("Bad gateway (gave up after 3 retries)"));
        assert_eq!(*hooks.0.lock().unwrap(), vec![1000, 2000, 4000]);
        // a 408 is transient too: it recovers on the next call
        source.fail_at(&[5], &provider_error(408, "Request timeout", None));
        let outcome = engine.run(&mut EngineState::new()).await;
        assert_eq!(outcome, Ok(EngineOutcome::Completed));
    }

    #[tokio::test]
    async fn records_a_failing_issue_redacts_the_token_and_carries_on() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        sink.fail_on.lock().unwrap().insert("acme/api#2".into());
        let source = FakeSource::new(vec![issue(1), issue(2), issue(3)], vec![]);
        let mut state = EngineState::new();
        h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await.unwrap();
        assert_eq!(sink.issues.lock().unwrap().len(), 2);
        assert_eq!((state.progress.created, state.progress.failed), (2, 1));
        assert_eq!(state.errors.len(), 1);
        assert_eq!(state.errors[0].reference, "#2");
        assert!(!serde_json::to_string(&state.errors).unwrap().contains(TOKEN));
        assert!(state.errors[0].message.contains("[redacted]"));
    }

    #[tokio::test]
    async fn caps_the_stored_error_list_but_still_counts_every_failure() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let many: Vec<ExternalIssue> = (1..=130).map(issue).collect();
        for i in &many {
            sink.fail_on.lock().unwrap().insert(i.id.clone());
        }
        let source = FakeSource::new(many, vec![]);
        let mut state = EngineState::new();
        h.engine(&source, &sink, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await.unwrap();
        assert_eq!(state.progress.failed, 130);
        assert_eq!(state.errors.len(), 100);
    }

    #[tokio::test]
    async fn truncates_a_stored_error_message_to_300_characters() {
        struct Long;
        #[async_trait]
        impl ImportSink for Long {
            async fn resolve_plan(
                &self,
                _: &Discovery,
                _: &ImportMapping,
            ) -> Result<ResolvedPlan, ImportError> {
                Ok(ResolvedPlan::default())
            }
            async fn existing_issues(
                &self,
                _: ExternalProvider,
                _: &[String],
            ) -> Result<HashMap<String, String>, ImportError> {
                Ok(HashMap::new())
            }
            async fn create_issue(&self, _: &NewIssue) -> Result<CreateOutcome, ImportError> {
                Err(ImportError::Failed("x".repeat(1000)))
            }
            async fn refresh_ref(
                &self,
                _: ExternalProvider,
                _: &str,
                _: &ExternalRef,
            ) -> Result<(), ImportError> {
                Ok(())
            }
            async fn existing_comments(
                &self,
                _: ExternalProvider,
                _: &[String],
            ) -> Result<HashSet<String>, ImportError> {
                Ok(HashSet::new())
            }
            async fn create_comment(
                &self,
                _: ExternalProvider,
                _: &NewComment,
            ) -> Result<bool, ImportError> {
                Ok(false)
            }
        }
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let source = FakeSource::new(vec![issue(1)], vec![]);
        let engine = ImportEngine::new(
            ExternalProvider::Github,
            &source,
            &Long,
            &mapping,
            DEFAULT_IMPORT_OPTIONS,
            &h,
            vec![],
        );
        let mut state = EngineState::new();
        engine.run(&mut state).await.unwrap();
        assert_eq!(state.errors[0].message.len(), 300);
    }

    #[tokio::test]
    async fn imports_comments_once_only_for_imported_issues_written_by_the_importer() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let sink = MemorySink::new("ws_1");
        let comments = vec![
            comment(
                "c1",
                "acme/api#1",
                Some(ExternalUser {
                    id: "ada".into(),
                    login: Some("ada".into()),
                    ..ExternalUser::default()
                }),
                "first",
                "2026-01-02T00:00:00Z",
            ),
            comment("c2", "acme/api#99", None, "on a pull request", "2026-01-02T00:00:00Z"),
            comment(
                "c3",
                "acme/api#2",
                Some(ExternalUser {
                    id: "x".into(),
                    name: Some("Xavier".into()),
                    ..ExternalUser::default()
                }),
                "third",
                "2026-01-03T00:00:00Z",
            ),
        ];
        let source = FakeSource::new(vec![issue(1), issue(2)], comments.clone());
        let mut first = EngineState::new();
        h.engine(&source, &sink, &mapping, with_comments()).run(&mut first).await.unwrap();
        assert_eq!(first.progress.comments, 2);
        let stored: Vec<String> = sink.comments.lock().unwrap().values().cloned().collect();
        assert_eq!(
            stored,
            vec![
                comment_body(ExternalProvider::Github, &comments[0]),
                comment_body(ExternalProvider::Github, &comments[2])
            ]
        );

        let mut second = EngineState::new();
        h.engine(&source, &sink, &mapping, with_comments()).run(&mut second).await.unwrap();
        assert_eq!(second.progress.comments, 0);
        assert_eq!(sink.comments.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn keeps_two_workspaces_apart() {
        let (h, mapping) = (Harness::default(), ImportMapping::default());
        let (a, b) = (MemorySink::new("ws_a"), MemorySink::new("ws_b"));
        let source = FakeSource::new(vec![issue(1)], vec![]);
        h.engine(&source, &a, &mapping, DEFAULT_IMPORT_OPTIONS)
            .run(&mut EngineState::new())
            .await
            .unwrap();
        let mut state = EngineState::new();
        h.engine(&source, &b, &mapping, DEFAULT_IMPORT_OPTIONS).run(&mut state).await.unwrap();
        assert_eq!(a.issues.lock().unwrap().len(), 1);
        assert_eq!(b.issues.lock().unwrap().len(), 1);
        assert_eq!(state.progress.created, 1);
    }

    #[test]
    fn comment_body_names_the_original_author_and_day_and_says_where_it_came_from() {
        let by = |login: Option<&str>, name: Option<&str>| {
            Some(ExternalUser {
                id: "a".into(),
                login: login.map(str::to_owned),
                name: name.map(str::to_owned),
                email: None,
            })
        };
        assert_eq!(
            comment_body(
                ExternalProvider::Github,
                &comment("c", "i", by(Some("ada"), None), "hi", "2026-05-06T10:00:00Z")
            ),
            "_Imported from GitHub: @ada wrote on 2026-05-06_\n\nhi"
        );
        assert_eq!(
            comment_body(
                ExternalProvider::Linear,
                &comment("c", "i", by(None, Some("Ada L")), "hi", "nope")
            ),
            "_Imported from Linear: Ada L wrote_\n\nhi"
        );
        assert_eq!(
            comment_body(ExternalProvider::Linear, &comment("c", "i", None, "hi", "nope")),
            "_Imported from Linear: someone wrote_\n\nhi"
        );
        let long = comment_body(
            ExternalProvider::Github,
            &comment("c", "i", None, &"x".repeat(30_000), "nope"),
        );
        assert_eq!(long.len(), 20_000);
    }

    #[test]
    fn the_cursor_column_is_phase_cursor_plan_as_nestjs_stores_it() {
        let mut state = EngineState::new();
        assert_eq!(state.cursor_json(), json!({ "phase": "setup", "cursor": null }));
        state.phase = ImportPhase::Comments;
        state.cursor = Some("7".into());
        state.plan = Some(ResolvedPlan {
            projects: BTreeMap::from([("p".to_owned(), Some("pj_1".to_owned()))]),
            ..ResolvedPlan::default()
        });
        let stored = state.cursor_json();
        assert_eq!(stored["phase"], "comments");
        assert_eq!(stored["cursor"], "7");
        assert_eq!(stored["plan"]["projects"], json!({ "p": "pj_1" }));
        let back = EngineState::resume(Some(&stored), &json!({ "processed": 3 }), &json!([]));
        assert_eq!((back.phase, back.cursor.as_deref()), (ImportPhase::Comments, Some("7")));
        assert_eq!(back.plan, state.plan);
        assert_eq!(back.progress.processed, 3);
        assert_eq!(back.progress.phase, ImportPhase::Setup);
    }
}
