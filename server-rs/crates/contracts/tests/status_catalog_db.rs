//! `load_status_catalog` against a migrated database.

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use trama_contracts::status::{default_status_catalog, load_status_catalog};
use trama_core::testkit::TestDb;

#[tokio::test]
async fn loads_the_stored_catalog_or_the_seeds() {
    let Some(test) = TestDb::create().await else { return };
    trama_migration::Migrator::up(&test.db, None).await.unwrap();
    let statuses = serde_json::json!({
        "statuses": {
            "issue": [
                { "id": "st_ready", "name": "Ready", "icon": "circle", "color": "#5F6A7A", "type": "todo" },
            ],
        },
    });
    test.db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO workspaces (id, name, slug, settings) \
             VALUES ($1, 'Acme', 'acme', $2), ($3, 'Bare', 'bare', '{}')",
            ["ws_1".into(), statuses.into(), "ws_2".into()],
        ))
        .await
        .unwrap();

    let stored = load_status_catalog(&test.db, "ws_1").await;
    assert_eq!(stored.issue[0].id, "st_ready");
    assert_eq!(stored.issue[0].color, "#5f6a7a");
    assert!(stored.issue.iter().any(|e| e.id == "done"));
    assert_eq!(stored.project, default_status_catalog().project);

    assert_eq!(load_status_catalog(&test.db, "ws_2").await, default_status_catalog());
    assert_eq!(load_status_catalog(&test.db, "ws_missing").await, default_status_catalog());

    test.drop().await;
}
