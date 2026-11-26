//! `GET /api/public/views/{token}` against a real database: `public-views.spec.ts`.

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use trama_views::public::{PUBLIC_VIEW_LIMIT, PUBLIC_VIEW_SCAN_LIMIT};
use trama_views::rules::generate_public_token;

use common::{
    Req, Res, World, issue, many_issues, person, project, sql, workspace, workspace_with,
};
use trama_contracts::roles::fresh_workspace_roles;

const VIEWS: &str = "/api/w/acme/views";

struct Fx {
    w: World,
    owner: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace_with(
        w.db(),
        "acme",
        json!({
            "roles": fresh_workspace_roles(),
            "labels": [{"id": "lb_ui", "name": "UI", "color": "#2563eb", "template": false}]
        }),
    )
    .await;
    let owner = person(w.db(), "ws_acme", "u1", "owner").await;
    Some(Fx { w, owner })
}

impl Fx {
    /// Creates a view shared by link and returns its secret token.
    async fn link(&self, body: Value) -> String {
        let mut body = body;
        body["sharing"] = json!({"visibility": "link"});
        let res = self.w.send(Req::post(VIEWS).session(&self.owner).json(body)).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body["publicToken"].as_str().unwrap().to_owned()
    }

    async fn public(&self, token: &str) -> Res {
        self.w.send(Req::get(&format!("/api/public/views/{token}"))).await
    }

    async fn open(&self, view: Value) -> Value {
        let token = self.link(view).await;
        let res = self.public(&token).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body
    }
}

fn keys(group: &Value) -> Vec<&str> {
    group["items"].as_array().unwrap().iter().map(|i| i["key"].as_str().unwrap()).collect()
}

fn open_bugs() -> Value {
    json!({"name": "Open bugs", "entity": "issue",
           "filters": [{"field": "status", "op": "is", "value": "todo"}]})
}

#[tokio::test]
async fn returns_the_fixed_result_of_the_view_with_a_minimal_projection() {
    let Some(f) = fx().await else { return };
    for n in 1..=3 {
        let status = if n == 2 { "'done'" } else { "'todo'" };
        issue(f.w.db(), "ws_acme", n, &[("status", status), ("assigneeId", "'u1'")]).await;
    }
    let out = f.open(open_bugs()).await;
    assert_eq!(out["name"], "Open bugs");
    assert_eq!(out["entity"], "issue");
    assert_eq!(out["layout"], "list");
    assert_eq!(out["workspaceName"], "ACME");
    assert_eq!(out["total"], 2);
    assert_eq!(out["truncated"], false);
    assert!(out["generatedAt"].as_str().unwrap().ends_with('Z'));
    assert!(out.get("groupBy").is_none());
    let groups = out["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(keys(&groups[0]), ["BUG-1", "BUG-3"]);
    assert_eq!(
        groups[0]["items"][0],
        json!({
            "id": "in_acme_1", "key": "BUG-1", "title": "Issue 1", "kind": "bug",
            "status": "todo", "priority": "high", "assignee": "User u1", "labels": ["UI"],
            "updatedAt": "2026-02-01T00:00:00.000Z"
        })
    );
    f.w.drop().await;
}

#[tokio::test]
async fn never_leaks_private_fields() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", 1, &[("assigneeId", "'u1'")]).await;
    let token = f.link(open_bugs()).await;
    let res = f.public(&token).await;
    let json = res.body.to_string();
    for secret in [
        "PRIVATE BODY",
        "Secret Reporter",
        "u9",
        "internal.example",
        "u1@test.dev",
        "passwordHash",
        "workspaceId",
        "ws_acme",
        "ownerId",
        "filters",
        "publicToken",
        &token,
    ] {
        assert!(!json.contains(secret), "{secret} leaked: {json}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn groups_by_the_view_grouping_with_resolved_names_or_by_status_on_a_board() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "p1", "Apollo").await;
    issue(f.w.db(), "ws_acme", 1, &[("projectId", "'p1'")]).await;
    issue(f.w.db(), "ws_acme", 2, &[]).await;
    issue(f.w.db(), "ws_acme", 3, &[("projectId", "'p1'")]).await;
    let grouped = f
        .open(
            json!({"name": "By project", "entity": "issue", "groupBy": "projectId", "filters": []}),
        )
        .await;
    assert_eq!(grouped["groupBy"], "projectId");
    let summary: Vec<(String, String, usize)> = grouped["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["key"].as_str().unwrap().to_owned(),
                g["label"].as_str().unwrap().to_owned(),
                g["items"].as_array().unwrap().len(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [("p1".to_owned(), "Apollo".to_owned(), 2), (String::new(), String::new(), 1)]
    );
    // the issue shows the name of its project
    assert_eq!(grouped["groups"][0]["items"][0]["project"], "Apollo");

    sql(f.w.db(), "UPDATE issues SET status = 'done' WHERE key = 'BUG-2'").await;
    let board = f.open(json!({"name": "Board", "entity": "issue", "layout": "board"})).await;
    assert_eq!(board["groupBy"], "status");
    let order: Vec<&str> =
        board["groups"].as_array().unwrap().iter().map(|g| g["key"].as_str().unwrap()).collect();
    assert_eq!(order, ["todo", "done"]);
    f.w.drop().await;
}

#[tokio::test]
async fn applies_the_view_sort_and_the_direct_issue_project_filter() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "p1", "Apollo").await;
    issue(f.w.db(), "ws_acme", 1, &[("projectId", "'p1'")]).await;
    issue(f.w.db(), "ws_acme", 2, &[]).await;
    issue(f.w.db(), "ws_acme", 3, &[("projectId", "'p1'")]).await;
    let out = f
        .open(json!({"name": "P", "entity": "issue",
                     "filters": [{"field": "projectId", "op": "is", "value": "p1"}],
                     "sort": {"field": "title", "direction": "desc"}}))
        .await;
    assert_eq!(keys(&out["groups"][0]), ["BUG-3", "BUG-1"]);
    f.w.drop().await;
}

#[tokio::test]
async fn ignores_everything_the_request_carries() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", 1, &[]).await;
    let token = f.link(open_bugs()).await;
    // a query string, a session cookie and a body change nothing
    let res =
        f.w.send(
            Req::get(&format!(
                "/api/public/views/{token}?status=done&workspace=other&groupBy=title"
            ))
            .session(&f.owner),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["total"], 1);
    assert!(res.body.get("groupBy").is_none());
    f.w.drop().await;
}

#[tokio::test]
async fn never_reads_another_workspace() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "other").await;
    issue(f.w.db(), "ws_acme", 1, &[]).await;
    issue(f.w.db(), "ws_other", 1, &[("title", "'Theirs'"), ("key", "'THEIRS-1'")]).await;
    let out = f.open(json!({"name": "All", "entity": "issue"})).await;
    assert_eq!(out["total"], 1);
    assert!(!out.to_string().contains("THEIRS"));
    f.w.drop().await;
}

#[tokio::test]
async fn truncates_long_results() {
    let Some(f) = fx().await else { return };
    many_issues(f.w.db(), "ws_acme", PUBLIC_VIEW_LIMIT + 5).await;
    let out = f.open(json!({"name": "Many", "entity": "issue"})).await;
    assert_eq!(out["total"], PUBLIC_VIEW_LIMIT + 5);
    assert_eq!(out["truncated"], true);
    assert_eq!(out["groups"][0]["items"].as_array().unwrap().len(), PUBLIC_VIEW_LIMIT);
    f.w.drop().await;
}

#[tokio::test]
async fn rejects_views_that_exceed_the_bounded_evaluation_size() {
    let Some(f) = fx().await else { return };
    many_issues(f.w.db(), "ws_acme", PUBLIC_VIEW_SCAN_LIMIT + 1).await;
    let token = f.link(json!({"name": "Huge", "entity": "issue"})).await;
    let res = f.public(&token).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.message().contains("20,000-row evaluation limit"), "{}", res.message());
    // the same for projects
    f.w.drop().await;
}

#[tokio::test]
async fn returns_exact_totals_at_the_evaluation_limit() {
    let Some(f) = fx().await else { return };
    many_issues(f.w.db(), "ws_acme", PUBLIC_VIEW_SCAN_LIMIT).await;
    let out = f.open(json!({"name": "Edge", "entity": "issue"})).await;
    assert_eq!(out["total"], PUBLIC_VIEW_SCAN_LIMIT);
    assert_eq!(out["truncated"], true);
    assert_eq!(out["groups"][0]["items"].as_array().unwrap().len(), PUBLIC_VIEW_LIMIT);
    f.w.drop().await;
}

#[tokio::test]
async fn rejects_project_views_that_exceed_the_bounded_evaluation_size() {
    let Some(f) = fx().await else { return };
    sql(
        f.w.db(),
        &format!(
            r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key)
               SELECT 'pj_' || n, 'ws_acme', 'P' || n, 'blue', 'planned', 'none', lpad(to_hex(n), 4, '0')
               FROM generate_series(1, {}) AS n"#,
            PUBLIC_VIEW_SCAN_LIMIT + 1
        ),
    )
    .await;
    let token = f.link(json!({"name": "Huge", "entity": "project"})).await;
    let res = f.public(&token).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.message().contains("20,000-row evaluation limit"));
    f.w.drop().await;
}

#[tokio::test]
async fn answers_404_for_malformed_unknown_revoked_and_no_longer_public_tokens() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", 1, &[]).await;
    let token = f.link(open_bugs()).await;
    for bad in [
        "nope".to_owned(),
        "vt_x".to_owned(),
        generate_public_token(),
        format!("{token}x"),
        "..%2F..%2Fetc%2Fpasswd".to_owned(),
    ] {
        let res = f.public(&bad).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(res.message(), "This shared view does not exist or is no longer shared");
    }
    assert_eq!(f.public(&token).await.status, StatusCode::OK);

    // shared with the workspace only: the link no longer opens
    let id = f.w.send(Req::get(VIEWS).session(&f.owner)).await.body[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = format!("{VIEWS}/{id}");
    f.w.send(
        Req::patch(&uri).session(&f.owner).json(json!({"sharing": {"visibility": "workspace"}})),
    )
    .await;
    assert_eq!(f.public(&token).await.status, StatusCode::NOT_FOUND);
    // and a new link is a different one
    let back = f
        .w
        .send(Req::patch(&uri).session(&f.owner).json(json!({"sharing": {"visibility": "link"}})))
        .await;
    let fresh = back.body["publicToken"].as_str().unwrap();
    assert_ne!(fresh, token);
    assert_eq!(f.public(&token).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.public(fresh).await.status, StatusCode::OK);
    // rotating revokes the previous token
    let rotated =
        f.w.send(Req::post(&format!("{uri}/rotate-link")).session(&f.owner).json(json!({}))).await;
    assert_eq!(f.public(fresh).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.public(rotated.body["publicToken"].as_str().unwrap()).await.status,
        StatusCode::OK
    );
    // a deleted view takes its link along
    f.w.send(Req::delete(&uri).session(&f.owner)).await;
    assert_eq!(
        f.public(rotated.body["publicToken"].as_str().unwrap()).await.status,
        StatusCode::NOT_FOUND
    );
    f.w.drop().await;
}

#[tokio::test]
async fn a_view_whose_entity_was_retired_is_gone_for_everyone() {
    let Some(f) = fx().await else { return };
    let token = f.link(open_bugs()).await;
    sql(f.w.db(), "UPDATE saved_views SET entity = 'workstream'").await;
    assert_eq!(f.public(&token).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn sets_the_no_indexing_headers_on_answers_and_errors() {
    let Some(f) = fx().await else { return };
    let token = f.link(open_bugs()).await;
    for res in [f.public(&token).await, f.public("nope").await] {
        let header =
            |name: &str| res.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        assert_eq!(header("cache-control").as_deref(), Some("no-store"), "{}", res.status);
        assert_eq!(header("x-robots-tag").as_deref(), Some("noindex, nofollow"));
        assert_eq!(header("referrer-policy").as_deref(), Some("no-referrer"));
    }
    // it is the only method of the route
    let res = f.w.send(Req::post(&format!("/api/public/views/{token}")).json(json!({}))).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn project_views_show_dates_leads_and_sort_a_timeline_by_start() {
    let Some(f) = fx().await else { return };
    sql(
        f.w.db(),
        r#"INSERT INTO projects (id, "workspaceId", name, color, status, priority, key, health, "leadId", "startDate", "targetDate", labels)
           VALUES ('pj_b', 'ws_acme', 'Beta', 'blue', 'in_progress', 'urgent', 'BETA', 'at_risk', 'u1', '2026-03-01T00:00:00Z', '2026-06-30T00:00:00Z', '["lb_ui"]'),
                  ('pj_a', 'ws_acme', 'Alpha', 'blue', 'planned', 'none', 'ALPH', NULL, NULL, '2026-01-15T00:00:00Z', NULL, '[]'),
                  ('pj_c', 'ws_acme', 'Gamma', 'blue', 'planned', 'none', 'GAMM', NULL, NULL, NULL, NULL, '[]')"#,
    )
    .await;
    let out = f.open(json!({"name": "Roadmap", "entity": "project", "layout": "timeline"})).await;
    assert_eq!(out["entity"], "project");
    assert_eq!(out["layout"], "timeline");
    let items = out["groups"][0]["items"].as_array().unwrap();
    // by start date; the project without one goes last
    let titles: Vec<&str> = items.iter().map(|i| i["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Alpha", "Beta", "Gamma"]);
    assert_eq!(
        items[1],
        json!({
            "id": "pj_b", "title": "Beta", "status": "in_progress", "priority": "urgent",
            "health": "at_risk", "assignee": "User u1", "labels": ["UI"],
            "startDate": "2026-03-01T00:00:00.000Z", "targetDate": "2026-06-30T00:00:00.000Z",
            "updatedAt": items[1]["updatedAt"]
        })
    );
    // filtering projects by status and grouping them by lead
    let out = f
        .open(json!({"name": "Planned", "entity": "project", "groupBy": "leadId",
                     "filters": [{"field": "status", "op": "in", "value": ["planned", "in_progress"]}]}))
        .await;
    let groups: Vec<(&str, &str)> = out["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| (g["key"].as_str().unwrap(), g["label"].as_str().unwrap()))
        .collect();
    assert_eq!(groups, [("u1", "User u1"), ("", "")]);
    f.w.drop().await;
}

#[tokio::test]
async fn evaluates_legacy_filters_without_failing() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", 1, &[]).await;
    let token = f.link(json!({"name": "Legacy", "entity": "issue"})).await;
    // rows saved before the DTO validated filter values: numbers, null, an unknown operator
    sql(
        f.w.db(),
        r#"UPDATE saved_views SET filters = '[{"field":"title","op":"contains","value":1},{"field":"status","op":"is","value":null},{"field":"nope","op":"is","value":"x"}]'"#,
    )
    .await;
    let res = f.public(&token).await;
    assert_eq!(res.status, StatusCode::OK);
    // "Issue 1" contains "1", but a null value means "no status" and the issue has one
    assert_eq!(res.body["total"], 0);
    sql(
        f.w.db(),
        r#"UPDATE saved_views SET filters = '[{"field":"title","op":"contains","value":1}]'"#,
    )
    .await;
    assert_eq!(f.public(&token).await.body["total"], 1);
    // an operator this server does not know matches nothing
    sql(
        f.w.db(),
        r#"UPDATE saved_views SET filters = '[{"field":"title","op":"between","value":"x"}]'"#,
    )
    .await;
    assert_eq!(f.public(&token).await.body["total"], 0);
    f.w.drop().await;
}
