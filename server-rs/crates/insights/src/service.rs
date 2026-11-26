//! Loading what the report is made of (`InsightsService.load`): the visible issues of the
//! workspace (or one project), their open pull requests, the overdue milestones and the events
//! of the range.
//!
//! Everything derives from the issues the caller may see: their project must be inside the
//! request's member access.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, QueryResult, Statement, Value};
use serde_json::json;
use trama_auth::WorkspaceContext;
use trama_auth::member_access::project_hidden;
use trama_contracts::insights::{InsightSignal, InsightSignalId, InsightsReport};
use trama_core::AppError;

use crate::report::{self, ArtifactRow, EventRow, Inputs, IssueRow, MilestoneRow};

/// Default range, days.
pub const DEFAULT_DAYS: i64 = 30;
/// Default stale threshold, days.
pub const DEFAULT_STALE_DAYS: i64 = 7;
/// Default items per signal in a report.
pub const DEFAULT_LIMIT: usize = 25;
/// Default items on a single signal (`GET /insights/signals/{id}`).
pub const DEFAULT_SIGNAL_LIMIT: usize = 100;

/// The knobs of a report.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Params {
    /// Range in days (30).
    pub days: Option<u32>,
    /// Only this project's issues.
    pub project_id: Option<String>,
    /// Stale threshold in days (7).
    pub stale_days: Option<u32>,
    /// Items per signal (25).
    pub limit: Option<u32>,
}

/// The report of the workspace of `ctx` (`InsightsService.report`).
///
/// # Errors
///
/// 404 `Project not found` for a project filter that does not exist or that the caller cannot
/// reach; database errors.
pub async fn report(
    db: &DatabaseConnection,
    ctx: &WorkspaceContext,
    params: &Params,
) -> Result<InsightsReport, AppError> {
    load(db, ctx, params, DEFAULT_LIMIT).await
}

/// One signal of the report (`InsightsService.signal`); items default to 100.
///
/// # Errors
///
/// As [`report`].
pub async fn signal(
    db: &DatabaseConnection,
    ctx: &WorkspaceContext,
    id: InsightSignalId,
    params: &Params,
) -> Result<InsightSignal, AppError> {
    let report = load(db, ctx, params, DEFAULT_SIGNAL_LIMIT).await?;
    report
        .signals
        .into_iter()
        .find(|signal| signal.id == id)
        .ok_or_else(|| AppError::internal("the report has no such signal"))
}

fn statement(sql: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(sea_orm::DbBackend::Postgres, sql, values)
}

/// A list of strings bound as one JSON parameter, read back with [`any_of`].
fn json_list<'a>(ids: impl IntoIterator<Item = &'a String>) -> Value {
    json!(ids.into_iter().collect::<Vec<_>>()).into()
}

/// `$n` (a [`json_list`]) as an array: no limit on how many ids.
fn any_of(n: usize) -> String {
    format!("ANY(ARRAY(SELECT jsonb_array_elements_text(${n}::jsonb)))")
}

/// Everything about the window and the caller's scope that the queries need.
struct Window<'a> {
    workspace_id: &'a str,
    project_id: Option<&'a str>,
    from: DateTime<Utc>,
    now: DateTime<Utc>,
    lookback: DateTime<Utc>,
}

async fn check_project(
    db: &DatabaseConnection,
    ctx: &WorkspaceContext,
    project_id: &str,
) -> Result<(), AppError> {
    let project = db
        .query_one_raw(statement(
            r#"SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2"#,
            vec![project_id.into(), ctx.workspace.id.as_str().into()],
        ))
        .await?;
    if project.is_none() || project_hidden(ctx.access.as_ref(), Some(project_id)) {
        return Err(AppError::not_found("Project not found"));
    }
    Ok(())
}

/// Open issues and the ones completed since the lookback, limited to the caller's projects.
async fn load_issues(
    db: &DatabaseConnection,
    ctx: &WorkspaceContext,
    window: &Window<'_>,
) -> Result<Vec<IssueRow>, AppError> {
    let mut values: Vec<Value> = vec![window.workspace_id.into()];
    let mut project_filter = String::new();
    if let Some(project_id) = window.project_id {
        values.push(project_id.into());
        project_filter = format!(r#"AND i."projectId" = ${}"#, values.len());
    }
    values.push(window.lookback.into());
    let sql = format!(
        r#"SELECT i.id, i.key, i.title, i.status, i."projectId", i."assigneeId",
                  i."createdAt", i."updatedAt", i."startedAt", i."completedAt"
             FROM issues i WHERE i."workspaceId" = $1 {project_filter}
              AND (i.status IN ('backlog','todo','in_progress','in_review') OR i."completedAt" >= ${})
            ORDER BY i."createdAt", i.id"#,
        values.len()
    );
    let rows = db.query_all_raw(statement(&sql, values)).await?;
    let mut issues = Vec::with_capacity(rows.len());
    for row in &rows {
        let issue = IssueRow {
            id: row.try_get("", "id")?,
            key: row.try_get("", "key")?,
            title: row.try_get("", "title")?,
            status: row.try_get("", "status")?,
            project_id: row.try_get("", "projectId")?,
            assignee_id: row.try_get("", "assigneeId")?,
            created_at: row.try_get("", "createdAt")?,
            updated_at: row.try_get("", "updatedAt")?,
            started_at: row.try_get("", "startedAt")?,
            completed_at: row.try_get("", "completedAt")?,
        };
        if !project_hidden(ctx.access.as_ref(), issue.project_id.as_deref()) {
            issues.push(issue);
        }
    }
    Ok(issues)
}

/// Open pull and merge requests of the given issues.
async fn load_artifacts(
    db: &DatabaseConnection,
    workspace_id: &str,
    issue_ids: &[String],
) -> Result<Vec<ArtifactRow>, AppError> {
    let sql = format!(
        r#"SELECT a.id, a.title, a.ci, a.review, a."updatedAt"
             FROM artifacts a JOIN issues i ON i.id = a."issueId" AND i."workspaceId" = a."workspaceId"
            WHERE a."workspaceId" = $1 AND a."issueId" = {}
              AND a.kind IN ('pull_request', 'merge_request') AND a.state = 'open'
            ORDER BY a."createdAt", a.id"#,
        any_of(2)
    );
    let rows =
        db.query_all_raw(statement(&sql, vec![workspace_id.into(), json_list(issue_ids)])).await?;
    rows.iter()
        .map(|row| {
            Ok(ArtifactRow {
                id: row.try_get("", "id")?,
                title: row.try_get("", "title")?,
                ci: row.try_get("", "ci")?,
                review: row.try_get("", "review")?,
                updated_at: row.try_get("", "updatedAt")?,
            })
        })
        .collect::<Result<_, DbErr>>()
        .map_err(Into::into)
}

/// Milestones past their target date with their open issue count (every issue of the
/// workspace that lists the milestone, visible or not).
async fn load_milestones(
    db: &DatabaseConnection,
    window: &Window<'_>,
) -> Result<Vec<MilestoneRow>, AppError> {
    let rows = db
        .query_all_raw(statement(
            r#"SELECT m.id, m.name, m."projectId", m."targetDate", p.status AS "projectStatus",
                      count(i.id) FILTER (WHERE i.status IN ('backlog','todo','in_progress','in_review'))::int AS "openIssues"
                 FROM milestones m JOIN projects p ON p.id = m."projectId"
                 LEFT JOIN issues i ON i."workspaceId" = m."workspaceId" AND i."milestoneIds" ? m.id
                WHERE m."workspaceId" = $1 AND m."targetDate" < now()
                  AND ($2::text IS NULL OR m."projectId" = $2)
                GROUP BY m.id, p.id
                ORDER BY m."targetDate", m.id"#,
            vec![window.workspace_id.into(), window.project_id.map(str::to_owned).into()],
        ))
        .await?;
    rows.iter()
        .map(|row| {
            let open: i32 = row.try_get("", "openIssues")?;
            Ok(MilestoneRow {
                id: row.try_get("", "id")?,
                name: row.try_get("", "name")?,
                project_id: row.try_get("", "projectId")?,
                target_date: row.try_get("", "targetDate")?,
                project_status: row.try_get("", "projectStatus")?,
                open_issues: i64::from(open),
            })
        })
        .collect::<Result<_, DbErr>>()
        .map_err(Into::into)
}

/// Events of people and agents about the given issues in the range, one row per actor and type.
async fn load_events(
    db: &DatabaseConnection,
    window: &Window<'_>,
    issue_ids: &[String],
) -> Result<Vec<EventRow>, AppError> {
    let sql = format!(
        r#"SELECT e.actor->>'id' AS "actorId", e.actor->>'type' AS "actorType", e.type,
                  max(e.at) AS "lastAt", count(*)::int AS events
             FROM domain_events e
            WHERE e."workspaceId" = $1 AND e.at >= $2 AND e.at < $3
              AND e.subject->>'id' = {}
              AND e.actor->>'type' IN ('user', 'agent')
            GROUP BY 1, 2, 3
            ORDER BY 1, 2, 3"#,
        any_of(4)
    );
    let values = vec![
        window.workspace_id.into(),
        window.from.into(),
        window.now.into(),
        json_list(issue_ids),
    ];
    let rows = db.query_all_raw(statement(&sql, values)).await?;
    rows.iter()
        .map(|row| {
            let events: i32 = row.try_get("", "events")?;
            Ok(EventRow {
                actor_id: row.try_get("", "actorId")?,
                actor_type: row.try_get("", "actorType")?,
                kind: row.try_get("", "type")?,
                last_at: row.try_get("", "lastAt")?,
                events: i64::from(events),
            })
        })
        .collect::<Result<_, DbErr>>()
        .map_err(Into::into)
}

/// `id → name`; the first row of an id wins (people are listed before agents).
fn names(rows: &[QueryResult]) -> Result<HashMap<String, String>, DbErr> {
    let mut out = HashMap::new();
    for row in rows {
        let id: String = row.try_get("", "id")?;
        out.entry(id).or_insert(row.try_get("", "name")?);
    }
    Ok(out)
}

/// Names of the people and agents behind the events.
async fn load_actor_names(
    db: &DatabaseConnection,
    events: &[EventRow],
) -> Result<HashMap<String, String>, AppError> {
    if events.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_of = |kind: &str| -> HashSet<String> {
        events.iter().filter(|e| e.actor_type == kind).filter_map(|e| e.actor_id.clone()).collect()
    };
    let (users, agents) = (ids_of("user"), ids_of("agent"));
    let sql = format!(
        "SELECT id, name FROM users WHERE id = {}
         UNION ALL SELECT id, name FROM agents WHERE id = {}",
        any_of(1),
        any_of(2)
    );
    let rows =
        db.query_all_raw(statement(&sql, vec![json_list(&users), json_list(&agents)])).await?;
    Ok(names(&rows)?)
}

/// Names of the people with in-flight work.
async fn load_assignee_names(
    db: &DatabaseConnection,
    issues: &[IssueRow],
) -> Result<HashMap<String, String>, AppError> {
    let assignees: HashSet<String> = issues
        .iter()
        .filter(|issue| issue.status == "in_progress" || issue.status == "in_review")
        .filter_map(|issue| issue.assignee_id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    if assignees.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = format!("SELECT id, name FROM users WHERE id = {}", any_of(1));
    let rows = db.query_all_raw(statement(&sql, vec![json_list(&assignees)])).await?;
    Ok(names(&rows)?)
}

async fn load(
    db: &DatabaseConnection,
    ctx: &WorkspaceContext,
    params: &Params,
    default_limit: usize,
) -> Result<InsightsReport, AppError> {
    let days = params.days.map_or(DEFAULT_DAYS, i64::from);
    let now = Utc::now();
    let window = Window {
        workspace_id: ctx.workspace.id.as_str(),
        // `?projectId=` is no filter
        project_id: params.project_id.as_deref().filter(|id| !id.is_empty()),
        from: now - Duration::days(days),
        now,
        lookback: now - Duration::days((days * 2).max(90)),
    };
    if let Some(project_id) = window.project_id {
        check_project(db, ctx, project_id).await?;
    }

    // all report data derives from these issues
    let issues = load_issues(db, ctx, &window).await?;
    let issue_ids: Vec<String> = issues.iter().map(|issue| issue.id.clone()).collect();
    let artifacts = if issue_ids.is_empty() {
        Vec::new()
    } else {
        load_artifacts(db, window.workspace_id, &issue_ids).await?
    };
    let milestones = load_milestones(db, &window).await?;
    let events = if issue_ids.is_empty() {
        Vec::new()
    } else {
        load_events(db, &window, &issue_ids).await?
    };
    let actor_names = load_actor_names(db, &events).await?;
    let user_names = load_assignee_names(db, &issues).await?;

    Ok(report::build(&Inputs {
        now,
        days,
        stale_days: params.stale_days.map_or(DEFAULT_STALE_DAYS, i64::from),
        limit: params.limit.map_or(default_limit, |n| n as usize),
        project_id: window.project_id.map(str::to_owned),
        issues,
        artifacts,
        milestones,
        events,
        actor_names,
        user_names,
    }))
}
