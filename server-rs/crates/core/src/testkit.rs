//! Throwaway databases for tests.
//!
//! Tests that need PostgreSQL read only `TEST_DATABASE_URL` (from the environment or
//! `server-rs/.env`) and never `DATABASE_URL`. Each [`TestDb`] is a new database named
//! `trama_rs_test_<random>` on that server, dropped by [`TestDb::drop`]. The database named in the
//! URL itself is never touched, so it is safe to reuse the NestJS e2e setting.
//!
//! When `TEST_DATABASE_URL` is unset the fixture returns `None` and the test should return early:
//! `cargo test` passes without a database.

use sea_orm::{ConnectionTrait, Database, DatabaseConnection};

use crate::db::{admin_url, quote_ident};
use crate::ids::uid;

/// A database that exists for one test.
pub struct TestDb {
    /// Connection to the test database.
    pub db: DatabaseConnection,
    url: String,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// Creates an empty database, or `None` (with a note on stderr) when `TEST_DATABASE_URL` is
    /// unset.
    ///
    /// # Panics
    ///
    /// Panics when `TEST_DATABASE_URL` is set but the server cannot be used: a broken setup
    /// should fail loudly rather than skip.
    pub async fn create() -> Option<Self> {
        let _ = dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env"));
        let Some(base) = std::env::var("TEST_DATABASE_URL").ok().filter(|v| !v.trim().is_empty())
        else {
            eprintln!("TEST_DATABASE_URL is unset; skipping database test");
            return None;
        };
        let (admin_url, _) = admin_url(&base)
            .unwrap_or_else(|| panic!("TEST_DATABASE_URL must name a database: {base}"));
        let name = uid("trama_rs_test");

        let admin = Database::connect(&admin_url).await.expect("connect to the test server");
        admin
            .execute_unprepared(&format!("CREATE DATABASE {}", quote_ident(&name)))
            .await
            .expect("create the test database");
        admin.close().await.expect("close the admin connection");

        let mut url = url::Url::parse(&base).expect("TEST_DATABASE_URL is a URL");
        url.set_path(&format!("/{name}"));
        let url = url.to_string();
        let db = Database::connect(&url).await.expect("connect to the test database");
        Some(Self { db, url, admin_url, name })
    }

    /// Connection string of the test database.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Closes the connection and drops the database.
    ///
    /// # Panics
    ///
    /// Panics when the database cannot be dropped.
    pub async fn drop(self) {
        self.db.close().await.expect("close the test connection");
        let admin = Database::connect(&self.admin_url).await.expect("connect to the test server");
        admin
            .execute_unprepared(&format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                quote_ident(&self.name)
            ))
            .await
            .expect("drop the test database");
        admin.close().await.expect("close the admin connection");
    }
}
