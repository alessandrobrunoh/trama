//! Runs import jobs in the background of the API process (`importers/import-runner.service.ts`).
//!
//! Jobs are rows: a restart (or a second instance) picks queued and stale ones up and continues
//! from the stored cursor. Nothing here logs a token.
//!
//! [`with_services`] registers the runner on the `AppState` (so the routes and the sweep share
//! it) and [`spawn`] starts the sweep; `TRAMA_IMPORT_RUNNER=off` disables the sweep, jobs
//! started or retried through the API still run.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QuerySelect,
    Set, Statement,
};
use serde_json::{Map, Value};
use tokio::task::JoinHandle;
use trama_common::request_context;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::imports::{
    ExternalProvider, ImportMapping, ImportOptions, ImportSource, ImportStatus,
};
use trama_contracts::js;
use trama_core::AppState;
use trama_entities::import_jobs;
use trama_events::{Events, RecordEvent};
use trama_integrations::Http;

use crate::adapter::create_adapter;
use crate::credentials;
use crate::engine::{
    EngineHooks, EngineOutcome, EngineState, ImportEngine, ImportError, MAX_STORED_ERRORS,
    WaitOutcome,
};
use crate::mapping::redact_secrets;
use crate::sink::PgImportSink;
use crate::types::Discovery;
use crate::types::ImportSourceAdapter;

/// A runner that has not touched its job for this long is considered gone; another one takes the
/// job over.
const STALE_AFTER_SECONDS: f64 = 90.0;
const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// Waits up to this long inside the process; longer rate-limit windows hand the job back to the
/// queue.
const MAX_INLINE_WAIT_MS: i64 = 10 * 60_000;
const WAIT_SLICE: Duration = Duration::from_secs(5);
const MIN_WAIT_SLICE: Duration = Duration::from_millis(250);
/// Jobs running at once in this process, across workspaces.
pub const MAX_CONCURRENT_IMPORTS: usize = 4;
/// Longest stored label of the source.
const SOURCE_LABEL_MAX: usize = 200;
/// Longest stored failure message.
const LAST_ERROR_MAX: usize = 500;

#[derive(Default)]
struct Slots {
    /// Claim in flight.
    pending: HashSet<String>,
    /// Claimed and running here.
    active: HashSet<String>,
}

#[derive(Default)]
struct Shared {
    slots: Mutex<Slots>,
    stopping: AtomicBool,
}

/// The background runner of this process. Cheap to clone; every clone shares the same state.
#[derive(Clone, Default)]
pub struct ImportRunner(Arc<Shared>);

/// Shared by every [`ImportRunner::of`] on a state without a registered runner.
static PROCESS_LOCAL: LazyLock<ImportRunner> = LazyLock::new(ImportRunner::default);

/// Registers the runner on `state` so [`ImportRunner::of`] (the routes) and [`spawn`] (the
/// sweep) share it.
#[must_use]
pub fn with_services(state: AppState) -> AppState {
    state.with_extension(ImportRunner::default())
}

/// Starts the sweep that resumes queued and abandoned jobs: right away, then every 30 seconds.
/// Disabled by `TRAMA_IMPORT_RUNNER=off` (the returned task then ends at once). Abort the handle
/// to stop it, and call [`stop`] so running jobs hand themselves back.
///
/// Must be called inside a Tokio runtime.
#[must_use]
pub fn spawn(state: &AppState) -> JoinHandle<()> {
    if !state.config.import_runner_enabled {
        return tokio::spawn(async {});
    }
    let runner = ImportRunner::of(state);
    let state = state.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(SWEEP_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            runner.sweep(&state).await;
        }
    })
}

/// `onModuleDestroy`: no new job starts, and a job waiting out a rate limit hands itself back.
pub fn stop(state: &AppState) {
    ImportRunner::of(state).0.stopping.store(true, Ordering::SeqCst);
}

/// Builds the adapter that reads a source. Production states have none registered and use
/// [`create_adapter`]; a test registers one with `AppState::with_extension` to read a fake
/// tracker instead of calling GitHub or Linear.
#[derive(Clone)]
pub struct SourceFactory(Arc<MakeSource>);

type MakeSource =
    dyn Fn(ExternalProvider, &ImportSource) -> Arc<dyn ImportSourceAdapter> + Send + Sync;

impl SourceFactory {
    /// A factory that answers every source with `make`'s adapter.
    pub fn new(
        make: impl Fn(ExternalProvider, &ImportSource) -> Arc<dyn ImportSourceAdapter>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self(Arc::new(make))
    }
}

/// The adapter that reads `source` with `cred`: the registered [`SourceFactory`]'s, else the
/// provider's.
///
/// # Errors
///
/// 400 when the source or credential does not fit the provider.
pub fn source_for(
    state: &AppState,
    provider: ExternalProvider,
    cred: &credentials::ResolvedCredential,
    source: &ImportSource,
) -> Result<Arc<dyn ImportSourceAdapter>, trama_core::AppError> {
    if let Some(factory) = state.extension::<SourceFactory>() {
        return Ok((factory.0)(provider, source));
    }
    create_adapter(Http::of(state), provider, cred, source).map(Arc::from)
}

/// The rows of an `UPDATE ... RETURNING`.
async fn claim(db: &DatabaseConnection, id: &str) -> Result<bool, DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            db.get_database_backend(),
            r#"UPDATE "import_jobs" SET "status" = 'running', "heartbeatAt" = now(), "startedAt" = COALESCE("startedAt", now())
               WHERE "id" = $1 AND (
                 ("status" = 'queued' AND ("waitingUntil" IS NULL OR "waitingUntil" <= now()))
                 OR ("status" = 'running' AND ("heartbeatAt" IS NULL OR "heartbeatAt" < now() - make_interval(secs => $2)))
               ) RETURNING "id""#,
            [id.into(), STALE_AFTER_SECONDS.into()],
        ))
        .await?;
    Ok(!rows.is_empty())
}

async fn update_job(
    db: &DatabaseConnection,
    id: &str,
    set: import_jobs::ActiveModel,
) -> Result<(), DbErr> {
    import_jobs::Entity::update_many()
        .set(set)
        .filter(import_jobs::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

impl ImportRunner {
    /// The runner registered on `state`, else one shared process-local runner.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state.extension::<Self>().cloned().unwrap_or_else(|| PROCESS_LOCAL.clone())
    }

    fn slots(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.0.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn is_stopping(&self) -> bool {
        self.0.stopping.load(Ordering::SeqCst)
    }

    /// Takes a worker slot for `id`, or `false` when it is already here, the runner is stopping
    /// or [`MAX_CONCURRENT_IMPORTS`] jobs are in flight.
    fn reserve(&self, id: &str) -> bool {
        let mut slots = self.slots();
        if self.is_stopping()
            || slots.active.contains(id)
            || slots.pending.contains(id)
            || slots.active.len() + slots.pending.len() >= MAX_CONCURRENT_IMPORTS
        {
            return false;
        }
        slots.pending.insert(id.to_owned());
        true
    }

    fn activate(&self, id: &str) {
        let mut slots = self.slots();
        slots.pending.remove(id);
        slots.active.insert(id.to_owned());
    }

    fn release(&self, id: &str) {
        let mut slots = self.slots();
        slots.pending.remove(id);
        slots.active.remove(id);
    }

    /// Whether the pool has no room for another job.
    fn full(&self) -> bool {
        let slots = self.slots();
        slots.active.len() + slots.pending.len() >= MAX_CONCURRENT_IMPORTS
    }

    /// Fills the bounded worker pool with queued or abandoned jobs.
    ///
    /// NestJS reserves the slot before calling `kick`, which then refuses a job it finds reserved,
    /// so its sweep never starts anything; here the sweep goes through `kick` as intended.
    pub async fn sweep(&self, state: &AppState) {
        if self.is_stopping() {
            return;
        }
        let ids: Vec<String> = import_jobs::Entity::find()
            .select_only()
            .column(import_jobs::Column::Id)
            .filter(import_jobs::Column::Status.is_in(["queued", "running"]))
            .into_tuple()
            .all(&state.db)
            .await
            .unwrap_or_default();
        for id in ids {
            if self.full() {
                break;
            }
            self.kick(state, &id).await;
        }
    }

    /// Claims the job (atomically, so two instances never run it) and runs it in the background.
    /// `false` when it was not claimed: already running here, too many jobs in flight, parked
    /// until later, or another instance has it.
    pub async fn kick(&self, state: &AppState, id: &str) -> bool {
        self.kick_with(state, id, |runner, state, id| async move {
            if let Err(error) = execute(&runner, &state, &id).await {
                tracing::error!("Import {id} crashed: {}", redact_secrets(error.message(), &[]));
            }
        })
        .await
    }

    async fn kick_with<F, Fut>(&self, state: &AppState, id: &str, run: F) -> bool
    where
        F: FnOnce(Self, AppState, String) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        if !self.reserve(id) {
            return false;
        }
        match claim(&state.db, id).await {
            Ok(true) => {}
            Ok(false) => {
                self.release(id);
                return false;
            }
            Err(error) => {
                tracing::warn!("Import {id} could not be claimed: {error}");
                self.release(id);
                return false;
            }
        }
        self.activate(id);
        let (runner, state, id) = (self.clone(), state.clone(), id.to_owned());
        // the request's `X-Client-Id` rides along, as it does through NestJS's async context
        let client_id = trama_common::client_id();
        tokio::spawn(request_context::scope(client_id, async move {
            run(runner.clone(), state, id.clone()).await;
            runner.release(&id);
        }));
        true
    }
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value, what: &str) -> Result<T, ImportError> {
    serde_json::from_value(value.clone())
        .map_err(|e| ImportError::Failed(format!("The job's {what} is unreadable: {e}")))
}

/// Writes the job's status, finish time and error, then records `import.<status>`.
async fn finish(
    state: &AppState,
    id: &str,
    status: ImportStatus,
    last_error: Option<&str>,
) -> Result<(), ImportError> {
    let mut set = import_jobs::ActiveModel {
        status: Set(status.as_str().to_owned()),
        finished_at: Set(Some(Utc::now().fixed_offset())),
        waiting_until: Set(None),
        last_error: Set(last_error.map(str::to_owned)),
        ..Default::default()
    };
    if status == ImportStatus::Completed {
        set.cursor = Set(None);
    }
    update_job(&state.db, id, set).await?;
    // what the checkpoints stored: the progress and label of the run
    let Some(job) = import_jobs::Entity::find_by_id(id).one(&state.db).await? else {
        return Ok(());
    };
    let mut data = Map::new();
    data.insert("provider".into(), job.provider.clone().into());
    data.insert("source".into(), job.source_label.clone().into());
    if let Some(progress) = job.progress.as_object() {
        for (key, value) in progress {
            data.insert(key.clone(), value.clone());
        }
    }
    if let Some(error) = last_error {
        data.insert("error".into(), error.into());
    }
    let actor: ActorRef = parse(&job.created_by, "creator")?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(
                job.workspace_id.clone(),
                actor,
                format!("import.{status}"),
                SubjectRef { kind: SubjectType::Import, id: job.id.clone() },
            )
            .data(Value::Object(data)),
        )
        .await?;
    Ok(())
}

/// What the engine asks of the job row.
struct JobHooks {
    state: AppState,
    id: String,
    runner: ImportRunner,
}

#[async_trait]
impl EngineHooks for JobHooks {
    async fn checkpoint(&self, state: &EngineState) -> Result<(), ImportError> {
        let errors: Vec<_> = state.errors.iter().take(MAX_STORED_ERRORS).collect();
        update_job(
            &self.state.db,
            &self.id,
            import_jobs::ActiveModel {
                progress: Set(serde_json::to_value(&state.progress)
                    .map_err(|e| ImportError::Failed(e.to_string()))?),
                errors: Set(
                    serde_json::to_value(errors).map_err(|e| ImportError::Failed(e.to_string()))?
                ),
                cursor: Set(Some(state.cursor_json())),
                heartbeat_at: Set(Some(Utc::now().fixed_offset())),
                waiting_until: Set(None),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    async fn on_discovery(&self, discovery: &Discovery) -> Result<(), ImportError> {
        update_job(
            &self.state.db,
            &self.id,
            import_jobs::ActiveModel {
                source_label: Set(
                    js::truncate(&discovery.source_label, SOURCE_LABEL_MAX).to_owned()
                ),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    async fn is_canceled(&self) -> Result<bool, ImportError> {
        let requested: Option<bool> = import_jobs::Entity::find_by_id(self.id.as_str())
            .select_only()
            .column(import_jobs::Column::CancelRequested)
            .into_tuple()
            .one(&self.state.db)
            .await?;
        Ok(requested.unwrap_or(false))
    }

    async fn wait(&self, until: DateTime<Utc>) -> Result<WaitOutcome, ImportError> {
        let db = &self.state.db;
        if (until - Utc::now()).num_milliseconds() > MAX_INLINE_WAIT_MS {
            // Too long to hold on to: park the job; the sweep resumes it once the window has
            // passed.
            update_job(
                db,
                &self.id,
                import_jobs::ActiveModel {
                    status: Set(ImportStatus::Queued.as_str().to_owned()),
                    waiting_until: Set(Some(until.fixed_offset())),
                    heartbeat_at: Set(None),
                    ..Default::default()
                },
            )
            .await?;
            return Ok(WaitOutcome::Release);
        }
        update_job(
            db,
            &self.id,
            import_jobs::ActiveModel {
                waiting_until: Set(Some(until.fixed_offset())),
                ..Default::default()
            },
        )
        .await?;
        while Utc::now() < until {
            if self.runner.is_stopping() {
                return Ok(WaitOutcome::Release);
            }
            if self.is_canceled().await? {
                return Ok(WaitOutcome::Resume);
            }
            let left = (until - Utc::now()).to_std().unwrap_or_default();
            tokio::time::sleep(WAIT_SLICE.min(left.max(MIN_WAIT_SLICE))).await;
            update_job(
                db,
                &self.id,
                import_jobs::ActiveModel {
                    heartbeat_at: Set(Some(Utc::now().fixed_offset())),
                    ..Default::default()
                },
            )
            .await?;
        }
        update_job(
            db,
            &self.id,
            import_jobs::ActiveModel { waiting_until: Set(None), ..Default::default() },
        )
        .await?;
        Ok(WaitOutcome::Resume)
    }

    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Reads the job, runs the engine over it and ends it as completed, canceled or (through
/// [`execute`]) failed. A released job is already queued again with its `waitingUntil`.
async fn drive(
    runner: &ImportRunner,
    state: &AppState,
    job: &import_jobs::Model,
    token: &mut Option<String>,
) -> Result<(), ImportError> {
    let provider = ExternalProvider::parse(&job.provider)
        .ok_or_else(|| ImportError::Failed(format!("Unknown provider \"{}\"", job.provider)))?;
    let text = |key: &str| {
        job.credential.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
    };
    let cred = credentials::resolve(
        state,
        &job.workspace_id,
        provider,
        text("credentialId").as_deref(),
        text("connectionId").as_deref(),
    )
    .await?;
    token.clone_from(&cred.token);
    let source: ImportSource = parse(&job.source, "source")?;
    let adapter = source_for(state, provider, &cred, &source)?;
    let sink = PgImportSink::new(
        state,
        &job.workspace_id,
        parse::<ActorRef>(&job.created_by, "creator")?,
        &job.id,
        provider,
        cred.base_url.clone(),
    );
    let mapping: ImportMapping = parse(&job.mapping, "mapping")?;
    let options: ImportOptions = parse(&job.options, "options")?;
    let mut engine_state = EngineState::resume(job.cursor.as_ref(), &job.progress, &job.errors);
    let hooks = JobHooks { state: state.clone(), id: job.id.clone(), runner: runner.clone() };
    let engine = ImportEngine::new(
        provider,
        &*adapter,
        &sink,
        &mapping,
        options,
        &hooks,
        vec![token.clone().unwrap_or_default()],
    );
    match engine.run(&mut engine_state).await? {
        EngineOutcome::Completed => finish(state, &job.id, ImportStatus::Completed, None).await,
        EngineOutcome::Canceled => finish(state, &job.id, ImportStatus::Canceled, None).await,
        EngineOutcome::Released => Ok(()),
    }
}

/// Runs a claimed job to its end. Failures are stored on the job (`failed`, with the message
/// scrubbed of the token); only a failure to store them is returned.
async fn execute(runner: &ImportRunner, state: &AppState, id: &str) -> Result<(), ImportError> {
    let Some(job) = import_jobs::Entity::find_by_id(id).one(&state.db).await? else {
        return Ok(());
    };
    let mut token: Option<String> = None;
    if let Err(error) = drive(runner, state, &job, &mut token).await {
        let message = redact_secrets(error.message(), &[token.as_deref()]);
        let message = js::truncate(&message, LAST_ERROR_MAX);
        if !error.is_fatal() {
            tracing::warn!("Import {} failed: {message}", job.id);
        }
        finish(state, &job.id, ImportStatus::Failed, Some(message)).await?;
    }
    Ok(())
}
