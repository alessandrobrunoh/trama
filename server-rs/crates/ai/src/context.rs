//! What the assistant is told about the page the person is on
//! (`server/src/ai/ai-context.service.ts`).

use async_trait::async_trait;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use trama_auth::WorkspaceContext;
use trama_contracts::js;
use trama_core::AppError;
use trama_entities::{issues, projects};

use crate::dto::{ChatContext, ChatContextKind};

/// Who is chatting, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatScope {
    /// The workspace id.
    pub workspace_id: String,
    /// The workspace name.
    pub workspace_name: String,
    /// The person.
    pub user_id: Option<String>,
}

impl ChatScope {
    /// The scope of a `/w/{slug}` request.
    #[must_use]
    pub fn of(ctx: &WorkspaceContext) -> Self {
        Self {
            workspace_id: ctx.workspace.id.clone(),
            workspace_name: ctx.workspace.name.clone(),
            user_id: ctx.user_id.clone(),
        }
    }
}

/// Describes the page for the model.
#[async_trait]
pub trait PageContext: Send + Sync {
    /// `withTools`: the model can look records up itself, so no record lists are pre-loaded into
    /// the prompt.
    ///
    /// # Errors
    ///
    /// 404 when the issue or project named by the context does not exist in the workspace.
    async fn resolve(
        &self,
        scope: &ChatScope,
        context: Option<&ChatContext>,
        with_tools: bool,
    ) -> Result<String, AppError>;
}

/// [`PageContext`] over the database.
#[derive(Clone)]
pub struct DbPageContext {
    db: DatabaseConnection,
}

impl DbPageContext {
    /// Reads from `db`.
    #[must_use]
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    /// The caller's open issues, most urgent first. Titles only, never descriptions.
    async fn assigned_issues(
        &self,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<Vec<Value>, AppError> {
        let rank = |priority: &str| match priority {
            "urgent" => 0,
            "high" => 1,
            "medium" => 2,
            "low" => 3,
            _ => 4,
        };
        let mut items = issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .filter(issues::Column::AssigneeId.eq(user_id))
            .filter(issues::Column::Status.is_not_in(["done", "canceled"]))
            .order_by_desc(issues::Column::UpdatedAt)
            .limit(100)
            .all(&self.db)
            .await?;
        items.sort_by_key(|i| rank(&i.priority));
        Ok(items
            .into_iter()
            .take(25)
            .map(|i| {
                json!({
                    "key": i.key,
                    "title": i.title,
                    "status": i.status,
                    "priority": i.priority,
                    "kind": i.kind,
                })
            })
            .collect())
    }
}

#[async_trait]
impl PageContext for DbPageContext {
    async fn resolve(
        &self,
        scope: &ChatScope,
        context: Option<&ChatContext>,
        with_tools: bool,
    ) -> Result<String, AppError> {
        let Some(context) = context else {
            return Ok("No page data has been shared.".to_owned());
        };
        let workspace_id = scope.workspace_id.as_str();
        let base = json!({ "workspace": scope.workspace_name, "page": context.label });
        let with = |extra: Value| {
            let mut merged = base.clone();
            if let (Some(target), Value::Object(more)) = (merged.as_object_mut(), extra) {
                target.extend(more);
            }
            merged.to_string()
        };
        let id = context.id.as_deref().filter(|id| !id.is_empty());
        let Some(id) = id.filter(|_| context.kind != ChatContextKind::Page) else {
            if with_tools {
                return Ok(with(json!({
                    "note": "Only the page name is shared. Use the tools to look up any record.",
                })));
            }
            let mine = match &scope.user_id {
                Some(user) => self.assigned_issues(workspace_id, user).await?,
                None => Vec::new(),
            };
            return Ok(with(json!({
                "note": "Only the page name and the user’s own open issues (key, title, status, priority) are shared; no other workspace records are available.",
                "myOpenIssues": mine,
            })));
        };
        if context.kind == ChatContextKind::Issue {
            let item = issues::Entity::find()
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(
                    Condition::any().add(issues::Column::Id.eq(id)).add(issues::Column::Key.eq(id)),
                )
                .one(&self.db)
                .await?
                .ok_or_else(|| AppError::not_found("Issue not found"))?;
            let mut issue = json!({
                "key": item.key,
                "title": item.title,
                "status": item.status,
                "priority": item.priority,
                "kind": item.kind,
            });
            if let (Some(body), Some(map)) = (&item.body, issue.as_object_mut()) {
                map.insert("body".to_owned(), json!(js::truncate(body, 14_000)));
            }
            return Ok(with(json!({ "issue": issue })));
        }
        let item = projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace_id))
            .filter(projects::Column::Id.eq(id))
            .one(&self.db)
            .await?
            .ok_or_else(|| AppError::not_found("Project not found"))?;
        Ok(with(json!({
            "project": {
                "name": item.name,
                "key": item.key,
                "summary": item.summary,
                "status": item.status,
                "repository": item.repository,
            },
        })))
    }
}
