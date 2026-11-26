//! Insights of the Trama API: the port of `server/src/insights`.
//!
//! * `GET /api/w/{slug}/insights?days=&projectId=&staleDays=&limit=`: the report. Four health
//!   signals (stale issues, overdue milestones, pull requests stuck in review, failing CI), flow
//!   metrics (cycle and lead time, weekly throughput, work in progress), review bottlenecks and
//!   who did the work;
//! * `GET /api/w/{slug}/insights/signals/{id}`: one signal with up to 100 items (404 `Unknown
//!   signal "<id>"` for an id that is not one of the four).
//!
//! Everything derives from the issues the caller can see: issues of projects outside the
//! request's member access are left out, and so are their pull requests and events. A project
//! filter that does not exist or is outside the access is a 404 `Project not found`.
//!
//! [`service`] loads the rows; [`report`] computes the report from them without a database.

pub mod report;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{Params, report as load_report, signal as load_signal};
