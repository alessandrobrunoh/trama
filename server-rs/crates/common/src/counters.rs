//! Atomic per-workspace sequences (table `workspace_counters`), the port of
//! `server/src/common/counters.service.ts`:
//!
//! * `issue-key:<prefix>` numbers issues per project tag (`AUTH-142`) or `UNPR`.
//!
//! Always call inside the transaction that inserts the numbered row (pass the transaction as
//! `conn`).

use sea_orm::{ConnectionTrait, DbErr, Statement};

/// The next value of counter `name` in `workspace_id`, starting at 1.
///
/// # Errors
///
/// The database error.
pub async fn next<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    name: &str,
) -> Result<i32, DbErr> {
    value(
        conn,
        r#"INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,1)
           ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = "workspace_counters"."value" + 1
           RETURNING "value""#,
        vec![workspace_id.into(), name.into()],
    )
    .await
}

/// Like [`next`], but never returns a number `<= floor`: one atomic statement moves the counter
/// to at least `floor` and then increments it. Pass the highest number already used by rows that
/// share the key prefix, so a lagging counter can never hand out a key that exists. Concurrent
/// callers serialize on the counter row and each get a distinct number.
///
/// # Errors
///
/// The database error.
pub async fn next_above<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    name: &str,
    floor: i32,
) -> Result<i32, DbErr> {
    value(
        conn,
        r#"INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3 + 1)
           ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3) + 1
           RETURNING "value""#,
        vec![workspace_id.into(), name.into(), floor.into()],
    )
    .await
}

/// Ensures the counter is at least `value` (seed / import with explicit numbers).
///
/// # Errors
///
/// The database error.
pub async fn bump_to<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    name: &str,
    value: i32,
) -> Result<(), DbErr> {
    conn.execute_raw(Statement::from_sql_and_values(
        conn.get_database_backend(),
        r#"INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3)
           ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3)"#,
        vec![workspace_id.into(), name.into(), value.into()],
    ))
    .await?;
    Ok(())
}

async fn value<C: ConnectionTrait>(
    conn: &C,
    sql: &str,
    values: Vec<sea_orm::Value>,
) -> Result<i32, DbErr> {
    let row = conn
        .query_one_raw(Statement::from_sql_and_values(conn.get_database_backend(), sql, values))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("workspace_counters returned no row".into()))?;
    row.try_get("", "value")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::TransactionTrait;
    use sea_orm_migration::MigratorTrait;
    use trama_core::testkit::TestDb;

    pub(crate) async fn workspace(db: &impl ConnectionTrait, id: &str) {
        db.execute_unprepared(&format!(
            r#"INSERT INTO "workspaces" ("id","slug","name") VALUES ('{id}','{id}','{id}')"#
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn counts_per_workspace_and_name() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        workspace(&test.db, "ws_a").await;
        workspace(&test.db, "ws_b").await;

        assert_eq!(next(&test.db, "ws_a", "issue-key:AUTH").await.unwrap(), 1);
        assert_eq!(next(&test.db, "ws_a", "issue-key:AUTH").await.unwrap(), 2);
        assert_eq!(next(&test.db, "ws_a", "issue-key:UNPR").await.unwrap(), 1);
        assert_eq!(next(&test.db, "ws_b", "issue-key:AUTH").await.unwrap(), 1);

        // a lagging counter jumps past the floor; a leading one is left alone
        assert_eq!(next_above(&test.db, "ws_a", "issue-key:AUTH", 10).await.unwrap(), 11);
        assert_eq!(next_above(&test.db, "ws_a", "issue-key:AUTH", 3).await.unwrap(), 12);
        assert_eq!(next_above(&test.db, "ws_a", "issue-key:NEW", 5).await.unwrap(), 6);

        bump_to(&test.db, "ws_b", "issue-key:AUTH", 40).await.unwrap();
        bump_to(&test.db, "ws_b", "issue-key:AUTH", 7).await.unwrap();
        bump_to(&test.db, "ws_b", "issue-key:SEED", 3).await.unwrap();
        assert_eq!(next(&test.db, "ws_b", "issue-key:AUTH").await.unwrap(), 41);
        assert_eq!(next(&test.db, "ws_b", "issue-key:SEED").await.unwrap(), 4);

        // inside a transaction
        let tx = test.db.begin().await.unwrap();
        assert_eq!(next(&tx, "ws_b", "issue-key:SEED").await.unwrap(), 5);
        tx.rollback().await.unwrap();
        assert_eq!(next(&test.db, "ws_b", "issue-key:SEED").await.unwrap(), 5);

        test.drop().await;
    }
}
