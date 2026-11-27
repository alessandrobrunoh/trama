//! Workspace-scoped issue-tracker imports.
//!
//! This first port covers safe workspace-scoped credential/job reads and the job lifecycle
//! controls. Provider discovery, encrypted credential creation, and import execution remain
//! separate follow-up slices; no route here exposes stored credential ciphertext.
mod credentials;
mod github;
mod router;
mod service;
mod sink;

pub use github::execute_github_job;
pub use router::{ApiDoc, router};
pub use sink::{ImportIssue, ImportSink};
