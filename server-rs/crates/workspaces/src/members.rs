//! `MembersController`, `AgentsController` and `TokensController` of
//! `server/src/workspaces/workspaces.controller.ts`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use trama_auth::tokens::ApiTokenView;
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::common::ASSISTANT_TOKEN_NAME;
use trama_contracts::identity::Agent;
use trama_contracts::roles::{Capability, LegacyRole};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::router::ADMIN;
use crate::schemas::{
    AddMemberBody, ChangeMemberBody, CreateAgentBody, CreateTokenBody, MemberWithUser,
    TokenCreated, UpdateAgentBody,
};
use crate::service::{self, MemberCaller, MemberViewer, agent_view};

/// `@NoGuests()` on `TokensController`.
const TOKENS: Gate = Gate::authenticated().no_guests();

#[derive(OpenApi)]
#[openapi(
    paths(
        list_members,
        add_member,
        change_member,
        remove_member,
        list_agents,
        create_agent,
        get_agent,
        update_agent,
        remove_agent,
        list_tokens,
        create_token,
        remove_token
    ),
    components(schemas(
        AddMemberBody,
        ChangeMemberBody,
        MemberWithUser,
        CreateAgentBody,
        UpdateAgentBody,
        Agent,
        CreateTokenBody,
        TokenCreated,
        ApiTokenView
    ))
)]
pub(crate) struct MembersDoc;

pub(crate) fn routes() -> Routes {
    Routes::new()
        .get("/w/{slug}/members", Gate::authenticated(), list_members)
        .post("/w/{slug}/members", Gate::authenticated().can(Capability::InviteMembers), add_member)
        .patch("/w/{slug}/members/{id}", ADMIN, change_member)
        .delete(
            "/w/{slug}/members/{id}",
            Gate::authenticated().roles(LegacyRole::Viewer),
            remove_member,
        )
        .get("/w/{slug}/agents", Gate::authenticated(), list_agents)
        .post("/w/{slug}/agents", Gate::authenticated().can(Capability::ManageAgents), create_agent)
        .get("/w/{slug}/agents/{id}", Gate::authenticated().no_guests(), get_agent)
        .patch(
            "/w/{slug}/agents/{id}",
            Gate::authenticated().can(Capability::ManageAgents),
            update_agent,
        )
        .delete(
            "/w/{slug}/agents/{id}",
            Gate::authenticated().can(Capability::ManageAgents),
            remove_agent,
        )
        .get("/w/{slug}/tokens", TOKENS, list_tokens)
        .post("/w/{slug}/tokens", TOKENS.require_user().can(Capability::ManageTokens), create_token)
        .delete("/w/{slug}/tokens/{id}", TOKENS, remove_token)
}

// ───────────────────────────── members ─────────────────────────────

/// Everyone in the workspace, or, for someone limited to some projects, the people on those
/// projects.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/members",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses((status = 200, description = "Memberships with their accounts", body = [MemberWithUser]))
)]
async fn list_members(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<MemberWithUser>>, AppError> {
    let members =
        service::list_members(&state.db, &ctx.workspace.id, Some(MemberViewer::of(&ctx))).await?;
    Ok(Json(members))
}

/// Adds an existing account to the workspace.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/members",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = AddMemberBody,
    responses(
        (status = 201, description = "The new membership", body = MemberWithUser),
        (status = 400, description = "Invalid body or unknown role"),
        (status = 403, description = "Cannot invite, or cannot grant that role"),
        (status = 404, description = "No account with that email"),
        (status = 409, description = "Already a member"),
    )
)]
async fn add_member(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<AddMemberBody>,
) -> Result<(StatusCode, Json<MemberWithUser>), AppError> {
    let input = body.validate()?;
    let added =
        service::add_member(&state, &ctx.workspace, &MemberCaller::of(&ctx), &input).await?;
    Ok((StatusCode::CREATED, Json(added)))
}

/// Changes a member's role, custom access, or both. Admin.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/members/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Membership id"),
    ),
    request_body = ChangeMemberBody,
    responses(
        (status = 200, description = "The updated membership", body = MemberWithUser),
        (status = 400, description = "Nothing to change, or an invalid role or access"),
        (status = 403, description = "Not allowed to grant or change that"),
        (status = 404, description = "Unknown membership"),
        (status = 409, description = "Would leave the workspace without an owner"),
    )
)]
async fn change_member(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<ChangeMemberBody>,
) -> Result<Json<MemberWithUser>, AppError> {
    let patch = body.validate()?;
    let updated =
        service::update_member(&state, &ctx.workspace, &MemberCaller::of(&ctx), &id, &patch)
            .await?;
    Ok(Json(updated))
}

/// Admins remove anyone below owner; any member can remove themselves (leave). Only the
/// workspace owner removes other owners, and nobody else removes the workspace owner, who
/// transfers ownership before leaving.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/members/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Membership id"),
    ),
    responses(
        (status = 204, description = "Removed"),
        (status = 403, description = "Not allowed to remove them"),
        (status = 404, description = "Unknown membership"),
        (status = 409, description = "The owner must transfer ownership first"),
    )
)]
async fn remove_member(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove_member(&state, &ctx.workspace, &MemberCaller::of(&ctx), &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ───────────────────────────── agents ─────────────────────────────

/// Every agent, or, for someone limited to some projects, the agents with a task on those
/// projects.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/agents",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses((status = 200, description = "Agents, oldest first", body = [Agent]))
)]
async fn list_agents(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<Agent>>, AppError> {
    let rows = service::list_agents(&state.db, &ctx.workspace.id).await?;
    Ok(Json(rows.iter().map(agent_view).collect()))
}

/// Registers an agent.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/agents",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateAgentBody,
    responses(
        (status = 201, description = "The agent", body = Agent),
        (status = 400, description = "Invalid body, or the owner is not a member"),
        (status = 403, description = "Cannot manage agents"),
    )
)]
async fn create_agent(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateAgentBody>,
) -> Result<(StatusCode, Json<Agent>), AppError> {
    let input = body.validate()?;
    let agent = service::create_agent(&state, &ctx.workspace.id, &input).await?;
    Ok((StatusCode::CREATED, Json(agent_view(&agent))))
}

/// One agent.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/agents/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Agent id"),
    ),
    responses(
        (status = 200, description = "The agent", body = Agent),
        (status = 403, description = "Guests cannot"),
        (status = 404, description = "Unknown agent"),
    )
)]
async fn get_agent(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Agent>, AppError> {
    let agent = service::get_agent(&state.db, &ctx.workspace.id, &id).await?;
    Ok(Json(agent_view(&agent)))
}

/// Edits an agent; `null` clears its description or owner.
#[utoipa::path(
    patch,
    path = "/api/w/{slug}/agents/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Agent id"),
    ),
    request_body = UpdateAgentBody,
    responses(
        (status = 200, description = "The agent", body = Agent),
        (status = 400, description = "Invalid body, or the owner is not a member"),
        (status = 403, description = "Cannot manage agents"),
        (status = 404, description = "Unknown agent"),
    )
)]
async fn update_agent(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateAgentBody>,
) -> Result<Json<Agent>, AppError> {
    let patch = body.validate()?;
    let agent = service::update_agent(&state, &ctx.workspace.id, &id, &patch).await?;
    Ok(Json(agent_view(&agent)))
}

/// Removes an agent and the tokens that act as it.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/agents/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Agent id"),
    ),
    responses(
        (status = 204, description = "Removed"),
        (status = 403, description = "Cannot manage agents"),
        (status = 404, description = "Unknown agent"),
    )
)]
async fn remove_agent(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::remove_agent(&state, &ctx.workspace.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ───────────────────────────── tokens ─────────────────────────────

/// Admins see every token of the workspace; others only their own.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/tokens",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Tokens, newest first", body = [ApiTokenView]),
        (status = 403, description = "Guests cannot"),
    )
)]
async fn list_tokens(
    ctx: Ctx,
    State(state): State<AppState>,
) -> Result<Json<Vec<ApiTokenView>>, AppError> {
    let only =
        if ctx.has_admin_power() { None } else { Some(ctx.user_id.as_deref().unwrap_or("-")) };
    let all = service::list_tokens(&state.db, &ctx.workspace.id, only).await?;
    // the assistant's per-turn tokens live for seconds; they are not something to manage
    Ok(Json(all.into_iter().filter(|t| t.name != ASSISTANT_TOKEN_NAME).collect()))
}

/// Returns `{ token, secret }`; the secret is shown only this once.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tokens",
    tag = "workspaces",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateTokenBody,
    responses(
        (status = 201, description = "The token and its secret", body = TokenCreated),
        (status = 400, description = "Invalid body, or contradictory scope and permissions"),
        (status = 403, description = "Cannot manage tokens, or would escalate"),
        (status = 404, description = "Unknown agent"),
    )
)]
async fn create_token(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateTokenBody>,
) -> Result<(StatusCode, Json<TokenCreated>), AppError> {
    let input = body.validate()?;
    let created = service::create_api_token(&state, &ctx, &auth, &input).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Revokes a token. Admins revoke any; others only their own.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/tokens/{id}",
    tag = "workspaces",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Token id"),
    ),
    responses(
        (status = 204, description = "Revoked"),
        (status = 404, description = "Unknown token"),
    )
)]
async fn remove_token(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let only =
        if ctx.has_admin_power() { None } else { Some(ctx.user_id.as_deref().unwrap_or("-")) };
    service::remove_token(&state.db, &ctx.workspace.id, &id, only).await?;
    Ok(StatusCode::NO_CONTENT)
}
