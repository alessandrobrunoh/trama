//! Stored issue rows and their wire form.

use serde_json::Value;
use trama_contracts::common::Priority;
use trama_contracts::issues::{Issue, IssueKind, IssueSource};
use trama_core::time::to_iso;
use trama_entities::issues;

/// The strings of a JSON array column (`labels`, `aliases`, `milestoneIds`).
#[must_use]
pub fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The wire form of a stored issue (`IssueEntity.toJSON()`): absent columns are omitted, never
/// `null`. `artifact_count` is left out; the single-issue route fills it in.
#[must_use]
pub fn present(row: &issues::Model) -> Issue {
    Issue {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        key: row.key.clone(),
        number: row.number,
        kind: IssueKind::parse(&row.kind).unwrap_or(IssueKind::Bug),
        title: row.title.clone(),
        body: row.body.clone(),
        source: IssueSource::parse(&row.source).unwrap_or(IssueSource::Manual),
        reporter_name: row.reporter_name.clone(),
        reporter_id: row.reporter_id.clone(),
        assignee_id: row.assignee_id.clone(),
        priority: Priority::parse(&row.priority).unwrap_or(Priority::None),
        status: row.status.clone(),
        project_id: row.project_id.clone(),
        milestone_ids: strings(&row.milestone_ids),
        estimate: row.estimate,
        due_date: row.due_date.as_ref().map(to_iso),
        started_at: row.started_at.as_ref().map(to_iso),
        completed_at: row.completed_at.as_ref().map(to_iso),
        labels: strings(&row.labels),
        aliases: strings(&row.aliases),
        parent_id: row.parent_id.clone(),
        duplicate_of_id: row.duplicate_of_id.clone(),
        external_url: row.external_url.clone(),
        thread_url: row.thread_url.clone(),
        external_ref: row
            .external_ref
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        artifact_count: None,
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, IntoActiveModel};
    use serde_json::json;

    use super::*;

    /// A bare stored issue, for tests.
    pub(crate) fn row(id: &str, key: &str, number: i32) -> issues::Model {
        let now = chrono::Utc::now().fixed_offset();
        issues::Model {
            id: id.to_owned(),
            workspace_id: "ws_1".to_owned(),
            key: key.to_owned(),
            number,
            kind: "bug".to_owned(),
            title: id.to_owned(),
            body: None,
            source: "manual".to_owned(),
            reporter_name: None,
            reporter_id: None,
            priority: "none".to_owned(),
            status: "todo".to_owned(),
            duplicate_of_id: None,
            external_url: None,
            created_at: now,
            updated_at: now,
            assignee_id: None,
            milestone_ids: json!([]),
            estimate: None,
            started_at: None,
            completed_at: None,
            aliases: json!([]),
            project_id: None,
            labels: json!([]),
            external_ref: None,
            parent_id: None,
            thread_url: None,
            due_date: None,
        }
    }

    pub(crate) async fn seed_workspace(db: &DatabaseConnection, id: &str) {
        db.execute_unprepared(&format!(
            r#"INSERT INTO "workspaces" ("id","slug","name") VALUES ('{id}','{id}','{id}')"#
        ))
        .await
        .unwrap();
    }

    pub(crate) async fn insert_issue(db: &DatabaseConnection, row: &issues::Model) {
        row.clone().into_active_model().reset_all().insert(db).await.unwrap();
    }

    #[test]
    fn omits_what_is_absent_and_formats_dates_like_json() {
        let mut stored = row("in_1", "BUG-1", 1);
        stored.due_date = chrono::DateTime::parse_from_rfc3339("2026-12-02T00:00:00Z").ok();
        stored.estimate = Some(3.0);
        stored.external_ref = Some(json!({
            "provider": "github", "id": "a/b#1", "url": "https://x.dev", "origin": "link"
        }));
        let wire = serde_json::to_value(present(&stored)).unwrap();
        assert_eq!(wire["dueDate"], "2026-12-02T00:00:00.000Z");
        assert_eq!(wire["estimate"], 3);
        assert_eq!(wire["externalRef"]["provider"], "github");
        for absent in ["body", "assigneeId", "projectId", "parentId", "threadUrl", "artifactCount"]
        {
            assert!(wire.get(absent).is_none(), "{absent}");
        }
        assert_eq!(wire["labels"], json!([]));
        assert_eq!(wire["milestoneIds"], json!([]));
    }
}
