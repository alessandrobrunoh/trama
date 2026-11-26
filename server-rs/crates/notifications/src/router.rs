//! `NotificationsController`, `NotificationSettingsController` and `PushController`
//! (`server/src/notifications/notifications.controller.ts`), mounted under `/api`.

use axum::Json;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_common::Mailer;
use trama_contracts::identity::NotificationSettings;
use trama_contracts::roles::LegacyRole;
use trama_core::{ApiJson, AppError, AppState};
use trama_events::Events;
use utoipa::OpenApi;

use crate::push::{PushService, PushSubscriptionInput};
use crate::schemas::{
    ListQuery, MarkReadBody, NotificationListView, NotificationView, PushEnabled, PushEndpointBody,
    PushKeys, PushStatus, PushSubscriptionBody, SettingsView, UnreadCount, UpdateSettingsBody,
};
use crate::service::{self, ListOptions};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(list, read, get_settings, update_settings, push_status, subscribe, unsubscribe),
    components(schemas(
        NotificationListView,
        NotificationSettings,
        NotificationView,
        PushEnabled,
        PushEndpointBody,
        PushKeys,
        PushStatus,
        PushSubscriptionBody,
        SettingsView,
        UnreadCount,
        UpdateSettingsBody,
        MarkReadBody,
    ))
)]
pub struct ApiDoc;

/// `@RequireUser()` on `NotificationsController`: the caller's own notifications are personal,
/// so agent tokens get 403.
const PERSONAL: Gate = Gate::authenticated().require_user();

/// `@RequireUser() @SessionOnly()` on the settings and push controllers: personal to the
/// signed-in person, the same in every workspace, and never through an API token.
const ACCOUNT: Gate = Gate::authenticated().require_user().session_only();

/// Routes of this module.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/notifications", PERSONAL, list)
        .post("/w/{slug}/notifications/read", PERSONAL.roles(LegacyRole::Viewer), read)
        .get("/me/notification-settings", ACCOUNT, get_settings)
        .patch("/me/notification-settings", ACCOUNT, update_settings)
        .get("/me/push", ACCOUNT, push_status)
        .put("/me/push/subscription", ACCOUNT, subscribe)
        .delete("/me/push/subscription", ACCOUNT, unsubscribe)
}

/// The caller's id; routes behind `require_user` always have one.
fn user_id(auth: &Auth) -> Result<&str, AppError> {
    auth.require_user().map(|user| user.id.as_str())
}

/// The caller's notifications in this workspace, newest first, and how many are unread.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/notifications",
    tag = "notifications",
    params(("slug" = String, Path, description = "Workspace slug"), ListQuery),
    responses(
        (status = 200, description = "The page and the unread count", body = NotificationListView),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no notifications"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<NotificationListView>, AppError> {
    let q = ListQuery::parse(raw.as_deref())?;
    let user_id = ctx
        .user_id
        .as_deref()
        .ok_or_else(|| AppError::forbidden(trama_auth::guard::REQUIRE_USER))?;
    let page = service::list(
        &state.db,
        &ctx.workspace.id,
        user_id,
        ctx.access.as_ref(),
        ListOptions { limit: q.limit, unread_only: q.unread.unwrap_or(false) },
    )
    .await?;
    Ok(Json(page))
}

/// Marks some (or, without `ids`, all) of the caller's notifications as read.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/notifications/read",
    tag = "notifications",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = MarkReadBody,
    responses(
        (status = 200, description = "Unread notifications left", body = UnreadCount),
        (status = 400, description = "Invalid ids"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Agent tokens have no notifications"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn read(
    ctx: Ctx,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<MarkReadBody>,
) -> Result<Json<UnreadCount>, AppError> {
    let ids = body.ids()?;
    let user_id = ctx
        .user_id
        .as_deref()
        .ok_or_else(|| AppError::forbidden(trama_auth::guard::REQUIRE_USER))?;
    let unread = service::mark_read(
        &state.db,
        &Events::of(&state),
        &ctx.workspace.id,
        user_id,
        ids.as_deref(),
    )
    .await?;
    Ok(Json(UnreadCount { unread }))
}

/// The signed-in person's notification settings (the same in every workspace).
#[utoipa::path(
    get,
    path = "/api/me/notification-settings",
    tag = "notifications",
    responses(
        (status = 200, description = "Settings with the defaults applied", body = SettingsView),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Session only"),
    )
)]
async fn get_settings(
    auth: Auth,
    State(state): State<AppState>,
) -> Result<Json<SettingsView>, AppError> {
    let settings =
        service::get_settings(&state.db, Mailer::of(&state).enabled(), user_id(&auth)?).await?;
    Ok(Json(settings))
}

/// Switches channels of some kinds; what is not sent stays as it was.
#[utoipa::path(
    patch,
    path = "/api/me/notification-settings",
    tag = "notifications",
    request_body = UpdateSettingsBody,
    responses(
        (status = 200, description = "The settings after the change", body = SettingsView),
        (status = 400, description = "Unknown kind or channel, or a value that is not a boolean"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Session only"),
    )
)]
async fn update_settings(
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<UpdateSettingsBody>,
) -> Result<Json<SettingsView>, AppError> {
    let patch = body.patch()?;
    let settings =
        service::update_settings(&state.db, Mailer::of(&state).enabled(), user_id(&auth)?, &patch)
            .await?;
    Ok(Json(settings))
}

/// Whether Web Push is set up, and the public key the browser subscribes with.
#[utoipa::path(
    get,
    path = "/api/me/push",
    tag = "notifications",
    responses(
        (status = 200, description = "`publicKey` is null when the server has no VAPID keys", body = PushStatus),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Session only"),
    )
)]
async fn push_status(State(state): State<AppState>) -> Json<PushStatus> {
    let push = PushService::of(&state);
    Json(PushStatus {
        enabled: push.enabled(),
        public_key: push.application_server_key().map(ToOwned::to_owned),
    })
}

/// Registers this device. Idempotent per endpoint.
#[utoipa::path(
    put,
    path = "/api/me/push/subscription",
    tag = "notifications",
    request_body = PushSubscriptionBody,
    responses(
        (status = 200, description = "Registered", body = PushEnabled),
        (status = 400, description = "Push is not set up, or the subscription is invalid"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Session only"),
    )
)]
async fn subscribe(
    auth: Auth,
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<PushSubscriptionBody>,
) -> Result<Json<PushEnabled>, AppError> {
    let parts = body.validate()?;
    let push = PushService::of(&state);
    if !push.enabled() {
        return Err(AppError::bad_request("Push notifications are not set up on this server"));
    }
    let (Some(p256dh), Some(auth_secret)) = (parts.p256dh, parts.auth) else {
        return Err(AppError::bad_request("keys.p256dh and keys.auth are required"));
    };
    // the header as Node reads it: bytes as Latin-1
    let user_agent = headers
        .get(header::USER_AGENT)
        .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect::<String>());
    push.subscribe(
        &state.db,
        user_id(&auth)?,
        PushSubscriptionInput { endpoint: parts.endpoint, p256dh, auth: auth_secret, user_agent },
    )
    .await?;
    Ok(Json(PushEnabled { enabled: true }))
}

/// Forgets this device. Unknown endpoints are fine.
#[utoipa::path(
    delete,
    path = "/api/me/push/subscription",
    tag = "notifications",
    request_body = PushEndpointBody,
    responses(
        (status = 204, description = "Forgotten"),
        (status = 400, description = "Invalid endpoint"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "Session only"),
    )
)]
async fn unsubscribe(
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<PushEndpointBody>,
) -> Result<StatusCode, AppError> {
    let endpoint = body.endpoint()?;
    PushService::of(&state).unsubscribe(&state.db, user_id(&auth)?, &endpoint).await?;
    Ok(StatusCode::NO_CONTENT)
}
