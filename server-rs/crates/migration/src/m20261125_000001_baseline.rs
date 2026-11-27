//! Baseline: the schema as left by the NestJS migrations up to [`LAST_TYPEORM_MIGRATION`].
//!
//! * Empty database: runs `baseline.sql`, which also records the TypeORM migrations as applied so
//!   the NestJS API does not run them again.
//! * Database built by the NestJS API that has applied [`LAST_TYPEORM_MIGRATION`]: adopted as is.
//!   Later TypeORM migrations are fine; the NestJS API owns the schema until the hand-over.
//! * Anything else (an older NestJS schema, or tables without TypeORM's bookkeeping): refused,
//!   because running the baseline there would fail half-way or hide drift.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

/// The newest TypeORM migration included in `baseline.sql`.
pub const LAST_TYPEORM_MIGRATION: &str = "TimeEntrySource1794700000000";

const BASELINE_SQL: &str = include_str!("baseline.sql");

/// What the database looked like before the baseline ran.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// No tables: the baseline creates the schema.
    Empty,
    /// Built by the NestJS migrations up to the baseline or later: nothing to do.
    NestSchema,
}

/// See the module documentation.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        match inspect(db).await? {
            Found::Empty => {
                db.execute_unprepared(BASELINE_SQL).await?;
                tracing::info!("created the schema from the baseline");
            }
            Found::NestSchema => {
                tracing::info!("adopted the schema built by the NestJS migrations");
            }
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration("the baseline cannot be reverted".to_owned()))
    }
}

/// Classifies the database the baseline is about to run on.
///
/// # Errors
///
/// Returns [`DbErr::Migration`] for a schema the baseline must not touch.
pub async fn inspect(db: &impl ConnectionTrait) -> Result<Found, DbErr> {
    let tables = scalar_i64(
        db,
        "SELECT count(*) FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_name <> 'seaql_migrations'",
        [],
    )
    .await?;
    if tables == 0 {
        return Ok(Found::Empty);
    }

    let has_typeorm = scalar_i64(
        db,
        "SELECT count(*) FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_name = 'migrations'",
        [],
    )
    .await?
        > 0;
    if !has_typeorm {
        return Err(DbErr::Migration(
            "the database has tables but no TypeORM `migrations` table; refusing to apply the \
             baseline over an unknown schema"
                .to_owned(),
        ));
    }

    let applied = scalar_i64(
        db,
        "SELECT count(*) FROM migrations WHERE name = $1",
        [LAST_TYPEORM_MIGRATION.into()],
    )
    .await?
        > 0;
    if applied {
        Ok(Found::NestSchema)
    } else {
        Err(DbErr::Migration(format!(
            "the NestJS migrations have not reached {LAST_TYPEORM_MIGRATION}; start the NestJS \
             API once (it migrates on boot), then start this one"
        )))
    }
}

async fn scalar_i64<const N: usize>(
    db: &impl ConnectionTrait,
    sql: &str,
    values: [sea_orm_migration::sea_orm::Value; N],
) -> Result<i64, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres, sql, values))
        .await?
        .ok_or_else(|| DbErr::Custom(format!("no row from {sql}")))?;
    row.try_get_by_index(0)
}
