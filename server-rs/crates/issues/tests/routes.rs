//! The `/api/w/{slug}/tasks…` routes behind the real access guard: the behaviour of
//! `issues-subissues`, `issue-filters`, `task-due-date`, `task-thread-url` and `task-artifacts`
//! (task side), the `/tasks` parts of `rbac`, `guests` and `token-permissions`, and the controller
//! spec (`artifactCount`, hidden parents, the context).

mod common;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_contracts::roles::TokenScope;
use trama_entities::{comments, domain_events};

use common::{Req, Res, World, issue, only_projects, person, project, sql, token, workspace};

const T: &str = "/api/w/acme/tasks";

struct Team {
    owner: String,
    member: String,
    viewer: String,
}

/// `acme` with an owner, a member and a viewer.
async fn team(w: &World) -> Team {
    let db = w.db();
    workspace(db, "acme").await;
    Team {
        owner: person(db, "acme", "u_owner", "owner", None).await,
        member: person(db, "acme", "u_member", "member", None).await,
        viewer: person(db, "acme", "u_viewer", "viewer", None).await,
    }
}

async fn create(w: &World, cookie: &str, body: &Value) -> Res {
    w.send(Req::post(T).session(cookie).json(body)).await
}

async fn made(w: &World, cookie: &str, body: &Value) -> Value {
    let res = create(w, cookie, body).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    res.body
}

async fn get(w: &World, cookie: &str, task: &str) -> Res {
    w.send(Req::get(&format!("{T}/{task}")).session(cookie)).await
}

async fn patch(w: &World, cookie: &str, task: &str, body: &Value) -> Res {
    w.send(Req::patch(&format!("{T}/{task}")).session(cookie).json(body)).await
}

async fn events(w: &World, kind: &str) -> Vec<domain_events::Model> {
    domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq(kind))
        .order_by_asc(domain_events::Column::At)
        .all(w.db())
        .await
        .unwrap()
}

fn titles(body: &Value) -> Vec<String> {
    let mut titles: Vec<String> =
        body.as_array().unwrap().iter().map(|i| i["title"].as_str().unwrap().to_owned()).collect();
    titles.sort();
    titles
}

// ───────────────────────── issues-subissues ─────────────────────────

#[tokio::test]
async fn supports_arbitrary_nesting_with_flat_parent_ids_and_independent_statuses() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let root =
        made(&w, &t.owner, &json!({ "kind": "feature", "title": "Root issue", "status": "done" }))
            .await;
    let child = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Child issue", "parentId": root["id"] }),
    )
    .await;
    let grandchild = made(
        &w,
        &t.owner,
        &json!({ "kind": "tech_debt", "title": "Grandchild issue", "parentId": child["key"] }),
    )
    .await;
    assert_eq!(child["parentId"], root["id"]);
    assert_eq!(child["status"], "backlog");
    assert_eq!(grandchild["parentId"], child["id"]);
    assert_eq!(grandchild["status"], "backlog");

    // the list is flat: parent ids only, no `children`
    let res = w.send(Req::get(T).session(&t.owner)).await;
    let listed = res.body.as_array().unwrap().iter().find(|i| i["id"] == grandchild["id"]).unwrap();
    assert_eq!(listed["parentId"], child["id"]);
    assert!(listed.get("children").is_none());
    w.drop().await;
}

#[tokio::test]
async fn reparents_clears_and_rejects_self_parenting_and_ancestor_cycles() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let root = made(&w, &t.owner, &json!({ "kind": "feature", "title": "Cycle root" })).await;
    let other_root =
        made(&w, &t.owner, &json!({ "kind": "feature", "title": "Alternate root" })).await;
    let child = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Cycle child", "parentId": root["id"] }),
    )
    .await;
    let grandchild = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Cycle grandchild", "parentId": child["id"] }),
    )
    .await;
    let id = |v: &Value| v["id"].as_str().unwrap().to_owned();

    let res = patch(&w, &t.owner, &id(&child), &json!({ "parentId": child["id"] })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "An issue cannot be its own parent");
    let res = patch(&w, &t.owner, &id(&root), &json!({ "parentId": grandchild["id"] })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Issue hierarchy cannot contain cycles");
    assert_eq!(get(&w, &t.owner, &id(&child)).await.body["parentId"], root["id"]);

    let res = patch(&w, &t.owner, &id(&child), &json!({ "parentId": other_root["key"] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["parentId"], other_root["id"]);
    let res = patch(&w, &t.owner, &id(&child), &json!({ "parentId": null })).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("parentId").is_none());
    assert_eq!(get(&w, &t.owner, &id(&grandchild)).await.body["parentId"], child["id"]);

    // the hierarchy change is an `issue.updated` naming `parentId`
    let updated = events(&w, "issue.updated").await;
    assert!(updated.iter().any(|e| e.data["fields"] == json!(["parentId"])));
    w.drop().await;
}

#[tokio::test]
async fn keeps_children_when_their_parent_is_deleted_and_rejects_cross_workspace_links() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let parent = made(&w, &t.owner, &json!({ "kind": "feature", "title": "Deleted parent" })).await;
    let child = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Surviving child", "parentId": parent["id"] }),
    )
    .await;
    let res = w
        .send(Req::delete(&format!("{T}/{}", parent["id"].as_str().unwrap())).session(&t.owner))
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let surviving = get(&w, &t.owner, child["id"].as_str().unwrap()).await;
    assert_eq!(surviving.status, StatusCode::OK);
    assert_eq!(surviving.body["id"], child["id"]);
    assert!(surviving.body.get("parentId").is_none());
    // the detached child is announced as a hierarchy change
    let detached: Vec<_> = events(&w, "issue.updated")
        .await
        .into_iter()
        .filter(|e| e.subject["id"] == child["id"] && e.data["fields"] == json!(["parentId"]))
        .collect();
    assert_eq!(detached.len(), 1);
    assert_eq!(events(&w, "issue.deleted").await.len(), 1);

    workspace(w.db(), "other").await;
    let other_owner = person(w.db(), "other", "u_other", "owner", None).await;
    let foreign = w
        .send(
            Req::post("/api/w/other/tasks")
                .session(&other_owner)
                .json(&json!({ "kind": "feature", "title": "Foreign parent" })),
        )
        .await;
    assert_eq!(foreign.status, StatusCode::CREATED);
    let res = create(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Cross-workspace child", "parentId": foreign.body["id"] }),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = patch(
        &w,
        &t.owner,
        child["id"].as_str().unwrap(),
        &json!({ "parentId": foreign.body["id"] }),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

// ───────────────────────── issue-filters ─────────────────────────

#[tokio::test]
async fn filters_by_one_or_several_priorities_and_by_open_status() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    for (title, priority, status) in [
        ("urgent open", "urgent", "todo"),
        ("high open", "high", "in_progress"),
        ("high done", "high", "done"),
        ("low open", "low", "backlog"),
        ("high canceled", "high", "canceled"),
    ] {
        made(
            &w,
            &t.owner,
            &json!({ "kind": "bug", "title": title, "priority": priority, "status": status }),
        )
        .await;
    }
    let list = |query: &str| {
        let uri = format!("{T}{query}");
        let cookie = t.owner.clone();
        let w = &w;
        async move { w.send(Req::get(&uri).session(&cookie)).await }
    };
    let ok = |res: Res| {
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        titles(&res.body)
    };
    assert_eq!(ok(list("?priority=high").await), ["high canceled", "high done", "high open"]);
    assert_eq!(ok(list("?priority=high,urgent&open=true").await), ["high open", "urgent open"]);
    assert_eq!(ok(list("?open=true").await), ["high open", "low open", "urgent open"]);
    assert_eq!(ok(list("?open=false&priority=low").await), ["low open"]);
    assert_eq!(ok(list("").await).len(), 5);
    assert_eq!(ok(list("?limit=2").await).len(), 2);
    for bad in ["?limit=0", "?priority=bogus", "?open=maybe"] {
        assert_eq!(list(bad).await.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    w.drop().await;
}

// ───────────────────────── task-due-date ─────────────────────────

#[tokio::test]
async fn stores_the_due_date_keeps_it_on_other_edits_and_clears_it_with_null() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task =
        made(&w, &t.owner, &json!({ "kind": "bug", "title": "Ship it", "dueDate": "2026-12-02" }))
            .await;
    assert_eq!(task["dueDate"], "2026-12-02T00:00:00.000Z");
    let other = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Someday" })).await;
    assert!(other.get("dueDate").is_none());

    let key = task["key"].as_str().unwrap();
    let next = "2026-12-05T00:00:00.000Z";
    assert_eq!(patch(&w, &t.owner, key, &json!({ "dueDate": next })).await.body["dueDate"], next);
    let listed = w.send(Req::get(T).session(&t.owner)).await.body;
    let found = listed.as_array().unwrap().iter().find(|i| i["id"] == task["id"]).unwrap();
    assert_eq!(found["dueDate"], next);
    assert_eq!(
        patch(&w, &t.owner, key, &json!({ "title": "Ship it now" })).await.body["dueDate"],
        next
    );
    let cleared = patch(&w, &t.owner, key, &json!({ "dueDate": null })).await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert!(cleared.body.get("dueDate").is_none());
    w.drop().await;
}

#[tokio::test]
async fn rejects_due_dates_that_are_not_iso_8601() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Validation" })).await;
    for due in [json!("tomorrow"), json!("12/02/2026"), json!(""), json!(42)] {
        let res =
            create(&w, &t.owner, &json!({ "kind": "bug", "title": "Bad", "dueDate": due })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{due}");
        let res =
            patch(&w, &t.owner, task["key"].as_str().unwrap(), &json!({ "dueDate": due })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{due}");
    }
    w.drop().await;
}

// ───────────────────────── task-thread-url ─────────────────────────

#[tokio::test]
async fn stores_a_thread_url_on_create_and_patch_and_clears_it_with_null() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let url = "https://delta.dev/t/login-loop-1f2e";
    let task =
        made(&w, &t.owner, &json!({ "kind": "bug", "title": "Login loops", "threadUrl": url }))
            .await;
    assert_eq!(task["threadUrl"], url);
    let other = made(&w, &t.owner, &json!({ "kind": "bug", "title": "No thread" })).await;
    assert!(other.get("threadUrl").is_none());

    let key = task["key"].as_str().unwrap();
    let next = "http://localhost:4300/t/abc?x=1#top";
    assert_eq!(
        patch(&w, &t.owner, key, &json!({ "threadUrl": next })).await.body["threadUrl"],
        next
    );
    assert_eq!(get(&w, &t.owner, key).await.body["threadUrl"], next);
    assert_eq!(
        patch(&w, &t.owner, key, &json!({ "title": "Login loops again" })).await.body["threadUrl"],
        next
    );
    let cleared = patch(&w, &t.owner, key, &json!({ "threadUrl": null })).await;
    assert!(cleared.body.get("threadUrl").is_none());
    w.drop().await;
}

#[tokio::test]
async fn rejects_other_schemes_non_urls_padding_and_anything_over_2048_characters() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Validation" })).await;
    let key = task["key"].as_str().unwrap();
    let long = format!("https://delta.dev/{}", "a".repeat(2048));
    let bad = [
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "ftp://delta.dev/t/1",
        "file:///etc/passwd",
        "delta.dev/t/1",
        " https://delta.dev/t/1",
        "https://",
        "",
        long.as_str(),
    ];
    for url in bad {
        let res =
            create(&w, &t.owner, &json!({ "kind": "bug", "title": "Bad", "threadUrl": url })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{url}");
        let res = patch(&w, &t.owner, key, &json!({ "threadUrl": url })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{url}");
    }
    assert_eq!(
        patch(&w, &t.owner, key, &json!({ "threadUrl": 12 })).await.status,
        StatusCode::BAD_REQUEST
    );
    let longest = format!("https://delta.dev/{}", "a".repeat(2048 - "https://delta.dev/".len()));
    assert_eq!(longest.len(), 2048);
    let res = patch(&w, &t.owner, key, &json!({ "threadUrl": longest })).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["threadUrl"], longest);
    w.drop().await;
}

#[tokio::test]
async fn puts_the_thread_in_the_task_markdown_for_agents() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let url = "https://delta.dev/t/briefing-77aa";
    let task =
        made(&w, &t.owner, &json!({ "kind": "feature", "title": "Briefing", "threadUrl": url }))
            .await;
    let key = task["key"].as_str().unwrap();
    let md =
        w.send(Req::get(&format!("{T}/{key}/context?format=markdown")).session(&t.owner)).await;
    assert_eq!(md.status, StatusCode::OK);
    assert!(md.text.contains(&format!("Thread: {url}")), "{}", md.text);
    let json = w.send(Req::get(&format!("{T}/{key}/context?format=json")).session(&t.owner)).await;
    assert_eq!(json.body["issue"]["threadUrl"], url);
    w.drop().await;
}

// ───────────────────────── the controller spec ─────────────────────────

#[tokio::test]
async fn answers_the_artifact_count_only_to_callers_who_can_read_artifacts() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Counted" })).await;
    let key = task["key"].as_str().unwrap();
    // a session: a zero count is still a count
    assert_eq!(get(&w, &t.owner, key).await.body["artifactCount"], 0);
    let res = w
        .send(
            Req::post(&format!("{T}/{key}/artifacts"))
                .session(&t.owner)
                .json(&json!({ "kind": "document", "title": "Notes" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    assert_eq!(get(&w, &t.owner, key).await.body["artifactCount"], 1);

    let db = w.db();
    let with = token(
        db,
        "ws_acme",
        "u_owner",
        TokenScope::Custom,
        Some(&["tasks:read", "artifacts:read"]),
        None,
    )
    .await;
    let without =
        token(db, "ws_acme", "u_owner", TokenScope::Custom, Some(&["tasks:read"]), None).await;
    let res = w.send(Req::get(&format!("{T}/{key}")).bearer(&with)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["artifactCount"], 1);
    let res = w.send(Req::get(&format!("{T}/{key}")).bearer(&without)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("artifactCount").is_none());
    // the context shows no artifacts either
    let res = w.send(Req::get(&format!("{T}/{key}/context")).bearer(&without)).await;
    assert_eq!(res.body["artifacts"], json!([]));
    w.drop().await;
}

#[tokio::test]
async fn hides_a_parent_the_caller_cannot_see() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let db = w.db();
    project(db, "ws_acme", "pj_visible", "VIS").await;
    project(db, "ws_acme", "pj_hidden", "HID").await;
    issue(db, "ws_acme", "in_parent", "HID-1", Some("pj_hidden"), &[]).await;
    issue(db, "ws_acme", "in_child", "VIS-1", Some("pj_visible"), &[]).await;
    sql(db, r#"UPDATE issues SET "parentId" = 'in_parent' WHERE id = 'in_child'"#).await;
    let limited =
        person(db, "acme", "u_limited", "member", Some(only_projects(&["pj_visible"], false)))
            .await;

    assert_eq!(get(&w, &t.owner, "in_child").await.body["parentId"], "in_parent");
    let res = get(&w, &limited, "in_child").await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("parentId").is_none());
    assert_eq!(get(&w, &limited, "HID-1").await.status, StatusCode::NOT_FOUND);
    let res = w.send(Req::get(&format!("{T}/in_child/context")).session(&limited)).await;
    assert!(res.body["issue"].get("parentId").is_none());
    let list = w.send(Req::get(T).session(&limited)).await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert!(list.body[0].get("parentId").is_none());
    let res = patch(&w, &limited, "in_child", &json!({ "title": "Renamed" })).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("parentId").is_none());
    // the hidden parent is still the real one
    assert_eq!(get(&w, &t.owner, "in_child").await.body["parentId"], "in_parent");
    w.drop().await;
}

#[tokio::test]
async fn the_context_carries_the_plan_summary_and_a_markdown_briefing() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Broken" })).await;
    let key = task["key"].as_str().unwrap();
    let ctx = |query: &str| {
        let uri = format!("{T}/{key}/context{query}");
        Req::get(&uri).session(&t.owner)
    };
    let attach = |body: Value| {
        let req = Req::post(&format!("{T}/{key}/artifacts")).session(&t.owner).json(&body);
        w.send(req)
    };

    // a pull request is no plan
    let pr = attach(json!({ "kind": "pull_request", "title": "Fix" })).await;
    assert_eq!(pr.status, StatusCode::CREATED);
    let res = w.send(ctx("")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("planSummary").is_none());
    assert_eq!(res.body["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(res.body["issue"]["id"], task["id"]);

    let plan = attach(json!({ "kind": "document", "title": "Plan: rollout" })).await;
    assert_eq!(plan.status, StatusCode::CREATED);
    let res = w.send(ctx("")).await;
    assert_eq!(res.body["planSummary"]["artifactCount"], 1);
    assert_eq!(res.body["planSummary"]["latestArtifact"]["id"], plan.body["id"]);
    assert_eq!(res.body["artifacts"].as_array().unwrap().len(), 2);

    // markdown by query and by Accept header; JSON still wins without either
    let md = w.send(ctx("?format=markdown")).await;
    assert_eq!(md.status, StatusCode::OK);
    assert_eq!(md.headers["content-type"], "text/markdown; charset=utf-8");
    assert!(md.text.contains(&format!("# {key} — Broken")), "{}", md.text);
    assert!(!md.text.contains("Answered"));
    let md = w.send(ctx("").header("accept", "text/markdown")).await;
    assert!(md.text.starts_with(&format!("# {key}")), "{}", md.text);
    let json = w.send(ctx("").header("accept", "application/json, text/markdown;q=0.5")).await;
    assert_eq!(json.body["issue"]["key"], key);
    let res = w.send(ctx("?format=html")).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    w.drop().await;
}

// ───────────────────────── task-artifacts (task side) ─────────────────────────

#[tokio::test]
async fn deleting_a_task_deletes_its_artifacts_and_comments() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Doomed" })).await;
    let id = task["id"].as_str().unwrap();
    let res = w
        .send(
            Req::post(&format!("{T}/{id}/artifacts")).session(&t.owner).json(
                &json!({ "kind": "link", "title": "Spec", "url": "https://example.com/spec" }),
            ),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    sql(
        w.db(),
        &format!(
            r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
               VALUES ('cm_1', 'ws_acme', '{{"type":"issue","id":"{id}"}}', '{{"type":"system"}}', 'hi')"#
        ),
    )
    .await;
    let res = w.send(Req::delete(&format!("{T}/{id}")).session(&t.owner)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(get(&w, &t.owner, id).await.status, StatusCode::NOT_FOUND);
    let remaining = comments::Entity::find().all(w.db()).await.unwrap();
    assert!(remaining.is_empty());
    let artifacts = trama_entities::artifacts::Entity::find().all(w.db()).await.unwrap();
    assert!(artifacts.is_empty());
    w.drop().await;
}

#[tokio::test]
async fn read_only_members_and_tokens_cannot_attach_artifacts() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let task = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Guarded" })).await;
    let key = task["key"].as_str().unwrap();
    let body = json!({ "kind": "document", "title": "Notes" });
    let attach = |req: Req| w.send(req.json(&body));
    let res = attach(Req::post(&format!("{T}/{key}/artifacts")).session(&t.viewer)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let read = token(w.db(), "ws_acme", "u_owner", TokenScope::Read, None, None).await;
    let res = attach(Req::post(&format!("{T}/{key}/artifacts")).bearer(&read)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // but they read
    let res = w.send(Req::get(&format!("{T}/{key}/artifacts")).bearer(&read)).await;
    assert_eq!(res.status, StatusCode::OK);
    w.drop().await;
}

// ───────────────────────── rbac ─────────────────────────

#[tokio::test]
async fn roles_decide_who_reads_creates_and_deletes() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let issue = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Visible" })).await;
    let key = issue["key"].as_str().unwrap();

    // a viewer reads but writes nothing
    assert_eq!(w.send(Req::get(T).session(&t.viewer)).await.status, StatusCode::OK);
    assert_eq!(get(&w, &t.viewer, key).await.status, StatusCode::OK);
    let res = create(&w, &t.viewer, &json!({ "kind": "bug", "title": "Nope" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        patch(&w, &t.viewer, key, &json!({ "title": "x" })).await.status,
        StatusCode::FORBIDDEN
    );
    let res = w
        .send(
            Req::post(&format!("{T}/bulk"))
                .session(&t.viewer)
                .json(&json!({ "ids": [key], "patch": { "priority": "low" } })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        w.send(Req::delete(&format!("{T}/{key}")).session(&t.viewer)).await.status,
        StatusCode::FORBIDDEN
    );

    // a member creates, edits and (by default) deletes
    let created = create(&w, &t.member, &json!({ "kind": "bug", "title": "Ok" })).await;
    assert_eq!(created.status, StatusCode::CREATED);
    let recorded = events(&w, "issue.created").await;
    assert_eq!(recorded.last().unwrap().actor, json!({ "type": "user", "id": "u_member" }));
    assert_eq!(
        patch(&w, &t.member, key, &json!({ "title": "Edited" })).await.status,
        StatusCode::OK
    );
    let res = w
        .send(
            Req::post(&format!("{T}/bulk-delete"))
                .session(&t.member)
                .json(&json!({ "ids": [created.body["key"]] })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body, json!({ "deleted": [created.body["id"]] }));
    let res = w.send(Req::delete(&format!("{T}/{key}")).session(&t.member)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.message());

    // a role without `deleteIssues` is refused: the guest has only `createIssues`
    let guest = person(w.db(), "acme", "u_guest", "guest", None).await;
    let other = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Kept" })).await;
    let other_key = other["key"].as_str().unwrap();
    let res = w.send(Req::delete(&format!("{T}/{other_key}")).session(&guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w
        .send(
            Req::post(&format!("{T}/bulk-delete"))
                .session(&guest)
                .json(&json!({ "ids": [other_key] })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(get(&w, &t.owner, other_key).await.status, StatusCode::OK);
    w.drop().await;
}

#[tokio::test]
async fn another_workspace_is_a_404_and_its_tasks_are_invisible() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    workspace(w.db(), "beta").await;
    let beta = person(w.db(), "beta", "u_beta", "owner", None).await;
    let secret = made(&w, &t.owner, &json!({ "kind": "bug", "title": "Secret" })).await;

    assert_eq!(w.send(Req::get(T).session(&beta)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        create(&w, &beta, &json!({ "kind": "bug", "title": "x" })).await.status,
        StatusCode::NOT_FOUND
    );
    for reference in [secret["id"].as_str().unwrap(), secret["key"].as_str().unwrap()] {
        let res = w.send(Req::get(&format!("/api/w/beta/tasks/{reference}")).session(&beta)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{reference}");
        assert_eq!(res.message(), format!("Issue \"{reference}\" not found"));
    }
    // and without a session there is no answer
    assert_eq!(w.send(Req::get(T)).await.status, StatusCode::UNAUTHORIZED);
    w.drop().await;
}

// ───────────────────────── guests ─────────────────────────

#[tokio::test]
async fn a_guest_sees_and_creates_tasks_only_in_their_project() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let db = w.db();
    project(db, "ws_acme", "pj_shared", "SHR").await;
    project(db, "ws_acme", "pj_secret", "SEC").await;
    let shared = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Visible zebra task", "projectId": "pj_shared" }),
    )
    .await;
    let secret = made(
        &w,
        &t.owner,
        &json!({ "kind": "bug", "title": "Hidden zebra task", "projectId": "pj_secret" }),
    )
    .await;
    let guest =
        person(db, "acme", "u_guest", "guest", Some(only_projects(&["pj_shared"], false))).await;

    let res = w.send(Req::get(T).session(&guest)).await;
    assert_eq!(res.status, StatusCode::OK);
    let ids: Vec<_> = res.body.as_array().unwrap().iter().map(|i| i["id"].clone()).collect();
    assert_eq!(ids, [shared["id"].clone()]);
    for reference in [secret["key"].as_str().unwrap(), secret["id"].as_str().unwrap()] {
        assert_eq!(get(&w, &guest, reference).await.status, StatusCode::NOT_FOUND, "{reference}");
    }
    let res = w
        .send(
            Req::get(&format!("{T}/{}/artifacts", secret["id"].as_str().unwrap())).session(&guest),
        )
        .await;
    assert_eq!((res.status, res.body), (StatusCode::OK, json!([])));
    let res = w.send(Req::get(&format!("{T}?q=zebra")).session(&guest)).await;
    assert_eq!(res.body.as_array().unwrap().len(), 1);

    // creates and edits in their own project, nowhere else
    let created = made(
        &w,
        &guest,
        &json!({ "kind": "bug", "title": "From the client", "projectId": "pj_shared" }),
    )
    .await;
    let key = created["key"].as_str().unwrap();
    assert_eq!(
        patch(&w, &guest, key, &json!({ "title": "Renamed by the client" })).await.status,
        StatusCode::OK
    );
    let res = create(
        &w,
        &guest,
        &json!({ "kind": "bug", "title": "Elsewhere", "projectId": "pj_secret" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = create(&w, &guest, &json!({ "kind": "bug", "title": "No project" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = patch(&w, &guest, key, &json!({ "projectId": "pj_secret" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        w.send(Req::delete(&format!("{T}/{key}")).session(&guest)).await.status,
        StatusCode::FORBIDDEN
    );
    // a hidden task cannot be reached through the bulk routes either
    let res = w
        .send(
            Req::post(&format!("{T}/bulk"))
                .session(&guest)
                .json(&json!({ "ids": [secret["key"]], "patch": { "priority": "low" } })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    w.drop().await;
}

#[tokio::test]
async fn an_organizer_manages_tasks_in_every_project() {
    let Some(w) = World::new().await else { return };
    team(&w).await;
    let db = w.db();
    project(db, "ws_acme", "pj_a", "AAA").await;
    let organizer = person(db, "acme", "u_org", "organizer", None).await;
    let task = made(
        &w,
        &organizer,
        &json!({ "kind": "feature", "title": "Plan it", "projectId": "pj_a" }),
    )
    .await;
    let res = w
        .send(Req::delete(&format!("{T}/{}", task["key"].as_str().unwrap())).session(&organizer))
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    w.drop().await;
}

// ───────────────────────── token-permissions ─────────────────────────

#[tokio::test]
async fn a_custom_token_acts_within_its_task_permissions() {
    let Some(w) = World::new().await else { return };
    team(&w).await;
    let db = w.db();
    let secret = token(
        db,
        "ws_acme",
        "u_owner",
        TokenScope::Custom,
        Some(&["tasks:write", "projects:read"]),
        None,
    )
    .await;
    assert_eq!(w.send(Req::get(T).bearer(&secret)).await.status, StatusCode::OK);
    let res = w
        .send(
            Req::post(T)
                .bearer(&secret)
                .json(&json!({ "kind": "bug", "title": "from custom token" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let key = res.body["key"].as_str().unwrap();
    assert_eq!(events(&w, "issue.created").await[0].actor["id"], "u_owner");
    let no_delete = w.send(Req::delete(&format!("{T}/{key}")).bearer(&secret)).await;
    assert_eq!(no_delete.status, StatusCode::FORBIDDEN);
    assert!(no_delete.message().contains("tasks:delete"), "{}", no_delete.message());

    // a read token reads, never writes
    let read = token(db, "ws_acme", "u_owner", TokenScope::Read, None, None).await;
    assert_eq!(w.send(Req::get(T).bearer(&read)).await.status, StatusCode::OK);
    let res =
        w.send(Req::post(T).bearer(&read).json(&json!({ "kind": "bug", "title": "x" }))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // a write token creates but is not the owner's delete
    let write = token(db, "ws_acme", "u_member", TokenScope::Write, None, None).await;
    let res =
        w.send(Req::post(T).bearer(&write).json(&json!({ "kind": "bug", "title": "ok" }))).await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(events(&w, "issue.created").await.last().unwrap().actor["id"], "u_member");
    w.drop().await;
}

#[tokio::test]
async fn per_token_budgets_answer_429_on_tasks() {
    let Some(w) = World::new().await else { return };
    let _t = team(&w).await;
    let db = w.db();
    let secret = token(
        db,
        "ws_acme",
        "u_owner",
        TokenScope::Custom,
        Some(&["tasks:write"]),
        Some(json!({ "writesPerMinute": 2 })),
    )
    .await;
    let post =
        |title: &str| Req::post(T).bearer(&secret).json(&json!({ "kind": "bug", "title": title }));
    assert_eq!(w.send(post("one")).await.status, StatusCode::CREATED);
    assert_eq!(w.send(post("two")).await.status, StatusCode::CREATED);
    let blocked = w.send(post("three")).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(blocked.message(), "Token limit reached: 2 writes per minute. Slow down.");
    // reads are not writes
    assert_eq!(w.send(Req::get(T).bearer(&secret)).await.status, StatusCode::OK);
    w.drop().await;
}

// ───────────────────────── bulk ─────────────────────────

#[tokio::test]
async fn bulk_updates_and_deletes_are_all_or_nothing() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    let a = made(&w, &t.owner, &json!({ "kind": "bug", "title": "A" })).await;
    let b = made(&w, &t.owner, &json!({ "kind": "bug", "title": "B" })).await;
    let bulk = |body: Value| {
        let req = Req::post(&format!("{T}/bulk")).session(&t.owner).json(&body);
        w.send(req)
    };

    let res = bulk(
        json!({ "ids": [a["key"], b["id"]], "patch": { "priority": "high", "assigneeId": null } }),
    )
    .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    let updated = res.body.as_array().unwrap();
    assert_eq!(updated.len(), 2);
    assert!(updated.iter().all(|i| i["priority"] == "high"));

    // an unknown task rejects the whole request, naming it
    let res = bulk(json!({ "ids": [a["key"], "NOPE-1"], "patch": { "priority": "low" } })).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert!(res.message().contains("NOPE-1"), "{}", res.message());
    assert_eq!(get(&w, &t.owner, a["id"].as_str().unwrap()).await.body["priority"], "high");

    // the body is validated
    for body in [
        json!({ "patch": { "status": "done" } }),
        json!({ "ids": [], "patch": { "status": "done" } }),
        json!({ "ids": [a["id"]] }),
        json!({ "ids": [a["id"], a["id"]], "patch": { "status": "done" } }),
        json!({ "ids": [a["id"]], "patch": { "priority": null } }),
        json!({ "ids": [a["id"]], "patch": { "addLabels": [1] } }),
        json!({ "ids": [a["id"]], "patch": {} }),
        json!({ "ids": (0..101).map(|i| format!("in_{i}")).collect::<Vec<_>>(), "patch": { "status": "done" } }),
    ] {
        let res = bulk(body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}: {}", res.message());
    }

    let res = w
        .send(
            Req::post(&format!("{T}/bulk-delete"))
                .session(&t.owner)
                .json(&json!({ "ids": [a["id"], "NOPE-1"] })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&w, &t.owner, a["id"].as_str().unwrap()).await.status, StatusCode::OK);
    let res = w
        .send(
            Req::post(&format!("{T}/bulk-delete"))
                .session(&t.owner)
                .json(&json!({ "ids": [a["id"], b["key"]] })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "deleted": [a["id"], b["id"]] }));
    assert_eq!(events(&w, "issue.deleted").await.len(), 2);
    w.drop().await;
}

// ───────────────────────── routing edges ─────────────────────────

#[tokio::test]
async fn bulk_is_not_a_task_reference_for_reads() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    // NestJS routes `GET /tasks/bulk` to `:idOrKey`
    let res = get(&w, &t.owner, "bulk").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Issue \"bulk\" not found");
    // `bulk-delete` likewise, and so do the other verbs
    let res = get(&w, &t.owner, "bulk-delete").await;
    assert_eq!(res.message(), "Issue \"bulk-delete\" not found");
    let res = patch(&w, &t.owner, "bulk", &json!({ "title": "x" })).await;
    assert_eq!(
        (res.status, res.message()),
        (StatusCode::NOT_FOUND, "Issue \"bulk\" not found".into())
    );
    let res = w.send(Req::delete(&format!("{T}/bulk")).session(&t.owner)).await;
    assert_eq!(
        (res.status, res.message()),
        (StatusCode::NOT_FOUND, "Issue \"bulk\" not found".into())
    );
    let res = w.send(Req::delete(&format!("{T}/bulk")).session(&t.viewer)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    w.drop().await;
}

#[tokio::test]
async fn resolves_a_task_by_id_key_any_case_and_a_former_key() {
    let Some(w) = World::new().await else { return };
    let t = team(&w).await;
    project(w.db(), "ws_acme", "pj_a", "AUTH").await;
    issue(w.db(), "ws_acme", "in_1", "AUTH-1", Some("pj_a"), &["OLD-1"]).await;
    for reference in ["in_1", "AUTH-1", "auth-1", "OLD-1", "old-1"] {
        let res = get(&w, &t.owner, reference).await;
        assert_eq!(res.status, StatusCode::OK, "{reference}");
        assert_eq!(res.body["id"], "in_1");
    }
    let res = get(&w, &t.owner, "NOPE-9").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Issue \"NOPE-9\" not found");
    w.drop().await;
}
