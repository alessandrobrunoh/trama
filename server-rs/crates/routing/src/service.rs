//! Database-backed routing lookups for integration ingestion and importers.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter, Set,
    TransactionTrait,
};
use trama_contracts::common::{ActorRef, GitProvider};
use trama_contracts::integrations::{ConnectionOwnerType, ConnectionProvider, ConnectionStatus};
use trama_contracts::routing::{
    RoutingConnectionOption, RoutingDirection, RoutingFilters, RoutingRuleConnection,
    RoutingSourceSuggestion, RoutingSuggestionStatus, RoutingSuggestions,
};
use trama_core::validation::Patch;
use trama_core::{AppError, AppState};
use trama_entities::{integration_connections, projects, routing_rules};

use crate::schemas::{CreateRuleBody, SuggestionsQuery, UpdateRuleBody};
use crate::source_path::{filters_match, source_includes, specificity};

/// Routing candidate attributes used by incoming webhook handlers.
#[derive(Clone, Debug, Default)]
pub struct ItemAttributes {
    /// External labels.
    pub labels: Vec<String>,
    /// External milestone title, if any.
    pub milestone: Option<String>,
}

/// The rule selected for an incoming item. The workspace and project IDs must be used as a
/// coupled scope by the caller when creating the task.
#[derive(Clone, Debug)]
pub struct ResolvedRule {
    /// Rule row.
    pub rule: routing_rules::Model,
}

/// Parse and validate connection source strings (URLs and SSH remotes are accepted).
fn source_path(provider: GitProvider, raw: &str, host: &str) -> Result<String, AppError> {
    let mut text = raw.trim().to_owned();
    let mut source_host = None;
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        let rest = text.split_once("://").map_or("", |(_, rest)| rest);
        let mut parts = rest.splitn(2, '/');
        source_host = parts.next().map(str::to_ascii_lowercase);
        text = parts.next().unwrap_or_default().to_owned();
    } else if let Some(rest) = text.strip_prefix("ssh://git@") {
        let mut parts = rest.splitn(2, '/');
        source_host = parts.next().map(str::to_ascii_lowercase);
        text = parts.next().unwrap_or_default().to_owned();
    } else if let Some(rest) = text.strip_prefix("git@") {
        let mut parts = rest.splitn(2, ':');
        source_host = parts.next().map(str::to_ascii_lowercase);
        text = parts.next().unwrap_or_default().to_owned();
    }
    text = text.split(['?', '#']).next().unwrap_or_default().trim_matches('/').to_owned();
    if text.to_ascii_lowercase().ends_with(".git") {
        text.truncate(text.len() - 4);
    }
    if source_host.as_ref().is_some_and(|h| h != host && h != &format!("www.{host}")) {
        return Err(AppError::bad_request(format!(
            "That address is on {}, but this connection reaches {host}",
            source_host.unwrap_or_default()
        )));
    }
    crate::source_path::normalize_source_path(provider.as_str(), &text)
        .map_err(AppError::bad_request)
}

fn normalized_filters(filters: Option<RoutingFilters>) -> Result<RoutingFilters, AppError> {
    let filters = filters.unwrap_or_default();
    let mut labels = Vec::new();
    for label in filters.labels.unwrap_or_default() {
        let label = label.trim().to_owned();
        if !label.is_empty()
            && !labels.iter().any(|known: &String| known.eq_ignore_ascii_case(&label))
        {
            if label.chars().count() > 100 {
                return Err(AppError::bad_request("A label filter is too long"));
            }
            labels.push(label);
        }
    }
    if labels.len() > 10 {
        return Err(AppError::bad_request("At most 10 label filters"));
    }
    let milestone = filters.milestone.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
    if milestone.as_ref().is_some_and(|m| m.chars().count() > 100) {
        return Err(AppError::bad_request("The milestone filter is too long"));
    }
    Ok(RoutingFilters { labels: (!labels.is_empty()).then_some(labels), milestone })
}

fn filter_key(filters: &RoutingFilters) -> String {
    let mut parts = Vec::new();
    if let Some(labels) = &filters.labels {
        let mut labels: Vec<_> = labels.iter().map(|s| s.to_ascii_lowercase()).collect();
        labels.sort();
        parts.push(format!("l:{}", labels.join(",")));
    }
    if let Some(milestone) = &filters.milestone {
        parts.push(format!("m:{}", milestone.to_ascii_lowercase()));
    }
    parts.join("|")
}

fn filters_overlap(a: &RoutingFilters, b: &RoutingFilters) -> bool {
    !matches!((&a.milestone, &b.milestone), (Some(a), Some(b)) if !a.eq_ignore_ascii_case(b))
}

async fn usable_connection(
    state: &AppState,
    user_id: Option<&str>,
    workspace_id: &str,
    connection_id: &str,
) -> Result<integration_connections::Model, AppError> {
    let Some(user_id) = user_id else {
        return Err(AppError::entity_not_found("Connection", connection_id));
    };
    let usable =
        trama_integrations::connections::usable_for(&state.db, user_id, workspace_id).await?;
    if !usable.iter().any(|c| c.connection.id == connection_id) {
        return Err(AppError::entity_not_found("Connection", connection_id));
    }
    integration_connections::Entity::find_by_id(connection_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Connection", connection_id))
}

/// Return only connections the caller may use: personal connections plus workspace connections
/// where the caller has integration-management permission. Agent tokens have no user and see none.
///
/// # Errors
///
/// Returns a database error while resolving membership or connections.
pub async fn connection_options(
    state: &AppState,
    workspace_id: &str,
    user_id: Option<&str>,
    provider: Option<GitProvider>,
) -> Result<Vec<RoutingConnectionOption>, AppError> {
    let Some(user_id) = user_id else { return Ok(Vec::new()) };
    let rows =
        trama_integrations::connections::usable_for(&state.db, user_id, workspace_id).await?;
    Ok(rows
        .into_iter()
        .filter_map(|usable| {
            let connection = usable.connection;
            let git_provider = connection.provider.git()?;
            if provider.is_some_and(|p| p != git_provider) {
                return None;
            }
            Some(RoutingConnectionOption {
                connection: RoutingRuleConnection {
                    id: connection.id.clone(),
                    provider: git_provider,
                    label: connection.label.clone(),
                    owner_type: connection.owner_type,
                    owner_name: connection.owner_name,
                    mine: (connection.owner_type == ConnectionOwnerType::User
                        && connection.owner_user_id.as_deref() == Some(user_id))
                    .then_some(true),
                },
                account: connection.account,
                suggested: usable.suggested,
                healthy: connection.status == ConnectionStatus::Connected,
            })
        })
        .collect())
}

/// Ask connected git providers for a bounded repository sample and annotate each path with its
/// existing workspace destination. Provider failures produce an `error` field, never credentials.
///
/// # Errors
///
/// Returns a database error for rule, project or connection reads.
#[allow(clippy::too_many_lines)]
pub async fn suggestions(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
    user_id: Option<&str>,
    query: SuggestionsQuery,
) -> Result<RoutingSuggestions, AppError> {
    if query.connection_id.as_ref().is_some_and(|id| id.is_empty() || id.chars().count() > 100) {
        return Err(AppError::bad_request("Invalid connectionId"));
    }
    if query.q.as_ref().is_some_and(|q| q.chars().count() > 200) {
        return Err(AppError::bad_request("Search query is too long"));
    }
    if let Some(connection_id) = query.connection_id.as_deref() {
        let Some(user_id) = user_id else {
            return Err(AppError::entity_not_found("Connection", connection_id));
        };
        let usable =
            trama_integrations::connections::usable_for(&state.db, user_id, workspace_id).await?;
        if !usable.iter().any(|c| c.connection.id == connection_id) {
            return Err(AppError::entity_not_found("Connection", connection_id));
        }
    }
    let Some(user_id) = user_id else {
        return Ok(RoutingSuggestions { items: Vec::new(), error: None });
    };
    let usable =
        trama_integrations::connections::usable_for(&state.db, user_id, workspace_id).await?;
    let mut candidates = Vec::new();
    let mut source_error = false;
    for connection in usable {
        if connection.connection.provider.git() != Some(query.provider)
            || query.connection_id.as_ref().is_some_and(|id| id != &connection.connection.id)
            || connection.connection.status != ConnectionStatus::Connected
        {
            continue;
        }
        let row = integration_connections::Entity::find_by_id(&connection.connection.id)
            .one(&state.db)
            .await?;
        let Some(row) = row else { continue };
        let Ok(client) = trama_integrations::service::connection_client(state, &row) else {
            source_error = true;
            continue;
        };
        for page in 1..=2 {
            let Ok(result) = client.list_repositories(page, 100).await else {
                source_error = true;
                break;
            };
            for repo in result.items {
                if query.q.as_ref().is_none_or(|q| {
                    repo.full_name.to_lowercase().contains(&q.trim().to_lowercase())
                }) {
                    candidates.push((
                        connection.connection.host.clone(),
                        repo.full_name,
                        repo.url,
                        repo.private,
                    ));
                }
            }
            if !result.has_more {
                break;
            }
        }
    }
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::Provider.eq(query.provider.as_str()))
        .all(&state.db)
        .await?;
    let project_names: std::collections::HashMap<_, _> = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|project| (project.id, project.name))
        .collect();
    let mark = |host: &str, source_path: String, url: Option<String>, private: Option<bool>| {
        let hit = rows
            .iter()
            .filter(|r| {
                r.host.eq_ignore_ascii_case(host)
                    && crate::source_path::sources_overlap(&r.source_path, &source_path)
            })
            .max_by_key(|r| {
                let filters =
                    serde_json::from_value::<RoutingFilters>(r.filters.clone()).unwrap_or_default();
                specificity(&r.source_path, &filters)
            });
        match hit {
            None => RoutingSourceSuggestion {
                source_path,
                url,
                private,
                status: RoutingSuggestionStatus::Available,
                project_id: None,
                project_name: None,
            },
            Some(rule) if rule.project_id == project_id => RoutingSourceSuggestion {
                source_path,
                url,
                private,
                status: RoutingSuggestionStatus::ThisProject,
                project_id: Some(project_id.to_owned()),
                project_name: None,
            },
            Some(rule) => RoutingSourceSuggestion {
                source_path,
                url,
                private,
                status: RoutingSuggestionStatus::OtherProject,
                project_id: Some(rule.project_id.clone()),
                project_name: (!trama_auth::member_access::project_hidden(
                    trama_auth::member_access::current_access().as_deref(),
                    Some(&rule.project_id),
                ))
                .then(|| project_names.get(&rule.project_id).cloned())
                .flatten(),
            },
        }
    };
    let mut suggestions: Vec<_> = candidates
        .iter()
        .map(|(host, source_path, url, private)| {
            mark(host, source_path.clone(), Some(url.clone()), *private)
        })
        .collect();
    let mut groups = std::collections::BTreeSet::new();
    for (host, source_path, _, _) in &candidates {
        if let Some((owner, _)) = source_path.rsplit_once('/') {
            groups.insert((host.clone(), owner.to_owned()));
        }
    }
    for (host, owner) in groups {
        suggestions.push(mark(&host, format!("{owner}/*"), None, None));
    }
    suggestions.sort_by_key(|item| match item.status {
        RoutingSuggestionStatus::Available => 0,
        RoutingSuggestionStatus::ThisProject => 1,
        RoutingSuggestionStatus::OtherProject => 2,
    });
    suggestions.truncate(20);
    Ok(RoutingSuggestions {
        items: suggestions,
        error: source_error.then(|| "The source could not be listed right now".to_owned()),
    })
}

/// Resolve the most-specific rule for an item arriving through the given connection.
///
/// The connection binding is deliberate: knowing a provider/repository is not sufficient to
/// trust an event from an unrelated integration.
///
/// # Errors
///
/// Returns a database error if the rules cannot be read.
pub async fn resolve_for_connection<C: ConnectionTrait>(
    db: &C,
    connection_id: &str,
    provider: GitProvider,
    repository: &str,
    item: &ItemAttributes,
) -> Result<Option<ResolvedRule>, AppError> {
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::ConnectionId.eq(connection_id))
        .filter(routing_rules::Column::Provider.eq(provider.as_str()))
        .all(db)
        .await?;
    let mut matches: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            source_includes(&r.source_path, repository)
                && serde_json::from_value::<RoutingFilters>(r.filters.clone())
                    .is_ok_and(|f| filters_match(&f, &item.labels, item.milestone.as_deref()))
        })
        .collect();
    matches.sort_by_key(|r| {
        let filters =
            serde_json::from_value::<RoutingFilters>(r.filters.clone()).unwrap_or_default();
        (std::cmp::Reverse(specificity(&r.source_path, &filters)), r.created_at)
    });
    Ok(matches.into_iter().next().map(|rule| ResolvedRule { rule }))
}

/// Resolve the project for an importer. Filtered rules are deliberately excluded: an importer
/// lacks per-item metadata and must not guess which filtered destination applies.
///
/// # Errors
///
/// Returns a database error if the rules cannot be read.
pub async fn project_for_repository<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    provider: GitProvider,
    host: &str,
    repository: &str,
) -> Result<Option<String>, AppError> {
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::Provider.eq(provider.as_str()))
        .all(db)
        .await?;
    let mut matches: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            r.host.eq_ignore_ascii_case(host)
                && r.filter_key.is_empty()
                && source_includes(&r.source_path, repository)
        })
        .collect();
    matches.sort_by_key(|r| {
        let filters = RoutingFilters::default();
        std::cmp::Reverse(specificity(&r.source_path, &filters))
    });
    Ok(matches.into_iter().next().map(|r| r.project_id))
}

/// GitHub repositories routed on github.com; used to seed import project mappings.
///
/// # Errors
///
/// Returns a database error if the rules cannot be read.
pub async fn routed_repositories<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::Provider.eq("github"))
        .filter(routing_rules::Column::Host.eq("github.com"))
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .filter(|r| r.filter_key.is_empty())
        .map(|r| (r.source_path, r.project_id))
        .collect())
}

/// Add a rule after checking connection ownership, provider, project scope and overlap.
///
/// # Errors
///
/// Returns 400 for invalid source/filter/direction, 404 for an inaccessible connection/project,
/// and 409 when an overlapping rule already routes the source.
pub async fn create_rule(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
    user_id: Option<&str>,
    actor: &ActorRef,
    body: CreateRuleBody,
) -> Result<routing_rules::Model, AppError> {
    if body.source_path.trim().is_empty() || body.source_path.chars().count() > 300 {
        return Err(AppError::bad_request("Invalid sourcePath"));
    }
    if body.connection_id.is_empty() || body.connection_id.chars().count() > 100 {
        return Err(AppError::bad_request("Invalid connectionId"));
    }
    trama_projects::service::get(&state.db, workspace_id, project_id).await?;
    let connection = usable_connection(state, user_id, workspace_id, &body.connection_id).await?;
    if connection.provider != ConnectionProvider::from(body.provider).as_str() {
        return Err(AppError::bad_request(
            "The connection provider does not match the source provider",
        ));
    }
    let path = source_path(body.provider, &body.source_path, &connection.host)?;
    let filters = normalized_filters(body.filters)?;
    let direction = body.direction.unwrap_or(RoutingDirection::Inbound);
    if direction == RoutingDirection::TwoWay && !body.provider.routing_support().two_way {
        return Err(AppError::bad_request(format!(
            "{} sources can only be inbound for now",
            body.provider.meta().label
        )));
    }
    let txn = state.db.begin().await?;
    txn.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [format!("routing:{workspace_id}").into()],
    ))
    .await?;
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::Provider.eq(body.provider.as_str()))
        .all(&txn)
        .await?;
    let clash = rows.iter().find(|r| {
        r.host.eq_ignore_ascii_case(&connection.host)
            && crate::source_path::sources_overlap(&r.source_path, &path)
            && serde_json::from_value::<RoutingFilters>(r.filters.clone())
                .is_ok_and(|old| filters_overlap(&old, &filters))
    });
    if let Some(clash) = clash {
        let project = projects::Entity::find_by_id(&clash.project_id).one(&txn).await?;
        let where_to = project
            .filter(|p| {
                !trama_auth::member_access::project_hidden(
                    trama_auth::member_access::current_access().as_deref(),
                    Some(&p.id),
                )
            })
            .map_or_else(
                || "another project".to_owned(),
                |project| format!("the project \"{}\"", project.name),
            );
        let how = if clash.source_path.eq_ignore_ascii_case(&path) {
            format!("{path} already goes to {where_to}")
        } else {
            format!("{path} overlaps {}, which already goes to {where_to}", clash.source_path)
        };
        return Err(AppError::conflict(format!(
            "{how}. One source, one project: remove that source first, or give the rules filters that cannot match the same item (different milestones)."
        )));
    }
    let id = trama_core::ids::uid("rr");
    let now = chrono::Utc::now().fixed_offset();
    routing_rules::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        connection_id: Set(Some(connection.id)),
        provider: Set(body.provider.as_str().to_owned()),
        host: Set(connection.host),
        source_path: Set(path),
        filters: Set(serde_json::to_value(&filters).map_err(AppError::internal)?),
        filter_key: Set(filter_key(&filters)),
        direction: Set(direction.as_str().to_owned()),
        created_by: Set(serde_json::to_value(actor).map_err(AppError::internal)?),
        migrated_from: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        last_sync_at: Set(None),
        last_error: Set(None),
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;
    routing_rules::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::internal("Created routing rule disappeared"))
}

/// Update a project rule while keeping provider and host affinity of its source.
///
/// # Errors
///
/// Returns 404 for a rule outside the workspace/project, 400 for invalid values, and 409 for
/// overlapping rules.
pub async fn update_rule(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
    rule_id: &str,
    user_id: Option<&str>,
    patch: UpdateRuleBody,
) -> Result<routing_rules::Model, AppError> {
    if let Patch::Value(connection_id) = &patch.connection_id
        && (connection_id.is_empty() || connection_id.chars().count() > 100)
    {
        return Err(AppError::bad_request("Invalid connectionId"));
    }
    trama_projects::service::get(&state.db, workspace_id, project_id).await?;
    let txn = state.db.begin().await?;
    txn.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [format!("routing:{workspace_id}").into()],
    ))
    .await?;
    let mut row = routing_rules::Entity::find_by_id(rule_id)
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::ProjectId.eq(project_id))
        .one(&txn)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Routing rule", rule_id))?;
    let mut changed = false;
    if let Patch::Value(connection_id) = &patch.connection_id {
        let provider = GitProvider::parse(&row.provider)
            .ok_or_else(|| AppError::internal("Unknown routing provider"))?;
        let connection = usable_connection(state, user_id, workspace_id, connection_id).await?;
        if connection.provider != ConnectionProvider::from(provider).as_str() {
            return Err(AppError::bad_request(
                "The connection provider does not match the source provider",
            ));
        }
        if connection.host != row.host {
            return Err(AppError::bad_request(format!(
                "This connection does not reach {}",
                row.host
            )));
        }
        row.connection_id = Some(connection.id);
        row.last_error = None;
        changed = true;
    } else if matches!(&patch.connection_id, Patch::Null) {
        return Err(AppError::bad_request("connectionId must not be null"));
    }
    let mut filters =
        serde_json::from_value::<RoutingFilters>(row.filters.clone()).unwrap_or_default();
    if let Patch::Value(replacement) = &patch.filters {
        filters = normalized_filters(Some(replacement.clone()))?;
        row.filters = serde_json::to_value(&filters).map_err(AppError::internal)?;
        row.filter_key = filter_key(&filters);
        changed = true;
    } else if matches!(&patch.filters, Patch::Null) {
        return Err(AppError::bad_request("filters must not be null"));
    }
    if let Patch::Value(direction) = &patch.direction {
        let provider = GitProvider::parse(&row.provider)
            .ok_or_else(|| AppError::internal("Unknown routing provider"))?;
        if *direction == RoutingDirection::TwoWay && !provider.routing_support().two_way {
            return Err(AppError::bad_request(format!(
                "{} sources can only be inbound for now",
                provider.meta().label
            )));
        }
        direction.as_str().clone_into(&mut row.direction);
        changed = true;
    } else if matches!(&patch.direction, Patch::Null) {
        return Err(AppError::bad_request("direction must not be null"));
    }
    if changed {
        let candidates = routing_rules::Entity::find()
            .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
            .filter(routing_rules::Column::Provider.eq(row.provider.clone()))
            .all(&txn)
            .await?;
        if candidates.iter().filter(|candidate| candidate.id != row.id).any(|candidate| {
            candidate.host.eq_ignore_ascii_case(&row.host)
                && crate::source_path::sources_overlap(&candidate.source_path, &row.source_path)
                && serde_json::from_value::<RoutingFilters>(candidate.filters.clone())
                    .is_ok_and(|other| filters_overlap(&other, &filters))
        }) {
            return Err(AppError::conflict("This source overlaps an existing routing rule"));
        }
        row.updated_at = chrono::Utc::now().fixed_offset();
        row = row.into_active_model().reset_all().update(&txn).await?;
    }
    txn.commit().await?;
    Ok(row)
}

/// Remove a rule only within its workspace/project scope.
///
/// # Errors
///
/// Returns 404 when no such rule exists in the caller's project.
pub async fn remove_rule(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
    rule_id: &str,
) -> Result<(), AppError> {
    let result = routing_rules::Entity::delete_many()
        .filter(routing_rules::Column::Id.eq(rule_id))
        .filter(routing_rules::Column::WorkspaceId.eq(workspace_id))
        .filter(routing_rules::Column::ProjectId.eq(project_id))
        .exec(&state.db)
        .await?;
    if result.rows_affected == 0 {
        return Err(AppError::entity_not_found("Routing rule", rule_id));
    }
    Ok(())
}
