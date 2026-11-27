//! Paginated GitHub issue import and resumable job execution.
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde_json::{Value, json};
use trama_core::{AppError, AppState};
use trama_entities::import_jobs;
use trama_integrations::{Http, HttpRequest, HttpResponse};

use crate::sink::{ImportIssue, ImportSink};

const PAGE_SIZE: usize = 100;

/// Runs a GitHub job from its persisted page cursor. Every page is persisted before moving on;
/// replay after a crash is safe because the sink enforces external-reference uniqueness.
pub async fn execute_github_job(
    state: &AppState,
    job_id: &str,
    token: Option<&str>,
) -> Result<(), AppError> {
    let job = import_jobs::Entity::find_by_id(job_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Import", job_id))?;
    if job.provider != "github" {
        return Err(AppError::bad_request("Import job is not a GitHub job"));
    }
    let repo = job
        .source
        .get("repository")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("GitHub import is missing its repository"))?;
    let base = job
        .credential
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.github.com");
    let api = if base.ends_with("/api/v3") {
        base.to_owned()
    } else if base == "https://api.github.com" {
        base.to_owned()
    } else {
        format!("{base}/api/v3")
    };
    let mut page =
        job.cursor.as_ref().and_then(|v| v.get("page")).and_then(Value::as_u64).unwrap_or(1);
    let mut progress = job.progress.clone();
    let mut created = progress.get("created").and_then(Value::as_u64).unwrap_or(0);
    let mut skipped = progress.get("skipped").and_then(Value::as_u64).unwrap_or(0);
    let mut processed = progress.get("processed").and_then(Value::as_u64).unwrap_or(0);
    loop {
        let latest = import_jobs::Entity::find_by_id(job_id)
            .one(&state.db)
            .await?
            .ok_or_else(|| AppError::entity_not_found("Import", job_id))?;
        if latest.cancel_requested {
            let mut update: import_jobs::ActiveModel = latest.into();
            update.status = Set("canceled".into());
            update.finished_at = Set(Some(Utc::now().into()));
            update.heartbeat_at = Set(None);
            update.update(&state.db).await?;
            return Ok(());
        }
        let issue_state =
            if job.options.get("includeClosed").and_then(Value::as_bool) == Some(false) {
                "open"
            } else {
                "all"
            };
        let request = github_request(
            format!(
                "{api}/repos/{repo}/issues?state={issue_state}&per_page={PAGE_SIZE}&page={page}"
            ),
            token,
        );
        let response = Http::of(state).request(request).await.map_err(|e| {
            AppError::new(
                StatusCode::BAD_GATEWAY,
                format!("GitHub Issues is unreachable: {}", redact(&e.to_string(), token)),
            )
        })?;
        ensure_github_ok(&response, token)?;
        let issues = response.json.as_array().ok_or_else(|| {
            AppError::bad_request("GitHub returned an unexpected issues response")
        })?;
        let sink = ImportSink::new(&state.db, &job.workspace_id, job_id);
        for raw in issues.iter().filter(|v| v.get("pull_request").is_none()) {
            processed += 1;
            let Some(issue) = convert_issue(raw) else {
                skipped += 1;
                continue;
            };
            if sink.create_issue("github", &issue).await? {
                created += 1;
            } else {
                skipped += 1;
            }
        }
        page += 1;
        let is_done = issues.len() < PAGE_SIZE;
        progress = json!({"phase": if is_done {"done"} else {"issues"}, "processed":processed,
            "created":created, "skipped":skipped, "failed":0, "comments":0});
        let latest = import_jobs::Entity::find_by_id(job_id)
            .one(&state.db)
            .await?
            .ok_or_else(|| AppError::entity_not_found("Import", job_id))?;
        let mut update: import_jobs::ActiveModel = latest.into();
        update.progress = Set(progress.clone());
        update.cursor =
            Set(if is_done { None } else { Some(json!({"phase":"issues","page":page})) });
        update.heartbeat_at = Set(Some(Utc::now().into()));
        if is_done {
            update.status = Set("completed".into());
            update.finished_at = Set(Some(Utc::now().into()));
        }
        update.update(&state.db).await?;
        if is_done {
            return Ok(());
        }
    }
}

fn github_request(url: String, token: Option<&str>) -> HttpRequest {
    let mut req = HttpRequest::get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "trama");
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    req
}

fn ensure_github_ok(response: &HttpResponse, token: Option<&str>) -> Result<(), AppError> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    let message =
        response.json.get("message").and_then(Value::as_str).unwrap_or("request rejected");
    let message = redact(message, token);
    if response.status == 429
        || response.status == 403 && response.headers.contains_key("x-ratelimit-remaining")
    {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "GitHub Issues rate limit reached",
        ));
    }
    if matches!(response.status, 401 | 403 | 404) {
        return Err(AppError::bad_request(format!(
            "GitHub Issues rejected the request ({message})"
        )));
    }
    Err(AppError::new(StatusCode::BAD_GATEWAY, format!("GitHub Issues failed: {message}")))
}

fn redact(message: &str, token: Option<&str>) -> String {
    token
        .filter(|t| t.len() >= 6)
        .map_or_else(|| message.to_owned(), |t| message.replace(t, "[redacted]"))
}

fn date(value: Option<&str>, fallback: DateTime<Utc>) -> DateTime<Utc> {
    value
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map_or(fallback, |d| d.with_timezone(&Utc))
}

fn convert_issue(raw: &Value) -> Option<ImportIssue> {
    let number = raw.get("number")?.as_u64()?;
    let url = raw.get("html_url")?.as_str()?;
    let now = Utc::now();
    let state = raw.get("state").and_then(Value::as_str).unwrap_or("open");
    let reason = raw.get("state_reason").and_then(Value::as_str);
    let state_type = if state == "open" {
        "open"
    } else if reason == Some("not_planned") {
        "not_planned"
    } else {
        "closed"
    };
    let labels = raw.get("labels").and_then(Value::as_array).cloned().unwrap_or_default();
    let label_names: Vec<String> = labels
        .iter()
        .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let kind = if label_names.iter().any(|s| s.to_lowercase().contains("bug")) {
        "bug"
    } else {
        "feature"
    };
    let priority = if label_names
        .iter()
        .any(|s| s.to_lowercase().contains("urgent") || s.to_lowercase().contains("p0"))
    {
        "urgent"
    } else if label_names
        .iter()
        .any(|s| s.to_lowercase().contains("high") || s.to_lowercase().contains("p1"))
    {
        "high"
    } else {
        "none"
    };
    let status = if state == "open" {
        "backlog"
    } else if state_type == "not_planned" {
        "canceled"
    } else {
        "done"
    };
    let creator = raw.get("user").and_then(|u| u.get("login")).and_then(Value::as_str);
    let repo_id = raw
        .get("repository_url")
        .and_then(Value::as_str)
        .and_then(|u| u.strip_prefix("https://api.github.com/repos/"))
        .unwrap_or_default();
    let external_id = format!("{}#{}", repo_id.to_lowercase(), number);
    let created_at = date(raw.get("created_at").and_then(Value::as_str), now);
    let updated_at = date(raw.get("updated_at").and_then(Value::as_str), created_at);
    let closed_at = raw.get("closed_at").and_then(Value::as_str).map(|s| date(Some(s), updated_at));
    Some(ImportIssue {
        external_id,
        external_url: url.into(),
        external_key: format!("#{number}"),
        external_state: if state == "open" { "Open".into() } else { "Closed".into() },
        external_state_type: state_type.into(),
        synced_at: now,
        kind: kind.into(),
        title: raw
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(300)
            .collect(),
        body: raw.get("body").and_then(Value::as_str).map(|s| s.chars().take(100_000).collect()),
        source: "github".into(),
        reporter_name: creator.map(str::to_owned),
        assignee_id: None,
        project_id: None,
        milestone_ids: vec![],
        priority: priority.into(),
        status: status.into(),
        estimate: None,
        labels: vec![],
        created_at,
        updated_at,
        started_at: None,
        completed_at: closed_at,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use sea_orm::{ActiveModelTrait, ConnectionTrait, Set};
    use sea_orm_migration::MigratorTrait;
    use trama_core::{Config, testkit::TestDb};
    use trama_entities::{import_jobs, workspaces};
    use trama_integrations::{HttpClient, HttpFailure};

    use super::*;

    #[derive(Clone, Default)]
    struct MockGithub(Arc<Mutex<Vec<String>>>);

    #[async_trait]
    impl HttpClient for MockGithub {
        async fn request(&self, request: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            self.0.lock().unwrap().push(request.url.clone());
            let url = url::Url::parse(&request.url).unwrap();
            let page = url.query_pairs().find(|(key, _)| key == "page").unwrap().1;
            let json = if page == "1" {
                json!((1..=100).map(|number| {
                    let mut issue = json!({
                    "number": number, "title": format!("Imported {number}"), "body": "body", "state": "open",
                    "html_url": format!("https://github.com/acme/app/issues/{number}"),
                    "repository_url": "https://api.github.com/repos/acme/app",
                    "created_at": "2025-01-01T00:00:00Z", "updated_at": "2025-01-02T00:00:00Z",
                    "user": {"login":"octocat"}, "labels": []
                    });
                    if number < 100 {
                        issue["pull_request"] = json!({});
                    }
                    issue
                }).collect::<Vec<_>>())
            } else if page == "2" {
                json!([{
                    "number": 101, "title": "Imported 101", "body": "body", "state": "open",
                    "html_url": "https://github.com/acme/app/issues/101",
                    "repository_url": "https://api.github.com/repos/acme/app",
                    "created_at": "2025-01-01T00:00:00Z", "updated_at": "2025-01-02T00:00:00Z",
                    "user": {"login":"octocat"}, "labels": []
                }])
            } else {
                json!([])
            };
            Ok(HttpResponse { status: 200, headers: BTreeMap::new(), json })
        }
    }

    #[tokio::test]
    async fn github_pages_checkpoint_and_persist_imported_tasks() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        workspaces::ActiveModel {
            id: Set("ws_github_import".into()),
            slug: Set("github-import".into()),
            name: Set("GitHub import".into()),
            ..Default::default()
        }
        .insert(&test.db)
        .await
        .unwrap();
        import_jobs::ActiveModel {
            id: Set("imp_github_import".into()),
            workspace_id: Set("ws_github_import".into()),
            provider: Set("github".into()),
            status: Set("running".into()),
            source_label: Set("acme/app".into()),
            source: Set(json!({"repository":"acme/app"})),
            options: Set(json!({"includeClosed":true})),
            mapping: Set(json!({})),
            credential: Set(json!({})),
            progress: Set(json!({"processed":0,"created":0,"skipped":0})),
            errors: Set(json!([])),
            cursor: Set(None),
            cancel_requested: Set(false),
            created_by: Set(json!({"type":"user","id":"u_importer"})),
            ..Default::default()
        }
        .insert(&test.db)
        .await
        .unwrap();
        let provider = MockGithub::default();
        let seen = provider.0.clone();
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]))
            .with_extension(Http::new(provider));
        execute_github_job(&state, "imp_github_import", None).await.unwrap();
        let row = import_jobs::Entity::find_by_id("imp_github_import")
            .one(&test.db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "completed");
        assert_eq!(row.progress["created"], 2);
        assert_eq!(row.cursor, None);
        assert_eq!(seen.lock().unwrap().len(), 2);
        let count: i64 = test
            .db
            .query_one_raw(sea_orm::Statement::from_sql_and_values(
                test.db.get_database_backend(),
                r#"SELECT count(*) AS count FROM issues WHERE "workspaceId" = $1
               AND "externalRef"->>'provider' = 'github'"#,
                ["ws_github_import".into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "count")
            .unwrap();
        assert_eq!(count, 2);
        // Simulate a restarted worker picking up a job whose first page was checkpointed.
        let mut resumed: import_jobs::ActiveModel = row.into();
        resumed.status = Set("running".into());
        resumed.finished_at = Set(None);
        resumed.cursor = Set(Some(json!({"phase":"issues","page":2})));
        resumed.progress = Set(json!({"processed":1,"created":1,"skipped":0}));
        resumed.update(&test.db).await.unwrap();
        seen.lock().unwrap().clear();
        execute_github_job(&state, "imp_github_import", None).await.unwrap();
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].ends_with("&page=2"));
        let replayed = import_jobs::Entity::find_by_id("imp_github_import")
            .one(&test.db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replayed.status, "completed");
        assert_eq!(replayed.cursor, None);
        assert_eq!(replayed.progress["created"], 1);
        assert_eq!(replayed.progress["skipped"], 1);
        test.drop().await;
    }
}
