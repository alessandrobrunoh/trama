//! `ArtifactsService` (`server/src/artifacts/artifacts.service.ts`): everything the artifacts
//! routes do, callable from other crates (issues, integrations).
//!
//! Reads and writes follow the request's project scope (the member-access task-local of
//! `trama-auth`): an artifact of a task in a project the caller cannot reach is neither listed
//! nor readable, and cannot be attached to or moved onto. Background callers (webhooks, the
//! artifact linker) run outside a request, where nothing is narrowed.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::{Alias, Expr, ExprTrait, Query};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, Statement,
};
use serde_json::{Map, Value, json};
use trama_auth::member_access::{current_access, project_hidden, project_scope_expr};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::issues::{
    ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState,
};
use trama_contracts::js::is_whitespace;
use trama_core::ids::uid;
use trama_core::validation::Patch;
use trama_core::{AppError, AppState};
use trama_entities::{artifacts, issues};
use trama_events::{Events, RecordEvent};
use trama_uploads::UploadSubject;
use trama_uploads::rules::is_workspace_upload_url;
use trama_uploads::service::{forget_subjects, release_ids};

/// The fields of an artifact a caller can set, as `ArtifactInput` in NestJS.
///
/// On create, an absent or cleared field falls back to its default (`?? null`, the kind's
/// default state, the PR defaults). On update, [`Patch::Missing`] and `None` leave the field
/// alone and [`Patch::Null`] clears it; the owner can never be cleared (400).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ArtifactInput {
    /// The task that owns the artifact (an id, not a key).
    pub issue_id: Patch<String>,
    /// Git full name or URL.
    pub repository: Patch<String>,
    /// Short note, trimmed; blank clears it.
    pub description: Patch<String>,
    /// Provider; on create the default follows the kind.
    pub provider: Option<ArtifactProvider>,
    /// Title, trimmed.
    pub title: Option<String>,
    /// Link: an http(s) URL, or the artifact's own upload path.
    pub url: Patch<String>,
    /// e.g. `#182`, a commit sha.
    pub external_id: Patch<String>,
    /// Lifecycle state; on create the default follows the kind.
    pub state: Option<ArtifactState>,
    /// CI status of a PR or MR.
    pub ci: Patch<CiState>,
    /// Review status of a PR or MR.
    pub review: Patch<ReviewState>,
    /// PR or MR has merge conflicts.
    pub has_conflicts: Patch<bool>,
    /// Deployment or release environment.
    pub environment: Patch<String>,
    /// Server side only (the HTTP bodies do not carry it): the people a review was asked from,
    /// when that is known, so only they hear about it. Recorded on `review.requested`, never
    /// stored.
    pub reviewer_user_ids: Vec<String>,
}

/// The filters of [`list`] (`ArtifactFilter`). An empty string filters nothing, as in NestJS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ArtifactFilter {
    /// Only the artifacts of this task (an id).
    pub issue_id: Option<String>,
    /// Only this repository.
    pub repository: Option<String>,
    /// Only this kind.
    pub kind: Option<ArtifactKind>,
    /// Only this state.
    pub state: Option<ArtifactState>,
}

/// Initial state when none is given (`DEFAULT_STATE`).
#[must_use]
pub const fn default_state(kind: ArtifactKind) -> ArtifactState {
    match kind {
        ArtifactKind::PullRequest | ArtifactKind::MergeRequest => ArtifactState::Open,
        ArtifactKind::Build | ArtifactKind::Deployment => ArtifactState::Pending,
        ArtifactKind::TestReport => ArtifactState::Succeeded,
        ArtifactKind::Document
        | ArtifactKind::Link
        | ArtifactKind::Design
        | ArtifactKind::Image
        | ArtifactKind::File
        | ArtifactKind::Release => ArtifactState::Published,
    }
}

/// `isHttpUrl`: a `link` artifact must point to an http(s) URL.
#[must_use]
pub fn is_http_url(value: Option<&str>) -> bool {
    value
        .filter(|v| !v.is_empty())
        .and_then(|v| url::Url::parse(v).ok())
        .is_some_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// `artifactOwners`: the owner ids of an artifact row that are set, for event payloads.
#[must_use]
pub fn artifact_owners(row: &artifacts::Model) -> Map<String, Value> {
    let mut owners = Map::new();
    if let Some(issue_id) = row.issue_id.as_deref().filter(|id| !id.is_empty()) {
        owners.insert("issueId".to_owned(), json!(issue_id));
    }
    owners
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `a || null` on a string: empty is falsy.
fn non_empty(text: Option<&str>) -> Option<&str> {
    text.filter(|t| !t.is_empty())
}

/// `description?.trim() || null`.
fn clean_description(text: Option<&str>) -> Option<String> {
    text.map(js_trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap_or_else(Utc::now)
}

/// Artifacts of the workspace, newest first, narrowed to the projects the caller can reach.
///
/// # Errors
///
/// Database errors.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    filter: &ArtifactFilter,
) -> Result<Vec<artifacts::Model>, AppError> {
    let mut query = artifacts::Entity::find()
        .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(artifacts::Column::CreatedAt);
    if let Some(issue_id) = non_empty(filter.issue_id.as_deref()) {
        query = query.filter(artifacts::Column::IssueId.eq(issue_id));
    }
    if let Some(repository) = non_empty(filter.repository.as_deref()) {
        query = query.filter(artifacts::Column::Repository.eq(repository));
    }
    if let Some(kind) = filter.kind {
        query = query.filter(artifacts::Column::Kind.eq(kind.as_str()));
    }
    if let Some(state) = filter.state {
        query = query.filter(artifacts::Column::State.eq(state.as_str()));
    }
    if let Some(scope) = owner_scope() {
        query = query.filter(scope);
    }
    Ok(query.all(db).await?)
}

/// The project scope of a list: an artifact is in scope when its task is, and an artifact with
/// no task only when the caller also sees unassigned work. `None` when not narrowed.
fn owner_scope() -> Option<Condition> {
    let access = current_access()?;
    let alias = Alias::new("i");
    let project = Expr::col((alias.clone(), issues::Column::ProjectId));
    let in_scope = project_scope_expr(&project)?;
    let mut owner = Query::select();
    owner.expr(Expr::val(1)).from_as(issues::Entity, alias.clone()).and_where(
        Expr::col((alias, issues::Column::Id))
            .equals((artifacts::Entity, artifacts::Column::IssueId)),
    );
    owner.cond_where(in_scope);
    let mut any = Condition::any().add(Expr::exists(owner));
    if access.include_unassigned {
        any = any.add(artifacts::Column::IssueId.is_null());
    }
    Some(any)
}

/// How many artifacts a task has, without loading them. The caller has already been allowed to
/// see the task.
///
/// # Errors
///
/// Database errors.
pub async fn count_for_issue<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue_id: &str,
) -> Result<u64, AppError> {
    Ok(artifacts::Entity::find()
        .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
        .filter(artifacts::Column::IssueId.eq(issue_id))
        .count(db)
        .await?)
}

/// One artifact.
///
/// # Errors
///
/// 404 `Artifact "<id>" not found`, also for an artifact of a task in a project the caller
/// cannot reach.
pub async fn get<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<artifacts::Model, AppError> {
    let row = artifacts::Entity::find_by_id(id)
        .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?;
    match row {
        Some(row) if !is_hidden(db, &row).await? => Ok(row),
        _ => Err(AppError::entity_not_found("Artifact", id)),
    }
}

/// An artifact is hidden when its task's project is outside the caller's scope. A task that is
/// gone counts as unassigned.
async fn is_hidden<C: ConnectionTrait>(db: &C, row: &artifacts::Model) -> Result<bool, AppError> {
    let access = current_access();
    let Some(issue_id) = row.issue_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(project_hidden(access.as_deref(), None));
    };
    let project_id = issue_project(db, &row.workspace_id, issue_id).await?.flatten();
    Ok(project_hidden(access.as_deref(), project_id.as_deref()))
}

/// The project of a task: `None` when the task does not exist, `Some(None)` when it has none.
async fn issue_project<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue_id: &str,
) -> Result<Option<Option<String>>, AppError> {
    Ok(issues::Entity::find()
        .filter(issues::Column::Id.eq(issue_id))
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .select_only()
        .column(issues::Column::ProjectId)
        .into_tuple::<Option<String>>()
        .one(db)
        .await?)
}

/// `^[A-Za-z]+-\d+$`
fn is_issue_key(value: &str) -> bool {
    let Some((letters, digits)) = value.split_once('-') else { return false };
    !letters.is_empty()
        && letters.chars().all(|c| c.is_ascii_alphabetic())
        && !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
}

/// Resolves a task by id, key (`CORA-12`) or alias to its id. It does not look at the caller's
/// project scope: a task in a hidden project resolves, and the operation that follows refuses it.
///
/// # Errors
///
/// 404 `Issue "<idOrKey>" not found`.
pub async fn resolve_issue_id<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id_or_key: &str,
) -> Result<String, AppError> {
    let base = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .select_only()
        .column(issues::Column::Id);
    let row = if is_issue_key(id_or_key) {
        let key = id_or_key.to_uppercase();
        let by_key = base
            .clone()
            .filter(issues::Column::Key.eq(key.as_str()))
            .into_tuple::<String>()
            .one(db)
            .await?;
        match by_key {
            Some(id) => Some(id),
            None => {
                base.filter(Expr::cust_with_values(r#""issues"."aliases" @> $1"#, [json!([key])]))
                    .into_tuple::<String>()
                    .one(db)
                    .await?
            }
        }
    } else {
        base.filter(issues::Column::Id.eq(id_or_key)).into_tuple::<String>().one(db).await?
    };
    row.ok_or_else(|| AppError::entity_not_found("Issue", id_or_key))
}

/// The referenced task must exist in the workspace and be visible to the caller.
async fn validate_owner<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(issue_id) = non_empty(issue_id) else { return Ok(()) };
    let unknown = || AppError::bad_request(format!("Unknown issue \"{issue_id}\""));
    let project = issue_project(db, workspace_id, issue_id).await?.ok_or_else(unknown)?;
    if project_hidden(current_access().as_deref(), project.as_deref()) {
        return Err(unknown());
    }
    Ok(())
}

/// Client urls are http(s). A workspace upload path is allowed only when this artifact already
/// owns that file (`uploadId`); callers cannot point an artifact at someone else's upload by
/// setting `url`.
fn assert_link_url(kind: &str, url: Option<&str>, upload_id: Option<&str>) -> Result<(), AppError> {
    let url = non_empty(url);
    if kind == ArtifactKind::Link.as_str() && url.is_none() {
        return Err(AppError::bad_request("A link artifact needs a valid http(s) url"));
    }
    let Some(url) = url else { return Ok(()) };
    if is_http_url(Some(url)) {
        return Ok(());
    }
    if let Some(upload_id) = non_empty(upload_id)
        && is_workspace_upload_url(Some(url))
        && url.ends_with(&format!("/uploads/{upload_id}"))
    {
        return Ok(());
    }
    Err(AppError::bad_request("An artifact url must be a valid http(s) url"))
}

fn subject(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Artifact, id: id.to_owned() }
}

/// Attaches a new artifact to a task and records `artifact.attached` (and `review.requested`
/// when it is created with a requested review).
///
/// # Errors
///
/// 400 `An artifact needs a task: issueId`, `A link artifact needs a valid http(s) url`,
/// `An artifact url must be a valid http(s) url`, `Unknown issue "<id>"` (also for a task in a
/// project the caller cannot reach), `An artifact needs a title`.
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    kind: ArtifactKind,
    input: ArtifactInput,
) -> Result<artifacts::Model, AppError> {
    let Some(issue_id) = non_empty(input.issue_id.as_value().map(String::as_str)) else {
        return Err(AppError::bad_request("An artifact needs a task: issueId"));
    };
    assert_link_url(kind.as_str(), input.url.as_value().map(String::as_str), None)?;
    validate_owner(&state.db, workspace_id, Some(issue_id)).await?;
    let title = input.title.as_deref().map(js_trim).filter(|t| !t.is_empty());
    let Some(title) = title else {
        return Err(AppError::bad_request("An artifact needs a title"));
    };
    let is_pr = matches!(kind, ArtifactKind::PullRequest | ArtifactKind::MergeRequest);
    let provider = input.provider.unwrap_or(match kind {
        ArtifactKind::MergeRequest => ArtifactProvider::Gitlab,
        ArtifactKind::PullRequest => ArtifactProvider::Github,
        _ => ArtifactProvider::Other,
    });
    let owned = |patch: &Patch<String>| patch.as_value().cloned();
    let row = artifacts::ActiveModel {
        id: Set(uid("ar")),
        workspace_id: Set(workspace_id.to_owned()),
        issue_id: Set(Some(issue_id.to_owned())),
        repository: Set(owned(&input.repository)),
        description: Set(clean_description(input.description.as_value().map(String::as_str))),
        kind: Set(kind.as_str().to_owned()),
        provider: Set(provider.as_str().to_owned()),
        title: Set(title.to_owned()),
        url: Set(owned(&input.url)),
        external_id: Set(owned(&input.external_id)),
        state: Set(input.state.unwrap_or_else(|| default_state(kind)).as_str().to_owned()),
        ci: Set(input
            .ci
            .as_value()
            .map(|c| c.as_str().to_owned())
            .or_else(|| is_pr.then(|| CiState::Pending.as_str().to_owned()))),
        review: Set(input
            .review
            .as_value()
            .map(|r| r.as_str().to_owned())
            .or_else(|| is_pr.then(|| ReviewState::None.as_str().to_owned()))),
        has_conflicts: Set(input.has_conflicts.as_value().copied().or(is_pr.then_some(false))),
        environment: Set(owned(&input.environment)),
        author_ref: Set(serde_json::to_value(actor).ok()),
        ..Default::default()
    }
    .insert(&state.db)
    .await?;

    let mut data = Map::new();
    data.insert("kind".to_owned(), json!(row.kind));
    data.insert("title".to_owned(), json!(row.title));
    data.insert("externalId".to_owned(), json!(row.external_id));
    data.insert("state".to_owned(), json!(row.state));
    data.extend(artifact_owners(&row));
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "artifact.attached", subject(&row.id))
                .data(Value::Object(data)),
        )
        .await?;
    if row.review.as_deref() == Some(ReviewState::Requested.as_str()) {
        review_requested(state, &row, actor, &input.reviewer_user_ids).await?;
    }
    Ok(row)
}

/// `review.requested`: not shown live; `reviewer_user_ids` narrows who is notified.
async fn review_requested(
    state: &AppState,
    row: &artifacts::Model,
    actor: &ActorRef,
    reviewer_user_ids: &[String],
) -> Result<(), AppError> {
    let mut data = Map::new();
    data.insert("title".to_owned(), json!(row.title));
    data.insert("externalId".to_owned(), json!(row.external_id));
    data.extend(artifact_owners(row));
    if !reviewer_user_ids.is_empty() {
        data.insert("reviewerUserIds".to_owned(), json!(reviewer_user_ids));
    }
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(
                &row.workspace_id,
                actor.clone(),
                "review.requested",
                subject(&row.id),
            )
            .data(Value::Object(data))
            .without_live(),
        )
        .await?;
    Ok(())
}

/// Collects the fields an update changes, as `[before, after]` pairs keyed by field name.
#[derive(Default)]
struct Changes {
    fields: Vec<&'static str>,
    pairs: Map<String, Value>,
}

impl Changes {
    /// `set(k, v)`: a field counts as changed when its JSON differs.
    #[allow(clippy::needless_pass_by_value)] // callers build both with `json!`
    fn record(&mut self, field: &'static str, before: Value, after: Value) -> bool {
        if before == after {
            return false;
        }
        self.fields.push(field);
        self.pairs.insert(field.to_owned(), json!([before, after]));
        true
    }
}

/// Changes an artifact and records `artifact.updated` (and `review.requested` when the review
/// became `requested`). A patch that changes nothing answers the stored row and records nothing.
///
/// # Errors
///
/// 404 `Artifact "<id>" not found` (also when hidden by the caller's project scope); 400
/// `Unknown issue "<id>"`, `An artifact needs a task: issueId`, and the url errors of
/// [`create`].
#[allow(clippy::too_many_lines)] // one block per patched field, as in NestJS
pub async fn update(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
    patch: ArtifactInput,
) -> Result<artifacts::Model, AppError> {
    let current = get(&state.db, workspace_id, id).await?;
    validate_owner(&state.db, workspace_id, patch.issue_id.as_value().map(String::as_str)).await?;
    let mut row = current.clone();
    let mut changes = Changes::default();

    if let Some(title) = &patch.title {
        let title = js_trim(title).to_owned();
        if changes.record("title", json!(row.title), json!(title)) {
            row.title = title;
        }
    }
    if let Some(description) = patch.description.clone().into_option() {
        let description = clean_description(description.as_deref());
        if changes.record("description", json!(row.description), json!(description)) {
            row.description = description;
        }
    }
    if let Some(issue_id) = patch.issue_id.clone().into_option()
        && changes.record("issueId", json!(row.issue_id), json!(issue_id))
    {
        row.issue_id = issue_id;
    }
    if let Some(repository) = patch.repository.clone().into_option()
        && changes.record("repository", json!(row.repository), json!(repository))
    {
        row.repository = repository;
    }
    if let Some(provider) = patch.provider
        && changes.record("provider", json!(row.provider), json!(provider.as_str()))
    {
        provider.as_str().clone_into(&mut row.provider);
    }
    if let Some(url) = patch.url.clone().into_option()
        && changes.record("url", json!(row.url), json!(url))
    {
        row.url = url;
    }
    if let Some(external_id) = patch.external_id.clone().into_option()
        && changes.record("externalId", json!(row.external_id), json!(external_id))
    {
        row.external_id = external_id;
    }
    if let Some(next) = patch.state
        && changes.record("state", json!(row.state), json!(next.as_str()))
    {
        next.as_str().clone_into(&mut row.state);
    }
    if let Some(ci) = patch.ci.clone().into_option() {
        let ci = ci.map(|c| c.as_str().to_owned());
        if changes.record("ci", json!(row.ci), json!(ci)) {
            row.ci = ci;
        }
    }
    if let Some(review) = patch.review.clone().into_option() {
        let review = review.map(|r| r.as_str().to_owned());
        if changes.record("review", json!(row.review), json!(review)) {
            row.review = review;
        }
    }
    if let Some(has_conflicts) = patch.has_conflicts.clone().into_option()
        && changes.record("hasConflicts", json!(row.has_conflicts), json!(has_conflicts))
    {
        row.has_conflicts = has_conflicts;
    }
    if let Some(environment) = patch.environment.clone().into_option()
        && changes.record("environment", json!(row.environment), json!(environment))
    {
        row.environment = environment;
    }

    // an uploaded file stays attached only while the url still points at it
    let mut released = None;
    if let Some(upload_id) = row.upload_id.clone().filter(|u| !u.is_empty())
        && !row.url.as_deref().is_some_and(|u| u.contains(&format!("/uploads/{upload_id}")))
    {
        row.upload_id = None;
        changes.fields.push("uploadId");
        released = Some(upload_id);
    }
    if changes.fields.is_empty() {
        return Ok(row);
    }
    if non_empty(row.issue_id.as_deref()).is_none() {
        return Err(AppError::bad_request("An artifact needs a task: issueId"));
    }
    assert_link_url(&row.kind, row.url.as_deref(), row.upload_id.as_deref())?;

    let saved = save_changes(&state.db, &current, &row).await?;
    let mut data = Map::new();
    data.insert("title".to_owned(), json!(saved.title));
    data.insert("externalId".to_owned(), json!(saved.external_id));
    data.extend(artifact_owners(&saved));
    data.insert("changes".to_owned(), Value::Object(changes.pairs.clone()));
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "artifact.updated", subject(id))
                .data(Value::Object(data)),
        )
        .await?;
    if let Some(upload_id) = released {
        forget_subjects(&state.db, workspace_id, &[UploadSubject::artifact(id, None)]).await?;
        release_ids(&state.db, workspace_id, &[upload_id]).await?;
    }
    if changes.pairs.contains_key("review")
        && saved.review.as_deref() == Some(ReviewState::Requested.as_str())
    {
        review_requested(state, &saved, actor, &patch.reviewer_user_ids).await?;
    }
    Ok(saved)
}

/// Writes only the columns that differ from `before`, like TypeORM's `save`, so a concurrent
/// change to another column is not overwritten.
async fn save_changes<C: ConnectionTrait>(
    db: &C,
    before: &artifacts::Model,
    after: &artifacts::Model,
) -> Result<artifacts::Model, AppError> {
    let mut row = before.clone().into_active_model();
    row.title.set_if_not_equals(after.title.clone());
    row.description.set_if_not_equals(after.description.clone());
    row.issue_id.set_if_not_equals(after.issue_id.clone());
    row.repository.set_if_not_equals(after.repository.clone());
    row.provider.set_if_not_equals(after.provider.clone());
    row.url.set_if_not_equals(after.url.clone());
    row.external_id.set_if_not_equals(after.external_id.clone());
    row.state.set_if_not_equals(after.state.clone());
    row.ci.set_if_not_equals(after.ci.clone());
    row.review.set_if_not_equals(after.review.clone());
    row.has_conflicts.set_if_not_equals(after.has_conflicts);
    row.environment.set_if_not_equals(after.environment.clone());
    row.upload_id.set_if_not_equals(after.upload_id.clone());
    row.updated_at = Set(now().fixed_offset());
    Ok(row.update(db).await?)
}

/// Deletes an artifact with the comments on it, releases its uploaded file and records
/// `artifact.deleted`.
///
/// # Errors
///
/// 404 `Artifact "<id>" not found` (also when hidden by the caller's project scope).
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id: &str,
) -> Result<(), AppError> {
    let row = get(&state.db, workspace_id, id).await?;
    state
        .db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2"#,
            [workspace_id.into(), id.into()],
        ))
        .await?;
    artifacts::Entity::delete_by_id(id).exec(&state.db).await?;
    if let Some(upload_id) = row.upload_id.clone() {
        forget_subjects(&state.db, workspace_id, &[UploadSubject::artifact(id, None)]).await?;
        release_ids(&state.db, workspace_id, &[upload_id]).await?;
    }
    let mut data = Map::new();
    data.insert("title".to_owned(), json!(row.title));
    data.extend(artifact_owners(&row));
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, actor.clone(), "artifact.deleted", subject(id))
                .data(Value::Object(data)),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_http_urls() {
        for ok in ["https://example.com/a?b=1", "http://localhost:3000"] {
            assert!(is_http_url(Some(ok)), "{ok}");
        }
        for bad in [
            None,
            Some(""),
            Some("example.com"),
            Some("ftp://example.com"),
            Some("javascript:alert(1)"),
        ] {
            assert!(!is_http_url(bad), "{bad:?}");
        }
    }

    #[test]
    fn default_states_follow_the_kind() {
        assert_eq!(default_state(ArtifactKind::PullRequest), ArtifactState::Open);
        assert_eq!(default_state(ArtifactKind::Build), ArtifactState::Pending);
        assert_eq!(default_state(ArtifactKind::TestReport), ArtifactState::Succeeded);
        assert_eq!(default_state(ArtifactKind::Link), ArtifactState::Published);
        for kind in ArtifactKind::ALL {
            let _ = default_state(*kind);
        }
    }

    #[test]
    fn recognizes_issue_keys() {
        for ok in ["CORA-12", "a-1"] {
            assert!(is_issue_key(ok), "{ok}");
        }
        for bad in ["", "CORA", "CORA-", "-1", "CORA-1a", "CO RA-1", "in_abc123", "A1-2"] {
            assert!(!is_issue_key(bad), "{bad}");
        }
    }

    #[test]
    fn link_urls_follow_the_upload_rule() {
        assert!(assert_link_url("link", None, None).is_err());
        assert!(assert_link_url("link", Some("ftp://x"), None).is_err());
        assert!(assert_link_url("link", Some("https://x.test"), None).is_ok());
        assert!(assert_link_url("document", None, None).is_ok());
        let own = "/api/w/acme/uploads/upl_abcdefghijkl";
        assert!(assert_link_url("file", Some(own), None).is_err());
        assert!(assert_link_url("file", Some(own), Some("upl_abcdefghijkl")).is_ok());
        assert!(assert_link_url("file", Some(own), Some("upl_zzzzzzzzzzzz")).is_err());
    }
}
