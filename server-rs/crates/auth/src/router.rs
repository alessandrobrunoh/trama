//! `/api/auth/*`: the port of `server/src/auth/auth.controller.ts`.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use sea_orm::EntityTrait;
use serde_json::Value;
use trama_contracts::identity::User;
use trama_contracts::roles::{ApiAction, TokenScope, api_permissions};
use trama_core::{ApiJson, AppError, AppState};
use trama_entities::workspaces;
use utoipa::OpenApi;

use crate::context::Auth;
use crate::cookies::{append_cookies, cleared_session_cookies, session_cookies};
use crate::gate::{Gate, Routes};
use crate::personal_workspace::ensure_personal_workspace;
use crate::schemas::{LoginBody, Session, SignupBody, TokenIntrospection, TokenWorkspace};
use crate::service::{self, NewUser, WorkspaceWithRole};
use crate::tokens::ApiTokenView;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(signup, login, logout, me, token),
    components(schemas(
        SignupBody,
        LoginBody,
        Session,
        WorkspaceWithRole,
        TokenIntrospection,
        TokenWorkspace,
        ApiTokenView
    ))
)]
pub struct ApiDoc;

/// Routes of this module, relative to `/api`.
pub fn router() -> Routes {
    Routes::new()
        .post("/auth/signup", Gate::public(), signup)
        .post("/auth/login", Gate::public(), login)
        .post("/auth/logout", Gate::authenticated().require_user(), logout)
        .get("/auth/me", Gate::authenticated().require_user(), me)
        .get("/auth/token", Gate::authenticated().allow_custom_token(), token)
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers.get(header::USER_AGENT).map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect())
}

fn with_cookies(status: StatusCode, body: impl IntoResponse, cookies: &[String]) -> Response {
    let mut res = (status, body).into_response();
    append_cookies(res.headers_mut(), cookies);
    res
}

/// Creates an account, its personal workspace and a session. Public.
#[utoipa::path(
    post,
    path = "/api/auth/signup",
    tag = "auth",
    request_body = SignupBody,
    responses(
        (status = 201, description = "Signed up; sets the session cookie", body = Session),
        (status = 400, description = "Invalid body"),
        (status = 409, description = "Email already registered"),
        (status = 415, description = "Not JSON"),
    )
)]
async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<SignupBody>,
) -> Result<Response, AppError> {
    let input = body.validate()?;
    let user = service::create_user(
        &state.db,
        NewUser { name: &input.name, email: &input.email, password: &input.password },
    )
    .await?;
    let personal = ensure_personal_workspace(&state.db, &user).await?;
    let session =
        service::create_session(&state.db, &user.id, user_agent(&headers).as_deref()).await?;
    let body = Session { user: User::from(&user), workspaces: vec![personal] };
    Ok(with_cookies(
        StatusCode::CREATED,
        Json(body),
        &session_cookies(&session.raw, state.config.production),
    ))
}

/// Signs in with email and password. Public.
#[utoipa::path(
    post,
    path = "/api/auth/login",
    tag = "auth",
    request_body = LoginBody,
    responses(
        (status = 200, description = "Signed in; sets the session cookie", body = Session),
        (status = 400, description = "Invalid body"),
        (status = 401, description = "Invalid email or password"),
        (status = 415, description = "Not JSON"),
    )
)]
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<LoginBody>,
) -> Result<Response, AppError> {
    let (email, password) = body.validate()?;
    let user = service::verify_credentials(&state.db, &email, &password).await?;
    // accounts created before personal workspaces existed (or by seeding) get theirs now
    ensure_personal_workspace(&state.db, &user).await?;
    let session =
        service::create_session(&state.db, &user.id, user_agent(&headers).as_deref()).await?;
    let body = Session {
        user: User::from(&user),
        workspaces: service::workspaces_of(&state.db, &user.id).await?,
    };
    Ok(with_cookies(
        StatusCode::OK,
        Json(body),
        &session_cookies(&session.raw, state.config.production),
    ))
}

/// Ends the browser session and clears both cookie names. Needs a user.
#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "auth",
    responses(
        (status = 204, description = "Signed out; clears the session cookies"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent token, or missing CSRF header"),
    )
)]
async fn logout(State(state): State<AppState>, auth: Auth) -> Result<Response, AppError> {
    if let Some(session_id) = &auth.session_id {
        service::destroy_session(&state.db, session_id).await?;
    }
    Ok(with_cookies(StatusCode::NO_CONTENT, (), &cleared_session_cookies(state.config.production)))
}

/// The signed-in user and their workspaces. An API token only sees its own workspace.
#[utoipa::path(
    get,
    path = "/api/auth/me",
    tag = "auth",
    responses(
        (status = 200, description = "The caller", body = Session),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent or custom token"),
    )
)]
async fn me(State(state): State<AppState>, auth: Auth) -> Result<Json<Session>, AppError> {
    let user = auth.require_user()?;
    let mut workspaces = service::workspaces_of(&state.db, &user.id).await?;
    // an API token belongs to one workspace: it does not learn about the user's others
    if let Some(token) = &auth.token {
        workspaces.retain(|w| w.workspace.id == token.workspace_id());
    }
    Ok(Json(Session { user: User::from(user), workspaces }))
}

/// Introspection for API-token clients (the MCP server): the token's workspace and what it may
/// do, so a client needs nothing but the key.
#[utoipa::path(
    get,
    path = "/api/auth/token",
    tag = "auth",
    responses(
        (status = 200, description = "The token", body = TokenIntrospection),
        (status = 401, description = "No credentials"),
        (status = 403, description = "Called without an API token"),
    )
)]
async fn token(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<TokenIntrospection>, AppError> {
    let Some(token) = &auth.token else {
        return Err(AppError::forbidden("Call this endpoint with an API token"));
    };
    let workspace = workspaces::Entity::find_by_id(token.workspace_id().to_owned())
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            AppError::internal(format!("workspace of token {} is gone", token.row.id))
        })?;
    let all = || api_permissions().into_iter();
    let permissions: Vec<Value> = match token.scope {
        Some(TokenScope::Custom) => {
            token.row.permissions.as_ref().and_then(Value::as_array).cloned().unwrap_or_default()
        }
        Some(TokenScope::Read) => all()
            .filter(|p| p.action == ApiAction::Read)
            .map(|p| Value::String(p.to_string()))
            .collect(),
        _ => all().map(|p| Value::String(p.to_string())).collect(),
    };
    Ok(Json(TokenIntrospection {
        token: ApiTokenView::from(&token.row),
        actor: auth.actor.clone(),
        workspace: TokenWorkspace { id: workspace.id, slug: workspace.slug, name: workspace.name },
        permissions,
    }))
}
