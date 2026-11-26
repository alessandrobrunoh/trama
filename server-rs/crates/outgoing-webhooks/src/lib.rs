//! Custom integrations of the Trama API: the port of `server/src/outgoing-webhooks`.
//!
//! A workspace can register up to 20 URLs; Trama then POSTs a signed JSON body to each one for
//! every domain event it subscribes to (`*`, `issue.*`, `issue.created`).
//!
//! # Routes
//!
//! All need the `manageIntegrations` capability.
//!
//! | Route | Notes |
//! | --- | --- |
//! | `GET /api/w/{slug}/outgoing-webhooks` | oldest first, never with the secret |
//! | `POST /api/w/{slug}/outgoing-webhooks` | 201 `{ webhook, secret }`; the secret is shown once; 409 past 20 |
//! | `GET`, `PATCH`, `DELETE /api/w/{slug}/outgoing-webhooks/{id}` | `DELETE` answers 204 |
//! | `POST …/{id}/rotate-secret` | 200 `{ webhook, secret }`; the old secret stops working |
//! | `POST …/{id}/test` | 200 with the delivery of a `ping` (even when disabled, never retried) |
//! | `GET …/{id}/deliveries` | `?limit=` 1 to 50 (default 20), newest first |
//!
//! # Deliveries
//!
//! [`delivery`] listens to `trama_events`' recorded stream. A delivery is a `POST` with
//! `X-Trama-Event`, `X-Trama-Delivery` and `X-Trama-Signature: sha256=<hmac of the body>` (and
//! the pre-rename `X-Nabla-*` twins), a 5 s deadline and one retry after `TRAMA_WEBHOOK_RETRY_MS`
//! for network errors, timeouts, 429 and 5xx. The deliveries of one webhook are sent in order.
//! Requests go through [`trama_integrations::Http`]; tests register a fake with
//! `state.with_extension(Http::new(fake))`.
//!
//! # Starting it
//!
//! `trama-api` registers the dispatcher and starts the listener once at startup:
//!
//! ```no_run
//! # async fn demo(state: trama_core::AppState) {
//! let state = trama_outgoing_webhooks::with_services(state);
//! let listener = trama_outgoing_webhooks::spawn(&state);
//! // ... serve; on shutdown:
//! listener.abort();
//! # }
//! ```
//!
//! # Public API for other crates
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `OutgoingWebhooksService.list/get/create/update/rotateSecret/remove/recentDeliveries/ping` | [`service`]`::{list, get, create, update, rotate_secret, remove, recent_deliveries, ping}` |
//! | `invalidate`, `idle` | [`Dispatcher::invalidate`], [`Dispatcher::idle`] |
//! | `signBody`, `verifySignature` | [`signature::sign_body`], [`signature::verify_signature`] |

pub mod delivery;
pub mod router;
pub mod schemas;
pub mod service;
pub mod signature;

pub use delivery::{DeliveryPayload, Dispatcher, spawn};
pub use router::{ApiDoc, router};

use trama_core::AppState;

/// Registers the process-wide [`Dispatcher`] on `state`.
#[must_use]
pub fn with_services(state: AppState) -> AppState {
    state.with_extension(Dispatcher::default())
}
