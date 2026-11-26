//! Attention items: derived from the visible issues' artifacts, with the caller's own dismissals
//! and snoozes on top (`attention.service.ts`).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set};
use trama_auth::member_access::{can_view, current_access, project_hidden};
use trama_contracts::access::MemberResource;
use trama_contracts::activity::{AttentionItem, AttentionKind, AttentionSeverity, AttentionState};
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_entities::{artifacts, attention_state, issues};
use trama_events::js_date::parse_js_date;

/// Message of the 404 for an item that is not (or no longer) in the caller's list.
pub const ITEM_NOT_FOUND: &str = "Attention item not found";

/// Message of the 400 for a snooze that is not in the future.
pub const SNOOZE_NOT_FUTURE: &str = "snoozedUntil must be a future date";

/// Rows the workspace snapshot has already loaded, so `list` does not read them again.
#[derive(Clone, Copy, Debug)]
pub struct SnapshotRows<'a> {
    /// Every issue of the workspace.
    pub issues: &'a [issues::Model],
    /// Every artifact of the workspace.
    pub artifacts: &'a [artifacts::Model],
}

/// The caller's attention items, most severe first and oldest first within a severity
/// (`AttentionService.list`).
///
/// Nothing is derived for a caller who cannot view issues; a caller who cannot view artifacts
/// gets none from artifacts. Issues of projects outside the request's member access are left
/// out, and their artifacts with them. Pass the snapshot's `rows` to skip the queries.
///
/// # Errors
///
/// Database errors.
pub async fn list(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    rows: Option<SnapshotRows<'_>>,
) -> Result<Vec<AttentionItem>, AppError> {
    let access = current_access();
    if !can_view(MemberResource::Issues, access.as_deref()) {
        return Ok(Vec::new());
    }

    let loaded_issues;
    let issue_rows = if let Some(rows) = rows {
        rows.issues
    } else {
        loaded_issues = issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .all(db)
            .await?;
        &loaded_issues
    };
    let visible: HashMap<&str, &issues::Model> = issue_rows
        .iter()
        .filter(|issue| !project_hidden(access.as_deref(), issue.project_id.as_deref()))
        .map(|issue| (issue.id.as_str(), issue))
        .collect();
    if visible.is_empty() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    if can_view(MemberResource::Artifacts, access.as_deref()) {
        let loaded_artifacts;
        let artifact_rows = if let Some(rows) = rows {
            rows.artifacts
        } else {
            // only the artifacts of visible issues matter; the filter below drops the rest
            loaded_artifacts = artifacts::Entity::find()
                .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
                .filter(artifacts::Column::IssueId.is_not_null())
                .filter(
                    sea_orm::Condition::any()
                        .add(artifacts::Column::Review.eq("requested"))
                        .add(artifacts::Column::Ci.eq("failing")),
                )
                .order_by_asc(artifacts::Column::Id)
                .all(db)
                .await?;
            &loaded_artifacts
        };
        for artifact in artifact_rows {
            let Some(issue) = artifact.issue_id.as_deref().and_then(|id| visible.get(id)) else {
                continue;
            };
            if artifact.review.as_deref() == Some("requested") {
                items.push(artifact_item(
                    AttentionKind::ReviewRequested,
                    artifact,
                    issue,
                    "Review requested",
                ));
            }
            if artifact.ci.as_deref() == Some("failing") {
                items.push(artifact_item(AttentionKind::CiFailed, artifact, issue, "CI failing"));
            }
        }
    }
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let saved: HashMap<String, attention_state::Model> = attention_state::Entity::find()
        .filter(attention_state::Column::WorkspaceId.eq(workspace_id))
        .filter(attention_state::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|state| (state.item_id.clone(), state))
        .collect();
    let now = Utc::now();
    let mut items: Vec<(AttentionItem, i64)> = items
        .into_iter()
        .map(|(item, since)| {
            let saved = saved.get(&item.id);
            (with_saved_state(item, since, saved, now), since)
        })
        .collect();
    items.sort_by_key(|(item, since)| (severity_rank(item.severity), *since));
    Ok(items.into_iter().map(|(item, _)| item).collect())
}

/// Dismisses one of the caller's items (`dismiss`).
///
/// # Errors
///
/// 404 `Attention item not found` when it is not in the caller's list.
pub async fn dismiss(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    item_id: &str,
) -> Result<(), AppError> {
    let item = find_item(db, workspace_id, user_id, item_id).await?;
    save_state(db, workspace_id, user_id, &item, AttentionState::Dismissed, None).await
}

/// Hides one of the caller's items until `until` (`snooze`).
///
/// # Errors
///
/// 400 `snoozedUntil must be a future date` when `until` is not a date or is not in the future;
/// 404 `Attention item not found` when it is not in the caller's list.
pub async fn snooze(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    item_id: &str,
    until: &str,
) -> Result<(), AppError> {
    let until = parse_js_date(until)
        .filter(|at| *at > Utc::now())
        .ok_or_else(|| AppError::bad_request(SNOOZE_NOT_FUTURE))?;
    let item = find_item(db, workspace_id, user_id, item_id).await?;
    save_state(db, workspace_id, user_id, &item, AttentionState::Snoozed, Some(until)).await
}

/// Forgets the caller's dismissal or snooze of an item and returns it open (`restore`).
///
/// # Errors
///
/// 404 `Attention item not found` when it is not in the caller's list.
pub async fn restore(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    item_id: &str,
) -> Result<AttentionItem, AppError> {
    let item = find_item(db, workspace_id, user_id, item_id).await?;
    attention_state::Entity::delete_many()
        .filter(attention_state::Column::WorkspaceId.eq(workspace_id))
        .filter(attention_state::Column::UserId.eq(user_id))
        .filter(attention_state::Column::ItemId.eq(item_id))
        .exec(db)
        .await?;
    Ok(AttentionItem { state: AttentionState::Open, snoozed_until: None, ..item })
}

async fn find_item(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    item_id: &str,
) -> Result<AttentionItem, AppError> {
    list(db, workspace_id, user_id, None)
        .await?
        .into_iter()
        .find(|candidate| candidate.id == item_id)
        .ok_or_else(|| AppError::not_found(ITEM_NOT_FOUND))
}

fn severity_rank(severity: AttentionSeverity) -> u8 {
    match severity {
        AttentionSeverity::High => 0,
        AttentionSeverity::Medium => 1,
        AttentionSeverity::Low => 2,
    }
}

/// The item and its `since` in milliseconds (what a saved state is compared with).
fn artifact_item(
    kind: AttentionKind,
    artifact: &artifacts::Model,
    issue: &issues::Model,
    message: &str,
) -> (AttentionItem, i64) {
    let item = AttentionItem {
        id: format!("{kind}:{}", artifact.id),
        kind,
        severity: if kind == AttentionKind::CiFailed {
            AttentionSeverity::High
        } else {
            AttentionSeverity::Medium
        },
        title: artifact.title.clone(),
        detail: format!("{message} on {}: {}", issue.key, issue.title),
        artifact_id: Some(artifact.id.clone()),
        issue_id: Some(issue.id.clone()),
        since: to_iso(&artifact.updated_at),
        state: AttentionState::Open,
        snoozed_until: None,
    };
    (item, artifact.updated_at.timestamp_millis())
}

/// A saved state only counts while the condition it was made for is still the same one
/// (`since` unchanged) and, for a snooze, until it expires.
fn with_saved_state(
    item: AttentionItem,
    since: i64,
    saved: Option<&attention_state::Model>,
    now: DateTime<Utc>,
) -> AttentionItem {
    let Some(state) = saved else { return item };
    if state.since.timestamp_millis() != since {
        return item;
    }
    if state.state == AttentionState::Snoozed.as_str()
        && state.snoozed_until.is_some_and(|until| until <= now)
    {
        return item;
    }
    let Some(parsed) = AttentionState::parse(&state.state) else { return item };
    AttentionItem { state: parsed, snoozed_until: state.snoozed_until.as_ref().map(to_iso), ..item }
}

async fn save_state(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    item: &AttentionItem,
    state: AttentionState,
    snoozed_until: Option<DateTime<Utc>>,
) -> Result<(), AppError> {
    let since = parse_js_date(&item.since).unwrap_or_else(Utc::now);
    attention_state::Entity::insert(attention_state::ActiveModel {
        user_id: Set(user_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        item_id: Set(item.id.clone()),
        state: Set(state.as_str().to_owned()),
        snoozed_until: Set(snoozed_until.map(|at| at.fixed_offset())),
        since: Set(since.fixed_offset()),
    })
    .on_conflict(
        OnConflict::columns([
            attention_state::Column::UserId,
            attention_state::Column::WorkspaceId,
            attention_state::Column::ItemId,
        ])
        .update_columns([
            attention_state::Column::State,
            attention_state::Column::SnoozedUntil,
            attention_state::Column::Since,
        ])
        .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}
