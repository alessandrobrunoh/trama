//! The access guard: the port of `server/src/workspaces/access.guard.ts` (`AccessGuard`, the
//! single global guard) and `MemberAccessInterceptor`.
//!
//! It runs in front of every route registered through [`crate::Routes`], after routing and
//! before any extractor (so before body validation, as NestJS guards run before pipes). In
//! order, the first failing check answers:
//!
//! 1. a [`Gate::public`] route passes, but a mutating request with a body must be JSON (415);
//! 2. authentication: `Authorization: Bearer trm_…|nbl_…`, else the `trama_session` /
//!    `nabla_session` cookie (401 `Authentication required`). A bearer header that does not
//!    resolve never falls back to the cookie;
//! 3. cookie-session writes: the body must be JSON (multipart on a [`Gate::multipart`] route,
//!    415) and `X-Requested-With` or `X-Client-Id` must be sent (403);
//! 4. [`Gate::session_only`] refuses API tokens (403);
//! 5. API tokens: the per-token budget (429), then a `custom` token needs the route's
//!    `<resource>:<action>` (403);
//! 6. a `read` token cannot write (403);
//! 7. [`Gate::require_user`] refuses agent tokens (403);
//! 8. routes with a `{slug}` segment: the workspace and the caller's membership (404 for
//!    non-members), the role (403 `This role is no longer available`), the guest marker, the
//!    role gate with the token scope cap, then the member grant (403 each).
//!
//! The handler then runs with the member access and upload caller of the request in their
//! task-locals.

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::extract::{MatchedPath, OriginalUri, RawPathParams, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use trama_contracts::access::{MemberAccess, effective_member_access};
use trama_contracts::common::{ActorRef, ActorType};
use trama_contracts::identity::stored_member_access;
use trama_contracts::roles::{
    GUEST_ROLE_ID, LegacyRole, RoleGate, TokenScope, agent_workspace_role, apply_token_scope,
    find_workspace_role, role_allows,
};
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::{AppError, AppState};
use trama_entities::{agents, memberships, users, workspaces};

use crate::context::{AuthInfo, AuthMethod, AuthToken, WorkspaceContext};
use crate::cookies::session_cookie;
use crate::gate::{Gate, RouteEntry, RouteTable};
use crate::member_access::with_access;
use crate::upload_caller::{UploadCaller, with_upload_caller};
use crate::{service, tokens};

/// 401 when no credentials resolve.
pub const AUTH_REQUIRED: &str = "Authentication required";
/// 415 for a non-JSON body.
pub const JSON_REQUIRED: &str = "Content-Type must be application/json";
/// 403 for a cookie-session write without the CSRF header.
pub const CSRF_REQUIRED: &str = "Missing X-Requested-With or X-Client-Id header";
/// 403 of [`Gate::session_only`].
pub const SESSION_ONLY: &str =
    "This account-level route is only available to signed-in browser sessions, not API tokens";
/// 403 for a write with a `read` token.
pub const READ_SCOPE: &str = "This API token has the \"read\" scope and can only call GET routes";
/// 403 of [`Gate::require_user`].
pub const REQUIRE_USER: &str = "This endpoint requires a user, not an agent token";
/// 403 for a `custom` token on a route outside the permission catalog.
pub const NOT_FOR_CUSTOM: &str = "This route is not available to custom API tokens";
/// 403 when the membership's role was deleted.
pub const ROLE_GONE: &str = "This role is no longer available";
/// 403 of [`Gate::no_guests`].
pub const NO_GUESTS: &str = "Guests cannot do that";
/// 403 when the role does not pass the gate.
pub const NOT_ALLOWED: &str = "You are not allowed to do that";

/// Does a cookie session's write carry an acceptable body type? Bodies must be JSON; a route
/// marked [`Gate::multipart`] may also take `multipart/form-data` (`sessionAllowsContentType`).
#[must_use]
#[allow(clippy::fn_params_excessive_bools)]
pub fn session_allows_content_type(
    has_body: bool,
    json: bool,
    multipart: bool,
    multipart_route: bool,
) -> bool {
    !has_body || json || (multipart_route && multipart)
}

struct Guard {
    state: AppState,
    table: RouteTable,
}

impl Guard {
    fn lookup(&self, method: &Method, path: &str) -> Option<Arc<RouteEntry>> {
        let find = |m: &Method, p: &str| self.table.get(&(m.clone(), p.to_owned())).cloned();
        let relative = path.strip_prefix("/api").filter(|p| p.starts_with('/'));
        let at = |m: &Method| find(m, path).or_else(|| relative.and_then(|p| find(m, p)));
        at(method).or_else(|| (method == Method::HEAD).then(|| at(&Method::GET)).flatten())
    }

    fn path_known(&self, path: &str) -> bool {
        let relative = path.strip_prefix("/api").unwrap_or(path);
        self.table.keys().any(|(_, p)| p == path || p == relative)
    }
}

pub(crate) fn install(
    router: Router<AppState>,
    table: RouteTable,
    state: AppState,
) -> Router<AppState> {
    let guard = Arc::new(Guard { state, table });
    router.layer(middleware::from_fn_with_state(guard, run))
}

async fn run(State(guard): State<Arc<Guard>>, req: Request, next: Next) -> Response {
    let Some(matched) = req.extensions().get::<MatchedPath>().map(|m| m.as_str().to_owned()) else {
        return next.run(req).await;
    };
    let method = req.method().clone();
    let entry = match guard.lookup(&method, &matched) {
        Some(entry) => entry,
        // a method nobody registered on a known path: NestJS answers 404 before any guard
        None if guard.path_known(&matched) => {
            let path = req
                .extensions()
                .get::<OriginalUri>()
                .map_or_else(|| req.uri().path().to_owned(), |u| u.path().to_owned());
            return AppError::not_found(format!("Cannot {method} {path}")).into_response();
        }
        // not registered through `Routes` at all: the default gate (fail closed)
        None => Arc::new(RouteEntry::new(
            &method,
            matched.strip_prefix("/api").unwrap_or(&matched),
            Gate::authenticated(),
        )),
    };
    let (mut parts, body) = req.into_parts();
    let passed = match check(&guard.state, &entry, &mut parts).await {
        Ok(passed) => passed,
        Err(err) => return err.into_response(),
    };
    let access = passed.ctx.as_ref().and_then(|c| c.access_arc());
    let caller = passed.ctx.as_ref().map(|ctx| {
        Arc::new(UploadCaller {
            actor: ctx.actor.clone(),
            role: ctx.role.clone(),
            permissions: passed.auth.as_ref().and_then(|a| a.token.as_ref()).and_then(|t| {
                (t.scope == Some(TokenScope::Custom))
                    .then(|| t.permissions.clone().unwrap_or_default())
            }),
        })
    });
    if let Some(auth) = passed.auth {
        parts.extensions.insert(auth);
    }
    if let Some(ctx) = passed.ctx {
        parts.extensions.insert(ctx);
    }
    let req = Request::from_parts(parts, body);
    with_access(access, with_upload_caller(caller, next.run(req))).await
}

struct Passed {
    auth: Option<Arc<AuthInfo>>,
    ctx: Option<Arc<WorkspaceContext>>,
}

fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// `content-length` present and not `0`, or `transfer-encoding` present.
fn has_body(headers: &HeaderMap) -> bool {
    headers.get(header::CONTENT_LENGTH).is_some_and(|v| v.as_bytes() != b"0")
        || headers.contains_key(header::TRANSFER_ENCODING)
}

/// `req.is(mime)`: the media type of `Content-Type` (parameters dropped, case-insensitive).
fn content_type_is(headers: &HeaderMap, mime: &str) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case(mime))
}

fn non_empty_header(headers: &HeaderMap, name: &str) -> bool {
    headers.get(name).is_some_and(|v| !v.is_empty())
}

fn unsupported() -> AppError {
    AppError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, JSON_REQUIRED)
}

async fn check(
    state: &AppState,
    entry: &RouteEntry,
    parts: &mut Parts,
) -> Result<Passed, AppError> {
    let gate = entry.gate;
    let method = parts.method.clone();
    let mutating = !is_safe(&method);
    let headers = &parts.headers;

    if gate.public {
        if mutating && has_body(headers) && !content_type_is(headers, "application/json") {
            return Err(unsupported());
        }
        return Ok(Passed { auth: None, ctx: None });
    }

    let auth = authenticate(state, headers)
        .await?
        .ok_or_else(|| AppError::new(StatusCode::UNAUTHORIZED, AUTH_REQUIRED))?;

    if mutating && auth.method == AuthMethod::Session {
        if !session_allows_content_type(
            has_body(headers),
            content_type_is(headers, "application/json"),
            content_type_is(headers, "multipart/form-data"),
            gate.multipart,
        ) {
            return Err(unsupported());
        }
        if !non_empty_header(headers, "x-requested-with")
            && !non_empty_header(headers, "x-client-id")
        {
            return Err(AppError::forbidden(CSRF_REQUIRED));
        }
    }

    if auth.token.is_some() && gate.session_only {
        return Err(AppError::forbidden(SESSION_ONLY));
    }

    if let Some(token) = &auth.token {
        tokens::enforce_limits(&state.db, &token.row, mutating).await?;
        if token.scope == Some(TokenScope::Custom) {
            enforce_custom_permission(entry, token, mutating)?;
        }
    }

    if auth.token_scope() == Some(TokenScope::Read) && mutating {
        return Err(AppError::forbidden(READ_SCOPE));
    }

    if gate.require_user && auth.user.is_none() {
        return Err(AppError::forbidden(REQUIRE_USER));
    }

    let slug = slug_param(parts).await?;
    let ctx = match slug {
        Some(slug) => Some(Arc::new(workspace_context(state, entry, &method, &auth, &slug).await?)),
        None => None,
    };
    Ok(Passed { auth: Some(Arc::new(auth)), ctx })
}

/// `custom` tokens: the route's `<resource>:<action>` must be in the token's list.
fn enforce_custom_permission(
    entry: &RouteEntry,
    token: &AuthToken,
    mutating: bool,
) -> Result<(), AppError> {
    let Some(needed) = entry.permission else {
        // File bytes are not their own permission: the uploads service checks the parent
        // record, and whether this token may write, before anything is stored or returned.
        if entry.upload_bytes || (entry.gate.allow_custom_token && !mutating) {
            return Ok(());
        }
        return Err(AppError::forbidden(NOT_FOR_CUSTOM));
    };
    let needed = needed.to_string();
    if !token.has_permission(&needed) {
        return Err(AppError::forbidden(format!(
            "This API token lacks the \"{needed}\" permission"
        )));
    }
    Ok(())
}

async fn slug_param(parts: &mut Parts) -> Result<Option<String>, AppError> {
    use axum::extract::FromRequestParts;
    let params = match RawPathParams::from_request_parts(parts, &()).await {
        Ok(params) => params,
        Err(rejection) => return Err(AppError::bad_request(rejection.body_text())),
    };
    Ok(params
        .iter()
        .find(|(name, _)| *name == "slug")
        .map(|(_, v)| v.to_owned())
        .filter(|v| !v.is_empty()))
}

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Bearer\s+(\S+)$").unwrap_or_else(|e| unreachable!("{e}")));

/// Resolves the caller: a bearer token when an `Authorization` header is sent (and nothing else
/// then), else the session cookie.
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Option<AuthInfo>, AppError> {
    let db = &state.db;
    if let Some(value) = headers.get(header::AUTHORIZATION).filter(|v| !v.is_empty()) {
        let value: String = value.as_bytes().iter().map(|b| char::from(*b)).collect();
        let Some(secret) = BEARER.captures(&value).and_then(|c| c.get(1)) else { return Ok(None) };
        // A presented bearer token that is missing, revoked or expired is not a session: do not
        // fall through to the cookie, the caller asked to act as that token.
        let Some(token) = tokens::authenticate(db, secret.as_str()).await? else { return Ok(None) };
        if token.actor.kind == ActorType::User {
            let Some(id) = token.actor.id.clone() else { return Ok(None) };
            let Some(user) = users::Entity::find_by_id(id).one(db).await? else { return Ok(None) };
            return Ok(Some(AuthInfo {
                actor: ActorRef::user(user.id.clone()),
                user: Some(user),
                token: Some(token),
                method: AuthMethod::Token,
                session_id: None,
            }));
        }
        return Ok(Some(AuthInfo {
            actor: token.actor.clone(),
            user: None,
            token: Some(token),
            method: AuthMethod::Token,
            session_id: None,
        }));
    }
    let Some(raw) = session_cookie(headers) else { return Ok(None) };
    let Some((user, session_id)) = service::authenticate_session(db, &raw).await? else {
        return Ok(None);
    };
    Ok(Some(AuthInfo {
        actor: ActorRef::user(user.id.clone()),
        user: Some(user),
        token: None,
        method: AuthMethod::Session,
        session_id: Some(session_id),
    }))
}

enum Membership {
    User { role: String, access: Option<MemberAccess> },
    Agent,
}

/// The caller's membership, or a synthetic agent membership; `None` without access.
async fn membership_in(
    state: &AppState,
    auth: &AuthInfo,
    workspace_id: &str,
) -> Result<Option<Membership>, AppError> {
    if auth.token.as_ref().is_some_and(|t| t.workspace_id() != workspace_id) {
        return Ok(None);
    }
    if let Some(user) = &auth.user {
        let row = memberships::Entity::find()
            .filter(memberships::Column::WorkspaceId.eq(workspace_id))
            .filter(memberships::Column::UserId.eq(user.id.clone()))
            .one(&state.db)
            .await?;
        return Ok(row.map(|m| Membership::User {
            access: stored_member_access(m.access.as_ref()),
            role: m.role,
        }));
    }
    // Agent token: valid only while the agent still exists in this workspace. Agents are not
    // narrowed per person.
    if auth.actor.kind == ActorType::Agent
        && let Some(id) = auth.actor.id.as_ref().filter(|id| !id.is_empty())
    {
        let exists = agents::Entity::find()
            .filter(agents::Column::Id.eq(id.clone()))
            .filter(agents::Column::WorkspaceId.eq(workspace_id))
            .count(&state.db)
            .await?
            > 0;
        return Ok(exists.then_some(Membership::Agent));
    }
    Ok(None)
}

/// `@Roles(min)` with an id that is not an old rank gates like `member` (`rankGate`); the typed
/// [`LegacyRole`] makes that case unrepresentable.
fn default_min(gate: Gate, mutating: bool) -> LegacyRole {
    gate.min.unwrap_or(if mutating { LegacyRole::Member } else { LegacyRole::Viewer })
}

async fn workspace_context(
    state: &AppState,
    entry: &RouteEntry,
    method: &Method,
    auth: &AuthInfo,
    slug: &str,
) -> Result<WorkspaceContext, AppError> {
    let gate = entry.gate;
    let mutating = !is_safe(method);
    let not_found = || AppError::not_found(format!("Workspace \"{slug}\" not found"));
    let workspace = workspaces::Entity::find()
        .filter(workspaces::Column::Slug.eq(slug))
        .one(&state.db)
        .await?
        .ok_or_else(not_found)?;
    let membership = membership_in(state, auth, &workspace.id).await?.ok_or_else(not_found)?;
    let settings = resolve_workspace_settings(&workspace.settings);
    let (member_role, stored, is_agent) = match membership {
        Membership::User { role, access } => (role, access, false),
        Membership::Agent => ("member".to_owned(), None, true),
    };
    let base_role = if is_agent {
        agent_workspace_role()
    } else {
        find_workspace_role(&settings.roles, Some(&member_role))
            .cloned()
            .ok_or_else(|| AppError::forbidden(ROLE_GONE))?
    };
    let capability = gate.capability;
    let scope = auth.token_scope();
    let effective = apply_token_scope(&base_role, scope);
    if !is_agent && member_role == GUEST_ROLE_ID && gate.no_guests {
        return Err(AppError::forbidden(NO_GUESTS));
    }
    let access = effective_member_access(Some(&effective), stored.as_ref());
    let role_gate =
        RoleGate { capability, min: default_min(gate, mutating), needed_grant: entry.member_grant };
    if !role_allows(Some(&effective), &role_gate, access.as_ref()) {
        let uncapped = effective_member_access(Some(&base_role), stored.as_ref());
        if let Some(scope) = scope.filter(|s| *s != TokenScope::Admin)
            && role_allows(Some(&base_role), &role_gate, uncapped.as_ref())
        {
            return Err(AppError::forbidden(format!(
                "This route needs more than the \"{scope}\" token scope allows"
            )));
        }
        if let Some(capability) = capability {
            return Err(AppError::forbidden(format!(
                "You are not allowed to {}",
                capability.meta().label.to_lowercase()
            )));
        }
        return Err(AppError::forbidden(NOT_ALLOWED));
    }
    // A capability is the permission for this route. Grants still narrow routes that are not
    // capability-gated.
    if let (Some(access), None, Some(needed)) = (&access, capability, entry.member_grant)
        && !access.grants.contains(&needed)
    {
        return Err(AppError::forbidden(format!("Your access does not include \"{needed}\"")));
    }
    Ok(WorkspaceContext {
        settings,
        actor: auth.actor.clone(),
        user_id: auth.user.as_ref().map(|u| u.id.clone()),
        member_role: member_role.clone(),
        role: member_role,
        token_scope: scope,
        access,
        owner: effective.owner,
        capabilities: effective.capabilities.clone(),
        effective_role: effective,
        workspace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_content_type_keeps_json_and_allows_multipart_only_on_upload_routes() {
        assert!(session_allows_content_type(true, true, false, false));
        assert!(!session_allows_content_type(true, false, true, false));
        assert!(session_allows_content_type(true, false, true, true));
        assert!(!session_allows_content_type(true, false, false, true));
        assert!(session_allows_content_type(false, false, false, false));
    }

    #[test]
    fn reads_content_types_like_type_is() {
        let mut h = HeaderMap::new();
        assert!(!content_type_is(&h, "application/json"));
        h.insert(header::CONTENT_TYPE, "Application/JSON; charset=utf-8".parse().unwrap());
        assert!(content_type_is(&h, "application/json"));
        h.insert(header::CONTENT_TYPE, "application/vnd.api+json".parse().unwrap());
        assert!(!content_type_is(&h, "application/json"));
        assert!(!has_body(&h));
        h.insert(header::CONTENT_LENGTH, "0".parse().unwrap());
        assert!(!has_body(&h));
        h.insert(header::CONTENT_LENGTH, "2".parse().unwrap());
        assert!(has_body(&h));
    }

    #[test]
    fn parses_bearer_headers_like_the_regex() {
        let secret = |h: &str| BEARER.captures(h).map(|c| c[1].to_owned());
        assert_eq!(secret("Bearer trm_x").as_deref(), Some("trm_x"));
        assert_eq!(secret("bearer   trm_x").as_deref(), Some("trm_x"));
        assert_eq!(secret("Bearer trm_x extra"), None);
        assert_eq!(secret("Basic abc"), None);
        assert_eq!(secret("Bearer "), None);
    }
}
