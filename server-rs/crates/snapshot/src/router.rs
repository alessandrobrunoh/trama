//! `SnapshotController` (`server/src/snapshot/snapshot.controller.ts`), mounted under `/api`.

use axum::Json;
use axum::extract::{RawQuery, State};
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::activity::{SnapshotCommentsMode, WorkspaceSnapshot};
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::SnapshotQuery;
use crate::service;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(get),
    components(schemas(
        SnapshotCommentsMode,
        WorkspaceSnapshot,
        trama_contracts::activity::Comment,
        trama_contracts::activity::CommentIndexEntry,
        trama_contracts::activity::DomainEvent,
        trama_contracts::activity::AttentionItem,
        trama_contracts::identity::Workspace,
        trama_contracts::identity::User,
        trama_contracts::identity::Membership,
        trama_contracts::identity::Agent,
        trama_contracts::projects::Project,
        trama_contracts::projects::Milestone,
        trama_contracts::issues::Issue,
        trama_contracts::issues::Artifact,
        trama_contracts::views::SavedView,
        trama_contracts::integrations::IntegrationConnection,
    ))
)]
pub struct ApiDoc;

/// `@RequireUser()`: the snapshot boots a person's workspace; an agent token has no user.
const USER: Gate = Gate::authenticated().require_user();

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new().get("/w/{slug}/snapshot", USER, get)
}

/// The workspace snapshot (`WorkspaceSnapshot`): everything the client needs to boot a workspace
/// in one call.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/snapshot",
    tag = "snapshot",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("comments" = Option<SnapshotCommentsMode>, Query, description = "`full` inlines every comment; `index` (the default) is the bounded mode"),
    ),
    responses(
        (status = 200, description = "The workspace snapshot", body = WorkspaceSnapshot),
        (status = 400, description = "`comments` is not `full` or `index`"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "An agent token"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn get(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<WorkspaceSnapshot>, AppError> {
    let q = SnapshotQuery::parse(raw.as_deref())?;
    let me = auth.require_user()?;
    let mode = q.comments.unwrap_or(SnapshotCommentsMode::Index);
    Ok(Json(service::build(&state, &ctx, me, mode).await?))
}
