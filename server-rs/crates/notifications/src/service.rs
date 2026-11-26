//! Reading notifications, marking them read and the per-person settings: the non-producing half
//! of `NotificationsService`.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use trama_auth::member_access::project_hidden;
use trama_contracts::access::{MemberAccess, is_project_limited};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::identity::{
    NOTIFICATION_KINDS, NotificationKind, NotificationSettings, resolve_notification_settings,
};
use trama_core::AppError;
use trama_entities::{artifacts, issues, notifications, users};
use trama_events::{Events, LiveChange};

use crate::schemas::{ChannelPatch, NotificationListView, NotificationView, SettingsView};

/// How many recent notifications a project-limited person's inbox is cut from.
const LIMITED_WINDOW: u64 = 500;
/// The default page size.
const DEFAULT_LIMIT: i64 = 50;
/// The largest page.
const MAX_LIMIT: i64 = 200;

/// `{ limit, unreadOnly }` of [`list`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListOptions {
    /// Page size, clamped to 1..=200 (default 50).
    pub limit: Option<i64>,
    /// Only unread notifications.
    pub unread_only: bool,
}

fn recent(
    workspace_id: &str,
    user_id: &str,
    unread_only: bool,
) -> sea_orm::Select<notifications::Entity> {
    let mut query = notifications::Entity::find()
        .filter(notifications::Column::WorkspaceId.eq(workspace_id))
        .filter(notifications::Column::UserId.eq(user_id));
    if unread_only {
        query = query.filter(notifications::Column::ReadAt.is_null());
    }
    query.order_by_desc(notifications::Column::CreatedAt).order_by_desc(notifications::Column::Id)
}

async fn count_unread<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    user_id: &str,
) -> Result<i64, DbErr> {
    let count = notifications::Entity::find()
        .filter(notifications::Column::WorkspaceId.eq(workspace_id))
        .filter(notifications::Column::UserId.eq(user_id))
        .filter(notifications::Column::ReadAt.is_null())
        .count(db)
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// The caller's notifications in a workspace, newest first, and how many are unread.
///
/// Someone limited to some projects only keeps the notifications of those projects (access can
/// shrink later): the page is cut from their 500 most recent, and `unread` counts the openable
/// ones among their 500 most recent unread.
///
/// # Errors
///
/// Database errors.
pub async fn list(
    db: &DatabaseConnection,
    workspace_id: &str,
    user_id: &str,
    access: Option<&MemberAccess>,
    opts: ListOptions,
) -> Result<NotificationListView, DbErr> {
    let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let take = u64::try_from(limit).unwrap_or(1);
    let (rows, unread) = if let Some(access) = access.filter(|a| is_project_limited(Some(a))) {
        let rows =
            recent(workspace_id, user_id, opts.unread_only).limit(LIMITED_WINDOW).all(db).await?;
        let visible = openable(db, workspace_id, rows, access).await?;
        let unread = if opts.unread_only {
            visible.len()
        } else {
            let unread_rows =
                recent(workspace_id, user_id, true).limit(LIMITED_WINDOW).all(db).await?;
            openable(db, workspace_id, unread_rows, access).await?.len()
        };
        let items = visible.into_iter().take(usize::try_from(take).unwrap_or(1)).collect();
        (items, i64::try_from(unread).unwrap_or(i64::MAX))
    } else {
        let rows = recent(workspace_id, user_id, opts.unread_only).limit(take).all(db).await?;
        (rows, count_unread(db, workspace_id, user_id).await?)
    };
    let items = rows
        .into_iter()
        .map(|row| {
            let mut view = NotificationView::from(row);
            // the retired Workstream updater linked to a page that no longer exists
            if view.kind == "workstream_update" {
                "tasks".clone_into(&mut view.link);
            }
            view
        })
        .collect();
    Ok(NotificationListView { items, unread })
}

/// The notifications about a project, task or artifact the access can open. Anything else is
/// dropped.
async fn openable(
    db: &DatabaseConnection,
    workspace_id: &str,
    rows: Vec<notifications::Model>,
    access: &MemberAccess,
) -> Result<Vec<notifications::Model>, DbErr> {
    let subject_of = |row: &notifications::Model| {
        (
            row.subject.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_owned(),
            row.subject.get("id").and_then(|t| t.as_str()).unwrap_or_default().to_owned(),
        )
    };
    let ids_of = |kind: &str| -> Vec<String> {
        let mut seen = HashSet::new();
        rows.iter()
            .map(subject_of)
            .filter(|(k, _)| k == kind)
            .map(|(_, id)| id)
            .filter(|id| seen.insert(id.clone()))
            .collect()
    };
    let artifact_ids = ids_of("artifact");
    let artifacts: Vec<(String, Option<String>)> = if artifact_ids.is_empty() {
        Vec::new()
    } else {
        artifacts::Entity::find()
            .select_only()
            .column(artifacts::Column::Id)
            .column(artifacts::Column::IssueId)
            .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
            .filter(artifacts::Column::Id.is_in(artifact_ids))
            .into_tuple()
            .all(db)
            .await?
    };
    let mut issue_ids = ids_of("issue");
    for issue_id in artifacts.iter().filter_map(|(_, issue)| issue.as_ref()) {
        if !issue_ids.contains(issue_id) {
            issue_ids.push(issue_id.clone());
        }
    }
    let issues: Vec<(String, Option<String>)> = if issue_ids.is_empty() {
        Vec::new()
    } else {
        issues::Entity::find()
            .select_only()
            .column(issues::Column::Id)
            .column(issues::Column::ProjectId)
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::Id.is_in(issue_ids))
            .into_tuple()
            .all(db)
            .await?
    };
    let project_of_issue: HashMap<String, Option<String>> = issues.into_iter().collect();
    let issue_of_artifact: HashMap<String, Option<String>> = artifacts.into_iter().collect();
    Ok(rows
        .into_iter()
        .filter(|row| {
            let (kind, id) = subject_of(row);
            if kind == "project" {
                return !project_hidden(Some(access), Some(&id));
            }
            let issue_id = match kind.as_str() {
                "issue" => Some(id),
                "artifact" => issue_of_artifact.get(&id).cloned().flatten(),
                _ => None,
            };
            let Some(issue_id) = issue_id.filter(|id| !id.is_empty()) else { return false };
            let Some(project) = project_of_issue.get(&issue_id) else { return false };
            !project_hidden(Some(access), project.as_deref())
        })
        .collect())
}

/// Marks some (or, without ids, all) of the caller's notifications in this workspace as read and
/// tells their other tabs. Returns how many are still unread.
///
/// # Errors
///
/// Database errors.
pub async fn mark_read(
    db: &DatabaseConnection,
    events: &Events,
    workspace_id: &str,
    user_id: &str,
    ids: Option<&[String]>,
) -> Result<i64, DbErr> {
    // `In([])` matches nothing
    if ids.is_none_or(|ids| !ids.is_empty()) {
        let mut update = notifications::Entity::update_many()
            .col_expr(notifications::Column::ReadAt, Expr::value(Utc::now().fixed_offset()))
            .filter(notifications::Column::WorkspaceId.eq(workspace_id))
            .filter(notifications::Column::UserId.eq(user_id))
            .filter(notifications::Column::ReadAt.is_null());
        if let Some(ids) = ids {
            update = update.filter(notifications::Column::Id.is_in(ids.iter().cloned()));
        }
        update.exec(db).await?;
    }
    events.publish_to_user(
        workspace_id,
        LiveChange::updated(LiveEventEntity::Notification, "read"),
        user_id,
    );
    count_unread(db, workspace_id, user_id).await
}

// ───────────────────────────── settings ─────────────────────────────

async fn find_user(db: &DatabaseConnection, user_id: &str) -> Result<users::Model, AppError> {
    users::Entity::find_by_id(user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::not_found("Could not find any entity of type \"UserEntity\""))
}

/// The person's settings with the defaults applied, and whether the server sends email at all.
///
/// # Errors
///
/// Database errors.
pub async fn get_settings(
    db: &DatabaseConnection,
    email_available: bool,
    user_id: &str,
) -> Result<SettingsView, AppError> {
    let user = find_user(db, user_id).await?;
    Ok(SettingsView {
        settings: resolve_notification_settings(Some(&user.notification_settings)),
        email_available,
    })
}

/// Applies a validated patch to the person's settings.
///
/// # Errors
///
/// Database errors.
pub async fn update_settings(
    db: &DatabaseConnection,
    email_available: bool,
    user_id: &str,
    patch: &[(NotificationKind, ChannelPatch)],
) -> Result<SettingsView, AppError> {
    let user = find_user(db, user_id).await?;
    let mut next = resolve_notification_settings(Some(&user.notification_settings));
    for kind in NOTIFICATION_KINDS {
        let Some((_, change)) = patch.iter().rev().find(|(k, _)| k == kind) else { continue };
        let channels = match kind {
            NotificationKind::Assigned => &mut next.assigned,
            NotificationKind::ReviewRequested => &mut next.review_requested,
            NotificationKind::CiFailed => &mut next.ci_failed,
            NotificationKind::Comment => &mut next.comment,
        };
        if let Some(v) = change.in_app {
            channels.in_app = v;
        }
        if let Some(v) = change.email {
            channels.email = v;
        }
        if let Some(v) = change.push {
            channels.push = v;
        }
    }
    users::ActiveModel {
        id: sea_orm::ActiveValue::Unchanged(user.id),
        notification_settings: Set(settings_json(&next)),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(SettingsView { settings: next, email_available })
}

fn settings_json(settings: &NotificationSettings) -> serde_json::Value {
    serde_json::to_value(settings).unwrap_or_default()
}
