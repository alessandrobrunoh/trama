//! Domain events and live events of the Trama API: the port of `server/src/events`.
//!
//! * [`Events`] (`EventsService`): appends `DomainEvent`s ([`Events::record`]) and broadcasts
//!   `LiveEvent`s ([`Events::publish`]) to every API instance through Postgres;
//! * [`visibility`] (`EventVisibilityService`): the project boundary for history, snapshots and
//!   live events;
//! * [`stream_auth`] (`StreamAuthService`, `closeWhenInvalid`): re-checks an open stream;
//! * [`router`]: `GET /api/w/:slug/events` and the SSE stream `GET /api/w/:slug/events/stream`.
//!
//! # Getting the service
//!
//! `trama-api` builds one [`Events::start`] at startup and registers it on the `AppState`.
//! Anywhere with the state, take it with [`Events::of`]; it is cheap to clone. Without a
//! registered instance (tests that build a bare state) `of` returns one shared process-local
//! instance, so a test still sees its own events.
//!
//! # Recording a domain event
//!
//! Pass the connection to write with: the transaction (`&txn`) to write atomically with the
//! mutation, else `&state.db`. The live event goes out right after the insert (NestJS does not
//! wait for the commit either).
//!
//! ```no_run
//! # async fn demo(state: trama_core::AppState, actor: trama_contracts::ActorRef) -> Result<(), sea_orm::DbErr> {
//! use serde_json::json;
//! use trama_contracts::common::{SubjectRef, SubjectType};
//! use trama_contracts::activity::LiveEventEntity;
//! use trama_events::{Events, LiveChange, RecordEvent};
//!
//! let events = Events::of(&state);
//! let subject = SubjectRef { kind: SubjectType::Issue, id: "in_1".into() };
//!
//! // `<x>.created` → live `created`, `<x>.deleted` → `deleted`, anything else → `updated`
//! events.record(&state.db, RecordEvent::new("ws_1", actor.clone(), "issue.created", subject.clone())
//!     .data(json!({ "title": "Crash" }))).await?;
//! // only persist (`live: false`)
//! events.record(&state.db, RecordEvent::new("ws_1", actor.clone(), "issue.viewed", subject.clone())
//!     .without_live()).await?;
//! // a custom live event, still scoped by the subject (`{ type: 'created', entity: 'comment', id }`)
//! events.record(&state.db, RecordEvent::new("ws_1", actor, "comment.created", subject)
//!     .live(LiveChange::created(LiveEventEntity::Comment, "cm_1"))).await?;
//! # Ok(()) }
//! ```
//!
//! `RecordEvent::at` backdates an event (seed only); backdated events are not sent to
//! [`Events::subscribe_recorded`].
//!
//! # Publishing a live event
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `events.publish(ws, { type: 'updated', entity: 'workspace', id })` | `events.publish(ws, LiveChange::updated(LiveEventEntity::Workspace, id))` |
//! | `events.publish(ws, change, userId)` | `events.publish_to_user(ws, change, user_id)` |
//! | `events.publish(ws, change, undefined, row.subject)` | `events.publish_with(ws, change, None, Some(subject))` |
//!
//! `publish` returns at once (the `NOTIFY` goes out from a background worker, in order). It adds
//! the request's `X-Client-Id` from [`trama_common::client_id`]: call it inside the request, or
//! re-enter `trama_common::request_context::scope` in a spawned task.
//!
//! # Subscribing
//!
//! * [`Events::subscribe`] (`stream$`): every [`PublishedEvent`] of every workspace, after the
//!   Postgres round trip (so also those of other instances);
//! * [`Events::subscribe_recorded`] (`recorded$`): every `domain_events` row this instance
//!   wrote, for outgoing webhooks, notifications and two-way sync.
//!
//! Both are `tokio::sync::broadcast` receivers; a subscriber that falls more than
//! [`service::LIVE_CAPACITY`] / [`service::RECORDED_CAPACITY`] messages behind gets
//! `RecvError::Lagged` and should resynchronise.
//!
//! # Between instances
//!
//! Live events travel as JSON on the Postgres channel [`relay::LIVE_CHANNEL`] (`trama_live`),
//! byte-compatible with NestJS, so a NestJS and a Rust instance can share it. Each instance
//! keeps one `LISTEN` connection, reconnecting after 1 s, doubling to 30 s; while it is down,
//! events go to this instance's streams only. [`Events::shutdown`] stops it.

pub mod js_date;
pub mod relay;
pub mod router;
pub mod schemas;
pub mod service;
mod sse;
pub mod stream_auth;
pub mod visibility;

pub use router::{ApiDoc, router};
pub use service::{Events, Live, LiveChange, PublishedEvent, RecordEvent};
pub use sse::PING_EVERY;
