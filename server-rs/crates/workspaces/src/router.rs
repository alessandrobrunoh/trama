//! `WorkspacesController` and `WorkspaceController` of
//! `server/src/workspaces/workspaces.controller.ts` (`/api/workspaces`, `/api/w/{slug}`, its
//! settings, roles, ownership transfer and deletion), and the module's router and OpenAPI
//! document.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::{Auth, Ctx, Gate, Routes, WorkspaceWithRole};
use trama_contracts::identity::Workspace;
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{
    CreateRoleBody, CreateWorkspaceBody, DeleteWorkspaceBody, TransferOwnershipBody,
    UpdateRoleBody, UpdateSettingsBody, UpdateWorkspaceBody,
};
use crate::service;

/// `@Roles('admin')`.
pub(crate) const ADMIN: Gate = Gate::authenticated().roles(LegacyRole::Admin);
/// `@Roles('owner')`.
pub(crate) const OWNER: Gate = Gate::authenticated().roles(LegacyRole::Owner);

/// OpenAPI document of this module.
pub struct ApiDoc;

impl OpenApi for ApiDoc {
    fn openapi() -> utoipa::openapi::OpenApi {
        let mut doc = WorkspaceDoc::openapi();
        doc.merge(crate::members::MembersDoc::openapi());
        doc.merge(crate::catalog::CatalogDoc::openapi());
        doc
    }
}

/// Routes of this module, relative to `/api`.
pub fn router() -> Routes {
    routes().merge(crate::members::routes()).merge(crate::catalog::routes())
}

#[derive(OpenApi)]
#[openapi(
    paths(
        list_workspaces,
        create_workspace,
        get_workspace,
        update_workspace,
        update_settings,
        create_role,
        update_role,
        delete_role,
        transfer_ownership,
        delete_workspace
    ),
    components(schemas(
        CreateWorkspaceBody,
        UpdateWorkspaceBody,
        UpdateSettingsBody,
        DeleteWorkspaceBody,
        TransferOwnershipBody,
        CreateRoleBody,
        UpdateRoleBody,
        WorkspaceWithRole,
        Workspace
    ))
)]
struct WorkspaceDoc;

fn routes() -> Routes {
    Routes::new()
        .get("/workspaces", Gate::authenticated().require_user(), list_workspaces)
        .post("/workspaces", Gate::authenticated().require_user().session_only(), create_workspace)
        .get("/w/{slug}", Gate::authenticated(), get_workspace)
        .patch("/w/{slug}", ADMIN, update_workspace)
        .patch("/w/{slug}/settings", ADMIN, update_settings)
        .post("/w/{slug}/roles", OWNER, create_role)
        .patch("/w/{slug}/roles/{roleId}", OWNER, update_role)
        .delete("/w/{slug}/roles/{roleId}", OWNER, delete_role)
        .post("/w/{slug}/transfer-ownership", OWNER.session_only(), transfer_ownership)
        .delete("/w/{slug}", OWNER, delete_workspace)
}

/// Workspaces I belong to, each with my `role`. An API token only sees the workspace it belongs
/// to.
#[utoipa::path(
    get,
    path = "/api/workspaces",
    tag = "workspaces",
    responses(
        (status = 200, description = "The caller's workspaces", body = [WorkspaceWithRole]),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent token"),
    )
)]
async fn list_workspaces(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<Vec<WorkspaceWithRole>>, AppError> {
    let user = auth.require_user()?;
    let mut mine = service::list_mine(&state.db, &user.id).await?;
    if let Some(token) = &auth.token {
        mine.retain(|w| w.workspace.id == token.workspace_id());
    }
    Ok(Json(mine))
}

/// Creates a workspace owned by the caller. Account-level: a token is bound to one workspace and
/// cannot mint new ones.
#[utoipa::path(
    post,
    path = "/api/workspaces",
    tag = "workspaces",
    request_body = CreateWorkspaceBody,
    responses(
        (status = 201, description = "The new workspace", body = WorkspaceWithRole),
        (status = 400, description = "Invalid body or slug"),
        (status = 403, description = "Not a browser session"),
        (status = 409, description = "Slug reserved or taken"),
    )
)]
async fn create_workspace(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(body): ApiJson<CreateWorkspaceBody>,
) -> Result<(StatusCode, Json<WorkspaceWithRole>), AppError> {
    let input = body.validate()?;
    let created = service::create_workspace(&state.db, auth.require_user()?, &input).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// The workspace with the caller's role.
#[utoipa::path(
    get,
    path = "/api/w/{slug}",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "The workspace", body = WorkspaceWithRole),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn get_workspace(ctx: Ctx) -> Json<WorkspaceWithRole> {
    Json(WorkspaceWithRole::new(&ctx.workspace, ctx.role.clone()))
}

/// Renames the workspace or changes its slug. Admin.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = UpdateWorkspaceBody,
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Invalid body or slug"),
        (status = 403, description = "Not an admin"),
        (status = 409, description = "Slug taken"),
    )
)]
async fn update_workspace(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<UpdateWorkspaceBody>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let patch = body.validate()?;
    let saved = service::update_workspace(&state.db, &ctx.workspace, &patch).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}

/// Workspace customization (estimate scale, icon, week start, time zone). Admin.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/settings",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = UpdateSettingsBody,
    responses(
        (status = 200, description = "The updated workspace", body = WorkspaceWithRole),
        (status = 400, description = "Invalid body or time zone"),
        (status = 403, description = "Not an admin"),
    )
)]
async fn update_settings(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<UpdateSettingsBody>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let patch = body.validate()?;
    let saved = service::update_settings(&state, &ctx.workspace, &patch).await?;
    Ok(Json(WorkspaceWithRole::new(&saved, ctx.role.clone())))
}

/// Adds a role. Owner.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/roles",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateRoleBody,
    responses(
        (status = 201, description = "The updated workspace", body = Workspace),
        (status = 400, description = "Invalid name or capability"),
        (status = 403, description = "Not an owner"),
        (status = 409, description = "A role with that name exists"),
    )
)]
async fn create_role(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateRoleBody>,
) -> Result<(StatusCode, Json<Workspace>), AppError> {
    let input = body.validate()?;
    let saved = service::create_role(&state, &ctx, &input).await?;
    Ok((StatusCode::CREATED, Json(Workspace::from(&saved))))
}

/// Renames a role or changes its capabilities and grants. Owner.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/roles/{roleId}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("roleId" = String, Path, description = "Role id"),
    ),
    request_body = UpdateRoleBody,
    responses(
        (status = 200, description = "The updated workspace", body = Workspace),
        (status = 400, description = "Nothing to change, or an invalid value"),
        (status = 403, description = "Not an owner"),
        (status = 404, description = "Unknown role"),
        (status = 409, description = "A role with that name exists"),
    )
)]
async fn update_role(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, role_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateRoleBody>,
) -> Result<Json<Workspace>, AppError> {
    let patch = body.validate()?;
    let saved = service::update_role(&state, &ctx, &role_id, &patch).await?;
    Ok(Json(Workspace::from(&saved)))
}

/// Deletes a role nobody holds. Owner.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/roles/{roleId}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("roleId" = String, Path, description = "Role id"),
    ),
    responses(
        (status = 200, description = "The updated workspace", body = Workspace),
        (status = 403, description = "Not an owner, or the owner role"),
        (status = 404, description = "Unknown role"),
        (status = 409, description = "Members or invitations still use the role"),
    )
)]
async fn delete_role(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, role_id)): Path<(String, String)>,
) -> Result<Json<Workspace>, AppError> {
    let saved = service::delete_role(&state, &ctx, &role_id).await?;
    Ok(Json(Workspace::from(&saved)))
}

/// Hands the workspace to another member (they become owner and primary owner). Browser
/// session, primary owner only.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/transfer-ownership",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = TransferOwnershipBody,
    responses(
        (status = 200, description = "The workspace", body = WorkspaceWithRole),
        (status = 403, description = "Not the primary owner, or an API token"),
        (status = 404, description = "Unknown membership"),
        (status = 409, description = "Personal workspace, or the target already owns it"),
    )
)]
async fn transfer_ownership(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<TransferOwnershipBody>,
) -> Result<Json<WorkspaceWithRole>, AppError> {
    let membership_id = body.validate()?;
    let transferred = service::transfer_ownership(
        &state,
        &ctx.workspace,
        &ctx.role,
        ctx.user_id.as_deref(),
        &membership_id,
    )
    .await?;
    Ok(Json(transferred))
}

/// Deletes the workspace; irreversible, so the body repeats its slug or name. Owner.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = DeleteWorkspaceBody,
    responses(
        (status = 204, description = "Deleted"),
        (status = 400, description = "`confirm` is not the slug or the name"),
        (status = 403, description = "Not an owner"),
        (status = 409, description = "Personal workspace"),
    )
)]
async fn delete_workspace(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<DeleteWorkspaceBody>,
) -> Result<StatusCode, AppError> {
    let confirm = body.validate()?;
    service::delete_workspace(&state.db, &ctx.workspace, &confirm).await?;
    Ok(StatusCode::NO_CONTENT)
}
