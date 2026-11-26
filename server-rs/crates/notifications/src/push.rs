//! `PushService` (`push.service.ts`): Web Push to a person's devices.
//!
//! Enabled by `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (generate with `npx web-push
//! generate-vapid-keys`) and optionally `VAPID_SUBJECT` (a `mailto:` or https URL). Without keys
//! nothing is sent and the UI hides the device switch.
//!
//! Get the process's service with [`PushService::of`]. The HTTP request to the push service goes
//! through a [`WebPushTransport`]: [`HttpTransport`] (the SSRF guard of `trama-common`) in
//! production, a fake in tests ([`PushService::with_transport`]).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::future::join_all;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, Set};
use serde_json::json;
use trama_common::safe_fetch::{OutboundPolicy, Resolver, SafeRequest, SystemResolver};
use trama_core::AppState;
use trama_core::ids::uid;
use trama_entities::push_subscriptions;
use url::Url;

use crate::webpush::{self, Vapid};

/// How long a push service keeps an undelivered message (`TTL_SECONDS`, 24 h).
pub const TTL_SECONDS: u32 = 24 * 60 * 60;
/// How long a push request may take (`SEND_TIMEOUT_MS`).
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest `User-Agent` kept with a subscription.
const MAX_USER_AGENT: usize = 300;

/// What the browser needs to show a notification and open the right page on click.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushMessage {
    /// Headline.
    pub title: String,
    /// Body text.
    pub body: Option<String>,
    /// Path inside the web app, e.g. `/acme/tasks/CORA-12`.
    pub path: String,
    /// Same tag replaces the previous notification instead of stacking.
    pub tag: Option<String>,
}

/// A device registration as the browser sends it (`PushSubscriptionInput`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushSubscriptionInput {
    /// The push service URL.
    pub endpoint: String,
    /// The browser's public key.
    pub p256dh: String,
    /// The browser's auth secret.
    pub auth: String,
    /// The browser's `User-Agent`.
    pub user_agent: Option<String>,
}

/// Why a push endpoint must not be stored or contacted (SSRF guard: https, no internal
/// addresses), or `None` (`pushEndpointProblem`).
pub async fn push_endpoint_problem(endpoint: &str, policy: &OutboundPolicy) -> Option<String> {
    push_endpoint_problem_with(endpoint, policy, Some(&SystemResolver)).await
}

/// [`push_endpoint_problem`] with a chosen resolver; `None` skips name resolution.
pub async fn push_endpoint_problem_with(
    endpoint: &str,
    policy: &OutboundPolicy,
    resolver: Option<&dyn Resolver>,
) -> Option<String> {
    let https = OutboundPolicy { require_https: true, ..policy.clone() };
    if let Some(problem) =
        trama_common::safe_fetch::outbound_url_problem_with(endpoint, &https, resolver).await
    {
        return Some(problem);
    }
    match Url::parse(endpoint) {
        Ok(url) if url.scheme() == "https" => None,
        _ => Some("url must use https://".to_owned()),
    }
}

/// The JSON a `push` event carries. Angular's service worker (`ngsw-worker.js`) shows a payload
/// shaped `{ notification: {…} }` and, on click, runs `data.onActionClick.default`: focus an open
/// tab on the path or open a new one (`pushPayload`).
#[must_use]
pub fn push_payload(message: &PushMessage) -> String {
    let mut notification = serde_json::Map::new();
    notification.insert("title".to_owned(), json!(message.title));
    if let Some(body) = message.body.as_ref().filter(|b| !b.is_empty()) {
        notification.insert("body".to_owned(), json!(body));
    }
    notification.insert("icon".to_owned(), json!("/icons/icon-192x192.png"));
    if let Some(tag) = message.tag.as_ref().filter(|t| !t.is_empty()) {
        notification.insert("tag".to_owned(), json!(tag));
    }
    notification.insert(
        "data".to_owned(),
        json!({ "onActionClick": { "default": {
            "operation": "navigateLastFocusedOrOpen",
            "url": message.path,
        } } }),
    );
    json!({ "notification": notification }).to_string()
}

/// One request to a push service (`webpush.sendNotification`'s arguments).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushRequest {
    /// The normalized endpoint href.
    pub endpoint: String,
    /// The browser's public key.
    pub p256dh: String,
    /// The browser's auth secret.
    pub auth: String,
    /// The JSON payload, not yet encrypted.
    pub payload: String,
    /// `TTL` in seconds.
    pub ttl: u32,
    /// Whole-request deadline.
    pub timeout: Duration,
}

/// A push that did not go through (`WebPushError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushError {
    /// The push service's status, when it answered.
    pub status: Option<u16>,
    /// What went wrong.
    pub message: String,
}

/// The boxed future of [`WebPushTransport::send`].
pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), PushError>> + Send + 'a>>;

/// Delivers one push (`webpush.sendNotification`). Tests plug in a fake.
pub trait WebPushTransport: Send + Sync + 'static {
    /// Sends `request`; any 2xx answer is success.
    fn send(&self, request: PushRequest) -> SendFuture<'_>;
}

/// The real transport: VAPID, `aes128gcm` and a POST through `trama-common`'s SSRF guard (only
/// vetted public addresses; a stored endpoint may have started pointing inward since it was
/// saved).
pub struct HttpTransport {
    vapid: Vapid,
    policy: OutboundPolicy,
}

impl HttpTransport {
    /// A transport signing with `vapid`.
    #[must_use]
    pub fn new(vapid: Vapid, policy: &OutboundPolicy) -> Self {
        Self { vapid, policy: OutboundPolicy { require_https: true, ..policy.clone() } }
    }
}

impl WebPushTransport for HttpTransport {
    fn send(&self, request: PushRequest) -> SendFuture<'_> {
        Box::pin(async move {
            let local = |message: String| PushError { status: None, message };
            let url = Url::parse(&request.endpoint).map_err(|e| local(e.to_string()))?;
            let audience = url.origin().ascii_serialization();
            let authorization = self.vapid.authorization(&audience).map_err(local)?;
            let body = webpush::encrypt(&request.p256dh, &request.auth, request.payload.as_bytes())
                .map_err(local)?;
            let res = SafeRequest::post(url.as_str())
                .header("TTL", request.ttl.to_string())
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .header("Authorization", authorization)
                .header("Urgency", "normal")
                .body(body)
                .timeout(request.timeout)
                .max_bytes(64 * 1024)
                .truncate()
                .send(&self.policy)
                .await
                .map_err(|e| local(e.to_string()))?;
            if (200..300).contains(&res.status) {
                Ok(())
            } else {
                Err(PushError {
                    status: Some(res.status),
                    message: "Received unexpected response code".to_owned(),
                })
            }
        })
    }
}

/// Web Push to a person's devices. Cheap to clone.
#[derive(Clone)]
pub struct PushService {
    public_key: Option<String>,
    transport: Option<Arc<dyn WebPushTransport>>,
    policy: OutboundPolicy,
}

impl std::fmt::Debug for PushService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushService").field("enabled", &self.enabled()).finish_non_exhaustive()
    }
}

impl PushService {
    /// The service the configuration describes. Without both VAPID keys it is off; an unusable
    /// key or subject is logged and turns it off too. Registered on the state at startup by
    /// [`crate::with_services`].
    #[must_use]
    pub fn from_config(config: &trama_core::Config) -> Self {
        let push = &config.push;
        let off = |policy: &OutboundPolicy| Self {
            public_key: None,
            transport: None,
            policy: policy.clone(),
        };
        let (Some(public), Some(private)) = (&push.vapid_public_key, &push.vapid_private_key)
        else {
            static LOGGED: AtomicBool = AtomicBool::new(false);
            if !LOGGED.swap(true, Ordering::Relaxed) {
                tracing::info!(
                    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set: push notifications are not sent"
                );
            }
            return off(&config.outbound);
        };
        match Vapid::new(&push.vapid_subject, public, private.expose()) {
            Ok(vapid) => Self {
                public_key: Some(public.clone()),
                transport: Some(Arc::new(HttpTransport::new(vapid, &config.outbound))),
                policy: config.outbound.clone(),
            },
            Err(e) => {
                tracing::warn!("Invalid VAPID configuration, push is off: {e}");
                off(&config.outbound)
            }
        }
    }

    /// The service registered on `state` at startup, else one built from its configuration.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state.extension::<Self>().cloned().unwrap_or_else(|| Self::from_config(&state.config))
    }

    /// The same service delivering through `transport` instead of HTTP (tests). Only an enabled
    /// service (valid VAPID keys in the configuration) sends.
    #[must_use]
    pub fn with_transport(mut self, transport: Arc<dyn WebPushTransport>) -> Self {
        if self.enabled() {
            self.transport = Some(transport);
        }
        self
    }

    /// Whether VAPID keys are set and valid.
    #[must_use]
    pub fn enabled(&self) -> bool {
        self.public_key.is_some()
    }

    /// Public key the browser subscribes with; `None` when push is off.
    #[must_use]
    pub fn application_server_key(&self) -> Option<&str> {
        self.public_key.as_deref()
    }

    /// Every device of the person.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list(
        &self,
        db: &DatabaseConnection,
        user_id: &str,
    ) -> Result<Vec<push_subscriptions::Model>, DbErr> {
        push_subscriptions::Entity::find()
            .filter(push_subscriptions::Column::UserId.eq(user_id))
            .order_by_asc(push_subscriptions::Column::CreatedAt)
            .all(db)
            .await
    }

    /// Registers a device. Idempotent per endpoint; a device that moves to another account is
    /// re-pointed to it.
    ///
    /// # Errors
    ///
    /// 400 `Invalid push endpoint: …` for an endpoint that is not a public https URL; database
    /// errors.
    pub async fn subscribe(
        &self,
        db: &DatabaseConnection,
        user_id: &str,
        input: PushSubscriptionInput,
    ) -> Result<(), trama_core::AppError> {
        if let Some(problem) = push_endpoint_problem(&input.endpoint, &self.policy).await {
            return Err(trama_core::AppError::bad_request(format!(
                "Invalid push endpoint: {problem}"
            )));
        }
        let user_agent = input.user_agent.map(|ua| ua.chars().take(MAX_USER_AGENT).collect());
        let row = push_subscriptions::ActiveModel {
            id: Set(uid("psh")),
            user_id: Set(user_id.to_owned()),
            endpoint: Set(input.endpoint),
            p256dh: Set(input.p256dh),
            auth: Set(input.auth),
            user_agent: Set(user_agent),
            ..Default::default()
        };
        push_subscriptions::Entity::insert(row)
            .on_conflict(
                OnConflict::column(push_subscriptions::Column::Endpoint)
                    .update_columns([
                        push_subscriptions::Column::UserId,
                        push_subscriptions::Column::P256dh,
                        push_subscriptions::Column::Auth,
                        push_subscriptions::Column::UserAgent,
                    ])
                    .to_owned(),
            )
            .exec_without_returning(db)
            .await?;
        Ok(())
    }

    /// Forgets a device. Only the owner can remove a subscription; unknown endpoints are fine.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn unsubscribe(
        &self,
        db: &DatabaseConnection,
        user_id: &str,
        endpoint: &str,
    ) -> Result<(), DbErr> {
        push_subscriptions::Entity::delete_many()
            .filter(push_subscriptions::Column::UserId.eq(user_id))
            .filter(push_subscriptions::Column::Endpoint.eq(endpoint))
            .exec(db)
            .await?;
        Ok(())
    }

    /// Sends to every device of the person. Returns how many accepted it; dead subscriptions
    /// (the push service answered 404 or 410) are removed.
    ///
    /// # Errors
    ///
    /// Database errors reading the subscriptions.
    pub async fn send(
        &self,
        db: &DatabaseConnection,
        user_id: &str,
        message: &PushMessage,
    ) -> Result<usize, DbErr> {
        let Some(transport) = self.transport.as_ref().filter(|_| self.enabled()) else {
            return Ok(0);
        };
        let subs = self.list(db, user_id).await?;
        if subs.is_empty() {
            return Ok(0);
        }
        let payload = push_payload(message);
        let delivered = join_all(
            subs.iter()
                .map(|sub| async { self.send_one(db, transport.as_ref(), sub, &payload).await }),
        )
        .await;
        Ok(delivered.into_iter().filter(|ok| *ok).count())
    }

    async fn send_one(
        &self,
        db: &DatabaseConnection,
        transport: &dyn WebPushTransport,
        sub: &push_subscriptions::Model,
        payload: &str,
    ) -> bool {
        let host = Url::parse(&sub.endpoint)
            .ok()
            .and_then(|u| u.host_str().map(ToOwned::to_owned))
            .unwrap_or_default();
        if let Some(problem) = push_endpoint_problem(&sub.endpoint, &self.policy).await {
            tracing::warn!("Push to {host} failed: {problem}");
            return false;
        }
        let Ok(url) = Url::parse(&sub.endpoint) else { return false };
        // the normalized href, so numeric host spellings (0x7f.1) reach the guard as the address
        // they are
        let request = PushRequest {
            endpoint: url.to_string(),
            p256dh: sub.p256dh.clone(),
            auth: sub.auth.clone(),
            payload: payload.to_owned(),
            ttl: TTL_SECONDS,
            timeout: SEND_TIMEOUT,
        };
        match transport.send(request).await {
            Ok(()) => true,
            Err(e) => {
                if matches!(e.status, Some(404 | 410)) {
                    // the browser dropped it (uninstalled, permission revoked): forget it
                    if let Err(db_err) =
                        push_subscriptions::Entity::delete_by_id(sub.id.clone()).exec(db).await
                    {
                        tracing::warn!("Push to {host} failed: {db_err}");
                    }
                } else {
                    tracing::warn!("Push to {host} failed: {}", e.message);
                }
                false
            }
        }
    }
}

impl std::error::Error for PushError {}

impl std::fmt::Display for PushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use trama_common::safe_fetch::OutboundPolicy;

    use super::*;

    fn policy() -> OutboundPolicy {
        OutboundPolicy::default()
    }

    #[tokio::test]
    async fn rejects_internal_and_insecure_endpoints() {
        for endpoint in [
            "https://10.0.0.5:8443/x",
            "https://127.0.0.1/x",
            "https://localhost/x",
            "https://169.254.169.254/x",
            "https://[::1]/x",
            "http://fcm.googleapis.com/x",
        ] {
            assert!(
                push_endpoint_problem_with(endpoint, &policy(), None).await.is_some(),
                "{endpoint}"
            );
        }
    }

    #[tokio::test]
    async fn accepts_a_public_https_push_service_address() {
        assert_eq!(
            push_endpoint_problem_with("https://8.8.8.8/push/abc", &policy(), None).await,
            None
        );
    }

    #[tokio::test]
    async fn an_allowed_host_still_needs_https() {
        let policy = OutboundPolicy {
            allowed_hosts: vec!["push.internal".to_owned()],
            ..OutboundPolicy::default()
        };
        assert_eq!(
            push_endpoint_problem_with("http://push.internal/x", &policy, None).await.as_deref(),
            Some("url must use https://")
        );
        assert_eq!(
            push_endpoint_problem_with("https://push.internal/x", &policy, None).await,
            None
        );
    }

    #[test]
    fn uses_the_shape_angulars_service_worker_shows_and_opens_the_page_on_click() {
        let payload = push_payload(&PushMessage {
            title: "Ana assigned you BUG-1".into(),
            body: Some("Login fails".into()),
            path: "/acme/issues/BUG-1".into(),
            tag: Some("assigned:in_1".into()),
        });
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let notification = &parsed["notification"];
        assert_eq!(notification["title"], "Ana assigned you BUG-1");
        assert_eq!(notification["body"], "Login fails");
        assert_eq!(notification["tag"], "assigned:in_1");
        assert_eq!(notification["icon"], "/icons/icon-192x192.png");
        assert_eq!(
            notification["data"]["onActionClick"]["default"],
            json!({ "operation": "navigateLastFocusedOrOpen", "url": "/acme/issues/BUG-1" })
        );
    }

    #[test]
    fn leaves_out_the_body_and_tag_when_there_are_none() {
        let payload = push_payload(&PushMessage {
            title: "Hello".into(),
            body: None,
            path: "/acme".into(),
            tag: None,
        });
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let notification = parsed["notification"].as_object().unwrap();
        assert!(!notification.contains_key("body"));
        assert!(!notification.contains_key("tag"));
    }

    #[test]
    fn push_is_off_without_usable_keys() {
        let config = trama_core::Config::from_vars(&[]);
        let service = PushService::from_config(&config);
        assert!(!service.enabled());
        assert_eq!(service.application_server_key(), None);

        let config = trama_core::Config::from_vars(&[
            ("VAPID_PUBLIC_KEY", "abcd"),
            ("VAPID_PRIVATE_KEY", "abcd"),
        ]);
        assert!(!PushService::from_config(&config).enabled());
    }
}
