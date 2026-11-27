//! `CommentsController` (`server/src/comments/comments.controller.ts`), mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::activity::{Comment, CommentPage};
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{CreateCommentBody, ListCommentsQuery, PageCommentsQuery, UpdateCommentBody};
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, page, get, create, update, remove),
    components(schemas(Comment, CommentPage, CreateCommentBody, UpdateCommentBody))
)]
pub struct ApiDoc;

/// Routes of this module. The controller has no class decorators: every member reads, members
/// and up write (the default gate); `DELETE` is `@Roles('member')`.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/comments", Gate::authenticated(), list)
        // before `{id}`, as in the controller (axum prefers the static segment either way)
        .get("/w/{slug}/comments/page", Gate::authenticated(), page)
        .get("/w/{slug}/comments/{id}", Gate::authenticated(), get)
        .post("/w/{slug}/comments", Gate::authenticated(), create)
        .patch("/w/{slug}/comments/{id}", Gate::authenticated(), update)
        .delete("/w/{slug}/comments/{id}", Gate::authenticated().roles(LegacyRole::Member), remove)
}

/// The workspace's comments, oldest first, at most 100; filter by subject. A person limited to
/// some projects must name one subject they can see.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/comments",
    tag = "comments",
    params(("slug" = String, Path, description = "Workspace slug"), ListCommentsQuery),
    responses(
        (status = 200, description = "Comments, oldest first", body = [Comment]),
        (status = 400, description = "Invalid filter"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "A limited person did not name a subject"),
        (status = 404, description = "Unknown workspace, or a subject the caller cannot see"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Comment>>, AppError> {
    let q = ListCommentsQuery::parse(raw.as_deref())?;
    let comments = service::list(
        &state.db,
        &ctx.workspace.id,
        q.subject_type.as_deref(),
        q.subject_id.as_deref(),
    )
    .await?;
    Ok(Json(comments))
}

/// Cursor-paginated comments of one subject, newest first.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/comments/page",
    tag = "comments",
    params(("slug" = String, Path, description = "Workspace slug"), PageCommentsQuery),
    responses(
        (status = 200, description = "One page; `nextCursor` is null on the last", body = CommentPage),
        (status = 400, description = "Invalid query or cursor"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or a subject the caller cannot see"),
    )
)]
async fn page(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<CommentPage>, AppError> {
    let q = PageCommentsQuery::parse(raw.as_deref())?;
    Ok(Json(service::page(&state.db, &ctx.workspace.id, &q).await?))
}

/// One comment.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/comments/{id}",
    tag = "comments",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Comment id"),
    ),
    responses(
        (status = 200, description = "The comment", body = Comment),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown comment, workspace, or one on work the caller cannot see"),
    )
)]
async fn get(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Comment>, AppError> {
    Ok(Json(service::get(&state.db, &ctx.workspace.id, &id).await?))
}

/// Comments on an issue, artifact, project, milestone or import.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/comments",
    tag = "comments",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateCommentBody,
    responses(
        (status = 201, description = "The new comment", body = Comment),
        (status = 400, description = "Invalid body, unknown subject, or a file the caller cannot attach"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot write comments"),
        (status = 404, description = "Unknown workspace, or a subject the caller cannot see"),
    )
)]
async fn create(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateCommentBody>,
) -> Result<(StatusCode, Json<Comment>), AppError> {
    let (subject, body) = body.validate()?;
    let comment = service::create(&state, &ctx, subject, &body).await?;
    Ok((StatusCode::CREATED, Json(comment)))
}

/// Edits a comment. Only its author may.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/comments/{id}",
    tag = "comments",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Comment id"),
    ),
    request_body = UpdateCommentBody,
    responses(
        (status = 200, description = "The updated comment", body = Comment),
        (status = 400, description = "Invalid body, or a file the caller cannot attach"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not the author"),
        (status = 404, description = "Unknown comment or workspace"),
    )
)]
async fn update(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateCommentBody>,
) -> Result<Json<Comment>, AppError> {
    let body = body.validate()?;
    Ok(Json(service::update(&state, &ctx, &id, &body).await?))
}

/// Deletes a comment. Its author or an admin may.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/comments/{id}",
    tag = "comments",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Comment id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Neither the author nor an admin"),
        (status = 404, description = "Unknown comment or workspace"),
    )
)]
async fn remove(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
