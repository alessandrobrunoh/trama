//! The `/api/w/{slug}/attention` routes behind the real access guard: `attention.service.spec.ts`
//! and what the NestJS e2e specs exercise (snapshot scoping, per-user state).

mod common;

use axum::http::StatusCode;
use chrono::Timelike;
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait};
use serde_json::{Value, json};
use trama_attention::{SnapshotRows, list};
use trama_contracts::access::{MemberAction, MemberGrant, MemberResource};
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::time::to_iso;
use trama_entities::{artifacts, issues};

use common::{
    Req, World, agent_token, artifact, issue, only_projects, person, project, sql, workspace,
    workspace_with_roles,
};

const URL: &str = "/api/w/acme/attention";
const SINCE: &str = "2026-01-01T00:00:00.123456Z";
const SINCE_ISO: &str = "2026-01-01T00:00:00.123Z";

struct Fx {
    w: World,
    ada: String,
    bob: String,
}

/// `acme` with two members, an issue without a project and one pull request that needs a review
/// and has failing CI (the artifact of the `attention.service.spec.ts` fixture).
async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    issue(w.db(), "ws_acme", "in_1", None).await;
    artifact(w.db(), "ws_acme", "ar_1", "in_1", Some("requested"), Some("failing"), SINCE).await;
    let ada = person(w.db(), "acme", "u_ada", "member", None).await;
    let bob = person(w.db(), "acme", "u_bob", "member", None).await;
    Some(Fx { w, ada, bob })
}

impl Fx {
    async fn items(&self, cookie: &str) -> Vec<Value> {
        let res = self.w.send(Req::get(URL).session(cookie)).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body.as_array().unwrap().clone()
    }

    async fn state_of(&self, cookie: &str, id: &str) -> Option<String> {
        self.items(cookie)
            .await
            .into_iter()
            .find(|item| item["id"] == id)
            .map(|item| item["state"].as_str().unwrap().to_owned())
    }
}

/// An ISO timestamp `secs` from now, to the second as a snooze date is usually sent.
fn in_secs(secs: i64) -> String {
    let at = chrono::Utc::now() + chrono::Duration::seconds(secs);
    to_iso(&at.with_nanosecond(0).unwrap())
}

#[tokio::test]
async fn derives_review_and_ci_items_from_issue_artifacts() {
    let Some(f) = fx().await else { return };
    // not attention: no flag, no issue (legacy workstream owner), flag values that do not count
    issue(f.w.db(), "ws_acme", "in_2", None).await;
    artifact(f.w.db(), "ws_acme", "ar_quiet", "in_2", Some("approved"), Some("passing"), SINCE)
        .await;
    sql(
        f.w.db(),
        r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, review, ci, "legacyWorkstreamKey")
           VALUES ('ar_legacy', 'ws_acme', 'pull_request', 'github', 'Old', 'open', 'requested', 'failing', 'OLD-7')"#,
    )
    .await;

    let items = f.items(&f.ada).await;
    let kinds: Vec<_> = items
        .iter()
        .map(|i| (i["kind"].as_str().unwrap(), i["issueId"].as_str().unwrap()))
        .collect();
    assert_eq!(kinds, [("ci_failed", "in_1"), ("review_requested", "in_1")]);
    assert_eq!(
        items[0],
        json!({
            "id": "ci_failed:ar_1", "kind": "ci_failed", "severity": "high", "title": "PR ar_1",
            "detail": "CI failing on K-in_1: Issue in_1", "artifactId": "ar_1", "issueId": "in_1",
            "since": SINCE_ISO, "state": "open",
        })
    );
    assert_eq!(items[1]["id"], "review_requested:ar_1");
    assert_eq!(items[1]["severity"], "medium");
    assert_eq!(items[1]["detail"], "Review requested on K-in_1: Issue in_1");
    f.w.drop().await;
}

#[tokio::test]
async fn orders_by_severity_then_oldest_first() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_2", None).await;
    artifact(
        f.w.db(),
        "ws_acme",
        "ar_old",
        "in_2",
        Some("requested"),
        None,
        "2025-06-01T00:00:00Z",
    )
    .await;
    artifact(f.w.db(), "ws_acme", "ar_fail", "in_2", None, Some("failing"), "2025-12-01T00:00:00Z")
        .await;
    let ids: Vec<_> =
        f.items(&f.ada).await.iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(
        ids,
        ["ci_failed:ar_fail", "ci_failed:ar_1", "review_requested:ar_old", "review_requested:ar_1"]
    );
    f.w.drop().await;
}

#[tokio::test]
async fn persists_per_user_dismissals_against_the_current_item_timestamp() {
    let Some(f) = fx().await else { return };
    let id = "review_requested:ar_1";

    // DELETE answers 200 with no body
    let res = f.w.send(Req::delete(&format!("{URL}/{id}")).session(&f.ada)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.empty);
    assert_eq!(f.state_of(&f.ada, id).await.as_deref(), Some("dismissed"));
    // nobody else is affected
    assert_eq!(f.state_of(&f.bob, id).await.as_deref(), Some("open"));
    assert_eq!(f.state_of(&f.ada, "ci_failed:ar_1").await.as_deref(), Some("open"));

    // the stored row keeps the item's `since` (to the millisecond)
    let rows = f
        .w
        .db()
        .query_all_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            r#"SELECT "userId", "itemId", state, "snoozedUntil" IS NULL AS no_snooze, since = '2026-01-01T00:00:00.123Z' AS same FROM attention_state"#,
        ))
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].try_get::<String>("", "userId").unwrap(), "u_ada");
    assert_eq!(rows[0].try_get::<String>("", "state").unwrap(), "dismissed");
    assert!(rows[0].try_get::<bool>("", "no_snooze").unwrap());
    assert!(rows[0].try_get::<bool>("", "same").unwrap());

    // dismissing again is fine, and the POST form answers 201 with no body
    let again = f.w.send(Req::post(&format!("{URL}/{id}/dismiss")).session(&f.ada)).await;
    assert_eq!(again.status, StatusCode::CREATED);
    assert!(again.empty);

    // the artifact changed since: the old dismissal no longer applies
    sql(f.w.db(), r#"UPDATE artifacts SET "updatedAt" = '2026-02-01T00:00:00Z' WHERE id = 'ar_1'"#)
        .await;
    assert_eq!(f.state_of(&f.ada, id).await.as_deref(), Some("open"));
    f.w.drop().await;
}

#[tokio::test]
async fn snoozes_until_a_future_date() {
    let Some(f) = fx().await else { return };
    let id = "ci_failed:ar_1";
    let until = in_secs(3_600);
    let res =
        f.w.send(
            Req::post(&format!("{URL}/{id}/snooze"))
                .session(&f.ada)
                .json(json!({ "until": until })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    assert!(res.empty);

    let item = f.items(&f.ada).await.into_iter().find(|i| i["id"] == id).unwrap();
    assert_eq!(item["state"], "snoozed");
    assert_eq!(item["snoozedUntil"], until);
    assert_eq!(f.state_of(&f.bob, id).await.as_deref(), Some("open"));

    // a snooze that has ended is open again, without `snoozedUntil`
    sql(f.w.db(), r#"UPDATE attention_state SET "snoozedUntil" = now() - interval '1 minute'"#)
        .await;
    let item = f.items(&f.ada).await.into_iter().find(|i| i["id"] == id).unwrap();
    assert_eq!(item["state"], "open");
    assert!(item.get("snoozedUntil").is_none());
    f.w.drop().await;
}

#[tokio::test]
async fn rejects_a_snooze_that_is_not_a_future_date() {
    let Some(f) = fx().await else { return };
    let url = format!("{URL}/ci_failed:ar_1/snooze");
    let post = |body: Value| f.w.send(Req::post(&url).session(&f.ada).json(body));

    let past = post(json!({ "until": "2000-01-01T00:00:00.000Z" })).await;
    assert_eq!(past.status, StatusCode::BAD_REQUEST);
    assert_eq!(past.message(), "snoozedUntil must be a future date");
    // an ISO string that is not a date JavaScript reads is NaN
    let week = post(json!({ "until": "2999-W01" })).await;
    assert_eq!(week.message(), "snoozedUntil must be a future date");

    for body in
        [json!({}), json!({ "until": null }), json!({ "until": 5 }), json!({ "until": "soon" })]
    {
        let res = post(body).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.message(), "until must be a valid ISO 8601 date string");
    }
    // the body is validated before the item is looked up
    let unknown =
        f.w.send(
            Req::post(&format!("{URL}/nope/snooze")).session(&f.ada).json(json!({ "until": "x" })),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(f.state_of(&f.ada, "ci_failed:ar_1").await.as_deref(), Some("open"));
    f.w.drop().await;
}

#[tokio::test]
async fn unknown_items_are_404() {
    let Some(f) = fx().await else { return };
    for req in [
        Req::delete(&format!("{URL}/ci_failed:nope")),
        Req::post(&format!("{URL}/ci_failed:nope/dismiss")),
        Req::post(&format!("{URL}/ci_failed:nope/restore")),
        Req::post(&format!("{URL}/ci_failed:nope/snooze")).json(json!({ "until": in_secs(60) })),
    ] {
        let res = f.w.send(req.session(&f.ada)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(res.message(), "Attention item not found");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn restores_only_the_requesting_users_state() {
    let Some(f) = fx().await else { return };
    let id = "review_requested:ar_1";
    for cookie in [&f.ada, &f.bob] {
        let res = f.w.send(Req::delete(&format!("{URL}/{id}")).session(cookie)).await;
        assert_eq!(res.status, StatusCode::OK);
    }

    let res = f.w.send(Req::post(&format!("{URL}/{id}/restore")).session(&f.ada)).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    assert_eq!(res.body["id"], id);
    assert_eq!(res.body["state"], "open");
    assert!(res.body.get("snoozedUntil").is_none());

    assert_eq!(f.state_of(&f.ada, id).await.as_deref(), Some("open"));
    assert_eq!(f.state_of(&f.bob, id).await.as_deref(), Some("dismissed"));
    f.w.drop().await;
}

#[tokio::test]
async fn an_agent_token_has_no_attention() {
    let Some(f) = fx().await else { return };
    let secret = agent_token(f.w.db(), "ws_acme", "ag_1").await;
    let res = f.w.send(Req::get(URL).bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This endpoint requires a user, not an agent token");
    let res = f.w.send(Req::delete(&format!("{URL}/ci_failed:ar_1")).bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    f.w.drop().await;
}

#[tokio::test]
async fn needs_a_session_and_a_membership() {
    let Some(f) = fx().await else { return };
    let anonymous = f.w.send(Req::get(URL)).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    workspace(f.w.db(), "other").await;
    let stranger = person(f.w.db(), "other", "u_x", "member", None).await;
    let res = f.w.send(Req::get(URL).session(&stranger)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn project_scoping_follows_the_members_access() {
    let Some(f) = fx().await else { return };
    project(f.w.db(), "ws_acme", "pj_a").await;
    issue(f.w.db(), "ws_acme", "in_a", Some("pj_a")).await;
    artifact(f.w.db(), "ws_acme", "ar_a", "in_a", None, Some("failing"), "2025-01-01T00:00:00Z")
        .await;
    let narrowed =
        person(f.w.db(), "acme", "u_narrow", "member", Some(only_projects(&["pj_a"], false))).await;
    let with_unassigned =
        person(f.w.db(), "acme", "u_free", "member", Some(only_projects(&["pj_a"], true))).await;

    let ids = |items: Vec<Value>| -> Vec<String> {
        items.iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(ids(f.items(&narrowed).await), ["ci_failed:ar_a"]);
    assert_eq!(
        ids(f.items(&with_unassigned).await),
        ["ci_failed:ar_a", "ci_failed:ar_1", "review_requested:ar_1"]
    );
    assert_eq!(ids(f.items(&f.ada).await).len(), 3);

    // an item outside the person's projects does not exist for them
    let res = f.w.send(Req::delete(&format!("{URL}/ci_failed:ar_1")).session(&narrowed)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn needs_permission_to_view_issues_and_artifacts() {
    let Some(w) = World::new().await else { return };
    let grant = |resource| MemberGrant::new(resource, MemberAction::View);
    let mut roles = fresh_workspace_roles();
    for role in &mut roles {
        if role.id == "viewer" {
            role.grants.retain(|g| *g != grant(MemberResource::Issues));
        }
    }
    workspace_with_roles(w.db(), "acme", &roles).await;
    issue(w.db(), "ws_acme", "in_1", None).await;
    artifact(w.db(), "ws_acme", "ar_1", "in_1", Some("requested"), None, SINCE).await;
    let viewer = person(w.db(), "acme", "u_v", "viewer", None).await;
    let member = person(w.db(), "acme", "u_m", "member", None).await;

    let res = w.send(Req::get(URL).session(&viewer)).await;
    assert_eq!((res.status, res.body), (StatusCode::OK, json!([])));
    let res = w.send(Req::get(URL).session(&member)).await;
    assert_eq!(res.body.as_array().unwrap().len(), 1);
    w.drop().await;

    // issues visible but no artifacts: nothing to derive
    let Some(w) = World::new().await else { return };
    let mut roles = fresh_workspace_roles();
    for role in &mut roles {
        if role.id == "viewer" {
            role.grants.retain(|g| *g != grant(MemberResource::Artifacts));
        }
    }
    workspace_with_roles(w.db(), "acme", &roles).await;
    issue(w.db(), "ws_acme", "in_1", None).await;
    artifact(w.db(), "ws_acme", "ar_1", "in_1", Some("requested"), None, SINCE).await;
    let viewer = person(w.db(), "acme", "u_v", "viewer", None).await;
    let res = w.send(Req::get(URL).session(&viewer)).await;
    assert_eq!((res.status, res.body), (StatusCode::OK, json!([])));
    w.drop().await;
}

#[tokio::test]
async fn lists_from_the_snapshot_rows_without_querying() {
    let Some(f) = fx().await else { return };
    let db: &DatabaseConnection = f.w.db();
    let issue_rows = issues::Entity::find().all(db).await.unwrap();
    let artifact_rows = artifacts::Entity::find().all(db).await.unwrap();
    // the rows are used as they are: the database no longer has anything to derive
    sql(db, r#"UPDATE artifacts SET review = NULL, ci = NULL"#).await;
    let rows = SnapshotRows { issues: &issue_rows, artifacts: &artifact_rows };
    let items = list(db, "ws_acme", "u_ada", Some(rows)).await.unwrap();
    assert_eq!(items.len(), 2);
    assert!(list(db, "ws_acme", "u_ada", None).await.unwrap().is_empty());
    f.w.drop().await;
}
