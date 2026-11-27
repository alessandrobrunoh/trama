//! The issues service (`issues.service.ts`): reading, creating, editing (one or many),
//! re-keying and deleting issues, and the external tracker pointer.
//!
//! Functions read the request's member access from the `trama_auth` task-local, as the NestJS
//! service does, so a narrowed member neither sees nor touches issues of other projects. Outside
//! a request (the importers, routing rules) nothing is hidden. Writes that announce themselves
//! take the [`AppState`]: they record the domain events after the transaction committed.
//!
//! Rows are `trama_entities::issues::Model`s; [`present`] turns one into the wire [`Issue`]. A
//! response must also run [`hide_invisible_parents`], which blanks a `parentId` the caller cannot
//! see.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, EntityTrait, IntoActiveModel,
    QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde_json::{Value, json};
use trama_auth::member_access::{
    apply_project_scope, assert_can_use_project, current_access, project_hidden,
};
use trama_common::refs;
use trama_common::util::{is_unique_violation, unique};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, ActorType, Priority, SubjectRef, SubjectType};
use trama_contracts::imports::ExternalRef;
use trama_contracts::issues::{Issue, IssueKind, IssueSource};
use trama_contracts::labels::LabelScope;
use trama_contracts::projects::UNASSIGNED_ISSUE_KEY_PREFIX;
use trama_contracts::status::{
    StatusEntry, load_status_catalog, require_status, status_filter_ids, status_ids_for_types,
};
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{comments, issues, milestones};
use trama_events::{Events, LiveChange, RecordEvent};
use trama_uploads::UploadSubject;
use trama_uploads::service::{assert_attachable, retained};
use trama_workspaces::labels;

use crate::facts::{StatusFacts, apply_status_facts, claim_assignee};
use crate::hierarchy::{
    Relation, assert_parent_link, assert_parent_link_locked, lock_hierarchy, lock_relations,
    read_relation,
};
use crate::keys::{IssueKeyChange, IssueRekeyReason, allocate_issue_numbers, issue_key_prefix};
use crate::rows::{present, strings};
use crate::thread_link::assert_thread_linkable;

/// An issue to create (`CreateIssueDto` after validation, or what an importer builds).
#[derive(Clone, Debug, PartialEq)]
pub struct NewIssue {
    /// Classification; it does not affect the issue key.
    pub kind: IssueKind,
    /// Title (trimmed when stored).
    pub title: String,
    /// Description.
    pub body: Option<String>,
    /// Where it came from; `agent` for an agent actor, else `manual`.
    pub source: Option<IssueSource>,
    /// Free-text reporter.
    pub reporter_name: Option<String>,
    /// The assignee: `None` leaves it to the claim rule, `Some(None)` is an explicit nobody.
    pub assignee_id: Option<Option<String>>,
    /// Project the issue is planned under.
    pub project_id: Option<String>,
    /// Id or key of the parent issue.
    pub parent_id: Option<String>,
    /// Priority; `none` by default.
    pub priority: Option<Priority>,
    /// Catalog id, or a legacy enum (the seeded status of that type); `backlog` by default.
    pub status: Option<String>,
    /// Link to the issue elsewhere.
    pub external_url: Option<String>,
    /// Delta thread link (http/https).
    pub thread_url: Option<String>,
    /// Story points.
    pub estimate: Option<f64>,
    /// The day the task should be done.
    pub due_date: Option<DateTime<Utc>>,
    /// Workspace label ids.
    pub labels: Option<Vec<String>>,
}

impl NewIssue {
    /// An issue with only the required fields.
    #[must_use]
    pub fn new(kind: IssueKind, title: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            body: None,
            source: None,
            reporter_name: None,
            assignee_id: None,
            project_id: None,
            parent_id: None,
            priority: None,
            status: None,
            external_url: None,
            thread_url: None,
            estimate: None,
            due_date: None,
            labels: None,
        }
    }
}

/// Changes to an issue (`IssueInput` of `issues.service.ts`). `None` leaves a field alone;
/// `Some(None)` clears the ones that can be cleared.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct IssueInput {
    /// New title.
    pub title: Option<String>,
    /// New classification; it does not change the key.
    pub kind: Option<IssueKind>,
    /// Story points.
    pub estimate: Option<Option<f64>>,
    /// The day the task should be done.
    pub due_date: Option<Option<DateTime<Utc>>>,
    /// Description.
    pub body: Option<Option<String>>,
    /// Free-text reporter.
    pub reporter_name: Option<Option<String>>,
    /// Assignee.
    pub assignee_id: Option<Option<String>>,
    /// Project the issue is planned under; clearing it drops that project's milestone.
    pub project_id: Option<Option<String>>,
    /// Id or key of the parent issue; `Some(None)` makes it a root issue.
    pub parent_id: Option<Option<String>>,
    /// Priority.
    pub priority: Option<Priority>,
    /// Catalog id, or a legacy enum (the seeded status of that type).
    pub status: Option<String>,
    /// Link to the issue elsewhere.
    pub external_url: Option<Option<String>>,
    /// Delta thread link (http/https).
    pub thread_url: Option<Option<String>>,
    /// At most one milestone per project, from the issue's project.
    pub milestone_ids: Option<Vec<String>>,
    /// Id or key of the issue this duplicates; setting it cancels the issue.
    pub duplicate_of_id: Option<Option<String>>,
    /// Workspace label ids; replaces the whole list.
    pub labels: Option<Vec<String>>,
}

impl IssueInput {
    /// The names of the fields this change carries (`Object.keys(patch)`), status excluded.
    fn fields(&self, from_kind: &str) -> Vec<&'static str> {
        let mut fields = Vec::new();
        let mut add = |present: bool, name: &'static str| {
            if present {
                fields.push(name);
            }
        };
        add(self.title.is_some(), "title");
        add(self.kind.is_some_and(|kind| kind.as_str() != from_kind), "kind");
        add(self.estimate.is_some(), "estimate");
        add(self.due_date.is_some(), "dueDate");
        add(self.body.is_some(), "body");
        add(self.reporter_name.is_some(), "reporterName");
        add(self.assignee_id.is_some(), "assigneeId");
        add(self.project_id.is_some(), "projectId");
        add(self.parent_id.is_some(), "parentId");
        add(self.priority.is_some(), "priority");
        add(self.external_url.is_some(), "externalUrl");
        add(self.thread_url.is_some(), "threadUrl");
        add(self.milestone_ids.is_some(), "milestoneIds");
        add(self.duplicate_of_id.is_some(), "duplicateOfId");
        add(self.labels.is_some(), "labels");
        fields
    }
}

/// One change applied to every issue of a bulk request. Labels are added / removed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BulkIssuePatch {
    /// Catalog id, or a legacy enum (the seeded status of that type).
    pub status: Option<String>,
    /// Priority.
    pub priority: Option<Priority>,
    /// Assignee; `Some(None)` clears it.
    pub assignee_id: Option<Option<String>>,
    /// Project; `Some(None)` clears it and drops that project's milestone.
    pub project_id: Option<Option<String>>,
    /// Labels to add.
    pub add_labels: Option<Vec<String>>,
    /// Labels to remove.
    pub remove_labels: Option<Vec<String>>,
}

/// The filters of [`list`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IssueFilter {
    /// Only this kind.
    pub kind: Option<IssueKind>,
    /// Catalog id, or a legacy enum (the seeded status of that type).
    pub status: Option<String>,
    /// Only issues of this assignee.
    pub assignee_id: Option<String>,
    /// Only issues of this project.
    pub project_id: Option<String>,
    /// Only issues in this milestone.
    pub milestone_id: Option<String>,
    /// Text in the title, key or an alias.
    pub q: Option<String>,
    /// Any of these priorities.
    pub priority: Vec<Priority>,
    /// Only issues still in play: backlog, todo, in progress, in review.
    pub open: bool,
    /// At most this many, newest first; 500 at the most (and by default).
    pub limit: Option<u64>,
}

/// Most issues [`list`] returns.
pub const LIST_MAX: u64 = 500;

/// The issue-status catalog of a workspace.
async fn issue_catalog<C: ConnectionTrait>(db: &C, workspace_id: &str) -> Vec<StatusEntry> {
    load_status_catalog(db, workspace_id).await.issue
}

fn now() -> DateTime<Utc> {
    Utc::now()
}

fn subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Issue, id: id.to_owned() }
}

/// `^[A-Za-z][A-Za-z0-9]*-\d+$`
fn is_issue_key(value: &str) -> bool {
    let Some((prefix, number)) = value.split_once('-') else { return false };
    prefix.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric())
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// Issues of the workspace, newest first, narrowed to the projects the caller can reach.
///
/// # Errors
///
/// A database error.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    filter: &IssueFilter,
) -> Result<Vec<issues::Model>, AppError> {
    let mut query = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(issues::Column::CreatedAt)
        .order_by_desc(issues::Column::Id);
    if let Some(kind) = filter.kind {
        query = query.filter(issues::Column::Kind.eq(kind.as_str()));
    }
    let status = filter.status.as_deref().filter(|s| !s.is_empty());
    if status.is_some() || filter.open {
        let catalog = issue_catalog(db, workspace_id).await;
        if let Some(status) = status {
            query = query.filter(issues::Column::Status.is_in(status_filter_ids(&catalog, status)));
        }
        if filter.open {
            query = query.filter(issues::Column::Status.is_in(status_ids_for_types(
                &catalog,
                &["backlog", "todo", "in_progress", "in_review"],
            )));
        }
    }
    if !filter.priority.is_empty() {
        query = query.filter(
            issues::Column::Priority.is_in(filter.priority.iter().map(|p| p.as_str().to_owned())),
        );
    }
    if let Some(assignee) = filter.assignee_id.as_deref().filter(|a| !a.is_empty()) {
        query = query.filter(issues::Column::AssigneeId.eq(assignee));
    }
    if let Some(project) = filter.project_id.as_deref().filter(|p| !p.is_empty()) {
        query = query.filter(issues::Column::ProjectId.eq(project));
    }
    if let Some(milestone) = filter.milestone_id.as_deref().filter(|m| !m.is_empty()) {
        query = query.filter(Expr::cust_with_values(
            r#""issues"."milestoneIds" @> $1"#,
            [json!([milestone])],
        ));
    }
    query = apply_project_scope(query, issues::Column::ProjectId);
    if let Some(q) = filter.q.as_deref().filter(|q| !q.is_empty()) {
        query = query.filter(Expr::cust_with_values(
            r#"("issues"."title" ILIKE $1 OR "issues"."key" ILIKE $1 OR "issues"."aliases"::text ILIKE $1)"#,
            [format!("%{q}%")],
        ));
    }
    // an explicit limit is capped at 500; omitting it used to return the whole table
    let limit = Ord::min(filter.limit.unwrap_or(LIST_MAX), LIST_MAX);
    Ok(query.limit(limit).all(db).await?)
}

/// The stored row `id_or_key` names (id, key in any case, or a retained alias), whoever may see
/// it.
async fn find_by_ref<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id_or_key: &str,
) -> Result<Option<issues::Model>, AppError> {
    let base = issues::Entity::find().filter(issues::Column::WorkspaceId.eq(workspace_id));
    if !is_issue_key(id_or_key) {
        return Ok(base.filter(issues::Column::Id.eq(id_or_key)).one(db).await?);
    }
    let key = id_or_key.to_uppercase();
    if let Some(row) = base.clone().filter(issues::Column::Key.eq(key.as_str())).one(db).await? {
        return Ok(Some(row));
    }
    Ok(base
        .filter(Expr::cust_with_values(r#""issues"."aliases" @> $1"#, [json!([key])]))
        .one(db)
        .await?)
}

/// `id_or_key`: id (`in_…`), key (`AUTH-142`, any case) or a previous project key alias.
///
/// # Errors
///
/// 404 `Issue "<ref>" not found`, also for an issue of a project the caller cannot reach.
pub async fn get<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id_or_key: &str,
) -> Result<issues::Model, AppError> {
    find_by_ref(db, workspace_id, id_or_key)
        .await?
        .filter(|row| !project_hidden(current_access().as_deref(), row.project_id.as_deref()))
        .ok_or_else(|| AppError::entity_not_found("Issue", id_or_key))
}

/// The ids among `ids` whose issue the caller may also see: a parent id may be returned only
/// then.
///
/// # Errors
///
/// A database error.
pub async fn visible_parent_ids<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashSet<String>, AppError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let parents: Vec<(String, Option<String>)> = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.iter().cloned()))
        .select_only()
        .columns([issues::Column::Id, issues::Column::ProjectId])
        .into_tuple()
        .all(db)
        .await?;
    let access = current_access();
    Ok(parents
        .into_iter()
        .filter(|(_, project)| !project_hidden(access.as_deref(), project.as_deref()))
        .map(|(id, _)| id)
        .collect())
}

/// Blanks the `parent_id` of every issue whose parent the caller cannot see.
///
/// # Errors
///
/// A database error.
pub async fn hide_invisible_parents<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issues: &mut [Issue],
) -> Result<(), AppError> {
    let parent_ids = unique(&issues.iter().filter_map(|i| i.parent_id.clone()).collect::<Vec<_>>());
    if parent_ids.is_empty() {
        return Ok(());
    }
    let visible = visible_parent_ids(db, workspace_id, &parent_ids).await?;
    for issue in issues {
        if issue.parent_id.as_ref().is_some_and(|parent| !visible.contains(parent)) {
            issue.parent_id = None;
        }
    }
    Ok(())
}

/// [`present`] for one row, without a parent the caller cannot see.
///
/// # Errors
///
/// A database error.
pub async fn present_visible<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    row: &issues::Model,
) -> Result<Issue, AppError> {
    let mut issue = [present(row)];
    hide_invisible_parents(db, workspace_id, &mut issue).await?;
    let [issue] = issue;
    Ok(issue)
}

/// Milestones must exist and belong to the issue's project; an issue may be in at most one
/// milestone per project.
async fn assert_milestones<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    milestone_ids: &[String],
    project_id: Option<&str>,
) -> Result<(), AppError> {
    if milestone_ids.is_empty() {
        return Ok(());
    }
    let found = milestones::Entity::find()
        .filter(milestones::Column::WorkspaceId.eq(workspace_id))
        .filter(milestones::Column::Id.is_in(milestone_ids.iter().cloned()))
        .all(db)
        .await?;
    if found.len() != milestone_ids.len() {
        return Err(AppError::bad_request(format!(
            "Unknown milestone in: {}",
            milestone_ids.join(", ")
        )));
    }
    let mut seen: HashSet<String> = HashSet::new();
    for id in milestone_ids {
        let Some(m) = found.iter().find(|m| &m.id == id) else { continue };
        if project_id != Some(m.project_id.as_str()) {
            return Err(AppError::bad_request(format!(
                "Milestone \"{}\" does not belong to this issue's project",
                m.name
            )));
        }
        if !seen.insert(m.project_id.clone()) {
            return Err(AppError::bad_request(
                "An issue can be in at most one milestone per project",
            ));
        }
    }
    Ok(())
}

/// Resolves a parent in this workspace and enforces the same project visibility as issue reads.
async fn resolve_parent_id<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    child_id: Option<&str>,
    parent_ref: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(parent_ref) = parent_ref else { return Ok(None) };
    let parent = get(db, workspace_id, parent_ref).await?;
    if Some(parent.id.as_str()) == child_id {
        return Err(AppError::bad_request("An issue cannot be its own parent"));
    }
    Ok(Some(parent.id))
}

/// Writes every column of `rows` (`save`). Pass the transaction the change runs in as `conn`.
///
/// # Errors
///
/// A database error.
pub async fn save_rows<C: ConnectionTrait>(
    conn: &C,
    rows: &[issues::Model],
) -> Result<(), AppError> {
    for row in rows {
        row.clone().into_active_model().reset_all().update(conn).await?;
    }
    Ok(())
}

fn json_strings(values: &[String]) -> Value {
    json!(values)
}

/// Creates an issue and records `issue.created`.
///
/// The key follows the project: its tag, or `UNPR` without one, numbered by the per-prefix
/// counter. A user actor creating an issue already `in_progress` without an assignee becomes the
/// assignee.
///
/// # Errors
///
/// 403 when the project is outside the request's access; 404 for a parent that does not exist or
/// is hidden; 400 for an unknown project, status, label, assignee, or an upload the caller cannot
/// attach.
#[allow(clippy::too_many_lines, reason = "one transaction: validate, number, insert, record")]
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    input: NewIssue,
) -> Result<issues::Model, AppError> {
    let db = &state.db;
    assert_can_use_project(input.project_id.as_deref())?;
    let parent_id = resolve_parent_id(db, workspace_id, None, input.parent_id.as_deref()).await?;
    refs::projects(db, workspace_id, &input.project_id.iter().cloned().collect::<Vec<_>>()).await?;
    let catalog = issue_catalog(db, workspace_id).await;
    let resolved =
        require_status(&catalog, input.status.as_deref().unwrap_or("backlog"), "status")?;
    let assignee_id = claim_assignee(
        actor,
        None,
        &resolved.kind,
        input.assignee_id.clone().flatten(),
        input.assignee_id.is_some(),
    );
    refs::users(db, workspace_id, std::slice::from_ref(&assignee_id)).await?;
    assert_attachable(db, workspace_id, input.body.as_deref()).await?;
    let mut facts = StatusFacts::default();
    apply_status_facts(&mut facts, &resolved.kind, now());

    let txn = db.begin().await?;
    let id = uid("in");
    if let Some(parent_id) = &parent_id {
        assert_parent_link(&txn, workspace_id, &id, parent_id).await?;
        let parent = lock_relations(&txn, workspace_id, std::slice::from_ref(parent_id)).await?;
        let visible = parent
            .get(parent_id)
            .is_some_and(|p| !project_hidden(current_access().as_deref(), p.project_id.as_deref()));
        if !visible {
            return Err(AppError::entity_not_found("Issue", parent_id));
        }
    }
    let prefix = issue_key_prefix(&txn, workspace_id, input.project_id.as_deref()).await?;
    let number = allocate_issue_numbers(&txn, workspace_id, &prefix, 1).await?[0];
    let assigned_labels =
        labels::assign(&txn, workspace_id, input.labels.as_deref(), Some(LabelScope::Issue), None)
            .await?
            .unwrap_or_default();
    let at = now().fixed_offset();
    let row = issues::ActiveModel {
        id: Set(id),
        workspace_id: Set(workspace_id.to_owned()),
        key: Set(format!("{prefix}-{number}")),
        number: Set(number),
        kind: Set(input.kind.as_str().to_owned()),
        title: Set(trama_contracts::js::trim(&input.title).to_owned()),
        body: Set(input.body),
        source: Set(input
            .source
            .unwrap_or(if actor.kind == ActorType::Agent {
                IssueSource::Agent
            } else {
                IssueSource::Manual
            })
            .as_str()
            .to_owned()),
        reporter_name: Set(input.reporter_name),
        reporter_id: Set(if actor.kind == ActorType::User { actor.id.clone() } else { None }),
        priority: Set(input.priority.unwrap_or(Priority::None).as_str().to_owned()),
        status: Set(resolved.id.clone()),
        duplicate_of_id: Set(None),
        external_url: Set(input.external_url),
        created_at: Set(at),
        updated_at: Set(at),
        assignee_id: Set(assignee_id),
        milestone_ids: Set(json!([])),
        estimate: Set(input.estimate),
        started_at: Set(facts.started_at.map(|d| d.fixed_offset())),
        completed_at: Set(facts.completed_at.map(|d| d.fixed_offset())),
        aliases: Set(json!([])),
        project_id: Set(input.project_id),
        labels: Set(json_strings(&assigned_labels)),
        external_ref: Set(None),
        parent_id: Set(parent_id),
        thread_url: Set(input.thread_url),
        due_date: Set(input.due_date.map(|d| d.fixed_offset())),
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;

    retained(
        db,
        workspace_id,
        None,
        row.body.as_deref(),
        Some(&UploadSubject::issue(row.id.clone(), row.project_id.clone())),
    )
    .await?;
    Events::of(state)
        .record(
            db,
            RecordEvent::new(workspace_id, actor.clone(), "issue.created", subject(&row.id)).data(
                json!({
                    "key": row.key,
                    "kind": row.kind,
                    "title": row.title,
                    "status": row.status,
                    "assigneeId": row.assignee_id,
                }),
            ),
        )
        .await?;
    Ok(row)
}

/// An update validated and applied to the row in memory, waiting to be persisted and announced.
struct Prepared {
    row: issues::Model,
    patch: IssueInput,
    from: String,
    from_key: String,
    from_kind: String,
    from_project_id: Option<String>,
    previous_assignee_id: Option<String>,
    project_changed: bool,
    key_change: Option<IssueKeyChange>,
}

/// Validates `patch` and applies it to `row` in memory; nothing is persisted yet.
#[allow(clippy::too_many_lines, reason = "one rule per field, in the order NestJS checks them")]
async fn prepare_update<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    actor: &ActorRef,
    mut row: issues::Model,
    mut patch: IssueInput,
    refs_checked: bool,
    catalog: &[StatusEntry],
) -> Result<Prepared, AppError> {
    assert_thread_linkable(
        &row.key,
        row.thread_url.as_deref(),
        patch.thread_url.as_ref().and_then(Option::as_deref),
    )?;
    let previous_assignee_id = row.assignee_id.clone();
    if !refs_checked {
        if let Some(assignee) = &patch.assignee_id {
            refs::users(db, workspace_id, std::slice::from_ref(assignee)).await?;
        }
        if let Some(Some(project)) = &patch.project_id {
            refs::projects(db, workspace_id, std::slice::from_ref(project)).await?;
        }
    }
    let from = row.status.clone();
    let from_key = row.key.clone();
    let from_kind = row.kind.clone();
    let from_project_id = row.project_id.clone();
    let mut duplicate_of_id = row.duplicate_of_id.clone();
    if let Some(duplicate) = patch.duplicate_of_id.clone() {
        match duplicate {
            None => duplicate_of_id = None,
            Some(reference) => {
                if let Some(status) = &patch.status
                    && require_status(catalog, status, "status")?.kind != "canceled"
                {
                    return Err(AppError::bad_request(
                        "Marking an issue as a duplicate sets its status to \"canceled\"",
                    ));
                }
                let target = get(db, workspace_id, &reference).await?;
                if target.id == row.id {
                    return Err(AppError::bad_request("An issue cannot duplicate itself"));
                }
                duplicate_of_id = Some(target.id);
                patch.status = Some("canceled".to_owned());
            }
        }
    }

    let next_project_id = match &patch.project_id {
        Some(project) => project.clone(),
        None => row.project_id.clone(),
    };
    let current_milestones = strings(&row.milestone_ids);
    let mut next_milestones = current_milestones.clone();
    if let Some(requested) = &patch.milestone_ids {
        next_milestones = unique(requested);
        assert_milestones(db, workspace_id, &next_milestones, next_project_id.as_deref()).await?;
    } else if patch.project_id.is_some() && !current_milestones.is_empty() {
        let kept: HashSet<String> = milestones::Entity::find()
            .filter(milestones::Column::WorkspaceId.eq(workspace_id))
            .filter(milestones::Column::Id.is_in(current_milestones.iter().cloned()))
            .all(db)
            .await?
            .into_iter()
            .filter(|m| next_project_id.as_deref() == Some(m.project_id.as_str()))
            .map(|m| m.id)
            .collect();
        next_milestones = current_milestones.into_iter().filter(|id| kept.contains(id)).collect();
    }
    row.milestone_ids = json_strings(&next_milestones);

    if let Some(title) = &patch.title {
        row.title = trama_contracts::js::trim(title).to_owned();
    }
    if let Some(kind) = patch.kind {
        kind.as_str().clone_into(&mut row.kind);
    }
    if let Some(estimate) = patch.estimate {
        row.estimate = estimate;
    }
    if let Some(due_date) = patch.due_date {
        row.due_date = due_date.map(|d| d.fixed_offset());
    }
    if let Some(body) = &patch.body {
        row.body.clone_from(body);
    }
    if let Some(reporter) = &patch.reporter_name {
        row.reporter_name.clone_from(reporter);
    }
    if let Some(assignee) = &patch.assignee_id {
        row.assignee_id.clone_from(assignee);
    }
    if let Some(project) = &patch.project_id {
        row.project_id.clone_from(project);
    }
    if let Some(parent) = &patch.parent_id {
        row.parent_id.clone_from(parent);
    }
    if let Some(priority) = patch.priority {
        priority.as_str().clone_into(&mut row.priority);
    }
    if let Some(url) = &patch.external_url {
        row.external_url.clone_from(url);
    }
    if let Some(url) = &patch.thread_url {
        row.thread_url.clone_from(url);
    }
    if let Some(requested) = &patch.labels {
        let current = strings(&row.labels);
        let assigned = labels::assign(
            db,
            workspace_id,
            Some(requested),
            Some(LabelScope::Issue),
            Some(&current),
        )
        .await?
        .unwrap_or_default();
        row.labels = json_strings(&assigned);
    }
    let from_type = require_status(catalog, &from, "status")?.kind.clone();
    let mut to_type = from_type.clone();
    if let Some(status) = &patch.status {
        let resolved = require_status(catalog, status, "status")?;
        row.status.clone_from(&resolved.id);
        to_type.clone_from(&resolved.kind);
        if resolved.id != from {
            let mut facts = StatusFacts {
                started_at: row.started_at.map(|d| d.with_timezone(&Utc)),
                completed_at: row.completed_at.map(|d| d.with_timezone(&Utc)),
            };
            apply_status_facts(&mut facts, &resolved.kind, now());
            row.started_at = facts.started_at.map(|d| d.fixed_offset());
            row.completed_at = facts.completed_at.map(|d| d.fixed_offset());
        }
    }
    let claimed = claim_assignee(
        actor,
        Some(&from_type),
        &to_type,
        row.assignee_id.clone(),
        patch.assignee_id.is_some(),
    );
    if claimed != row.assignee_id {
        refs::users(db, workspace_id, std::slice::from_ref(&claimed)).await?;
        row.assignee_id = claimed;
    }
    row.duplicate_of_id = duplicate_of_id;
    row.updated_at = now().fixed_offset();
    let project_changed =
        patch.project_id.as_ref().is_some_and(|project| project != &from_project_id);
    Ok(Prepared {
        row,
        patch,
        from,
        from_key,
        from_kind,
        from_project_id,
        previous_assignee_id,
        project_changed,
        key_change: None,
    })
}

/// The key prefix follows the project; keep the previous key as an alias.
async fn rekey<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    p: &mut Prepared,
    prefix: &str,
) -> Result<IssueKeyChange, AppError> {
    let number = allocate_issue_numbers(conn, workspace_id, prefix, 1).await?[0];
    let from = p.from_key.clone();
    let to = format!("{prefix}-{number}");
    let mut aliases = strings(&p.row.aliases);
    if !aliases.contains(&from) {
        aliases.push(from.clone());
    }
    p.row.aliases = json_strings(&aliases);
    p.row.number = number;
    p.row.key.clone_from(&to);
    Ok(IssueKeyChange {
        issue_id: p.row.id.clone(),
        from,
        to,
        from_project_id: p.from_project_id.clone(),
        to_project_id: p.row.project_id.clone(),
        reason: IssueRekeyReason::ProjectChanged,
    })
}

/// Copies what the locked relation decides (key, number, aliases) onto the row and re-keys it
/// when its project changed.
async fn settle_key<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    p: &mut Prepared,
    relation: &Relation,
    target_prefix: Option<&str>,
) -> Result<(), AppError> {
    p.from_key.clone_from(&relation.key);
    p.from_project_id.clone_from(&relation.project_id);
    p.row.key.clone_from(&relation.key);
    p.row.number = relation.number;
    p.row.aliases.clone_from(&relation.aliases);
    p.project_changed = p.patch.project_id.is_some() && p.row.project_id != relation.project_id;
    p.key_change = if p.project_changed {
        let prefix = target_prefix.unwrap_or(UNASSIGNED_ISSUE_KEY_PREFIX);
        Some(rekey(conn, workspace_id, p, prefix).await?)
    } else {
        None
    };
    Ok(())
}

/// Edits an issue and records `issue.rekeyed` (when it changed project), `issue.updated` and
/// `issue.status_changed` as they apply.
///
/// A parent change locks the workspace hierarchy and refuses a link that would make a cycle.
/// Changing project re-keys the issue under the new project's tag and keeps the old key as an
/// alias; its milestones are pruned to the new project's.
///
/// # Errors
///
/// 404 for an unknown or hidden issue or parent; 403 for a project outside the request's access;
/// 400 for an invalid reference, status, label, milestone or hierarchy; 409 when the hierarchy
/// changed under the update.
pub async fn update(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id_or_key: &str,
    mut patch: IssueInput,
) -> Result<issues::Model, AppError> {
    let db = &state.db;
    let row = get(db, workspace_id, id_or_key).await?;
    if let Some(project) = &patch.project_id {
        assert_can_use_project(project.as_deref())?;
    }
    if let Some(parent) = &patch.parent_id {
        let resolved =
            resolve_parent_id(db, workspace_id, Some(&row.id), parent.as_deref()).await?;
        patch.parent_id = Some(resolved);
    }
    let previous_body = row.body.clone();
    let body_changed = patch.body.is_some();
    let catalog = issue_catalog(db, workspace_id).await;
    let mut prepared = prepare_update(db, workspace_id, actor, row, patch, false, &catalog).await?;
    if body_changed {
        assert_attachable(db, workspace_id, prepared.row.body.as_deref()).await?;
    }

    let txn = db.begin().await?;
    let target_prefix = match &prepared.patch.project_id {
        Some(project) => Some(issue_key_prefix(&txn, workspace_id, project.as_deref()).await?),
        None => None,
    };
    let row_id = prepared.row.id.clone();
    let relation = if let Some(next_parent) = prepared.patch.parent_id.clone() {
        lock_hierarchy(&txn, workspace_id).await?;
        let observed = read_relation(&txn, workspace_id, &row_id).await?;
        let mut ids = vec![row_id.clone()];
        ids.extend(observed.parent_id.clone());
        ids.extend(next_parent.clone());
        let relations = lock_relations(&txn, workspace_id, &unique(&ids)).await?;
        let current = relations
            .get(&row_id)
            .filter(|c| !project_hidden(current_access().as_deref(), c.project_id.as_deref()))
            .ok_or_else(|| AppError::entity_not_found("Issue", &row_id))?;
        if current.parent_id != observed.parent_id {
            return Err(AppError::conflict("Issue hierarchy changed; retry the update"));
        }
        if let Some(previous) = &current.parent_id
            && !relations.contains_key(previous)
        {
            return Err(AppError::entity_not_found("Issue", previous));
        }
        if let Some(next) = &next_parent {
            let visible = relations.get(next).is_some_and(|p| {
                !project_hidden(current_access().as_deref(), p.project_id.as_deref())
            });
            if !visible {
                return Err(AppError::entity_not_found("Issue", next));
            }
            assert_parent_link_locked(&txn, workspace_id, &row_id, next).await?;
        }
        if prepared.patch.project_id.is_none() {
            prepared.row.project_id.clone_from(&current.project_id);
        }
        prepared.row.parent_id = next_parent;
        current.clone()
    } else {
        let relations = lock_relations(&txn, workspace_id, std::slice::from_ref(&row_id)).await?;
        let current = relations
            .get(&row_id)
            .filter(|c| !project_hidden(current_access().as_deref(), c.project_id.as_deref()))
            .ok_or_else(|| AppError::entity_not_found("Issue", &row_id))?;
        if prepared.patch.project_id.is_none() {
            prepared.row.project_id.clone_from(&current.project_id);
        }
        prepared.row.parent_id.clone_from(&current.parent_id);
        current.clone()
    };
    if let Some(Some(next)) = &prepared.patch.thread_url {
        // the row is locked now: a concurrent link that committed first wins
        let stored: Option<Option<String>> = issues::Entity::find_by_id(row_id.clone())
            .select_only()
            .column(issues::Column::ThreadUrl)
            .into_tuple()
            .one(&txn)
            .await?;
        assert_thread_linkable(&relation.key, stored.flatten().as_deref(), Some(next))?;
    }
    settle_key(&txn, workspace_id, &mut prepared, &relation, target_prefix.as_deref()).await?;
    save_rows(&txn, std::slice::from_ref(&prepared.row)).await?;
    txn.commit().await?;

    if body_changed {
        retained(
            db,
            workspace_id,
            previous_body.as_deref(),
            prepared.row.body.as_deref(),
            Some(&UploadSubject::issue(row_id, prepared.row.project_id.clone())),
        )
        .await?;
    }
    record_update(state, workspace_id, actor, &prepared).await?;
    Ok(prepared.row)
}

/// Resolves ids / keys / aliases to issue rows of this workspace (input order, duplicates
/// folded).
///
/// # Errors
///
/// 404 `Issue not found: <refs>` naming every reference that does not exist or is hidden, so
/// nothing is half-applied.
pub async fn get_many<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    refs: &[String],
) -> Result<Vec<issues::Model>, AppError> {
    let wanted = unique(refs);
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<String> =
        wanted.iter().filter(|r| is_issue_key(r)).map(|r| r.to_uppercase()).collect();
    let ids: Vec<String> = wanted.iter().filter(|r| !is_issue_key(r)).cloned().collect();
    let mut any = Condition::any();
    if !ids.is_empty() {
        any = any.add(issues::Column::Id.is_in(ids));
    }
    if !keys.is_empty() {
        any = any.add(issues::Column::Key.is_in(keys.clone())).add(Expr::cust_with_values(
            r#"EXISTS (SELECT 1 FROM jsonb_array_elements_text("issues"."aliases") a WHERE a IN (SELECT jsonb_array_elements_text($1::jsonb)))"#,
            [json!(keys)],
        ));
    }
    let found = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(any)
        .all(db)
        .await?;
    let access = current_access();
    let mut rows: Vec<issues::Model> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for reference in &wanted {
        let row = if is_issue_key(reference) {
            let key = reference.to_uppercase();
            // a key hit wins over an alias, matching `get`
            found
                .iter()
                .find(|row| row.key == key)
                .or_else(|| found.iter().find(|row| strings(&row.aliases).contains(&key)))
        } else {
            found.iter().find(|row| &row.id == reference)
        };
        match row {
            Some(row) if !project_hidden(access.as_deref(), row.project_id.as_deref()) => {
                if !rows.iter().any(|r| r.id == row.id) {
                    rows.push(row.clone());
                }
            }
            _ => missing.push(reference),
        }
    }
    if !missing.is_empty() {
        return Err(AppError::not_found(format!("Issue not found: {}", missing.join(", "))));
    }
    Ok(rows)
}

/// Applies one patch to many issues all-or-nothing: every issue is validated first, the writes
/// happen in one transaction, and the events are recorded once it committed (a failure leaves
/// nothing behind). Labels are added / removed, not replaced.
///
/// # Errors
///
/// 400 for an empty patch, a label both added and removed, or an unknown reference; 403 for a
/// project outside the request's access; 404 when an issue vanished meanwhile.
pub async fn update_many(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    rows: Vec<issues::Model>,
    patch: BulkIssuePatch,
) -> Result<Vec<issues::Model>, AppError> {
    let db = &state.db;
    let touches_anything = patch.status.is_some()
        || patch.priority.is_some()
        || patch.assignee_id.is_some()
        || patch.project_id.is_some()
        || patch.add_labels.is_some()
        || patch.remove_labels.is_some();
    if !touches_anything {
        return Err(AppError::bad_request("patch must change at least one field"));
    }
    let add_labels = unique(patch.add_labels.as_deref().unwrap_or_default());
    let remove_labels = unique(patch.remove_labels.as_deref().unwrap_or_default());
    if add_labels.iter().any(|id| remove_labels.contains(id)) {
        return Err(AppError::bad_request("A label cannot be both added and removed"));
    }
    if let Some(project) = &patch.project_id {
        assert_can_use_project(project.as_deref())?;
    }
    // one lookup per reference for the whole batch instead of one per issue
    if let Some(assignee) = &patch.assignee_id {
        refs::users(db, workspace_id, std::slice::from_ref(assignee)).await?;
    }
    if let Some(Some(project)) = &patch.project_id {
        refs::projects(db, workspace_id, std::slice::from_ref(project)).await?;
    }
    let all_labels: Vec<String> = add_labels.iter().chain(&remove_labels).cloned().collect();
    labels::assign(
        db,
        workspace_id,
        Some(&all_labels),
        Some(LabelScope::Issue),
        Some(&remove_labels),
    )
    .await?;

    let catalog = issue_catalog(db, workspace_id).await;
    let mut prepared: Vec<Prepared> = Vec::with_capacity(rows.len());
    for row in rows {
        let mut next = IssueInput {
            status: patch.status.clone(),
            priority: patch.priority,
            assignee_id: patch.assignee_id.clone(),
            project_id: patch.project_id.clone(),
            ..IssueInput::default()
        };
        if !add_labels.is_empty() || !remove_labels.is_empty() {
            let mut merged = strings(&row.labels);
            merged.extend(add_labels.iter().cloned());
            next.labels =
                Some(unique(&merged).into_iter().filter(|l| !remove_labels.contains(l)).collect());
        }
        prepared.push(prepare_update(db, workspace_id, actor, row, next, true, &catalog).await?);
    }

    let txn = db.begin().await?;
    let ids: Vec<String> = prepared.iter().map(|p| p.row.id.clone()).collect();
    let target_prefix = match &patch.project_id {
        Some(project) => Some(issue_key_prefix(&txn, workspace_id, project.as_deref()).await?),
        None => None,
    };
    let relations = lock_relations(&txn, workspace_id, &ids).await?;
    if relations.len() != ids.len() {
        return Err(AppError::not_found("An issue in the batch no longer exists"));
    }
    for p in &mut prepared {
        let relation = relations[&p.row.id].clone();
        if p.patch.project_id.is_none() {
            p.row.project_id.clone_from(&relation.project_id);
        }
        p.row.parent_id.clone_from(&relation.parent_id);
        settle_key(&txn, workspace_id, p, &relation, target_prefix.as_deref()).await?;
    }
    let saved: Vec<issues::Model> = prepared.iter().map(|p| p.row.clone()).collect();
    save_rows(&txn, &saved).await?;
    txn.commit().await?;
    for p in &prepared {
        record_update(state, workspace_id, actor, p).await?;
    }
    Ok(saved)
}

async fn record_update(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    p: &Prepared,
) -> Result<(), AppError> {
    let events = Events::of(state);
    let db = &state.db;
    let row = &p.row;
    let mut fields = p.patch.fields(&p.from_kind);
    if row.assignee_id != p.previous_assignee_id && !fields.contains(&"assigneeId") {
        fields.push("assigneeId");
    }
    if let Some(change) = &p.key_change {
        events
            .record(
                db,
                RecordEvent::new(workspace_id, actor.clone(), "issue.rekeyed", subject(&row.id))
                    .data(json!({
                        "key": row.key,
                        "from": change.from,
                        "to": row.key,
                        "fromProjectId": change.from_project_id,
                        "toProjectId": change.to_project_id,
                        "reason": change.reason.as_str(),
                    })),
            )
            .await?;
    }
    if !fields.is_empty() {
        let mut data = json!({ "key": row.key, "fields": fields });
        if row.assignee_id != p.previous_assignee_id {
            data["assignee"] = json!({ "from": p.previous_assignee_id, "to": row.assignee_id });
        }
        events
            .record(
                db,
                RecordEvent::new(workspace_id, actor.clone(), "issue.updated", subject(&row.id))
                    .data(data),
            )
            .await?;
    }
    if p.patch.status.as_ref().is_some_and(|status| *status != p.from) {
        events
            .record(
                db,
                RecordEvent::new(
                    workspace_id,
                    actor.clone(),
                    "issue.status_changed",
                    subject(&row.id),
                )
                .data(json!({ "key": row.key, "from": p.from, "to": row.status })),
            )
            .await?;
    }
    Ok(())
}

/// Attaches (or, with `None`, detaches) the external tracker issue this one mirrors. The pointer
/// is a read-only mirror: it never changes the status. Records `issue.updated`.
///
/// # Errors
///
/// 404 for an unknown or hidden issue; 409 naming the issue that already carries the external
/// issue (one external issue belongs to one issue).
pub async fn set_external_ref(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id_or_key: &str,
    external: Option<&ExternalRef>,
) -> Result<Issue, AppError> {
    let db = &state.db;
    let mut row = get(db, workspace_id, id_or_key).await?;
    let previous: Option<ExternalRef> =
        row.external_ref.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok());
    row.external_ref = external.and_then(|e| serde_json::to_value(e).ok());
    if let Some(external) = external
        && row.external_url.as_deref().is_none_or(str::is_empty)
    {
        row.external_url = Some(external.url.clone());
    }
    if external.is_none()
        && let Some(previous) = &previous
        && row.external_url.as_deref() == Some(previous.url.as_str())
    {
        row.external_url = None;
    }
    row.updated_at = now().fixed_offset();
    let update = issues::Entity::update_many()
        .set(issues::ActiveModel {
            external_ref: Set(row.external_ref.clone()),
            external_url: Set(row.external_url.clone()),
            updated_at: Set(row.updated_at),
            ..Default::default()
        })
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.eq(row.id.as_str()))
        .exec(db)
        .await;
    if let Err(err) = update {
        if let Some(external) = external
            && is_unique_violation(&err)
        {
            let other = issues::Entity::find()
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(Expr::cust_with_values(
                    r#""issues"."externalRef"->>'provider' = $1 AND "issues"."externalRef"->>'id' = $2"#,
                    [external.provider.as_str().to_owned(), external.id.clone()],
                ))
                .one(db)
                .await?;
            return Err(AppError::conflict(format!(
                "{} is already {}",
                external.key.as_deref().unwrap_or(&external.id),
                other.map_or_else(
                    || "linked to another issue".to_owned(),
                    |other| format!("linked to {}", other.key)
                ),
            )));
        }
        return Err(err.into());
    }
    let updated = present_visible(db, workspace_id, &get(db, workspace_id, &row.id).await?).await?;
    let external_data = external.map_or(Value::Null, |e| {
        let mut data = json!({ "provider": e.provider.as_str(), "origin": e.origin.as_str() });
        if let Some(key) = &e.key {
            data["key"] = json!(key);
        }
        data
    });
    Events::of(state)
        .record(
            db,
            RecordEvent::new(workspace_id, actor.clone(), "issue.updated", subject(&updated.id))
                .data(json!({
                    "key": updated.key,
                    "fields": ["externalRef"],
                    "external": external_data,
                })),
        )
        .await?;
    Ok(updated)
}

/// What [`refresh_external_ref`] stores from a fresh read of the external issue.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExternalRefRefresh {
    /// The tracker's own state name.
    pub state: Option<String>,
    /// Normalized state.
    pub state_type: Option<trama_contracts::imports::ExternalStateType>,
    /// When it was read.
    pub synced_at: Option<String>,
    /// What people call it.
    pub key: Option<String>,
    /// Link.
    pub url: Option<String>,
}

/// Stores a freshly read external status. Quiet on purpose (no domain event, only a live event):
/// it is a mirror, not a change of the work.
///
/// # Errors
///
/// 404 for an unknown or hidden issue; 400 `This issue is not linked to an external issue`.
pub async fn refresh_external_ref(
    state: &AppState,
    workspace_id: &str,
    id_or_key: &str,
    refresh: ExternalRefRefresh,
) -> Result<Issue, AppError> {
    let db = &state.db;
    let row = get(db, workspace_id, id_or_key).await?;
    let mut external: ExternalRef =
        row.external_ref.clone().and_then(|v| serde_json::from_value(v).ok()).ok_or_else(|| {
            AppError::bad_request("This issue is not linked to an external issue")
        })?;
    if let Some(state) = refresh.state {
        external.state = Some(state);
    }
    if let Some(state_type) = refresh.state_type {
        external.state_type = Some(state_type);
    }
    if let Some(synced_at) = refresh.synced_at {
        external.synced_at = Some(synced_at);
    }
    if let Some(key) = refresh.key {
        external.key = Some(key);
    }
    if let Some(url) = refresh.url {
        external.url = url;
    }
    issues::Entity::update_many()
        .set(issues::ActiveModel {
            external_ref: Set(serde_json::to_value(&external).ok()),
            ..Default::default()
        })
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.eq(row.id.as_str()))
        .exec(db)
        .await?;
    let updated = present_visible(db, workspace_id, &get(db, workspace_id, &row.id).await?).await?;
    Events::of(state)
        .publish(workspace_id, LiveChange::updated(LiveEventEntity::Issue, &updated.id));
    Ok(updated)
}

/// Deletes an issue and records `issue.deleted`; its children survive as root issues
/// (`issue.updated` for each), its comments go with it and issues that duplicated it forget it.
///
/// # Errors
///
/// 404 for an unknown or hidden issue (or one whose neighbours are hidden); 409 when the
/// hierarchy changed under the delete.
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id_or_key: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    let row = get(db, workspace_id, id_or_key).await?;
    let txn = db.begin().await?;
    let (removed, detached) =
        delete_rows(&txn, workspace_id, std::slice::from_ref(&row.id), id_or_key).await?;
    txn.commit().await?;
    record_removals(state, workspace_id, actor, &removed, &detached).await
}

/// Deletes many issues in one transaction, with the same effects as [`remove`] for each.
///
/// # Errors
///
/// As [`remove`]; nothing is deleted then.
pub async fn remove_many(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    rows: &[issues::Model],
) -> Result<(), AppError> {
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let Some(first) = ids.first() else { return Ok(()) };
    let txn = state.db.begin().await?;
    let (removed, detached) = delete_rows(&txn, workspace_id, &ids, first).await?;
    txn.commit().await?;
    record_removals(state, workspace_id, actor, &removed, &detached).await
}

async fn record_removals(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    removed: &[issues::Model],
    detached: &[issues::Model],
) -> Result<(), AppError> {
    let events = Events::of(state);
    for row in removed {
        events
            .record(
                &state.db,
                RecordEvent::new(workspace_id, actor.clone(), "issue.deleted", subject(&row.id))
                    .data(json!({
                        "key": row.key,
                        "title": row.title,
                        "projectId": row.project_id,
                    })),
            )
            .await?;
    }
    for issue in detached {
        events
            .record(
                &state.db,
                RecordEvent::new(workspace_id, actor.clone(), "issue.updated", subject(&issue.id))
                    .data(json!({ "key": issue.key, "fields": ["parentId"] })),
            )
            .await?;
    }
    Ok(())
}

/// Locks the hierarchy and every affected row, detaches the surviving children, and deletes the
/// issues with their comments. Returns the deleted rows and the children that lost their parent.
async fn delete_rows<C: ConnectionTrait>(
    txn: &C,
    workspace_id: &str,
    ids: &[String],
    issue_ref: &str,
) -> Result<(Vec<issues::Model>, Vec<issues::Model>), AppError> {
    lock_hierarchy(txn, workspace_id).await?;
    let target_relations: Vec<(String, Option<String>)> = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.iter().cloned()))
        .select_only()
        .columns([issues::Column::Id, issues::Column::ParentId])
        .into_tuple()
        .all(txn)
        .await?;
    if target_relations.len() != ids.len() {
        return Err(AppError::entity_not_found("Issue", issue_ref));
    }
    let parent_ids = unique(
        &target_relations.iter().filter_map(|(_, parent)| parent.clone()).collect::<Vec<_>>(),
    );
    let mut related = Condition::any()
        .add(issues::Column::Id.is_in(ids.iter().cloned()))
        .add(issues::Column::ParentId.is_in(ids.iter().cloned()));
    if !parent_ids.is_empty() {
        related = related.add(issues::Column::Id.is_in(parent_ids));
    }
    let affected = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(related)
        .order_by_asc(issues::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await?;
    let target_ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let targets: Vec<issues::Model> =
        affected.iter().filter(|i| target_ids.contains(i.id.as_str())).cloned().collect();
    if targets.len() != ids.len() {
        return Err(AppError::entity_not_found("Issue", issue_ref));
    }
    let observed: HashMap<&str, Option<&str>> =
        target_relations.iter().map(|(id, parent)| (id.as_str(), parent.as_deref())).collect();
    if targets.iter().any(|t| observed.get(t.id.as_str()) != Some(&t.parent_id.as_deref())) {
        return Err(AppError::conflict("Issue hierarchy changed; retry the delete"));
    }
    let access = current_access();
    if affected.iter().any(|i| project_hidden(access.as_deref(), i.project_id.as_deref())) {
        return Err(AppError::entity_not_found("Issue", issue_ref));
    }

    let mut detached: Vec<issues::Model> = affected
        .iter()
        .filter(|i| {
            i.parent_id.as_deref().is_some_and(|p| target_ids.contains(p))
                && !target_ids.contains(i.id.as_str())
        })
        .cloned()
        .collect();
    if !detached.is_empty() {
        let updated_at = now().fixed_offset();
        issues::Entity::update_many()
            .set(issues::ActiveModel {
                parent_id: Set(None),
                updated_at: Set(updated_at),
                ..Default::default()
            })
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::Id.is_in(detached.iter().map(|i| i.id.clone())))
            .exec(txn)
            .await?;
        for issue in &mut detached {
            issue.parent_id = None;
            issue.updated_at = updated_at;
        }
    }
    comments::Entity::delete_many()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .filter(Expr::cust(r#""comments"."subject"->>'id'"#).is_in(ids.iter().cloned()))
        .exec(txn)
        .await?;
    issues::Entity::update_many()
        .set(issues::ActiveModel { duplicate_of_id: Set(None), ..Default::default() })
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::DuplicateOfId.is_in(ids.iter().cloned()))
        .exec(txn)
        .await?;
    issues::Entity::delete_many()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.iter().cloned()))
        .exec(txn)
        .await?;
    Ok((targets, detached))
}
