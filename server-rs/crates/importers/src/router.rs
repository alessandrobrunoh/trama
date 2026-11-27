//! Import credential and job routes.
use crate::jobs;
use crate::schemas::ImportRequestDto;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Deserialize;
use serde_json::{Value, json};
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::roles::Capability;
use trama_contracts::{
    common::ActorRef,
    imports::{ExternalProvider, ImportJob, ImportPreview},
};
use trama_core::ApiJson;
use trama_core::{AppError, AppState};
use trama_entities::tracker_credentials;
use utoipa::OpenApi;

const MANAGE: Gate = Gate::authenticated().can(Capability::ManageIntegrations);

#[derive(OpenApi)]
#[openapi(
    paths(
        jobs::preview,
        jobs::start,
        jobs::list,
        jobs::get_one,
        jobs::cancel,
        jobs::retry,
        jobs::remove
    ),
    components(schemas(ImportJob, ImportPreview, ImportRequestDto))
)]
/// OpenAPI document for importer routes.
pub struct ApiDoc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCredentialBody {
    provider: ExternalProvider,
    token: String,
    base_url: Option<String>,
}

/// Workspace-scoped importer routes.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/imports", MANAGE, jobs::list)
        .post("/w/{slug}/imports", MANAGE, jobs::start)
        .get("/w/{slug}/imports/{id}", MANAGE, jobs::get_one)
        .post("/w/{slug}/imports/{id}/cancel", MANAGE, jobs::cancel)
        .post("/w/{slug}/imports/{id}/retry", MANAGE, jobs::retry)
        .delete("/w/{slug}/imports/{id}", MANAGE, jobs::remove)
        .get("/w/{slug}/imports/credentials", MANAGE, list_credentials)
        .post("/w/{slug}/imports/credentials", MANAGE, create_credential)
        .delete("/w/{slug}/imports/credentials/{id}", MANAGE, remove_credential)
        .post("/w/{slug}/imports/preview", MANAGE, jobs::preview)
        .merge(crate::external_links::routes())
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
