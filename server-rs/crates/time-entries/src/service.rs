//! Database operations for a user's own time entries.

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use trama_auth::member_access::{current_access, project_hidden};
use trama_contracts::threads::TimeEntrySource;
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{issues, time_entries};

use crate::schemas::TimeEntry;

/// Optional project and issue association.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Target {
    /// Description, normalized to an empty string when absent.
    pub description: Option<String>,
    /// Project id.
    pub project_id: Option<String>,
    /// Issue id.
    pub issue_id: Option<String>,
}

/// A manually recorded time interval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualTimeEntry {
    /// Association and description.
    pub target: Target,
    /// Start.
    pub started_at: DateTime<Utc>,
    /// End.
    pub ended_at: DateTime<Utc>,
}

const END_BEFORE_START: &str = "The end must be after the start";
const NO_TIMER: &str = "No timer is running";
const NOT_SUGGESTED: &str = "Only a suggested entry can be accepted";

/// Returns up to 100 of the caller's own entries, hiding projects outside their access.
///
/// Suggestions (`source: suggested`) are not entries yet: they are listed only when asked for
/// with `source`, and `source` lists just that source.
///
/// # Errors
/// A database error.
pub async fn list(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    source: Option<TimeEntrySource>,
) -> Result<Vec<TimeEntry>, AppError> {
    let access = current_access();
    let by_source = match source {
        Some(source) => time_entries::Column::Source.eq(source.as_str()),
        None => time_entries::Column::Source.ne(TimeEntrySource::Suggested.as_str()),
    };
    let rows = time_entries::Entity::find()
        .filter(time_entries::Column::WorkspaceId.eq(workspace_id))
        .filter(time_entries::Column::UserId.eq(user_id))
        .filter(by_source)
        .order_by_desc(time_entries::Column::StartedAt)
        .limit(100)
        .all(&state.db)
        .await?;
    Ok(rows
        .iter()
        .filter(|row| {
            !row.project_id.as_deref().is_some_and(|id| project_hidden(access.as_deref(), Some(id)))
        })
        .map(TimeEntry::from)
        .collect())
}

/// Stops this user's running timer, then starts a new one.
///
/// # Errors
/// 400 for a description that is too long; 404 for an unavailable project or issue; otherwise
/// a database error.
pub async fn start(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    target: Target,
) -> Result<TimeEntry, AppError> {
    let (project_id, issue_id, description) = resolve_target(state, workspace_id, target).await?;
    let now = Utc::now().fixed_offset();
    for row in running(state, workspace_id, user_id).await? {
        let mut active: time_entries::ActiveModel = row.into();
        active.ended_at = Set(Some(now));
        active.updated_at = Set(now);
        active.update(&state.db).await?;
    }
    let row = time_entries::ActiveModel {
        id: Set(uid("te")),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        project_id: Set(project_id),
        issue_id: Set(issue_id),
        description: Set(description),
        source: Set("timer".into()),
        started_at: Set(now),
        ended_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&state.db)
    .await?;
    Ok(TimeEntry::from(&row))
}

/// Stops the caller's active timer.
///
/// # Errors
/// 400 `No timer is running`, or a database error.
pub async fn stop(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
) -> Result<TimeEntry, AppError> {
    let row = running(state, workspace_id, user_id)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::bad_request(NO_TIMER))?;
    let now = Utc::now().fixed_offset();
    if now < row.started_at {
        return Err(AppError::bad_request(END_BEFORE_START));
    }
    let mut active: time_entries::ActiveModel = row.into();
    active.ended_at = Set(Some(now));
    active.updated_at = Set(now);
    Ok(TimeEntry::from(&active.update(&state.db).await?))
}

/// Creates a manual time entry.
///
/// # Errors
/// 400 when the end is not after the start or the description is too long; 404 for an
/// unavailable project or issue; otherwise a database error.
pub async fn add(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    input: ManualTimeEntry,
) -> Result<TimeEntry, AppError> {
    if input.ended_at <= input.started_at {
        return Err(AppError::bad_request(END_BEFORE_START));
    }
    let (project_id, issue_id, description) =
        resolve_target(state, workspace_id, input.target).await?;
    let now = Utc::now().fixed_offset();
    let row = time_entries::ActiveModel {
        id: Set(uid("te")),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        project_id: Set(project_id),
        issue_id: Set(issue_id),
        description: Set(description),
        source: Set("manual".into()),
        started_at: Set(input.started_at.fixed_offset()),
        ended_at: Set(Some(input.ended_at.fixed_offset())),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&state.db)
    .await?;
    Ok(TimeEntry::from(&row))
}

/// Turns a suggestion of the caller (from `trama sync`) into a plain entry. Another person's
/// entry, and one in a project the caller cannot open, is not found.
///
/// # Errors
/// 404 when the entry is absent, owned by another user or hidden; 400
/// `Only a suggested entry can be accepted`; otherwise a database error.
pub async fn accept(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    id: &str,
) -> Result<TimeEntry, AppError> {
    let row = time_entries::Entity::find()
        .filter(time_entries::Column::Id.eq(id))
        .filter(time_entries::Column::WorkspaceId.eq(workspace_id))
        .one(&state.db)
        .await?
        .filter(|row| row.user_id == user_id)
        .ok_or_else(|| AppError::entity_not_found("Time entry", id))?;
    if row.project_id.is_some()
        && project_hidden(current_access().as_deref(), row.project_id.as_deref())
    {
        return Err(AppError::entity_not_found("Time entry", id));
    }
    if row.source != TimeEntrySource::Suggested.as_str() {
        return Err(AppError::bad_request(NOT_SUGGESTED));
    }
    let mut active: time_entries::ActiveModel = row.into();
    active.source = Set(TimeEntrySource::Manual.as_str().to_owned());
    active.updated_at = Set(Utc::now().fixed_offset());
    Ok(TimeEntry::from(&active.update(&state.db).await?))
}

/// The caller's open timers. A suggestion is always finished, so it never counts as one.
async fn running(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
) -> Result<Vec<time_entries::Model>, AppError> {
    Ok(time_entries::Entity::find()
        .filter(time_entries::Column::WorkspaceId.eq(workspace_id))
        .filter(time_entries::Column::UserId.eq(user_id))
        .filter(time_entries::Column::EndedAt.is_null())
        .filter(time_entries::Column::Source.ne(TimeEntrySource::Suggested.as_str()))
        .all(&state.db)
        .await?)
}

/// Deletes only a record owned by this user in this workspace; other people's records look absent.
///
/// # Errors
/// 404 when the entry is absent or belongs to another user; otherwise a database error.
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    id: &str,
) -> Result<(), AppError> {
    let row = time_entries::Entity::find()
        .filter(time_entries::Column::Id.eq(id))
        .filter(time_entries::Column::WorkspaceId.eq(workspace_id))
        .one(&state.db)
        .await?;
    if row.is_none_or(|row| row.user_id != user_id) {
        return Err(AppError::entity_not_found("Time entry", id));
    }
    time_entries::Entity::delete_many()
        .filter(time_entries::Column::Id.eq(id))
        .filter(time_entries::Column::WorkspaceId.eq(workspace_id))
        .filter(time_entries::Column::UserId.eq(user_id))
        .exec(&state.db)
        .await?;
    Ok(())
}

async fn resolve_target(
    state: &AppState,
    workspace_id: &str,
    target: Target,
) -> Result<(Option<String>, Option<String>, String), AppError> {
    let description = target.description.unwrap_or_default().trim().to_owned();
    if description.chars().count() > 500 {
        return Err(AppError::bad_request("Description is too long"));
    }
    let mut project_id = target.project_id;
    let issue_id = target.issue_id;
    if let Some(id) = project_id.as_deref() {
        trama_projects::service::get(&state.db, workspace_id, id).await?;
    }
    if let Some(id) = issue_id.as_deref() {
        let issue = issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::Id.eq(id))
            .one(&state.db)
            .await?
            .filter(|issue| {
                !project_hidden(current_access().as_deref(), issue.project_id.as_deref())
            })
            .ok_or_else(|| AppError::entity_not_found("Issue", id))?;
        if issue.project_id.is_some() && project_id.is_some() && issue.project_id != project_id {
            return Err(AppError::bad_request("That issue is not in the selected project"));
        }
        if project_id.is_none() {
            project_id = issue.project_id;
        }
    }
    Ok((project_id, issue_id, description))
}
