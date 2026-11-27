//! The baseline against real PostgreSQL databases (skipped without `TEST_DATABASE_URL`).

use sea_orm_migration::MigratorTrait;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};
use trama_core::testkit::TestDb;
use trama_migration::Migrator;
use trama_migration::m20261125_000001_baseline::LAST_TYPEORM_MIGRATION;

async fn count(db: &impl ConnectionTrait, sql: &str) -> i64 {
    db.query_one_raw(Statement::from_string(DbBackend::Postgres, sql))
        .await
        .unwrap()
        .unwrap()
        .try_get_by_index(0)
        .unwrap()
}

async fn public_tables(db: &impl ConnectionTrait) -> i64 {
    count(
        db,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' \
         AND table_name <> 'seaql_migrations'",
    )
    .await
}

#[tokio::test]
async fn creates_the_schema_in_an_empty_database() {
    let Some(test) = TestDb::create().await else { return };

    Migrator::up(&test.db, None).await.unwrap();

    // 40 domain tables + TypeORM's `migrations`.
    assert_eq!(public_tables(&test.db).await, 41);
    let last = count(
        &test.db,
        &format!("SELECT count(*) FROM migrations WHERE name = '{LAST_TYPEORM_MIGRATION}'"),
    )
    .await;
    assert_eq!(last, 1, "TypeORM bookkeeping is recorded so NestJS skips its migrations");

    // Running again is a no-op.
    Migrator::up(&test.db, None).await.unwrap();
    assert_eq!(public_tables(&test.db).await, 41);
    test.drop().await;
}

#[tokio::test]
async fn adopts_a_database_built_by_nest() {
    let Some(test) = TestDb::create().await else { return };
    // Stand-in for a NestJS-built database: the baseline SQL, without SeaORM's bookkeeping.
    test.db.execute_unprepared(include_str!("../src/baseline.sql")).await.unwrap();
    test.db.execute_unprepared("ALTER TABLE issues ADD COLUMN \"later\" text").await.unwrap();

    Migrator::up(&test.db, None).await.unwrap();

    let later = count(
        &test.db,
        "SELECT count(*) FROM information_schema.columns \
         WHERE table_name = 'issues' AND column_name = 'later'",
    )
    .await;
    assert_eq!(later, 1, "an adopted schema is left alone");
    test.drop().await;
}

#[tokio::test]
async fn refuses_an_older_nest_schema() {
    let Some(test) = TestDb::create().await else { return };
    test.db.execute_unprepared(include_str!("../src/baseline.sql")).await.unwrap();
    test.db
        .execute_unprepared(&format!(
            "DELETE FROM migrations WHERE name = '{LAST_TYPEORM_MIGRATION}'"
        ))
        .await
        .unwrap();

    let err = Migrator::up(&test.db, None).await.unwrap_err();
    assert!(err.to_string().contains(LAST_TYPEORM_MIGRATION), "{err}");
    test.drop().await;
}

#[tokio::test]
async fn refuses_an_unknown_schema() {
    let Some(test) = TestDb::create().await else { return };
    test.db.execute_unprepared("CREATE TABLE stray (id int)").await.unwrap();

    let err = Migrator::up(&test.db, None).await.unwrap_err();
    assert!(err.to_string().contains("unknown schema"), "{err}");
    test.drop().await;
}
