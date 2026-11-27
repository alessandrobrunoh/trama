//! "Shared with me" and "Show in" (`server/src/sharing/sharing.service.ts`).
//!
//! A project is shared with a person when they belong to its workspace through a membership
//! limited to some projects (a guest). The project never leaves its workspace: a placement is a
//! per-person link, it grants nobody anything, and every read of the project still goes through
//! the original workspace's permission checks. A placement whose person lost their access stops
//! being listed.

use std::collections::HashMap;

use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde_json::{Value, json};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::identity::stored_member_access;
use trama_contracts::projects::{ProjectPlacement, SharedProject, WorkspaceRef};
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{memberships, project_placements, projects, workspaces};
use trama_events::{Events, LiveChange};

use crate::plan::limited_project_ids;

/// Workspaces where the person is limited to some projects, with the projects they can really
/// see.
struct GuestRows {
    workspace: workspaces::Model,
    role: String,
    projects: Vec<projects::Model>,
}

/// Every project the person reaches as a guest, with where (if anywhere) they chose to show it.
///
/// # Errors
///
/// The database error.
pub async fn list<C: ConnectionTrait>(db: &C, user_id: &str) -> Result<Vec<SharedProject>, DbErr> {
    let rows = guest_rows(db, user_id).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let placements: HashMap<String, project_placements::Model> = project_placements::Entity::find()
        .filter(project_placements::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.project_id.clone(), row))
        .collect();
    let mut out = Vec::new();
    for GuestRows { workspace, role, projects } in rows {
        for project in projects {
            let placement = placements.get(&project.id).map(to_placement);
            out.push(SharedProject {
                id: project.id,
                name: project.name,
                key: project.key,
                color: project.color,
                icon: project.icon.filter(|icon| !icon.is_empty()),
                workspace: WorkspaceRef {
                    id: workspace.id.clone(),
                    slug: workspace.slug.clone(),
                    name: workspace.name.clone(),
                },
                role: role.clone(),
                placement,
            });
        }
    }
    Ok(out)
}

/// Show a shared project in one of the person's own workspaces (or move it between them).
///
/// # Errors
///
/// 404 when the project is not shared with the person or the workspace is not theirs; 400 when
/// the project already lives in that workspace.
pub async fn place<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
    workspace_id: &str,
    position: Option<i32>,
) -> Result<ProjectPlacement, AppError> {
    let shared = shared_project(db, user_id, project_id).await?;
    if shared.workspace.id == workspace_id {
        return Err(AppError::bad_request("The project already lives in that workspace"));
    }
    // a person can only place it in a workspace they belong to; anything else looks like it
    // does not exist
    let member = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .filter(memberships::Column::UserId.eq(user_id))
        .count(db)
        .await?;
    if member == 0 {
        return Err(AppError::entity_not_found("Workspace", workspace_id));
    }
    let next = match position {
        Some(position) => position,
        None => next_position(db, user_id, workspace_id).await?,
    };
    Ok(save(db, user_id, project_id, Some(workspace_id), next).await?)
}

/// "Hide from Shared with me": the project is listed nowhere until the placement is cleared.
///
/// # Errors
///
/// 404 when the project is not shared with the person.
pub async fn hide<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
) -> Result<ProjectPlacement, AppError> {
    shared_project(db, user_id, project_id).await?;
    Ok(save(db, user_id, project_id, None, 0).await?)
}

/// Back to Shared with me. Only ever touches the caller's own row.
///
/// # Errors
///
/// The database error.
pub async fn clear<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
) -> Result<(), DbErr> {
    delete_placement(db, user_id, project_id).await
}

/// Leave the project: the person's guest access to it is removed from the workspace's
/// membership. A guest left with nothing loses the membership altogether. Their own placement
/// goes with it.
///
/// # Errors
///
/// 404 when the project is not shared with the person.
pub async fn leave(state: &AppState, user_id: &str, project_id: &str) -> Result<(), AppError> {
    let db = &state.db;
    let shared = shared_project(db, user_id, project_id).await?;
    let membership = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(shared.workspace.id.as_str()))
        .filter(memberships::Column::UserId.eq(user_id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Project", project_id))?;
    let events = Events::of(state);
    if let Some(access) = stored_member_access(membership.access.as_ref()) {
        let remaining: Vec<String> =
            access.projects.project_ids.iter().filter(|id| *id != project_id).cloned().collect();
        if membership.role == "guest" && remaining.is_empty() && !access.include_unassigned {
            memberships::Entity::delete_by_id(membership.id.as_str()).exec(db).await?;
            events.publish(
                &shared.workspace.id,
                LiveChange::deleted(LiveEventEntity::Membership, &membership.id),
            );
        } else {
            let raw = membership.access.clone().unwrap_or(Value::Null);
            memberships::ActiveModel {
                id: Set(membership.id.clone()),
                access: Set(Some(with_projects(&raw, &remaining))),
                ..Default::default()
            }
            .update(db)
            .await?;
            events.publish(
                &shared.workspace.id,
                LiveChange::updated(LiveEventEntity::Membership, &membership.id),
            );
        }
    }
    delete_placement(db, user_id, project_id).await?;
    Ok(())
}

/// `access` with its project list replaced by exactly `project_ids` (`{ ...access, projects: {
/// all: false, projectIds } }`); every other key is kept as stored.
pub(crate) fn with_projects(access: &Value, project_ids: &[String]) -> Value {
    let mut next = access.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("projects".to_owned(), json!({ "all": false, "projectIds": project_ids }));
    }
    next
}

// ───────────────────────────── internals ─────────────────────────────

async fn shared_project<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
) -> Result<SharedProject, AppError> {
    // not shared with this person: indistinguishable from a project that does not exist
    list(db, user_id)
        .await?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::entity_not_found("Project", project_id))
}

async fn guest_rows<C: ConnectionTrait>(db: &C, user_id: &str) -> Result<Vec<GuestRows>, DbErr> {
    let memberships = memberships::Entity::find()
        .filter(memberships::Column::UserId.eq(user_id))
        .order_by_asc(memberships::Column::CreatedAt)
        .order_by_asc(memberships::Column::Id)
        .all(db)
        .await?;
    if memberships.is_empty() {
        return Ok(Vec::new());
    }
    let workspaces: HashMap<String, workspaces::Model> = workspaces::Entity::find()
        .filter(workspaces::Column::Id.is_in(memberships.iter().map(|m| m.workspace_id.clone())))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    let mut rows = Vec::new();
    for membership in memberships {
        let Some(workspace) = workspaces.get(&membership.workspace_id) else { continue };
        let settings = resolve_workspace_settings(&workspace.settings);
        let access = stored_member_access(membership.access.as_ref());
        let Some(ids) = limited_project_ids(&settings.roles, &membership.role, access.as_ref())
        else {
            continue;
        };
        if ids.is_empty() {
            continue;
        }
        let projects = projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(projects::Column::Id.is_in(ids))
            .order_by_asc(projects::Column::Name)
            .all(db)
            .await?;
        if !projects.is_empty() {
            rows.push(GuestRows { workspace: workspace.clone(), role: membership.role, projects });
        }
    }
    rows.sort_by(|a, b| locale_compare(&a.workspace.name, &b.workspace.name));
    Ok(rows)
}

/// An approximation of `a.localeCompare(b)`: case-insensitive first, a lower case letter before
/// the same upper case one.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

async fn next_position<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    workspace_id: &str,
) -> Result<i32, DbErr> {
    let max: Option<Option<i32>> = project_placements::Entity::find()
        .select_only()
        .column_as(project_placements::Column::Position.max(), "max")
        .filter(project_placements::Column::UserId.eq(user_id))
        .filter(project_placements::Column::WorkspaceId.eq(workspace_id))
        .into_tuple()
        .one(db)
        .await?;
    Ok(max.flatten().unwrap_or(-1) + 1)
}

async fn save<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
    workspace_id: Option<&str>,
    position: i32,
) -> Result<ProjectPlacement, DbErr> {
    // one row per person and project: a repeated or racing request replaces it instead of failing
    project_placements::Entity::insert(project_placements::ActiveModel {
        id: Set(uid("pp")),
        user_id: Set(user_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        workspace_id: Set(workspace_id.map(ToOwned::to_owned)),
        position: Set(position),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([
            project_placements::Column::UserId,
            project_placements::Column::ProjectId,
        ])
        .update_columns([
            project_placements::Column::Id,
            project_placements::Column::WorkspaceId,
            project_placements::Column::Position,
        ])
        .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(ProjectPlacement {
        project_id: project_id.to_owned(),
        workspace_id: workspace_id.map(ToOwned::to_owned),
        position,
    })
}

async fn delete_placement<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    project_id: &str,
) -> Result<(), DbErr> {
    project_placements::Entity::delete_many()
        .filter(project_placements::Column::UserId.eq(user_id))
        .filter(project_placements::Column::ProjectId.eq(project_id))
        .exec(db)
        .await?;
    Ok(())
}

fn to_placement(row: &project_placements::Model) -> ProjectPlacement {
    ProjectPlacement {
        project_id: row.project_id.clone(),
        workspace_id: row.workspace_id.clone(),
        position: row.position,
    }
}
