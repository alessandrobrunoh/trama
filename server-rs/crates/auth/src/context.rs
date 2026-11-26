//! Who is calling, and the workspace a `/w/{slug}` route acts in: the Rust form of
//! `AuthInfo`, `WorkspaceContext` and the `@Auth()`, `@Ctx()` and `@Actor()` parameter
//! decorators of `server/src/auth/request-context.ts`.
//!
//! The guard puts an [`AuthInfo`] (every non-public route) and a [`WorkspaceContext`] (routes
//! with a `{slug}` segment) into the request extensions; handlers take them with the [`Auth`],
//! [`Ctx`] and [`Actor`] extractors.

use std::ops::Deref;
use std::sync::Arc;

use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::request::Parts;
use serde_json::Value;
use trama_contracts::access::MemberAccess;
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{
    Capability, Role, TokenScope, WorkspaceRole, legacy_role_at_least, role_has_admin_power,
};
use trama_contracts::settings::WorkspaceSettings;
use trama_core::AppError;
use trama_entities::{api_tokens, users, workspaces};

/// How the caller authenticated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    /// The httpOnly `trama_session` (or legacy `nabla_session`) cookie.
    Session,
    /// `Authorization: Bearer trm_…` (or a legacy `nbl_…` token).
    Token,
}

/// An API token row with its JSON columns read.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthToken {
    /// The row (`last_used_at` already touched by this request when due).
    pub row: api_tokens::Model,
    /// `scope`; `None` only for a value outside the catalog (treated like `admin`).
    pub scope: Option<TokenScope>,
    /// `actor`: who the token acts as.
    pub actor: ActorRef,
    /// `permissions`, as stored; set only for `custom` tokens.
    pub permissions: Option<Vec<String>>,
}

impl AuthToken {
    /// Reads a token row. A row whose `actor` is not an actor reference yields `None`.
    #[must_use]
    pub fn from_row(row: api_tokens::Model) -> Option<Self> {
        let actor: ActorRef = serde_json::from_value(row.actor.clone()).ok()?;
        let scope = TokenScope::parse(&row.scope);
        let permissions = row
            .permissions
            .as_ref()
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect());
        Some(Self { row, scope, actor, permissions })
    }

    /// The token's workspace.
    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.row.workspace_id
    }

    /// `token.permissions?.includes(permission)`.
    #[must_use]
    pub fn has_permission(&self, permission: &str) -> bool {
        self.permissions.as_ref().is_some_and(|p| p.iter().any(|x| x == permission))
    }
}

/// Who is calling (set by the guard on every non-public route). `@Auth()`.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthInfo {
    /// The acting user or agent.
    pub actor: ActorRef,
    /// Present for browser sessions and user-actor API tokens; absent for agent tokens.
    pub user: Option<users::Model>,
    /// Present when authenticated with an API token.
    pub token: Option<AuthToken>,
    /// Session or token.
    pub method: AuthMethod,
    /// sha256 id of the cookie session (method = session).
    pub session_id: Option<String>,
}

impl AuthInfo {
    /// The scope of the API token, `None` for browser sessions.
    #[must_use]
    pub fn token_scope(&self) -> Option<TokenScope> {
        self.token.as_ref().and_then(|t| t.scope)
    }

    /// The user, or 403 `This endpoint requires a user, not an agent token` (what
    /// [`crate::Gate::require_user`] guarantees ahead of the handler).
    ///
    /// # Errors
    ///
    /// 403 for an agent token.
    pub fn require_user(&self) -> Result<&users::Model, AppError> {
        self.user.as_ref().ok_or_else(|| AppError::forbidden(crate::guard::REQUIRE_USER))
    }
}

/// Resolved for every route under `/api/w/{slug}/…`. `@Ctx()`.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceContext {
    /// The workspace row.
    pub workspace: workspaces::Model,
    /// Its settings with the defaults applied (`workspace.resolved()`).
    pub settings: WorkspaceSettings,
    /// The acting user or agent.
    pub actor: ActorRef,
    /// The acting user's id (`None` for agent tokens).
    pub user_id: Option<String>,
    /// The membership's role id (`member` for agents). A read or write token does not change
    /// this; `owner` and `capabilities` do.
    pub role: Role,
    /// The caller's real workspace role, ignoring any token scope cap (same as `role`).
    pub member_role: Role,
    /// Scope of the API token used for this request (`None` for browser sessions).
    pub token_scope: Option<TokenScope>,
    /// Present only when this person is narrower than their role. The owner role is never
    /// narrowed. `None`: the role applies in full.
    pub access: Option<MemberAccess>,
    /// True when this request still has the owner role (false for a read or write token).
    pub owner: bool,
    /// Capabilities of the role after the token scope cap.
    pub capabilities: Vec<Capability>,
    /// The role definition after the token scope cap (`agent` for agent tokens).
    pub effective_role: WorkspaceRole,
}

impl WorkspaceContext {
    /// The workspace id.
    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace.id
    }

    /// `isOwner(ctx)`: the owner role, unless a read or write token capped this request.
    #[must_use]
    pub fn is_owner(&self) -> bool {
        self.owner
    }

    /// `hasAdminPower(ctx)`: the owner role, or a capability that used to require an admin.
    #[must_use]
    pub fn has_admin_power(&self) -> bool {
        self.owner
            || role_has_admin_power(Some(&WorkspaceRole {
                owner: false,
                capabilities: self.capabilities.clone(),
                ..self.effective_role.clone()
            }))
    }

    /// `canDo(ctx, capability)`: does this request's role include it (capped by the token
    /// scope)?
    #[must_use]
    pub fn can_do(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// Deprecated `hasRole(ctx.role, min)`: both ids are old ranks and `role` is at least `min`.
    #[must_use]
    pub fn has_role(&self, min: &str) -> bool {
        legacy_role_at_least(&self.role, min)
    }

    /// The member access as an `Arc`, for [`crate::member_access::with_access`].
    #[must_use]
    pub fn access_arc(&self) -> Option<Arc<MemberAccess>> {
        self.access.clone().map(Arc::new)
    }
}

/// `@Auth() auth: AuthInfo`. Fails closed with 401 on a route the guard did not authenticate (a
/// public one); use `Option<Auth>` there.
#[derive(Clone, Debug)]
pub struct Auth(pub Arc<AuthInfo>);

impl Deref for Auth {
    type Target = AuthInfo;
    fn deref(&self) -> &AuthInfo {
        &self.0
    }
}

fn unauthenticated() -> AppError {
    AppError::new(axum::http::StatusCode::UNAUTHORIZED, crate::guard::AUTH_REQUIRED)
}

impl<S: Send + Sync> FromRequestParts<S> for Auth {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut Parts,
        _: &S,
    ) -> impl Future<Output = Result<Self, AppError>> + Send {
        let auth = parts.extensions.get::<Arc<AuthInfo>>().cloned().map(Auth);
        std::future::ready(auth.ok_or_else(unauthenticated))
    }
}

impl<S: Send + Sync> OptionalFromRequestParts<S> for Auth {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _: &S,
    ) -> impl Future<Output = Result<Option<Self>, Self::Rejection>> + Send {
        std::future::ready(Ok(parts.extensions.get::<Arc<AuthInfo>>().cloned().map(Auth)))
    }
}

/// `@Ctx() ctx: WorkspaceContext`, on routes whose path has a `{slug}` segment. Anywhere else it
/// is a programming error and answers 500.
#[derive(Clone, Debug)]
pub struct Ctx(pub Arc<WorkspaceContext>);

impl Deref for Ctx {
    type Target = WorkspaceContext;
    fn deref(&self) -> &WorkspaceContext {
        &self.0
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Ctx {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut Parts,
        _: &S,
    ) -> impl Future<Output = Result<Self, AppError>> + Send {
        let ctx =
            parts.extensions.get::<Arc<WorkspaceContext>>().cloned().map(Ctx).ok_or_else(|| {
                AppError::internal(format!("no workspace context on {}", parts.uri.path()))
            });
        std::future::ready(ctx)
    }
}

/// `@Actor() actor: ActorRef`: the workspace context's actor, else the authenticated one.
#[derive(Clone, Debug)]
pub struct Actor(pub ActorRef);

impl<S: Send + Sync> FromRequestParts<S> for Actor {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut Parts,
        _: &S,
    ) -> impl Future<Output = Result<Self, AppError>> + Send {
        let from_ctx = parts.extensions.get::<Arc<WorkspaceContext>>().map(|c| c.actor.clone());
        let actor = from_ctx
            .or_else(|| parts.extensions.get::<Arc<AuthInfo>>().map(|a| a.actor.clone()))
            .map(Self)
            .ok_or_else(unauthenticated);
        std::future::ready(actor)
    }
}
