//! `ProjectsController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::projects::Project;
use trama_contracts::roles::Capability;
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{CreateProjectDto, ListProjectsQuery, UpdateProjectDto};
use crate::service::{self, present};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, get_one, create, update, remove),
    components(schemas(CreateProjectDto, Project, UpdateProjectDto))
)]
pub struct ApiDoc;

/// Writes need `manageProjects` (`@Can('manageProjects')`); reads are open to every member.
const MANAGE: Gate = Gate::authenticated().can(Capability::ManageProjects);

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/projects", Gate::authenticated(), list)
        .get("/w/{slug}/projects/{id}", Gate::authenticated(), get_one)
        .post("/w/{slug}/projects", MANAGE, create)
        .patch("/w/{slug}/projects/{id}", MANAGE, update)
        .delete("/w/{slug}/projects/{id}", MANAGE, remove)
}

/// The workspace's projects, newest update first; narrowed members only see the projects of
/// their access.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects",
    tag = "projects",
    params(("slug" = String, Path, description = "Workspace slug"), ListProjectsQuery),
    responses(
        (status = 200, description = "Projects", body = [Project]),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Project>>, AppError> {
    let filter = ListProjectsQuery::parse(raw.as_deref())?;
    service::list(&state.db, &ctx.workspace.id, filter).await.map(Json)
}

/// One project.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/projects/{id}",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    responses(
        (status = 200, description = "The project", body = Project),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or project, or outside the caller's access"),
    )
)]
async fn get_one(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Project>, AppError> {
    service::get(&state.db, &ctx.workspace.id, &id).await.map(|row| Json(present(&row)))
}

/// Creates a project; the tag comes from the request or is suggested from the name.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/projects",
    tag = "projects",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateProjectDto,
    responses(
        (status = 201, description = "The new project", body = Project),
        (status = 400, description = "Invalid body, icon, lead, tag, status or health"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects, or the caller's access is narrowed"),
        (status = 404, description = "Unknown workspace, or not a member"),
        (status = 409, description = "The tag is already used"),
    )
)]
async fn create(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<CreateProjectDto>,
) -> Result<(StatusCode, Json<Project>), AppError> {
    let project = service::create(&state, &ctx.workspace.id, &actor, dto.validate()?).await?;
    Ok((StatusCode::CREATED, Json(project)))
}

/// Edits a project; clearable fields accept `null`. Changing the tag re-keys the issues and
/// keeps their old keys as aliases.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/projects/{id}",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    request_body = UpdateProjectDto,
    responses(
        (status = 200, description = "The updated project", body = Project),
        (status = 400, description = "Invalid body, icon, lead, tag, status or health"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace or project, or outside the caller's access"),
        (status = 409, description = "The tag is already used, or changed under us"),
    )
)]
async fn update(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(dto): ApiJson<UpdateProjectDto>,
) -> Result<Json<Project>, AppError> {
    service::update(&state, &ctx.workspace.id, &actor, &id, dto.validate()?).await.map(Json)
}

/// Deletes a project: its issues move to no project and are re-keyed under `UNPR`.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/projects/{id}",
    tag = "projects",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "No right to manage projects"),
        (status = 404, description = "Unknown workspace or project, or outside the caller's access"),
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
