//! What the project AI reads from the database (`server/src/ai/project-ai-facts.service.ts`).
//! Read-only.

use std::collections::HashMap;

use async_trait::async_trait;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, ExprTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::Value;
use trama_contracts::js;
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_entities::{domain_events, issues, milestones, projects, users};

use crate::project_logic::{
    FactsEvent, FactsIssue, FactsMilestone, FactsProject, ProjectFacts, clip,
};

const MAX_PROJECT_ISSUES: u64 = 500;
const MAX_CANDIDATES: usize = 150;

/// The records a project proposal is based on.
#[async_trait]
pub trait ProjectAiStore: Send + Sync {
    /// The project of the workspace.
    async fn find_project(
        &self,
        workspace_id: &str,
        id: &str,
    ) -> Result<Option<projects::Model>, AppError>;

    /// `withCandidates`: also load open issues outside the project (for the `issues` suggestion).
    async fn gather(
        &self,
        project: &projects::Model,
        with_candidates: bool,
    ) -> Result<ProjectFacts, AppError>;
}

/// [`ProjectAiStore`] over the database.
#[derive(Clone)]
pub struct DbProjectAiStore {
    db: DatabaseConnection,
}

impl DbProjectAiStore {
    /// Reads from `db`.
    #[must_use]
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    async fn candidate_issues(&self, workspace_id: &str) -> Result<Vec<issues::Model>, AppError> {
        let rows = issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::Status.is_not_in(["done", "canceled"]))
            .order_by_desc(issues::Column::UpdatedAt)
            .limit(u64::try_from(MAX_CANDIDATES * 3).unwrap_or(450))
            .all(&self.db)
            .await?;
        Ok(rows
            .into_iter()
            .filter(|i| i.project_id.is_none() && i.duplicate_of_id.is_none())
            .take(MAX_CANDIDATES)
            .collect())
    }

    async fn recent_events(
        &self,
        workspace_id: &str,
        project_id: &str,
        issue_ids: &[String],
    ) -> Result<Vec<domain_events::Model>, AppError> {
        let subject_id = || Expr::cust(r#""subject" ->> 'id'"#);
        let mut scope = Condition::any().add(subject_id().eq(Expr::val(project_id)));
        if !issue_ids.is_empty() {
            scope = scope.add(subject_id().is_in(issue_ids.iter().map(String::as_str)));
        }
        Ok(domain_events::Entity::find()
            .filter(domain_events::Column::WorkspaceId.eq(workspace_id))
            .filter(scope)
            .order_by_desc(domain_events::Column::At)
            .limit(25)
            .all(&self.db)
            .await?)
    }
}

fn milestone_ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn event_summary(event: &domain_events::Model) -> String {
    let label = ["key", "title", "name"]
        .iter()
        .filter_map(|k| event.data.get(*k).and_then(Value::as_str))
        .find(|v| !v.is_empty());
    let text = label.map_or_else(
        || {
            let part = |key: &str| {
                event.subject.get(key).and_then(Value::as_str).unwrap_or("undefined").to_owned()
            };
            format!("{} {}", part("type"), part("id"))
        },
        str::to_owned,
    );
    clip(Some(js::trim(&text)), 160)
}

#[async_trait]
impl ProjectAiStore for DbProjectAiStore {
    async fn find_project(
        &self,
        workspace_id: &str,
        id: &str,
    ) -> Result<Option<projects::Model>, AppError> {
        Ok(projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace_id))
            .filter(projects::Column::Id.eq(id))
            .one(&self.db)
            .await?)
    }

    async fn gather(
        &self,
        project: &projects::Model,
        with_candidates: bool,
    ) -> Result<ProjectFacts, AppError> {
        let workspace_id = project.workspace_id.as_str();
        let milestone_rows = milestones::Entity::find()
            .filter(milestones::Column::WorkspaceId.eq(workspace_id))
            .filter(milestones::Column::ProjectId.eq(project.id.as_str()))
            .order_by_asc(milestones::Column::SortOrder)
            .limit(50)
            .all(&self.db)
            .await?;
        let issue_rows = issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::ProjectId.eq(project.id.as_str()))
            .order_by_desc(issues::Column::UpdatedAt)
            .limit(MAX_PROJECT_ISSUES)
            .all(&self.db)
            .await?;
        let issue_ids: Vec<String> = issue_rows.iter().map(|i| i.id.clone()).collect();
        let events = self.recent_events(workspace_id, &project.id, &issue_ids).await?;
        let candidates =
            if with_candidates { self.candidate_issues(workspace_id).await? } else { Vec::new() };

        let mut user_ids: Vec<String> = project.lead_id.iter().cloned().collect();
        user_ids.extend(issue_rows.iter().chain(&candidates).filter_map(|i| i.assignee_id.clone()));
        user_ids.sort();
        user_ids.dedup();
        let mut names: HashMap<String, String> = HashMap::new();
        if !user_ids.is_empty() {
            let rows: Vec<(String, String)> = users::Entity::find()
                .select_only()
                .column(users::Column::Id)
                .column(users::Column::Name)
                .filter(users::Column::Id.is_in(user_ids))
                .into_tuple()
                .all(&self.db)
                .await?;
            names.extend(rows);
        }

        let to_issue = |i: &issues::Model| FactsIssue {
            id: i.id.clone(),
            key: i.key.clone(),
            title: i.title.clone(),
            status: i.status.clone(),
            priority: i.priority.clone(),
            assignee_id: i.assignee_id.clone(),
            assignee: i.assignee_id.as_ref().and_then(|id| names.get(id).cloned()),
            milestone_ids: milestone_ids(&i.milestone_ids),
            updated_at: to_iso(&i.updated_at),
        };
        Ok(ProjectFacts {
            project: FactsProject {
                id: project.id.clone(),
                name: project.name.clone(),
                summary: project.summary.clone(),
                description: project.description.clone(),
                status: project.status.clone(),
                priority: project.priority.clone(),
                lead: project.lead_id.as_ref().and_then(|id| names.get(id).cloned()),
                start_date: project.start_date.as_ref().map(to_iso),
                target_date: project.target_date.as_ref().map(to_iso),
                created_at: to_iso(&project.created_at),
            },
            milestones: milestone_rows
                .iter()
                .map(|m| FactsMilestone {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    target_date: m.target_date.as_ref().map(to_iso),
                })
                .collect(),
            issues: issue_rows.iter().map(&to_issue).collect(),
            events: events
                .iter()
                .map(|e| FactsEvent {
                    at: to_iso(&e.at),
                    kind: e.r#type.clone(),
                    summary: event_summary(e),
                })
                .collect(),
            candidates: candidates.iter().map(&to_issue).collect(),
        })
    }
}
