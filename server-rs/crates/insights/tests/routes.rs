//! `/api/w/{slug}/insights` behind the real access guard: `insights.service.spec.ts` and the
//! report's behaviour against real rows.

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use trama_contracts::insights::INSIGHT_SIGNAL_IDS;

use common::{
    Req, World, agent, event, issue, milestone, only_projects, person, project, pull_request, sql,
    user, workspace,
};

const URL: &str = "/api/w/acme/insights";

struct Fx {
    w: World,
    cookie: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let cookie = person(w.db(), "acme", "u_member", "member", None).await;
    Some(Fx { w, cookie })
}

impl Fx {
    async fn get(&self, path: &str) -> common::Res {
        self.w.send(Req::get(&format!("{URL}{path}")).session(&self.cookie)).await
    }

    async fn report(&self, query: &str) -> Value {
        let res = self.get(&format!("?{query}")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body
    }
}

fn signal<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["signals"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap()
}

fn item_ids(signal: &Value) -> Vec<&str> {
    signal["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn returns_all_current_contract_signals_with_an_empty_scope() {
    let Some(f) = fx().await else { return };
    let report = f.report("").await;

    let ids: Vec<_> =
        report["signals"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    let expected: Vec<_> = INSIGHT_SIGNAL_IDS.iter().map(|id| id.as_str()).collect();
    assert_eq!(ids, expected);
    for s in report["signals"].as_array().unwrap() {
        assert_eq!(
            (s["count"].clone(), s["items"].clone(), s["severity"].clone(), s["truncated"].clone()),
            (json!(0), json!([]), json!("ok"), json!(false))
        );
        assert!(s.get("oldestDays").is_none());
    }
    assert_eq!(report["signals"][0]["label"], "Stale issues");
    assert_eq!(report["signals"][3]["unit"], "pull request");
    assert!(!report["flow"]["throughput"].as_array().unwrap().is_empty());
    assert_eq!(
        report["actors"],
        json!({ "people": [], "agents": [], "share": { "people": 0, "agents": 0 }, "failures": [] })
    );
    assert_eq!(report["scope"], json!({}));
    assert_eq!(report["staleDays"], 7);
    assert_eq!(report["range"]["days"], 30);
    assert!(report["generatedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(report["bottlenecks"], json!([]));
    assert_eq!(
        report["flow"]["issueCycle"],
        json!({ "stats": { "count": 0 }, "histogram": [], "slowest": [] })
    );
    assert_eq!(report["flow"]["previousThroughput"], json!({ "issuesDone": 0 }));
    assert_eq!(
        report["flow"]["wip"],
        json!({ "people": [], "agents": [], "limits": { "issues": 5 } })
    );
    assert_eq!(report["flow"]["aging"], json!({ "baselineSamples": 0, "items": [] }));
    f.w.drop().await;
}

#[tokio::test]
async fn applies_a_project_filter_without_leaking_items() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_ok", "started").await;
    project(f.w.db(), "ws_acme", "pj_other", "started").await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_ok",
        Some("pj_ok"),
        &[("status", "'in_progress'"), ("updatedAt", "now() - interval '10 days'")],
    )
    .await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_other",
        Some("pj_other"),
        &[("status", "'in_progress'"), ("updatedAt", "now() - interval '10 days'")],
    )
    .await;

    let report = f.report("projectId=pj_ok").await;
    assert_eq!(report["scope"], json!({ "projectId": "pj_ok" }));
    assert_eq!(item_ids(signal(&report, "stale_issues")), ["in_ok"]);
    assert_eq!(item_ids(signal(&f.report("").await, "stale_issues")).len(), 2);
    // an empty `projectId` is no filter
    assert_eq!(f.report("projectId=").await["scope"], json!({}));

    let missing = f.get("?projectId=pj_nope").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.message(), "Project not found");
    f.w.drop().await;
}

#[tokio::test]
async fn stale_issues_are_in_flight_and_idle() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a", "started").await;
    let idle = |days: u32| format!("now() - interval '{days} days'");
    issue(
        f.w.db(),
        "ws_acme",
        "in_old",
        Some("pj_a"),
        &[("status", "'in_progress'"), ("updatedAt", &idle(10)), ("assigneeId", "NULL")],
    )
    .await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_older",
        Some("pj_a"),
        &[("status", "'in_review'"), ("updatedAt", &idle(20))],
    )
    .await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_fresh",
        Some("pj_a"),
        &[("status", "'in_progress'"), ("updatedAt", &idle(2))],
    )
    .await;
    issue(f.w.db(), "ws_acme", "in_todo", Some("pj_a"), &[("updatedAt", &idle(50))]).await;

    let report = f.report("").await;
    let stale = signal(&report, "stale_issues");
    assert_eq!(item_ids(stale), ["in_older", "in_old"]);
    assert_eq!(
        (stale["count"].clone(), stale["severity"].clone(), stale["oldestDays"].clone()),
        (json!(2), json!("warning"), json!(20))
    );
    assert_eq!(
        stale["items"][1],
        json!({
            "type": "issue", "id": "in_old", "key": "K-in_old", "title": "Issue in_old", "projectId": "pj_a",
            "since": stale["items"][1]["since"], "ageDays": 10,
            "detail": "In-flight Issue has not been updated recently.",
        })
    );
    assert_eq!(item_ids(signal(&f.report("staleDays=15").await, "stale_issues")), ["in_older"]);

    // the item limit cuts the list, not the count
    let cut = f.report("limit=1").await;
    let stale = signal(&cut, "stale_issues");
    assert_eq!(
        (stale["count"].clone(), item_ids(stale), stale["truncated"].clone()),
        (json!(2), vec!["in_older"], json!(true))
    );
    f.w.drop().await;
}

#[tokio::test]
async fn overdue_milestones_have_open_issues_in_a_live_project() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_live", "started").await;
    project(f.w.db(), "ws_acme", "pj_done", "completed").await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_live",
        Some("pj_live"),
        &[("milestoneIds", r#"'["ms_late", "ms_future"]'"#)],
    )
    .await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_done",
        Some("pj_done"),
        &[("milestoneIds", r#"'["ms_closed"]'"#)],
    )
    .await;
    issue(
        f.w.db(),
        "ws_acme",
        "in_shipped",
        Some("pj_live"),
        &[
            ("status", "'done'"),
            ("completedAt", "now() - interval '1 day'"),
            ("milestoneIds", r#"'["ms_empty"]'"#),
        ],
    )
    .await;
    milestone(f.w.db(), "ws_acme", "ms_late", "pj_live", 5).await;
    milestone(f.w.db(), "ws_acme", "ms_empty", "pj_live", 5).await;
    milestone(f.w.db(), "ws_acme", "ms_closed", "pj_done", 5).await;
    sql(f.w.db(), r#"INSERT INTO milestones (id, "workspaceId", name, "projectId", "targetDate") VALUES ('ms_future', 'ws_acme', 'Future', 'pj_live', now() + interval '5 days')"#).await;

    let report = f.report("").await;
    let overdue = signal(&report, "overdue_milestones");
    assert_eq!(item_ids(overdue), ["ms_late"]);
    assert_eq!(overdue["severity"], "warning");
    let item = &overdue["items"][0];
    assert_eq!(item["type"], "milestone");
    assert_eq!(item["title"], "Milestone ms_late");
    assert_eq!(item["projectId"], "pj_live");
    assert_eq!(item["detail"], "1 open Issues remain.");
    assert_eq!(item["ageDays"], 5);
    assert!(item.get("key").is_none());

    // a project filter keeps only that project's milestones
    assert_eq!(
        item_ids(signal(&f.report("projectId=pj_done").await, "overdue_milestones")),
        Vec::<&str>::new()
    );
    f.w.drop().await;
}

#[tokio::test]
async fn pull_request_signals_and_review_bottlenecks() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", None, &[]).await;
    pull_request(f.w.db(), "ws_acme", "pr_old", "in_1", 5, &[("review", "'requested'")]).await;
    pull_request(f.w.db(), "ws_acme", "pr_older", "in_1", 9, &[]).await;
    pull_request(f.w.db(), "ws_acme", "pr_new", "in_1", 1, &[]).await;
    pull_request(f.w.db(), "ws_acme", "pr_red", "in_1", 1, &[("ci", "'failing'")]).await;
    pull_request(f.w.db(), "ws_acme", "pr_merged", "in_1", 30, &[("state", "'merged'")]).await;
    pull_request(f.w.db(), "ws_acme", "mr_old", "in_1", 4, &[("kind", "'merge_request'")]).await;
    pull_request(f.w.db(), "ws_acme", "build", "in_1", 30, &[("kind", "'build'")]).await;

    let report = f.report("").await;
    let stuck = signal(&report, "prs_stuck_in_review");
    assert_eq!(item_ids(stuck), ["pr_older", "pr_old", "mr_old"]);
    assert_eq!(
        (stuck["count"].clone(), stuck["severity"].clone(), stuck["oldestDays"].clone()),
        (json!(3), json!("info"), json!(9))
    );
    assert_eq!(
        stuck["items"][1]["detail"],
        "Open pull request has no approval and has been inactive for at least 3 days."
    );
    assert_eq!(stuck["items"][1]["type"], "artifact");
    assert_eq!(stuck["items"][1]["title"], "PR pr_old");
    let failing = signal(&report, "ci_failing");
    assert_eq!(item_ids(failing), ["pr_red"]);
    assert_eq!(failing["items"][0]["detail"], "Latest pull request CI result is failing.");

    // nobody is known to wait for these reviews
    assert_eq!(
        report["bottlenecks"],
        json!([{ "actor": { "type": "unassigned", "name": "Unassigned" }, "reviews": 3, "oldestDays": 9, "totalWaitDays": 18 }])
    );
    f.w.drop().await;
}

#[tokio::test]
async fn flow_metrics_cover_finished_issues_of_the_range() {
    let Some(f) = fx().await else { return };
    let ago = |days: u32| format!("now() - interval '{days} days'");
    for (id, started, completed) in [
        ("d1", ago(12), ago(10)),
        ("d2", "NULL".to_owned(), ago(3)),
        ("d_before", ago(70), ago(60)),
    ] {
        let extra = [
            ("status", "'done'"),
            ("startedAt", started.as_str()),
            ("completedAt", completed.as_str()),
        ];
        issue(f.w.db(), "ws_acme", id, None, &extra).await;
    }
    let report = f.report("").await;
    let flow = &report["flow"];
    assert_eq!(
        flow["issueCycle"]["stats"],
        json!({ "count": 1, "p50": 2, "p85": 2, "p95": 2, "mean": 2, "max": 2 })
    );
    assert_eq!(
        flow["issueLead"]["stats"],
        json!({ "count": 2, "p50": 30, "p85": 37, "p95": 37, "mean": 33.5, "max": 37 })
    );
    let counts: Vec<_> = flow["throughput"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["issuesDone"].as_i64().unwrap())
        .collect();
    assert_eq!(counts, [0, 0, 1, 1, 0]);
    assert_eq!(flow["throughput"][4]["end"], report["range"]["to"]);

    // a 7 day range is one bucket and leaves out what finished before it
    let week = f.report("days=7").await;
    assert_eq!(week["flow"]["throughput"].as_array().unwrap().len(), 1);
    assert_eq!(week["flow"]["throughput"][0]["issuesDone"], 1);
    assert_eq!(week["flow"]["issueLead"]["stats"]["count"], 1);
    assert_eq!(f.report("days=90").await["flow"]["throughput"].as_array().unwrap().len(), 13);
    f.w.drop().await;
}

#[tokio::test]
async fn work_in_progress_names_people_and_flags_overload() {
    let Some(f) = fx().await else { return };
    user(f.w.db(), "u_ada", "Ada").await;
    user(f.w.db(), "u_bob", "Bob").await;
    for n in 0..6 {
        issue(
            f.w.db(),
            "ws_acme",
            &format!("in_a{n}"),
            None,
            &[("status", "'in_progress'"), ("assigneeId", "'u_ada'")],
        )
        .await;
    }
    issue(
        f.w.db(),
        "ws_acme",
        "in_b",
        None,
        &[("status", "'in_review'"), ("assigneeId", "'u_bob'")],
    )
    .await;
    issue(f.w.db(), "ws_acme", "in_todo", None, &[("assigneeId", "'u_bob'")]).await;

    let wip = f.report("").await["flow"]["wip"].clone();
    let people = wip["people"].as_array().unwrap();
    assert_eq!(people.len(), 2);
    assert_eq!(people[0]["actor"], json!({ "type": "user", "id": "u_ada", "name": "Ada" }));
    assert_eq!(
        (people[0]["issues"].clone(), people[0]["overloaded"].clone()),
        (json!(6), json!(true))
    );
    assert_eq!(people[0]["items"].as_array().unwrap().len(), 6);
    assert_eq!(people[0]["items"][0]["detail"], "Assigned in-flight Issue.");
    assert_eq!(people[1]["actor"]["name"], "Bob");
    assert_eq!(
        (people[1]["issues"].clone(), people[1]["overloaded"].clone()),
        (json!(1), json!(false))
    );
    f.w.drop().await;
}

#[tokio::test]
async fn contributors_come_from_the_events_of_the_visible_issues() {
    let Some(f) = fx().await else { return };
    user(f.w.db(), "u_ada", "Ada").await;
    agent(f.w.db(), "ws_acme", "ag_robo", "Robo").await;
    issue(f.w.db(), "ws_acme", "in_1", None, &[]).await;
    event(f.w.db(), "ws_acme", "ev_1", ("user", "u_ada"), "issue.updated", "in_1", 1).await;
    event(f.w.db(), "ws_acme", "ev_2", ("user", "u_ada"), "issue.updated", "in_1", 2).await;
    event(f.w.db(), "ws_acme", "ev_3", ("user", "u_ada"), "issue.status_changed", "in_1", 3).await;
    event(f.w.db(), "ws_acme", "ev_4", ("agent", "ag_robo"), "issue.created", "in_1", 1).await;
    // not counted: outside the range, another subject, a system actor
    event(f.w.db(), "ws_acme", "ev_5", ("user", "u_ada"), "issue.updated", "in_1", 40).await;
    event(f.w.db(), "ws_acme", "ev_6", ("user", "u_ada"), "issue.updated", "in_other", 1).await;
    event(f.w.db(), "ws_acme", "ev_7", ("system", "sys"), "issue.updated", "in_1", 1).await;
    // an actor that no longer exists
    event(f.w.db(), "ws_acme", "ev_8", ("user", "u_gone"), "issue.updated", "in_1", 1).await;

    let actors = f.report("").await["actors"].clone();
    let people = actors["people"].as_array().unwrap();
    assert_eq!(people.len(), 2);
    assert_eq!(people[0]["actor"], json!({ "type": "user", "id": "u_ada", "name": "Ada" }));
    assert_eq!(
        (
            people[0]["events"].clone(),
            people[0]["issuesDone"].clone(),
            people[0]["comments"].clone(),
            people[0]["pullRequests"].clone()
        ),
        (json!(3), json!(1), json!(0), json!(0))
    );
    assert!(people[0]["lastActiveAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(people[1]["actor"]["name"], "Unknown");
    assert_eq!(
        actors["agents"][0]["actor"],
        json!({ "type": "agent", "id": "ag_robo", "name": "Robo" })
    );
    assert_eq!(actors["agents"][0]["events"], 1);
    assert_eq!(actors["share"], json!({ "people": 0.8, "agents": 0.2 }));
    assert_eq!(actors["failures"], json!([]));

    // a 7 day range drops the older events
    let week = f.report("days=7").await["actors"].clone();
    assert_eq!(week["people"][0]["events"], 3);
    f.w.drop().await;
}

#[tokio::test]
async fn one_signal_with_up_to_a_hundred_items() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", None, &[]).await;
    for n in 0..30 {
        pull_request(f.w.db(), "ws_acme", &format!("pr_{n:02}"), "in_1", 1, &[("ci", "'failing'")])
            .await;
    }
    let res = f.get("/signals/ci_failing").await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(res.body["id"], "ci_failing");
    assert_eq!(res.body["items"].as_array().unwrap().len(), 30);
    assert_eq!(res.body["truncated"], false);
    // the report itself lists 25
    let report = f.report("").await;
    assert_eq!(signal(&report, "ci_failing")["items"].as_array().unwrap().len(), 25);
    assert_eq!(signal(&report, "ci_failing")["truncated"], true);
    let cut = f.get("/signals/ci_failing?limit=2").await;
    assert_eq!(cut.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(cut.body["count"], 30);

    let unknown = f.get("/signals/nope").await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.message(), "Unknown signal \"nope\"");
    // the query is validated before the signal is looked up
    assert_eq!(f.get("/signals/nope?days=14").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.get("/signals/ci_failing?projectId=pj_nope").await.message(), "Project not found");
    f.w.drop().await;
}

#[tokio::test]
async fn validates_the_query_like_class_validator() {
    let Some(f) = fx().await else { return };
    for (query, message) in [
        ("days=14", "days must be one of the following values: 7, 30, 90"),
        ("days=x", "days must be one of the following values: 7, 30, 90"),
        ("projectId=a&projectId=b", "projectId must be a string"),
        ("staleDays=0", "staleDays must not be less than 1"),
        ("staleDays=91", "staleDays must not be greater than 90"),
        ("limit=501", "limit must not be greater than 500"),
        ("limit=1.5", "limit must be an integer number"),
    ] {
        let res = f.get(&format!("?{query}")).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(res.message(), message, "{query}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn needs_a_member() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "other").await;
    let anonymous = f.w.send(Req::get(URL)).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    let stranger = person(f.w.db(), "other", "u_x", "member", None).await;
    let res = f.w.send(Req::get(URL).session(&stranger)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // a viewer may read
    let viewer = person(f.w.db(), "acme", "u_viewer", "viewer", None).await;
    assert_eq!(f.w.send(Req::get(URL).session(&viewer)).await.status, StatusCode::OK);
    f.w.drop().await;
}

#[tokio::test]
async fn limited_members_only_see_their_projects() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a", "started").await;
    project(f.w.db(), "ws_acme", "pj_b", "started").await;
    let idle = ("updatedAt", "now() - interval '10 days'");
    issue(f.w.db(), "ws_acme", "in_a", Some("pj_a"), &[("status", "'in_progress'"), idle]).await;
    issue(f.w.db(), "ws_acme", "in_b", Some("pj_b"), &[("status", "'in_progress'"), idle]).await;
    issue(f.w.db(), "ws_acme", "in_free", None, &[("status", "'in_progress'"), idle]).await;
    pull_request(f.w.db(), "ws_acme", "pr_a", "in_a", 5, &[]).await;
    pull_request(f.w.db(), "ws_acme", "pr_b", "in_b", 5, &[]).await;
    user(f.w.db(), "u_ada", "Ada").await;
    event(f.w.db(), "ws_acme", "ev_a", ("user", "u_ada"), "issue.updated", "in_a", 1).await;
    event(f.w.db(), "ws_acme", "ev_b", ("user", "u_ada"), "issue.updated", "in_b", 1).await;

    let narrowed =
        person(f.w.db(), "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false))).await;
    let res = f.w.send(Req::get(URL).session(&narrowed)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    assert_eq!(item_ids(signal(&res.body, "stale_issues")), ["in_a"]);
    assert_eq!(item_ids(signal(&res.body, "prs_stuck_in_review")), ["pr_a"]);
    assert_eq!(res.body["actors"]["people"][0]["events"], 1);

    let with_free =
        person(f.w.db(), "acme", "u_free", "member", Some(only_projects(&["pj_a"], true))).await;
    let res = f.w.send(Req::get(URL).session(&with_free)).await;
    let mut ids = item_ids(signal(&res.body, "stale_issues"));
    ids.sort_unstable();
    assert_eq!(ids, ["in_a", "in_free"]);

    // a project outside the access does not exist for them
    let res = f.w.send(Req::get(&format!("{URL}?projectId=pj_b")).session(&narrowed)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Project not found");
    let res =
        f.w.send(Req::get(&format!("{URL}/signals/ci_failing?projectId=pj_b")).session(&narrowed))
            .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);

    // everyone else sees it all
    assert_eq!(item_ids(signal(&f.report("").await, "stale_issues")).len(), 3);
    f.w.drop().await;
}
