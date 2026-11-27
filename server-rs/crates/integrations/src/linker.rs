//! `ArtifactLinkerService` (`artifact-linker.service.ts`): turns normalized provider data into
//! issue-owned artifacts, matched by issue keys.
//!
//! [`upsert`] creates or updates one artifact per (repository, kind, external id, issue)
//! through `trama_artifacts::service` and remembers the git coordinates for later CI events
//! ([`apply_ci`]). It runs outside a request (webhooks, routing), so nothing is narrowed by a
//! member's project scope. People are resolved through external identities: the sender of an
//! event is credited instead of "system" when their login is verified, and review requests
//! reach the members the provider named (only those who may see the task).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set,
};
use trama_artifacts::{ArtifactInput, service as artifacts_service};
use trama_auth::member_access::project_hidden;
use trama_contracts::access::MemberAccess;
use trama_contracts::common::ActorRef;
use trama_contracts::identity::stored_member_access;
use trama_contracts::issues::{ArtifactKind, ArtifactProvider};
use trama_core::validation::Patch;
use trama_core::{AppError, AppState};
use trama_entities::{artifact_sources, artifacts, issues, memberships};
use trama_external_identities::service::{
    ResolveOptions, resolve_member_by_login, resolve_members_by_logins,
};

use crate::candidates::{ArtifactCandidate, CiPatch};
use crate::keys::extract_keys;

/// What [`upsert`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkResult {
    /// Artifacts created.
    pub created: u32,
    /// Artifacts that changed.
    pub updated: u32,
    /// The issue keys found in the candidate (those of existing issues).
    pub issue_keys: Vec<String>,
}

/// In-process serialization per artifact identity (webhooks of one PR arrive in bursts).
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

async fn serial<T>(key: String, work: impl Future<Output = T>) -> T {
    let lock = {
        let mut locks = LOCKS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(locks.entry(key.clone()).or_default())
    };
    let result = {
        let _guard = lock.lock().await;
        work.await
    };
    let mut locks = LOCKS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // the map and this call hold it: nobody else is queued on it
    if Arc::strong_count(&lock) == 2 {
        locks.remove(&key);
    }
    result
}

/// Issue key → issue id for the workspace.
///
/// # Errors
///
/// Database errors.
pub async fn key_map<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
) -> Result<HashMap<String, String>, AppError> {
    let rows: Vec<(String, String)> = issues::Entity::find()
        .select_only()
        .column(issues::Column::Key)
        .column(issues::Column::Id)
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .into_tuple()
        .all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

/// A person the provider asked for a review, with the access that decides what they may see.
struct Reviewer {
    user_id: String,
    access: Option<MemberAccess>,
}

struct People {
    actor: ActorRef,
    reviewers: Vec<Reviewer>,
}

/// Who the event concerns, from the provider's logins through external identities: the people a
/// review was asked from (workspace members only, so only they hear about it), and, when the
/// sender has a verified identity, the person to credit the activity to instead of "system". A
/// lookup problem never drops the webhook: it falls back to what was found so far.
async fn people(
    state: &AppState,
    workspace_id: &str,
    c: &ArtifactCandidate,
    host: Option<&str>,
) -> People {
    let mut reviewers = Vec::new();
    let mut actor = ActorRef::system();
    let found: Result<(), AppError> = async {
        if !c.reviewer_logins.is_empty() {
            let found = resolve_members_by_logins(
                &state.db,
                workspace_id,
                c.provider.as_str(),
                host,
                &c.reviewer_logins,
                ResolveOptions::default(),
            )
            .await?;
            let mut ids: Vec<&String> = found.values().collect();
            ids.sort();
            ids.dedup();
            if !ids.is_empty() {
                let rows = memberships::Entity::find()
                    .filter(memberships::Column::WorkspaceId.eq(workspace_id))
                    .filter(memberships::Column::UserId.is_in(ids))
                    .all(&state.db)
                    .await?;
                for m in rows {
                    reviewers.push(Reviewer {
                        access: stored_member_access(m.access.as_ref()),
                        user_id: m.user_id,
                    });
                }
            }
        }
        if let Some(login) = c.actor_login.as_deref().filter(|l| !l.is_empty())
            && let Some(user_id) = resolve_member_by_login(
                &state.db,
                workspace_id,
                c.provider.as_str(),
                host,
                Some(login),
                ResolveOptions::VERIFIED,
            )
            .await?
        {
            actor = ActorRef::user(user_id);
        }
        Ok(())
    }
    .await;
    if let Err(e) = found {
        tracing::warn!("Login lookup failed: {e}");
    }
    People { actor, reviewers }
}

/// Reviewers who may see the task: someone limited to other projects is not told about it.
async fn reviewers_who_can_see<C: ConnectionTrait>(
    db: &C,
    issue_id: &str,
    reviewers: &[Reviewer],
) -> Result<Vec<String>, AppError> {
    if reviewers.is_empty() {
        return Ok(Vec::new());
    }
    let mut project_id: Option<String> = None;
    if reviewers.iter().any(|r| r.access.as_ref().is_some_and(|a| !a.projects.all)) {
        project_id = issues::Entity::find_by_id(issue_id).one(db).await?.and_then(|i| i.project_id);
    }
    Ok(reviewers
        .iter()
        .filter(|r| !project_hidden(r.access.as_ref(), project_id.as_deref()))
        .map(|r| r.user_id.clone())
        .collect())
}

fn some<T>(value: Option<T>) -> Patch<T> {
    value.map_or(Patch::Missing, Patch::Value)
}

/// Links a PR/MR candidate to the issues named by its keys and keeps its artifacts current:
/// one artifact per issue, found again by (`repository`, kind, external id). `host` is the git
/// host the event came from (its connection's), for login lookups. `repository` is the
/// repository's full name, as `artifacts.repository` stores it.
///
/// # Errors
///
/// Database errors and the errors of `trama_artifacts::service::{create, update}`.
pub async fn upsert(
    state: &AppState,
    workspace_id: &str,
    repository: &str,
    c: &ArtifactCandidate,
    host: Option<&str>,
) -> Result<LinkResult, AppError> {
    let key = format!("{workspace_id}|{repository}|{}|{}", c.kind.as_str(), c.external_id);
    serial(key, do_upsert(state, workspace_id, repository, c, host)).await
}

#[allow(clippy::too_many_lines)] // one pass over the targets, as in NestJS
async fn do_upsert(
    state: &AppState,
    workspace_id: &str,
    repository: &str,
    c: &ArtifactCandidate,
    host: Option<&str>,
) -> Result<LinkResult, AppError> {
    let keys_by_issue = key_map(&state.db, workspace_id).await?;
    let is_known = |k: &str| keys_by_issue.contains_key(k);
    let mut keys = extract_keys(&c.texts, false, Some(&is_known));
    let known_set: HashSet<String> = keys.iter().cloned().collect();
    for key in extract_keys(&c.branch_texts, true, Some(&is_known)) {
        if !known_set.contains(&key) {
            keys.push(key);
        }
    }
    let existing = artifacts::Entity::find()
        .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
        .filter(artifacts::Column::Repository.eq(repository))
        .filter(artifacts::Column::Kind.eq(c.kind.as_str()))
        .filter(artifacts::Column::ExternalId.eq(c.external_id.as_str()))
        .all(&state.db)
        .await?;
    // a later row for the same issue wins; the order of first appearance is kept
    let mut by_issue: HashMap<String, artifacts::Model> = HashMap::new();
    let mut existing_order: Vec<String> = Vec::new();
    for row in existing {
        if let Some(issue_id) = row.issue_id.clone() {
            if !by_issue.contains_key(&issue_id) {
                existing_order.push(issue_id.clone());
            }
            by_issue.insert(issue_id, row);
        }
    }
    let mut targets: Vec<String> = Vec::new();
    for key in &keys {
        if let Some(issue_id) = keys_by_issue.get(key)
            && !targets.contains(issue_id)
        {
            targets.push(issue_id.clone());
        }
    }
    for issue_id in existing_order {
        if !targets.contains(&issue_id) {
            targets.push(issue_id);
        }
    }

    let mut result = LinkResult { created: 0, updated: 0, issue_keys: keys };
    let people = if targets.is_empty() {
        People { actor: ActorRef::system(), reviewers: Vec::new() }
    } else {
        people(state, workspace_id, c, host).await
    };
    let provider = ArtifactProvider::parse(c.provider.as_str());

    for issue_id in targets {
        let current = by_issue.get(&issue_id);
        let reviewer_user_ids =
            reviewers_who_can_see(&state.db, &issue_id, &people.reviewers).await?;
        let apply_review = c.review.is_some()
            && match (&c.review_only_from, current) {
                (Some(only), Some(current)) => {
                    let now = current.review.as_deref().unwrap_or("none");
                    only.iter().any(|r| r.as_str() == now)
                }
                _ => true,
            };
        let row = if let Some(current) = current {
            let row = artifacts_service::update(
                state,
                workspace_id,
                &people.actor,
                &current.id,
                ArtifactInput {
                    title: Some(c.title.clone()),
                    url: some(c.url.clone()),
                    state: c.state,
                    ci: some(c.ci),
                    review: if apply_review { some(c.review) } else { Patch::Missing },
                    has_conflicts: some(c.has_conflicts),
                    reviewer_user_ids,
                    ..ArtifactInput::default()
                },
            )
            .await?;
            if row.updated_at > current.updated_at {
                result.updated += 1;
            }
            row
        } else {
            let row = artifacts_service::create(
                state,
                workspace_id,
                &people.actor,
                c.kind,
                ArtifactInput {
                    issue_id: Patch::Value(issue_id.clone()),
                    reviewer_user_ids,
                    provider,
                    title: Some(c.title.clone()),
                    url: some(c.url.clone()),
                    external_id: Patch::Value(c.external_id.clone()),
                    repository: Patch::Value(repository.to_owned()),
                    state: c.state,
                    ci: some(c.ci),
                    review: some(c.review),
                    has_conflicts: some(c.has_conflicts),
                    ..ArtifactInput::default()
                },
            )
            .await?;
            result.created += 1;
            row
        };
        if c.head_sha.is_some() || c.head_branch.is_some() {
            remember_source(&state.db, workspace_id, repository, &row.id, c).await?;
        }
    }
    Ok(result)
}

/// `ArtifactSourceEntity.upsert`: the git coordinates CI events find the artifact by.
async fn remember_source<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    repository: &str,
    artifact_id: &str,
    c: &ArtifactCandidate,
) -> Result<(), AppError> {
    let mut update =
        vec![artifact_sources::Column::WorkspaceId, artifact_sources::Column::Repository];
    let mut head_sha = ActiveValue::NotSet;
    let mut head_branch = ActiveValue::NotSet;
    if let Some(sha) = &c.head_sha {
        head_sha = Set(Some(sha.clone()));
        update.push(artifact_sources::Column::HeadSha);
    }
    if let Some(branch) = &c.head_branch {
        head_branch = Set(Some(branch.clone()));
        update.push(artifact_sources::Column::HeadBranch);
    }
    artifact_sources::Entity::insert(artifact_sources::ActiveModel {
        artifact_id: Set(artifact_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        repository: Set(Some(repository.to_owned())),
        head_sha,
        head_branch,
    })
    .on_conflict(
        OnConflict::column(artifact_sources::Column::ArtifactId).update_columns(update).to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    Ok(())
}

/// Applies a CI result to the PR/MR artifacts of a commit (by head sha) or listed explicitly.
/// Returns how many artifacts changed. A failing update is logged and skipped.
///
/// # Errors
///
/// Database errors while finding the artifacts.
pub async fn apply_ci(
    state: &AppState,
    workspace_id: &str,
    repository: &str,
    patch: &CiPatch,
) -> Result<u32, AppError> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(sha) = &patch.sha {
        let sources = artifact_sources::Entity::find()
            .filter(artifact_sources::Column::WorkspaceId.eq(workspace_id))
            .filter(artifact_sources::Column::Repository.eq(repository))
            .filter(artifact_sources::Column::HeadSha.eq(sha.as_str()))
            .all(&state.db)
            .await?;
        ids.extend(sources.into_iter().map(|s| s.artifact_id));
    }
    if !patch.pr_external_ids.is_empty() {
        let rows = artifacts::Entity::find()
            .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
            .filter(artifacts::Column::Repository.eq(repository))
            .filter(artifacts::Column::ExternalId.is_in(patch.pr_external_ids.iter().cloned()))
            .all(&state.db)
            .await?;
        ids.extend(
            rows.into_iter()
                .filter(|r| {
                    r.kind == ArtifactKind::PullRequest.as_str()
                        || r.kind == ArtifactKind::MergeRequest.as_str()
                })
                .map(|r| r.id),
        );
    }
    let mut seen = HashSet::new();
    let mut changed = 0;
    for id in ids.into_iter().filter(|id| seen.insert(id.clone())) {
        let outcome: Result<bool, AppError> = async {
            let Some(before) = artifacts::Entity::find_by_id(id.as_str()).one(&state.db).await?
            else {
                return Ok(false);
            };
            if before.ci.as_deref() == Some(patch.ci.as_str()) {
                return Ok(false);
            }
            artifacts_service::update(
                state,
                workspace_id,
                &ActorRef::system(),
                &id,
                ArtifactInput { ci: Patch::Value(patch.ci), ..ArtifactInput::default() },
            )
            .await?;
            Ok(true)
        }
        .await;
        match outcome {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("CI update of {id} failed: {e}"),
        }
    }
    Ok(changed)
}
