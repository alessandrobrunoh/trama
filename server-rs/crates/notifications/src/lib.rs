//! Notifications of the Trama API: the port of `server/src/notifications`.
//!
//! * [`router`]: `GET /api/w/:slug/notifications`, `POST /api/w/:slug/notifications/read`, the
//!   per-person settings (`/api/me/notification-settings`) and Web Push registration
//!   (`/api/me/push`);
//! * [`rules`] (`notification-rules.ts`): who hears about a domain event, and what they are told;
//! * [`delivery`] (the producing half of `NotificationsService`): listens to recorded domain
//!   events and delivers each message to the person's inbox, devices and mailbox as their
//!   settings ask;
//! * [`push`] and [`webpush`] (`PushService`, the `web-push` package): VAPID keys from
//!   configuration, subscriptions, encryption and the request to the push service, through the
//!   SSRF guard of `trama-common`;
//! * [`service`]: reading, marking read and the settings, for other crates.
//!
//! # Starting it
//!
//! Notifications are produced from `trama-events`' recorded stream, as NestJS does with
//! `recorded$`, so nothing else has to call this crate when it records an event. `trama-api`
//! registers the services and starts the listener once at startup:
//!
//! ```no_run
//! # async fn demo(state: trama_core::AppState) {
//! let state = trama_notifications::with_services(state);
//! let listener = trama_notifications::spawn(&state);
//! // ... serve; on shutdown:
//! listener.abort();
//! # }
//! ```
//!
//! Tests build the state themselves, register a fake push transport with
//! [`push::PushService::with_transport`] and a capturing `Mailer`, and call [`spawn`].

pub mod delivery;
pub mod push;
pub mod router;
pub mod rules;
pub mod schemas;
pub mod service;
pub mod validation;
pub mod webpush;

pub use delivery::spawn;
pub use push::{PushMessage, PushService};
pub use router::{ApiDoc, router};

use trama_core::AppState;

/// Registers the process-wide [`PushService`] (one VAPID key set, read once from the
/// configuration) on `state`.
#[must_use]
pub fn with_services(state: AppState) -> AppState {
    let push = PushService::from_config(&state.config);
    state.with_extension(push)
}
