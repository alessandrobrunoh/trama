//! Moving a project to another workspace (`server/src/sharing/project-transfer.service.ts`).
//!
//! Moves a project, with its milestones, issues, time entries, comments, artifacts and history,
//! to another workspace. The caller must be able to administer both workspaces. Issue keys are
//! kept (so the project tag must be free in the target), statuses and labels are mapped to the
//! target's by type and name, guests are carried over as limited members, and anything that
//! pointed at a person who is not in the target is cleared. One transaction: either everything
//! moves or nothing does.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, Statement, TransactionTrait,
    Value as SqlValue,
};
use serde_json::{Value, json};
use trama_auth::WorkspaceContext;
use trama_auth::member_access::project_hidden;
use trama_common::util::{is_unique_violation, unique};
use trama_contracts::access::effective_member_access;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::identity::stored_member_access;
use trama_contracts::projects::{
    ProjectRef, ProjectTransferGuest, ProjectTransferPreview, ProjectTransferResult,
    TransferCounts, TransferGuestAction, WorkspaceRef,
};
use trama_contracts::roles::{find_workspace_role, role_has_admin_power};
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{issues, memberships, milestones, projects, users, workspaces};
use trama_events::{Events, LiveChange, RecordEvent};

use crate::plan::{
    StatusMap, TransferMappingPlan, TransferUsage, guest_role_for, limited_project_ids,
    plan_transfer_mappings,
};
use crate::schemas::project_wire;
use crate::service::with_projects;

/// Why a step of the transfer failed: kept apart so a unique violation can become a 409.
enum Fail {
    App(AppError),
    Db(DbErr),
}

impl From<AppError> for Fail {
    fn from(err: AppError) -> Self {
        Self::App(err)
    }
}

impl From<DbErr> for Fail {
    fn from(err: DbErr) -> Self {
        Self::Db(err)
    }
}

impl From<Fail> for AppError {
    fn from(fail: Fail) -> Self {
        match fail {
            Fail::App(err) => err,
            Fail::Db(err) => err.into(),
        }
    }
}

/// A person limited to the project in the source workspace.
struct CarriedGuest {
    user_id: String,
    name: String,
    email: String,
    action: TransferGuestAction,
    role: String,
    /// The membership in the source workspace.
    from: memberships::Model,
    /// The membership in the target, when there is one.
    existing: Option<memberships::Model>,
}

struct Plan {
    source: workspaces::Model,
    target: workspaces::Model,
    project: projects::Model,
    issues: Vec<issues::Model>,
    milestone_ids: Vec<String>,
    mapping: TransferMappingPlan,
    guests: Vec<CarriedGuest>,
    /// Everyone who is a member of the target once the guests are carried over.
    target_people: HashSet<String>,
    preview: ProjectTransferPreview,
}

/// What a transfer would do: status and label mapping, guests carried over, blockers. Changes
/// nothing.
///
/// # Errors
///
/// 404 for an unknown project or a target the caller does not belong to; 400 for the project's
/// own workspace; 403 when the caller does not administer the target.
pub async fn preview(
    state: &AppState,
    ctx: &WorkspaceContext,
    project_id: &str,
    target_slug: &str,
) -> Result<ProjectTransferPreview, AppError> {
    let (source, target, project) = resolve(&state.db, ctx, project_id, target_slug).await?;
    let caller = caller_id(ctx)?;
    let plan = plan(&state.db, source, target, project, caller, false).await?;
    Ok(plan.preview)
}

/// Moves the project. See the module docs.
///
/// # Errors
///
/// As [`preview`], and 409 when the plan has blockers or something in the project already exists
/// in the target.
pub async fn transfer(
    state: &AppState,
    ctx: &WorkspaceContext,
    actor: ActorRef,
    project_id: &str,
    target_slug: &str,
) -> Result<ProjectTransferResult, AppError> {
    let (source, target, _) = resolve(&state.db, ctx, project_id, target_slug).await?;
    let caller = caller_id(ctx)?;
    let txn = state.db.begin().await?;
    let moved = match run(&txn, &source.id, &target.id, project_id, caller).await {
        Ok(moved) => moved,
        Err(fail) => {
            // the transaction rolls back when dropped; say so explicitly
            let _ = txn.rollback().await;
            if let Fail::Db(err) = &fail
                && is_unique_violation(err)
            {
                return Err(AppError::conflict(
                    "Something in this project already exists in the target workspace (an issue key or an imported issue)",
                ));
            }
            return Err(fail.into());
        }
    };
    txn.commit().await?;
    let Moved { plan, project, time_entries, unassigned } = moved;
    announce(state, &plan, actor).await?;
    Ok(ProjectTransferResult {
        // the entity is what every project route returns
        project: project_wire(&project),
        target: workspace_ref(&plan.target),
        counts: TransferCounts {
            issues: len(plan.issues.len()),
            milestones: len(plan.milestone_ids.len()),
            time_entries,
        },
        unassigned,
    })
}

struct Moved {
    plan: Plan,
    project: projects::Model,
    time_entries: i64,
    unassigned: i64,
}

fn caller_id(ctx: &WorkspaceContext) -> Result<&str, AppError> {
    ctx.user_id
        .as_deref()
        .ok_or_else(|| AppError::forbidden("This endpoint requires a user, not an agent token"))
}

#[allow(clippy::cast_possible_wrap)]
const fn len(n: usize) -> i64 {
    n as i64
}

fn workspace_ref(row: &workspaces::Model) -> WorkspaceRef {
    WorkspaceRef { id: row.id.clone(), slug: row.slug.clone(), name: row.name.clone() }
}

/// The body of the transaction: lock, plan, refuse on blockers, apply.
async fn run(
    txn: &DatabaseTransaction,
    source_id: &str,
    target_id: &str,
    project_id: &str,
    caller: &str,
) -> Result<Moved, Fail> {
    // serialize transfers touching either workspace; plain writes (issue creation) keep going
    txn.execute_raw(Statement::from_sql_and_values(
        txn.get_database_backend(),
        r#"SELECT "id" FROM "workspaces" WHERE "id" IN ($1, $2) ORDER BY "id" FOR NO KEY UPDATE"#,
        [source_id.into(), target_id.into()],
    ))
    .await?;
    let source = workspaces::Entity::find_by_id(source_id).one(txn).await?.ok_or_else(gone)?;
    let target = workspaces::Entity::find_by_id(target_id).one(txn).await?.ok_or_else(gone)?;
    let locked = txn
        .query_one_raw(Statement::from_sql_and_values(
            txn.get_database_backend(),
            r#"SELECT "id" FROM "projects" WHERE "workspaceId" = $1 AND "id" = $2 FOR UPDATE"#,
            [source.id.as_str().into(), project_id.into()],
        ))
        .await?;
    if locked.is_none() {
        return Err(AppError::entity_not_found("Project", project_id).into());
    }
    let project = projects::Entity::find_by_id(project_id).one(txn).await?.ok_or_else(gone)?;
    let plan = plan(txn, source, target, project, caller, true).await?;
    if !plan.preview.blockers.is_empty() {
        return Err(AppError::conflict(plan.preview.blockers.join(" ")).into());
    }
    apply(txn, plan).await
}

/// `findOneByOrFail` failing.
fn gone() -> DbErr {
    DbErr::RecordNotFound("Record not found".to_owned())
}

// ───────────────────────────── permissions ─────────────────────────────

/// Both workspaces and the project, or an error. The caller already administers the source
/// (route gate).
async fn resolve<C: ConnectionTrait>(
    db: &C,
    ctx: &WorkspaceContext,
    project_id: &str,
    target_slug: &str,
) -> Result<(workspaces::Model, workspaces::Model, projects::Model), AppError> {
    let source = ctx.workspace.clone();
    let project = projects::Entity::find_by_id(project_id)
        .filter(projects::Column::WorkspaceId.eq(source.id.as_str()))
        .one(db)
        .await?;
    let Some(project) = project.filter(|p| !project_hidden(ctx.access.as_ref(), Some(&p.id)))
    else {
        return Err(AppError::entity_not_found("Project", project_id));
    };
    let target = workspaces::Entity::find()
        .filter(workspaces::Column::Slug.eq(trama_contracts::js::trim(target_slug).to_lowercase()))
        .one(db)
        .await?;
    let mine = match (&target, ctx.user_id.as_deref()) {
        (Some(target), Some(user_id)) => {
            memberships::Entity::find()
                .filter(memberships::Column::WorkspaceId.eq(target.id.as_str()))
                .filter(memberships::Column::UserId.eq(user_id))
                .one(db)
                .await?
        }
        _ => None,
    };
    // a workspace the caller does not belong to looks like one that does not exist
    let (Some(target), Some(mine)) = (target, mine) else {
        return Err(AppError::not_found(format!("Workspace \"{target_slug}\" not found")));
    };
    if target.id == source.id {
        return Err(AppError::bad_request("The project already lives in that workspace"));
    }
    let settings = resolve_workspace_settings(&target.settings);
    let role = find_workspace_role(&settings.roles, Some(&mine.role));
    let stored = stored_member_access(mine.access.as_ref());
    let access = effective_member_access(role, stored.as_ref());
    if !role_has_admin_power(role) || access.is_some_and(|a| !a.projects.all) {
        return Err(AppError::forbidden(
            "You need to be an owner or admin of the target workspace to transfer a project into it",
        ));
    }
    Ok((source, target, project))
}

// ───────────────────────────── planning ─────────────────────────────

fn bump(map: &mut IndexMap<String, i64>, key: &str) {
    *map.entry(key.to_owned()).or_insert(0) += 1;
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
        .unwrap_or_default()
}

/// `$n` as an array of the ids bound as one JSON parameter (no limit on how many).
fn any_of(n: usize) -> String {
    format!("ANY(ARRAY(SELECT jsonb_array_elements_text(${n}::jsonb)))")
}

fn id_list(ids: &[String]) -> SqlValue {
    Value::from(ids.to_vec()).into()
}

async fn count_rows<C: ConnectionTrait>(
    db: &C,
    sql: &str,
    values: Vec<SqlValue>,
) -> Result<i64, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(db.get_database_backend(), sql, values))
        .await?
        .ok_or_else(gone)?;
    Ok(i64::from(row.try_get::<i32>("", "count")?))
}

async fn ids_returned<C: ConnectionTrait>(
    db: &C,
    sql: &str,
    values: Vec<SqlValue>,
) -> Result<Vec<String>, DbErr> {
    db.query_all_raw(Statement::from_sql_and_values(db.get_database_backend(), sql, values))
        .await?
        .iter()
        .map(|row| row.try_get::<String>("", "id"))
        .collect()
}

async fn run_sql<C: ConnectionTrait>(
    db: &C,
    sql: &str,
    values: Vec<SqlValue>,
) -> Result<u64, DbErr> {
    Ok(db
        .execute_raw(Statement::from_sql_and_values(db.get_database_backend(), sql, values))
        .await?
        .rows_affected())
}

#[allow(clippy::too_many_lines)]
async fn plan<C: ConnectionTrait>(
    db: &C,
    source: workspaces::Model,
    target: workspaces::Model,
    project: projects::Model,
    caller: &str,
    lock: bool,
) -> Result<Plan, Fail> {
    let mut query = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(source.id.as_str()))
        .filter(issues::Column::ProjectId.eq(project.id.as_str()))
        .order_by_asc(issues::Column::CreatedAt)
        .order_by_asc(issues::Column::Id);
    if lock {
        query = query.lock_exclusive();
    }
    let issue_rows = query.all(db).await?;
    let milestone_ids: Vec<String> = milestones::Entity::find()
        .filter(milestones::Column::ProjectId.eq(project.id.as_str()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.id)
        .collect();
    let issue_ids: Vec<String> = issue_rows.iter().map(|issue| issue.id.clone()).collect();
    let time_entries = count_rows(
        db,
        &format!(
            r#"SELECT count(*)::int AS "count" FROM "time_entries"
                WHERE "workspaceId" = $1 AND ("projectId" = $2 OR "issueId" = {})"#,
            any_of(3)
        ),
        vec![source.id.as_str().into(), project.id.as_str().into(), id_list(&issue_ids)],
    )
    .await?;

    let mut usage = TransferUsage {
        project_status: project.status.clone(),
        project_health: project.health.clone(),
        ..TransferUsage::default()
    };
    for issue in &issue_rows {
        bump(&mut usage.issue_statuses, &issue.status);
        for id in strings(&issue.labels) {
            bump(&mut usage.labels, &id);
        }
    }
    for id in strings(&project.labels) {
        bump(&mut usage.labels, &id);
    }
    let source_settings = resolve_workspace_settings(&source.settings);
    let target_settings = resolve_workspace_settings(&target.settings);
    let mapping = plan_transfer_mappings(&source_settings, &target_settings, &usage, || uid("lb"));

    let mut blockers = mapping.blockers.clone();
    let tag_taken = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(target.id.as_str()))
        .filter(projects::Column::Key.eq(project.key.as_str()))
        .count(db)
        .await?
        > 0;
    if tag_taken {
        blockers.push(format!(
            "The project tag {} is already used in {}. Change the tag first.",
            project.key, target.name
        ));
    }
    let clash = db
        .query_one_raw(Statement::from_sql_and_values(
            db.get_database_backend(),
            r#"SELECT 1 FROM "issues" i
                WHERE i."workspaceId" = $1
                  AND (i."key" ~ $2
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(i."aliases", '[]'::jsonb)) AS a(v) WHERE a.v ~ $2))
                LIMIT 1"#,
            [target.id.as_str().into(), format!("^{}-[0-9]+$", project.key).into()],
        ))
        .await?;
    if clash.is_some() {
        blockers.push(format!(
            "{} already has issues keyed {}-…, so the keys would collide.",
            target.name, project.key
        ));
    }

    let guests =
        guests_of(db, &source_settings, &target_settings, &target, &project, caller, &mut blockers)
            .await?;
    let mut target_people: HashSet<String> = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(target.id.as_str()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.user_id)
        .collect();
    target_people.extend(guests.iter().map(|guest| guest.user_id.clone()));

    let outside =
        |person: &Option<String>| person.as_ref().is_some_and(|id| !target_people.contains(id));
    let lost_issues = issue_rows
        .iter()
        .filter(|issue| outside(&issue.assignee_id) || outside(&issue.reporter_id))
        .count();
    let unassigned = len(lost_issues + usize::from(outside(&project.lead_id)));

    let preview = ProjectTransferPreview {
        project: ProjectRef {
            id: project.id.clone(),
            name: project.name.clone(),
            key: project.key.clone(),
        },
        source: workspace_ref(&source),
        target: workspace_ref(&target),
        counts: TransferCounts {
            issues: len(issue_rows.len()),
            milestones: len(milestone_ids.len()),
            time_entries,
        },
        mappings: mapping.mappings.clone(),
        guests: guests
            .iter()
            .map(|guest| ProjectTransferGuest {
                user_id: guest.user_id.clone(),
                name: guest.name.clone(),
                email: guest.email.clone(),
                action: guest.action,
                role: guest.role.clone(),
            })
            .collect(),
        unassigned,
        blockers,
    };
    Ok(Plan {
        source,
        target,
        project,
        issues: issue_rows,
        milestone_ids,
        mapping,
        guests,
        target_people,
        preview,
    })
}

/// People limited to this project in the source: they keep their way in, as limited members of
/// the target.
async fn guests_of<C: ConnectionTrait>(
    db: &C,
    source_settings: &trama_contracts::settings::WorkspaceSettings,
    target_settings: &trama_contracts::settings::WorkspaceSettings,
    target: &workspaces::Model,
    project: &projects::Model,
    caller: &str,
    blockers: &mut Vec<String>,
) -> Result<Vec<CarriedGuest>, DbErr> {
    let carried: Vec<memberships::Model> = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(project.workspace_id.as_str()))
        .order_by_asc(memberships::Column::CreatedAt)
        .order_by_asc(memberships::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .filter(|row| {
            let stored = stored_member_access(row.access.as_ref());
            row.user_id != caller
                && limited_project_ids(&source_settings.roles, &row.role, stored.as_ref())
                    .is_some_and(|ids| ids.contains(&project.id))
        })
        .collect();
    if carried.is_empty() {
        return Ok(Vec::new());
    }
    let user_ids: Vec<String> = carried.iter().map(|row| row.user_id.clone()).collect();
    let people: HashMap<String, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(user_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|user| (user.id.clone(), user))
        .collect();
    let existing: HashMap<String, memberships::Model> = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(target.id.as_str()))
        .filter(memberships::Column::UserId.is_in(user_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.user_id.clone(), row))
        .collect();
    let mut out = Vec::new();
    for from in carried {
        let Some(user) = people.get(&from.user_id) else { continue };
        let (action, role, there) = match existing.get(&from.user_id) {
            None => {
                let Some(role) = guest_role_for(&target_settings.roles, &from.role) else {
                    blockers.push(format!(
                        "{} has no role a guest can hold (everything there is an owner or admin role), so {} could not be carried over.",
                        target.name, user.name
                    ));
                    continue;
                };
                (TransferGuestAction::Add, role, None)
            }
            Some(there) => {
                let stored = stored_member_access(there.access.as_ref());
                let action =
                    if limited_project_ids(&target_settings.roles, &there.role, stored.as_ref())
                        .is_none()
                    {
                        TransferGuestAction::Keep
                    } else {
                        TransferGuestAction::Extend
                    };
                (action, there.role.clone(), Some(there.clone()))
            }
        };
        out.push(CarriedGuest {
            user_id: user.id.clone(),
            name: user.name.clone(),
            email: user.email.clone(),
            action,
            role,
            from,
            existing: there,
        });
    }
    Ok(out)
}

// ───────────────────────────── applying ─────────────────────────────

/// `values.map(from).filter(present)` over a stored id list, without repeats.
fn remap(ids: &[String], map: &HashMap<String, Option<String>>) -> Vec<String> {
    let mapped: Vec<String> = ids.iter().filter_map(|id| map.get(id).cloned().flatten()).collect();
    unique(&mapped)
}

fn mapped(map: &StatusMap, stored: &str) -> String {
    map.get(stored).cloned().unwrap_or_else(|| stored.to_owned())
}

// one statement per kind of record, in the order the NestJS service runs them
#[allow(clippy::too_many_lines)]
async fn apply(txn: &DatabaseTransaction, plan: Plan) -> Result<Moved, Fail> {
    let Plan {
        source,
        target,
        project,
        issues: issue_rows,
        milestone_ids,
        mapping,
        target_people,
        ..
    } = &plan;
    let issue_ids: Vec<String> = issue_rows.iter().map(|issue| issue.id.clone()).collect();
    let in_moved: HashSet<&str> = issue_ids.iter().map(String::as_str).collect();
    let milestones_moved: HashSet<&str> = milestone_ids.iter().map(String::as_str).collect();
    let (src, tgt) = (source.id.as_str(), target.id.as_str());

    if !mapping.new_labels.is_empty() {
        let stored = resolve_workspace_settings(&target.settings).labels;
        let mut settings = target.settings.as_object().cloned().unwrap_or_default();
        let labels: Vec<_> = stored.iter().chain(mapping.new_labels.iter()).collect();
        settings.insert("labels".to_owned(), json!(labels));
        workspaces::ActiveModel {
            id: Set(target.id.clone()),
            settings: Set(Value::Object(settings)),
            ..Default::default()
        }
        .update(txn)
        .await?;
    }

    // people who are not in the target are cleared rather than left dangling
    let mut unassigned = 0_i64;
    for issue in issue_rows {
        let outside =
            |person: &Option<String>| person.as_ref().is_some_and(|id| !target_people.contains(id));
        let (lose_assignee, lose_reporter) =
            (outside(&issue.assignee_id), outside(&issue.reporter_id));
        if lose_assignee || lose_reporter {
            unassigned += 1;
        }
        let status = mapped(&mapping.statuses.issue, &issue.status);
        let labels = remap(&strings(&issue.labels), &mapping.labels);
        let milestone_ids: Vec<String> = strings(&issue.milestone_ids)
            .into_iter()
            .filter(|id| milestones_moved.contains(id.as_str()))
            .collect();
        // the parent link only works inside one workspace
        let lose_parent = issue.parent_id.as_deref().is_some_and(|id| !in_moved.contains(id));
        let lose_duplicate =
            issue.duplicate_of_id.as_deref().is_some_and(|id| !in_moved.contains(id));
        let new_status = (status != issue.status).then_some(status);
        let new_labels = (json!(labels) != issue.labels).then(|| json!(labels));
        let new_milestones =
            (json!(milestone_ids) != issue.milestone_ids).then(|| json!(milestone_ids));
        let touched = lose_assignee
            || lose_reporter
            || lose_parent
            || lose_duplicate
            || new_status.is_some()
            || new_labels.is_some()
            || new_milestones.is_some();
        if !touched {
            continue;
        }
        // only what changed is written, as TypeORM's `save` does
        let mut row = issues::ActiveModel { id: Set(issue.id.clone()), ..Default::default() };
        if lose_assignee {
            row.assignee_id = Set(None);
        }
        if lose_reporter {
            row.reporter_id = Set(None);
        }
        if let Some(status) = new_status {
            row.status = Set(status);
        }
        if let Some(labels) = new_labels {
            row.labels = Set(labels);
        }
        if let Some(milestones) = new_milestones {
            row.milestone_ids = Set(milestones);
        }
        if lose_parent {
            row.parent_id = Set(None);
        }
        if lose_duplicate {
            row.duplicate_of_id = Set(None);
        }
        row.update(txn).await?;
    }
    if !issue_ids.is_empty() {
        // issues elsewhere that point at a moved one lose that link (same-workspace foreign key)
        for column in ["parentId", "duplicateOfId"] {
            run_sql(
                txn,
                &format!(
                    r#"UPDATE "issues" SET "{column}" = NULL
                        WHERE "workspaceId" = $1 AND "{column}" = {any} AND NOT ("id" = {any})"#,
                    any = any_of(2)
                ),
                vec![src.into(), id_list(&issue_ids)],
            )
            .await?;
        }
        // one statement, so a parent and its children move together
        run_sql(
            txn,
            &format!(
                r#"UPDATE "issues" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "id" = {}"#,
                any_of(3)
            ),
            vec![tgt.into(), src.into(), id_list(&issue_ids)],
        )
        .await?;
    }

    run_sql(
        txn,
        r#"UPDATE "milestones" SET "workspaceId" = $1 WHERE "projectId" = $2"#,
        vec![tgt.into(), project.id.as_str().into()],
    )
    .await?;

    let new_health =
        project.health.as_ref().map(|health| mapped(&mapping.statuses.project_health, health));
    let lead = project.lead_id.clone().filter(|id| target_people.contains(id));
    projects::ActiveModel {
        id: Set(project.id.clone()),
        workspace_id: Set(target.id.clone()),
        status: Set(mapped(&mapping.statuses.project, &project.status)),
        health: Set(new_health),
        labels: Set(json!(remap(&strings(&project.labels), &mapping.labels))),
        lead_id: Set(lead),
        updated_at: Set(chrono::Utc::now().fixed_offset()),
        ..Default::default()
    }
    .update(txn)
    .await?;

    let time_entries = ids_returned(
        txn,
        &format!(
            r#"UPDATE "time_entries" SET "workspaceId" = $1, "projectId" = $3
                WHERE "workspaceId" = $2 AND ("projectId" = $3 OR "issueId" = {}) RETURNING "id""#,
            any_of(4)
        ),
        vec![tgt.into(), src.into(), project.id.as_str().into(), id_list(&issue_ids)],
    )
    .await?;

    let artifact_ids = ids_returned(
        txn,
        &format!(
            r#"UPDATE "artifacts" SET "workspaceId" = $1
                WHERE "workspaceId" = $2 AND "issueId" = {} RETURNING "id""#,
            any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&issue_ids)],
    )
    .await?;
    if !artifact_ids.is_empty() {
        run_sql(
            txn,
            &format!(
                r#"UPDATE "artifact_sources" SET "workspaceId" = $1 WHERE "artifactId" = {}"#,
                any_of(2)
            ),
            vec![tgt.into(), id_list(&artifact_ids)],
        )
        .await?;
    }

    let subjects: Vec<String> = std::iter::once(project.id.clone())
        .chain(milestone_ids.iter().cloned())
        .chain(issue_ids.iter().cloned())
        .chain(artifact_ids.iter().cloned())
        .collect();
    let comment_ids = ids_returned(
        txn,
        &format!(
            r#"UPDATE "comments" SET "workspaceId" = $1
                WHERE "workspaceId" = $2 AND "subject"->>'id' = {} RETURNING "id""#,
            any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&subjects)],
    )
    .await?;
    run_sql(
        txn,
        &format!(
            r#"UPDATE "domain_events" SET "workspaceId" = $1
                WHERE "workspaceId" = $2 AND "subject"->>'id' = {}"#,
            any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&subjects)],
    )
    .await?;

    // an edge with one end left behind cannot work across workspaces
    run_sql(
        txn,
        &format!(
            r#"DELETE FROM "dependencies"
                WHERE "workspaceId" = $1 AND (("fromId" = {any}) <> ("toId" = {any}))"#,
            any = any_of(2)
        ),
        vec![src.into(), id_list(&subjects)],
    )
    .await?;
    run_sql(
        txn,
        &format!(
            r#"UPDATE "dependencies" SET "workspaceId" = $1
                WHERE "workspaceId" = $2 AND "fromId" = {any} AND "toId" = {any}"#,
            any = any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&subjects)],
    )
    .await?;

    // files follow the records that use them, unless something staying behind still does
    let referencing: Vec<String> = subjects.iter().chain(comment_ids.iter()).cloned().collect();
    run_sql(
        txn,
        &format!(
            r#"UPDATE "uploads" u SET "workspaceId" = $1
                WHERE u."workspaceId" = $2
                  AND EXISTS (SELECT 1 FROM "upload_references" r WHERE r."uploadId" = u."id" AND r."workspaceId" = $2 AND r."subjectId" = {any})
                  AND NOT EXISTS (SELECT 1 FROM "upload_references" r WHERE r."uploadId" = u."id" AND r."workspaceId" = $2 AND NOT (r."subjectId" = {any}))"#,
            any = any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&referencing)],
    )
    .await?;
    run_sql(
        txn,
        &format!(
            r#"UPDATE "upload_references" r SET "workspaceId" = $1
                WHERE r."workspaceId" = $2 AND r."subjectId" = {}
                  AND EXISTS (SELECT 1 FROM "uploads" u WHERE u."id" = r."uploadId" AND u."workspaceId" = $1)"#,
            any_of(3)
        ),
        vec![tgt.into(), src.into(), id_list(&referencing)],
    )
    .await?;
    run_sql(
        txn,
        &format!(
            r#"DELETE FROM "upload_references" WHERE "workspaceId" = $1 AND "subjectId" = {}"#,
            any_of(2)
        ),
        vec![src.into(), id_list(&referencing)],
    )
    .await?;

    // pins and inbox items are per person and per workspace: they would point at the old address
    run_sql(
        txn,
        &format!(
            r#"DELETE FROM "favorites" WHERE "workspaceId" = $1 AND "subjectId" = {}"#,
            any_of(2)
        ),
        vec![src.into(), id_list(&subjects)],
    )
    .await?;
    run_sql(
        txn,
        &format!(
            r#"DELETE FROM "notifications" WHERE "workspaceId" = $1 AND "subject"->>'id' = {}"#,
            any_of(2)
        ),
        vec![src.into(), id_list(&referencing)],
    )
    .await?;

    // the next issue in the project continues after the highest number either side has used
    run_sql(
        txn,
        r#"INSERT INTO "workspace_counters" ("workspaceId", "name", "value")
           SELECT $1, "name", "value" FROM "workspace_counters" WHERE "workspaceId" = $2 AND "name" = $3
           ON CONFLICT ("workspaceId", "name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", EXCLUDED."value")"#,
        vec![tgt.into(), src.into(), format!("issue-key:{}", project.key).into()],
    )
    .await?;

    carry_guests(txn, &plan).await?;

    // someone who had put this project in the target workspace now simply sees it there
    run_sql(
        txn,
        r#"DELETE FROM "project_placements" WHERE "projectId" = $1 AND "workspaceId" = $2"#,
        vec![project.id.as_str().into(), tgt.into()],
    )
    .await?;

    let moved =
        projects::Entity::find_by_id(project.id.as_str()).one(txn).await?.ok_or_else(gone)?;
    Ok(Moved { time_entries: len(time_entries.len()), unassigned, project: moved, plan })
}

async fn carry_guests(txn: &DatabaseTransaction, plan: &Plan) -> Result<(), Fail> {
    let (project, target) = (&plan.project, &plan.target);
    for guest in &plan.guests {
        match guest.action {
            TransferGuestAction::Add => {
                memberships::ActiveModel {
                    id: Set(uid("mb")),
                    workspace_id: Set(target.id.clone()),
                    user_id: Set(guest.user_id.clone()),
                    role: Set(guest.role.clone()),
                    access: Set(Some(json!({
                        "projects": { "all": false, "projectIds": [project.id] },
                        "includeUnassigned": false,
                        "grants": [],
                    }))),
                    ..Default::default()
                }
                .insert(txn)
                .await?;
            }
            TransferGuestAction::Extend => {
                if let Some(existing) = &guest.existing
                    && let Some(access) = stored_member_access(existing.access.as_ref())
                {
                    let mut ids = access.projects.project_ids;
                    ids.push(project.id.clone());
                    let raw = existing.access.clone().unwrap_or(Value::Null);
                    memberships::ActiveModel {
                        id: Set(existing.id.clone()),
                        access: Set(Some(with_projects(&raw, &unique(&ids)))),
                        ..Default::default()
                    }
                    .update(txn)
                    .await?;
                }
            }
            TransferGuestAction::Keep => {}
        }
        // their way into the source project is gone with it
        let Some(access) = stored_member_access(guest.from.access.as_ref()) else { continue };
        let remaining: Vec<String> =
            access.projects.project_ids.iter().filter(|id| **id != project.id).cloned().collect();
        if guest.from.role == "guest" && remaining.is_empty() && !access.include_unassigned {
            memberships::Entity::delete_by_id(guest.from.id.as_str()).exec(txn).await?;
        } else {
            let raw = guest.from.access.clone().unwrap_or(Value::Null);
            memberships::ActiveModel {
                id: Set(guest.from.id.clone()),
                access: Set(Some(with_projects(&raw, &remaining))),
                ..Default::default()
            }
            .update(txn)
            .await?;
        }
    }
    Ok(())
}

// ───────────────────────────── after commit ─────────────────────────────

async fn announce(state: &AppState, plan: &Plan, actor: ActorRef) -> Result<(), AppError> {
    let (source, target, project) = (&plan.source, &plan.target, &plan.project);
    let events = Events::of(state);
    events
        .record(
            &state.db,
            RecordEvent::new(
                &target.id,
                actor,
                "project.transferred",
                SubjectRef { kind: SubjectType::Project, id: project.id.clone() },
            )
            .data(json!({
                "name": project.name,
                "key": project.key,
                "from": { "id": source.id, "slug": source.slug, "name": source.name },
                "issues": plan.issues.len(),
            }))
            .without_live(),
        )
        .await?;
    events.publish(&source.id, LiveChange::deleted(LiveEventEntity::Project, &project.id));
    events.publish(&source.id, LiveChange::updated(LiveEventEntity::Workspace, &source.id));
    events.publish(&target.id, LiveChange::created(LiveEventEntity::Project, &project.id));
    events.publish(&target.id, LiveChange::updated(LiveEventEntity::Workspace, &target.id));
    for guest in &plan.guests {
        if guest.action == TransferGuestAction::Add {
            // the membership event carries the person's id, as NestJS sends it
            events.publish(
                &target.id,
                LiveChange::created(LiveEventEntity::Membership, &guest.user_id),
            );
        }
    }
    Ok(())
}
