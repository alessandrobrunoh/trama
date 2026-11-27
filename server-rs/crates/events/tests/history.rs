//! `GET /api/w/:slug/events`: filters, validation messages and the project boundary
//! (`events-visibility.e2e-spec.ts`).

mod common;

use axum::http::StatusCode;
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{Value, json};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_events::RecordEvent;

use common::{
    Req, World, comment, issue, member, only_projects, project, session, sql, user, workspace,
};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap()
}

fn subject(kind: SubjectType, id: &str) -> SubjectRef {
    SubjectRef { kind, id: id.to_owned() }
}

/// Records `kind` about `subject` `seconds` after [`base`] in `ws`.
async fn record(w: &World, ws: &str, kind: &str, about: SubjectRef, seconds: i64, data: Value) {
    w.events
        .record(
            w.db(),
            RecordEvent::new(ws, ActorRef::user("u_owner"), kind, about)
                .data(data)
                .at(base() + Duration::seconds(seconds))
                .without_live(),
        )
        .await
        .unwrap();
}

/// Owner `u_owner` of `acme` (and a second workspace `other`), with a session.
async fn owner(w: &World) -> String {
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    user(w.db(), "u_owner").await;
    member(w.db(), "ws_acme", "u_owner", "owner", None).await;
    session(w.db(), "u_owner").await
}

async fn get(w: &World, cookie: &str, query: &str) -> common::Res {
    w.send(Req::get(&format!("/api/w/acme/events{query}")).session(cookie)).await
}

fn types(body: &Value) -> Vec<&str> {
    body.as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn lists_the_workspaces_events_newest_first() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    record(
        &w,
        "ws_acme",
        "issue.created",
        subject(SubjectType::Issue, "in_1"),
        1,
        json!({ "title": "A" }),
    )
    .await;
    record(&w, "ws_acme", "issue.updated", subject(SubjectType::Issue, "in_1"), 3, json!({})).await;
    record(&w, "ws_acme", "project.created", subject(SubjectType::Project, "pr_1"), 2, json!({}))
        .await;
    record(&w, "ws_other", "issue.created", subject(SubjectType::Issue, "in_9"), 4, json!({}))
        .await;

    let res = get(&w, &cookie, "").await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(types(&res.body), ["issue.updated", "project.created", "issue.created"]);
    let oldest = &res.body[2];
    assert!(oldest["id"].as_str().unwrap().starts_with("ev_"));
    assert_eq!(oldest["workspaceId"], "ws_acme");
    assert_eq!(oldest["at"], "2026-01-01T12:00:01.000Z");
    assert_eq!(oldest["actor"], json!({ "type": "user", "id": "u_owner" }));
    assert_eq!(oldest["subject"], json!({ "type": "issue", "id": "in_1" }));
    assert_eq!(oldest["data"], json!({ "title": "A" }));
    // null columns are left out of the JSON, as the entity's toJSON does
    assert!(oldest.get("legacyWorkstreamKey").is_none());
    w.drop().await;
}

#[tokio::test]
async fn events_with_the_same_time_come_newest_id_first() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    for n in 0..4 {
        record(
            &w,
            "ws_acme",
            &format!("issue.e{n}"),
            subject(SubjectType::Issue, "in_1"),
            0,
            json!({}),
        )
        .await;
    }
    let res = get(&w, &cookie, "").await;
    let ids: Vec<&str> =
        res.body.as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(ids, sorted);
    w.drop().await;
}

#[tokio::test]
async fn limits_to_100_unless_asked_and_to_500_at_most() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    sql(
        w.db(),
        r#"INSERT INTO domain_events (id, "workspaceId", at, actor, type, subject, data)
           SELECT 'ev_' || n, 'ws_acme', now() - (n || ' seconds')::interval, '{"type":"system"}',
                  'issue.updated', '{"type":"issue","id":"in_1"}', '{}'
           FROM generate_series(1, 520) AS n"#,
    )
    .await;
    assert_eq!(get(&w, &cookie, "").await.body.as_array().unwrap().len(), 100);
    assert_eq!(get(&w, &cookie, "?limit=7").await.body.as_array().unwrap().len(), 7);
    assert_eq!(get(&w, &cookie, "?limit=500").await.body.as_array().unwrap().len(), 500);
    assert_eq!(get(&w, &cookie, "?limit=1").await.body.as_array().unwrap().len(), 1);
    // `Number()`: these are all the integer 3
    for q in ["3.0", "3e0", "0x3", "+3", "%203"] {
        assert_eq!(
            get(&w, &cookie, &format!("?limit={q}")).await.body.as_array().unwrap().len(),
            3,
            "{q}"
        );
    }
    w.drop().await;
}

#[tokio::test]
async fn filters_by_subject_type_prefix_before_and_legacy_key() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    record(&w, "ws_acme", "issue.created", subject(SubjectType::Issue, "in_1"), 1, json!({})).await;
    record(
        &w,
        "ws_acme",
        "issue.status_changed",
        subject(SubjectType::Issue, "in_1"),
        2,
        json!({}),
    )
    .await;
    record(&w, "ws_acme", "issue.created", subject(SubjectType::Issue, "in_2"), 3, json!({})).await;
    record(&w, "ws_acme", "project.created", subject(SubjectType::Project, "pr_1"), 4, json!({}))
        .await;
    sql(
        w.db(),
        r#"UPDATE domain_events SET "legacyWorkstreamKey" = 'wk-9' WHERE type = 'project.created'"#,
    )
    .await;

    let count = |res: &common::Res| res.body.as_array().unwrap().len();
    let res = get(&w, &cookie, "?subject=issue%3Ain_1").await;
    assert_eq!(types(&res.body), ["issue.status_changed", "issue.created"]);
    // only the first two parts count
    assert_eq!(count(&get(&w, &cookie, "?subject=issue%3Ain_1%3Aextra").await), 2);
    assert_eq!(count(&get(&w, &cookie, "?subject=issue%3Anope").await), 0);

    assert_eq!(count(&get(&w, &cookie, "?type=issue.").await), 3);
    assert_eq!(count(&get(&w, &cookie, "?type=issue.created").await), 2);
    assert_eq!(count(&get(&w, &cookie, "?type=project").await), 1);
    // `%`, `_` and `\` are matched literally, not as wildcards (they are escaped, not dropped):
    // `_` in an event type is a plain character
    assert_eq!(count(&get(&w, &cookie, "?type=issue.status_").await), 1);
    assert_eq!(count(&get(&w, &cookie, "?type=issue.status_changed").await), 1);
    assert_eq!(count(&get(&w, &cookie, "?type=issue_created").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?type=issue.crea_ted").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?type=issue.status%25").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?type=%25").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?type=i%25ssue.").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?type=issue%5C").await), 0);

    // strictly older than `before`
    let before = get(&w, &cookie, "?before=2026-01-01T12%3A00%3A03.000Z").await;
    assert_eq!(types(&before.body), ["issue.status_changed", "issue.created"]);
    assert_eq!(count(&get(&w, &cookie, "?before=2026-01-01T12%3A00%3A01.000Z").await), 0);
    assert_eq!(count(&get(&w, &cookie, "?before=2027-01-01").await), 4);
    assert_eq!(
        count(&get(&w, &cookie, "?before=Thu%2C%2001%20Jan%202026%2012%3A00%3A03%20GMT").await),
        2
    );

    let legacy = get(&w, &cookie, "?legacyWorkstreamKey=wk-9").await;
    assert_eq!(types(&legacy.body), ["project.created"]);
    assert_eq!(legacy.body[0]["legacyWorkstreamKey"], "wk-9");
    assert_eq!(count(&get(&w, &cookie, "?legacyWorkstreamKey=zzz").await), 0);

    // empty filters are not filters
    assert_eq!(count(&get(&w, &cookie, "?type=&subject=&before=&legacyWorkstreamKey=").await), 4);
    // unknown keys are dropped
    assert_eq!(count(&get(&w, &cookie, "?colour=red").await), 4);
    // filters combine
    assert_eq!(count(&get(&w, &cookie, "?subject=issue%3Ain_1&type=issue.created").await), 1);
    w.drop().await;
}

#[tokio::test]
async fn rejects_invalid_filters_with_the_messages_of_the_nestjs_api() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    let bad = |res: common::Res| {
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.body["statusCode"], 400);
        assert_eq!(res.body["error"], "Bad Request");
        res.message()
    };
    assert_eq!(bad(get(&w, &cookie, "?subject=issue").await), "subject must be \"<type>:<id>\"");
    assert_eq!(bad(get(&w, &cookie, "?subject=issue%3A").await), "subject must be \"<type>:<id>\"");
    assert_eq!(bad(get(&w, &cookie, "?subject=%3Ain_1").await), "subject must be \"<type>:<id>\"");
    assert_eq!(bad(get(&w, &cookie, "?before=yesterday").await), "before must be an ISO date");
    assert_eq!(bad(get(&w, &cookie, "?limit=0").await), "limit must not be less than 1");
    assert_eq!(bad(get(&w, &cookie, "?limit=501").await), "limit must not be greater than 500");
    assert_eq!(bad(get(&w, &cookie, "?limit=2.5").await), "limit must be an integer number");
    assert_eq!(
        bad(get(&w, &cookie, "?limit=abc").await),
        "limit must not be greater than 500; limit must not be less than 1; limit must be an integer number"
    );
    assert_eq!(bad(get(&w, &cookie, "?type=a&type=b").await), "type must be a string");
    // the body is a message array, like class-validator's
    let res = get(&w, &cookie, "?limit=0").await;
    assert_eq!(res.body["message"], json!(["limit must not be less than 1"]));
    w.drop().await;
}

#[tokio::test]
async fn needs_a_session_and_membership() {
    let Some(w) = World::new().await else { return };
    let cookie = owner(&w).await;
    user(w.db(), "u_out").await;
    member(w.db(), "ws_other", "u_out", "owner", None).await;
    let outsider = session(w.db(), "u_out").await;

    assert_eq!(w.send(Req::get("/api/w/acme/events")).await.status, StatusCode::UNAUTHORIZED);
    let res = get(&w, &outsider, "").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "Workspace \"acme\" not found");
    assert_eq!(get(&w, &cookie, "").await.status, StatusCode::OK);
    w.drop().await;
}

/// `filters hidden project and issue events, including comment excerpts, in history`.
#[tokio::test]
async fn hides_events_of_projects_the_member_cannot_reach() {
    let Some(w) = World::new().await else { return };
    let owner_cookie = owner(&w).await;
    user(w.db(), "u_viewer").await;
    member(w.db(), "ws_acme", "u_viewer", "viewer", Some(only_projects(&["pr_vis"], false))).await;
    let viewer = session(w.db(), "u_viewer").await;

    project(w.db(), "ws_acme", "pr_vis").await;
    project(w.db(), "ws_acme", "pr_hid").await;
    issue(w.db(), "ws_acme", "in_vis", Some("pr_vis")).await;
    issue(w.db(), "ws_acme", "in_hid", Some("pr_hid")).await;
    comment(w.db(), "ws_acme", "cm_vis", json!({ "type": "issue", "id": "in_vis" })).await;
    comment(w.db(), "ws_acme", "cm_hid", json!({ "type": "issue", "id": "in_hid" })).await;
    for (n, (kind, about, data)) in [
        ("project.created", subject(SubjectType::Project, "pr_vis"), json!({})),
        ("project.created", subject(SubjectType::Project, "pr_hid"), json!({})),
        (
            "issue.created",
            subject(SubjectType::Issue, "in_vis"),
            json!({ "title": "Visible issue event" }),
        ),
        (
            "issue.created",
            subject(SubjectType::Issue, "in_hid"),
            json!({ "title": "Hidden issue event" }),
        ),
        (
            "comment.created",
            subject(SubjectType::Issue, "in_vis"),
            json!({ "excerpt": "visible comment excerpt" }),
        ),
        (
            "comment.created",
            subject(SubjectType::Issue, "in_hid"),
            json!({ "excerpt": "hidden comment excerpt" }),
        ),
        // a deleted issue is scoped by the project its event names
        (
            "issue.deleted",
            subject(SubjectType::Issue, "in_gone"),
            json!({ "projectId": "pr_hid", "title": "Gone hidden" }),
        ),
        (
            "issue.deleted",
            subject(SubjectType::Issue, "in_gone2"),
            json!({ "projectId": "pr_vis", "title": "Gone visible" }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        record(&w, "ws_acme", kind, about, i64::try_from(n).unwrap(), data).await;
    }

    let history = get(&w, &viewer, "?limit=500").await;
    assert_eq!(history.status, StatusCode::OK);
    let text = history.body.to_string();
    let subjects: Vec<&str> = history
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["subject"]["id"].as_str().unwrap())
        .collect();
    assert!(subjects.contains(&"in_vis"));
    assert!(subjects.contains(&"pr_vis"));
    assert!(subjects.contains(&"in_gone2"));
    for hidden in ["in_hid", "pr_hid", "in_gone"] {
        assert!(!subjects.contains(&hidden), "{hidden}");
    }
    assert!(text.contains("visible comment excerpt"));
    assert!(!text.contains("hidden comment excerpt"));
    assert!(!text.contains("Hidden issue event"));
    assert!(!text.contains("Gone hidden"));
    assert_eq!(history.body.as_array().unwrap().len(), 4);

    // the owner is not narrowed
    let all = get(&w, &owner_cookie, "?limit=500").await;
    assert_eq!(all.body.as_array().unwrap().len(), 8);
    // the filters apply before the limit; the boundary after it, as in NestJS
    let limited = get(&w, &viewer, "?limit=2").await;
    assert!(limited.body.as_array().unwrap().len() <= 2);
    w.drop().await;
}

#[tokio::test]
async fn workspace_level_events_follow_include_unassigned() {
    let Some(w) = World::new().await else { return };
    let _ = owner(&w).await;
    project(w.db(), "ws_acme", "pr_vis").await;
    issue(w.db(), "ws_acme", "in_vis", Some("pr_vis")).await;
    for (id, unassigned) in [("u_with", true), ("u_without", false)] {
        user(w.db(), id).await;
        member(w.db(), "ws_acme", id, "viewer", Some(only_projects(&["pr_vis"], unassigned))).await;
    }
    record(
        &w,
        "ws_acme",
        "comment.created",
        subject(SubjectType::Issue, "in_vis"),
        1,
        json!({ "excerpt": "x" }),
    )
    .await;
    record(&w, "ws_acme", "import.finished", subject(SubjectType::Import, "imp_1"), 2, json!({}))
        .await;

    let with = session(w.db(), "u_with").await;
    let without = session(w.db(), "u_without").await;
    // the viewer role can view comments, so that event is visible to both
    assert_eq!(types(&get(&w, &with, "").await.body), ["import.finished", "comment.created"]);
    assert_eq!(types(&get(&w, &without, "").await.body), ["comment.created"]);
    w.drop().await;
}
