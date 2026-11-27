//! The thread record routes behind the real access guard: `server/test/threads.e2e-spec.ts`
//! (the search cases belong to `trama-search`) and the service behaviour the routes do not show.

mod common;

use axum::http::StatusCode;
use chrono::DateTime;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::TokenScope;
use trama_contracts::threads::ThreadSyncInput;
use trama_entities::{domain_events, task_decisions, task_thread_records, time_entries};
use trama_threads::service::{self, SyncCaller};

use common::{Req, Res, World, only_projects, person, project, sql, token, workspace};

const W: &str = "/api/w/acme";
const THREAD_A: &str = "https://delta.dev/t/th_d93f10";
const THREAD_B: &str = "https://delta.dev/t/th_e01a77";
const PR_URL: &str = "https://github.com/acme/web/pull/423";

/// `acme` with its owner `u_owner`; returns the owner's session cookie.
async fn scene(w: &World) -> String {
    workspace(w.db(), "acme").await;
    person(w.db(), "acme", "u_owner", "owner", None).await
}

async fn task(w: &World, cookie: &str, extra: &Value) -> Value {
    let mut body = json!({ "kind": "feature", "title": "Alerting when refresh fails" });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    let res = w.send(Req::post(&format!("{W}/tasks")).session(cookie).json(&body)).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    res.body
}

async fn sync(w: &World, cookie: &str, key: &str, body: &Value) -> Res {
    w.send(Req::post(&format!("{W}/tasks/{key}/thread/sync")).session(cookie).json(body)).await
}

async fn synced(w: &World, cookie: &str, key: &str, body: &Value) -> Value {
    let res = sync(w, cookie, key, body).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    res.body
}

async fn get(w: &World, cookie: &str, path: &str) -> Res {
    w.send(Req::get(&format!("{W}{path}")).session(cookie)).await
}

async fn events(w: &World, kind: &str) -> Vec<domain_events::Model> {
    domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq(kind))
        .order_by_asc(domain_events::Column::At)
        .all(w.db())
        .await
        .unwrap()
}

fn texts(body: &Value) -> Vec<String> {
    body.as_array().unwrap().iter().map(|d| d["text"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn links_the_thread_through_the_first_sync_and_keeps_one_record_per_task() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    assert_eq!(
        get(&w, &owner, &format!("/tasks/{key}/thread")).await.status,
        StatusCode::NOT_FOUND
    );

    let first = synced(
        &w,
        &owner,
        key,
        &json!({
            "threadUrl": THREAD_A,
            "summary": "Added a metric",
            "files": ["src/auth/refresh.ts", "src/auth/metrics.ts"],
            "turns": 6,
        }),
    )
    .await;
    assert_eq!(first["linked"], true);
    assert_eq!(first["decisionsAdded"], 0);
    assert!(first["artifact"].is_null());
    assert!(first["timeSuggestion"].is_null());
    let record = &first["record"];
    assert_eq!(record["issueId"], t["id"]);
    assert_eq!(record["threadUrl"], THREAD_A);
    assert_eq!(record["summary"], "Added a metric");
    assert_eq!(record["files"], json!(["src/auth/refresh.ts", "src/auth/metrics.ts"]));
    assert_eq!(record["turns"], 6);
    assert_eq!(record["syncCount"], 1);
    assert_eq!(record["lastSyncBy"], json!({ "type": "user", "id": "u_owner" }));
    assert_eq!(record["decisions"], json!([]));
    assert_eq!(get(&w, &owner, &format!("/tasks/{key}")).await.body["threadUrl"], THREAD_A);

    // the second sync keeps the link, replaces the summary and merges the files, newest first
    let second = synced(
        &w,
        &owner,
        key,
        &json!({
            "threadUrl": THREAD_A,
            "summary": "Added a metric and an alert",
            "files": ["src/auth/alerts.ts", "src/auth/refresh.ts"],
        }),
    )
    .await;
    assert_eq!(second["linked"], false);
    assert_eq!(second["record"]["syncCount"], 2);
    assert_eq!(second["record"]["summary"], "Added a metric and an alert");
    assert_eq!(second["record"]["turns"], 6);
    assert_eq!(
        second["record"]["files"],
        json!(["src/auth/alerts.ts", "src/auth/refresh.ts", "src/auth/metrics.ts"])
    );

    let read = get(&w, &owner, &format!("/tasks/{key}/thread")).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.body["syncCount"], 2);
    let at = read.body["lastSyncAt"].as_str().unwrap();
    assert!(DateTime::parse_from_rfc3339(at).is_ok(), "{at}");
    assert!(at.ends_with('Z'));

    let synced_events = events(&w, "issue.thread_synced").await;
    assert_eq!(synced_events.len(), 2);
    assert_eq!(synced_events[0].subject["id"], t["id"]);
    assert_eq!(
        synced_events[0].data,
        json!({ "key": key, "decisions": 0, "files": 2, "pullRequest": false, "minutes": null })
    );
    assert_eq!(synced_events[1].data["files"], 3);
    // only the sync that linked the thread edits the task
    let updated: Vec<_> = events(&w, "issue.updated")
        .await
        .into_iter()
        .filter(|e| e.data["fields"] == json!(["threadUrl"]))
        .collect();
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].data["key"], key);
    w.drop().await;
}

#[tokio::test]
async fn syncs_without_a_thread_when_the_task_has_none() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let res = synced(&w, &owner, key, &json!({ "summary": "No thread yet" })).await;
    assert_eq!(res["linked"], false);
    assert!(res["record"]["threadUrl"].is_null());
    assert!(get(&w, &owner, &format!("/tasks/{key}")).await.body.get("threadUrl").is_none());
    w.drop().await;
}

#[tokio::test]
async fn refuses_a_different_thread_with_409_from_patch_and_from_sync() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    synced(&w, &owner, key, &json!({ "threadUrl": THREAD_A })).await;

    let patch = |body: Value| {
        let (w, owner) = (&w, &owner);
        async move { w.send(Req::patch(&format!("{W}/tasks/{key}")).session(owner).json(&body)).await }
    };
    let refused = patch(json!({ "threadUrl": THREAD_B })).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.body["code"], "thread_already_linked");
    assert_eq!(refused.body["threadUrl"], THREAD_A);
    assert!(refused.body["message"].is_string());

    let refused = sync(
        &w,
        &owner,
        key,
        &json!({ "threadUrl": THREAD_B, "summary": "Should not be stored", "decisions": [{ "text": "Nope" }] }),
    )
    .await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.body["code"], "thread_already_linked");
    assert_eq!(refused.body["threadUrl"], THREAD_A);
    // nothing from the refused sync was written
    let record = get(&w, &owner, &format!("/tasks/{key}/thread")).await.body;
    assert!(record["summary"].is_null());
    assert_eq!(record["decisions"], json!([]));

    // the same URL is fine, and so is unlinking and linking another
    assert_eq!(patch(json!({ "threadUrl": THREAD_A })).await.status, StatusCode::OK);
    assert_eq!(patch(json!({ "threadUrl": null })).await.status, StatusCode::OK);
    assert_eq!(patch(json!({ "threadUrl": THREAD_B })).await.status, StatusCode::OK);

    // a new task can be created with its thread, and a subtask links its own
    let created =
        task(&w, &owner, &json!({ "title": "Retry metrics", "threadUrl": THREAD_A })).await;
    assert_eq!(created["threadUrl"], THREAD_A);
    let sub = task(
        &w,
        &owner,
        &json!({ "title": "Retry metrics", "parentId": key, "threadUrl": THREAD_A }),
    )
    .await;
    assert_eq!(sub["threadUrl"], THREAD_A);
    w.drop().await;
}

#[tokio::test]
async fn adds_decisions_and_finds_them_by_path() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let other = task(&w, &owner, &json!({ "title": "Billing export" })).await;
    let key = t["key"].as_str().unwrap();
    let other_key = other["key"].as_str().unwrap();

    let res = synced(
        &w,
        &owner,
        key,
        &json!({
            "threadUrl": THREAD_A,
            "decisions": [
                { "text": "Refresh tokens stay server side", "paths": ["src/auth/*"] },
                { "text": "Alerts go through the existing queue", "paths": ["src/alerts/", "docs/alerts.md"] },
                { "text": "Specs sit next to the code", "paths": ["src/**/*.spec.ts"] },
                { "text": "Task wide note" },
            ],
        }),
    )
    .await;
    assert_eq!(res["decisionsAdded"], 4);
    assert_eq!(
        texts(&res["record"]["decisions"]),
        [
            "Refresh tokens stay server side",
            "Alerts go through the existing queue",
            "Specs sit next to the code",
            "Task wide note",
        ]
    );
    let first = &res["record"]["decisions"][0];
    assert_eq!(first["issueId"], t["id"]);
    assert_eq!(first["issueKey"], key);
    assert_eq!(first["paths"], json!(["src/auth/*"]));
    assert_eq!(first["threadUrl"], THREAD_A);
    assert_eq!(first["createdBy"], json!({ "type": "user", "id": "u_owner" }));
    assert!(first["id"].as_str().unwrap().starts_with("dc_"));
    synced(
        &w,
        &owner,
        other_key,
        &json!({ "decisions": [{ "text": "Exports are CSV", "paths": ["src/billing/export.ts"] }] }),
    )
    .await;

    let list = |query: String| {
        let (w, owner) = (&w, &owner);
        async move {
            let res = get(w, owner, &format!("/decisions{query}")).await;
            assert_eq!(res.status, StatusCode::OK, "{}", res.message());
            texts(&res.body)
        }
    };
    // glob, one segment: matches a file in the folder, not one deeper
    assert_eq!(list("?path=src/auth/session.ts".into()).await, ["Refresh tokens stay server side"]);
    assert!(list("?path=src/auth/token/refresh.ts".into()).await.is_empty());
    // directory prefix and exact path
    assert_eq!(
        list("?path=src/alerts/queue.ts".into()).await,
        ["Alerts go through the existing queue"]
    );
    assert_eq!(list("?path=docs/alerts.md".into()).await, ["Alerts go through the existing queue"]);
    // ** crosses folders
    assert_eq!(
        list("?path=src/auth/token/refresh.spec.ts".into()).await,
        ["Specs sit next to the code"]
    );
    assert_eq!(list("?path=src/billing/export.ts".into()).await, ["Exports are CSV"]);
    // decisions without paths only match together with their task
    assert!(list("?path=anything.ts".into()).await.is_empty());
    assert_eq!(list(format!("?path=anything.ts&issue={key}")).await, ["Task wide note"]);
    assert_eq!(
        list(format!("?path=src/auth/session.ts&issue={key}")).await,
        ["Task wide note", "Refresh tokens stay server side"]
    );
    // without a path: everything, newest first, filtered by task when asked
    let all = list(String::new()).await;
    assert_eq!(all.len(), 5);
    assert_eq!(all.last().unwrap(), "Refresh tokens stay server side");
    assert_eq!(list(format!("?issue={other_key}")).await, ["Exports are CSV"]);
    assert_eq!(list(format!("?issue={}&limit=2", t["id"].as_str().unwrap())).await.len(), 2);
    let too_many = get(&w, &owner, "/decisions?limit=500").await;
    assert_eq!(too_many.status, StatusCode::BAD_REQUEST);
    assert_eq!(too_many.message(), "limit must not be greater than 200");

    // later syncs append, never replace
    synced(
        &w,
        &owner,
        key,
        &json!({ "decisions": [{ "text": "One more", "paths": ["src/auth/"] }] }),
    )
    .await;
    assert_eq!(list(format!("?issue={key}")).await.len(), 5);
    assert_eq!(
        list("?path=src/auth/session.ts".into()).await,
        ["One more", "Refresh tokens stay server side"]
    );
    w.drop().await;
}

#[tokio::test]
async fn refuses_unsafe_paths_empty_decisions_and_oversized_input() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let many: Vec<Value> = (0..21).map(|i| json!({ "text": format!("d{i}") })).collect();
    let bad = [
        json!({ "files": ["../etc/passwd"] }),
        json!({ "files": ["/etc/passwd"] }),
        json!({ "decisions": [{ "text": "x", "paths": ["src/../../secrets"] }] }),
        json!({ "decisions": [{ "text": "   " }] }),
        json!({ "decisions": many }),
        json!({ "summary": "x".repeat(4001) }),
        json!({ "activeMinutes": 0 }),
        json!({ "activeMinutes": 721 }),
        json!({ "pullRequestUrl": "javascript:alert(1)" }),
        json!({ "threadUrl": "ftp://delta.dev/t/1" }),
    ];
    for body in bad {
        let res = sync(&w, &owner, key, &body).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(
        get(&w, &owner, &format!("/tasks/{key}/thread")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        sync(&w, &owner, "NOPE-1", &json!({ "summary": "x" })).await.status,
        StatusCode::NOT_FOUND
    );

    let res = sync(&w, &owner, key, &json!({ "files": ["/etc/passwd"] })).await;
    assert_eq!(res.message(), "Path \"/etc/passwd\" must be relative to the repository");
    let res = sync(&w, &owner, key, &json!({ "decisions": [{ "text": "  " }] })).await;
    assert_eq!(res.message(), "A decision needs text");
    let res = sync(&w, &owner, key, &json!({ "decisions": [{ "paths": ["a"] }, "x"] })).await;
    assert_eq!(
        res.message(),
        "decisions.0.text must be shorter than or equal to 1000 characters; decisions.0.text must be a string; decisions.1.nested property decisions must be either object or array"
    );
    w.drop().await;
}

#[tokio::test]
async fn attaches_the_pull_request_once_and_refreshes_it_on_the_next_sync() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let first = synced(&w, &owner, key, &json!({ "pullRequestUrl": PR_URL })).await;
    let artifact = &first["artifact"];
    assert_eq!(artifact["kind"], "pull_request");
    assert_eq!(artifact["provider"], "github");
    assert_eq!(artifact["url"], PR_URL);
    assert_eq!(artifact["externalId"], "#423");
    assert_eq!(artifact["repository"], "acme/web");
    assert_eq!(artifact["title"], "acme/web#423");
    assert_eq!(artifact["issueId"], t["id"]);

    let again =
        synced(&w, &owner, key, &json!({ "pullRequestUrl": PR_URL, "summary": "More work" })).await;
    assert_eq!(again["artifact"]["id"], artifact["id"]);

    let listed = get(&w, &owner, &format!("/tasks/{key}/artifacts")).await.body;
    let same: Vec<_> = listed.as_array().unwrap().iter().filter(|a| a["url"] == PR_URL).collect();
    assert_eq!(same.len(), 1);

    // another PR is another artifact
    synced(&w, &owner, key, &json!({ "pullRequestUrl": "https://github.com/acme/web/pull/424" }))
        .await;
    let all = get(&w, &owner, &format!("/tasks/{key}/artifacts")).await.body;
    let pulls = all.as_array().unwrap().iter().filter(|a| a["kind"] == "pull_request").count();
    assert_eq!(pulls, 2);

    let synced_events = events(&w, "issue.thread_synced").await;
    assert_eq!(synced_events.len(), 3);
    assert!(synced_events.iter().all(|e| e.data["pullRequest"] == true));
    assert_eq!(events(&w, "artifact.attached").await.len(), 2);
    w.drop().await;
}

#[tokio::test]
async fn attaching_a_pull_request_needs_the_artifacts_permission() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let url = format!("{W}/tasks/{key}/thread/sync");
    let body = json!({ "pullRequestUrl": PR_URL, "summary": "PR" });

    let tasks_only =
        token(w.db(), "ws_acme", "u_owner", TokenScope::Custom, Some(&["tasks:write"])).await;
    let res = w.send(Req::post(&url).bearer(&tasks_only).json(&body)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Attaching a pull request needs the artifacts permission");
    // a sync without a PR is a task edit, and the token may do it
    let res =
        w.send(Req::post(&url).bearer(&tasks_only).json(&json!({ "summary": "No PR" }))).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());

    let both = token(
        w.db(),
        "ws_acme",
        "u_owner",
        TokenScope::Custom,
        Some(&["tasks:write", "artifacts:write"]),
    )
    .await;
    let res = w.send(Req::post(&url).bearer(&both).json(&body)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["artifact"]["url"], PR_URL);

    // a member narrowed without the artifacts grant cannot attach one either
    let narrowed = person(
        w.db(),
        "acme",
        "u_narrow",
        "member",
        Some(json!({
            "projects": { "all": true, "projectIds": [] },
            "includeUnassigned": true,
            "grants": [],
        })),
    )
    .await;
    let res = sync(&w, &narrowed, key, &json!({ "pullRequestUrl": PR_URL })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    w.drop().await;
}

fn minutes_between(entry: &Value) -> i64 {
    let at = |field: &str| DateTime::parse_from_rfc3339(entry[field].as_str().unwrap()).unwrap();
    (at("endedAt") - at("startedAt")).num_minutes()
}

#[tokio::test]
async fn suggests_time_that_stays_out_of_the_list_until_it_is_accepted() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let res = synced(&w, &owner, key, &json!({ "activeMinutes": 47 })).await;
    let suggestion = &res["timeSuggestion"];
    assert_eq!(suggestion["userId"], "u_owner");
    assert_eq!(suggestion["minutes"], 47);
    let id = suggestion["id"].as_str().unwrap();
    assert_eq!(events(&w, "issue.thread_synced").await[0].data["minutes"], 47);

    // not in the default list, not a running timer
    assert_eq!(get(&w, &owner, "/time-entries").await.body, json!([]));
    let suggested = get(&w, &owner, "/time-entries?source=suggested").await.body;
    assert_eq!(suggested.as_array().unwrap().len(), 1);
    assert_eq!(suggested[0]["id"], id);
    assert_eq!(suggested[0]["userId"], "u_owner");
    assert_eq!(suggested[0]["issueId"], t["id"]);
    assert_eq!(suggested[0]["source"], "suggested");
    assert_eq!(minutes_between(&suggested[0]), 47);
    let stop = || w.send(Req::post(&format!("{W}/time-entries/stop")).session(&owner));
    assert_eq!(stop().await.status, StatusCode::BAD_REQUEST);
    let timer = w
        .send(Req::post(&format!("{W}/time-entries/start")).session(&owner).json(&json!({})))
        .await;
    assert_eq!(timer.status, StatusCode::CREATED);
    assert_eq!(timer.body["source"], "timer");
    assert_eq!(stop().await.status, StatusCode::CREATED);

    // only the owner of the suggestion accepts it; for anyone else it does not exist
    let sam = person(w.db(), "acme", "u_sam", "member", None).await;
    let accept = format!("{W}/time-entries/{id}/accept");
    assert_eq!(w.send(Req::post(&accept).session(&sam)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        w.send(Req::delete(&format!("{W}/time-entries/{id}")).session(&sam)).await.status,
        StatusCode::NOT_FOUND
    );

    let accepted = w.send(Req::post(&accept).session(&owner)).await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.message());
    assert_eq!(accepted.body["id"], id);
    assert_eq!(accepted.body["source"], "manual");
    let list = get(&w, &owner, "/time-entries").await.body;
    assert!(list.as_array().unwrap().iter().any(|e| e["id"] == id));
    assert_eq!(get(&w, &owner, "/time-entries?source=suggested").await.body, json!([]));
    let again = w.send(Req::post(&accept).session(&owner)).await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);
    assert_eq!(again.message(), "Only a suggested entry can be accepted");

    // a dismissed suggestion is gone
    let next = synced(&w, &owner, key, &json!({ "activeMinutes": 10 })).await;
    let dismissed = next["timeSuggestion"]["id"].as_str().unwrap();
    let res = w.send(Req::delete(&format!("{W}/time-entries/{dismissed}")).session(&owner)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(get(&w, &owner, "/time-entries?source=suggested").await.body, json!([]));

    let bad = get(&w, &owner, "/time-entries?source=nope").await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        bad.message(),
        "source must be one of the following values: timer, manual, suggested"
    );
    w.drop().await;
}

#[tokio::test]
async fn a_suggestion_in_a_hidden_project_cannot_be_accepted() {
    let Some(w) = World::new().await else { return };
    scene(&w).await;
    project(w.db(), "ws_acme", "pj_alpha", "ALPH").await;
    project(w.db(), "ws_acme", "pj_beta", "BETA").await;
    let narrowed =
        person(w.db(), "acme", "u_narrow", "member", Some(only_projects(&["pj_beta"], false)))
            .await;
    for (id, project) in [("te_hidden", "'pj_alpha'"), ("te_visible", "'pj_beta'")] {
        sql(
            w.db(),
            &format!(
                r#"INSERT INTO time_entries (id, "workspaceId", "userId", "projectId", description, source, "startedAt", "endedAt")
                   VALUES ('{id}', 'ws_acme', 'u_narrow', {project}, '', 'suggested', now() - interval '1 hour', now())"#
            ),
        )
        .await;
    }
    let res =
        w.send(Req::post(&format!("{W}/time-entries/te_hidden/accept")).session(&narrowed)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Time entry \"te_hidden\" not found");
    let ok =
        w.send(Req::post(&format!("{W}/time-entries/te_visible/accept")).session(&narrowed)).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.message());
    assert_eq!(ok.body["source"], "manual");
    w.drop().await;
}

#[tokio::test]
async fn an_agent_sync_suggests_time_for_the_assignee_and_for_nobody_without_one() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let assigned = task(&w, &owner, &json!({ "assigneeId": "u_owner" })).await;
    let unassigned = task(&w, &owner, &json!({ "title": "Nobody works on this" })).await;
    let agent =
        SyncCaller { actor: ActorRef::agent("ag_1"), user_id: None, can_write_artifacts: true };
    let input = ThreadSyncInput { active_minutes: Some(30), ..ThreadSyncInput::default() };

    let res = service::sync(&w.state, "ws_acme", &agent, assigned["key"].as_str().unwrap(), &input)
        .await
        .unwrap();
    let suggestion = res.time_suggestion.unwrap();
    assert_eq!((suggestion.user_id.as_str(), suggestion.minutes), ("u_owner", 30));
    assert_eq!(res.record.last_sync_by, ActorRef::agent("ag_1"));

    let res =
        service::sync(&w.state, "ws_acme", &agent, unassigned["key"].as_str().unwrap(), &input)
            .await
            .unwrap();
    assert!(res.time_suggestion.is_none());
    assert_eq!(time_entries::Entity::find().count(w.db()).await.unwrap(), 1);
    let entry = time_entries::Entity::find().one(w.db()).await.unwrap().unwrap();
    assert_eq!(entry.source, "suggested");
    assert_eq!(entry.issue_id.as_deref(), assigned["id"].as_str());
    w.drop().await;
}

#[tokio::test]
async fn suggests_points_from_similar_finished_tasks() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    project(w.db(), "ws_acme", "pj_identity", "IDEN").await;
    project(w.db(), "ws_acme", "pj_billing", "BILL").await;
    for (title, estimate, project) in [
        ("Rotate signing keys", 3, "pj_identity"),
        ("Add session audit log", 5, "pj_identity"),
        ("Expire stale sessions", 5, "pj_identity"),
        ("Invoice rounding", 13, "pj_billing"),
    ] {
        task(
            &w,
            &owner,
            &json!({ "title": title, "estimate": estimate, "projectId": project, "status": "done" }),
        )
        .await;
    }
    let target = task(
        &w,
        &owner,
        &json!({ "title": "Alert on token failures", "projectId": "pj_identity" }),
    )
    .await;
    let key = target["key"].as_str().unwrap();

    let res = get(&w, &owner, &format!("/tasks/{key}/estimate-suggestion")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["issueId"], target["id"]);
    assert_eq!(res.body["suggestion"], 5);
    assert_eq!(res.body["scale"], json!([0, 1, 2, 3, 5, 8, 13, 21]));
    let mut titles: Vec<&str> = res.body["basis"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["title"].as_str().unwrap())
        .collect();
    titles.sort_unstable();
    assert_eq!(titles, ["Add session audit log", "Expire stale sessions", "Rotate signing keys"]);
    assert!(res.body["basis"].as_array().unwrap().iter().all(|b| b["trackedMinutes"].is_null()));
    assert!(res.body["reason"].as_str().unwrap().contains("Median"));

    // finished entries that count are summed; suggestions and running timers are not
    let audit = res.body["basis"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["title"] == "Add session audit log")
        .unwrap();
    let audit_id = audit["id"].as_str().unwrap();
    for (id, source, ended) in [
        ("te_a", "manual", "now() - interval '1 hour'"),
        ("te_b", "timer", "now() - interval '30 minutes'"),
        ("te_c", "suggested", "now()"),
        ("te_d", "manual", "NULL"),
    ] {
        sql(
            w.db(),
            &format!(
                r#"INSERT INTO time_entries (id, "workspaceId", "userId", "issueId", description, source, "startedAt", "endedAt")
                   VALUES ('{id}', 'ws_acme', 'u_owner', '{audit_id}', '', '{source}', now() - interval '2 hours', {ended})"#
            ),
        )
        .await;
    }
    let res = get(&w, &owner, &format!("/tasks/{key}/estimate-suggestion")).await;
    let audit = res.body["basis"].as_array().unwrap().iter().find(|b| b["id"] == audit_id).unwrap();
    // 60 minutes (te_a) + 90 minutes (te_b)
    assert_eq!(audit["trackedMinutes"], 150);

    // too little history: no suggestion, and it says why
    let lonely = task(&w, &owner, &json!({ "title": "Something unrelated entirely" })).await;
    let none =
        get(&w, &owner, &format!("/tasks/{}/estimate-suggestion", lonely["key"].as_str().unwrap()))
            .await;
    assert_eq!(none.status, StatusCode::OK);
    assert!(none.body["suggestion"].is_null());
    assert_eq!(none.body["basis"], json!([]));
    assert!(!none.body["reason"].as_str().unwrap().is_empty());
    assert_eq!(
        get(&w, &owner, "/tasks/NOPE-1/estimate-suggestion").await.status,
        StatusCode::NOT_FOUND
    );
    w.drop().await;
}

#[tokio::test]
async fn estimates_follow_the_workspace_scale() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    for (title, estimate) in [("Rotate signing keys", 3), ("Rotate signing certificates", 4)] {
        task(&w, &owner, &json!({ "title": title, "estimate": estimate, "status": "done" })).await;
    }
    let target = task(&w, &owner, &json!({ "title": "Rotate signing material" })).await;
    let url = format!("/tasks/{}/estimate-suggestion", target["key"].as_str().unwrap());
    // 3 and 4 → 3.5: nearest is 3 on the fibonacci scale, halfway between 3 and 4 on the linear one
    assert_eq!(get(&w, &owner, &url).await.body["suggestion"], 3);
    sql(
        w.db(),
        r#"UPDATE workspaces SET settings = jsonb_set(settings, '{estimateScale}', '"linear"')"#,
    )
    .await;
    assert_eq!(get(&w, &owner, &url).await.body["suggestion"], 4);
    sql(
        w.db(),
        r#"UPDATE workspaces SET settings = jsonb_set(settings, '{estimateScale}', '"none"')"#,
    )
    .await;
    let off = get(&w, &owner, &url).await.body;
    assert!(off["suggestion"].is_null());
    assert_eq!(off["scale"], json!([]));
    assert_eq!(off["reason"], "Estimates are turned off in this workspace.");
    w.drop().await;
}

#[tokio::test]
async fn follows_the_task_permissions_a_viewer_reads_a_member_syncs() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    synced(
        &w,
        &owner,
        key,
        &json!({ "summary": "Done", "decisions": [{ "text": "A decision", "paths": ["src/"] }] }),
    )
    .await;

    let viewer = person(w.db(), "acme", "u_viewer", "viewer", None).await;
    assert_eq!(get(&w, &viewer, &format!("/tasks/{key}/thread")).await.body["summary"], "Done");
    assert_eq!(
        get(&w, &viewer, "/decisions?path=src/a.ts").await.body.as_array().unwrap().len(),
        1
    );
    assert_eq!(
        get(&w, &viewer, &format!("/tasks/{key}/estimate-suggestion")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        sync(&w, &viewer, key, &json!({ "summary": "No" })).await.status,
        StatusCode::FORBIDDEN
    );

    let member = person(w.db(), "acme", "u_member", "member", None).await;
    let res = synced(&w, &member, key, &json!({ "summary": "Mine" })).await;
    assert_eq!(res["record"]["lastSyncBy"], json!({ "type": "user", "id": "u_member" }));

    // a read token reads, and cannot sync
    let read = token(w.db(), "ws_acme", "u_owner", TokenScope::Read, None).await;
    let res = w.send(Req::get(&format!("{W}/decisions")).bearer(&read)).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w
        .send(Req::post(&format!("{W}/tasks/{key}/thread/sync")).bearer(&read).json(&json!({})))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // a custom token needs tasks:read / tasks:write
    let custom =
        token(w.db(), "ws_acme", "u_owner", TokenScope::Custom, Some(&["tasks:read"])).await;
    assert_eq!(
        w.send(Req::get(&format!("{W}/decisions")).bearer(&custom)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        w.send(Req::get(&format!("{W}/tasks/{key}/thread")).bearer(&custom)).await.status,
        StatusCode::OK
    );
    let none =
        token(w.db(), "ws_acme", "u_owner", TokenScope::Custom, Some(&["milestones:read"])).await;
    assert_eq!(
        w.send(Req::get(&format!("{W}/decisions")).bearer(&none)).await.status,
        StatusCode::FORBIDDEN
    );
    // signed out
    assert_eq!(w.send(Req::get(&format!("{W}/decisions"))).await.status, StatusCode::UNAUTHORIZED);
    w.drop().await;
}

#[tokio::test]
async fn hides_the_records_of_a_project_the_caller_cannot_see() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    project(w.db(), "ws_acme", "pj_alpha", "ALPH").await;
    project(w.db(), "ws_acme", "pj_beta", "BETA").await;
    let secret = task(&w, &owner, &json!({ "title": "Alpha work", "projectId": "pj_alpha" })).await;
    let key = secret["key"].as_str().unwrap();
    synced(
        &w,
        &owner,
        key,
        &json!({ "summary": "Alpha only", "decisions": [{ "text": "Alpha decision", "paths": ["src/"] }] }),
    )
    .await;

    let person_cookie =
        person(w.db(), "acme", "u_ivan", "member", Some(only_projects(&["pj_beta"], false))).await;
    for path in [format!("/tasks/{key}/thread"), format!("/tasks/{key}/estimate-suggestion")] {
        assert_eq!(get(&w, &person_cookie, &path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        sync(&w, &person_cookie, key, &json!({ "summary": "Sneaking in" })).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(get(&w, &person_cookie, "/decisions?path=src/a.ts").await.body, json!([]));
    assert_eq!(get(&w, &person_cookie, "/decisions").await.body, json!([]));
    assert_eq!(
        get(&w, &person_cookie, &format!("/decisions?issue={key}")).await.status,
        StatusCode::NOT_FOUND
    );
    // nothing was written by the refused sync
    assert_eq!(
        task_thread_records::Entity::find().one(w.db()).await.unwrap().unwrap().summary.as_deref(),
        Some("Alpha only")
    );
    w.drop().await;
}

#[tokio::test]
async fn deleting_a_task_deletes_its_record_and_decisions() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    synced(&w, &owner, key, &json!({ "summary": "s", "decisions": [{ "text": "d" }] })).await;
    assert_eq!(task_decisions::Entity::find().count(w.db()).await.unwrap(), 1);
    let res = w.send(Req::delete(&format!("{W}/tasks/{key}")).session(&owner)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(task_decisions::Entity::find().count(w.db()).await.unwrap(), 0);
    assert_eq!(task_thread_records::Entity::find().count(w.db()).await.unwrap(), 0);
    w.drop().await;
}

#[tokio::test]
async fn concurrent_syncs_of_different_threads_link_exactly_one() {
    let Some(w) = World::new().await else { return };
    let owner = scene(&w).await;
    let t = task(&w, &owner, &json!({})).await;
    let key = t["key"].as_str().unwrap();
    let (first, second) = (json!({ "threadUrl": THREAD_A }), json!({ "threadUrl": THREAD_B }));
    let (a, b) = tokio::join!(sync(&w, &owner, key, &first), sync(&w, &owner, key, &second));
    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let linked = get(&w, &owner, &format!("/tasks/{key}")).await.body["threadUrl"].clone();
    let winner = if a.status == StatusCode::OK { THREAD_A } else { THREAD_B };
    assert_eq!(linked, winner);
    assert_eq!(task_thread_records::Entity::find().count(w.db()).await.unwrap(), 1);
    w.drop().await;
}
