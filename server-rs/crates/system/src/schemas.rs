//! Response bodies of the system endpoints.

use serde::Serialize;
use utoipa::ToSchema;

/// The API is up and the database answers.
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthUp {
    /// Always `ok`.
    #[schema(example = "ok")]
    pub status: &'static str,
    /// Always `up`.
    #[schema(example = "up")]
    pub db: &'static str,
    /// Server time, ISO 8601 in UTC with milliseconds.
    #[schema(example = "2026-11-25T14:01:36.424Z")]
    pub time: String,
}

/// The database does not answer (sent with 503).
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthDown {
    /// Always `error`.
    #[schema(example = "error")]
    pub status: &'static str,
    /// Always `down`.
    #[schema(example = "down")]
    pub db: &'static str,
}
