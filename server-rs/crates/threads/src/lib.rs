//! Thread records, decisions and estimate suggestions: the port of `server/src/threads`.
//!
//! What the agent working in a task's thread keeps in Trama. One task links at most one Delta
//! thread; `trama sync` stores a read-only record of it (summary, files, turns), appends the
//! decisions the agent made, attaches the PR it opened and suggests the time it spent.
//!
//! # Routes
//!
//! | Route | Notes |
//! | --- | --- |
//! | `POST /api/w/{slug}/tasks/{idOrKey}/thread/sync` | 200; edits the task: links the thread, upserts the record, appends decisions, attaches the PR, suggests time |
//! | `GET /api/w/{slug}/tasks/{idOrKey}/thread` | the record with its decisions (oldest first); 404 until the first sync |
//! | `GET /api/w/{slug}/tasks/{idOrKey}/estimate-suggestion` | points from similar finished tasks |
//! | `GET /api/w/{slug}/decisions` | newest first; `path` (file, directory prefix or glob), `issue`, `limit` (1 to 200) |
//!
//! # Modules
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `thread-paths.ts` | [`paths`] |
//! | `pull-request-url.ts` | [`pull_request`] |
//! | `estimate-suggestion.ts` | [`estimate`] |
//! | `threads.service.ts` | [`service`] |
//! | `threads.controller.ts` | [`router`] and [`schemas`] |
//!
//! The 409 of a task that links another thread is
//! [`trama_issues::thread_link::thread_already_linked`].

pub mod estimate;
pub mod paths;
pub mod pull_request;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
