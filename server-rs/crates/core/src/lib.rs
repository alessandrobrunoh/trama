//! Shared foundation of the Trama API.
//!
//! Every module crate builds on these pieces so the Rust server answers exactly like the NestJS
//! API it replaces: the same error bodies, ids, timestamps and input checks.

pub mod config;
pub mod db;
pub mod errors;
pub mod http;
pub mod ids;
pub mod json;
pub mod state;
#[cfg(feature = "test-support")]
pub mod testkit;
pub mod time;
pub mod validation;

pub use config::Config;
pub use errors::AppError;
pub use json::ApiJson;
pub use state::AppState;
