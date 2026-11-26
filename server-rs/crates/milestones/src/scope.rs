//! The rule that an issue is only in milestones of its own project (`milestone-scope.ts`).

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};
use serde_json::{Value, json};
use trama_core::AppError;
use trama_entities::{issues, milestones};

/// Drops, from each of the issues, the milestones that no longer belong to the issue's project
/// (all of them when the issue has no project), with `updatedAt` bumped. Pass the transaction
/// the issue change runs in as `conn`.
///
/// Returns the ids of the issues that changed.
///
/// # Errors
///
/// A database error.
pub async fn prune_issue_milestones<C: ConnectionTrait>(
    conn: &C,
    workspace_id: &str,
    issue_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if issue_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(issue_ids.iter().cloned()))
        .all(conn)
        .await?;
    let with_milestones: Vec<(issues::Model, Vec<String>)> = rows
        .into_iter()
        .map(|issue| {
            let ids = milestone_ids(&issue.milestone_ids);
            (issue, ids)
        })
        .filter(|(_, ids)| !ids.is_empty())
        .collect();
    if with_milestones.is_empty() {
        return Ok(Vec::new());
    }
    let mut wanted: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in with_milestones.iter().flat_map(|(_, ids)| ids) {
        if seen.insert(id.as_str()) {
            wanted.push(id.clone());
        }
    }
    let project_of: HashMap<String, String> = milestones::Entity::find()
        .filter(milestones::Column::WorkspaceId.eq(workspace_id))
        .filter(milestones::Column::Id.is_in(wanted))
        .all(conn)
        .await?
        .into_iter()
        .map(|m| (m.id, m.project_id))
        .collect();
    let mut changed = Vec::new();
    for (issue, ids) in with_milestones {
        let kept: Vec<&String> = ids
            .iter()
            .filter(|id| {
                project_of
                    .get(*id)
                    .is_some_and(|project| issue.project_id.as_ref() == Some(project))
            })
            .collect();
        if kept.len() == ids.len() {
            continue;
        }
        issues::Entity::update_many()
            .set(issues::ActiveModel {
                milestone_ids: Set(json!(kept)),
                updated_at: Set(Utc::now().fixed_offset()),
                ..Default::default()
            })
            .filter(issues::Column::Id.eq(issue.id.as_str()))
            .exec(conn)
            .await?;
        changed.push(issue.id);
    }
    Ok(changed)
}

/// The ids in an issue's `milestoneIds` column.
fn milestone_ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}
