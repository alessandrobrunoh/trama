//! State shared by every handler.

use std::sync::Arc;

use sea_orm::DatabaseConnection;

use crate::Config;

/// Cloned into every request; cheap to clone.
#[derive(Clone, Debug)]
pub struct AppState {
    /// Connection pool.
    pub db: DatabaseConnection,
    /// Startup configuration.
    pub config: Arc<Config>,
}

impl AppState {
    /// State over an open connection pool.
    #[must_use]
    pub fn new(db: DatabaseConnection, config: Config) -> Self {
        Self { db, config: Arc::new(config) }
    }
}
