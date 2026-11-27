//! Import credential and job routes.
use crate::credentials;
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
use trama_contracts::{
    common::ActorRef,
    imports::{ExternalProvider, ExternalRef, ExternalRefOrigin, ExternalStateType},
};
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
        .post("/w/{slug}/tasks/{idOrKey}/external-ref", Gate::authenticated(), link_external_ref)
        .post(
            "/w/{slug}/tasks/{idOrKey}/external-ref/refresh",
            Gate::authenticated(),
            refresh_external_ref,
        )
        .delete(
            "/w/{slug}/tasks/{idOrKey}/external-ref",
            Gate::authenticated(),
            unlink_external_ref,
        )
}

#[derive(Deserialize)]
struct LinkExternalBody {
    url: String,
}

/// Provider reads run only through the shared SSRF-guarded HTTP transport.
async fn provider_issue(
    state: &AppState,
    workspace_id: &str,
    url: &str,
) -> Result<ExternalRef, AppError> {
    let parsed = url::Url::parse(url.trim())
        .map_err(|_| AppError::bad_request("Paste a GitHub or Linear issue URL"))?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(AppError::bad_request("Paste a GitHub or Linear issue URL"));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let http = trama_integrations::Http::of(state);
    if host == "linear.app" {
        let path: Vec<_> = parsed.path().split('/').filter(|s| !s.is_empty()).collect();
        if path.len() < 3 || path[1] != "issue" {
            return Err(AppError::bad_request("Paste a Linear issue URL"));
        }
        let identifier = path[2].split('/').next().unwrap_or_default().to_ascii_uppercase();
        let creds =
            credentials::resolve(state, workspace_id, ExternalProvider::Linear, None, None).await?;
        let token =
            creds.token.ok_or_else(|| AppError::bad_request("A Linear API key is required"))?;
        let response = http.request(trama_integrations::HttpRequest::new(
            axum::http::Method::POST, "https://api.linear.app/graphql",
        ).header("Authorization", &token).json(json!({"query":"query($id:String!){ issue(id:$id){ id identifier url title state { name type } } }","variables":{"id":identifier}})))
            .await.map_err(|e| AppError::new(StatusCode::BAD_GATEWAY, format!("Linear is unreachable: {}", e.to_string().replace(&token, "[redacted]"))))?;
        if !(200..300).contains(&response.status) {
            return Err(AppError::bad_request("Linear rejected the request"));
        }
        let issue = &response.json["data"]["issue"];
        let id = issue["id"]
            .as_str()
            .ok_or_else(|| AppError::bad_request("Linear issue was not found"))?
            .to_owned();
        let state_name = issue["state"]["name"].as_str().unwrap_or_default().to_owned();
        let kind = match issue["state"]["type"].as_str().unwrap_or_default() {
            "completed" => ExternalStateType::Done,
            "canceled" => ExternalStateType::Canceled,
            "started" => ExternalStateType::InProgress,
            _ => ExternalStateType::Open,
        };
        return Ok(ExternalRef {
            provider: ExternalProvider::Linear,
            id,
            url: issue["url"].as_str().unwrap_or(url).to_owned(),
            key: issue["identifier"].as_str().map(str::to_owned),
            state: Some(state_name),
            state_type: Some(kind),
            synced_at: Some(chrono::Utc::now().to_rfc3339()),
            origin: ExternalRefOrigin::Link,
        });
    }
    let segments: Vec<_> = parsed.path_segments().into_iter().flatten().collect();
    if host != "github.com" || segments.len() != 4 || !matches!(segments[2], "issues" | "pull") {
        return Err(AppError::bad_request("Paste a GitHub issue URL"));
    }
    let repository = format!("{}/{}", segments[0], segments[1]);
    let number = segments[3].trim_end_matches('/');
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::bad_request("Paste a GitHub issue URL"));
    }
    let provider = ExternalProvider::Github;
    let credential = credentials::resolve(state, workspace_id, provider, None, None).await?;
    let api = credential.base_url.as_deref().unwrap_or("https://api.github.com");
    let mut req =
        trama_integrations::HttpRequest::get(format!("{api}/repos/{repository}/issues/{number}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "trama");
    if let Some(token) = credential.token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let response = http.request(req).await.map_err(|e| {
        AppError::new(StatusCode::BAD_GATEWAY, format!("GitHub is unreachable: {e}"))
    })?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::bad_request("GitHub rejected the request"));
    }
    let issue = &response.json;
    let id = format!("{}#{}", repository.to_ascii_lowercase(), number);
    let state_name = issue["state"].as_str().unwrap_or("open").to_owned();
    let state_type = if state_name == "open" {
        ExternalStateType::Open
    } else if issue["state_reason"] == "not_planned" {
        ExternalStateType::Canceled
    } else {
        ExternalStateType::Done
    };
    Ok(ExternalRef {
        provider,
        id,
        url: issue["html_url"].as_str().unwrap_or(url).to_owned(),
        key: Some(format!("#{number}")),
        state: Some(state_name),
        state_type: Some(state_type),
        synced_at: Some(chrono::Utc::now().to_rfc3339()),
        origin: ExternalRefOrigin::Link,
    })
}

async fn link_external_ref(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<LinkExternalBody>,
) -> Result<Json<trama_contracts::issues::Issue>, AppError> {
    if body.url.len() < 8 || body.url.len() > 500 {
        return Err(AppError::bad_request("url must be between 8 and 500 characters"));
    }
    let reference = provider_issue(&state, &ctx.workspace.id, &body.url).await?;
    Ok(Json(
        trama_issues::service::set_external_ref(
            &state,
            &ctx.workspace.id,
            &actor,
            &id,
            Some(&reference),
        )
        .await?,
    ))
}

async fn refresh_external_ref(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<trama_contracts::issues::Issue>, AppError> {
    let row = trama_issues::service::get(&state.db, &ctx.workspace.id, &id).await?;
    let mut reference: ExternalRef =
        row.external_ref.clone().and_then(|v| serde_json::from_value(v).ok()).ok_or_else(|| {
            AppError::bad_request("This issue is not linked to an external issue")
        })?;
    let fresh = provider_issue(&state, &ctx.workspace.id, &reference.url).await?;
    reference.state = fresh.state;
    reference.state_type = fresh.state_type;
    reference.synced_at = fresh.synced_at;
    reference.key = fresh.key;
    reference.url = fresh.url;
    let update = trama_issues::service::ExternalRefRefresh {
        state: reference.state.clone(),
        state_type: reference.state_type,
        synced_at: reference.synced_at.clone(),
        key: reference.key.clone(),
        url: Some(reference.url.clone()),
    };
    Ok(Json(
        trama_issues::service::refresh_external_ref(&state, &ctx.workspace.id, &id, update).await?,
    ))
}

async fn unlink_external_ref(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<trama_contracts::issues::Issue>, AppError> {
    Ok(Json(
        trama_issues::service::set_external_ref(&state, &ctx.workspace.id, &actor, &id, None)
            .await?,
    ))
}

#[cfg(test)]
mod external_ref_tests {
    use std::collections::BTreeMap;

    use async_trait::async_trait;
    use trama_core::{AppState, Config, testkit::TestDb};
    use trama_integrations::{HttpClient, HttpFailure, HttpRequest, HttpResponse};

    use super::*;

    struct GithubIssueMock;

    #[async_trait]
    impl HttpClient for GithubIssueMock {
        async fn request(&self, request: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            assert_eq!(request.url, "https://api.github.com/repos/octo/repo/issues/12");
            assert!(request.headers.iter().any(|(key, value)| {
                key.eq_ignore_ascii_case("user-agent") && value == "trama"
            }));
            Ok(HttpResponse {
                status: 200,
                headers: BTreeMap::new(),
                json: json!({
                    "number": 12, "state": "closed", "state_reason": "not_planned",
                    "html_url": "https://github.com/octo/repo/issues/12"
                }),
            })
        }
    }

    #[tokio::test]
    async fn github_reference_is_read_from_provider_before_it_is_linked() {
        let Some(test) = TestDb::create().await else {
            return;
        };
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]))
            .with_extension(trama_integrations::Http::new(GithubIssueMock));
        let reference = provider_issue(
            &state,
            "ws_external_ref_test",
            "https://github.com/octo/repo/issues/12",
        )
        .await
        .unwrap();
        assert_eq!(reference.provider, ExternalProvider::Github);
        assert_eq!(reference.id, "octo/repo#12");
        assert_eq!(reference.key.as_deref(), Some("#12"));
        assert_eq!(reference.state_type, Some(ExternalStateType::Canceled));
        assert_eq!(reference.origin, ExternalRefOrigin::Link);
        test.drop().await;
    }

    #[tokio::test]
    async fn external_reference_rejects_non_tracker_hosts_without_fetching_them() {
        let Some(test) = TestDb::create().await else {
            return;
        };
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]))
            .with_extension(trama_integrations::Http::new(GithubIssueMock));
        let error = provider_issue(&state, "ws_external_ref_test", "https://127.0.0.1/private")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Paste a GitHub issue URL"));
        test.drop().await;
    }
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
