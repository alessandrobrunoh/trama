//! Writes an import into one workspace (`importers/import-sink.ts`, `TypeormImportSink`).
//!
//! Every query carries the workspace id, so a job can only ever see and touch its own
//! workspace's rows. Imported issues are written directly (no per-issue domain event): a
//! 5,000-issue import must not wake every open browser 5,000 times; the job emits its own events.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;

use async_trait::async_trait;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QuerySelect, Set, Statement, TransactionTrait, Unchanged,
};
use serde_json::json;
use trama_common::util::is_unique_violation;
use trama_contracts::common::ActorRef;
use trama_contracts::imports::{ExternalProvider, ExternalRef, ImportMapping, ImportTarget};
use trama_contracts::js;
use trama_contracts::labels::{
    LABEL_SWATCHES, StoredLabelScope, WorkspaceLabel, resolve_label_catalog,
};
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{comments, import_links, issues, milestones, projects, workspaces};
use trama_external_identities::ResolveOptions;
use trama_issues::keys::{allocate_issue_numbers, issue_key_prefix};
use trama_milestones::NewMilestone;
use trama_projects::NewProject;

use crate::engine::{CreateOutcome, ImportError, ImportSink, NewComment};
use crate::mapping::{NewIssue, ResolvedPlan, label_color, label_name, match_by_name};
use crate::types::Discovery;

/// Most custom (non-template) labels a workspace keeps.
const CUSTOM_LABELS_MAX: usize = 100;
/// Longest name of a created project or milestone.
const NAME_MAX: usize = 120;
const EXTERNAL_REF_INDEX: &str = "UQ_issues_external_ref";

/// What `import_links.kind` holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinkKind {
    Project,
    Milestone,
    Label,
}

impl LinkKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Milestone => "milestone",
            Self::Label => "label",
        }
    }
}

/// The sink of one job: one workspace, one provider, written on behalf of one actor.
pub struct PgImportSink {
    state: AppState,
    workspace_id: String,
    actor: ActorRef,
    job_id: String,
    provider: ExternalProvider,
    /// Whether assignees are looked up through external identities (GitHub only; Linear's
    /// people carry no login to resolve).
    identities: bool,
    /// The host those identities are looked up at: the credential's base URL.
    host: Option<String>,
}

/// What can fail while writing one issue: the unique index has to be told apart.
enum WriteFailure {
    Db(DbErr),
    App(AppError),
}

impl From<DbErr> for WriteFailure {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

impl From<AppError> for WriteFailure {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}

impl PgImportSink {
    /// A sink for job `job_id` of `workspace_id`. `base_url` is the credential's GitHub base
    /// URL; assignees the mapping does not mention are resolved through the members' external
    /// identities at that host (GitHub only).
    #[must_use]
    pub fn new(
        state: &AppState,
        workspace_id: &str,
        actor: ActorRef,
        job_id: &str,
        provider: ExternalProvider,
        base_url: Option<String>,
    ) -> Self {
        Self {
            state: state.clone(),
            workspace_id: workspace_id.to_owned(),
            actor,
            job_id: job_id.to_owned(),
            provider,
            identities: provider == ExternalProvider::Github,
            host: base_url,
        }
    }

    // ───────────── links ─────────────

    async fn link(&self, kind: LinkKind, external_id: &str) -> Result<Option<String>, ImportError> {
        let row = import_links::Entity::find_by_id((
            self.workspace_id.clone(),
            self.provider.as_str().to_owned(),
            kind.as_str().to_owned(),
            external_id.to_owned(),
        ))
        .one(&self.state.db)
        .await?;
        Ok(row.map(|row| row.trama_id))
    }

    async fn save_link<C: ConnectionTrait>(
        &self,
        conn: &C,
        kind: LinkKind,
        external_id: &str,
        trama_id: &str,
    ) -> Result<(), DbErr> {
        conn.execute_raw(Statement::from_sql_and_values(
            conn.get_database_backend(),
            r#"INSERT INTO "import_links" ("workspaceId","provider","kind","externalId","tramaId","jobId")
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT ("workspaceId","provider","kind","externalId")
               DO UPDATE SET "tramaId" = EXCLUDED."tramaId", "jobId" = EXCLUDED."jobId""#,
            [
                self.workspace_id.clone().into(),
                self.provider.as_str().into(),
                kind.as_str().into(),
                external_id.into(),
                trama_id.into(),
                self.job_id.clone().into(),
            ],
        ))
        .await?;
        Ok(())
    }

    async fn resolve_target<E, EF, C, CF>(
        &self,
        kind: LinkKind,
        label: &str,
        external_id: &str,
        target: Option<&ImportTarget>,
        exists: E,
        create: C,
    ) -> Result<Option<String>, ImportError>
    where
        E: Fn(String) -> EF,
        EF: Future<Output = Result<bool, ImportError>>,
        C: FnOnce() -> CF,
        CF: Future<Output = Result<String, ImportError>>,
    {
        match target {
            None | Some(ImportTarget::Skip) => Ok(None),
            Some(ImportTarget::Map { id }) => {
                if exists(id.clone()).await? {
                    Ok(Some(id.clone()))
                } else {
                    Err(ImportError::fatal(format!("The {label} you mapped to no longer exists")))
                }
            }
            Some(ImportTarget::Create) => {
                if let Some(linked) = self.link(kind, external_id).await?
                    && exists(linked.clone()).await?
                {
                    return Ok(Some(linked));
                }
                let id = create().await?;
                self.save_link(&self.state.db, kind, external_id, &id).await?;
                Ok(Some(id))
            }
        }
    }

    async fn project_exists(&self, id: String) -> Result<bool, ImportError> {
        Ok(projects::Entity::find()
            .filter(projects::Column::Id.eq(id))
            .filter(projects::Column::WorkspaceId.eq(self.workspace_id.as_str()))
            .count(&self.state.db)
            .await?
            > 0)
    }

    async fn milestone_exists(&self, id: String, project_id: &str) -> Result<bool, ImportError> {
        Ok(milestones::Entity::find()
            .filter(milestones::Column::Id.eq(id))
            .filter(milestones::Column::WorkspaceId.eq(self.workspace_id.as_str()))
            .filter(milestones::Column::ProjectId.eq(project_id))
            .count(&self.state.db)
            .await?
            > 0)
    }

    // ───────────── plan ─────────────

    async fn resolve_projects(
        &self,
        discovery: &Discovery,
        mapping: &ImportMapping,
        plan: &mut ResolvedPlan,
    ) -> Result<(), ImportError> {
        let workspace = self.workspace_id.as_str();
        let existing = projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace))
            .all(&self.state.db)
            .await?;
        for p in &discovery.projects {
            let resolved = self
                .resolve_target(
                    LinkKind::Project,
                    "project",
                    &p.id,
                    mapping.projects.get(&p.id),
                    |id| self.project_exists(id),
                    || async {
                        // A project with this name may already exist from an earlier run whose
                        // link was lost: reuse it.
                        if let Some(same) = match_by_name(&p.name, &existing, |m| &m.name) {
                            return Ok(same.id.clone());
                        }
                        let created = trama_projects::service::create(
                            &self.state,
                            workspace,
                            &self.actor,
                            NewProject {
                                name: js::truncate(&p.name, NAME_MAX).to_owned(),
                                color: label_color(p.color.as_deref()),
                                ..NewProject::default()
                            },
                        )
                        .await?;
                        Ok(created.id)
                    },
                )
                .await?;
            plan.projects.insert(p.id.clone(), resolved);
        }
        Ok(())
    }

    async fn resolve_milestones(
        &self,
        discovery: &Discovery,
        plan: &mut ResolvedPlan,
    ) -> Result<(), ImportError> {
        let workspace = self.workspace_id.as_str();
        for m in &discovery.milestones {
            let project_id =
                m.project_id.as_ref().and_then(|id| plan.projects.get(id).cloned().flatten());
            let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
                plan.milestones.insert(m.id.clone(), None);
                continue;
            };
            let name = js::truncate(&m.name, NAME_MAX).to_owned();
            let resolved = self
                .resolve_target(
                    LinkKind::Milestone,
                    "milestone",
                    &m.id,
                    Some(&ImportTarget::Create),
                    |id| self.milestone_exists(id, &project_id),
                    || async {
                        let same = milestones::Entity::find()
                            .filter(milestones::Column::WorkspaceId.eq(workspace))
                            .filter(milestones::Column::ProjectId.eq(project_id.as_str()))
                            .filter(milestones::Column::Name.eq(name.as_str()))
                            .one(&self.state.db)
                            .await?;
                        if let Some(same) = same {
                            return Ok(same.id);
                        }
                        let target_date = match m.due_on.as_deref() {
                            None => None,
                            Some(due) => {
                                Some(trama_milestones::dates::parse(due).ok_or_else(|| {
                                    ImportError::Failed("Invalid time value".into())
                                })?)
                            }
                        };
                        let created = trama_milestones::service::create(
                            &self.state,
                            workspace,
                            &self.actor,
                            NewMilestone {
                                project_id: project_id.clone(),
                                name: name.clone(),
                                description: m.description.clone(),
                                target_date,
                                sort_order: None,
                            },
                        )
                        .await?;
                        Ok(created.id)
                    },
                )
                .await?;
            plan.milestones.insert(m.id.clone(), resolved);
        }
        Ok(())
    }

    /// Labels live in the workspace settings, so all new ones are written in a single
    /// transaction.
    async fn resolve_labels(
        &self,
        discovery: &Discovery,
        mapping: &ImportMapping,
    ) -> Result<BTreeMap<String, Option<String>>, ImportError> {
        let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut links: HashMap<String, String> = HashMap::new();
        for l in &discovery.labels {
            if matches!(mapping.labels.get(&l.id), Some(ImportTarget::Create))
                && let Some(id) = self.link(LinkKind::Label, &l.id).await?
            {
                links.insert(l.id.clone(), id);
            }
        }
        let txn = self.state.db.begin().await?;
        let workspace = workspaces::Entity::find_by_id(self.workspace_id.as_str())
            .lock_exclusive()
            .one(&txn)
            .await?
            .ok_or_else(|| ImportError::Failed("Workspace not found".into()))?;
        let mut catalog = resolve_label_catalog(workspace.settings.get("labels"));
        let mut changed = false;
        for l in &discovery.labels {
            let resolved = match mapping.labels.get(&l.id) {
                None | Some(ImportTarget::Skip) => None,
                Some(ImportTarget::Map { id }) => {
                    if !catalog.iter().any(|c| &c.id == id) {
                        return Err(ImportError::fatal("A label you mapped to no longer exists"));
                    }
                    Some(id.clone())
                }
                Some(ImportTarget::Create) => {
                    let name = label_name(&l.name);
                    let existing = links
                        .get(&l.id)
                        .and_then(|linked| catalog.iter().find(|c| &c.id == linked))
                        .or_else(|| {
                            catalog.iter().find(|c| c.name.to_lowercase() == name.to_lowercase())
                        })
                        .map(|c| c.id.clone());
                    let id = if let Some(id) = existing {
                        Some(id)
                    } else if catalog.iter().filter(|c| !c.template).count() >= CUSTOM_LABELS_MAX {
                        None
                    } else {
                        let used: HashSet<&str> =
                            catalog.iter().map(|c| c.color.as_str()).collect();
                        let color = label_color(l.color.as_deref())
                            .or_else(|| {
                                LABEL_SWATCHES
                                    .iter()
                                    .find(|c| !used.contains(**c))
                                    .map(|c| (*c).to_owned())
                            })
                            .unwrap_or_else(|| {
                                LABEL_SWATCHES[catalog.len() % LABEL_SWATCHES.len()].to_owned()
                            });
                        let label = WorkspaceLabel {
                            id: uid("lb"),
                            name,
                            color,
                            template: false,
                            scope: StoredLabelScope::Issue,
                            archived: None,
                        };
                        let id = label.id.clone();
                        catalog.push(label);
                        changed = true;
                        Some(id)
                    };
                    if let Some(id) = &id {
                        self.save_link(&txn, LinkKind::Label, &l.id, id).await?;
                    }
                    id
                }
            };
            out.insert(l.id.clone(), resolved);
        }
        if changed {
            let mut settings = workspace.settings.clone();
            if !settings.is_object() {
                settings = json!({});
            }
            settings["labels"] =
                serde_json::to_value(&catalog).map_err(|e| ImportError::Failed(e.to_string()))?;
            workspaces::ActiveModel {
                id: Unchanged(workspace.id.clone()),
                settings: Set(settings),
                ..Default::default()
            }
            .update(&txn)
            .await?;
        }
        txn.commit().await?;
        Ok(out)
    }

    // ───────────── issues ─────────────

    async fn insert_issue(&self, issue: &NewIssue) -> Result<(), WriteFailure> {
        let txn = self.state.db.begin().await?;
        let workspace = self.workspace_id.as_str();
        let prefix = issue_key_prefix(&txn, workspace, issue.project_id.as_deref()).await?;
        let number = allocate_issue_numbers(&txn, workspace, &prefix, 1).await?[0];
        issues::ActiveModel {
            id: Set(uid("in")),
            workspace_id: Set(workspace.to_owned()),
            key: Set(format!("{prefix}-{number}")),
            number: Set(number),
            kind: Set(issue.kind.as_str().to_owned()),
            title: Set(issue.title.clone()),
            body: Set(issue.body.clone()),
            source: Set(issue.source.as_str().to_owned()),
            reporter_name: Set(issue.reporter_name.clone()),
            reporter_id: Set(None),
            priority: Set(issue.priority.as_str().to_owned()),
            status: Set(issue.status.as_str().to_owned()),
            duplicate_of_id: Set(None),
            external_url: Set(Some(issue.external_ref.url.clone())),
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
            external_ref: Set(Some(
                serde_json::to_value(&issue.external_ref)
                    .map_err(|e| DbErr::Custom(e.to_string()))?,
            )),
            parent_id: Set(None),
            thread_url: Set(None),
            due_date: Set(None),
        }
        .insert(&txn)
        .await?;
        txn.commit().await?;
        Ok(())
    }
}

#[async_trait]
impl ImportSink for PgImportSink {
    async fn resolve_plan(
        &self,
        discovery: &Discovery,
        mapping: &ImportMapping,
    ) -> Result<ResolvedPlan, ImportError> {
        let mut plan =
            ResolvedPlan { statuses: mapping.statuses.clone(), ..ResolvedPlan::default() };

        // `mapping.teams` names Linear teams. There is no workspace team to create or attach.
        for t in &discovery.teams {
            plan.teams.insert(t.id.clone(), None);
        }
        self.resolve_projects(discovery, mapping, &mut plan).await?;
        self.resolve_milestones(discovery, &mut plan).await?;
        plan.labels.extend(self.resolve_labels(discovery, mapping).await?);
        for u in &discovery.users {
            let resolved = if let Some(mapped) = mapping.users.get(&u.id) {
                mapped.clone()
            } else if let Some(login) =
                u.login.as_deref().filter(|l| self.identities && !l.is_empty())
            {
                trama_external_identities::service::resolve_member_by_login(
                    &self.state.db,
                    &self.workspace_id,
                    "github",
                    self.host.as_deref(),
                    Some(login),
                    ResolveOptions::default(),
                )
                .await?
            } else {
                None
            };
            plan.users.insert(u.id.clone(), resolved);
        }
        Ok(plan)
    }

    async fn existing_issues(
        &self,
        provider: ExternalProvider,
        ids: &[String],
    ) -> Result<HashMap<String, String>, ImportError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = self
            .state
            .db
            .query_all_raw(Statement::from_sql_and_values(
                self.state.db.get_database_backend(),
                r#"SELECT "id", "externalRef"->>'id' AS "ext" FROM "issues"
                   WHERE "workspaceId" = $1 AND "externalRef"->>'provider' = $2
                     AND "externalRef"->>'id' = ANY($3::text[])"#,
                [self.workspace_id.clone().into(), provider.as_str().into(), ids.to_vec().into()],
            ))
            .await?;
        let mut found = HashMap::new();
        for row in rows {
            found.insert(row.try_get::<String>("", "ext")?, row.try_get::<String>("", "id")?);
        }
        Ok(found)
    }

    async fn create_issue(&self, issue: &NewIssue) -> Result<CreateOutcome, ImportError> {
        match self.insert_issue(issue).await {
            Ok(()) => Ok(CreateOutcome::Created),
            Err(WriteFailure::Db(e))
                if is_unique_violation(&e) && e.to_string().contains(EXTERNAL_REF_INDEX) =>
            {
                Ok(CreateOutcome::Exists)
            }
            Err(WriteFailure::Db(e)) => Err(e.into()),
            Err(WriteFailure::App(e)) => Err(e.into()),
        }
    }

    async fn refresh_ref(
        &self,
        provider: ExternalProvider,
        id: &str,
        reference: &ExternalRef,
    ) -> Result<(), ImportError> {
        self.state
            .db
            .execute_raw(Statement::from_sql_and_values(
                self.state.db.get_database_backend(),
                r#"UPDATE "issues" SET "externalRef" = "externalRef" || jsonb_build_object('state', $4::text, 'stateType', $5::text, 'syncedAt', $6::text, 'key', $7::text, 'url', $8::text)
                   WHERE "workspaceId" = $1 AND "externalRef"->>'provider' = $2 AND "externalRef"->>'id' = $3"#,
                [
                    self.workspace_id.clone().into(),
                    provider.as_str().into(),
                    id.into(),
                    reference.state.clone().into(),
                    reference.state_type.map(|t| t.as_str().to_owned()).into(),
                    reference.synced_at.clone().into(),
                    reference.key.clone().into(),
                    reference.url.clone().into(),
                ],
            ))
            .await?;
        Ok(())
    }

    async fn existing_comments(
        &self,
        provider: ExternalProvider,
        ids: &[String],
    ) -> Result<HashSet<String>, ImportError> {
        if ids.is_empty() {
            return Ok(HashSet::new());
        }
        let rows = self
            .state
            .db
            .query_all_raw(Statement::from_sql_and_values(
                self.state.db.get_database_backend(),
                r#"SELECT "externalId" FROM "import_links"
                   WHERE "workspaceId" = $1 AND "provider" = $2 AND "kind" = 'comment' AND "externalId" = ANY($3::text[])"#,
                [self.workspace_id.clone().into(), provider.as_str().into(), ids.to_vec().into()],
            ))
            .await?;
        let mut found = HashSet::new();
        for row in rows {
            found.insert(row.try_get::<String>("", "externalId")?);
        }
        Ok(found)
    }

    async fn create_comment(
        &self,
        provider: ExternalProvider,
        comment: &NewComment,
    ) -> Result<bool, ImportError> {
        let txn = self.state.db.begin().await?;
        let id = uid("cm");
        // The link row is the idempotency key: whoever inserts it first writes the comment.
        let claimed = txn
            .query_all_raw(Statement::from_sql_and_values(
                txn.get_database_backend(),
                r#"INSERT INTO "import_links" ("workspaceId","provider","kind","externalId","tramaId","jobId")
                   VALUES ($1,$2,'comment',$3,$4,$5)
                   ON CONFLICT DO NOTHING RETURNING "externalId""#,
                [
                    self.workspace_id.clone().into(),
                    provider.as_str().into(),
                    comment.external_id.clone().into(),
                    id.clone().into(),
                    self.job_id.clone().into(),
                ],
            ))
            .await?;
        if claimed.is_empty() {
            txn.commit().await?;
            return Ok(false);
        }
        let at = comment.created_at.fixed_offset();
        comments::ActiveModel {
            id: Set(id),
            workspace_id: Set(self.workspace_id.clone()),
            subject: Set(json!({ "type": "issue", "id": comment.issue_id })),
            author: Set(serde_json::to_value(&self.actor)
                .map_err(|e| ImportError::Failed(e.to_string()))?),
            body: Set(comment.body.clone()),
            created_at: Set(at),
            updated_at: Set(at),
        }
        .insert(&txn)
        .await?;
        txn.commit().await?;
        Ok(true)
    }
}
