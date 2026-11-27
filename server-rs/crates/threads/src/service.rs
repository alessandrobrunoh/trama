//! The record an agent keeps of the thread linked to a task, its decisions and estimate hints
//! (`server/src/threads/threads.service.ts`).
//!
//! Like the issues service, these functions read the request's member access from the
//! `trama-auth` task-local, so a narrowed member neither sees nor syncs a task of another
//! project.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use sea_orm::sea_query::NullOrdering;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel,
    JoinType, Order, QueryFilter, QueryOrder, QuerySelect, RelationTrait, Set, Statement,
    TransactionTrait, Value,
};
use serde_json::{Value as Json, json};
use trama_artifacts::service::{ArtifactFilter, ArtifactInput};
use trama_auth::member_access::{apply_project_scope, current_access};
use trama_contracts::access::{MemberAction, MemberGrant, MemberResource};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::issues::{Artifact, ArtifactKind};
use trama_contracts::js;
use trama_contracts::settings::EstimateScale;
use trama_contracts::status::{load_status_catalog, status_ids_for_types};
use trama_contracts::threads::{
    EstimateSuggestion, THREAD_FILES_MAX, ThreadDecision, ThreadRecord, ThreadSyncInput,
    ThreadSyncResult, TimeEntrySource, TimeSuggestion,
};
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::validation::Patch;
use trama_core::{AppError, AppState};
use trama_entities::{issues, task_decisions, task_thread_records, time_entries};
use trama_events::{Events, RecordEvent};
use trama_issues::rows::strings;
use trama_issues::thread_link::assert_thread_linkable;
use trama_uploads::schemas::artifact_view;

use crate::estimate::{FinishedTask, SimilarityTarget, build_estimate_suggestion, rank_similar};
use crate::paths::{clean_thread_paths, decision_matches_path, merge_files};
use crate::pull_request::parse_pull_request_url;
use crate::schemas::{DECISIONS_DEFAULT_LIMIT, DECISIONS_MAX_LIMIT};

/// Most decisions looked at when a path filter has to be applied in memory (newest first).
const DECISIONS_SCAN_MAX: u64 = 5000;
/// Most finished tasks compared for an estimate suggestion (finished most recently first).
const ESTIMATE_CANDIDATES_MAX: u64 = 500;

/// Who the sync is for and what the caller may do besides editing the task.
#[derive(Clone, Debug)]
pub struct SyncCaller {
    /// The acting person or agent.
    pub actor: ActorRef,
    /// The person the key acts as. Absent for agent tokens.
    pub user_id: Option<String>,
    /// May the caller attach artifacts (custom tokens need `artifacts:write`)?
    pub can_write_artifacts: bool,
}

/// A sync after trimming and checking everything it sends (`CleanSync`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleanSync {
    /// The thread to link when the task has none.
    pub thread_url: Option<String>,
    /// `None`: leave the summary; `Some(None)`: a blank summary clears it.
    pub summary: Option<Option<String>>,
    /// Decisions to append: trimmed text and cleaned paths.
    pub decisions: Vec<(String, Vec<String>)>,
    /// Cleaned files.
    pub files: Vec<String>,
    /// PR to attach.
    pub pull_request_url: Option<String>,
    /// Minutes to suggest.
    pub active_minutes: Option<i64>,
    /// Turns so far.
    pub turns: Option<i64>,
}

/// Trims and checks everything a sync sends, so nothing is written when part of it is wrong
/// (`cleanSyncInput`).
///
/// # Errors
///
/// 400 `A decision needs text`, or a refused path.
pub fn clean_sync_input(input: &ThreadSyncInput) -> Result<CleanSync, AppError> {
    let mut decisions = Vec::new();
    for decision in input.decisions.as_deref().unwrap_or_default() {
        let text = js::trim(&decision.text);
        if text.is_empty() {
            return Err(AppError::bad_request("A decision needs text"));
        }
        let paths = clean_thread_paths(decision.paths.as_deref().unwrap_or_default())?;
        decisions.push((text.to_owned(), paths));
    }
    Ok(CleanSync {
        thread_url: input.thread_url.clone(),
        summary: input
            .summary
            .as_deref()
            .map(|s| Some(js::trim(s)).filter(|s| !s.is_empty()).map(str::to_owned)),
        decisions,
        files: clean_thread_paths(input.files.as_deref().unwrap_or_default())?,
        pull_request_url: input.pull_request_url.clone(),
        active_minutes: input.active_minutes,
        turns: input.turns,
    })
}

fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap_or_else(Utc::now)
}

fn subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Issue, id: id.to_owned() }
}

fn to_decision(row: &task_decisions::Model, issue_key: &str) -> ThreadDecision {
    ThreadDecision {
        id: row.id.clone(),
        issue_id: row.issue_id.clone(),
        issue_key: issue_key.to_owned(),
        text: row.text.clone(),
        paths: strings(&row.paths),
        thread_url: row.thread_url.clone(),
        created_by: serde_json::from_value(row.created_by.clone())
            .unwrap_or_else(|_| ActorRef::system()),
        created_at: to_iso(&row.created_at),
    }
}

fn to_record(row: &task_thread_records::Model, decisions: Vec<ThreadDecision>) -> ThreadRecord {
    ThreadRecord {
        issue_id: row.issue_id.clone(),
        thread_url: row.thread_url.clone(),
        summary: row.summary.clone(),
        files: strings(&row.files),
        turns: row.turns,
        sync_count: row.sync_count,
        last_sync_at: to_iso(&row.last_sync_at),
        last_sync_by: serde_json::from_value(row.last_sync_by.clone())
            .unwrap_or_else(|_| ActorRef::system()),
        decisions,
    }
}

/// Decisions of one task, oldest first.
async fn decisions_of<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue: &issues::Model,
) -> Result<Vec<ThreadDecision>, AppError> {
    let rows = task_decisions::Entity::find()
        .filter(task_decisions::Column::WorkspaceId.eq(workspace_id))
        .filter(task_decisions::Column::IssueId.eq(issue.id.as_str()))
        .order_by_asc(task_decisions::Column::CreatedAt)
        .order_by_asc(task_decisions::Column::Id)
        .all(db)
        .await?;
    Ok(rows.iter().map(|row| to_decision(row, &issue.key)).collect())
}

/// May the caller attach artifacts: the token allows it and so does the member's access.
fn may_attach_artifacts(caller: &SyncCaller) -> bool {
    caller.can_write_artifacts
        && current_access().is_none_or(|access| {
            access
                .grants
                .contains(&MemberGrant::new(MemberResource::Artifacts, MemberAction::Create))
        })
}

/// `trama sync`: link the thread, upsert the record, add decisions, attach the PR, suggest time.
/// Records `issue.updated` (when it linked the thread) and `issue.thread_synced`.
///
/// # Errors
///
/// 400 for a refused path, a blank decision or a PR URL the artifacts refuse; 403 `Attaching a
/// pull request needs the artifacts permission`; 404 for an unknown or hidden task; 409
/// `thread_already_linked` when the task links a different thread.
#[allow(
    clippy::too_many_lines,
    reason = "one step per part of the sync, in the order NestJS runs them"
)]
pub async fn sync(
    state: &AppState,
    workspace_id: &str,
    caller: &SyncCaller,
    id_or_key: &str,
    input: &ThreadSyncInput,
) -> Result<ThreadSyncResult, AppError> {
    let db = &state.db;
    let events = Events::of(state);
    let clean = clean_sync_input(input)?;
    let issue = trama_issues::service::get(db, workspace_id, id_or_key).await?;
    assert_thread_linkable(&issue.key, issue.thread_url.as_deref(), clean.thread_url.as_deref())?;
    if clean.pull_request_url.is_some() && !may_attach_artifacts(caller) {
        return Err(AppError::forbidden("Attaching a pull request needs the artifacts permission"));
    }
    // The PR goes first: attaching the same URL again is a no-op, so a retry cannot duplicate it.
    let artifact = match &clean.pull_request_url {
        Some(url) => {
            Some(attach_pull_request(state, workspace_id, &caller.actor, &issue, url).await?)
        }
        None => None,
    };

    let txn = db.begin().await?;
    // One sync at a time per task: the lock also settles a race between two different threads.
    let locked = issues::Entity::find()
        .filter(issues::Column::Id.eq(issue.id.as_str()))
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .lock_exclusive()
        .one(&txn)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Issue", &issue.id))?;
    assert_thread_linkable(&issue.key, locked.thread_url.as_deref(), clean.thread_url.as_deref())?;

    let at = now();
    let mut thread_url = locked.thread_url.clone();
    let mut linked = false;
    if let Some(url) = clean.thread_url.as_ref().filter(|_| thread_url.is_none()) {
        thread_url = Some(url.clone());
        linked = true;
        let mut active = locked.clone().into_active_model();
        active.thread_url = Set(thread_url.clone());
        active.updated_at = Set(at.fixed_offset());
        active.update(&txn).await?;
        events
            .record(
                &txn,
                RecordEvent::new(
                    workspace_id,
                    caller.actor.clone(),
                    "issue.updated",
                    subject(&issue.id),
                )
                .data(json!({ "key": issue.key, "fields": ["threadUrl"] })),
            )
            .await?;
    }

    let existing = task_thread_records::Entity::find_by_id(issue.id.clone()).one(&txn).await?;
    let mut files = existing.as_ref().map(|row| strings(&row.files)).unwrap_or_default();
    if !clean.files.is_empty() {
        files = merge_files(&files, &clean.files, THREAD_FILES_MAX);
    }
    let summary = match &clean.summary {
        Some(summary) => summary.clone(),
        None => existing.as_ref().and_then(|row| row.summary.clone()),
    };
    let turns = match clean.turns {
        Some(turns) => i32::try_from(turns).ok(),
        None => existing.as_ref().and_then(|row| row.turns),
    };
    let sync_count = existing.as_ref().map_or(0, |row| row.sync_count) + 1;
    let record = task_thread_records::ActiveModel {
        issue_id: Set(issue.id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        thread_url: Set(thread_url.clone()),
        summary: Set(summary),
        files: Set(json!(files)),
        turns: Set(turns),
        sync_count: Set(sync_count),
        last_sync_at: Set(at.fixed_offset()),
        last_sync_by: Set(serde_json::to_value(&caller.actor).unwrap_or(Json::Null)),
        created_at: Set(existing.as_ref().map_or(at.fixed_offset(), |row| row.created_at)),
    };
    let record =
        if existing.is_some() { record.update(&txn).await? } else { record.insert(&txn).await? };

    // one row per decision; the offset keeps the order they were sent in
    let mut added = 0usize;
    for (index, (text, paths)) in clean.decisions.iter().enumerate() {
        let offset = i64::try_from(index).unwrap_or(i64::MAX);
        task_decisions::ActiveModel {
            id: Set(uid("dc")),
            workspace_id: Set(workspace_id.to_owned()),
            issue_id: Set(issue.id.clone()),
            text: Set(text.clone()),
            paths: Set(json!(paths)),
            thread_url: Set(thread_url.clone()),
            created_by: Set(serde_json::to_value(&caller.actor).unwrap_or(Json::Null)),
            created_at: Set((at + Duration::milliseconds(offset)).fixed_offset()),
        }
        .insert(&txn)
        .await?;
        added += 1;
    }

    let mut time_suggestion = None;
    let owner = caller.user_id.clone().or_else(|| locked.assignee_id.clone());
    if let (Some(minutes), Some(owner)) = (clean.active_minutes, owner) {
        let entry = time_entries::ActiveModel {
            id: Set(uid("te")),
            workspace_id: Set(workspace_id.to_owned()),
            user_id: Set(owner.clone()),
            project_id: Set(locked.project_id.clone()),
            issue_id: Set(Some(issue.id.clone())),
            description: Set(String::new()),
            source: Set(TimeEntrySource::Suggested.as_str().to_owned()),
            started_at: Set((at - Duration::minutes(minutes)).fixed_offset()),
            ended_at: Set(Some(at.fixed_offset())),
            created_at: Set(at.fixed_offset()),
            updated_at: Set(at.fixed_offset()),
        }
        .insert(&txn)
        .await?;
        time_suggestion = Some(TimeSuggestion { id: entry.id, user_id: owner, minutes });
    }

    events
        .record(
            &txn,
            RecordEvent::new(
                workspace_id,
                caller.actor.clone(),
                "issue.thread_synced",
                subject(&issue.id),
            )
            .data(json!({
                "key": issue.key,
                "decisions": added,
                "files": files.len(),
                "pullRequest": artifact.is_some(),
                "minutes": time_suggestion.as_ref().map(|s| s.minutes),
            })),
        )
        .await?;

    let all = decisions_of(&txn, workspace_id, &issue).await?;
    txn.commit().await?;
    Ok(ThreadSyncResult {
        record: to_record(&record, all),
        decisions_added: added,
        linked,
        artifact,
        time_suggestion,
    })
}

/// The record of a task, with its decisions (oldest first).
///
/// # Errors
///
/// 404 for an unknown or hidden task, and `Thread record "<key>" not found` when it was never
/// synced.
pub async fn get_record<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id_or_key: &str,
) -> Result<ThreadRecord, AppError> {
    let issue = trama_issues::service::get(db, workspace_id, id_or_key).await?;
    let row = task_thread_records::Entity::find()
        .filter(task_thread_records::Column::WorkspaceId.eq(workspace_id))
        .filter(task_thread_records::Column::IssueId.eq(issue.id.as_str()))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Thread record", &issue.key))?;
    let decisions = decisions_of(db, workspace_id, &issue).await?;
    Ok(to_record(&row, decisions))
}

/// What `GET /decisions` filters by.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DecisionFilter {
    /// A repository file.
    pub path: Option<String>,
    /// Id or key of a task.
    pub issue: Option<String>,
    /// Most decisions to return.
    pub limit: Option<u64>,
}

/// Decisions, newest first. With `path`, the ones that cover that file (same path, a directory
/// prefix or a glob); decisions without paths only match when `issue` is given.
///
/// # Errors
///
/// 404 when `issue` is unknown or hidden.
pub async fn list_decisions<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    filter: &DecisionFilter,
) -> Result<Vec<ThreadDecision>, AppError> {
    let limit = filter.limit.unwrap_or(DECISIONS_DEFAULT_LIMIT).clamp(1, DECISIONS_MAX_LIMIT);
    let issue_id = match filter.issue.as_deref().filter(|issue| !issue.is_empty()) {
        Some(issue) => Some(trama_issues::service::get(db, workspace_id, issue).await?.id),
        None => None,
    };
    let file = filter.path.as_deref().map(js::trim).filter(|path| !path.is_empty());

    let mut query = task_decisions::Entity::find()
        .join(JoinType::InnerJoin, task_decisions::Relation::Issues.def())
        .filter(task_decisions::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(task_decisions::Column::CreatedAt)
        .order_by_desc(task_decisions::Column::Id)
        .limit(if file.is_some() { DECISIONS_SCAN_MAX } else { limit });
    if let Some(id) = &issue_id {
        query = query.filter(task_decisions::Column::IssueId.eq(id.as_str()));
    }
    query = apply_project_scope(query, issues::Column::ProjectId);
    let mut rows = query.all(db).await?;
    if let Some(file) = file {
        rows.retain(|row| {
            let paths = strings(&row.paths);
            if paths.is_empty() { issue_id.is_some() } else { decision_matches_path(&paths, file) }
        });
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    }

    let keys = issue_keys(db, workspace_id, rows.iter().map(|row| row.issue_id.clone())).await?;
    Ok(rows
        .iter()
        .map(|row| to_decision(row, keys.get(&row.issue_id).map_or("", String::as_str)))
        .collect())
}

/// Points suggested from similar finished tasks of the workspace. People decide.
///
/// # Errors
///
/// 404 for an unknown or hidden task.
pub async fn estimate_suggestion<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    scale: EstimateScale,
    id_or_key: &str,
) -> Result<EstimateSuggestion, AppError> {
    let issue = trama_issues::service::get(db, workspace_id, id_or_key).await?;
    let catalog = load_status_catalog(db, workspace_id).await.issue;
    let done = status_ids_for_types(&catalog, &["done"]);
    let query = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Status.is_in(done))
        .filter(issues::Column::Estimate.is_not_null())
        .filter(issues::Column::Id.ne(issue.id.as_str()))
        .order_by_with_nulls(issues::Column::CompletedAt, Order::Desc, NullOrdering::Last)
        .limit(ESTIMATE_CANDIDATES_MAX);
    let finished: Vec<FinishedTask> = apply_project_scope(query, issues::Column::ProjectId)
        .all(db)
        .await?
        .into_iter()
        .map(|row| FinishedTask {
            id: row.id,
            key: row.key,
            target: SimilarityTarget {
                title: row.title,
                project_id: row.project_id,
                labels: strings(&row.labels),
            },
            estimate: row.estimate.unwrap_or(0.0),
            tracked_minutes: None,
            completed_at: row.completed_at.map(|d| d.with_timezone(&Utc)),
        })
        .collect();

    let target = SimilarityTarget {
        title: issue.title.clone(),
        project_id: issue.project_id.clone(),
        labels: strings(&issue.labels),
    };
    let top = rank_similar(&target, &finished, crate::estimate::SUGGESTION_BASIS_MAX);
    let tracked = tracked_minutes(db, workspace_id, top.iter().map(|s| s.task.id.clone())).await?;
    let basis: Vec<FinishedTask> = top
        .into_iter()
        .map(|scored| FinishedTask {
            tracked_minutes: tracked.get(&scored.task.id).copied(),
            ..scored.task
        })
        .collect();
    Ok(build_estimate_suggestion(&issue.id, &target, &basis, scale))
}

/// Minutes of finished, counted entries per task. Suggestions and running timers do not count.
async fn tracked_minutes<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue_ids: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, i64>, AppError> {
    let ids: Vec<String> = issue_ids.into_iter().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT "issueId", (SUM(EXTRACT(EPOCH FROM ("endedAt" - "startedAt"))) / 60)::float8 AS "minutes"
             FROM "time_entries"
            WHERE "workspaceId" = $1
              AND "issueId" IN (SELECT jsonb_array_elements_text($2::jsonb))
              AND "endedAt" IS NOT NULL AND "source" <> 'suggested'
            GROUP BY "issueId""#,
        [Value::from(workspace_id), Value::from(json!(ids))],
    );
    let mut out = HashMap::new();
    for row in db.query_all_raw(statement).await? {
        let issue_id: String = row.try_get("", "issueId")?;
        let minutes: f64 = row.try_get("", "minutes")?;
        #[allow(clippy::cast_possible_truncation)]
        out.insert(issue_id, minutes.round() as i64);
    }
    Ok(out)
}

async fn issue_keys<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, String>, AppError> {
    let mut unique: Vec<String> = ids.into_iter().collect();
    unique.sort();
    unique.dedup();
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = issues::Entity::find()
        .select_only()
        .column(issues::Column::Id)
        .column(issues::Column::Key)
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(unique))
        .into_tuple::<(String, String)>()
        .all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

/// Creates the `pull_request` artifact of the task, or refreshes the one with the same URL.
async fn attach_pull_request(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    issue: &issues::Model,
    url: &str,
) -> Result<Artifact, AppError> {
    let parsed = parse_pull_request_url(url);
    let existing = trama_artifacts::service::list(
        &state.db,
        workspace_id,
        &ArtifactFilter { issue_id: Some(issue.id.clone()), ..ArtifactFilter::default() },
    )
    .await?
    .into_iter()
    .find(|a| {
        a.url.as_deref() == Some(url)
            && (a.kind == ArtifactKind::PullRequest.as_str()
                || a.kind == ArtifactKind::MergeRequest.as_str())
    });
    let patch = |value: Option<String>| value.map_or(Patch::Null, Patch::Value);
    let row = match existing {
        Some(existing) => {
            trama_artifacts::service::update(
                state,
                workspace_id,
                actor,
                &existing.id,
                ArtifactInput {
                    title: Some(parsed.title),
                    external_id: patch(parsed.external_id),
                    repository: patch(parsed.repository),
                    ..ArtifactInput::default()
                },
            )
            .await?
        }
        None => {
            trama_artifacts::service::create(
                state,
                workspace_id,
                actor,
                parsed.kind,
                ArtifactInput {
                    issue_id: Patch::Value(issue.id.clone()),
                    provider: Some(parsed.provider),
                    title: Some(parsed.title),
                    url: Patch::Value(url.to_owned()),
                    external_id: patch(parsed.external_id),
                    repository: patch(parsed.repository),
                    ..ArtifactInput::default()
                },
            )
            .await?
        }
    };
    Ok(artifact_view(&row))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use trama_contracts::threads::ThreadSyncDecision;

    use super::*;

    fn decision(text: &str, paths: Option<&[&str]>) -> ThreadSyncDecision {
        ThreadSyncDecision {
            text: text.to_owned(),
            paths: paths.map(|p| p.iter().map(|s| (*s).to_owned()).collect()),
        }
    }

    #[test]
    fn cleaning_trims_everything_and_drops_duplicate_paths() {
        let clean = clean_sync_input(&ThreadSyncInput {
            summary: Some("  Done  ".into()),
            decisions: Some(vec![
                decision(" Keep it simple ", Some(&[" src/a.ts", "src/a.ts", "docs/"])),
                decision("No paths", None),
            ]),
            files: Some(vec!["b.ts ".into(), "b.ts".into()]),
            active_minutes: Some(12),
            ..ThreadSyncInput::default()
        })
        .unwrap();
        assert_eq!(
            clean,
            CleanSync {
                thread_url: None,
                summary: Some(Some("Done".into())),
                decisions: vec![
                    ("Keep it simple".into(), vec!["src/a.ts".into(), "docs/".into()]),
                    ("No paths".into(), vec![]),
                ],
                files: vec!["b.ts".into()],
                pull_request_url: None,
                active_minutes: Some(12),
                turns: None,
            }
        );
    }

    #[test]
    fn a_missing_summary_is_left_alone_and_an_empty_one_becomes_null() {
        assert_eq!(clean_sync_input(&ThreadSyncInput::default()).unwrap().summary, None);
        let blank = ThreadSyncInput { summary: Some("   ".into()), ..ThreadSyncInput::default() };
        assert_eq!(clean_sync_input(&blank).unwrap().summary, Some(None));
    }

    #[test]
    fn a_blank_decision_and_unsafe_paths_are_refused() {
        let refused = |input: ThreadSyncInput| {
            let error = clean_sync_input(&input).unwrap_err();
            assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);
            error.to_string()
        };
        assert_eq!(
            refused(ThreadSyncInput {
                decisions: Some(vec![decision("  ", None)]),
                ..ThreadSyncInput::default()
            }),
            "400 Bad Request: A decision needs text"
        );
        refused(ThreadSyncInput {
            files: Some(vec!["/etc/passwd".into()]),
            ..ThreadSyncInput::default()
        });
        refused(ThreadSyncInput {
            decisions: Some(vec![decision("x", Some(&["../x"]))]),
            ..ThreadSyncInput::default()
        });
    }
}
