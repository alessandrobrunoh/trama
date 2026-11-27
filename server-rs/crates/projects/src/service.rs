//! Projects: listing, reading, creating, editing and deleting (`projects.service.ts`), plus the
//! wire form of a stored row.
//!
//! The functions read the request's member access from the `trama-auth` task-local, as the
//! NestJS service does: a narrowed member only reaches the projects of their access, and can
//! never create one (their list cannot grow through the API). Outside a request (the routing
//! rules, the importers, the project sharing of the invites module, the snapshot) there is no
//! access and nothing is hidden.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::Value as SqlValue;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel,
    QueryFilter, QueryOrder, QuerySelect, Set, Statement, TransactionTrait,
};
use serde_json::{Value, json};
use trama_auth::member_access::{apply_project_scope, current_access, project_hidden};
use trama_common::refs;
use trama_common::util::is_unique_violation;
use trama_contracts::common::{ActorRef, Priority, SubjectRef, SubjectType};
use trama_contracts::labels::LabelScope;
use trama_contracts::projects::{
    Project, UNASSIGNED_ISSUE_KEY_PREFIX, is_project_key, is_reserved_project_key,
    normalize_project_key, unique_project_key,
};
use trama_contracts::status::{load_status_catalog, require_status, status_filter_ids};
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{issues, milestones, projects};
use trama_events::{Events, RecordEvent};
use trama_issues::keys::{IssueKeyChange, IssueRekeyReason, rekey_issues};
use trama_issues::service::save_rows;
use trama_uploads::service as uploads;
use trama_uploads::{LostOwner, UploadSubject};
use trama_workspaces::labels;

use crate::icon::is_project_icon;

/// Semantic types of the project statuses that close a project.
const CLOSED: &[&str] = &["completed", "canceled"];

/// A project to create (`ProjectInput & { name }` of the importers).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewProject {
    /// Display name (trimmed when stored).
    pub name: String,
    /// Project tag; suggested from the name when absent.
    pub key: Option<String>,
    /// One-line summary (trimmed; blank is stored as none).
    pub summary: Option<String>,
    /// Longer description (not trimmed).
    pub description: Option<String>,
    /// `#rrggbb`; `#6b7280` when absent.
    pub color: Option<String>,
    /// Lucide icon name (kebab-case) or a single emoji.
    pub icon: Option<String>,
    /// Catalog id, or a legacy enum (the seeded status of that type); `backlog` when absent.
    pub status: Option<String>,
    /// Health catalog id, or a legacy enum.
    pub health: Option<String>,
    /// `none` when absent.
    pub priority: Option<Priority>,
    /// Lead user id.
    pub lead_id: Option<String>,
    /// One git repository: a URL or `owner/name` (trimmed; blank is stored as none).
    pub repository: Option<String>,
    /// Workspace label ids; replaced by `[]` when absent.
    pub labels: Option<Vec<String>>,
    /// Start date.
    pub start_date: Option<DateTime<Utc>>,
    /// Target date.
    pub target_date: Option<DateTime<Utc>>,
}

/// Changes to a project (`ProjectInput`); `None` leaves a field alone, `Some(None)` clears the
/// clearable ones.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectPatch {
    /// New name.
    pub name: Option<String>,
    /// New project tag; re-keys the issues and keeps their old keys as aliases.
    pub key: Option<String>,
    /// New summary, or `Some(None)` to clear it.
    pub summary: Option<Option<String>>,
    /// New description, or `Some(None)` to clear it.
    pub description: Option<Option<String>>,
    /// New color.
    pub color: Option<String>,
    /// New icon, or `Some(None)` to clear it.
    pub icon: Option<Option<String>>,
    /// New catalog id or legacy enum.
    pub status: Option<String>,
    /// New health catalog id or legacy enum, or `Some(None)` to clear it.
    pub health: Option<Option<String>>,
    /// New priority.
    pub priority: Option<Priority>,
    /// New lead user id, or `Some(None)` to clear it.
    pub lead_id: Option<Option<String>>,
    /// New repository, or `Some(None)` to clear it.
    pub repository: Option<Option<String>>,
    /// Workspace label ids; replaces the whole list.
    pub labels: Option<Vec<String>>,
    /// New start date, or `Some(None)` to clear it.
    pub start_date: Option<Option<DateTime<Utc>>>,
    /// New target date, or `Some(None)` to clear it.
    pub target_date: Option<Option<DateTime<Utc>>>,
}

impl ProjectPatch {
    /// The fields this change carries (`Object.keys(patch)`), in DTO declaration order.
    #[must_use]
    fn fields(&self) -> Vec<&'static str> {
        let mut fields = Vec::new();
        let mut add = |present: bool, name: &'static str| {
            if present {
                fields.push(name);
            }
        };
        add(self.name.is_some(), "name");
        add(self.key.is_some(), "key");
        add(self.summary.is_some(), "summary");
        add(self.description.is_some(), "description");
        add(self.color.is_some(), "color");
        add(self.icon.is_some(), "icon");
        add(self.status.is_some(), "status");
        add(self.health.is_some(), "health");
        add(self.priority.is_some(), "priority");
        add(self.lead_id.is_some(), "leadId");
        add(self.repository.is_some(), "repository");
        add(self.labels.is_some(), "labels");
        add(self.start_date.is_some(), "startDate");
        add(self.target_date.is_some(), "targetDate");
        fields
    }
}

/// The filters of the projects list (`ProjectFilter`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectFilter {
    /// Catalog id, or a legacy enum (the seeded status of that type).
    pub status: Option<String>,
    /// Health catalog id, or a legacy enum.
    pub health: Option<String>,
    /// Lead user id.
    pub lead_id: Option<String>,
    /// Substring of the name, case-insensitive.
    pub q: Option<String>,
}

/// The wire form of a stored project (`ProjectEntity.toJSON()`): absent columns are omitted,
/// never `null`.
#[must_use]
pub fn present(row: &projects::Model) -> Project {
    Project {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        name: row.name.clone(),
        key: row.key.clone(),
        summary: row.summary.clone(),
        description: row.description.clone(),
        color: row.color.clone(),
        icon: row.icon.clone(),
        status: row.status.clone(),
        health: row.health.clone(),
        priority: Priority::parse(&row.priority).unwrap_or(Priority::None),
        lead_id: row.lead_id.clone(),
        repository: row.repository.clone(),
        labels: strings(&row.labels),
        start_date: row.start_date.as_ref().map(to_iso),
        target_date: row.target_date.as_ref().map(to_iso),
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
        completed_at: row.completed_at.as_ref().map(to_iso),
    }
}

/// The strings of a JSON array column (`labels`).
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `String.prototype.trim`.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Trimmed, and blank stored as none (`x?.trim() || null`).
fn trimmed_or_none(value: Option<&str>) -> Option<String> {
    value.map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Project, id: id.to_owned() }
}

fn now() -> sea_orm::prelude::DateTimeWithTimeZone {
    Utc::now().fixed_offset()
}

/// `SELECT "key" FROM "projects" … FOR UPDATE`, as the re-key transactions lock the row.
/// `None` when the project is gone.
async fn lock_project_key<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    id: &str,
) -> Result<Option<String>, AppError> {
    projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Id.eq(id))
        .select_only()
        .column(projects::Column::Key)
        .lock_exclusive()
        .into_tuple::<String>()
        .one(conn)
        .await
        .map_err(Into::into)
}

/// The project's issues, locked for the re-key, oldest first.
async fn locked_issues<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    project_id: &str,
) -> Result<Vec<issues::Model>, AppError> {
    issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::ProjectId.eq(project_id))
        .order_by_asc(issues::Column::CreatedAt)
        .order_by_asc(issues::Column::Id)
        .lock_exclusive()
        .all(conn)
        .await
        .map_err(Into::into)
}

/// The stored row, or 404 when it does not exist or is outside the request's access.
async fn find<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<projects::Model, AppError> {
    let row = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Id.eq(id))
        .one(db)
        .await?;
    row.filter(|row| !project_hidden(current_access().as_deref(), Some(&row.id)))
        .ok_or_else(|| AppError::entity_not_found("Project", id))
}

/// The catalog id of a project health (a legacy enum value resolves to the seeded one).
///
/// # Errors
///
/// 400 when the workspace's health catalog has no such entry.
pub async fn resolve_health<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    stored: &str,
) -> Result<String, AppError> {
    let catalog = load_status_catalog(db, workspace_id).await;
    Ok(require_status(&catalog.project_health, stored, "health")?.id.clone())
}

/// The project rows a caller reaches, newest update first; a status or health filter also matches
/// the legacy enum, `q` is a case-insensitive substring of the name. The request's project access
/// applies. This is what the workspace snapshot embeds.
///
/// # Errors
///
/// A database error.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    filter: ProjectFilter,
) -> Result<Vec<Project>, AppError> {
    let catalog = load_status_catalog(db, workspace_id).await;
    let mut query = projects::Entity::find().filter(projects::Column::WorkspaceId.eq(workspace_id));
    if let Some(status) = filter.status {
        query = query
            .filter(projects::Column::Status.is_in(status_filter_ids(&catalog.project, &status)));
    }
    if let Some(health) = filter.health {
        query = query.filter(
            projects::Column::Health.is_in(status_filter_ids(&catalog.project_health, &health)),
        );
    }
    if let Some(lead) = filter.lead_id {
        query = query.filter(projects::Column::LeadId.eq(lead));
    }
    if let Some(q) = filter.q {
        query = query.filter(Expr::col(projects::Column::Name).ilike(format!("%{q}%")));
    }
    let rows = apply_project_scope(query, projects::Column::Id)
        .order_by_desc(projects::Column::UpdatedAt)
        .all(db)
        .await?;
    Ok(rows.iter().map(present).collect())
}

/// One project, as the stored row (the routing rules and the invites read it directly).
///
/// # Errors
///
/// 404 `Project "<id>" not found` when it does not exist or is outside the request's project
/// access.
pub async fn get<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<projects::Model, AppError> {
    find(db, workspace_id, id).await
}

/// Creates a project and records `project.created`. The tag comes from the request or is
/// suggested from the name, and must not collide with another project or a reserved prefix.
/// This is what the importers call.
///
/// # Errors
///
/// 403 when the caller's access is narrowed (it cannot grow its list), 400 for a bad icon, an
/// unknown lead, a bad or reserved tag, or an unknown status or health; 409 when the tag is
/// taken; 500 when no tag is left; else a database error.
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    input: NewProject,
) -> Result<Project, AppError> {
    if current_access().is_some_and(|access| !access.projects.all) {
        return Err(AppError::forbidden("Your access cannot add projects outside its list"));
    }
    validate(&state.db, workspace_id, input.icon.as_deref(), input.lead_id.as_deref()).await?;
    let key = resolve_project_key(&state.db, workspace_id, &input.name, input.key.as_deref(), None)
        .await?;
    let catalog = load_status_catalog(&state.db, workspace_id).await;
    let status =
        require_status(&catalog.project, input.status.as_deref().unwrap_or("backlog"), "status")?;
    let health = match input.health.as_deref() {
        Some(health) => Some(require_status(&catalog.project_health, health, "health")?.id.clone()),
        None => None,
    };
    let labels = match input.labels.as_deref() {
        Some(ids) => {
            labels::assign(&state.db, workspace_id, Some(ids), Some(LabelScope::Project), None)
                .await?
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    let at = now();
    let row = projects::ActiveModel {
        id: Set(uid("pj")),
        workspace_id: Set(workspace_id.to_owned()),
        name: Set(js_trim(&input.name).to_owned()),
        key: Set(key.clone()),
        summary: Set(trimmed_or_none(input.summary.as_deref())),
        description: Set(input.description.clone()),
        color: Set(input.color.unwrap_or_else(|| "#6b7280".to_owned())),
        icon: Set(input.icon.clone()),
        status: Set(status.id.clone()),
        health: Set(health),
        priority: Set(input.priority.unwrap_or(Priority::None).as_str().to_owned()),
        lead_id: Set(input.lead_id.clone()),
        repository: Set(trimmed_or_none(input.repository.as_deref())),
        labels: Set(json!(labels)),
        start_date: Set(input.start_date.map(|d| d.fixed_offset())),
        target_date: Set(input.target_date.map(|d| d.fixed_offset())),
        completed_at: Set(CLOSED.contains(&status.kind.as_str()).then_some(at)),
        created_at: Set(at),
        updated_at: Set(at),
    }
    .insert(&state.db)
    .await
    .map_err(|e| tag_taken(e, &key))?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "project.created", subject(&row.id))
                .data(json!({ "name": row.name, "key": row.key })),
        )
        .await?;
    if row.description.is_some() {
        uploads::retained(
            &state.db,
            workspace_id,
            None,
            row.description.as_deref(),
            Some(&UploadSubject::project(&row.id)),
        )
        .await?;
    }
    Ok(present(&row))
}

/// Edits a project. Records `project.updated` with the changed fields, `project.status_changed`
/// and `project.health_changed` when those moved, and an `issue.rekeyed` event per issue when
/// the tag changed.
///
/// # Errors
///
/// 404 when the project does not exist or is outside the request's access; 400 for a bad icon,
/// an unknown lead, a bad or reserved tag, or an unknown status or health; 409 when the tag is
/// taken or changed under us; else a database error.
#[allow(
    clippy::too_many_lines,
    reason = "one block per patched field, then the events, as in NestJS"
)]
pub async fn update(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
    patch: ProjectPatch,
) -> Result<Project, AppError> {
    let mut row = find(&state.db, workspace_id, id).await?;
    validate(
        &state.db,
        workspace_id,
        patch.icon.as_ref().and_then(|icon| icon.as_deref()),
        patch.lead_id.as_ref().and_then(|lead| lead.as_deref()),
    )
    .await?;
    let before = row.status.clone();
    let health_before = row.health.clone();
    let previous_key = row.key.clone();
    let next_key = match patch.key.as_deref() {
        None => previous_key.clone(),
        Some(key) => {
            resolve_project_key(&state.db, workspace_id, &row.name, Some(key), Some(id)).await?
        }
    };
    let previous_description = row.description.clone();
    if let Some(name) = &patch.name {
        row.name = js_trim(name).to_owned();
    }
    if patch.key.is_some() {
        row.key = next_key.clone();
    }
    if let Some(summary) = &patch.summary {
        row.summary = trimmed_or_none(summary.as_deref());
    }
    if let Some(description) = &patch.description {
        uploads::assert_attachable(&state.db, workspace_id, description.as_deref()).await?;
        row.description = description.clone();
    }
    if let Some(color) = &patch.color {
        row.color = color.clone();
    }
    if let Some(icon) = &patch.icon {
        row.icon = icon.clone();
    }
    if let Some(priority) = &patch.priority {
        priority.as_str().clone_into(&mut row.priority);
    }
    if let Some(lead) = &patch.lead_id {
        row.lead_id = lead.clone();
    }
    if let Some(repository) = &patch.repository {
        row.repository = trimmed_or_none(repository.as_deref());
    }
    if let Some(ids) = &patch.labels {
        let current = strings(&row.labels);
        row.labels = json!(
            labels::assign(
                &state.db,
                workspace_id,
                Some(ids.as_slice()),
                Some(LabelScope::Project),
                Some(current.as_slice()),
            )
            .await?
            .unwrap_or_default()
        );
    }
    if let Some(start) = &patch.start_date {
        row.start_date = start.map(|d| d.fixed_offset());
    }
    if let Some(target) = &patch.target_date {
        row.target_date = target.map(|d| d.fixed_offset());
    }
    if let Some(status) = patch.status.as_deref() {
        let catalog = load_status_catalog(&state.db, workspace_id).await;
        let entry = require_status(&catalog.project, status, "status")?;
        row.status = entry.id.clone();
        row.completed_at = if CLOSED.contains(&entry.kind.as_str()) {
            row.completed_at.or_else(|| Some(now()))
        } else {
            None
        };
    }
    if let Some(health) = &patch.health {
        let catalog = load_status_catalog(&state.db, workspace_id).await;
        row.health = match health.as_deref() {
            Some(health) => {
                Some(require_status(&catalog.project_health, health, "health")?.id.clone())
            }
            None => None,
        };
    }
    let at = now();
    row.updated_at = at;
    let issue_key_changes;
    if next_key == previous_key {
        row = row
            .clone()
            .into_active_model()
            .reset_all()
            .update(&state.db)
            .await
            .map_err(|e| tag_taken(e, &next_key))?;
        issue_key_changes = Vec::new();
    } else {
        let (saved, changes) =
            rekey_with_tag_change(state, workspace_id, id, &row, &previous_key, &next_key, at)
                .await?;
        row = saved;
        issue_key_changes = changes;
    }
    record_issue_rekeys(state, workspace_id, actor, &issue_key_changes).await?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "project.updated", subject(id))
                .data(json!({ "fields": patch.fields() })),
        )
        .await?;
    if patch.description.is_some() {
        uploads::retained(
            &state.db,
            workspace_id,
            previous_description.as_deref(),
            row.description.as_deref(),
            Some(&UploadSubject::project(&row.id)),
        )
        .await?;
    }
    if row.status != before {
        Events::of(state)
            .record(
                &state.db,
                RecordEvent::new(
                    workspace_id,
                    actor.clone(),
                    "project.status_changed",
                    subject(id),
                )
                .data(json!({ "from": before, "to": row.status })),
            )
            .await?;
    }
    if row.health != health_before {
        Events::of(state)
            .record(
                &state.db,
                RecordEvent::new(
                    workspace_id,
                    actor.clone(),
                    "project.health_changed",
                    subject(id),
                )
                .data(json!({ "from": health_before, "to": row.health })),
            )
            .await?;
    }
    Ok(present(&row))
}

/// Saves `row` with its new tag in one transaction that first locks the project row (`FOR
/// UPDATE`, so two tag edits serialize) and re-keys the project's issues under `next_key`,
/// keeping their old keys as aliases. Returns the saved row and the key changes; the caller
/// records the `issue.rekeyed` events after committing.
async fn rekey_with_tag_change(
    state: &AppState,
    workspace_id: &str,
    id: &str,
    row: &projects::Model,
    previous_key: &str,
    next_key: &str,
    at: sea_orm::prelude::DateTimeWithTimeZone,
) -> Result<(projects::Model, Vec<IssueKeyChange>), AppError> {
    let txn = state.db.begin().await?;
    let locked_key = lock_project_key(&txn, workspace_id, id).await?;
    if locked_key.is_none() {
        return Err(AppError::entity_not_found("Project", id));
    }
    if locked_key.as_deref() != Some(previous_key) {
        return Err(AppError::conflict("Project tag changed; retry the update"));
    }
    let mut issue_rows = locked_issues(&txn, workspace_id, id).await?;
    let saved: projects::Model = row
        .clone()
        .into_active_model()
        .reset_all()
        .update(&txn)
        .await
        .map_err(|e| tag_taken(e, next_key))?;
    let changes = rekey_issues(
        &txn,
        workspace_id,
        &mut issue_rows,
        next_key,
        Some(id),
        IssueRekeyReason::ProjectTagChanged,
        at.with_timezone(&Utc),
    )
    .await?;
    if !issue_rows.is_empty() {
        save_rows(&txn, &issue_rows).await?;
    }
    txn.commit().await?;
    Ok((saved, changes))
}

/// Deletes a project: its issues move to no project and are re-keyed under `UNPR` (their old
/// keys stay as aliases), the milestones of other issues are dropped and the milestone comments
/// deleted (the milestones themselves cascade in the database), the description's files are
/// released, and `issue.rekeyed` plus `project.deleted` events are recorded.
///
/// # Errors
///
/// 404 when the project does not exist or is outside the request's access, else a database
/// error.
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
) -> Result<(), AppError> {
    let row = find(&state.db, workspace_id, id).await?;
    let lost = uploads::ids_lost_with(
        &state.db,
        workspace_id,
        &LostOwner { issue_id: None, project_id: Some(id.to_owned()) },
        &[row.description.as_deref()],
    )
    .await?;
    let milestone_ids: Vec<String> = milestones::Entity::find()
        .filter(milestones::Column::ProjectId.eq(id))
        .select_only()
        .column(milestones::Column::Id)
        .into_tuple()
        .all(&state.db)
        .await?;
    let txn = state.db.begin().await?;
    if lock_project_key(&txn, workspace_id, id).await?.is_none() {
        return Err(AppError::entity_not_found("Project", id));
    }
    let mut issue_rows = locked_issues(&txn, workspace_id, id).await?;
    let issue_key_changes = rekey_issues(
        &txn,
        workspace_id,
        &mut issue_rows,
        UNASSIGNED_ISSUE_KEY_PREFIX,
        None,
        IssueRekeyReason::ProjectDeleted,
        Utc::now(),
    )
    .await?;
    for issue in &mut issue_rows {
        issue.project_id = None;
    }
    if !issue_rows.is_empty() {
        save_rows(&txn, &issue_rows).await?;
    }
    if !milestone_ids.is_empty() {
        // milestones cascade with the project: drop their ids from issues, and their comments
        txn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"UPDATE "issues" SET "milestoneIds" = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text("milestoneIds") x WHERE x <> ALL($2)), '[]'::jsonb) WHERE "workspaceId" = $1 AND "milestoneIds" ?| $2"#,
            vec![workspace_id.to_owned().into(), id_list(&milestone_ids)],
        ))
        .await?;
        txn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)"#,
            vec![workspace_id.to_owned().into(), id_list(&milestone_ids)],
        ))
        .await?;
    }
    projects::Entity::delete_by_id(id.to_owned()).exec(&txn).await?;
    txn.commit().await?;
    uploads::release_ids(&state.db, workspace_id, &lost).await?;
    record_issue_rekeys(state, workspace_id, actor, &issue_key_changes).await?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "project.deleted", subject(id))
                .data(json!({ "name": row.name, "key": row.key })),
        )
        .await?;
    Ok(())
}

/// An id list for a raw statement (`= ANY($n)`, `?| $n`).
fn id_list(ids: &[String]) -> SqlValue {
    sea_orm::Value::from(ids.to_vec())
}

/// 409 `Project tag "<key>" is already used` for a unique violation, else the error itself.
fn tag_taken(err: sea_orm::DbErr, key: &str) -> AppError {
    if is_unique_violation(&err) {
        AppError::conflict(format!("Project tag \"{key}\" is already used"))
    } else {
        err.into()
    }
}

/// The icon and lead rules every write checks (`validate`).
async fn validate<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    icon: Option<&str>,
    lead_id: Option<&str>,
) -> Result<(), AppError> {
    if icon.is_some_and(|icon| !is_project_icon(icon)) {
        return Err(AppError::bad_request(
            "icon must be a lucide icon name (kebab-case) or a single emoji",
        ));
    }
    refs::users(db, workspace_id, &[lead_id.map(str::to_owned)]).await
}

/// The tag to store: the request's (uppercased), or one suggested from the name that no other
/// project and no reserved prefix uses (`resolveProjectKey`).
async fn resolve_project_key<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    name: &str,
    value: Option<&str>,
    exclude_id: Option<&str>,
) -> Result<String, AppError> {
    let key = match value {
        None => {
            let used: Vec<String> = projects::Entity::find()
                .filter(projects::Column::WorkspaceId.eq(workspace_id))
                .select_only()
                .column(projects::Column::Key)
                .into_tuple()
                .all(db)
                .await?;
            unique_project_key(name, used.iter().map(String::as_str))
                .ok_or_else(|| AppError::internal("No available project tags remain"))?
        }
        Some(value) => normalize_project_key(value),
    };
    if !is_project_key(&key) {
        return Err(AppError::bad_request(
            "Project tag must be 1 to 4 letters or digits, starting with a letter",
        ));
    }
    if is_reserved_project_key(&key) {
        return Err(AppError::bad_request(if key == UNASSIGNED_ISSUE_KEY_PREFIX {
            format!("{UNASSIGNED_ISSUE_KEY_PREFIX} is reserved for issues without a project")
        } else {
            format!("{key} is reserved for decision identifiers")
        }));
    }
    let existing = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Key.eq(key.as_str()))
        .one(db)
        .await?;
    if existing.is_some_and(|p| p.id != exclude_id.unwrap_or_default()) {
        return Err(AppError::conflict(format!("Project tag \"{key}\" is already used")));
    }
    Ok(key)
}

/// One `issue.rekeyed` event per re-keyed issue (`recordIssueRekeys`).
async fn record_issue_rekeys(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    changes: &[IssueKeyChange],
) -> Result<(), AppError> {
    let events = Events::of(state);
    for change in changes {
        events
            .record(
                &state.db,
                RecordEvent::new(
                    workspace_id,
                    actor.clone(),
                    "issue.rekeyed",
                    SubjectRef { kind: SubjectType::Issue, id: change.issue_id.clone() },
                )
                .data(json!({
                    "key": change.to,
                    "from": change.from,
                    "to": change.to,
                    "fromProjectId": change.from_project_id,
                    "toProjectId": change.to_project_id,
                    "reason": change.reason.as_str(),
                })),
            )
            .await?;
    }
    Ok(())
}
