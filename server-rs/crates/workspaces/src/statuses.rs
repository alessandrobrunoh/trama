//! The workspace status catalogs: `StatusesService` of
//! `server/src/workspaces/statuses.service.ts`, behind `/api/w/{slug}/statuses`.

use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::json;
use trama_auth::WorkspaceContext;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::js;
use trama_contracts::status::{
    STATUS_NAME_MAX, StatusCatalog, StatusEntry, StatusSubject, is_status_color, is_status_icon,
    resolve_status_catalog, status_stored_values, status_type_label, status_types,
};
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{issues, projects, workspaces};
use trama_events::{Events, LiveChange};

use crate::schemas::{NewStatus, StatusPatch};
use crate::service::save_settings;

/// Most extra statuses (ids other than the seeded semantic type) a catalog can hold.
const CUSTOM_MAX: usize = 50;

/// The catalogs of a workspace row (`catalog`).
#[must_use]
pub fn catalog_of(ws: &workspaces::Model) -> StatusCatalog {
    resolve_status_catalog(ws.settings.get("statuses"))
}

fn subject(value: &str) -> Result<StatusSubject, AppError> {
    StatusSubject::parse(value)
        .ok_or_else(|| AppError::bad_request(format!("Unknown status subject \"{value}\"")))
}

fn unknown(id: &str) -> AppError {
    AppError::bad_request(format!("Unknown status \"{id}\""))
}

fn name(value: &str, entries: &[StatusEntry], except_id: Option<&str>) -> Result<String, AppError> {
    let name = js::trim(value);
    if name.is_empty() || js::len(name) > STATUS_NAME_MAX {
        return Err(AppError::bad_request(format!(
            "Status name must be 1-{STATUS_NAME_MAX} characters"
        )));
    }
    if entries
        .iter()
        .any(|e| Some(e.id.as_str()) != except_id && e.name.to_lowercase() == name.to_lowercase())
    {
        return Err(AppError::conflict(format!("Status \"{name}\" already exists")));
    }
    Ok(name.to_owned())
}

/// When the caller does not name the status, keep it distinct from the ones already in the
/// catalog.
fn unique_name(base: &str, entries: &[StatusEntry]) -> Result<String, AppError> {
    let trimmed = match js::trim(base) {
        "" => "Status",
        other => other,
    };
    let taken = |name: &str| entries.iter().any(|e| e.name.to_lowercase() == name.to_lowercase());
    let mut name = js::truncate(trimmed, STATUS_NAME_MAX).to_owned();
    let mut n = 2;
    while taken(&name) {
        let suffix = format!(" {n}");
        name = format!("{}{suffix}", js::truncate(trimmed, STATUS_NAME_MAX - js::len(&suffix)));
        n += 1;
        if n > CUSTOM_MAX {
            return Err(AppError::conflict(format!("Status \"{trimmed}\" already exists")));
        }
    }
    Ok(name)
}

fn icon(value: &str) -> Result<String, AppError> {
    let icon = js::trim(value);
    if !is_status_icon(icon) {
        return Err(AppError::bad_request(
            "icon must be a lucide icon name (kebab-case) or a single emoji",
        ));
    }
    Ok(icon.to_owned())
}

fn color(value: &str) -> Result<String, AppError> {
    let color = js::trim(value).to_lowercase();
    if !is_status_color(&color) {
        return Err(AppError::bad_request("color must be #rrggbb"));
    }
    Ok(color)
}

/// Adds a status of a chosen type, icon and color to one catalog (`create`).
///
/// # Errors
///
/// 400 for an unknown subject, type, icon, color or name, 409 for a duplicate name.
pub async fn create(
    state: &AppState,
    ctx: &WorkspaceContext,
    subject_key: &str,
    input: &NewStatus,
) -> Result<workspaces::Model, AppError> {
    let key = subject(subject_key)?;
    if !status_types(key).contains(&input.kind.as_str()) {
        return Err(AppError::bad_request(format!("Unknown {key} status type \"{}\"", input.kind)));
    }
    let mut catalog = catalog_of(&ctx.workspace);
    let entries = catalog.entries(key);
    let name = match input.name.as_deref().map(js::trim).filter(|n| !n.is_empty()) {
        Some(explicit) => name(explicit, entries, None)?,
        None => unique_name(&status_type_label(key, &input.kind), entries)?,
    };
    let icon = icon(&input.icon)?;
    let color = color(&input.color)?;
    if entries.iter().filter(|e| e.id != e.kind).count() >= CUSTOM_MAX {
        return Err(AppError::bad_request(format!(
            "A workspace can have at most {CUSTOM_MAX} extra {} statuses",
            key.catalog_key()
        )));
    }
    catalog.entries_mut(key).push(StatusEntry {
        id: uid("st"),
        name,
        icon,
        color,
        kind: input.kind.clone(),
    });
    save(state, ctx, &catalog).await
}

/// Renames or restyles a status (`update`).
///
/// # Errors
///
/// 400 for an unknown subject, status or value, 409 for a duplicate name.
pub async fn update(
    state: &AppState,
    ctx: &WorkspaceContext,
    subject_key: &str,
    id: &str,
    patch: &StatusPatch,
) -> Result<workspaces::Model, AppError> {
    let key = subject(subject_key)?;
    let mut catalog = catalog_of(&ctx.workspace);
    let entries = catalog.entries(key);
    let current = entries.iter().find(|e| e.id == id).ok_or_else(|| unknown(id))?;
    let next_name = match &patch.name {
        Some(requested) => name(requested, entries, Some(id))?,
        None => current.name.clone(),
    };
    let next_icon = match &patch.icon {
        Some(requested) => icon(requested)?,
        None => current.icon.clone(),
    };
    let next_color = match &patch.color {
        Some(requested) => color(requested)?,
        None => current.color.clone(),
    };
    if let Some(entry) = catalog.entries_mut(key).iter_mut().find(|e| e.id == id) {
        entry.name = next_name;
        entry.icon = next_icon;
        entry.color = next_color;
    }
    save(state, ctx, &catalog).await
}

/// Removes a status nobody uses, keeping at least one of every type (`remove`).
///
/// # Errors
///
/// 400 for an unknown subject or status or the last of its type, 409 while records use it.
pub async fn remove(
    state: &AppState,
    ctx: &WorkspaceContext,
    subject_key: &str,
    id: &str,
) -> Result<workspaces::Model, AppError> {
    let key = subject(subject_key)?;
    let mut catalog = catalog_of(&ctx.workspace);
    let entries = catalog.entries(key);
    let current = entries.iter().find(|e| e.id == id).ok_or_else(|| unknown(id))?;
    if entries.iter().filter(|e| e.kind == current.kind).count() <= 1 {
        return Err(AppError::bad_request(format!(
            "Keep at least one {} status",
            status_type_label(key, &current.kind)
        )));
    }
    let used = usage(&state.db, &ctx.workspace.id, key, current, entries).await?;
    if used > 0 {
        return Err(AppError::conflict(format!(
            "Can't remove \"{}\" while {used} {} it",
            current.name,
            if used == 1 { "record still uses" } else { "records still use" }
        )));
    }
    catalog.entries_mut(key).retain(|e| e.id != id);
    save(state, ctx, &catalog).await
}

/// How many records store this status.
async fn usage(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    key: StatusSubject,
    entry: &StatusEntry,
    entries: &[StatusEntry],
) -> Result<u64, AppError> {
    let values = status_stored_values(entry, entries);
    Ok(match key {
        StatusSubject::Issue => {
            issues::Entity::find()
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(issues::Column::Status.is_in(values))
                .count(db)
                .await?
        }
        StatusSubject::Project => {
            projects::Entity::find()
                .filter(projects::Column::WorkspaceId.eq(workspace_id))
                .filter(projects::Column::Status.is_in(values))
                .count(db)
                .await?
        }
        StatusSubject::ProjectHealth => {
            projects::Entity::find()
                .filter(projects::Column::WorkspaceId.eq(workspace_id))
                .filter(projects::Column::Health.is_in(values))
                .count(db)
                .await?
        }
    })
}

async fn save(
    state: &AppState,
    ctx: &WorkspaceContext,
    catalog: &StatusCatalog,
) -> Result<workspaces::Model, AppError> {
    let ws = &ctx.workspace;
    let mut settings = ws.settings.as_object().cloned().unwrap_or_default();
    settings.insert("statuses".into(), json!(catalog));
    let saved = save_settings(&state.db, ws, settings).await?;
    Events::of(state)
        .publish(&ws.id, LiveChange::updated(LiveEventEntity::Workspace, ws.id.clone()));
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use trama_contracts::status::{STATUS_ICON_MAX, default_status_catalog};

    use super::*;

    #[test]
    fn names_are_distinct_and_bounded() {
        let entries = default_status_catalog().issue;
        assert_eq!(unique_name("In Progress", &entries).unwrap(), "In Progress 2");
        assert_eq!(unique_name("  ", &entries).unwrap(), "Status");
        let long = "x".repeat(60);
        assert_eq!(unique_name(&long, &[]).unwrap().len(), STATUS_NAME_MAX);
        assert_eq!(name("backlog", &entries, None).unwrap_err().status_code(), 409);
        assert!(name("backlog", &entries, Some("backlog")).is_ok());
        assert_eq!(
            name(&"x".repeat(STATUS_NAME_MAX + 1), &entries, None).unwrap_err().status_code(),
            400
        );
    }

    #[test]
    fn icons_and_colors() {
        assert_eq!(icon(" bug ").unwrap(), "bug");
        assert_eq!(icon("🐞").unwrap(), "🐞");
        assert!(icon("Not an icon").is_err());
        assert!(icon(&"a".repeat(STATUS_ICON_MAX + 1)).is_err());
        assert_eq!(color(" #3F6BD6 ").unwrap(), "#3f6bd6");
        assert!(color("blue").is_err());
    }
}
