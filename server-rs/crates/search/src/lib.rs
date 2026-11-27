//! Search of the Trama API: the port of `server/src/search`.
//!
//! `GET /api/w/{slug}/search?q=…&types=project,issue,artifact,decision,record&limit=20` finds
//! projects (name, summary, description), issues (key, aliases, title, body), artifacts
//! (external id, title), the decisions agents recorded on tasks (task key, text, paths) and the
//! thread records of tasks (task key, task title, summary) of the workspace. A `decision` or
//! `record` hit carries the key and the `issueId` of its task (a record's hit id is the task
//! id). Every word of `q` (the first six) must appear in one of a type's columns;
//! rows are scored (exact key 100 … body 20, anything else 10) and returned best first.
//!
//! Project scoping is the request's member access: a type the caller may not view is skipped,
//! and rows of projects they cannot reach are dropped (an artifact counts as in its issue's
//! project; one without an issue is hidden from a limited caller).
//!
//! [`service::search`] is the same search for other crates.

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{SearchOptions, score_row, search};
