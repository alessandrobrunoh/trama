//! Workspace-scoped issue-tracker imports (`server/src/importers`).
//!
//! Credentials are stored encrypted and never returned. Preview, job creation, the import
//! engine and its background runner, and links from existing tasks to external issues follow
//! the NestJS module.
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `import-engine.ts` | [`engine`]: [`engine::ImportEngine`], the [`engine::ImportSink`] and [`engine::EngineHooks`] it is given |
//! | `import-sink.ts` | [`sink::PgImportSink`] |
//! | `ImportRunnerService` | [`runner`]: [`with_services`], [`spawn`] (the sweep), [`stop`], [`runner::ImportRunner`] |
//! | `ImportsService` | [`service`]: `preview`, `start`, `list`, `get`, `cancel`, `retry`, `remove` |
//! | `ImportsController` | [`router`] (credentials) and [`jobs`] (preview and jobs) |
//!
//! ```ignore
//! let state = trama_importers::with_services(state);
//! let importer = trama_importers::spawn(&state);
//! // ... serve; on shutdown:
//! trama_importers::stop(&state);
//! importer.abort();
//! ```
pub mod adapter;
pub mod credentials;
pub mod engine;
mod external_links;
pub mod github_adapter;
pub mod jobs;
pub mod linear_adapter;
pub mod mapping;
mod router;
pub mod runner;
pub mod schemas;
pub mod service;
pub mod sink;
pub mod types;

pub use router::{ApiDoc, router};
pub use runner::{ImportRunner, SourceFactory, spawn, stop, with_services};
