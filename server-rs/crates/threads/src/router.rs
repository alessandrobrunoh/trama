//! `ThreadsController` and `DecisionsController` (`server/src/threads/threads.controller.ts`),
//! mounted under `/api`.
//!
//! What the agent working in a task's thread keeps in Trama. Permissions follow the task
//! routes: `thread/sync` edits the task, the rest reads it.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use trama_auth::{Actor, Auth, AuthInfo, Ctx, Gate, Routes};
use trama_contracts::issues::{Artifact, ArtifactKind, ArtifactProvider, ArtifactState};
use trama_contracts::roles::TokenScope;
use trama_contracts::threads::{
    EstimateBasis, EstimateSuggestion, ThreadDecision, ThreadRecord, ThreadSyncDecision,
    ThreadSyncResult, TimeSuggestion,
};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{ListDecisionsQuery, ThreadSyncBody};
use crate::service::{self, DecisionFilter, SyncCaller};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(sync, record, estimate, list_decisions),
    components(schemas(
        Artifact,
        ArtifactKind,
        ArtifactProvider,
        ArtifactState,
        EstimateBasis,
        EstimateSuggestion,
        ThreadDecision,
        ThreadRecord,
        ThreadSyncBody,
        ThreadSyncDecision,
        ThreadSyncResult,
        TimeSuggestion,
    ))
)]
pub struct ApiDoc;

/// Routes of this module. The controllers have no decorators beyond the workspace guard: the
/// member grants on `issues` apply (`trama-auth`'s guard reads them from the path).
pub fn router() -> Routes {
    Routes::new()
        .post("/w/{slug}/tasks/{idOrKey}/thread/sync", Gate::authenticated(), sync)
        .get("/w/{slug}/tasks/{idOrKey}/thread", Gate::authenticated(), record)
        .get("/w/{slug}/tasks/{idOrKey}/estimate-suggestion", Gate::authenticated(), estimate)
        .get("/w/{slug}/decisions", Gate::authenticated(), list_decisions)
}

/// Custom tokens may attach a PR only with the artifacts write permission.
fn can_write_artifacts(auth: &AuthInfo) -> bool {
    match &auth.token {
        Some(token) if token.scope == Some(TokenScope::Custom) => {
            token.permissions.as_ref().is_some_and(|p| p.iter().any(|p| p == "artifacts:write"))
        }
        _ => true,
    }
}

/// `trama sync`: summary, files, decisions, PR and suggested time, in one call.
///
/// Every field is optional; send what changed. A different `threadUrl` while the task links one
/// answers 409 `thread_already_linked`.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks/{idOrKey}/thread/sync",
    tag = "threads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    request_body = ThreadSyncBody,
    responses(
        (status = 200, description = "The record after the sync", body = ThreadSyncResult),
        (status = 400, description = "Invalid body, path or decision"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to edit tasks, or to attach a pull request"),
        (status = 404, description = "Unknown workspace or task, or a task outside the caller's projects"),
        (status = 409, description = "The task already links a different thread (`thread_already_linked`)"),
    )
)]
async fn sync(
    ctx: Ctx,
    Auth(auth): Auth,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    ApiJson(body): ApiJson<ThreadSyncBody>,
) -> Result<Json<ThreadSyncResult>, AppError> {
    let input = body.validate()?;
    let caller = SyncCaller {
        actor,
        user_id: ctx.user_id.clone(),
        can_write_artifacts: can_write_artifacts(&auth),
    };
    service::sync(&state, &ctx.workspace.id, &caller, &id_or_key, &input).await.map(Json)
}

/// The record of a task: summary, files, turns and its decisions, oldest first.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks/{idOrKey}/thread",
    tag = "threads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    responses(
        (status = 200, description = "The thread record", body = ThreadRecord),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or task, or the task was never synced"),
    )
)]
async fn record(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
) -> Result<Json<ThreadRecord>, AppError> {
    service::get_record(&state.db, &ctx.workspace.id, &id_or_key).await.map(Json)
}

/// Points suggested from similar finished tasks of the workspace. People decide.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks/{idOrKey}/estimate-suggestion",
    tag = "threads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    responses(
        (status = 200, description = "The suggestion and what it is based on", body = EstimateSuggestion),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or task"),
    )
)]
async fn estimate(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
) -> Result<Json<EstimateSuggestion>, AppError> {
    service::estimate_suggestion(
        &state.db,
        &ctx.workspace.id,
        ctx.settings.estimate_scale,
        &id_or_key,
    )
    .await
    .map(Json)
}

/// Decisions of the workspace, newest first, read back before an agent touches a file. With
/// `path`, the ones that cover that file.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/decisions",
    tag = "threads",
    params(("slug" = String, Path, description = "Workspace slug"), ListDecisionsQuery),
    responses(
        (status = 200, description = "The decisions", body = [ThreadDecision]),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or an unknown `issue`"),
    )
)]
async fn list_decisions(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<ThreadDecision>>, AppError> {
    let query = ListDecisionsQuery::parse(raw.as_deref())?;
    let filter = DecisionFilter { path: query.path, issue: query.issue, limit: query.limit };
    service::list_decisions(&state.db, &ctx.workspace.id, &filter).await.map(Json)
}
