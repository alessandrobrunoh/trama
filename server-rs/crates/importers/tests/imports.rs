//! The import jobs against a real database, the real access guard and a fake tracker: the
//! cases of `imports.service.spec.ts` (jobs, one active import per workspace, workspace scoping),
//! `import-runner.service.spec.ts` (claims, the worker cap, stale takeover), and whole jobs
//! through the runner (create, claim, issues and comments persisted, `import.completed`, resume
//! from a stored cursor, cancel, rate-limit waits).

#![allow(clippy::too_many_lines)]

mod common;

use std::sync::atomic::Ordering;

use axum::http::StatusCode;
use chrono::{Duration, Utc};
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_entities::{
    comments, domain_events, import_jobs, import_links, issues, milestones, projects, workspaces,
};
use trama_importers::ImportRunner;
use trama_importers::types::SourceError;
use trama_integrations::ProviderHttpError;

use common::{
    Fake, Req, Res, World, entity, eventually, gh_comment, gh_issue, label, milestone, person, sql,
    workspace,
};

const IMPORTS: &str = "/api/w/acme/imports";

struct Fx {
    w: World,
    owner: String,
    member: String,
}

async fn fx(fake: Fake) -> Option<Fx> {
    let w = World::new(fake).await?;
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    let member = person(w.db(), "ws_acme", "m1", "member").await;
    Some(Fx { w, owner, member })
}

fn five() -> Fake {
    Fake::new((1..=5).map(gh_issue).collect(), vec![])
}

fn provider_error(status: u16, message: &str, wait: Option<Duration>) -> SourceError {
    SourceError::Provider(ProviderHttpError {
        status,
        message: message.into(),
        rate_limited_until: wait.map(|d| Utc::now() + d),
    })
}

impl Fx {
    async fn get(&self, path: &str) -> Res {
        self.w.send(Req::get(path).session(&self.owner)).await
    }
    async fn post(&self, path: &str, body: Value) -> Res {
        self.w.send(Req::post(path).session(&self.owner).json(body)).await
    }
    async fn post_empty(&self, path: &str) -> Res {
        self.w.send(Req::post(path).session(&self.owner)).await
    }
    async fn delete(&self, path: &str) -> Res {
        self.w.send(Req::delete(path).session(&self.owner)).await
    }

    /// Starts a GitHub import of `acme/api` and returns the job id; panics unless it is queued.
    async fn start(&self, extra: Value) -> String {
        let mut body = json!({ "provider": "github", "source": { "repository": "acme/api" } });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        let res = self.post(IMPORTS, body).await;
        assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.message());
        assert_eq!(res.body["status"], "queued");
        res.body["id"].as_str().unwrap().to_owned()
    }

    async fn job(&self, id: &str) -> Value {
        let res = self.get(&format!("{IMPORTS}/{id}")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body
    }

    async fn wait_status(&self, id: &str, status: &str) -> Value {
        eventually(&format!("job {id} to be {status}"), || async {
            let job = self.job(id).await;
            (job["status"] == status).then_some(job)
        })
        .await
    }

    async fn events(&self, kind: &str) -> Vec<domain_events::Model> {
        domain_events::Entity::find()
            .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
            .filter(domain_events::Column::Type.eq(kind))
            .all(self.w.db())
            .await
            .unwrap()
    }

    async fn wait_event(&self, kind: &str) -> domain_events::Model {
        eventually(&format!("a {kind} event"), || async { self.events(kind).await.pop() }).await
    }

    async fn issues(&self) -> Vec<issues::Model> {
        issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq("ws_acme"))
            .order_by_asc(issues::Column::CreatedAt)
            .order_by_asc(issues::Column::Number)
            .all(self.w.db())
            .await
            .unwrap()
    }

    async fn row(&self, id: &str) -> import_jobs::Model {
        import_jobs::Entity::find_by_id(id).one(self.w.db()).await.unwrap().unwrap()
    }
}

// ───────────────────────────── whole jobs ─────────────────────────────

#[tokio::test]
async fn runs_a_whole_job_creating_what_the_mapping_asks_for() {
    let fake = Fake::new((1..=5).map(gh_issue).collect(), vec![]);
    {
        let mut d = fake.discovery.lock().unwrap();
        d.projects = vec![entity("repo", "acme/api", Some("#112233"))];
        d.labels = vec![entity("bug", "bug", Some("#d73a4a")), entity("ui", "ui", None)];
        d.milestones = vec![milestone("m1", "v1", "repo")];
        d.users = vec![common::ada()];
        let mut issues = fake.issues.lock().unwrap();
        for i in issues.iter_mut() {
            i.project_id = Some("repo".into());
        }
        issues[0].labels = vec![label("bug", "bug", "#d73a4a")];
        issues[0].milestone = Some(milestone("m1", "v1", "repo"));
        issues[0].assignee = Some(common::ada());
        *fake.comments.lock().unwrap() = vec![
            gh_comment("c1", 1, "first"),
            gh_comment("c2", 99, "on a pull request"),
            gh_comment("c3", 2, "third"),
        ];
    }
    let Some(fx) = fx(fake).await else { return };
    // an existing label, to prove the catalog is extended rather than replaced
    sql(
        fx.w.db(),
        r##"UPDATE workspaces SET settings = settings || '{"labels":[{"id":"lb_old","name":"Old","color":"#000000","template":false,"scope":"issue"}]}'::jsonb WHERE id = 'ws_acme'"##,
    )
    .await;

    let started = fx
        .post(
            IMPORTS,
            json!({
                "provider": "github",
                "source": { "repository": "https://github.com/acme/api" },
                "options": { "includeComments": true },
                "mapping": {
                    "projects": { "repo": { "action": "create" } },
                    "labels": { "bug": { "action": "create" }, "ui": { "action": "skip" } },
                    "users": { "ada": "m1" },
                },
            }),
        )
        .await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.message());
    let id = started.body["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("imp_"));
    assert_eq!(started.body["status"], "queued");
    assert_eq!(started.body["sourceLabel"], "acme/api");
    assert_eq!(started.body["source"], json!({ "repository": "acme/api" }));
    assert_eq!(started.body["createdBy"], json!({ "type": "user", "id": "owner" }));
    assert_eq!(started.body["progress"]["phase"], "setup");
    for hidden in ["credential", "cursor", "heartbeatAt", "waitingUntil", "lastError"] {
        assert!(started.body.get(hidden).is_none(), "{hidden}");
    }

    let done = fx.wait_status(&id, "completed").await;
    assert_eq!(
        done["progress"],
        json!({ "phase": "done", "total": 5, "processed": 5, "created": 5,
                "skipped": 0, "failed": 0, "comments": 2 })
    );
    assert_eq!(done["errors"], json!([]));
    assert!(done["startedAt"].is_string() && done["finishedAt"].is_string());
    assert!(done.get("cursor").is_none() && done.get("credential").is_none());
    assert!(fx.row(&id).await.cursor.is_none(), "the cursor is cleared once completed");

    // the project the mapping asked for, and the milestone under it
    let project = projects::Entity::find().one(fx.w.db()).await.unwrap().unwrap();
    assert_eq!((project.name.as_str(), project.color.as_str()), ("acme/api", "#112233"));
    let milestone = milestones::Entity::find().one(fx.w.db()).await.unwrap().unwrap();
    assert_eq!(milestone.project_id, project.id);
    assert_eq!(milestone.name, "v1");
    assert_eq!(milestone.description.as_deref(), Some("First release"));
    assert_eq!(milestone.target_date.unwrap().to_utc().to_rfc3339(), "2026-12-31T00:00:00+00:00");
    // the label went into the catalog, once, next to the one that was there
    let workspace =
        workspaces::Entity::find_by_id("ws_acme").one(fx.w.db()).await.unwrap().unwrap();
    let catalog = workspace.settings["labels"].as_array().unwrap().clone();
    let names: Vec<&str> = catalog.iter().filter_map(|l| l["name"].as_str()).collect();
    assert_eq!(names, ["Old", "bug"]);
    let bug = catalog.iter().find(|l| l["name"] == "bug").unwrap();
    assert_eq!((bug["color"].as_str(), bug["scope"].as_str()), (Some("#d73a4a"), Some("issue")));
    assert!(bug["id"].as_str().unwrap().starts_with("lb_"));
    assert!(workspace.settings.get("roles").is_some(), "the other settings stay");

    // the issues: keyed under the project, mirrored from the tracker
    let rows = fx.issues().await;
    assert_eq!(rows.len(), 5);
    let first = rows.iter().find(|i| i.title == "Issue 1").unwrap();
    assert_eq!(first.key, format!("{}-1", project.key));
    assert_eq!(first.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(first.assignee_id.as_deref(), Some("m1"));
    assert_eq!(first.labels, json!([bug["id"]]));
    assert_eq!(first.milestone_ids, json!([milestone.id]));
    assert_eq!(first.source, "github");
    assert_eq!(first.reporter_name.as_deref(), Some("ada"));
    assert_eq!(first.external_url.as_deref(), Some("https://github.com/acme/api/issues/1"));
    let reference = first.external_ref.clone().unwrap();
    assert_eq!(reference["provider"], "github");
    assert_eq!(reference["id"], "acme/api#1");
    assert_eq!(reference["origin"], "import");
    assert_eq!(reference["state"], "Open");
    assert_eq!(reference["stateType"], "open");
    assert_eq!(first.created_at.to_utc().to_rfc3339(), "2026-01-01T00:00:00+00:00");

    // comments: written by the importer, only for imported issues, once
    let texts =
        comments::Entity::find().order_by_asc(comments::Column::Id).all(fx.w.db()).await.unwrap();
    assert_eq!(texts.len(), 2);
    for c in &texts {
        assert_eq!(c.author, json!({ "type": "user", "id": "owner" }));
        assert!(c.body.starts_with("_Imported from GitHub: @ada wrote on 2026-02-03_\n\n"));
        assert_eq!(c.created_at.to_utc().to_rfc3339(), "2026-02-03T10:00:00+00:00");
        assert_eq!(c.subject["type"], "issue");
    }
    // links: what was created, plus the comments; NestJS writes none for issues
    let links = import_links::Entity::find().all(fx.w.db()).await.unwrap();
    let mut kinds: Vec<&str> = links.iter().map(|l| l.kind.as_str()).collect();
    kinds.sort_unstable();
    assert_eq!(kinds, ["comment", "comment", "label", "milestone", "project"]);
    assert!(links.iter().all(|l| l.job_id.as_deref() == Some(id.as_str())));

    // events: the job's own, plus what the project and milestone services record
    let started = fx.events("import.started").await;
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].data, json!({ "provider": "github", "source": "acme/api" }));
    assert_eq!(started[0].subject, json!({ "type": "import", "id": id }));
    assert_eq!(started[0].actor, json!({ "type": "user", "id": "owner" }));
    let completed = fx.wait_event("import.completed").await;
    assert_eq!(
        completed.data,
        json!({ "provider": "github", "source": "acme/api", "phase": "done", "total": 5,
                "processed": 5, "created": 5, "skipped": 0, "failed": 0, "comments": 2 })
    );
    assert_eq!(completed.actor, json!({ "type": "user", "id": "owner" }));
    assert_eq!(fx.events("project.created").await.len(), 1);
    assert_eq!(fx.events("milestone.created").await.len(), 1);
    assert!(fx.events("issue.created").await.is_empty(), "no per-issue events");

    // a second import of the same source creates nothing and refreshes the mirrored status
    fx.w.fake.issues.lock().unwrap()[1].state = common::state_of("closed");
    let again = fx
        .start(json!({
            "options": { "includeComments": true },
            "mapping": { "projects": { "repo": { "action": "create" } },
                         "labels": { "bug": { "action": "create" } }, "users": { "ada": "m1" } },
        }))
        .await;
    let rerun = fx.wait_status(&again, "completed").await;
    assert_eq!(rerun["progress"]["created"], 0);
    assert_eq!(rerun["progress"]["skipped"], 5);
    assert_eq!(rerun["progress"]["comments"], 0);
    assert_eq!(fx.issues().await.len(), 5);
    assert_eq!(projects::Entity::find().count(fx.w.db()).await.unwrap(), 1, "the link is reused");
    assert_eq!(milestones::Entity::find().count(fx.w.db()).await.unwrap(), 1);
    let two = fx.issues().await.into_iter().find(|i| i.title == "Issue 2").unwrap();
    let reference = two.external_ref.unwrap();
    assert_eq!(
        (reference["state"].as_str(), reference["stateType"].as_str()),
        (Some("Closed"), Some("done"))
    );
    assert_eq!(two.status, "backlog", "the Trama status is not touched");
    fx.w.drop().await;
}

#[tokio::test]
async fn without_a_mapping_the_previews_suggestions_are_used() {
    let fake = five();
    fake.discovery.lock().unwrap().projects = vec![entity("repo", "Platform", None)];
    for i in fake.issues.lock().unwrap().iter_mut() {
        i.project_id = Some("repo".into());
    }
    let Some(fx) = fx(fake).await else { return };
    sql(
        fx.w.db(),
        r"INSERT INTO projects (id, `workspaceId`, name, color, status, priority, key)
          VALUES ('pj_platform', 'ws_acme', 'platform', '#6b7280', 'backlog', 'none', 'PLAT')"
            .replace('`', "\"")
            .as_str(),
    )
    .await;
    let id = fx.start(json!({})).await;
    let done = fx.wait_status(&id, "completed").await;
    // the preview matched the existing project by name
    assert_eq!(
        done["mapping"]["projects"]["repo"],
        json!({ "action": "map", "id": "pj_platform" })
    );
    assert_eq!(done["sourceLabel"], "acme/api");
    assert_eq!(projects::Entity::find().count(fx.w.db()).await.unwrap(), 1);
    assert!(fx.issues().await.iter().all(|i| i.key.starts_with("PLAT-")));
    fx.w.drop().await;
}

#[tokio::test]
async fn a_failed_job_resumes_from_its_stored_cursor_without_duplicates() {
    let fx = fx(five()).await;
    let Some(fx) = fx else { return };
    let token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    fx.w.fake.fail_call(3, provider_error(401, &format!("Bad credentials for {token}"), None));
    let id = fx.start(json!({})).await;
    let failed = fx.wait_status(&id, "failed").await;
    assert!(failed["lastError"].as_str().unwrap().contains("[redacted]"));
    assert!(!failed.to_string().contains(token));
    assert_eq!(failed["progress"]["created"], 4);
    assert_eq!(failed["progress"]["phase"], "issues");
    assert!(failed["finishedAt"].is_string());
    assert_eq!(fx.issues().await.len(), 4);
    let stored = fx.row(&id).await.cursor.unwrap();
    assert_eq!((stored["phase"].as_str(), stored["cursor"].as_str()), (Some("issues"), Some("4")));
    assert!(stored["plan"].is_object());
    let event = fx.wait_event("import.failed").await;
    assert_eq!(event.data["error"], failed["lastError"]);
    assert_eq!(event.data["created"], 4);

    // another import cannot start while this one can still be retried? it can: failed is final
    fx.w.fake.clear_failures();
    let discovered = fx.w.fake.discover_calls.load(Ordering::SeqCst);
    let retried = fx.post_empty(&format!("{IMPORTS}/{id}/retry")).await;
    assert_eq!(retried.status, StatusCode::OK, "{}", retried.message());
    assert!(retried.body.get("lastError").is_none() && retried.body.get("finishedAt").is_none());
    let done = fx.wait_status(&id, "completed").await;
    assert_eq!(done["progress"]["created"], 5);
    assert_eq!(done["progress"]["processed"], 5);
    assert_eq!(fx.issues().await.len(), 5);
    assert_eq!(
        fx.w.fake.discover_calls.load(Ordering::SeqCst),
        discovered,
        "the plan was stored: no second discovery"
    );
    assert!(done.get("lastError").is_none());
    fx.w.drop().await;
}

#[tokio::test]
async fn cancel_stops_a_running_job_at_its_next_page_and_keeps_what_was_imported() {
    let fake = Fake::new((1..=6).map(gh_issue).collect(), vec![]);
    let (permits, entered) = fake.gate_call(2);
    let Some(fx) = fx(fake).await else { return };
    let id = fx.start(json!({})).await;
    entered.notified().await;
    let canceling = fx.post_empty(&format!("{IMPORTS}/{id}/cancel")).await;
    assert_eq!(canceling.status, StatusCode::OK, "{}", canceling.message());
    assert_eq!(canceling.body["status"], "running");
    assert_eq!(canceling.body["cancelRequested"], true);
    permits.add_permits(1);
    let done = fx.wait_status(&id, "canceled").await;
    assert!(done["finishedAt"].is_string());
    assert_eq!(fx.issues().await.len(), 4, "the page in flight was finished");
    let event = fx.wait_event("import.canceled").await;
    assert_eq!(event.data["created"], 4);
    assert!(fx.row(&id).await.cursor.is_some(), "a canceled job keeps its cursor");
    assert_eq!(
        fx.post_empty(&format!("{IMPORTS}/{id}/cancel")).await.message(),
        "The import already canceled"
    );
    fx.w.drop().await;
}

#[tokio::test]
async fn a_short_rate_limit_is_waited_out_in_the_process() {
    let fake = Fake::new(vec![gh_issue(1), gh_issue(2)], vec![]);
    fake.fail_call(1, provider_error(429, "slow down", Some(Duration::milliseconds(700))));
    let Some(fx) = fx(fake).await else { return };
    let id = fx.start(json!({})).await;
    let done = fx.wait_status(&id, "completed").await;
    assert_eq!(fx.w.fake.issue_calls.load(Ordering::SeqCst), 2, "the same page was asked again");
    assert_eq!(fx.issues().await.len(), 2);
    assert!(done.get("waitingUntil").is_none());
    assert!(done.get("lastError").is_none());
    fx.w.drop().await;
}

#[tokio::test]
async fn a_long_rate_limit_parks_the_job_until_the_window_has_passed() {
    let fake = Fake::new(vec![gh_issue(1), gh_issue(2)], vec![]);
    fake.fail_call(1, provider_error(429, "slow down", Some(Duration::hours(1))));
    let Some(fx) = fx(fake).await else { return };
    let id = fx.start(json!({})).await;
    let parked = eventually("the job to be parked", || async {
        let job = fx.job(&id).await;
        job.get("waitingUntil").is_some().then_some(job)
    })
    .await;
    assert_eq!(parked["status"], "queued");
    assert!(fx.row(&id).await.heartbeat_at.is_none());
    // not claimable before the window has passed, here or by a sweep
    let runner = ImportRunner::of(&fx.w.state);
    assert!(!runner.kick(&fx.w.state, &id).await);
    runner.sweep(&fx.w.state).await;
    assert_eq!(fx.job(&id).await["status"], "queued");

    fx.w.fake.clear_failures();
    sql(fx.w.db(), &format!("UPDATE import_jobs SET \"waitingUntil\" = now() - interval '1 second' WHERE id = '{id}'")).await;
    runner.sweep(&fx.w.state).await;
    let done = fx.wait_status(&id, "completed").await;
    assert_eq!(done["progress"]["created"], 2);
    assert_eq!(fx.issues().await.len(), 2);
    fx.w.drop().await;
}

#[tokio::test]
async fn a_parked_job_is_canceled_at_once() {
    let fake = Fake::new(vec![gh_issue(1)], vec![]);
    fake.fail_call(1, provider_error(429, "slow down", Some(Duration::hours(1))));
    let Some(fx) = fx(fake).await else { return };
    let id = fx.start(json!({})).await;
    eventually("the job to be parked", || async {
        fx.job(&id).await.get("waitingUntil").map(|_| ())
    })
    .await;
    let canceled = fx.post_empty(&format!("{IMPORTS}/{id}/cancel")).await;
    assert_eq!(canceled.status, StatusCode::OK);
    assert_eq!(canceled.body["status"], "canceled");
    assert_eq!(canceled.body["cancelRequested"], true);
    assert!(canceled.body["finishedAt"].is_string());
    assert!(canceled.body.get("waitingUntil").is_none());
    assert!(fx.events("import.canceled").await.is_empty(), "no runner ended it");
    fx.w.drop().await;
}

#[tokio::test]
async fn a_job_whose_runner_is_gone_is_taken_over_from_its_cursor() {
    let Some(fx) = fx(five()).await else { return };
    workspace(fx.w.db(), "beta").await;
    let plan = r#"{"teams":{},"projects":{},"labels":{},"milestones":{},"users":{},"statuses":{}}"#;
    let insert = |id: &str, ws: &str, heartbeat: &str| {
        format!(
            r#"INSERT INTO import_jobs (id, "workspaceId", provider, status, "sourceLabel", source, options, mapping, credential, progress, errors, cursor, "heartbeatAt", "startedAt", "createdBy")
               VALUES ('{id}', '{ws}', 'github', 'running', 'acme/api', '{{"repository":"acme/api"}}',
                       '{{"includeComments":false,"includeClosed":true,"defaultKind":"feature"}}',
                       '{{"teams":{{}},"projects":{{}},"labels":{{}},"users":{{}},"statuses":{{}}}}', '{{}}',
                       '{{"phase":"issues","processed":2,"created":2,"skipped":0,"failed":0,"comments":0}}', '[]',
                       '{{"phase":"issues","cursor":"2","plan":{plan}}}', {heartbeat}, now(), '{{"type":"user","id":"owner"}}')"#
        )
    };
    sql(fx.w.db(), &insert("imp_stale", "ws_acme", "now() - interval '200 seconds'")).await;
    sql(fx.w.db(), &insert("imp_alive", "ws_beta", "now()")).await;

    let runner = ImportRunner::of(&fx.w.state);
    assert!(!runner.kick(&fx.w.state, "imp_alive").await, "its runner is still working on it");
    assert!(!runner.kick(&fx.w.state, "imp_missing").await);
    assert!(runner.kick(&fx.w.state, "imp_stale").await);
    let done = fx.wait_status("imp_stale", "completed").await;
    // pages 2 and 3 of the issues (cursor 2 and 4), added to the progress it had
    assert_eq!(done["progress"]["created"], 5);
    assert_eq!(done["progress"]["processed"], 5);
    assert_eq!(fx.issues().await.len(), 3);
    assert_eq!(fx.job("imp_stale").await["status"], "completed");
    assert_eq!(fx.row("imp_alive").await.status, "running");
    fx.w.drop().await;
}

#[tokio::test]
async fn the_sweep_picks_up_queued_jobs_across_workspaces() {
    let Some(fx) = fx(five()).await else { return };
    workspace(fx.w.db(), "beta").await;
    for (id, ws) in [("imp_a", "ws_acme"), ("imp_b", "ws_beta")] {
        sql(
            fx.w.db(),
            &format!(
                r#"INSERT INTO import_jobs (id, "workspaceId", provider, status, "sourceLabel", source, options, mapping, credential, progress, errors, "createdBy")
                   VALUES ('{id}', '{ws}', 'github', 'queued', 'acme/api', '{{"repository":"acme/api"}}',
                           '{{"includeComments":false,"includeClosed":true,"defaultKind":"feature"}}',
                           '{{"teams":{{}},"projects":{{}},"labels":{{}},"users":{{}},"statuses":{{}}}}', '{{}}',
                           '{{"phase":"setup","processed":0,"created":0,"skipped":0,"failed":0,"comments":0}}', '[]',
                           '{{"type":"user","id":"owner"}}')"#
            ),
        )
        .await;
    }
    ImportRunner::of(&fx.w.state).sweep(&fx.w.state).await;
    fx.wait_status("imp_a", "completed").await;
    let b = eventually("imp_b", || async {
        let row = import_jobs::Entity::find_by_id("imp_b").one(fx.w.db()).await.unwrap().unwrap();
        (row.status == "completed").then_some(row)
    })
    .await;
    assert_eq!(b.progress["created"], 5);
    assert_eq!(issues::Entity::find().count(fx.w.db()).await.unwrap(), 10);
    fx.w.drop().await;
}

// ───────────────────────────── the routes ─────────────────────────────

#[tokio::test]
async fn allows_one_active_import_per_workspace_and_guards_each_transition() {
    let fake = Fake::new((1..=4).map(gh_issue).collect(), vec![]);
    let (permits, entered) = fake.gate_call(1);
    let Some(fx) = fx(fake).await else { return };
    let id = fx.start(json!({})).await;
    entered.notified().await;

    let second = fx
        .post(IMPORTS, json!({ "provider": "github", "source": { "repository": "acme/api" } }))
        .await;
    assert_eq!(
        (second.status, second.message().as_str()),
        (StatusCode::CONFLICT, "Another import is still running in this workspace")
    );
    let retry = fx.post_empty(&format!("{IMPORTS}/{id}/retry")).await;
    assert_eq!(
        (retry.status, retry.message().as_str()),
        (StatusCode::CONFLICT, "Only a failed import can be retried")
    );
    let delete = fx.delete(&format!("{IMPORTS}/{id}")).await;
    assert_eq!(
        (delete.status, delete.message().as_str()),
        (StatusCode::CONFLICT, "Cancel the import before deleting it")
    );
    // the partial unique index decides when two requests race past the check
    let racing = trama_importers::service::start(
        &fx.w.state,
        "ws_acme",
        &trama_contracts::common::ActorRef::user("owner"),
        &trama_importers::service::ImportRequest {
            provider: trama_contracts::imports::ExternalProvider::Github,
            credential_id: None,
            connection_id: None,
            source: Some(common::source()),
            mapping: Some(json!({})),
            options: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(racing.status_code(), StatusCode::CONFLICT);

    fx.post_empty(&format!("{IMPORTS}/{id}/cancel")).await;
    permits.add_permits(1);
    fx.wait_status(&id, "canceled").await;
    // a finished job can be started again, listed, deleted
    let ended = fx.post_empty(&format!("{IMPORTS}/{id}/retry")).await;
    assert_eq!(ended.message(), "Only a failed import can be retried");
    let next = fx.start(json!({})).await;
    fx.wait_status(&next, "completed").await;
    let list = fx.get(IMPORTS).await;
    assert_eq!(list.status, StatusCode::OK);
    let ids: Vec<&str> =
        list.body.as_array().unwrap().iter().filter_map(|j| j["id"].as_str()).collect();
    assert_eq!(ids, [next.as_str(), id.as_str()], "newest first");
    assert_eq!(fx.delete(&format!("{IMPORTS}/{id}")).await.status, StatusCode::NO_CONTENT);
    let gone = fx.get(&format!("{IMPORTS}/{id}")).await;
    assert_eq!(
        (gone.status, gone.message()),
        (StatusCode::NOT_FOUND, format!("Import \"{id}\" not found"))
    );
    fx.w.drop().await;
}

#[tokio::test]
async fn jobs_are_scoped_to_their_workspace() {
    let Some(fx) = fx(five()).await else { return };
    workspace(fx.w.db(), "beta").await;
    let id = fx.start(json!({})).await;
    fx.wait_status(&id, "completed").await;
    let state = &fx.w.state;
    for result in [
        trama_importers::service::get(state, "ws_beta", &id).await.map(|_| ()),
        trama_importers::service::cancel(state, "ws_beta", &id).await.map(|_| ()),
        trama_importers::service::retry(state, "ws_beta", &id).await.map(|_| ()),
        trama_importers::service::remove(state, "ws_beta", &id).await,
    ] {
        assert_eq!(result.unwrap_err().status_code(), StatusCode::NOT_FOUND);
    }
    assert!(trama_importers::service::list(state, "ws_beta").await.unwrap().is_empty());
    assert_eq!(fx.job(&id).await["workspaceId"], "ws_acme");
    fx.w.drop().await;
}

#[tokio::test]
async fn needs_the_right_to_manage_integrations() {
    let Some(fx) = fx(five()).await else { return };
    let body = json!({ "provider": "github", "source": { "repository": "acme/api" } });
    for req in [
        Req::get(IMPORTS),
        Req::post(IMPORTS).json(body.clone()),
        Req::post(&format!("{IMPORTS}/preview")).json(body.clone()),
        Req::get(&format!("{IMPORTS}/imp_x")),
        Req::post(&format!("{IMPORTS}/imp_x/cancel")),
        Req::post(&format!("{IMPORTS}/imp_x/retry")),
        Req::delete(&format!("{IMPORTS}/imp_x")),
    ] {
        let res = fx.w.send(req.session(&fx.member)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.message());
    }
    let res = fx.w.send(Req::get(IMPORTS)).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    fx.w.drop().await;
}

#[tokio::test]
async fn refuses_a_bad_request_before_writing_anything() {
    let Some(fx) = fx(five()).await else { return };
    sql(
        fx.w.db(),
        r##"UPDATE workspaces SET settings = settings || '{"labels":[{"id":"lb_issue","name":"A","color":"#111111","template":false,"scope":"issue"},{"id":"lb_proj","name":"B","color":"#222222","template":false,"scope":"project"}]}'::jsonb WHERE id = 'ws_acme'"##,
    )
    .await;
    workspace(fx.w.db(), "beta").await;
    sql(fx.w.db(), r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key) VALUES ('pj_beta', 'ws_beta', 'Beta', '#6b7280', 'backlog', 'none', 'BETA')"#).await;
    let source = json!({ "repository": "acme/api" });
    let cases: Vec<(Value, &str)> = vec![
        (
            json!({ "provider": "jira", "source": source }),
            "provider must be one of the following values: github, linear",
        ),
        (json!({ "provider": "github" }), "source.repository must look like owner/name"),
        (
            json!({ "provider": "github", "source": { "repository": "nope" } }),
            "source.repository must look like owner/name",
        ),
        (
            json!({ "provider": "github", "source": source, "credentialId": "tcr_x" }),
            "Unknown github credential \"tcr_x\"",
        ),
        (
            json!({ "provider": "github", "source": source, "credentialId": "a", "connectionId": "b" }),
            "Pass credentialId or connectionId, not both",
        ),
        (
            json!({ "provider": "linear", "source": { "teamIds": ["a"] }, "mapping": {} }),
            "A Linear API key is required: add a credential first",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": [] }),
            "mapping must be an object",
        ),
        (
            json!({ "provider": "github", "source": source, "options": { "includeComments": "yes" } }),
            "options.includeComments must be a boolean",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "projects": { "p": { "action": "map" } } } }),
            "mapping.projects[\"p\"] must be {action: \"map\", id} | {action: \"create\"} | {action: \"skip\"}",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "teams": { "t": { "action": "map", "id": "tm_1" } } } }),
            "Linear teams are not workspace teams",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "projects": { "p": { "action": "map", "id": "pj_beta" } } } }),
            "Unknown project in: pj_beta",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "users": { "u": "stranger", "v": null } } }),
            "Not workspace members: stranger",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "labels": { "l": { "action": "map", "id": "lb_nope" }, "k": { "action": "map", "id": "lb_nope" } } } }),
            "Unknown label in: lb_nope",
        ),
        (
            json!({ "provider": "github", "source": source, "mapping": { "labels": { "l": { "action": "map", "id": "lb_proj" } } } }),
            "Label does not apply to issues: lb_proj",
        ),
    ];
    for (body, message) in cases {
        let res = fx.post(IMPORTS, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}: {}", res.message());
        assert!(res.message().contains(message), "{body}: {}", res.message());
    }
    assert_eq!(import_jobs::Entity::find().count(fx.w.db()).await.unwrap(), 0);
    assert!(fx.events("import.started").await.is_empty());
    // a mapping onto what exists is fine
    let ok = fx
        .post(
            IMPORTS,
            json!({ "provider": "github", "source": source,
                    "mapping": { "labels": { "l": { "action": "map", "id": "lb_issue" } }, "users": { "u": "m1" } } }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::ACCEPTED, "{}", ok.message());
    fx.w.drop().await;
}

#[tokio::test]
async fn previews_the_source_with_the_workspace_context() {
    let fake = five();
    {
        let mut d = fake.discovery.lock().unwrap();
        d.projects = vec![entity("repo", "Alpha", None)];
        d.labels = vec![entity("l1", "Bug", None), entity("l2", "Project label", None)];
        d.users = vec![
            common::ada(),
            trama_importers::types::ExternalUser {
                id: "u2".into(),
                login: Some("octo".into()),
                email: Some("M1@test.dev".into()),
                name: None,
            },
        ];
    }
    let Some(fx) = fx(fake).await else { return };
    sql(fx.w.db(), r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key) VALUES ('pj_alpha', 'ws_acme', 'alpha', '#6b7280', 'backlog', 'none', 'ALPH')"#).await;
    sql(
        fx.w.db(),
        r##"UPDATE workspaces SET settings = settings || '{"labels":[{"id":"lb_bug","name":"bug","color":"#111111","template":false,"scope":"issue"},{"id":"lb_p","name":"Project label","color":"#222222","template":false,"scope":"project"}]}'::jsonb WHERE id = 'ws_acme'"##,
    )
    .await;
    // `ada` is linked to a member through an external identity (any case)
    sql(fx.w.db(), r#"INSERT INTO external_identities (id, "userId", provider, host, login, source) VALUES ('ei_1', 'owner', 'github', 'github.com', 'Ada', 'manual')"#).await;

    let res = fx
        .post(
            &format!("{IMPORTS}/preview"),
            json!({ "provider": "github", "source": { "repository": "acme/api" }, "mapping": 5 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    let preview = res.body;
    assert_eq!(preview["provider"], "github");
    assert_eq!(preview["sourceLabel"], "acme/api");
    assert_eq!(preview["counts"]["issues"], 5);
    assert_eq!(preview["projects"][0]["suggested"], json!({ "action": "map", "id": "pj_alpha" }));
    // only the catalog's issue labels are offered
    assert_eq!(preview["labels"][0]["suggested"], json!({ "action": "map", "id": "lb_bug" }));
    assert_eq!(preview["labels"][1]["suggested"], json!({ "action": "create" }));
    let by_id = |id: &str| {
        preview["users"].as_array().unwrap().iter().find(|u| u["id"] == id).unwrap().clone()
    };
    assert_eq!(by_id("ada")["suggestedUserId"], "owner");
    assert_eq!(by_id("u2")["suggestedUserId"], "m1");
    assert_eq!(fx.w.fake.discover_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        import_jobs::Entity::find().count(fx.w.db()).await.unwrap(),
        0,
        "a preview writes nothing"
    );

    // a route covering the repository suggests that rule's project
    sql(fx.w.db(), r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key) VALUES ('pj_routed', 'ws_acme', 'Routed', '#6b7280', 'backlog', 'none', 'ROUT')"#).await;
    fx.w.drop().await;
}

#[tokio::test]
async fn a_failing_tracker_becomes_the_http_error_the_caller_should_see() {
    let Some(fx) = fx(five()).await else { return };
    let preview = format!("{IMPORTS}/preview");
    let body = json!({ "provider": "github", "source": { "repository": "acme/api" } });
    let token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let until = Utc::now() + Duration::minutes(5);
    let cases = [
        (
            provider_error(401, &format!("Bad credentials {token}"), None),
            StatusCode::BAD_REQUEST,
            "GitHub Issues rejected the request (Bad credentials [redacted])",
        ),
        (provider_error(500, "boom", None), StatusCode::BAD_GATEWAY, "GitHub Issues failed: boom"),
        (
            SourceError::Unexpected("odd".into()),
            StatusCode::BAD_GATEWAY,
            "GitHub Issues is unreachable: odd",
        ),
        (
            SourceError::Provider(ProviderHttpError {
                status: 403,
                message: "limit".into(),
                rate_limited_until: Some(until),
            }),
            StatusCode::TOO_MANY_REQUESTS,
            "GitHub Issues rate limit reached; try again after ",
        ),
    ];
    for (error, status, message) in cases {
        fx.w.fake.fail_call(0, error);
        let res = fx.post(&preview, body.clone()).await;
        assert_eq!(res.status, status, "{}", res.message());
        assert!(res.message().starts_with(message), "{}", res.message());
        assert!(!res.message().contains(token));
    }
    fx.w.drop().await;
}

// ───────────────────────────── the worker cap ─────────────────────────────

#[tokio::test]
async fn limits_claims_across_workspaces_to_four_jobs_at_once() {
    let fake = Fake::new((1..=2).map(gh_issue).collect(), vec![]);
    // every job's first page waits for the test, so the jobs stay in flight
    let (permits, _entered) = fake.gate_every_call();
    let Some(fx) = fx(fake).await else { return };
    for n in 0..6 {
        workspace(fx.w.db(), &format!("w{n}")).await;
        sql(
            fx.w.db(),
            &format!(
                r#"INSERT INTO import_jobs (id, "workspaceId", provider, status, "sourceLabel", source, options, mapping, credential, progress, errors, "createdBy")
                   VALUES ('imp_cap{n}', 'ws_w{n}', 'github', 'queued', 'acme/api', '{{"repository":"acme/api"}}',
                           '{{"includeComments":false,"includeClosed":true,"defaultKind":"feature"}}',
                           '{{"teams":{{}},"projects":{{}},"labels":{{}},"users":{{}},"statuses":{{}}}}', '{{}}',
                           '{{"phase":"setup","processed":0,"created":0,"skipped":0,"failed":0,"comments":0}}', '[]', '{{"type":"user","id":"owner"}}')"#
            ),
        )
        .await;
    }
    ImportRunner::of(&fx.w.state).sweep(&fx.w.state).await;
    eventually("four jobs to ask for their first page", || async {
        (fx.w.fake.issue_calls.load(Ordering::SeqCst) == 4).then_some(())
    })
    .await;
    let running = import_jobs::Entity::find()
        .filter(import_jobs::Column::Status.eq("running"))
        .count(fx.w.db())
        .await
        .unwrap();
    assert_eq!(running, 4, "two jobs wait for a slot");
    assert_eq!(
        import_jobs::Entity::find()
            .filter(import_jobs::Column::Status.eq("queued"))
            .count(fx.w.db())
            .await
            .unwrap(),
        2
    );
    // letting the pages through frees the slots, and the sweep fills them
    permits.add_permits(100);
    eventually("the first four to finish", || async {
        let done = import_jobs::Entity::find()
            .filter(import_jobs::Column::Status.eq("completed"))
            .count(fx.w.db())
            .await
            .unwrap();
        (done >= 4).then_some(())
    })
    .await;
    ImportRunner::of(&fx.w.state).sweep(&fx.w.state).await;
    eventually("all six to finish", || async {
        let done = import_jobs::Entity::find()
            .filter(import_jobs::Column::Status.eq("completed"))
            .count(fx.w.db())
            .await
            .unwrap();
        (done == 6).then_some(())
    })
    .await;
    fx.w.drop().await;
}
