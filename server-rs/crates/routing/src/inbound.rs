//! Idempotent ingestion entry point for authenticated/verified provider webhook handlers.
//!
//! Callers must verify the provider signature and normalize the event before calling this API.
//! This service additionally binds routing to the exact connection, provider and repository so
//! a valid event for another integration cannot be routed through this connection.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter, Set,
};
use trama_contracts::common::{ActorRef, GitProvider};
use trama_contracts::issues::{ArtifactState, IssueKind, IssueSource};
use trama_core::{AppError, AppState};
use trama_entities::{integration_connections, issues, routing_rule_items, routing_rules};
use trama_integrations::candidates::IssueCandidateState;
use trama_integrations::{ArtifactCandidate, IssueCandidate, ItemMeta, RepoMeta};
use trama_issues::service::{self, IssueInput, NewIssue};

use crate::service::{self as routing_service, ItemAttributes};

/// Result of routing an external issue event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutedIssue {
    /// Whether a new task was created, an existing one updated, or the event ignored.
    pub status: RoutedIssueStatus,
    /// Task key when the event has an associated task.
    pub key: Option<String>,
}

/// Outcome of routing an issue event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoutedIssueStatus {
    /// A task was created.
    Created,
    /// An existing task followed a state change.
    Updated,
    /// No task change was needed.
    Unchanged,
    /// The event did not correspond to an active rule.
    Ignored,
}

/// Result of routing a pull/merge-request event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutedPullRequest {
    /// True only when this event created a task for an otherwise-unmatched PR.
    pub placed: bool,
    /// Existing task key, when the PR names or has already been attached to a task.
    pub key: Option<String>,
}

fn issue_kind(labels: &[String]) -> IssueKind {
    let has =
        |names: &[&str]| labels.iter().any(|label| names.contains(&label.to_lowercase().as_str()));
    if has(&["security"]) {
        IssueKind::Security
    } else if has(&["bug", "defect", "regression"]) {
        IssueKind::Bug
    } else if has(&["feature", "enhancement", "feature request"]) {
        IssueKind::Feature
    } else if has(&["tech debt", "tech-debt", "chore", "refactor"]) {
        IssueKind::TechDebt
    } else {
        IssueKind::Feedback
    }
}

/// Route a provider-normalized issue event. Delivery is idempotent on the workspace/provider/
/// host/repository/kind/external ID unique key in `routing_rule_items`.
///
/// # Errors
///
/// Database or issue-creation errors. The caller must authenticate the webhook before invoking
/// this method.
#[allow(clippy::too_many_lines)]
pub async fn route_issue(
    state: &AppState,
    connection_id: &str,
    provider: GitProvider,
    repo: &RepoMeta,
    candidate: &IssueCandidate,
) -> Result<RoutedIssue, AppError> {
    if candidate.provider != provider
        || crate::source_path::normalize_source_path(provider.as_str(), &repo.full_name).is_err()
    {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Ignored, key: None });
    }
    let connection =
        integration_connections::Entity::find_by_id(connection_id).one(&state.db).await?;
    let Some(connection) = connection.filter(|row| row.provider == provider.as_str()) else {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Ignored, key: None });
    };
    let repository = repo.full_name.to_ascii_lowercase();
    let Some(resolved) = routing_service::resolve_for_connection(
        &state.db,
        connection_id,
        provider,
        &repo.full_name,
        &ItemAttributes {
            labels: candidate.labels.clone(),
            milestone: candidate.milestone.clone(),
        },
    )
    .await?
    else {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Ignored, key: None });
    };
    let rule = resolved.rule;
    let ws_id = rule.workspace_id.clone();
    let known = routing_rule_items::Entity::find()
        .filter(routing_rule_items::Column::WorkspaceId.eq(&ws_id))
        .filter(routing_rule_items::Column::Provider.eq(provider.as_str()))
        .filter(routing_rule_items::Column::Host.eq(&connection.host))
        .filter(routing_rule_items::Column::Repository.eq(&repository))
        .filter(routing_rule_items::Column::Kind.eq("issue"))
        .filter(routing_rule_items::Column::ExternalId.eq(&candidate.external_id))
        .one(&state.db)
        .await?;
    if let Some(item) = known {
        if item.issue_id.is_some()
            || chrono::Utc::now().timestamp() - item.created_at.timestamp() <= 5 * 60
        {
            return follow_issue(state, item, candidate).await;
        }
        routing_rule_items::Entity::delete_by_id(item.id).exec(&state.db).await?;
    }
    if candidate.state == IssueCandidateState::Closed {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Ignored, key: None });
    }
    let item_id = trama_core::ids::uid("ri");
    let claim = state
        .db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            r#"INSERT INTO "routing_rule_items"
               ("id", "workspaceId", "ruleId", "provider", "host", "repository", "kind", "externalId", "url", "externalState")
               VALUES ($1,$2,$3,$4,$5,$6,'issue',$7,$8,'open')
               ON CONFLICT ("workspaceId","provider","host","repository","kind","externalId") DO NOTHING
               RETURNING "id""#,
            [
                item_id.clone().into(),
                ws_id.clone().into(),
                rule.id.clone().into(),
                provider.as_str().to_owned().into(),
                connection.host.clone().into(),
                repository.clone().into(),
                candidate.external_id.clone().into(),
                candidate.url.clone().into(),
            ],
        ))
        .await?;
    if claim.is_none() {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Unchanged, key: None });
    }
    let kind = issue_kind(&candidate.labels);
    let source = match provider {
        GitProvider::Github => IssueSource::Github,
        GitProvider::Gitlab => IssueSource::Gitlab,
        GitProvider::Bitbucket => IssueSource::Api,
    };
    let mut body_parts = Vec::new();
    let description = candidate.body.as_deref().unwrap_or("").trim();
    if !description.is_empty() {
        body_parts.push(description.to_owned());
    }
    if let Some(url) = candidate.url.as_deref() {
        body_parts.push(format!("Source: {url}"));
    }
    let body = body_parts.join("\n\n");
    let mut input =
        NewIssue::new(kind, candidate.title.trim().chars().take(300).collect::<String>());
    input.body = (!body.is_empty()).then(|| body.chars().take(20_000).collect());
    input.source = Some(source);
    input.reporter_name = candidate.author.clone();
    input.project_id = Some(rule.project_id.clone());
    input.external_url = candidate.url.clone();
    let task = match service::create(state, &ws_id, &ActorRef::system(), input).await {
        Ok(task) => task,
        Err(error) => {
            routing_rule_items::Entity::delete_by_id(&item_id).exec(&state.db).await?;
            if let Some(rule) = routing_rules::Entity::find_by_id(&rule.id).one(&state.db).await? {
                let mut active = rule.into_active_model();
                active.last_error = Set(Some(
                    format!(
                        "Could not create a task for {}{}: {error}",
                        repo.full_name, candidate.external_id
                    )
                    .chars()
                    .take(500)
                    .collect(),
                ));
                active.update(&state.db).await?;
            }
            return Err(error);
        }
    };
    let mut item = routing_rule_items::Entity::find_by_id(&item_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::internal("Routing claim disappeared"))?
        .into_active_model();
    item.issue_id = Set(Some(task.id));
    item.update(&state.db).await?;
    record_success(state, &rule.id).await?;
    Ok(RoutedIssue { status: RoutedIssueStatus::Created, key: Some(task.key) })
}

async fn follow_issue(
    state: &AppState,
    item: routing_rule_items::Model,
    candidate: &IssueCandidate,
) -> Result<RoutedIssue, AppError> {
    let Some(task_id) = item.issue_id.as_deref() else {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Unchanged, key: None });
    };
    let Some(task) = issues::Entity::find_by_id(task_id)
        .filter(issues::Column::WorkspaceId.eq(&item.workspace_id))
        .one(&state.db)
        .await?
    else {
        return Ok(RoutedIssue { status: RoutedIssueStatus::Ignored, key: None });
    };
    let was_finished = task.status == "done" || task.status == "canceled";
    let next_status = match candidate.state {
        IssueCandidateState::Closed if !was_finished => Some(
            if candidate.state_reason.is_some_and(|reason| {
                reason == trama_integrations::candidates::StateReason::NotPlanned
            }) {
                "canceled"
            } else {
                "done"
            },
        ),
        IssueCandidateState::Open
            if was_finished && item.external_state.as_deref() == Some("closed") =>
        {
            Some("todo")
        }
        _ => None,
    };
    let changed = if let Some(status) = next_status {
        service::update(
            state,
            &item.workspace_id,
            &ActorRef::system(),
            &task.id,
            IssueInput { status: Some(status.to_owned()), ..Default::default() },
        )
        .await?;
        true
    } else {
        false
    };
    let mut active = item.clone().into_active_model();
    active.external_state = Set(Some(if candidate.state == IssueCandidateState::Open {
        "open".to_owned()
    } else {
        "closed".to_owned()
    }));
    active.update(&state.db).await?;
    if let Some(rule_id) = item.rule_id.as_deref() {
        record_success(state, rule_id).await?;
    }
    Ok(RoutedIssue {
        status: if changed { RoutedIssueStatus::Updated } else { RoutedIssueStatus::Unchanged },
        key: Some(task.key),
    })
}

async fn record_success(state: &AppState, rule_id: &str) -> Result<(), AppError> {
    if let Some(rule) = routing_rules::Entity::find_by_id(rule_id).one(&state.db).await? {
        let mut active = rule.into_active_model();
        active.last_sync_at = Set(Some(chrono::Utc::now().fixed_offset()));
        active.last_error = Set(None);
        active.update(&state.db).await?;
    }
    Ok(())
}

/// Route an unmatched pull/merge request. The webhook caller must verify its signature first.
/// PRs that name a task key are linked to that task and never create another task.
///
/// # Errors
///
/// Database, issue creation or artifact-linking errors.
#[allow(clippy::too_many_lines)]
pub async fn route_pull_request(
    state: &AppState,
    connection_id: &str,
    provider: GitProvider,
    repo: &RepoMeta,
    candidate: &ArtifactCandidate,
    meta: &ItemMeta,
) -> Result<RoutedPullRequest, AppError> {
    if candidate.provider != provider
        || crate::source_path::normalize_source_path(provider.as_str(), &repo.full_name).is_err()
    {
        return Ok(RoutedPullRequest { placed: false, key: None });
    }
    let connection =
        integration_connections::Entity::find_by_id(connection_id).one(&state.db).await?;
    let Some(connection) = connection.filter(|row| row.provider == provider.as_str()) else {
        return Ok(RoutedPullRequest { placed: false, key: None });
    };
    let repository = repo.full_name.to_ascii_lowercase();
    let Some(resolved) = routing_service::resolve_for_connection(
        &state.db,
        connection_id,
        provider,
        &repo.full_name,
        &ItemAttributes { labels: meta.labels.clone(), milestone: meta.milestone.clone() },
    )
    .await?
    else {
        return Ok(RoutedPullRequest { placed: false, key: None });
    };
    let rule = resolved.rule;
    let workspace_id = rule.workspace_id.clone();
    let known = routing_rule_items::Entity::find()
        .filter(routing_rule_items::Column::WorkspaceId.eq(&workspace_id))
        .filter(routing_rule_items::Column::Provider.eq(provider.as_str()))
        .filter(routing_rule_items::Column::Host.eq(&connection.host))
        .filter(routing_rule_items::Column::Repository.eq(&repository))
        .filter(routing_rule_items::Column::Kind.eq("pull_request"))
        .filter(routing_rule_items::Column::ExternalId.eq(&candidate.external_id))
        .one(&state.db)
        .await?;
    if let Some(item) = known {
        if let Some(issue_id) = item.issue_id
            && let Some(task) = issues::Entity::find_by_id(issue_id)
                .filter(issues::Column::WorkspaceId.eq(&workspace_id))
                .one(&state.db)
                .await?
        {
            let mut attached = candidate.clone();
            attached.texts.push(task.key.clone());
            trama_integrations::linker::upsert(
                state,
                &workspace_id,
                &repo.full_name,
                &attached,
                Some(&connection.host),
            )
            .await?;
            return Ok(RoutedPullRequest { placed: false, key: Some(task.key) });
        }
        return Ok(RoutedPullRequest { placed: false, key: None });
    }

    let key_map = trama_integrations::linker::key_map(&state.db, &workspace_id).await?;
    let known_key = trama_integrations::keys::extract_keys(
        &candidate.texts,
        false,
        Some(&|key| key_map.contains_key(key)),
    )
    .into_iter()
    .find(|key| key_map.contains_key(key));
    if let Some(key) = known_key {
        trama_integrations::linker::upsert(
            state,
            &workspace_id,
            &repo.full_name,
            candidate,
            Some(&connection.host),
        )
        .await?;
        return Ok(RoutedPullRequest { placed: false, key: Some(key) });
    }

    let item_id = trama_core::ids::uid("ri");
    let claim = state
        .db
        .query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            r#"INSERT INTO "routing_rule_items"
               ("id", "workspaceId", "ruleId", "provider", "host", "repository", "kind", "externalId", "url")
               VALUES ($1,$2,$3,$4,$5,$6,'pull_request',$7,$8)
               ON CONFLICT ("workspaceId","provider","host","repository","kind","externalId") DO NOTHING
               RETURNING "id""#,
            [
                item_id.clone().into(),
                workspace_id.clone().into(),
                rule.id.clone().into(),
                provider.as_str().to_owned().into(),
                connection.host.clone().into(),
                repository.into(),
                candidate.external_id.clone().into(),
                candidate.url.clone().into(),
            ],
        ))
        .await?;
    if claim.is_none() {
        return Ok(RoutedPullRequest { placed: false, key: None });
    }
    let source = match provider {
        GitProvider::Github => IssueSource::Github,
        GitProvider::Gitlab => IssueSource::Gitlab,
        GitProvider::Bitbucket => IssueSource::Api,
    };
    let mut input = NewIssue::new(
        IssueKind::Feature,
        candidate.title.trim().chars().take(300).collect::<String>(),
    );
    input.body = candidate.texts.get(1).map(|body| body.chars().take(20_000).collect());
    input.source = Some(source);
    input.project_id = Some(rule.project_id.clone());
    input.external_url = candidate.url.clone();
    input.status = Some(
        match candidate.state.unwrap_or(ArtifactState::Open) {
            ArtifactState::Merged => "done",
            ArtifactState::Closed => "canceled",
            ArtifactState::Draft => "in_progress",
            _ => "in_review",
        }
        .to_owned(),
    );
    let task = match service::create(state, &workspace_id, &ActorRef::system(), input).await {
        Ok(task) => task,
        Err(error) => {
            routing_rule_items::Entity::delete_by_id(&item_id).exec(&state.db).await?;
            return Err(error);
        }
    };
    let mut attached = candidate.clone();
    attached.texts.push(task.key.clone());
    if let Err(error) = trama_integrations::linker::upsert(
        state,
        &workspace_id,
        &repo.full_name,
        &attached,
        Some(&connection.host),
    )
    .await
    {
        routing_rule_items::Entity::delete_by_id(&item_id).exec(&state.db).await?;
        return Err(error);
    }
    let mut item = routing_rule_items::Entity::find_by_id(&item_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::internal("Routing claim disappeared"))?
        .into_active_model();
    item.issue_id = Set(Some(task.id));
    item.update(&state.db).await?;
    record_success(state, &rule.id).await?;
    Ok(RoutedPullRequest { placed: true, key: Some(task.key) })
}
