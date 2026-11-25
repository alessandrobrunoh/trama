//! PostgreSQL connection helpers.

use percent_encoding::percent_decode_str;
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, DbErr, Statement};
use url::Url;

/// Creates the database named in `url` when it does not exist yet, as the NestJS API does on
/// boot. Failures are logged and ignored: the following connection reports the real problem.
pub async fn ensure_database(url: &str) {
    let Some((admin_url, name)) = admin_url(url) else { return };
    if let Err(err) = create_if_missing(&admin_url, &name).await {
        tracing::warn!(database = %name, error = %err, "could not ensure database");
    }
}

/// Opens a connection pool.
///
/// # Errors
///
/// Returns the driver error when the server cannot be reached or refuses the login.
pub async fn connect(url: &str) -> Result<DatabaseConnection, DbErr> {
    Database::connect(url).await
}

/// The same server's `postgres` database, and the database name `url` points at. `None` when
/// `url` already names `postgres` or no database.
pub(crate) fn admin_url(url: &str) -> Option<(String, String)> {
    let mut parsed = Url::parse(url).ok()?;
    let name =
        percent_decode_str(parsed.path().trim_start_matches('/')).decode_utf8().ok()?.into_owned();
    if name.is_empty() || name == "postgres" {
        return None;
    }
    parsed.set_path("/postgres");
    Some((parsed.to_string(), name))
}

/// `"name"` with embedded quotes doubled.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

async fn create_if_missing(admin_url: &str, name: &str) -> Result<(), DbErr> {
    let admin = Database::connect(admin_url).await?;
    let found = admin
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [name.into()],
        ))
        .await?;
    if found.is_none() {
        admin.execute_unprepared(&format!("CREATE DATABASE {}", quote_ident(name))).await?;
        tracing::info!(database = %name, "created database");
    }
    admin.close().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_url_swaps_the_database() {
        let (admin, name) =
            admin_url("postgres://u:p@localhost:5435/trama?sslmode=disable").unwrap();
        assert_eq!(admin, "postgres://u:p@localhost:5435/postgres?sslmode=disable");
        assert_eq!(name, "trama");
        assert!(admin_url("postgres://u:p@localhost/postgres").is_none());
        assert!(admin_url("postgres://u:p@localhost").is_none());
    }

    #[test]
    fn decodes_the_name() {
        assert_eq!(admin_url("postgres://h/my%20db+x").unwrap().1, "my db+x");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident(r#"a"b"#), r#""a""b""#);
    }
}
