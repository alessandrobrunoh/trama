//! The parent/child links between issues, serialized so concurrent changes cannot form a cycle
//! or race a delete: the workspace row is locked `FOR UPDATE` first, then the issue rows involved
//! in id order.

use std::collections::HashMap;

use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Statement,
};
use serde_json::Value;
use trama_core::AppError;
use trama_entities::{issues, workspaces};

/// The columns of an issue that its parent link, key and project decide (`IssueTeamRef`).
#[derive(Clone, Debug)]
pub(crate) struct Relation {
    pub project_id: Option<String>,
    pub parent_id: Option<String>,
    pub key: String,
    pub number: i32,
    pub aliases: Value,
}

impl From<issues::Model> for Relation {
    fn from(row: issues::Model) -> Self {
        Self {
            project_id: row.project_id,
            parent_id: row.parent_id,
            key: row.key,
            number: row.number,
            aliases: row.aliases,
        }
    }
}

/// Locking the workspace serializes all parent-link changes with each other and with deletion.
pub(crate) async fn lock_hierarchy<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
) -> Result<(), AppError> {
    workspaces::Entity::find_by_id(workspace_id.to_owned())
        .select_only()
        .column(workspaces::Column::Id)
        .lock_exclusive()
        .into_tuple::<String>()
        .one(conn)
        .await?;
    Ok(())
}

/// Reads the current relationship before locking the complete, id-sorted set of related rows.
pub(crate) async fn read_relation<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    issue_id: &str,
) -> Result<Relation, AppError> {
    issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.eq(issue_id))
        .one(conn)
        .await?
        .map(Relation::from)
        .ok_or_else(|| AppError::entity_not_found("Issue", issue_id))
}

/// Locks the rows of `ids` (in id order) and returns what they are right now.
pub(crate) async fn lock_relations<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, Relation>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.iter().cloned()))
        .order_by_asc(issues::Column::Id)
        .lock_exclusive()
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(|row| (row.id.clone(), Relation::from(row))).collect())
}

/// Serializes parent changes in a workspace and rejects links to descendants.
pub(crate) async fn assert_parent_link<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    child_id: &str,
    parent_id: &str,
) -> Result<(), AppError> {
    lock_hierarchy(conn, workspace_id).await?;
    assert_parent_link_locked(conn, workspace_id, child_id, parent_id).await
}

/// The recursive query walks upward from the proposed parent, so depth is not bounded by
/// application code. The workspace lock must already be held.
pub(crate) async fn assert_parent_link_locked<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    child_id: &str,
    parent_id: &str,
) -> Result<(), AppError> {
    let row = conn
        .query_one_raw(Statement::from_sql_and_values(
            conn.get_database_backend(),
            r#"WITH RECURSIVE parent_chain ("id", "parentId", "path", "cycle") AS (
                 SELECT i."id", i."parentId", ARRAY[i."id"]::character varying[], false
                 FROM "issues" i
                 WHERE i."workspaceId" = $1 AND i."id" = $2
                 UNION ALL
                 SELECT p."id", p."parentId", c."path" || p."id",
                        p."id" = ANY(c."path")
                 FROM "issues" p
                 JOIN parent_chain c ON p."id" = c."parentId"
                 WHERE p."workspaceId" = $1 AND NOT c."cycle"
               )
               SELECT count(*) > 0 AS "found",
                      COALESCE(bool_or("id" = $3), false) AS "includesChild",
                      COALESCE(bool_or("cycle"), false) AS "containsCycle"
               FROM parent_chain"#,
            vec![workspace_id.into(), parent_id.into(), child_id.into()],
        ))
        .await?;
    let Some(row) = row else { return Err(AppError::entity_not_found("Issue", parent_id)) };
    let found: bool = row.try_get("", "found")?;
    let includes_child: bool = row.try_get("", "includesChild")?;
    let contains_cycle: bool = row.try_get("", "containsCycle")?;
    if !found {
        return Err(AppError::entity_not_found("Issue", parent_id));
    }
    if includes_child || contains_cycle {
        return Err(AppError::bad_request("Issue hierarchy cannot contain cycles"));
    }
    Ok(())
}
