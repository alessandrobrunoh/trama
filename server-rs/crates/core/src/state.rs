//! State shared by every handler.

use std::sync::Arc;

use axum::http::Extensions;
use sea_orm::DatabaseConnection;

use crate::Config;

/// Cloned into every request; cheap to clone.
#[derive(Clone, Debug)]
pub struct AppState {
    /// Connection pool.
    pub db: DatabaseConnection,
    /// Startup configuration.
    pub config: Arc<Config>,
    /// Process-wide services registered at startup by crates `trama-core` does not know about
    /// (the mailer, the secrets box, …), looked up by type. See [`AppState::with_extension`].
    extensions: Arc<Extensions>,
}

impl AppState {
    /// State over an open connection pool.
    #[must_use]
    pub fn new(db: DatabaseConnection, config: Config) -> Self {
        Self { db, config: Arc::new(config), extensions: Arc::default() }
    }

    /// Registers `value` so handlers can fetch it with [`AppState::extension`]. A second value of
    /// the same type replaces the first. Call while building the state, before serving.
    #[must_use]
    pub fn with_extension<T: Clone + Send + Sync + 'static>(mut self, value: T) -> Self {
        Arc::make_mut(&mut self.extensions).insert(value);
        self
    }

    /// The registered value of type `T`, if any.
    #[must_use]
    pub fn extension<T: Clone + Send + Sync + 'static>(&self) -> Option<&T> {
        self.extensions.get::<T>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Marker(u8);

    #[test]
    fn extensions_are_looked_up_by_type() {
        let state = AppState::new(DatabaseConnection::default(), Config::from_vars(&[]));
        assert!(state.extension::<Marker>().is_none());
        let state = state.with_extension(Marker(1)).with_extension(Marker(2));
        assert_eq!(state.clone().extension::<Marker>(), Some(&Marker(2)));
    }
}
