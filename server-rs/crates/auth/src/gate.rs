//! Route gates and the gated route table: the Rust form of the NestJS metadata decorators
//! (`@Public`, `@Roles`, `@Can`, `@AllowCustomToken`, `@SessionOnly`, `@RequireUser`,
//! `@Multipart`, `@NoGuests`).
//!
//! A module registers every handler through [`Routes`], and every registration names its
//! [`Gate`]: there is no way to add a handler without one. The guard (see [`crate::guard`])
//! reads the gate of the matched route before the handler runs.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::handler::Handler;
use axum::http::Method;
use axum::routing::{MethodFilter, MethodRouter, on};
use trama_contracts::access::MemberGrant;
use trama_contracts::roles::{ApiPermission, Capability, LegacyRole};
use trama_core::AppState;

use crate::member_access::required_member_grant;
use crate::permissions::{is_upload_bytes_route, nest_pattern, required_permission};

/// What a route requires, checked by the guard in the order of `AccessGuard.canActivate`.
///
/// Build it with the `const` constructors, chaining modifiers; a controller-wide gate is a
/// `const` the handlers extend:
///
/// ```
/// use trama_auth::Gate;
/// use trama_contracts::roles::{Capability, LegacyRole};
///
/// // `@Roles('admin')` on the controller
/// const ADMIN: Gate = Gate::authenticated().roles(LegacyRole::Admin);
/// // `@Can(Capability.ManageAgents)` on one handler of it
/// const MANAGE_AGENTS: Gate = ADMIN.can(Capability::ManageAgents);
/// assert!(!MANAGE_AGENTS.is_public());
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// one flag per NestJS decorator
#[allow(clippy::struct_excessive_bools)]
pub struct Gate {
    pub(crate) public: bool,
    pub(crate) min: Option<LegacyRole>,
    pub(crate) capability: Option<Capability>,
    pub(crate) allow_custom_token: bool,
    pub(crate) session_only: bool,
    pub(crate) require_user: bool,
    pub(crate) multipart: bool,
    pub(crate) no_guests: bool,
}

impl Default for Gate {
    fn default() -> Self {
        Self::authenticated()
    }
}

impl Gate {
    /// The default of every NestJS route: authenticated; on `/w/{slug}` routes the caller must
    /// be a member with the `viewer` gate for GET/HEAD and the `member` gate for writes.
    #[must_use]
    pub const fn authenticated() -> Self {
        Self {
            public: false,
            min: None,
            capability: None,
            allow_custom_token: false,
            session_only: false,
            require_user: false,
            multipart: false,
            no_guests: false,
        }
    }

    /// `@Public()`: no authentication (login, sign-up, health, webhooks). A mutating request
    /// with a body must still be JSON.
    #[must_use]
    pub const fn public() -> Self {
        Self { public: true, ..Self::authenticated() }
    }

    /// `@Roles(min)`: the gate of the old rank `min` instead of the viewer / member default.
    /// There is no ladder: `owner` needs the owner role, `admin` an admin capability, `member`
    /// a role that can write (or the member grant the route needs), `viewer` any role.
    #[must_use]
    pub const fn roles(self, min: LegacyRole) -> Self {
        Self { min: Some(min), ..self }
    }

    /// `@Can(capability)`: the role must hold this capability (Settings → Roles & permissions);
    /// the rank gate and member grants do not apply.
    #[must_use]
    pub const fn can(self, capability: Capability) -> Self {
        Self { capability: Some(capability), ..self }
    }

    /// `@AllowCustomToken()`: a GET outside the permission catalog (`GET /auth/token`) that
    /// `custom` tokens may still call.
    #[must_use]
    pub const fn allow_custom_token(self) -> Self {
        Self { allow_custom_token: true, ..self }
    }

    /// `@SessionOnly()`: an account-level route (create a workspace, accept an invite, personal
    /// settings) that refuses every API token.
    #[must_use]
    pub const fn session_only(self) -> Self {
        Self { session_only: true, ..self }
    }

    /// `@RequireUser()`: refuses agent tokens; the route needs a person.
    #[must_use]
    pub const fn require_user(self) -> Self {
        Self { require_user: true, ..self }
    }

    /// `@Multipart()`: a cookie session may send `multipart/form-data` here (the CSRF header is
    /// still required).
    #[must_use]
    pub const fn multipart(self) -> Self {
        Self { multipart: true, ..self }
    }

    /// `@NoGuests()`: 403 `Guests cannot do that` for the guest role, whatever else allows.
    #[must_use]
    pub const fn no_guests(self) -> Self {
        Self { no_guests: true, ..self }
    }

    /// `@Public()`?
    #[must_use]
    pub const fn is_public(&self) -> bool {
        self.public
    }

    /// The `@Roles` rank, if any.
    #[must_use]
    pub const fn min_role(&self) -> Option<LegacyRole> {
        self.min
    }

    /// The `@Can` capability, if any.
    #[must_use]
    pub const fn capability(&self) -> Option<Capability> {
        self.capability
    }
}

/// A registered route with what the guard derives from its pattern once, at startup.
#[derive(Clone, Debug)]
pub(crate) struct RouteEntry {
    pub(crate) gate: Gate,
    /// Derived from the full pattern in NestJS form (`/api/w/:slug/tasks/:idOrKey`).
    pub(crate) permission: Option<ApiPermission>,
    pub(crate) upload_bytes: bool,
    pub(crate) member_grant: Option<MemberGrant>,
}

impl RouteEntry {
    pub(crate) fn new(method: &Method, axum_path: &str, gate: Gate) -> Self {
        let pattern = format!("/api{}", nest_pattern(axum_path));
        Self {
            gate,
            permission: required_permission(method.as_str(), &pattern),
            upload_bytes: is_upload_bytes_route(&pattern),
            member_grant: required_member_grant(method.as_str(), &pattern),
        }
    }
}

/// `(method, axum path relative to /api)` → entry.
pub(crate) type RouteTable = HashMap<(Method, String), Arc<RouteEntry>>;

/// A module's routes, each with its [`Gate`]. Paths are relative to `/api` and use axum's
/// `{param}` syntax (`/w/{slug}/tasks/{idOrKey}`); the workspace segment must be named `slug`.
///
/// ```
/// use axum::Json;
/// use trama_auth::{Auth, Gate, Routes};
///
/// async fn me(auth: Auth) -> Json<String> {
///     Json(auth.actor.id.clone().unwrap_or_default())
/// }
///
/// pub fn router() -> Routes {
///     Routes::new().get("/example/me", Gate::authenticated().require_user(), me)
/// }
/// # let _ = router();
/// ```
#[derive(Default)]
#[must_use]
pub struct Routes {
    router: Router<AppState>,
    table: RouteTable,
}

impl std::fmt::Debug for Routes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut routes: Vec<String> = self.table.keys().map(|(m, p)| format!("{m} {p}")).collect();
        routes.sort();
        f.debug_struct("Routes").field("routes", &routes).finish_non_exhaustive()
    }
}

impl Routes {
    /// No routes.
    pub fn new() -> Self {
        Self::default()
    }

    /// `handler` for `method` on `path`, behind `gate`.
    ///
    /// # Panics
    ///
    /// When `method` on `path` is already registered.
    pub fn route<H, T>(self, method: Method, path: &str, gate: Gate, handler: H) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        self.route_with(method, path, gate, handler, |r| r)
    }

    /// [`Routes::route`] with a hook to layer the method router (for example a larger
    /// `DefaultBodyLimit` on an upload). The hook must not add methods: a method not
    /// registered through `Routes` answers 404 before reaching it.
    ///
    /// # Panics
    ///
    /// When `method` on `path` is already registered.
    pub fn route_with<H, T>(
        mut self,
        method: Method,
        path: &str,
        gate: Gate,
        handler: H,
        customize: impl FnOnce(MethodRouter<AppState>) -> MethodRouter<AppState>,
    ) -> Self
    where
        H: Handler<T, AppState>,
        T: 'static,
    {
        let filter = MethodFilter::try_from(method.clone())
            .unwrap_or_else(|_| panic!("unsupported method {method} for {path}"));
        let entry = Arc::new(RouteEntry::new(&method, path, gate));
        let key = (method, path.to_owned());
        assert!(!self.table.contains_key(&key), "route {} {} registered twice", key.0, key.1);
        self.table.insert(key, entry);
        self.router = self.router.route(path, customize(on(filter, handler)));
        self
    }

    /// GET (and HEAD) `path`.
    pub fn get<H: Handler<T, AppState>, T: 'static>(
        self,
        path: &str,
        gate: Gate,
        handler: H,
    ) -> Self {
        self.route(Method::GET, path, gate, handler)
    }

    /// POST `path`.
    pub fn post<H: Handler<T, AppState>, T: 'static>(
        self,
        path: &str,
        gate: Gate,
        handler: H,
    ) -> Self {
        self.route(Method::POST, path, gate, handler)
    }

    /// PUT `path`.
    pub fn put<H: Handler<T, AppState>, T: 'static>(
        self,
        path: &str,
        gate: Gate,
        handler: H,
    ) -> Self {
        self.route(Method::PUT, path, gate, handler)
    }

    /// PATCH `path`.
    pub fn patch<H: Handler<T, AppState>, T: 'static>(
        self,
        path: &str,
        gate: Gate,
        handler: H,
    ) -> Self {
        self.route(Method::PATCH, path, gate, handler)
    }

    /// DELETE `path`.
    pub fn delete<H: Handler<T, AppState>, T: 'static>(
        self,
        path: &str,
        gate: Gate,
        handler: H,
    ) -> Self {
        self.route(Method::DELETE, path, gate, handler)
    }

    /// Both route sets.
    ///
    /// # Panics
    ///
    /// When both register the same method on the same path.
    pub fn merge(mut self, other: Self) -> Self {
        for key in other.table.keys() {
            assert!(!self.table.contains_key(key), "route {} {} registered twice", key.0, key.1);
        }
        self.table.extend(other.table);
        self.router = self.router.merge(other.router);
        self
    }

    /// The gate of `method` on `path`, if registered.
    #[must_use]
    pub fn gate_of(&self, method: &Method, path: &str) -> Option<Gate> {
        self.table.get(&(method.clone(), path.to_owned())).map(|e| e.gate)
    }

    /// Every registered `(method, path)`, sorted.
    #[must_use]
    pub fn routes(&self) -> Vec<(Method, String)> {
        let mut out: Vec<(Method, String)> = self.table.keys().cloned().collect();
        out.sort_by(|a, b| (a.1.as_str(), a.0.as_str()).cmp(&(b.1.as_str(), b.0.as_str())));
        out
    }

    /// The router with the access guard in front of every route, ready to nest under `/api`.
    pub fn into_router(self, state: &AppState) -> Router<AppState> {
        crate::guard::install(self.router, self.table, state.clone())
    }

    /// [`Routes::into_router`] nested under `/api` with the state applied: the shape tests
    /// send requests to.
    pub fn into_app(self, state: AppState) -> Router {
        Router::new().nest("/api", self.into_router(&state)).with_state(state)
    }
}
