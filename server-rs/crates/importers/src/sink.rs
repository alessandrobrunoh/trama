//! Transactional persistence for imported issues.
use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, Set, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use trama_core::AppError;
use trama_entities::{import_links, issues};
use trama_issues::keys::{allocate_issue_numbers, issue_key_prefix};

/// The issue fields produced by provider mapping before workspace keys are assigned.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct ImportIssue {
    pub external_id: String,
    pub external_url: String,
    pub external_key: String,
    pub external_state: String,
    pub external_state_type: String,
    pub synced_at: DateTime<Utc>,
    pub kind: String,
    pub title: String,
    pub body: Option<String>,
    pub source: String,
    pub reporter_name: Option<String>,
    pub assignee_id: Option<String>,
    pub project_id: Option<String>,
    pub milestone_ids: Vec<String>,
    pub priority: String,
    pub status: String,
    pub estimate: Option<f64>,
    pub labels: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Workspace-scoped idempotent sink for external issues.
pub struct ImportSink<'a> {
    db: &'a DatabaseConnection,
    workspace_id: &'a str,
    job_id: &'a str,
}

impl<'a> ImportSink<'a> {
    /// Construct a sink bound to one job and workspace.
    pub const fn new(db: &'a DatabaseConnection, workspace_id: &'a str, job_id: &'a str) -> Self {
        Self { db, workspace_id, job_id }
    }

    /// Finds already imported issues by external identity in this workspace.
    pub async fn existing_issues(
        &self,
        provider: &str,
        ids: &[String],
    ) -> Result<Vec<(String, String)>, AppError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .query_all_raw(Statement::from_sql_and_values(
                self.db.get_database_backend(),
                r#"SELECT id, "externalRef"->>'id' AS external_id FROM issues
               WHERE "workspaceId" = $1 AND "externalRef"->>'provider' = $2
                 AND "externalRef"->>'id' = ANY($3::text[])"#,
                [self.workspace_id.into(), provider.into(), ids.to_vec().into()],
            ))
            .await?;
        rows.iter()
            .map(|row| Ok((row.try_get("", "external_id")?, row.try_get("", "id")?)))
            .collect::<Result<Vec<_>, sea_orm::DbErr>>()
            .map_err(Into::into)
    }

    /// Persists an issue and its import link in one transaction. A conflict on the database's
    /// unique external-reference index means another replay won, and returns `false`.
    pub async fn create_issue(
        &self,
        provider: &str,
        issue: &ImportIssue,
    ) -> Result<bool, AppError> {
        let txn = self.db.begin().await?;
        let prefix = issue_key_prefix(&txn, self.workspace_id, issue.project_id.as_deref()).await?;
        let number = allocate_issue_numbers(&txn, self.workspace_id, &prefix, 1).await?[0];
        let id = format!(
            "in_import_{}_{}",
            issue.synced_at.timestamp_nanos_opt().unwrap_or_default(),
            number
        );
        let external_ref = json!({
            "provider": provider, "id": issue.external_id, "url": issue.external_url,
            "key": issue.external_key, "state": issue.external_state,
            "stateType": issue.external_state_type, "syncedAt": issue.synced_at.to_rfc3339(),
            "origin": "import"
        });
        let row = issues::ActiveModel {
            id: Set(id.clone()),
            workspace_id: Set(self.workspace_id.to_owned()),
            key: Set(format!("{prefix}-{number}")),
            number: Set(number),
            kind: Set(issue.kind.clone()),
            title: Set(issue.title.clone()),
            body: Set(issue.body.clone()),
            source: Set(issue.source.clone()),
            reporter_name: Set(issue.reporter_name.clone()),
            reporter_id: Set(None),
            priority: Set(issue.priority.clone()),
            status: Set(issue.status.clone()),
            duplicate_of_id: Set(None),
            external_url: Set(Some(issue.external_url.clone())),
            created_at: Set(issue.created_at.fixed_offset()),
            updated_at: Set(issue.updated_at.fixed_offset()),
            assignee_id: Set(issue.assignee_id.clone()),
            milestone_ids: Set(json!(issue.milestone_ids)),
            estimate: Set(issue.estimate),
            started_at: Set(issue.started_at.map(|d| d.fixed_offset())),
            completed_at: Set(issue.completed_at.map(|d| d.fixed_offset())),
            aliases: Set(json!([])),
            project_id: Set(issue.project_id.clone()),
            labels: Set(json!(issue.labels)),
            external_ref: Set(Some(external_ref)),
            parent_id: Set(None),
            thread_url: Set(None),
            due_date: Set(None),
        };
        if let Err(error) = row.insert(&txn).await {
            // PostgreSQL unique violation is the authoritative cross-worker idempotency guard.
            if error.to_string().contains("UQ_issues_external_ref") {
                txn.rollback().await?;
                return Ok(false);
            }
            return Err(error.into());
        }
        import_links::ActiveModel {
            workspace_id: Set(self.workspace_id.to_owned()),
            provider: Set(provider.to_owned()),
            kind: Set("issue".to_owned()),
            external_id: Set(issue.external_id.clone()),
            trama_id: Set(id),
            job_id: Set(Some(self.job_id.to_owned())),
        }
        .insert(&txn)
        .await?;
        txn.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    use sea_orm_migration::MigratorTrait;

    fn issue() -> ImportIssue {
        let now = Utc::now();
        ImportIssue {
            external_id: "octo/repo#42".into(),
            external_url: "https://github.com/octo/repo/issues/42".into(),
            external_key: "#42".into(),
            external_state: "Open".into(),
            external_state_type: "open".into(),
            synced_at: now,
            kind: "bug".into(),
            title: "A replay-safe import".into(),
            body: None,
            source: "github".into(),
            reporter_name: Some("octocat".into()),
            assignee_id: None,
            project_id: None,
            milestone_ids: vec![],
            priority: "none".into(),
            status: "backlog".into(),
            estimate: None,
            labels: vec![],
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
        }
    }

    #[tokio::test]
    async fn replay_keeps_one_task_and_one_matching_import_link() {
        let Some(test) = trama_core::testkit::TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        test.db.execute_unprepared(
            r#"INSERT INTO workspaces (id, slug, name) VALUES ('ws_import_replay','ws-import-replay','Replay')"#,
        ).await.unwrap();
        let input = issue();
        let sink = ImportSink::new(&test.db, "ws_import_replay", "imp_replay");
        assert!(sink.create_issue("github", &input).await.unwrap());
        assert!(!sink.create_issue("github", &input).await.unwrap());
        let found =
            sink.existing_issues("github", std::slice::from_ref(&input.external_id)).await.unwrap();
        assert_eq!(found.len(), 1);
        let links = import_links::Entity::find()
            .filter(import_links::Column::WorkspaceId.eq("ws_import_replay"))
            .filter(import_links::Column::Provider.eq("github"))
            .filter(import_links::Column::ExternalId.eq(&input.external_id))
            .all(&test.db)
            .await
            .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].trama_id, found[0].1);
        test.drop().await;
    }
}
