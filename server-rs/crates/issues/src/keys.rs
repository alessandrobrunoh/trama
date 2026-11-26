//! Issue keys (`issue-keys.ts`): `AUTH-142` is the key prefix of the issue's project (its tag) or
//! the reserved `UNPR`, and a number from the per-prefix counter. Changing project re-keys an
//! issue and keeps the former key as an alias.

use chrono::{DateTime, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect, Statement,
};
use trama_common::counters;
use trama_contracts::projects::UNASSIGNED_ISSUE_KEY_PREFIX;
use trama_core::AppError;
use trama_entities::{issues, projects, workspace_counters};

use crate::rows::strings;

/// Why an issue got a new key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueRekeyReason {
    /// The issue moved to another project (or to none).
    ProjectChanged,
    /// The tag of its project changed.
    ProjectTagChanged,
    /// Its project was deleted.
    ProjectDeleted,
}

impl IssueRekeyReason {
    /// The wire string of the `issue.rekeyed` event.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProjectChanged => "project_changed",
            Self::ProjectTagChanged => "project_tag_changed",
            Self::ProjectDeleted => "project_deleted",
        }
    }
}

/// One re-keyed issue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueKeyChange {
    /// The issue.
    pub issue_id: String,
    /// Its previous key (now an alias).
    pub from: String,
    /// Its new key.
    pub to: String,
    /// Its project before.
    pub from_project_id: Option<String>,
    /// Its project after.
    pub to_project_id: Option<String>,
    /// Why.
    pub reason: IssueRekeyReason,
}

/// The key prefix for issues of `project_id`: the project tag, or `UNPR` without a project. The
/// project row is locked `FOR SHARE` so issue creation and tag edits serialize; call inside the
/// write transaction.
///
/// # Errors
///
/// 404 `Project "<id>" not found`, or a database error.
pub async fn issue_key_prefix<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<String, AppError> {
    let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
        return Ok(UNASSIGNED_ISSUE_KEY_PREFIX.to_owned());
    };
    let key = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Id.eq(project_id))
        .select_only()
        .column(projects::Column::Key)
        .lock_shared()
        .into_tuple::<String>()
        .one(conn)
        .await?;
    key.ok_or_else(|| AppError::entity_not_found("Project", project_id))
}

/// `count` consecutive numbers for `prefix`. A prefix without a counter starts above every number
/// already used by a key or a retained alias of that prefix; after that the atomic counter
/// decides. Call inside the write transaction.
///
/// # Errors
///
/// A database error.
pub async fn allocate_issue_numbers<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    prefix: &str,
    count: usize,
) -> Result<Vec<i32>, AppError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let name = format!("issue-key:{prefix}");
    let has_counter = workspace_counters::Entity::find()
        .filter(workspace_counters::Column::WorkspaceId.eq(workspace_id))
        .filter(workspace_counters::Column::Name.eq(name.as_str()))
        .count(conn)
        .await?
        > 0;
    let first = if has_counter {
        counters::next(conn, workspace_id, &name).await?
    } else {
        let row = conn
            .query_one_raw(Statement::from_sql_and_values(
                conn.get_database_backend(),
                r#"SELECT COALESCE(MAX((regexp_match(known."issueKey", '^' || $2 || '-([0-9]+)$'))[1]::integer), 0) AS "floor"
                     FROM (
                       SELECT "key" AS "issueKey" FROM "issues" WHERE "workspaceId" = $1
                       UNION ALL
                       SELECT a."issueKey"
                         FROM "issues" i
                         CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(i."aliases", '[]'::jsonb)) a("issueKey")
                        WHERE i."workspaceId" = $1
                     ) known
                    WHERE known."issueKey" ~ ('^' || $2 || '-[0-9]+$')"#,
                vec![workspace_id.into(), prefix.into()],
            ))
            .await?;
        let floor: i32 = match row {
            Some(row) => row.try_get("", "floor")?,
            None => 0,
        };
        counters::next_above(conn, workspace_id, &name, floor).await?
    };
    let mut numbers = vec![first];
    for _ in 1..count {
        numbers.push(counters::next(conn, workspace_id, &name).await?);
    }
    Ok(numbers)
}

/// Re-keys `issues` in memory under `prefix`, retaining their previous keys as look-up aliases
/// and bumping `updated_at`. Nothing is written: the caller saves the rows (see
/// [`crate::service::save_rows`]) in the same transaction and records the `issue.rekeyed`
/// events afterwards.
///
/// # Errors
///
/// A database error.
pub async fn rekey_issues<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    issues: &mut [issues::Model],
    prefix: &str,
    to_project_id: Option<&str>,
    reason: IssueRekeyReason,
    now: DateTime<Utc>,
) -> Result<Vec<IssueKeyChange>, AppError> {
    let numbers = allocate_issue_numbers(conn, workspace_id, prefix, issues.len()).await?;
    let mut changes = Vec::with_capacity(issues.len());
    for (issue, number) in issues.iter_mut().zip(numbers) {
        let from = issue.key.clone();
        let from_project_id = issue.project_id.clone();
        let to = format!("{prefix}-{number}");
        let mut aliases = strings(&issue.aliases);
        if !aliases.contains(&from) {
            aliases.push(from.clone());
        }
        issue.aliases = serde_json::json!(aliases);
        issue.number = number;
        issue.key.clone_from(&to);
        issue.updated_at = now.fixed_offset();
        changes.push(IssueKeyChange {
            issue_id: issue.id.clone(),
            from,
            to,
            from_project_id,
            to_project_id: to_project_id.map(str::to_owned),
            reason,
        });
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use sea_orm_migration::MigratorTrait;
    use trama_core::testkit::TestDb;

    use super::*;
    use crate::rows::tests::{insert_issue, row, seed_workspace};

    // issues/issue-keys.spec.ts
    #[tokio::test]
    async fn uses_a_project_tag_or_the_reserved_unassigned_prefix() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        seed_workspace(&test.db, "ws_1").await;
        test.db
            .execute_unprepared(
                r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
                   VALUES ('pj_cora', 'ws_1', 'Cora', 'blue', 'planned', 'none', 'CORA')"#,
            )
            .await
            .unwrap();
        assert_eq!(issue_key_prefix(&test.db, "ws_1", Some("pj_cora")).await.unwrap(), "CORA");
        assert_eq!(
            issue_key_prefix(&test.db, "ws_1", None).await.unwrap(),
            UNASSIGNED_ISSUE_KEY_PREFIX
        );
        let err = issue_key_prefix(&test.db, "ws_1", Some("pj_none")).await.unwrap_err();
        assert!(err.to_string().ends_with("Project \"pj_none\" not found"));
        test.drop().await;
    }

    #[tokio::test]
    async fn starts_above_retained_aliases_and_then_uses_the_atomic_prefix_counter() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        seed_workspace(&test.db, "ws_1").await;
        // `CORA-5` is a key, `CORA-8` only a retained alias of a re-keyed issue
        let mut moved = row("in_a", "UNPR-1", 1);
        moved.aliases = serde_json::json!(["CORA-8", "BUG-40"]);
        insert_issue(&test.db, &moved).await;
        insert_issue(&test.db, &row("in_b", "CORA-5", 5)).await;
        assert_eq!(allocate_issue_numbers(&test.db, "ws_1", "CORA", 2).await.unwrap(), [9, 10]);
        // the counter exists now: no scan, the next number follows
        assert_eq!(allocate_issue_numbers(&test.db, "ws_1", "CORA", 1).await.unwrap(), [11]);
        // another prefix is independent and starts at 1
        assert_eq!(allocate_issue_numbers(&test.db, "ws_1", "NEW", 1).await.unwrap(), [1]);
        assert!(allocate_issue_numbers(&test.db, "ws_1", "NEW", 0).await.unwrap().is_empty());
        test.drop().await;
    }

    #[tokio::test]
    async fn keeps_the_previous_key_as_an_alias_when_an_issue_changes_project() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        seed_workspace(&test.db, "ws_1").await;
        test.db
            .execute_unprepared(
                r#"INSERT INTO workspace_counters ("workspaceId", name, value)
                   VALUES ('ws_1', 'issue-key:UNPR', 3)"#,
            )
            .await
            .unwrap();
        let mut issue = row("in_1", "CORA-3", 3);
        issue.aliases = serde_json::json!(["BUG-7"]);
        issue.project_id = Some("pj_cora".to_owned());
        let mut rows = [issue];

        let changes = rekey_issues(
            &test.db,
            "ws_1",
            &mut rows,
            "UNPR",
            None,
            IssueRekeyReason::ProjectChanged,
            Utc::now(),
        )
        .await
        .unwrap();

        assert_eq!(rows[0].key, "UNPR-4");
        assert_eq!(rows[0].number, 4);
        assert_eq!(rows[0].aliases, serde_json::json!(["BUG-7", "CORA-3"]));
        assert_eq!(
            changes,
            [IssueKeyChange {
                issue_id: "in_1".to_owned(),
                from: "CORA-3".to_owned(),
                to: "UNPR-4".to_owned(),
                from_project_id: Some("pj_cora".to_owned()),
                to_project_id: None,
                reason: IssueRekeyReason::ProjectChanged,
            }]
        );
        test.drop().await;
    }
}
