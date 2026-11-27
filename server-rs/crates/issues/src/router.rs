//! `IssuesController` (`server/src/issues/issues.controller.ts`), mounted under `/api` as
//! `/w/{slug}/tasks`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::header::{ACCEPT, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use trama_artifacts::service::{ArtifactFilter, count_for_issue, list as list_artifacts};
use trama_auth::{Actor, Auth, AuthInfo, Ctx, Gate, Routes};
use trama_contracts::common::ActorRef;
use trama_contracts::issues::{
    Artifact, ArtifactKind, ArtifactProvider, ArtifactState, Issue, IssueContext, PlanSummary,
    is_plan_artifact,
};
use trama_contracts::roles::{Capability, TokenScope};
use trama_core::{ApiJson, AppError, AppState};
use trama_uploads::schemas::artifact_view;
use utoipa::OpenApi;

use crate::briefing::render_issue_briefing;
use crate::rows::present;
use crate::schemas::{
    BulkDeleteIssuesDto, BulkDeleteResult, BulkIssuePatchDto, BulkUpdateIssuesDto, ContextFormat,
    ContextQuery, CreateIssueDto, ListIssuesQuery, UpdateIssueDto,
};
use crate::service::{self, IssueFilter};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, bulk_update, bulk_delete, get_one, context, create, update, remove),
    components(schemas(
        Artifact,
        ArtifactKind,
        ArtifactProvider,
        ArtifactState,
        BulkDeleteIssuesDto,
        BulkDeleteResult,
        BulkIssuePatchDto,
        BulkUpdateIssuesDto,
        CreateIssueDto,
        Issue,
        IssueContext,
        PlanSummary,
        UpdateIssueDto,
    ))
)]
pub struct ApiDoc;

/// `@Can('createIssues')`.
const CREATE: Gate = Gate::authenticated().can(Capability::CreateIssues);
/// `@Can('deleteIssues')`.
const DELETE: Gate = Gate::authenticated().can(Capability::DeleteIssues);

/// Routes of this module. The controller has no other decorators: members read, `member` and up
/// write, and the member grants on `issues` apply (`trama-auth`'s guard reads them from the
/// path).
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/tasks", Gate::authenticated(), list)
        .post("/w/{slug}/tasks/bulk", Gate::authenticated(), bulk_update)
        .get("/w/{slug}/tasks/bulk", Gate::authenticated(), get_reserved)
        .patch("/w/{slug}/tasks/bulk", Gate::authenticated(), update_reserved)
        .delete("/w/{slug}/tasks/bulk", DELETE, remove_reserved)
        .post("/w/{slug}/tasks/bulk-delete", DELETE, bulk_delete)
        .get("/w/{slug}/tasks/bulk-delete", Gate::authenticated(), get_reserved)
        .patch("/w/{slug}/tasks/bulk-delete", Gate::authenticated(), update_reserved)
        .delete("/w/{slug}/tasks/bulk-delete", DELETE, remove_reserved)
        .get("/w/{slug}/tasks/{idOrKey}", Gate::authenticated(), get_one)
        .get("/w/{slug}/tasks/{idOrKey}/context", Gate::authenticated(), context)
        .post("/w/{slug}/tasks", CREATE, create)
        .patch("/w/{slug}/tasks/{idOrKey}", Gate::authenticated(), update)
        .delete("/w/{slug}/tasks/{idOrKey}", DELETE, remove)
}

/// Custom tokens must not learn artifact metadata without the artifacts resource permission.
fn can_read_artifacts(auth: &AuthInfo) -> bool {
    match &auth.token {
        Some(token) if token.scope == Some(TokenScope::Custom) => {
            token.permissions.as_ref().is_some_and(|p| p.iter().any(|p| p == "artifacts:read"))
        }
        _ => true,
    }
}

/// `req.accepts(['application/json', 'text/markdown']) === 'text/markdown'`: content negotiation
/// as the `accepts` package does it. Without an `Accept` header JSON (the first type) wins.
fn prefers_markdown(headers: &HeaderMap) -> bool {
    struct Spec {
        kind: String,
        sub: String,
        q: f64,
        index: usize,
    }
    let Some(accept) = headers.get(ACCEPT).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let mut specs: Vec<Spec> = Vec::new();
    for (index, part) in accept.split(',').enumerate() {
        let mut pieces = part.split(';').map(str::trim);
        let Some((kind, sub)) = pieces.next().and_then(|m| m.split_once('/')) else { continue };
        let mut q = 1.0;
        for param in pieces {
            if let Some(value) = param.strip_prefix("q=").or_else(|| param.strip_prefix("Q="))
                && let Ok(parsed) = value.trim().parse::<f64>()
            {
                q = parsed;
            }
        }
        specs.push(Spec {
            kind: kind.to_ascii_lowercase(),
            sub: sub.to_ascii_lowercase(),
            q,
            index,
        });
    }
    // (specificity, q, position in the header) of the best entry matching one provided type
    let rank = |kind: &str, sub: &str| -> Option<(u8, f64, usize)> {
        let mut best: Option<(u8, f64, usize)> = None;
        for spec in &specs {
            let mut s = 0;
            if spec.kind == kind {
                s |= 4;
            } else if spec.kind != "*" {
                continue;
            }
            if spec.sub == sub {
                s |= 2;
            } else if spec.sub != "*" {
                continue;
            }
            let candidate = (s, spec.q, spec.index);
            let better = best.is_none_or(|b| {
                candidate
                    .0
                    .cmp(&b.0)
                    .then(candidate.1.total_cmp(&b.1))
                    .then(candidate.2.cmp(&b.2))
                    .is_gt()
            });
            if better {
                best = Some(candidate);
            }
        }
        best.filter(|b| b.1 > 0.0)
    };
    let json = rank("application", "json");
    let markdown = rank("text", "markdown");
    match (json, markdown) {
        (_, None) => false,
        (None, Some(_)) => true,
        // higher q, then higher specificity, then the earlier entry; JSON is listed first
        (Some(j), Some(m)) => {
            if (m.1 - j.1).abs() > f64::EPSILON {
                m.1 > j.1
            } else if m.0 != j.0 {
                m.0 > j.0
            } else {
                m.2 < j.2
            }
        }
    }
}

/// The workspace's tasks, newest first, narrowed to the projects the caller can reach.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks",
    tag = "issues",
    params(("slug" = String, Path, description = "Workspace slug"), ListIssuesQuery),
    responses(
        (status = 200, description = "Tasks, newest first", body = [Issue]),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Issue>>, AppError> {
    let filter = IssueFilter::parse(raw.as_deref())?;
    let rows = service::list(&state.db, &ctx.workspace.id, &filter).await?;
    let mut issues: Vec<Issue> = rows.iter().map(present).collect();
    service::hide_invisible_parents(&state.db, &ctx.workspace.id, &mut issues).await?;
    Ok(Json(issues))
}

/// One patch for up to 100 tasks, all-or-nothing: unknown tasks or references reject the whole
/// request and nothing is written. Responds with the updated tasks.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks/bulk",
    tag = "issues",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = BulkUpdateIssuesDto,
    responses(
        (status = 200, description = "The updated tasks", body = [Issue]),
        (status = 400, description = "Invalid body or reference"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to edit tasks, or a project outside the caller's projects"),
        (status = 404, description = "Unknown workspace, or an unknown task"),
    )
)]
async fn bulk_update(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<BulkUpdateIssuesDto>,
) -> Result<Json<Vec<Issue>>, AppError> {
    let (ids, patch) = dto.validate()?;
    let rows = service::get_many(&state.db, &ctx.workspace.id, &ids).await?;
    let updated = service::update_many(&state, &ctx.workspace.id, &actor, rows, patch).await?;
    let mut issues: Vec<Issue> = updated.iter().map(present).collect();
    service::hide_invisible_parents(&state.db, &ctx.workspace.id, &mut issues).await?;
    Ok(Json(issues))
}

/// Deletes up to 100 tasks in one transaction. Needs the `deleteIssues` capability.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks/bulk-delete",
    tag = "issues",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = BulkDeleteIssuesDto,
    responses(
        (status = 200, description = "The ids of the deleted tasks", body = BulkDeleteResult),
        (status = 400, description = "Invalid body"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to delete tasks"),
        (status = 404, description = "Unknown workspace, or an unknown task"),
    )
)]
async fn bulk_delete(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<BulkDeleteIssuesDto>,
) -> Result<Json<BulkDeleteResult>, AppError> {
    let ids = dto.validate()?;
    let rows = service::get_many(&state.db, &ctx.workspace.id, &ids).await?;
    service::remove_many(&state, &ctx.workspace.id, &actor, &rows).await?;
    Ok(Json(BulkDeleteResult { deleted: rows.into_iter().map(|row| row.id).collect() }))
}

/// One task, by id, key or a previous key. `artifactCount` is present when the caller can read
/// artifacts.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks/{idOrKey}",
    tag = "issues",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    responses(
        (status = 200, description = "The task", body = Issue),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or task, or a task outside the caller's projects"),
    )
)]
async fn get_one(
    ctx: Ctx,
    Auth(auth): Auth,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
) -> Result<Json<Issue>, AppError> {
    get_task(&ctx, &auth, &state, &id_or_key).await
}

async fn get_task(
    ctx: &Ctx,
    auth: &AuthInfo,
    state: &AppState,
    id_or_key: &str,
) -> Result<Json<Issue>, AppError> {
    let ws = &ctx.workspace.id;
    let row = service::get(&state.db, ws, id_or_key).await?;
    let mut issue = service::present_visible(&state.db, ws, &row).await?;
    if can_read_artifacts(auth) {
        let count = count_for_issue(&state.db, ws, &row.id).await?;
        issue.artifact_count = Some(i64::try_from(count).unwrap_or(i64::MAX));
    }
    Ok(Json(issue))
}

/// The last path segment of a request for one of the fixed `bulk` paths.
fn reserved_segment(uri: &Uri) -> String {
    uri.path().rsplit('/').next().unwrap_or_default().to_owned()
}

/// NestJS matches `GET /tasks/bulk` and `/tasks/bulk-delete` (declared for POST only) against
/// `:idOrKey`; the answer is the 404 of an issue with that reference.
async fn get_reserved(
    ctx: Ctx,
    Auth(auth): Auth,
    State(state): State<AppState>,
    uri: Uri,
) -> Result<Json<Issue>, AppError> {
    get_task(&ctx, &auth, &state, &reserved_segment(&uri)).await
}

/// `PATCH /tasks/bulk`, see [`get_reserved`].
async fn update_reserved(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    uri: Uri,
    ApiJson(dto): ApiJson<UpdateIssueDto>,
) -> Result<Json<Issue>, AppError> {
    update_task(&ctx, &actor, &state, &reserved_segment(&uri), dto).await
}

/// `DELETE /tasks/bulk`, see [`get_reserved`].
async fn remove_reserved(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    uri: Uri,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &actor, &reserved_segment(&uri)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// JSON by default (the task, a summary of its plans and its artifacts); a markdown briefing
/// (what to know to pick the work up) with `?format=markdown` or `Accept: text/markdown`.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tasks/{idOrKey}/context",
    tag = "issues",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
        ContextQuery,
    ),
    responses(
        (status = 200, description = "The context", body = IssueContext),
        (status = 400, description = "Invalid format"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or task, or a task outside the caller's projects"),
    )
)]
async fn context(
    ctx: Ctx,
    Auth(auth): Auth,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let format = ContextFormat::parse(raw.as_deref())?;
    let ws = &ctx.workspace.id;
    let row = service::get(&state.db, ws, &id_or_key).await?;
    let issue = service::present_visible(&state.db, ws, &row).await?;
    let artifacts: Vec<Artifact> = if can_read_artifacts(&auth) {
        let filter = ArtifactFilter { issue_id: Some(row.id.clone()), ..ArtifactFilter::default() };
        list_artifacts(&state.db, ws, &filter).await?.iter().map(artifact_view).collect()
    } else {
        Vec::new()
    };
    let wants_markdown = match format {
        Some(format) => format == ContextFormat::Markdown,
        None => prefers_markdown(&headers),
    };
    if wants_markdown {
        let mut response = render_issue_briefing(&issue, &artifacts).into_response();
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("text/markdown; charset=utf-8"));
        return Ok(response);
    }
    let plans: Vec<&Artifact> =
        artifacts.iter().filter(|a| is_plan_artifact(a.kind, &a.title)).collect();
    // the newest plan; a tie keeps the first (the list is newest created first)
    let latest = plans.iter().fold(None::<&Artifact>, |best, plan| match best {
        Some(best) if best.updated_at >= plan.updated_at => Some(best),
        _ => Some(plan),
    });
    let plan_summary = (!plans.is_empty()).then(|| PlanSummary {
        artifact_count: i64::try_from(plans.len()).unwrap_or(i64::MAX),
        latest_artifact: latest.cloned(),
    });
    Ok(Json(IssueContext { issue, plan_summary, artifacts }).into_response())
}

/// Creates a task. Its key follows the project's tag (`UNPR-…` without a project).
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks",
    tag = "issues",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateIssueDto,
    responses(
        (status = 201, description = "The new task", body = Issue),
        (status = 400, description = "Invalid body or reference"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to create tasks, or a project outside the caller's projects"),
        (status = 404, description = "Unknown workspace, or an unknown parent task"),
    )
)]
async fn create(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<CreateIssueDto>,
) -> Result<(StatusCode, Json<Issue>), AppError> {
    let input = dto.validate()?;
    let row = service::create(&state, &ctx.workspace.id, &actor, input).await?;
    let issue = service::present_visible(&state.db, &ctx.workspace.id, &row).await?;
    Ok((StatusCode::CREATED, Json(issue)))
}

/// Edits a task; a field left out stays, `null` clears the fields that can be cleared. Changing
/// the project re-keys the task and keeps the old key as an alias.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/tasks/{idOrKey}",
    tag = "issues",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    request_body = UpdateIssueDto,
    responses(
        (status = 200, description = "The task after the change", body = Issue),
        (status = 400, description = "Invalid body, reference or hierarchy"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "A project outside the caller's projects"),
        (status = 404, description = "Unknown workspace, task or parent task"),
        (status = 409, description = "The hierarchy changed under the update"),
    )
)]
async fn update(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    ApiJson(dto): ApiJson<UpdateIssueDto>,
) -> Result<Json<Issue>, AppError> {
    update_task(&ctx, &actor, &state, &id_or_key, dto).await
}

async fn update_task(
    ctx: &Ctx,
    actor: &ActorRef,
    state: &AppState,
    id_or_key: &str,
    dto: UpdateIssueDto,
) -> Result<Json<Issue>, AppError> {
    let patch = dto.validate()?;
    let row = service::update(state, &ctx.workspace.id, actor, id_or_key, patch).await?;
    Ok(Json(service::present_visible(&state.db, &ctx.workspace.id, &row).await?))
}

/// Deletes a task: its children become root tasks, its comments go with it. Needs the
/// `deleteIssues` capability.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/tasks/{idOrKey}",
    tag = "issues",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id, key (`AUTH-142`) or a previous key"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to delete tasks"),
        (status = 404, description = "Unknown workspace or task"),
        (status = 409, description = "The hierarchy changed under the delete"),
    )
)]
async fn remove(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &actor, &id_or_key).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepting(value: Option<&str>) -> bool {
        let mut headers = HeaderMap::new();
        if let Some(value) = value {
            headers.insert(ACCEPT, HeaderValue::from_str(value).unwrap());
        }
        prefers_markdown(&headers)
    }

    #[test]
    fn negotiates_markdown_like_the_accepts_package() {
        assert!(!accepting(None));
        assert!(accepting(Some("text/markdown")));
        assert!(accepting(Some("text/*")));
        assert!(!accepting(Some("application/json")));
        assert!(!accepting(Some("*/*")));
        assert!(!accepting(Some("text/html,application/xhtml+xml,*/*;q=0.8")));
        assert!(accepting(Some("text/markdown, application/json;q=0.5")));
        assert!(!accepting(Some("text/markdown;q=0.5, application/json")));
        assert!(!accepting(Some("text/markdown;q=0")));
        // equal quality: the more specific entry, then the earlier one
        assert!(accepting(Some("text/markdown, */*")));
        assert!(!accepting(Some("application/json, text/markdown")));
        assert!(accepting(Some("text/markdown, application/json")));
    }
}
