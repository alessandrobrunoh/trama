//! Workspace-scoped issue-tracker imports (`server/src/importers`).
//!
//! Credentials are stored encrypted and never returned. Preview, job creation, the import
//! engine and its background runner, and links from existing tasks to external issues follow
//! the NestJS module.
pub mod adapter;
pub mod credentials;
mod github;
pub mod github_adapter;
pub mod linear_adapter;
pub mod mapping;
mod router;
mod service;
mod sink;
pub mod types;

pub use github::execute_github_job;
pub use router::{ApiDoc, router};
pub use sink::{ImportIssue, ImportSink};
