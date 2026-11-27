//! Written status updates of a project (`project-updates.service.ts`).
//!
//! Visibility follows the project: every function first reads the project through
//! [`crate::service::get`], so a project outside the request's access is a 404 before anything is
//! read or written. Like NestJS none of them opens a transaction: the row, the project's health
//! change and the event are separate statements.

use chrono::{DateTime, Utc};
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use serde_json::json;
use trama_auth::WorkspaceContext;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::js;
use trama_contracts::projects::{PROJECT_UPDATE_BODY_MAX, ProjectUpdate};
use trama_contracts::roles::Capability;
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::project_updates;
use trama_events::{Events, LiveChange, RecordEvent};
use trama_uploads::rules::same_actor;

use crate::service::{self, ProjectPatch};

/// How many updates `GET /projects/:id/updates` returns (the newest ones).
pub const PROJECT_UPDATES_LIST_MAX: u64 = 200;

/// How much of an update the `project.update_posted` event keeps (`excerpt`), in UTF-16 units.
const EXCERPT_UNITS: usize = 200;

/// Changes to an update: `None` leaves a field alone, `Some(None)` clears the health.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdatePatch {
    /// New text.
    pub body: Option<String>,
    /// New reported health (catalog id or legacy enum), or `Some(None)` to clear it.
    pub health: Option<Option<String>>,
}

/// Trimmed, 1 to [`PROJECT_UPDATE_BODY_MAX`] characters (`cleanBody`).
fn clean_body(value: &str) -> Result<String, AppError> {
    let body = js::trim(value);
    if body.is_empty() {
        return Err(AppError::bad_request("An update needs some text"));
    }
    if js::len(body) > PROJECT_UPDATE_BODY_MAX {
        return Err(AppError::bad_request(format!(
            "An update can have at most {PROJECT_UPDATE_BODY_MAX} characters"
        )));
    }
    Ok(body.to_owned())
}

/// The wire form of a stored update: `health` and `editedAt` are omitted when unset.
///
/// # Errors
///
/// A 500 when the stored author is not an actor (never written by this module).
pub fn present(row: &project_updates::Model) -> Result<ProjectUpdate, AppError> {
    Ok(ProjectUpdate {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        project_id: row.project_id.clone(),
        author: author_of(row)?,
        body: row.body.clone(),
        health: row.health.clone(),
        created_at: to_iso(&row.created_at),
        edited_at: row.edited_at.as_ref().map(to_iso),
    })
}

fn author_of(row: &project_updates::Model) -> Result<ActorRef, AppError> {
    serde_json::from_value(row.author.clone()).map_err(AppError::internal)
}

fn project_subject(project_id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Project, id: project_id.to_owned() }
}

/// `new Date()`: the current time in whole milliseconds.
fn now_millis() -> DateTimeWithTimeZone {
    let now = Utc::now();
    DateTime::from_timestamp_millis(now.timestamp_millis()).unwrap_or(now).fixed_offset()
}

async fn find<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    project_id: &str,
    update_id: &str,
) -> Result<project_updates::Model, AppError> {
    project_updates::Entity::find()
        .filter(project_updates::Column::WorkspaceId.eq(workspace_id))
        .filter(project_updates::Column::ProjectId.eq(project_id))
        .filter(project_updates::Column::Id.eq(update_id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Project update", update_id))
}

/// The updates of one project, newest first, at most [`PROJECT_UPDATES_LIST_MAX`].
///
/// # Errors
///
/// 404 when the project does not exist or is outside the request's access.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    project_id: &str,
) -> Result<Vec<ProjectUpdate>, AppError> {
    service::get(db, workspace_id, project_id).await?;
    project_updates::Entity::find()
        .filter(project_updates::Column::WorkspaceId.eq(workspace_id))
        .filter(project_updates::Column::ProjectId.eq(project_id))
        .order_by_desc(project_updates::Column::CreatedAt)
        .order_by_desc(project_updates::Column::Id)
        .limit(PROJECT_UPDATES_LIST_MAX)
        .all(db)
        .await?
        .iter()
        .map(present)
        .collect()
}

/// Posts an update and records `project.update_posted`. Reporting a health that differs from
/// the project's also sets the project's health, through [`service::update`] (which records the
/// usual `project.updated` and `project.health_changed` events).
///
/// # Errors
///
/// 404 when the project is not visible; 400 for an empty or over-long body or an unknown
/// health; else a database error.
pub async fn create(
    state: &AppState,
    ctx: &WorkspaceContext,
    project_id: &str,
    body: &str,
    health: Option<&str>,
) -> Result<ProjectUpdate, AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    let project = service::get(&state.db, workspace_id, project_id).await?;
    let body = clean_body(body)?;
    let health = match health {
        Some(health) => Some(service::resolve_health(&state.db, workspace_id, health).await?),
        None => None,
    };
    let row = project_updates::ActiveModel {
        id: Set(uid("pu")),
        workspace_id: Set(workspace_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        author: Set(serde_json::to_value(&ctx.actor).map_err(AppError::internal)?),
        body: Set(body.clone()),
        health: Set(health.clone()),
        edited_at: Set(None),
        ..Default::default()
    }
    .insert(&state.db)
    .await?;
    if let Some(next) = health.as_deref().filter(|next| project.health.as_deref() != Some(*next)) {
        let patch = ProjectPatch { health: Some(Some(next.to_owned())), ..ProjectPatch::default() };
        service::update(state, workspace_id, &ctx.actor, project_id, patch).await?;
    }
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(
                workspace_id,
                ctx.actor.clone(),
                "project.update_posted",
                project_subject(project_id),
            )
            .data(json!({
                "updateId": row.id,
                "excerpt": js::truncate(&body, EXCERPT_UNITS),
                "health": health,
            }))
            .live(LiveChange::created(LiveEventEntity::ProjectUpdate, &row.id)),
        )
        .await?;
    present(&row)
}

/// Edits the text and/or the reported health of an update; only its author may. The project's
/// own health is not touched: only posting an update sets it. An edit that changes nothing
/// returns the update as it is, without marking it edited.
///
/// # Errors
///
/// 404 for a project that is not visible or an update of another project; 403 `Only the author
/// can edit an update`; 400 for an empty or over-long body or an unknown health.
pub async fn update(
    state: &AppState,
    ctx: &WorkspaceContext,
    project_id: &str,
    update_id: &str,
    patch: UpdatePatch,
) -> Result<ProjectUpdate, AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    service::get(&state.db, workspace_id, project_id).await?;
    let row = find(&state.db, workspace_id, project_id, update_id).await?;
    if !same_actor(&author_of(&row)?, &ctx.actor) {
        return Err(AppError::forbidden("Only the author can edit an update"));
    }
    let mut next_body = None;
    if let Some(body) = patch.body.as_deref() {
        let body = clean_body(body)?;
        if body != row.body {
            next_body = Some(body);
        }
    }
    let mut next_health = None;
    if let Some(health) = patch.health {
        let health = match health {
            None => None,
            Some(health) => Some(service::resolve_health(&state.db, workspace_id, &health).await?),
        };
        if health != row.health {
            next_health = Some(health);
        }
    }
    if next_body.is_none() && next_health.is_none() {
        return present(&row);
    }
    let mut active = row.into_active_model();
    if let Some(body) = next_body {
        active.body = Set(body);
    }
    if let Some(health) = next_health {
        active.health = Set(health);
    }
    active.edited_at = Set(Some(now_millis()));
    let saved = active.update(&state.db).await?;
    Events::of(state).publish_with(
        workspace_id,
        LiveChange::updated(LiveEventEntity::ProjectUpdate, &saved.id),
        None,
        Some(project_subject(project_id).into()),
    );
    present(&saved)
}

/// The author, or anyone who can manage projects, removes an update.
///
/// # Errors
///
/// 404 for a project that is not visible or an update of another project; 403 `Only the author
/// or someone who manages projects can delete an update`.
pub async fn remove(
    state: &AppState,
    ctx: &WorkspaceContext,
    project_id: &str,
    update_id: &str,
) -> Result<(), AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    service::get(&state.db, workspace_id, project_id).await?;
    let row = find(&state.db, workspace_id, project_id, update_id).await?;
    if !same_actor(&author_of(&row)?, &ctx.actor) && !ctx.can_do(Capability::ManageProjects) {
        return Err(AppError::forbidden(
            "Only the author or someone who manages projects can delete an update",
        ));
    }
    project_updates::Entity::delete_by_id(row.id.as_str()).exec(&state.db).await?;
    Events::of(state).publish_with(
        workspace_id,
        LiveChange::deleted(LiveEventEntity::ProjectUpdate, &row.id),
        None,
        Some(project_subject(project_id).into()),
    );
    Ok(())
}
