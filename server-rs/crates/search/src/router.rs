//! `SearchController`, mounted under `/api`.

use axum::Json;
use axum::extract::{RawQuery, State};
use trama_auth::{Ctx, Gate, Routes};
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::{SearchQuery, SearchResponse, SearchResult, SearchType};
use crate::service::{self, SearchOptions};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(paths(search), components(schemas(SearchResponse, SearchResult, SearchType)))]
pub struct ApiDoc;

/// Routes of this module (the controller has no decorators: every member may search).
pub fn router() -> Routes {
    Routes::new().get("/w/{slug}/search", Gate::authenticated(), search)
}

/// Searches projects, issues and artifacts by key, title and body. People limited to some
/// projects only find work in those projects.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/search",
    tag = "search",
    params(("slug" = String, Path, description = "Workspace slug"), SearchQuery),
    responses(
        (status = 200, description = "Matches, best first", body = SearchResponse),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn search(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<SearchResponse>, AppError> {
    let query = SearchQuery::parse(raw.as_deref())?;
    let options = SearchOptions { types: query.types, limit: query.limit };
    service::search(&state.db, &ctx.workspace.id, &query.q, &options).await.map(Json)
}
