//! Preview and import jobs (`importers/imports.service.ts`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use chrono::Utc;
use regex::Regex;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde_json::{Map, Value, json};
use trama_common::refs;
use trama_common::util::{is_unique_violation, unique};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::imports::{
    DEFAULT_IMPORT_OPTIONS, ExternalProvider, IMPORT_ACTIVE_STATUSES, ImportMapping, ImportPreview,
    ImportSource, ImportTarget,
};
use trama_contracts::js;
use trama_contracts::labels::{StoredLabelScope, resolve_label_catalog};
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{import_jobs, memberships, projects, users, workspaces};
use trama_events::{Events, RecordEvent};
use trama_external_identities::ResolveOptions;

use crate::adapter::provider_failure;
use crate::credentials;
use crate::engine::empty_progress;
use crate::mapping::{
    Member, Named, PreviewContext, Route, build_preview, mapping_from_preview, parse_mapping,
    parse_options,
};
use crate::runner::{ImportRunner, source_for};

/// Longest stored label of the source.
const SOURCE_LABEL_MAX: usize = 200;
/// Most jobs a listing returns.
const LIST_MAX: u64 = 50;
const ANOTHER_RUNNING: &str = "Another import is still running in this workspace";

static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$").expect("a valid pattern")
});
static TEAM_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,100}$").expect("a valid pattern"));
static URL_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://[^/]+/").expect("a valid pattern"));

/// A validated preview or import request (`ImportRequest`).
#[derive(Clone, Debug, PartialEq)]
pub struct ImportRequest {
    /// Tracker.
    pub provider: ExternalProvider,
    /// A saved tracker credential.
    pub credential_id: Option<String>,
    /// A GitHub connection of the workspace.
    pub connection_id: Option<String>,
    /// What to read.
    pub source: Option<ImportSource>,
    /// The editable mapping; absent = the preview's suggestions.
    pub mapping: Option<Value>,
    /// Options over [`DEFAULT_IMPORT_OPTIONS`].
    pub options: Option<Value>,
}

impl ImportRequest {
    fn credential(&self) -> (Option<&str>, Option<&str>) {
        (
            self.credential_id.as_deref().filter(|s| !s.is_empty()),
            self.connection_id.as_deref().filter(|s| !s.is_empty()),
        )
    }
}

const BAD_REPOSITORY: &str = "source.repository must look like owner/name";

/// `owner/name` from an `owner/name` string or a GitHub URL; anything else is a 400.
///
/// # Errors
///
/// 400 `source.repository must look like owner/name`.
pub fn parse_repository(raw: Option<&str>) -> Result<String, AppError> {
    let input = js::trim(raw.unwrap_or_default());
    let is_url = URL_PREFIX.is_match(input);
    let stripped = URL_PREFIX.replace(input, "");
    let parts: Vec<&str> = stripped.trim_end_matches('/').split('/').collect();
    // A URL may carry more path (/issues/4); a plain value must be exactly owner/name.
    if !is_url && parts.len() != 2 {
        return Err(AppError::bad_request(BAD_REPOSITORY));
    }
    let head = &parts[..parts.len().min(2)];
    let joined = head.join("/");
    let repository = match joined.len().checked_sub(4) {
        Some(at) if joined.is_char_boundary(at) && joined[at..].eq_ignore_ascii_case(".git") => {
            joined[..at].to_owned()
        }
        _ => joined,
    };
    if !REPOSITORY.is_match(&repository) || head.iter().any(|p| *p == "." || *p == "..") {
        return Err(AppError::bad_request(BAD_REPOSITORY));
    }
    Ok(repository)
}

/// The source as it is stored: a GitHub repository, or the distinct Linear team ids.
///
/// # Errors
///
/// 400 for a bad repository or team id.
pub fn normalize_source(
    provider: ExternalProvider,
    source: Option<&ImportSource>,
) -> Result<ImportSource, AppError> {
    if provider == ExternalProvider::Github {
        let repository = parse_repository(source.and_then(|s| s.repository.as_deref()))?;
        return Ok(ImportSource { repository: Some(repository), team_ids: None });
    }
    let team_ids = unique(source.and_then(|s| s.team_ids.as_deref()).unwrap_or_default());
    if team_ids.iter().any(|id| !TEAM_ID.is_match(id)) {
        return Err(AppError::bad_request("source.teamIds contains an invalid id"));
    }
    Ok(ImportSource { repository: None, team_ids: Some(team_ids) })
}

// ───────────── preview ─────────────

/// What the preview matches the source against: members, projects, issue labels and routed
/// repositories of the workspace.
async fn context(state: &AppState, workspace_id: &str) -> Result<PreviewContext, AppError> {
    let db = &state.db;
    let user_ids: Vec<String> = memberships::Entity::find()
        .select_only()
        .column(memberships::Column::UserId)
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .into_tuple()
        .all(db)
        .await?;
    let people = if user_ids.is_empty() {
        Vec::new()
    } else {
        users::Entity::find().filter(users::Column::Id.is_in(user_ids)).all(db).await?
    };
    let known_projects = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .all(db)
        .await?;
    let workspace = workspaces::Entity::find_by_id(workspace_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Workspace", workspace_id))?;
    Ok(PreviewContext {
        members: people
            .into_iter()
            .map(|u| Member { id: u.id, name: u.name, email: u.email })
            .collect(),
        teams: Vec::new(),
        projects: known_projects.into_iter().map(|p| Named { id: p.id, name: p.name }).collect(),
        labels: resolve_label_catalog(workspace.settings.get("labels"))
            .into_iter()
            .filter(|l| l.scope == StoredLabelScope::Issue)
            .map(|l| Named { id: l.id, name: l.name })
            .collect(),
        by_login: None,
        routes: trama_routing::service::routed_repositories(db, workspace_id)
            .await?
            .into_iter()
            .map(|(source_path, project_id)| Route { source_path, project_id })
            .collect(),
    })
}

/// Reads the source and answers with counts plus the suggested mapping. Writes nothing.
///
/// # Errors
///
/// 400 for a bad source or credential, the provider's failure as an HTTP error (the message never
/// carries a token).
pub async fn preview(
    state: &AppState,
    workspace_id: &str,
    req: &ImportRequest,
) -> Result<ImportPreview, AppError> {
    let source = normalize_source(req.provider, req.source.as_ref())?;
    let (credential_id, connection_id) = req.credential();
    let cred =
        credentials::resolve(state, workspace_id, req.provider, credential_id, connection_id)
            .await?;
    let adapter = source_for(state, req.provider, &cred, &source)?;
    let discovery = adapter
        .discover()
        .await
        .map_err(|e| provider_failure(req.provider.label(), &e, &[cred.token.as_deref()]))?;
    let mut ctx = context(state, workspace_id).await?;
    if req.provider == ExternalProvider::Github {
        // A GitHub login one of the members has linked is the strongest hint for who an
        // assignee is.
        let logins: Vec<&str> = discovery
            .users
            .iter()
            .filter_map(|u| u.login.as_deref().filter(|l| !l.is_empty()))
            .collect();
        ctx.by_login = Some(
            trama_external_identities::service::resolve_members_by_logins(
                &state.db,
                workspace_id,
                "github",
                cred.base_url.as_deref(),
                &logins,
                ResolveOptions::default(),
            )
            .await?,
        );
    }
    Ok(build_preview(&discovery, &ctx))
}

// ───────────── jobs ─────────────

fn map_ids(targets: &BTreeMap<String, ImportTarget>) -> Vec<String> {
    targets
        .values()
        .filter_map(|t| match t {
            ImportTarget::Map { id } if !id.is_empty() => Some(id.clone()),
            _ => None,
        })
        .collect()
}

/// Every reference in the mapping must exist in this workspace before a single row is written.
async fn assert_mapping(
    state: &AppState,
    workspace_id: &str,
    mapping: &ImportMapping,
) -> Result<(), AppError> {
    if mapping.teams.values().any(|t| matches!(t, ImportTarget::Map { .. })) {
        return Err(AppError::bad_request("Linear teams are not workspace teams"));
    }
    refs::projects(&state.db, workspace_id, &map_ids(&mapping.projects)).await?;
    let people: Vec<Option<String>> = mapping.users.values().cloned().collect();
    refs::users(&state.db, workspace_id, &people).await?;
    let label_ids = map_ids(&mapping.labels);
    if !label_ids.is_empty() {
        let workspace = workspaces::Entity::find_by_id(workspace_id)
            .one(&state.db)
            .await?
            .ok_or_else(|| AppError::entity_not_found("Workspace", workspace_id))?;
        let catalog = resolve_label_catalog(workspace.settings.get("labels"));
        let scope_of = |id: &String| catalog.iter().find(|l| &l.id == id).map(|l| l.scope);
        let unknown: Vec<String> =
            label_ids.iter().filter(|id| scope_of(id).is_none()).cloned().collect();
        if !unknown.is_empty() {
            return Err(AppError::bad_request(format!(
                "Unknown label in: {}",
                unique(&unknown).join(", ")
            )));
        }
        let wrong: Vec<String> = label_ids
            .iter()
            .filter(|id| scope_of(id).is_some_and(|scope| scope != StoredLabelScope::Issue))
            .cloned()
            .collect();
        if !wrong.is_empty() {
            return Err(AppError::bad_request(format!(
                "Label does not apply to issues: {}",
                unique(&wrong).join(", ")
            )));
        }
    }
    Ok(())
}

async fn has_active_job(state: &AppState, workspace_id: &str) -> Result<bool, AppError> {
    let active: Vec<&str> = IMPORT_ACTIVE_STATUSES.iter().map(|s| s.as_str()).collect();
    Ok(import_jobs::Entity::find()
        .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
        .filter(import_jobs::Column::Status.is_in(active))
        .count(&state.db)
        .await?
        > 0)
}

fn is_active(status: &str) -> bool {
    IMPORT_ACTIVE_STATUSES.iter().any(|s| s.as_str() == status)
}

fn credential_ref(req: &ImportRequest) -> Value {
    let mut out = Map::new();
    if let Some(id) = &req.credential_id {
        out.insert("credentialId".into(), id.clone().into());
    }
    if let Some(id) = &req.connection_id {
        out.insert("connectionId".into(), id.clone().into());
    }
    Value::Object(out)
}

fn json_of<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(AppError::internal)
}

/// Queues the import and returns the job; the runner picks it up.
///
/// # Errors
///
/// 400 for a bad source, credential, options or mapping; 409 when another import of the
/// workspace is queued or running (also when the unique index says so).
pub async fn start(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    req: &ImportRequest,
) -> Result<import_jobs::Model, AppError> {
    let source = normalize_source(req.provider, req.source.as_ref())?;
    let (credential_id, connection_id) = req.credential();
    // the reference must be one of this workspace's
    credentials::resolve(state, workspace_id, req.provider, credential_id, connection_id).await?;
    let options = parse_options(req.options.as_ref(), DEFAULT_IMPORT_OPTIONS)?;
    if has_active_job(state, workspace_id).await? {
        return Err(AppError::conflict(ANOTHER_RUNNING));
    }

    let mut source_label = if req.provider == ExternalProvider::Github {
        source.repository.clone().unwrap_or_default()
    } else {
        let teams = source.team_ids.as_deref().unwrap_or_default();
        format!(
            "Linear ({})",
            if teams.is_empty() {
                "all teams".to_owned()
            } else {
                format!("{} team(s)", teams.len())
            }
        )
    };
    let mapping = if let Some(raw) = req.mapping.as_ref().filter(|m| !m.is_null()) {
        parse_mapping(Some(raw))?
    } else {
        // No mapping given (an agent, "run with defaults"): use what the preview suggests.
        let suggested = preview(state, workspace_id, req).await?;
        source_label.clone_from(&suggested.source_label);
        mapping_from_preview(&suggested)
    };
    assert_mapping(state, workspace_id, &mapping).await?;

    let inserted = import_jobs::ActiveModel {
        id: Set(uid("imp")),
        workspace_id: Set(workspace_id.to_owned()),
        provider: Set(req.provider.as_str().to_owned()),
        status: Set("queued".to_owned()),
        source_label: Set(js::truncate(&source_label, SOURCE_LABEL_MAX).to_owned()),
        source: Set(json_of(&source)?),
        options: Set(json_of(&options)?),
        mapping: Set(json_of(&mapping)?),
        credential: Set(credential_ref(req)),
        progress: Set(json_of(&empty_progress())?),
        errors: Set(json!([])),
        cursor: Set(None),
        waiting_until: Set(None),
        cancel_requested: Set(false),
        last_error: Set(None),
        heartbeat_at: Set(None),
        created_by: Set(json_of(actor)?),
        started_at: Set(None),
        finished_at: Set(None),
        ..Default::default()
    }
    .insert(&state.db)
    .await;
    let job = match inserted {
        Ok(job) => job,
        // The partial unique index is the cross-request/process authority.
        Err(error) if is_unique_violation(&error) => {
            return Err(AppError::conflict(ANOTHER_RUNNING));
        }
        Err(error) => return Err(error.into()),
    };
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(
                workspace_id,
                actor.clone(),
                "import.started",
                SubjectRef { kind: SubjectType::Import, id: job.id.clone() },
            )
            .data(json!({ "provider": job.provider, "source": job.source_label })),
        )
        .await?;
    ImportRunner::of(state).kick(state, &job.id).await;
    Ok(job)
}

/// The workspace's jobs, newest first (at most 50).
///
/// # Errors
///
/// A database error.
pub async fn list(
    state: &AppState,
    workspace_id: &str,
) -> Result<Vec<import_jobs::Model>, AppError> {
    Ok(import_jobs::Entity::find()
        .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(import_jobs::Column::CreatedAt)
        .limit(LIST_MAX)
        .all(&state.db)
        .await?)
}

/// One job of the workspace.
///
/// # Errors
///
/// 404 `Import "<id>" not found`.
pub async fn get(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<import_jobs::Model, AppError> {
    import_jobs::Entity::find_by_id(id)
        .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Import", id))
}

async fn update_where(
    state: &AppState,
    workspace_id: &str,
    id: &str,
    set: import_jobs::ActiveModel,
    only: impl sea_orm::sea_query::IntoCondition,
) -> Result<u64, AppError> {
    Ok(import_jobs::Entity::update_many()
        .set(set)
        .filter(import_jobs::Column::Id.eq(id))
        .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
        .filter(only)
        .exec(&state.db)
        .await?
        .rows_affected)
}

/// Asks a job to stop: a queued job nobody picked up stops now, a running one at its next page.
///
/// # Errors
///
/// 404 for an unknown job; 409 `The import already <status>` once it ended.
pub async fn cancel(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<import_jobs::Model, AppError> {
    let job = get(state, workspace_id, id).await?;
    if !is_active(&job.status) {
        return Err(AppError::conflict(format!("The import already {}", job.status)));
    }
    let parked = update_where(
        state,
        workspace_id,
        id,
        import_jobs::ActiveModel {
            status: Set("canceled".to_owned()),
            finished_at: Set(Some(Utc::now().fixed_offset())),
            waiting_until: Set(None),
            cancel_requested: Set(true),
            ..Default::default()
        },
        sea_orm::Condition::all()
            .add(import_jobs::Column::Status.eq("queued"))
            .add(import_jobs::Column::HeartbeatAt.is_null()),
    )
    .await?;
    // A running job stops at its next page; one that is parked or not yet picked up stops now.
    if parked == 0 {
        update_where(
            state,
            workspace_id,
            id,
            import_jobs::ActiveModel { cancel_requested: Set(true), ..Default::default() },
            sea_orm::Condition::all(),
        )
        .await?;
    }
    get(state, workspace_id, id).await
}

/// Continues a failed import from where it stopped.
///
/// # Errors
///
/// 404 for an unknown job; 409 unless it failed, or when another import is active.
pub async fn retry(
    state: &AppState,
    workspace_id: &str,
    id: &str,
) -> Result<import_jobs::Model, AppError> {
    let job = get(state, workspace_id, id).await?;
    if job.status != "failed" {
        return Err(AppError::conflict("Only a failed import can be retried"));
    }
    if has_active_job(state, workspace_id).await? {
        return Err(AppError::conflict(ANOTHER_RUNNING));
    }
    update_where(
        state,
        workspace_id,
        id,
        import_jobs::ActiveModel {
            status: Set("queued".to_owned()),
            last_error: Set(None),
            finished_at: Set(None),
            cancel_requested: Set(false),
            heartbeat_at: Set(None),
            waiting_until: Set(None),
            ..Default::default()
        },
        sea_orm::Condition::all(),
    )
    .await?;
    ImportRunner::of(state).kick(state, id).await;
    get(state, workspace_id, id).await
}

/// Deletes a finished job.
///
/// # Errors
///
/// 404 for an unknown job; 409 `Cancel the import before deleting it` while it is active.
pub async fn remove(state: &AppState, workspace_id: &str, id: &str) -> Result<(), AppError> {
    let job = get(state, workspace_id, id).await?;
    if is_active(&job.status) {
        return Err(AppError::conflict("Cancel the import before deleting it"));
    }
    import_jobs::Entity::delete_many()
        .filter(import_jobs::Column::Id.eq(id))
        .filter(import_jobs::Column::WorkspaceId.eq(workspace_id))
        .exec(&state.db)
        .await?;
    Ok(())
}

/// The wire form of a job: `ImportJobEntity.toJSON()`. Null columns are left out, and the
/// credential reference, cursor and heartbeat are never returned.
#[must_use]
pub fn present(job: &import_jobs::Model) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), job.id.clone().into());
    out.insert("workspaceId".into(), job.workspace_id.clone().into());
    out.insert("provider".into(), job.provider.clone().into());
    out.insert("status".into(), job.status.clone().into());
    out.insert("sourceLabel".into(), job.source_label.clone().into());
    out.insert("source".into(), job.source.clone());
    out.insert("options".into(), job.options.clone());
    out.insert("mapping".into(), job.mapping.clone());
    out.insert("progress".into(), job.progress.clone());
    out.insert("errors".into(), job.errors.clone());
    if let Some(at) = &job.waiting_until {
        out.insert("waitingUntil".into(), to_iso(at).into());
    }
    out.insert("cancelRequested".into(), job.cancel_requested.into());
    if let Some(error) = &job.last_error {
        out.insert("lastError".into(), error.clone().into());
    }
    out.insert("createdBy".into(), job.created_by.clone());
    out.insert("createdAt".into(), to_iso(&job.created_at).into());
    if let Some(at) = &job.started_at {
        out.insert("startedAt".into(), to_iso(at).into());
    }
    if let Some(at) = &job.finished_at {
        out.insert("finishedAt".into(), to_iso(at).into());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github(repository: &str) -> ImportSource {
        ImportSource { repository: Some(repository.into()), team_ids: None }
    }

    fn linear(ids: &[&str]) -> ImportSource {
        ImportSource {
            repository: None,
            team_ids: Some(ids.iter().map(|s| (*s).to_owned()).collect()),
        }
    }

    #[test]
    fn accepts_owner_name_or_a_github_url_for_a_repository() {
        assert_eq!(parse_repository(Some("acme/api")).unwrap(), "acme/api");
        assert_eq!(parse_repository(Some("https://github.com/acme/api")).unwrap(), "acme/api");
        assert_eq!(parse_repository(Some("https://github.com/acme/api.git")).unwrap(), "acme/api");
        assert_eq!(
            parse_repository(Some("https://github.com/acme/api/issues/4")).unwrap(),
            "acme/api"
        );
        assert_eq!(parse_repository(Some("  acme/api/  ")).unwrap(), "acme/api");
        assert_eq!(parse_repository(Some("acme/API.GIT")).unwrap(), "acme/API");
    }

    #[test]
    fn rejects_a_repository_that_is_not_owner_name() {
        for bad in ["", "acme", "acme/api/../../x", "a b/c", "acme/ap;i", "../etc/passwd"] {
            let error = parse_repository(Some(bad)).unwrap_err();
            assert_eq!(error.status_code(), 400, "{bad:?}");
            assert!(error.to_string().contains(BAD_REPOSITORY), "{bad:?}");
        }
        assert!(parse_repository(None).is_err());
        assert!(parse_repository(Some("https://github.com/acme/")).is_err());
        assert!(parse_repository(Some("https://github.com/./..")).is_err());
    }

    #[test]
    fn normalizes_a_source_per_provider() {
        assert_eq!(
            normalize_source(
                ExternalProvider::Github,
                Some(&github("https://github.com/acme/api"))
            )
            .unwrap(),
            ImportSource { repository: Some("acme/api".into()), team_ids: None }
        );
        assert!(normalize_source(ExternalProvider::Github, None).is_err());
        // Linear without a source means every team
        assert_eq!(
            normalize_source(ExternalProvider::Linear, None).unwrap().team_ids,
            Some(vec![])
        );
    }

    #[test]
    fn validates_linear_team_ids_and_drops_duplicates() {
        assert_eq!(
            normalize_source(ExternalProvider::Linear, Some(&linear(&["a", "a", "b_1"])))
                .unwrap()
                .team_ids,
            Some(vec!["a".to_owned(), "b_1".to_owned()])
        );
        let error = normalize_source(ExternalProvider::Linear, Some(&linear(&["ok", "bad id!"])))
            .unwrap_err();
        assert_eq!(error.status_code(), 400);
        assert!(error.to_string().contains("source.teamIds contains an invalid id"));
    }

    #[test]
    fn jobs_are_presented_like_the_nestjs_entity() {
        use chrono::TimeZone;
        let at = Utc.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).unwrap().fixed_offset();
        let job = import_jobs::Model {
            id: "imp_1".into(),
            workspace_id: "ws_1".into(),
            provider: "github".into(),
            status: "queued".into(),
            source_label: "acme/api".into(),
            source: json!({ "repository": "acme/api" }),
            options: json!({}),
            mapping: json!({}),
            credential: json!({ "credentialId": "tcr_secret" }),
            progress: json!({ "phase": "setup" }),
            errors: json!([]),
            cursor: Some(json!({ "phase": "issues" })),
            waiting_until: None,
            cancel_requested: false,
            last_error: None,
            heartbeat_at: Some(at),
            created_by: json!({ "type": "user", "id": "usr_1" }),
            created_at: at,
            started_at: None,
            finished_at: None,
        };
        let out = present(&job);
        let keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        for hidden in ["credential", "cursor", "heartbeatAt", "waitingUntil", "lastError"] {
            assert!(!keys.contains(&hidden), "{hidden}");
        }
        assert_eq!(out["createdAt"], "2026-10-01T12:00:00.000Z");
        assert_eq!(out["createdBy"], json!({ "type": "user", "id": "usr_1" }));
        assert!(!out.to_string().contains("tcr_secret"));
    }
}
