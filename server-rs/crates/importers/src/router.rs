//! Import credential and job routes.
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set,
};
use serde::Deserialize;
use serde_json::{Value, json};
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::roles::Capability;
use trama_contracts::{common::ActorRef, imports::ExternalProvider};
use trama_core::ApiJson;
use trama_core::{AppError, AppState};
use trama_entities::{import_jobs, tracker_credentials};
use utoipa::OpenApi;

const MANAGE: Gate = Gate::authenticated().can(Capability::ManageIntegrations);

#[derive(OpenApi)]
#[openapi()]
/// OpenAPI document for importer routes.
pub struct ApiDoc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCredentialBody {
    provider: ExternalProvider,
    token: String,
    base_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBody {
    provider: ExternalProvider,
    credential_id: Option<String>,
    connection_id: Option<String>,
    source: PreviewSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSource {
    repository: Option<String>,
    team_ids: Option<Vec<String>>,
}

/// Workspace-scoped importer routes.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/imports", MANAGE, list_jobs)
        .get("/w/{slug}/imports/{id}", MANAGE, get_job)
        .post("/w/{slug}/imports/{id}/cancel", MANAGE, cancel_job)
        .post("/w/{slug}/imports/{id}/retry", MANAGE, retry_job)
        .delete("/w/{slug}/imports/{id}", MANAGE, remove_job)
        .get("/w/{slug}/imports/credentials", MANAGE, list_credentials)
        .post("/w/{slug}/imports/credentials", MANAGE, create_credential)
        .delete("/w/{slug}/imports/credentials/{id}", MANAGE, remove_credential)
        .post("/w/{slug}/imports/preview", MANAGE, preview)
        .merge(crate::external_links::routes())
}

async fn preview(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<PreviewBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.credential_id.as_deref().is_some_and(str::is_empty)
        || body.connection_id.as_deref().is_some_and(str::is_empty)
    {
        return Err(AppError::bad_request("credentialId and connectionId must be non-empty"));
    }
    let credential = crate::credentials::resolve(
        &state,
        &ctx.workspace.id,
        body.provider,
        body.credential_id.as_deref(),
        body.connection_id.as_deref(),
    )
    .await?;
    let preview = if body.provider == ExternalProvider::Github {
        let repository = crate::service::parse_repository(body.source.repository.as_deref())?;
        crate::service::github_preview(&state, &repository, credential).await?
    } else {
        let ids = body.source.team_ids.as_deref().unwrap_or_default();
        if ids.len() > 50 {
            return Err(AppError::bad_request(
                "source.teamIds must contain no more than 50 elements",
            ));
        }
        crate::service::validate_team_ids(Some(ids))?;
        crate::service::linear_preview(&state, credential).await?
    };
    Ok((StatusCode::OK, Json(preview)))
}

async fn create_credential(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateCredentialBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let token = body.token.trim();
    if token.chars().count() < 8 || token.chars().count() > 500 {
        return Err(AppError::bad_request(
            "token must be longer than or equal to 8 and shorter than or equal to 500 characters",
        ));
    }
    if body.base_url.as_ref().is_some_and(|url| url.chars().count() > 500) {
        return Err(AppError::bad_request(
            "baseUrl must be shorter than or equal to 500 characters",
        ));
    }
    let actor: &ActorRef = &actor;
    let value = crate::credentials::create(
        &state,
        &ctx.workspace.id,
        actor,
        body.provider,
        token,
        body.base_url.as_deref(),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(value)))
}

fn present(row: &import_jobs::Model) -> Value {
    json!({
        "id": row.id, "workspaceId": row.workspace_id, "provider": row.provider,
        "status": row.status, "sourceLabel": row.source_label, "source": row.source,
        "options": row.options, "mapping": row.mapping,
        "progress": row.progress, "errors": row.errors,
        "waitingUntil": row.waiting_until.map(|v| v.to_rfc3339()),
        "cancelRequested": row.cancel_requested, "lastError": row.last_error,
        "createdAt": row.created_at.to_rfc3339(),
        "startedAt": row.started_at.map(|v| v.to_rfc3339()),
        "finishedAt": row.finished_at.map(|v| v.to_rfc3339())
    })
}

async fn list_jobs(ctx: Ctx, State(state): State<AppState>) -> Result<Json<Vec<Value>>, AppError> {
    let rows = import_jobs::Entity::find()
        .filter(import_jobs::Column::WorkspaceId.eq(&ctx.workspace.id))
        .order_by_desc(import_jobs::Column::CreatedAt)
        .all(&state.db)
        .await?;
    Ok(Json(rows.iter().take(50).map(present).collect()))
}

async fn get_job(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let row = import_jobs::Entity::find_by_id(&id)
        .filter(import_jobs::Column::WorkspaceId.eq(&ctx.workspace.id))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Import", &id))?;
    Ok(Json(present(&row)))
}

async fn cancel_job(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let row = get_row(&state, &ctx.workspace.id, &id).await?;
    if !["queued", "running"].contains(&row.status.as_str()) {
        return Err(AppError::conflict(format!("The import already {}", row.status)));
    }
    let parked = row.status == "queued" && row.heartbeat_at.is_none();
    let mut model = row.into_active_model();
    model.cancel_requested = Set(true);
    if parked {
        model.status = Set("canceled".into());
        model.finished_at = Set(Some(Utc::now().into()));
        model.waiting_until = Set(None);
    }
    let updated = model.update(&state.db).await?;
    Ok(Json(present(&updated)))
}

async fn retry_job(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let row = get_row(&state, &ctx.workspace.id, &id).await?;
    if row.status != "failed" {
        return Err(AppError::conflict("Only a failed import can be retried"));
    }
    if import_jobs::Entity::find()
        .filter(import_jobs::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(import_jobs::Column::Status.is_in(["queued", "running"]))
        .one(&state.db)
        .await?
        .is_some()
    {
        return Err(AppError::conflict("Another import is still running in this workspace"));
    }
    let mut model = row.into_active_model();
    model.status = Set("queued".into());
    model.last_error = Set(None);
    model.finished_at = Set(None);
    model.cancel_requested = Set(false);
    model.heartbeat_at = Set(None);
    model.waiting_until = Set(None);
    let updated = model.update(&state.db).await?;
    Ok(Json(present(&updated)))
}

async fn get_row(
    state: &AppState,
    workspace: &str,
    id: &str,
) -> Result<import_jobs::Model, AppError> {
    import_jobs::Entity::find_by_id(id)
        .filter(import_jobs::Column::WorkspaceId.eq(workspace))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Import", id))
}

async fn remove_job(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let row = get_row(&state, &ctx.workspace.id, &id).await?;
    if ["queued", "running"].contains(&row.status.as_str()) {
        return Err(AppError::conflict("Cancel the import before deleting it"));
    }
    import_jobs::Entity::delete_by_id(id)
        .filter(import_jobs::Column::WorkspaceId.eq(&ctx.workspace.id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_credentials(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = tracker_credentials::Entity::find()
        .filter(tracker_credentials::Column::WorkspaceId.eq(&ctx.workspace.id))
        .order_by_asc(tracker_credentials::Column::CreatedAt)
        .all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(|r| json!({
        "id": r.id, "workspaceId": r.workspace_id, "provider": r.provider,
        "account": r.account, "baseUrl": r.base_url,
        "createdAt": r.created_at.to_rfc3339(), "lastUsedAt": r.last_used_at.map(|v| v.to_rfc3339())
    })).collect()))
}

async fn remove_credential(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let result = tracker_credentials::Entity::delete_many()
        .filter(tracker_credentials::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(tracker_credentials::Column::Id.eq(&id))
        .exec(&state.db)
        .await?;
    if result.rows_affected == 0 {
        return Err(AppError::entity_not_found("Credential", &id));
    }
    Ok(StatusCode::NO_CONTENT)
}
