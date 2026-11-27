//! `MilestonesController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::projects::Milestone;
use trama_contracts::roles::Capability;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{
    CreateMilestoneDto, ListMilestonesQuery, ReorderMilestonesDto, UpdateMilestoneDto,
};
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, get_one, create, reorder, update, remove),
    components(schemas(CreateMilestoneDto, Milestone, ReorderMilestonesDto, UpdateMilestoneDto))
)]
pub struct ApiDoc;

/// Writes need `manageProjects` (`@Can('manageProjects')`); reads are open to every member.
const MANAGE: Gate = Gate::authenticated().can(Capability::ManageProjects);

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/milestones", Gate::authenticated(), list)
        .get("/w/{slug}/milestones/{id}", Gate::authenticated(), get_one)
        .post("/w/{slug}/milestones", MANAGE, create)
        .post("/w/{slug}/milestones/reorder", MANAGE, reorder)
        .patch("/w/{slug}/milestones/{id}", MANAGE, update)
        .delete("/w/{slug}/milestones/{id}", MANAGE, remove)
}

/// The workspace's milestones, ordered by project then position; narrowed members only see the
/// milestones of their projects.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/milestones",
    tag = "milestones",
    params(("slug" = String, Path, description = "Workspace slug"), ListMilestonesQuery),
    responses(
        (status = 200, description = "Milestones", body = [Milestone]),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Milestone>>, AppError> {
    let query = ListMilestonesQuery::parse(raw.as_deref())?;
    service::list(&state.db, &ctx.workspace.id, query.project_id.as_deref()).await.map(Json)
}

/// One milestone.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/milestones/{id}",
    tag = "milestones",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Milestone id"),
    ),
    responses(
        (status = 200, description = "The milestone", body = Milestone),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or milestone, or outside the caller's projects"),
    )
)]
async fn get_one(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Milestone>, AppError> {
    service::get(&state.db, &ctx.workspace.id, &id).await.map(Json)
}

/// Creates a milestone at the end of its project's list unless `sortOrder` says otherwise.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/milestones",
    tag = "milestones",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateMilestoneDto,
    responses(
        (status = 201, description = "The new milestone", body = Milestone),
        (status = 400, description = "Invalid body, or an unknown project"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects, or the project is outside the caller's projects"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn create(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<CreateMilestoneDto>,
) -> Result<(StatusCode, Json<Milestone>), AppError> {
    let milestone = service::create(&state, &ctx.workspace.id, &actor, dto.validate()?).await?;
    Ok((StatusCode::CREATED, Json(milestone)))
}

/// Numbers the `sortOrder` of a project's milestones 0..n-1 following `ids`; the milestones not
/// listed keep their relative order after the listed ones. Returns the project's milestones in
/// the new order.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/milestones/reorder",
    tag = "milestones",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = ReorderMilestonesDto,
    responses(
        (status = 200, description = "The project's milestones in the new order", body = [Milestone]),
        (status = 400, description = "Invalid body, or ids that are not distinct milestones of the project"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn reorder(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<ReorderMilestonesDto>,
) -> Result<Json<Vec<Milestone>>, AppError> {
    let (project_id, ids) = dto.validate()?;
    service::reorder(&state, &ctx.workspace.id, &actor, &project_id, &ids).await.map(Json)
}

/// Edits a milestone; `description` and `targetDate` accept `null` to clear them.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/milestones/{id}",
    tag = "milestones",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Milestone id"),
    ),
    request_body = UpdateMilestoneDto,
    responses(
        (status = 200, description = "The updated milestone", body = Milestone),
        (status = 400, description = "Invalid body"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace or milestone, or outside the caller's projects"),
    )
)]
async fn update(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(dto): ApiJson<UpdateMilestoneDto>,
) -> Result<Json<Milestone>, AppError> {
    service::update(&state, &ctx.workspace.id, &actor, &id, dto.validate()?).await.map(Json)
}

/// Deletes a milestone, taking it out of the issues that were in it and deleting its comments.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/milestones/{id}",
    tag = "milestones",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Milestone id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace or milestone, or outside the caller's projects"),
    )
)]
async fn remove(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove(&state, &ctx.workspace.id, &actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
