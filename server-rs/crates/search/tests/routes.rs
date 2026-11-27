//! `GET /api/w/{slug}/search` behind the real access guard: `search.service.spec.ts` and the
//! searches of the NestJS `projects` and `guests` e2e specs.

mod common;

use axum::http::StatusCode;
use serde_json::json;
use trama_contracts::access::{MemberAction, MemberGrant, MemberResource};
use trama_contracts::roles::fresh_workspace_roles;

use common::{
    Req, World, artifact, issue, only_projects, person, project, sql, workspace,
    workspace_with_roles,
};

const URL: &str = "/api/w/acme/search";

fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

struct Fx {
    w: World,
    member: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let member = person(w.db(), "acme", "u_member", "member", None).await;
    Some(Fx { w, member })
}

impl Fx {
    async fn get(&self, query: &str) -> common::Res {
        self.w.send(Req::get(&format!("{URL}?{query}")).session(&self.member)).await
    }

    async fn ids(&self, query: &str) -> Vec<String> {
        let res = self.get(query).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.ids()
    }
}

/// `projects are searchable`: by name, and by summary with `types=project`.
#[tokio::test]
async fn finds_projects_by_name_summary_and_description() {
    let Some(f) = fx().await else { return };
    project(
        f.w.db(),
        "ws_acme",
        "pj_z",
        "Zebra rollout",
        Some("Quagga migration"),
        Some("Stripes"),
    )
    .await;
    project(f.w.db(), "ws_acme", "pj_o", "Other", None, None).await;

    let res = f.get("q=zebra").await;
    assert_eq!(res.body["results"][0]["type"], "project");
    assert_eq!(res.ids(), ["pj_z"]);
    assert_eq!(
        res.body["results"][0],
        json!({ "type": "project", "id": "pj_z", "title": "Zebra rollout", "subtitle": "planned", "score": 55 })
    );
    assert_eq!(f.ids("q=quagga&types=project").await, ["pj_z"]);
    assert_eq!(f.ids("q=stripes").await, ["pj_z"]);
    // a body-only match scores 20
    assert_eq!(f.get("q=quagga").await.body["results"][0]["score"], 20);
    f.w.drop().await;
}

#[tokio::test]
async fn finds_issues_by_key_alias_title_and_body() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "BUG-1", "Login broken", None).await;
    sql(f.w.db(), r#"UPDATE issues SET aliases = '["OLD-12"]', body = 'Stack trace on submit' WHERE id = 'in_1'"#).await;
    issue(f.w.db(), "ws_acme", "in_2", "BUG-10", "Other", None).await;

    let by_key = f.get("q=bug-1").await;
    // the exact key beats a key prefix
    assert_eq!(by_key.ids(), ["in_1", "in_2"]);
    assert_eq!(by_key.body["results"][0]["score"], 100);
    assert_eq!(by_key.body["results"][1]["score"], 80);
    assert_eq!(
        by_key.body["results"][0],
        json!({ "type": "issue", "id": "in_1", "key": "BUG-1", "title": "Login broken", "subtitle": "bug · todo", "score": 100 })
    );
    assert_eq!(f.ids("q=old-12").await, ["in_1"]);
    assert_eq!(f.ids("q=login").await, ["in_1"]);
    assert_eq!(f.get("q=stack").await.body["results"][0]["score"], 20);
    f.w.drop().await;
}

#[tokio::test]
async fn every_word_must_match_and_special_characters_are_literal() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "A-1", "Fix login page", None).await;
    issue(f.w.db(), "ws_acme", "in_2", "A-2", "Fix signup", None).await;
    issue(f.w.db(), "ws_acme", "in_3", "A-3", "100% done_ready", None).await;
    issue(f.w.db(), "ws_acme", "in_4", "A-4", "100 done ready", None).await;

    assert_eq!(f.ids("q=fix%20page").await, ["in_1"]);
    assert_eq!(f.ids("q=page%20fix").await, ["in_1"]);
    assert_eq!(f.ids("q=fix").await.len(), 2);
    assert_eq!(f.ids(&format!("q={}", encode("100%"))).await, ["in_3"]);
    assert_eq!(f.ids(&format!("q={}", encode("done_ready"))).await, ["in_3"]);
    assert_eq!(f.ids(&format!("q={}", encode("a\\b"))).await, Vec::<String>::new());
    // only the first six words count: `nope` is not looked for
    assert_eq!(f.ids("q=fix%20login%20page%20x%20x%20x%20nope").await, ["in_1"]);
    assert_eq!(f.ids("q=fix%20login%20page%20x%20x%20nope").await, Vec::<String>::new());
    f.w.drop().await;
}

#[tokio::test]
async fn artifacts_keep_a_retired_workstream_as_provenance() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a", "Alpha", None, None).await;
    issue(f.w.db(), "ws_acme", "in_1", "A-1", "Owner", Some("pj_a")).await;
    artifact(f.w.db(), "ws_acme", "ar_1", "Build", Some("#42"), Some("in_1"), None).await;
    artifact(f.w.db(), "ws_acme", "ar_old", "Build of old", None, None, Some("OLD-7")).await;

    let res = f.get("q=build&types=artifact").await;
    assert_eq!(res.ids(), ["ar_1", "ar_old"]);
    assert_eq!(
        res.body["results"][0],
        json!({ "type": "artifact", "id": "ar_1", "key": "#42", "title": "Build", "subtitle": "build · open", "score": 70 })
    );
    assert_eq!(
        res.body["results"][1],
        json!({ "type": "artifact", "id": "ar_old", "title": "Build of old", "subtitle": "build · open", "legacyWorkstreamKey": "OLD-7", "score": 55 })
    );
    assert_eq!(f.ids("q=%2342&types=artifact").await, ["ar_1"]);
    f.w.drop().await;
}

#[tokio::test]
async fn ties_go_to_projects_then_issues_then_artifacts_then_title() {
    let Some(f) = fx().await else { return };
    // all four titles are a plain prefix match (55)
    project(f.w.db(), "ws_acme", "pj_1", "Spark project", None, None).await;
    issue(f.w.db(), "ws_acme", "in_b", "S-2", "spark beta", None).await;
    issue(f.w.db(), "ws_acme", "in_a", "S-1", "Spark Alpha", None).await;
    artifact(f.w.db(), "ws_acme", "ar_1", "Spark build", None, Some("in_a"), None).await;
    assert_eq!(f.ids("q=spark").await, ["pj_1", "in_a", "in_b", "ar_1"]);
    // `types` narrows it down; an unknown type is not accepted
    assert_eq!(f.ids("q=spark&types=issue,artifact").await, ["in_a", "in_b", "ar_1"]);
    assert_eq!(f.ids("q=spark&types=").await.len(), 4);
    f.w.drop().await;
}

/// `finds decisions and thread records, each with its task`.
#[tokio::test]
async fn finds_decisions_and_thread_records_each_with_its_task() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "TRM-128", "Refresh alerts", None).await;
    issue(f.w.db(), "ws_acme", "in_2", "TRM-129", "Unrelated", None).await;
    sql(
        f.w.db(),
        r#"INSERT INTO task_decisions (id, "workspaceId", "issueId", text, paths, "createdBy")
           VALUES ('dc_1', 'ws_acme', 'in_1', 'Keep refresh tokens server side', '["src/auth/*"]',
                   '{"type":"agent","id":"ag_1"}'),
                  ('dc_2', 'ws_acme', 'in_2', 'Use a queue', '["src/jobs/*"]',
                   '{"type":"agent","id":"ag_1"}')"#,
    )
    .await;
    sql(
        f.w.db(),
        r#"INSERT INTO task_thread_records ("issueId", "workspaceId", summary, "lastSyncBy")
           VALUES ('in_1', 'ws_acme', 'Added metrics for refresh', '{"type":"agent","id":"ag_1"}')"#,
    )
    .await;

    let res = f.get("q=refresh&types=decision,record").await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    let results = res.body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "{results:?}");
    let decision = results.iter().find(|r| r["type"] == "decision").unwrap();
    assert_eq!(
        *decision,
        json!({
            "type": "decision", "id": "dc_1", "key": "TRM-128", "issueId": "in_1",
            "title": "Keep refresh tokens server side", "subtitle": "Refresh alerts", "score": 40
        })
    );
    // the hit of a record is its task: title = the task's title, subtitle = the summary
    let record = results.iter().find(|r| r["type"] == "record").unwrap();
    assert_eq!(
        *record,
        json!({
            "type": "record", "id": "in_1", "key": "TRM-128", "issueId": "in_1",
            "title": "Refresh alerts", "subtitle": "Added metrics for refresh", "score": 55
        })
    );
    // the task key finds both of its hits; the decision paths are searchable
    assert_eq!(f.ids("q=trm-128&types=decision,record").await, ["dc_1", "in_1"]);
    assert_eq!(f.ids("q=src%2Fjobs&types=decision").await, ["dc_2"]);
    // without `types` every kind is searched
    assert_eq!(f.ids("q=refresh").await, ["in_1", "in_1", "dc_1"]);
    f.w.drop().await;
}

#[tokio::test]
async fn decisions_and_records_follow_the_project_of_their_task() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a", "Alpha", None, None).await;
    project(f.w.db(), "ws_acme", "pj_b", "Beta", None, None).await;
    issue(f.w.db(), "ws_acme", "in_a", "A-1", "Visible task", Some("pj_a")).await;
    issue(f.w.db(), "ws_acme", "in_b", "B-1", "Hidden task", Some("pj_b")).await;
    issue(f.w.db(), "ws_acme", "in_free", "F-1", "Free task", None).await;
    for (n, task) in [("a", "in_a"), ("b", "in_b"), ("free", "in_free")] {
        sql(
            f.w.db(),
            &format!(
                r#"INSERT INTO task_decisions (id, "workspaceId", "issueId", text, "createdBy")
                   VALUES ('dc_{n}', 'ws_acme', '{task}', 'Zebra decision {n}', '{{"type":"agent","id":"ag_1"}}');
                   INSERT INTO task_thread_records ("issueId", "workspaceId", summary, "lastSyncBy")
                   VALUES ('{task}', 'ws_acme', 'Zebra summary {n}', '{{"type":"agent","id":"ag_1"}}')"#
            ),
        )
        .await;
    }
    let narrowed =
        person(f.w.db(), "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false))).await;
    let get = |cookie: &str| f.w.send(Req::get(&format!("{URL}?q=zebra")).session(cookie));
    let mut ids = get(&narrowed).await.ids();
    ids.sort();
    assert_eq!(ids, ["dc_a", "in_a"]);
    let with_free =
        person(f.w.db(), "acme", "u_free", "member", Some(only_projects(&["pj_a"], true))).await;
    let mut ids = get(&with_free).await.ids();
    ids.sort();
    assert_eq!(ids, ["dc_a", "dc_free", "in_a", "in_free"]);
    assert_eq!(f.ids("q=zebra").await.len(), 6);
    f.w.drop().await;
}

#[tokio::test]
async fn limits_the_results() {
    let Some(f) = fx().await else { return };
    for n in 0..25 {
        issue(
            f.w.db(),
            "ws_acme",
            &format!("in_{n:02}"),
            &format!("K-{n}"),
            &format!("Item {n:02}"),
            None,
        )
        .await;
    }
    assert_eq!(f.ids("q=item").await.len(), 20);
    assert_eq!(f.ids("q=item&limit=3").await, ["in_00", "in_01", "in_02"]);
    assert_eq!(f.ids("q=item&limit=100").await.len(), 25);
    f.w.drop().await;
}

#[tokio::test]
async fn an_empty_search_finds_nothing() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "A-1", "Anything", None).await;
    for query in ["q=", "q=%20%20", "q=%C2%A0", "q=%09"] {
        let res = f.get(query).await;
        assert_eq!((res.status, res.body), (StatusCode::OK, json!({ "results": [] })), "{query}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn validates_the_query_like_class_validator() {
    let Some(f) = fx().await else { return };
    let types = "each value in types must be one of the following values: project, issue, artifact, decision, record";
    let limit = "limit must not be greater than 100; limit must not be less than 1; limit must be an integer number";
    for (query, message) in [
        ("", "q must be a string".to_owned()),
        ("q=a&q=b", "q must be a string".to_owned()),
        ("q=a&types=customer", types.to_owned()),
        ("q=a&types=issue&types=nope", types.to_owned()),
        ("q=a&limit=0", "limit must not be less than 1".to_owned()),
        ("q=a&limit=101", "limit must not be greater than 100".to_owned()),
        ("q=a&limit=x", limit.to_owned()),
    ] {
        let res = f.get(query).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(res.message(), message, "{query}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn stays_inside_the_workspace_and_needs_a_member() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "other").await;
    issue(f.w.db(), "ws_acme", "in_1", "A-1", "Zebra mine", None).await;
    issue(f.w.db(), "ws_other", "in_2", "B-1", "Zebra theirs", None).await;
    assert_eq!(f.ids("q=zebra").await, ["in_1"]);

    let anonymous = f.w.send(Req::get(&format!("{URL}?q=zebra"))).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    let stranger = person(f.w.db(), "other", "u_x", "member", None).await;
    let res = f.w.send(Req::get(&format!("{URL}?q=zebra")).session(&stranger)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

/// `a guest sees only their project: … search`, for a member limited to some projects.
#[tokio::test]
async fn limited_members_only_find_work_in_their_projects() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a", "Zebra shared", None, None).await;
    project(f.w.db(), "ws_acme", "pj_b", "Zebra secret", None, None).await;
    issue(f.w.db(), "ws_acme", "in_a", "A-1", "Zebra task", Some("pj_a")).await;
    issue(f.w.db(), "ws_acme", "in_b", "B-1", "Zebra hidden task", Some("pj_b")).await;
    issue(f.w.db(), "ws_acme", "in_free", "F-1", "Zebra unassigned task", None).await;
    artifact(f.w.db(), "ws_acme", "ar_a", "Zebra build", None, Some("in_a"), None).await;
    artifact(f.w.db(), "ws_acme", "ar_b", "Zebra secret build", None, Some("in_b"), None).await;
    artifact(f.w.db(), "ws_acme", "ar_old", "Zebra old build", None, None, Some("OLD-1")).await;

    let narrowed =
        person(f.w.db(), "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false))).await;
    let res = f.w.send(Req::get(&format!("{URL}?q=zebra")).session(&narrowed)).await;
    assert_eq!(res.ids(), ["pj_a", "in_a", "ar_a"]);

    let with_free =
        person(f.w.db(), "acme", "u_free", "member", Some(only_projects(&["pj_a"], true))).await;
    let res = f.w.send(Req::get(&format!("{URL}?q=zebra")).session(&with_free)).await;
    let mut ids = res.ids();
    ids.sort();
    assert_eq!(ids, ["ar_a", "ar_old", "in_a", "in_free", "pj_a"]);

    // everybody else finds everything
    assert_eq!(f.ids("q=zebra").await.len(), 8);
    f.w.drop().await;
}

#[tokio::test]
async fn skips_types_the_caller_cannot_view() {
    let Some(w) = World::new().await else { return };
    let mut roles = fresh_workspace_roles();
    for role in &mut roles {
        if role.id == "viewer" {
            role.grants
                .retain(|g| *g != MemberGrant::new(MemberResource::Issues, MemberAction::View));
        }
    }
    workspace_with_roles(w.db(), "acme", &roles).await;
    project(w.db(), "ws_acme", "pj_a", "Zebra", None, None).await;
    issue(w.db(), "ws_acme", "in_a", "A-1", "Zebra task", None).await;
    let viewer = person(w.db(), "acme", "u_v", "viewer", None).await;
    let res = w.send(Req::get(&format!("{URL}?q=zebra")).session(&viewer)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.ids(), ["pj_a"]);
    w.drop().await;
}
