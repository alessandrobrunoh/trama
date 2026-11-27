//! Project routing-rules HTTP endpoints.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::access::MemberGrant;
use trama_contracts::roles::Capability;
use trama_contracts::routing::{
    RoutingConnectionOption, RoutingFilters, RoutingRule, RoutingRuleConnection, RoutingRuleHealth,
    RoutingRuleStats, RoutingRulesOverview, RoutingSuggestions,
};
use trama_core::{ApiJson, AppError, AppState};
use trama_entities::{routing_rule_items, routing_rules};
use utoipa::OpenApi;

use crate::schemas::{ConnectionQuery, CreateRuleBody, SuggestionsQuery, UpdateRuleBody};
use crate::service;

fn can_manage(ctx: &Ctx) -> bool {
    ctx.can_do(Capability::CreateIssues)
        && ctx.access.as_ref().is_none_or(|access| {
            MemberGrant::parse("issues:create").is_some_and(|grant| {
                access.grants.contains(&grant) && !ctx.effective_role.grants.contains(&grant)
            })
        })
}

fn assert_writer(ctx: &Ctx) -> Result<(), AppError> {
    if can_manage(ctx) {
        Ok(())
    } else {
        Err(AppError::forbidden("You are not allowed to add sources to this project"))
    }
}

#[derive(OpenApi)]
#[openapi(
    paths(overview, connections, suggestions, create, update, remove),
    components(schemas(
        RoutingRulesOverview,
        RoutingRuleStats,
        RoutingRule,
        CreateRuleBody,
        UpdateRuleBody,
        ConnectionQuery,
        SuggestionsQuery,
        RoutingConnectionOption,
        RoutingSuggestions,
    ))
)]
/// OpenAPI document for routing.
pub struct ApiDoc;

/// Project-scoped read routes; mutating rules require the issue-creation capability.
pub fn router() -> Routes {
    let write = Gate::authenticated().can(Capability::CreateIssues);
    Routes::new()
        .get("/w/{slug}/projects/{projectId}/routing-rules", Gate::authenticated(), overview)
        .get(
            "/w/{slug}/projects/{projectId}/routing-rules/connections",
            Gate::authenticated(),
            connections,
        )
        .get("/w/{slug}/projects/{projectId}/routing-rules/suggestions", write, suggestions)
        .post("/w/{slug}/projects/{projectId}/routing-rules", write, create)
        .patch("/w/{slug}/projects/{projectId}/routing-rules/{ruleId}", write, update)
        .delete("/w/{slug}/projects/{projectId}/routing-rules/{ruleId}", write, remove)
}

/// List rules for a project. The workspace and project are always checked together.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Project routing rules", body = RoutingRulesOverview),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or project"),
    )
)]
async fn overview(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id)): Path<(String, String)>,
) -> Result<Json<RoutingRulesOverview>, AppError> {
    trama_projects::service::get(&state.db, &ctx.workspace.id, &project_id).await?;
    let rows = routing_rules::Entity::find()
        .filter(routing_rules::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(routing_rules::Column::ProjectId.eq(&project_id))
        .order_by_asc(routing_rules::Column::CreatedAt)
        .order_by_asc(routing_rules::Column::Id)
        .all(&state.db)
        .await?;
    let ids: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
    let items = if ids.is_empty() {
        Vec::new()
    } else {
        routing_rule_items::Entity::find()
            .filter(routing_rule_items::Column::RuleId.is_in(ids))
            .all(&state.db)
            .await?
    };
    let recent = items
        .iter()
        .filter(|i| i.created_at.timestamp() > chrono::Utc::now().timestamp() - 7 * 86_400)
        .collect::<Vec<_>>();
    let counts =
        items.iter().fold(std::collections::HashMap::<String, i64>::new(), |mut map, item| {
            if let Some(rule_id) = &item.rule_id {
                *map.entry(rule_id.clone()).or_default() += 1;
            }
            map
        });
    let mut presented = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut view = rule_view(&state, row.clone(), ctx.user_id.as_deref()).await?;
        view.task_count = counts.get(&row.id).copied().unwrap_or_default();
        presented.push(view);
    }
    let rules_failing = i64::try_from(
        presented.iter().filter(|rule| rule.health == RoutingRuleHealth::Error).count(),
    )
    .unwrap_or(i64::MAX);
    Ok(Json(RoutingRulesOverview {
        rules: presented,
        stats: RoutingRuleStats {
            tasks_arrived: i64::try_from(recent.iter().filter(|i| i.kind == "issue").count())
                .unwrap_or(i64::MAX),
            unmatched_placed: i64::try_from(
                recent.iter().filter(|i| i.kind == "pull_request").count(),
            )
            .unwrap_or(i64::MAX),
            rules_failing,
        },
        can_manage: can_manage(&ctx),
    }))
}

/// Workspace and personal connections this caller can route through.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules/connections",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID"),
        ("provider" = Option<String>, Query, description = "Optional provider filter")
    ),
    responses(
        (status = 200, description = "Usable connections", body = [RoutingConnectionOption]),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown project"),
    )
)]
async fn connections(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id)): Path<(String, String)>,
    Query(query): Query<ConnectionQuery>,
) -> Result<Json<Vec<RoutingConnectionOption>>, AppError> {
    trama_projects::service::get(&state.db, &ctx.workspace.id, &project_id).await?;
    Ok(Json(
        service::connection_options(
            &state,
            &ctx.workspace.id,
            ctx.user_id.as_deref(),
            query.provider,
        )
        .await?,
    ))
}

/// Suggest reachable repositories and indicate where each currently routes.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules/suggestions",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID"),
        ("provider" = String, Query, description = "Git provider"),
        ("connectionId" = Option<String>, Query, description = "Optional connection"),
        ("q" = Option<String>, Query, description = "Search query")
    ),
    responses(
        (status = 200, description = "Repository suggestions", body = RoutingSuggestions),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs issue creation permission"),
        (status = 404, description = "Unknown project or connection"),
    )
)]
async fn suggestions(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id)): Path<(String, String)>,
    Query(query): Query<SuggestionsQuery>,
) -> Result<Json<RoutingSuggestions>, AppError> {
    assert_writer(&ctx)?;
    trama_projects::service::get(&state.db, &ctx.workspace.id, &project_id).await?;
    Ok(Json(
        service::suggestions(&state, &ctx.workspace.id, &project_id, ctx.user_id.as_deref(), query)
            .await?,
    ))
}

/// Create a source rule for a project.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID")
    ),
    request_body = CreateRuleBody,
    responses(
        (status = 201, description = "Created routing rule", body = RoutingRule),
        (status = 400, description = "Invalid source or filter"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs issue creation permission"),
        (status = 404, description = "Project or usable connection not found"),
        (status = 409, description = "Source overlaps another rule"),
    )
)]
async fn create(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<CreateRuleBody>,
) -> Result<(StatusCode, Json<RoutingRule>), AppError> {
    assert_writer(&ctx)?;
    let row = service::create_rule(
        &state,
        &ctx.workspace.id,
        &project_id,
        ctx.user_id.as_deref(),
        &ctx.actor,
        body,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(rule_view(&state, row, ctx.user_id.as_deref()).await?)))
}

/// Update a project routing rule.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules/{ruleId}",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID"),
        ("ruleId" = String, Path, description = "Routing rule ID")
    ),
    request_body = UpdateRuleBody,
    responses(
        (status = 200, description = "Updated routing rule", body = RoutingRule),
        (status = 400, description = "Invalid update"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs issue creation permission"),
        (status = 404, description = "Project, rule or usable connection not found"),
        (status = 409, description = "Source overlaps another rule"),
    )
)]
async fn update(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id, rule_id)): Path<(String, String, String)>,
    ApiJson(body): ApiJson<UpdateRuleBody>,
) -> Result<Json<RoutingRule>, AppError> {
    assert_writer(&ctx)?;
    let row = service::update_rule(
        &state,
        &ctx.workspace.id,
        &project_id,
        &rule_id,
        ctx.user_id.as_deref(),
        body,
    )
    .await?;
    Ok(Json(rule_view(&state, row, ctx.user_id.as_deref()).await?))
}

/// Delete a project routing rule.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/projects/{projectId}/routing-rules/{ruleId}",
    tag = "routing",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("projectId" = String, Path, description = "Project ID"),
        ("ruleId" = String, Path, description = "Routing rule ID")
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Needs issue creation permission"),
        (status = 404, description = "No rule in this project"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, project_id, rule_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AppError> {
    assert_writer(&ctx)?;
    trama_projects::service::get(&state.db, &ctx.workspace.id, &project_id).await?;
    service::remove_rule(&state, &ctx.workspace.id, &project_id, &rule_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rule_view(
    state: &AppState,
    row: routing_rules::Model,
    user_id: Option<&str>,
) -> Result<RoutingRule, AppError> {
    let filters = serde_json::from_value::<RoutingFilters>(row.filters.clone()).unwrap_or_default();
    let say_path = if row.source_path.ends_with("/*") {
        &row.source_path[..row.source_path.len() - 2]
    } else {
        &row.source_path
    };
    let connection_model = if let Some(id) = &row.connection_id {
        trama_entities::integration_connections::Entity::find_by_id(id).one(&state.db).await?
    } else {
        None
    };
    let connection = if let Some(connection_model) = &connection_model {
        let view = trama_integrations::service::summarize(
            &state.db,
            std::slice::from_ref(connection_model),
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("Connection summary missing"))?;
        Some(RoutingRuleConnection {
            id: view.id,
            provider: view
                .provider
                .git()
                .ok_or_else(|| AppError::internal("Routing connection is not a git host"))?,
            label: view.label,
            owner_type: view.owner_type,
            owner_name: view.owner_name,
            mine: (view.owner_type == trama_contracts::integrations::ConnectionOwnerType::User
                && view.owner_user_id.as_deref() == user_id)
                .then_some(true),
        })
    } else {
        None
    };
    let (health, health_reason) = match connection_model.as_ref() {
        None => (
            RoutingRuleHealth::Error,
            Some(format!(
                "The connection this source read through was removed. New issues from {say_path} aren't arriving."
            )),
        ),
        Some(conn) if conn.status == "revoked" => (
            RoutingRuleHealth::Error,
            Some(format!(
                "{}'s connection was revoked. New issues from {say_path} aren't arriving.",
                connection.as_ref().and_then(|c| c.owner_name.as_deref()).unwrap_or("The owner")
            )),
        ),
        Some(conn) if conn.status != "connected" => (
            RoutingRuleHealth::Error,
            Some(format!("The connection is failing. New issues from {say_path} may not arrive.")),
        ),
        Some(_) if row.last_error.is_some() => (RoutingRuleHealth::Error, row.last_error.clone()),
        Some(_) => (RoutingRuleHealth::Ok, None),
    };
    Ok(RoutingRule {
        id: row.id,
        workspace_id: row.workspace_id,
        project_id: row.project_id,
        connection_id: row.connection_id,
        provider: serde_json::from_value(serde_json::Value::String(row.provider.clone()))
            .map_err(|_| AppError::internal("Invalid routing-rule provider"))?,
        host: row.host,
        source_path: row.source_path,
        filters,
        direction: serde_json::from_value(serde_json::Value::String(row.direction))
            .map_err(|_| AppError::internal("Invalid routing-rule direction"))?,
        connection,
        health,
        health_reason,
        last_sync_at: row.last_sync_at.as_ref().map(trama_core::time::to_iso),
        last_error: row.last_error,
        task_count: 0,
        migrated_from: row.migrated_from,
        created_by: serde_json::from_value(row.created_by)
            .map_err(|_| AppError::internal("Invalid routing-rule actor data"))?,
        created_at: trama_core::time::to_iso(&row.created_at),
        updated_at: trama_core::time::to_iso(&row.updated_at),
    })
}
