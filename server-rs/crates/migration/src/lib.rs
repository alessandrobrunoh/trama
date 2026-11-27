//! Schema migrations of the Trama database.
//!
//! The first migration is a baseline of the schema the NestJS (TypeORM) migrations produce. It
//! adopts a database those migrations already built and creates the schema in an empty one; see
//! [`m20261125_000001_baseline`]. SeaORM records its progress in `seaql_migrations`, next to
//! TypeORM's `migrations` table.
//!
//! While both APIs share the database, schema changes stay in the NestJS migrations and the
//! baseline is regenerated with `scripts/dump-baseline.sh`. Once NestJS stops running
//! migrations, new ones are added here.

use sea_orm_migration::prelude::*;

pub mod m20261125_000001_baseline;

/// Every migration, oldest first.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20261125_000001_baseline::Migration)]
    }
}
