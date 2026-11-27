//! `LabelsController` and `StatusesController`: the workspace's label and status catalogs under
//! `/api/w/{slug}/labels` and `/api/w/{slug}/statuses`. Every call answers with the updated
//! workspace and the caller's role.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Ctx, Gate, Routes, WorkspaceWithRole};
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::router::ADMIN;
use crate::schemas::{
    CreateLabelBody, CreateStatusBody, MergeLabelBody, UpdateLabelBody, UpdateStatusBody,
};
use crate::{labels, statuses};

#[derive(OpenApi)]
#[openapi(
    paths(
        create_label,
        update_label,
        merge_label,
        remove_label,
        create_status,
        update_status,
        remove_status
    ),
    components(schemas(
        CreateLabelBody,
        UpdateLabelBody,
        MergeLabelBody,
        CreateStatusBody,
        UpdateStatusBody
    ))
)]
pub(crate) struct CatalogDoc;

pub(crate) fn routes() -> Routes {
    Routes::new()
        .post(
            "/w/{slug}/labels",
            Gate::authenticated().roles(LegacyRole::Member).no_guests(),
            create_label,
        )
        .patch("/w/{slug}/labels/{id}", ADMIN, update_label)
        .post("/w/{slug}/labels/{id}/merge", ADMIN, merge_label)
        .delete("/w/{slug}/labels/{id}", ADMIN, remove_label)
        .post("/w/{slug}/statuses/{subject}", ADMIN, create_status)
        .patch("/w/{slug}/statuses/{subject}/{id}", ADMIN, update_status)
        .delete("/w/{slug}/statuses/{subject}/{id}", ADMIN, remove_status)
}

/// Members can create a label while tagging (the picker offers it inline); everything else about
/// the catalog is admin-only.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/labels",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateLabelBody,
    responses(
        (status = 201, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Invalid label"),
        (status = 403, description = "Guests and viewers cannot"),
        (status = 409, description = "A label with that name exists"),
    )
)]
async fn create_label(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateLabelBody>,
) -> Result<(StatusCode, Json<WorkspaceWithRole>), AppError> {
    let input = body.validate()?;
    let saved = labels::create(&state, &ctx, &input).await?;
    Ok((StatusCode::CREATED, Json(WorkspaceWithRole::new(&saved, ctx.role.clone()))))
}

/// Renames, recolors, archives or re-scopes a label. Admin.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/labels/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Label id"),
    ),
    request_body = UpdateLabelBody,
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown label or invalid value"),
        (status = 403, description = "Not an admin"),
        (status = 409, description = "A label with that name exists"),
    )
)]
async fn update_label(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateLabelBody>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let patch = body.validate()?;
    let saved = labels::update(&state, &ctx, &id, &patch).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}

/// Moves everything labelled `{id}` onto `into` and removes `{id}`. Admin.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/labels/{id}/merge",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Label id"),
    ),
    request_body = MergeLabelBody,
    responses(
        (status = 201, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown label, or a merge that is not allowed"),
        (status = 403, description = "Not an admin"),
    )
)]
async fn merge_label(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<MergeLabelBody>,
) -> Result<(StatusCode, Json<WorkspaceWithRole>), AppError> {
    let into = body.validate()?;
    let saved = labels::merge(&state, &ctx, &id, &into).await?;
    Ok((StatusCode::CREATED, Json(WorkspaceWithRole::new(&saved, ctx.role.clone()))))
}

/// Deletes a label and strips it from every record and saved view. Admin.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/labels/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Label id"),
    ),
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown label, or a template"),
        (status = 403, description = "Not an admin"),
    )
)]
async fn remove_label(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let saved = labels::remove(&state, &ctx, &id).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}

/// Adds a status to a catalog (`issue`, `project` or `project_health`). Admin.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/statuses/{subject}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("subject" = String, Path, description = "issue, project or project_health"),
    ),
    request_body = CreateStatusBody,
    responses(
        (status = 201, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown subject or type, or an invalid value"),
        (status = 403, description = "Not an admin"),
        (status = 409, description = "A status with that name exists"),
    )
)]
async fn create_status(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, subject)): Path<(String, String)>,
    ApiJson(body): ApiJson<CreateStatusBody>,
) -> Result<(StatusCode, Json<WorkspaceWithRole>), AppError> {
    let input = body.validate()?;
    let saved = statuses::create(&state, &ctx, &subject, &input).await?;
    Ok((StatusCode::CREATED, Json(WorkspaceWithRole::new(&saved, ctx.role.clone()))))
}

/// Renames or restyles a status. Admin.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/statuses/{subject}/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("subject" = String, Path, description = "issue, project or project_health"),
        ("id" = String, Path, description = "Status id"),
    ),
    request_body = UpdateStatusBody,
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown subject or status, or an invalid value"),
        (status = 403, description = "Not an admin"),
        (status = 409, description = "A status with that name exists"),
    )
)]
async fn update_status(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, subject, id)): Path<(String, String, String)>,
    ApiJson(body): ApiJson<UpdateStatusBody>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let patch = body.validate()?;
    let saved = statuses::update(&state, &ctx, &subject, &id, &patch).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}

/// Removes a status nobody uses, keeping one of every type. Admin.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/statuses/{subject}/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("subject" = String, Path, description = "issue, project or project_health"),
        ("id" = String, Path, description = "Status id"),
    ),
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Unknown subject or status, or the last of its type"),
        (status = 403, description = "Not an admin"),
        (status = 409, description = "Records still use it"),
    )
)]
async fn remove_status(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, subject, id)): Path<(String, String, String)>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let saved = statuses::remove(&state, &ctx, &subject, &id).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}
