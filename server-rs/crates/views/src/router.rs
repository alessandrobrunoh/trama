//! `ViewsController` and `PublicViewsController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::map_response;
use axum::response::Response;
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::views::{
    FilterValue, PublicView, PublicViewGroup, PublicViewItem, SavedView, ShareGrant, ShareLevel,
    ShareVisibility, SharingSettings, ViewEntity, ViewFilter, ViewFilterOp, ViewLayout, ViewSort,
};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{
    CreateViewDto, FilterDto, GrantDto, InviteViewDto, SharingDto, SortDto, UpdateViewDto,
};
use crate::{public, service};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, get_one, create, update, invite, rotate_link, remove, public_view),
    components(schemas(
        CreateViewDto,
        FilterDto,
        FilterValue,
        GrantDto,
        InviteViewDto,
        PublicView,
        PublicViewGroup,
        PublicViewItem,
        SavedView,
        ShareGrant,
        ShareLevel,
        ShareVisibility,
        SharingDto,
        SharingSettings,
        SortDto,
        UpdateViewDto,
        ViewEntity,
        ViewFilter,
        ViewFilterOp,
        ViewLayout,
        ViewSort,
    ))
)]
pub struct ApiDoc;

/// Routes of this module (the controllers have no decorators except `@Public()` on the public
/// link: members, `viewer` and up for reads, `member` and up for writes).
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/views", Gate::authenticated(), list)
        .get("/w/{slug}/views/{id}", Gate::authenticated(), get_one)
        .post("/w/{slug}/views", Gate::authenticated(), create)
        .patch("/w/{slug}/views/{id}", Gate::authenticated(), update)
        .post("/w/{slug}/views/{id}/invite", Gate::authenticated(), invite)
        .post("/w/{slug}/views/{id}/rotate-link", Gate::authenticated(), rotate_link)
        .delete("/w/{slug}/views/{id}", Gate::authenticated(), remove)
        .route_with(
            axum::http::Method::GET,
            "/public/views/{token}",
            Gate::public(),
            public_view,
            |route| route.layer(map_response(no_indexing_headers)),
        )
}

/// `@Header(...)` of the public link: set before the handler runs, so errors carry them too.
async fn no_indexing_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

/// The views the caller may see: their own, those shared with the workspace or by link, and
/// those they were invited to.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/views",
    tag = "views",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Visible views, oldest first", body = [SavedView]),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(ctx: Ctx, State(state): State<AppState>) -> Result<Json<Vec<SavedView>>, AppError> {
    service::list(&state, &ctx).await.map(Json)
}

/// One view.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/views/{id}",
    tag = "views",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "View id"),
    ),
    responses(
        (status = 200, description = "The view", body = SavedView),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or view, or not visible to the caller"),
    )
)]
async fn get_one(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<SavedView>, AppError> {
    service::get(&state, &ctx, &id).await.map(Json)
}

/// Creates a view owned by the caller.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/views",
    tag = "views",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateViewDto,
    responses(
        (status = 201, description = "The new view", body = SavedView),
        (status = 400, description = "Invalid body, a layout the entity cannot have, or grants that are not members"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token, or no right to share views"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn create(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(dto): ApiJson<CreateViewDto>,
) -> Result<(StatusCode, Json<SavedView>), AppError> {
    let view = service::create(&state, &ctx, dto.validate()?).await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// Edits a view's definition and, for people who manage it, its sharing.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/views/{id}",
    tag = "views",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "View id"),
    ),
    request_body = UpdateViewDto,
    responses(
        (status = 200, description = "The updated view", body = SavedView),
        (status = 400, description = "Invalid body, a layout the entity cannot have, or grants that are not members"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "View-only access, or not allowed to change sharing"),
        (status = 404, description = "Unknown workspace or view, or not visible to the caller"),
    )
)]
async fn update(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(dto): ApiJson<UpdateViewDto>,
) -> Result<Json<SavedView>, AppError> {
    service::update(&state, &ctx, &id, dto.validate()?).await.map(Json)
}

/// Invites existing workspace members by email.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/views/{id}/invite",
    tag = "views",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "View id"),
    ),
    request_body = InviteViewDto,
    responses(
        (status = 200, description = "The updated view", body = SavedView),
        (status = 400, description = "Invalid body, or people who are not workspace members"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not allowed to change sharing"),
        (status = 404, description = "Unknown workspace or view, or not visible to the caller"),
    )
)]
async fn invite(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(dto): ApiJson<InviteViewDto>,
) -> Result<Json<SavedView>, AppError> {
    let (emails, level) = dto.validate()?;
    service::invite(&state, &ctx, &id, &emails, level).await.map(Json)
}

/// Issues a new public link; the previous one stops working.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/views/{id}/rotate-link",
    tag = "views",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "View id"),
    ),
    responses(
        (status = 200, description = "The view with its new link", body = SavedView),
        (status = 400, description = "The view is not shared by link"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not allowed to change sharing"),
        (status = 404, description = "Unknown workspace or view, or not visible to the caller"),
    )
)]
async fn rotate_link(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<SavedView>, AppError> {
    service::rotate_link(&state, &ctx, &id).await.map(Json)
}

/// Deletes a view.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/views/{id}",
    tag = "views",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "View id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Not allowed to delete this view"),
        (status = 404, description = "Unknown workspace or view, or not visible to the caller"),
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

/// The one unauthenticated door into a saved view. Read-only by construction: the only input is
/// the secret token, and it takes no query string or body, so a visitor cannot influence which
/// rows, fields or workspace are returned.
#[utoipa::path(
    get,
    path = "/api/public/views/{token}",
    tag = "views",
    params(("token" = String, Path, description = "Secret token of the public link")),
    responses(
        (status = 200, description = "The fixed result of the shared view", body = PublicView),
        (status = 404, description = "The token is malformed, unknown, revoked or no longer shared"),
        (status = 422, description = "The view would read more rows than the evaluation limit"),
    )
)]
async fn public_view(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<PublicView>, AppError> {
    public::get(&state, &token).await.map(Json)
}
