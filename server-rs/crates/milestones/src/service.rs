//! Milestones: listing, reading, creating, editing, reordering and deleting
//! (`milestones.service.ts`).
//!
//! The functions read the request's member access from the `trama_auth` task-local, as the
//! NestJS service does, so a narrowed member only reaches the milestones of their projects.
//! Outside a request (the importers, the snapshot) there is none and nothing is hidden.
//! [`list`] is what the workspace snapshot embeds and [`create`] what the importers call.

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Set, Statement, TransactionTrait,
};
use serde_json::json;
use trama_auth::member_access::project_hidden;
use trama_auth::member_access::{apply_project_scope, assert_can_use_project, current_access};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::projects::Milestone;
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{milestones, projects};
use trama_events::{Events, LiveChange, RecordEvent};

/// A milestone to create.
#[derive(Clone, Debug, PartialEq)]
pub struct NewMilestone {
    /// Project it belongs to; must be in the workspace.
    pub project_id: String,
    /// Display name (trimmed when stored).
    pub name: String,
    /// Description (trimmed; blank is stored as none).
    pub description: Option<String>,
    /// Target date.
    pub target_date: Option<DateTime<Utc>>,
    /// Position inside the project; after the last milestone when absent.
    pub sort_order: Option<f64>,
}

/// Changes to a milestone; `None` leaves a field alone, `Some(None)` clears `description` and
/// `target_date`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MilestonePatch {
    /// New name.
    pub name: Option<String>,
    /// New description, or `Some(None)` to clear it.
    pub description: Option<Option<String>>,
    /// New target date, or `Some(None)` to clear it.
    pub target_date: Option<Option<DateTime<Utc>>>,
    /// New position.
    pub sort_order: Option<f64>,
}

/// The wire form of a stored milestone.
#[must_use]
pub fn present(row: &milestones::Model) -> Milestone {
    Milestone {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        project_id: row.project_id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        target_date: row.target_date.as_ref().map(to_iso),
        sort_order: row.sort_order,
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
    }
}

/// `String.prototype.trim`.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Milestone, id: id.to_owned() }
}

fn now() -> sea_orm::prelude::DateTimeWithTimeZone {
    Utc::now().fixed_offset()
}

/// A workspace's milestones ordered by project, then position, then age; with `project_id` only
/// that project's. The request's project access applies.
///
/// # Errors
///
/// A database error.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<Vec<Milestone>, AppError> {
    let mut query =
        milestones::Entity::find().filter(milestones::Column::WorkspaceId.eq(workspace_id));
    if let Some(project) = project_id.filter(|p| !p.is_empty()) {
        query = query.filter(milestones::Column::ProjectId.eq(project));
    }
    let rows = apply_project_scope(query, milestones::Column::ProjectId)
        .order_by_asc(milestones::Column::ProjectId)
        .order_by_asc(milestones::Column::SortOrder)
        .order_by_asc(milestones::Column::CreatedAt)
        .order_by_asc(milestones::Column::Id)
        .all(db)
        .await?;
    Ok(rows.iter().map(present).collect())
}

/// The stored row, or 404 when it does not exist or its project is outside the request's access.
async fn find<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<milestones::Model, AppError> {
    let row = milestones::Entity::find()
        .filter(milestones::Column::WorkspaceId.eq(workspace_id))
        .filter(milestones::Column::Id.eq(id))
        .one(db)
        .await?;
    row.filter(|row| !project_hidden(current_access().as_deref(), Some(&row.project_id)))
        .ok_or_else(|| AppError::entity_not_found("Milestone", id))
}

/// One milestone.
///
/// # Errors
///
/// 404 `Milestone "<id>" not found` when it does not exist or is outside the request's project
/// access.
pub async fn get<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<Milestone, AppError> {
    find(db, workspace_id, id).await.map(|row| present(&row))
}

/// Creates a milestone and records `milestone.created`.
///
/// # Errors
///
/// 403 when the project is outside the request's access, 400 `Unknown project "<id>"` when it
/// is not in the workspace, or a database error.
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    input: NewMilestone,
) -> Result<Milestone, AppError> {
    assert_can_use_project(Some(&input.project_id))?;
    let project_exists = projects::Entity::find()
        .filter(projects::Column::Id.eq(input.project_id.as_str()))
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .count(&state.db)
        .await?
        > 0;
    if !project_exists {
        return Err(AppError::bad_request(format!("Unknown project \"{}\"", input.project_id)));
    }
    let sort_order = if let Some(order) = input.sort_order {
        order
    } else {
        let max: Option<Option<f64>> = milestones::Entity::find()
            .select_only()
            .column_as(Expr::col(milestones::Column::SortOrder).max(), "max")
            .filter(milestones::Column::WorkspaceId.eq(workspace_id))
            .filter(milestones::Column::ProjectId.eq(input.project_id.as_str()))
            .into_tuple()
            .one(&state.db)
            .await?;
        max.flatten().map_or(0.0, |max| max + 1.0)
    };
    let at = now();
    let row = milestones::ActiveModel {
        id: Set(uid("ms")),
        workspace_id: Set(workspace_id.to_owned()),
        project_id: Set(input.project_id),
        name: Set(js_trim(&input.name).to_owned()),
        description: Set(input
            .description
            .as_deref()
            .map(js_trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)),
        target_date: Set(input.target_date.map(|d| d.fixed_offset())),
        sort_order: Set(sort_order),
        created_at: Set(at),
        updated_at: Set(at),
    }
    .insert(&state.db)
    .await?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "milestone.created", subject(&row.id))
                .data(json!({ "name": row.name, "projectId": row.project_id })),
        )
        .await?;
    Ok(present(&row))
}

/// Edits a milestone. Records `milestone.updated` with the changed fields, or nothing when no
/// field changed.
///
/// # Errors
///
/// 404 when the milestone does not exist or is outside the request's access, or a database
/// error.
pub async fn update(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
    patch: MilestonePatch,
) -> Result<Milestone, AppError> {
    let row = find(&state.db, workspace_id, id).await?;
    let mut fields: Vec<&str> = Vec::new();
    let mut changes = milestones::ActiveModel { id: Set(row.id.clone()), ..Default::default() };
    if let Some(name) = &patch.name {
        let name = js_trim(name);
        if name != row.name {
            changes.name = Set(name.to_owned());
            fields.push("name");
        }
    }
    if let Some(description) = &patch.description {
        let description = description.as_deref().map(js_trim).filter(|d| !d.is_empty());
        if description != row.description.as_deref() {
            changes.description = Set(description.map(str::to_owned));
            fields.push("description");
        }
    }
    if let Some(target_date) = &patch.target_date {
        // compared as JSON does: by the millisecond
        let stored = row.target_date.as_ref().map(to_iso);
        if target_date.as_ref().map(to_iso) != stored {
            changes.target_date = Set(target_date.map(|d| d.fixed_offset()));
            fields.push("targetDate");
        }
    }
    // exact comparison, as `JSON.stringify` compares numbers
    #[allow(clippy::float_cmp)]
    let sort_order_changed = patch.sort_order.is_some_and(|order| order != row.sort_order);
    if let Some(sort_order) = patch.sort_order.filter(|_| sort_order_changed) {
        changes.sort_order = Set(sort_order);
        fields.push("sortOrder");
    }
    if fields.is_empty() {
        return Ok(present(&row));
    }
    changes.updated_at = Set(now());
    let saved = changes.update(&state.db).await?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "milestone.updated", subject(id)).data(
                json!({ "name": saved.name, "projectId": saved.project_id, "fields": fields }),
            ),
        )
        .await?;
    Ok(present(&saved))
}

/// Assigns `sortOrder` 0..n-1 to a project's milestones following `ids` (the others keep their
/// relative order after the listed ones). Records `milestone.updated` for every milestone that
/// moved and returns the project's milestones in the new order.
///
/// # Errors
///
/// 400 `ids must be distinct milestones of the project`, or a database error.
pub async fn reorder(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    project_id: &str,
    ids: &[String],
) -> Result<Vec<Milestone>, AppError> {
    let rows = milestones::Entity::find()
        .filter(milestones::Column::WorkspaceId.eq(workspace_id))
        .filter(milestones::Column::ProjectId.eq(project_id))
        .order_by_asc(milestones::Column::SortOrder)
        .order_by_asc(milestones::Column::CreatedAt)
        .order_by_asc(milestones::Column::Id)
        .all(&state.db)
        .await?;
    let by_id: HashMap<&str, &milestones::Model> =
        rows.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut seen = std::collections::HashSet::new();
    if !ids.iter().all(|id| seen.insert(id.as_str()))
        || ids.iter().any(|id| !by_id.contains_key(id.as_str()))
    {
        return Err(AppError::bad_request("ids must be distinct milestones of the project"));
    }
    let listed = ids.iter().filter_map(|id| by_id.get(id.as_str()).copied());
    let rest = rows.iter().filter(|r| !seen.contains(r.id.as_str())).collect::<Vec<_>>();
    let mut ordered: Vec<&milestones::Model> = listed.collect();
    ordered.extend(rest);
    let at = now();
    let mut moved = Vec::new();
    for (index, row) in ordered.iter().enumerate() {
        #[allow(clippy::cast_precision_loss)] // at most a few hundred milestones
        let position = index as f64;
        if row.sort_order.partial_cmp(&position) != Some(Ordering::Equal) {
            moved.push(((*row).clone(), position));
        }
    }
    if !moved.is_empty() {
        let txn = state.db.begin().await?;
        for (row, position) in &moved {
            milestones::ActiveModel {
                id: Set(row.id.clone()),
                sort_order: Set(*position),
                updated_at: Set(at),
                ..Default::default()
            }
            .update(&txn)
            .await?;
        }
        txn.commit().await?;
    }
    let events = Events::of(state);
    for (row, _) in &moved {
        events
            .record(
                &state.db,
                RecordEvent::new(
                    workspace_id,
                    actor.clone(),
                    "milestone.updated",
                    subject(&row.id),
                )
                .data(json!({
                    "name": row.name,
                    "projectId": project_id,
                    "fields": ["sortOrder"],
                })),
            )
            .await?;
    }
    list(&state.db, workspace_id, Some(project_id)).await
}

/// Deletes a milestone: removes it from the issues that were in it, deletes its comments and
/// records `milestone.deleted`; the issues that changed are announced on the live stream.
///
/// # Errors
///
/// 404 when the milestone does not exist or is outside the request's access, or a database
/// error.
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
) -> Result<(), AppError> {
    let row = find(&state.db, workspace_id, id).await?;
    let txn = state.db.begin().await?;
    let statement = |sql: &str| {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [workspace_id.to_owned().into(), id.to_owned().into()],
        )
    };
    let affected = txn
        .query_all_raw(statement(
            r#"SELECT "id" FROM "issues" WHERE "workspaceId" = $1 AND jsonb_exists("milestoneIds", $2::text)"#,
        ))
        .await?
        .iter()
        .map(|r| r.try_get::<String>("", "id"))
        .collect::<Result<Vec<_>, _>>()?;
    txn.execute_raw(statement(
        r#"UPDATE "issues" SET "milestoneIds" = "milestoneIds" - $2::text WHERE "workspaceId" = $1 AND jsonb_exists("milestoneIds", $2::text)"#,
    ))
    .await?;
    txn.execute_raw(statement(
        r#"DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2"#,
    ))
    .await?;
    milestones::Entity::delete_by_id(id).exec(&txn).await?;
    txn.commit().await?;
    let events = Events::of(state);
    events
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "milestone.deleted", subject(id))
                .data(json!({ "name": row.name, "projectId": row.project_id })),
        )
        .await?;
    // issues that were in the milestone changed too: let other tabs refetch them
    for issue in affected.iter().take(200) {
        events.publish(workspace_id, LiveChange::updated(LiveEventEntity::Issue, issue));
    }
    Ok(())
}
