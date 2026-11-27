//! Database tests of the snapshot route: the wire format, the comments mode, the integrations
//! gate, the attention items and the member/guest visibility.

mod common;

use common::*;
use serde_json::json;
use trama_contracts::roles::{Capability, WorkspaceRole, fresh_workspace_roles};

const BASE: &str = "/api/w/acme/snapshot";

/// A workspace with an owner, a shared and a hidden project, tasks (one assigned, one a child of
/// a hidden parent), a review-requested artifact, comments, events and a git connection.
async fn seeded(w: &World) -> String {
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "acme", "usr_owner", "owner", None).await;
    agent(w.db(), "ws_acme", "ag_shared").await;
    agent(w.db(), "ws_acme", "ag_hidden").await;
    project(w.db(), "ws_acme", "pj_shared").await;
    project(w.db(), "ws_acme", "pj_hidden").await;
    issue(w.db(), "ws_acme", "in_shared", Some("pj_shared"), Some("ag_shared"), None).await;
    issue(w.db(), "ws_acme", "in_hidden", Some("pj_hidden"), Some("ag_hidden"), None).await;
    issue(w.db(), "ws_acme", "in_child", Some("pj_shared"), None, Some("in_hidden")).await;
    artifact(w.db(), "ws_acme", "ar_1", "in_shared", "requested").await;
    comment(
        w.db(),
        "ws_acme",
        "cm_1",
        &json!({ "type": "issue", "id": "in_shared" }),
        &json!({ "type": "user", "id": "usr_owner" }),
        "on the shared task",
    )
    .await;
    comment(
        w.db(),
        "ws_acme",
        "cm_2",
        &json!({ "type": "issue", "id": "in_hidden" }),
        &json!({ "type": "user", "id": "usr_owner" }),
        "internal-only",
    )
    .await;
    event(
        w.db(),
        "ws_acme",
        "ev_1",
        "issue.created",
        &json!({ "type": "issue", "id": "in_shared" }),
        &json!({ "projectId": "pj_shared" }),
    )
    .await;
    event(
        w.db(),
        "ws_acme",
        "ev_2",
        "issue.created",
        &json!({ "type": "issue", "id": "in_hidden" }),
        &json!({ "projectId": "pj_hidden" }),
    )
    .await;
    event(
        w.db(),
        "ws_acme",
        "ev_3",
        "project.created",
        &json!({ "type": "project", "id": "pj_hidden" }),
        &json!({}),
    )
    .await;
    connection(w.db(), "ws_acme", "ic_1", "acme").await;
    owner
}

fn ids(list: &serde_json::Value) -> Vec<&str> {
    list.as_array().expect("a list").iter().map(|row| row["id"].as_str().expect("an id")).collect()
}

#[tokio::test]
async fn the_route_is_gated() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    // not signed in
    let res = w.send(Req::get(BASE)).await;
    assert_eq!(res.status, 401, "{}", res.message());

    // unknown workspace
    let res = w.send(Req::get("/api/w/nope/snapshot").session(&owner)).await;
    assert_eq!(res.status, 404, "{}", res.message());

    // a member of another workspace
    workspace(w.db(), "other").await;
    let stranger = person(w.db(), "other", "usr_stranger", "owner", None).await;
    let res = w.send(Req::get(BASE).session(&stranger)).await;
    assert_eq!(res.status, 404, "{}", res.message());

    // an agent token has no user to boot
    let token = agent_token(w.db(), "ws_acme", "ag_bot").await;
    let res = w.send(Req::get(BASE).bearer(&token)).await;
    assert_eq!(res.status, 403, "{}", res.message());

    w.drop().await;
}

#[tokio::test]
async fn boots_the_workspace_with_the_bounded_comment_index_by_default() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    let res = w.send(Req::get(BASE).session(&owner)).await;
    assert_eq!(res.status, 200, "{}", res.message());
    let snap = &res.body;

    // exactly the contract's fields, none of the retired collections
    let mut keys: Vec<&str> =
        snap.as_object().expect("an object").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "agents",
            "artifacts",
            "attention",
            "commentIndex",
            "comments",
            "events",
            "integrations",
            "issues",
            "me",
            "memberships",
            "milestones",
            "myRole",
            "projects",
            "users",
            "views",
            "workspace",
        ]
    );

    assert_eq!(snap["workspace"]["id"], "ws_acme");
    assert_eq!(snap["me"]["id"], "usr_owner");
    assert_eq!(snap["myRole"], "owner");
    assert_eq!(ids(&snap["memberships"]), ["mb_acme_usr_owner"]);
    assert_eq!(ids(&snap["users"]), ["usr_owner"]);
    assert_eq!(ids(&snap["agents"]), ["ag_shared", "ag_hidden"]);

    // `index` mode: no inlined comments, but a per-subject count
    assert_eq!(snap["comments"], json!([]));
    let index = snap["commentIndex"].as_array().expect("the comment index");
    assert_eq!(index.len(), 2);
    assert_eq!(index[0]["subject"]["id"], "in_hidden");
    assert_eq!(index[0]["count"], 1);

    // the events, newest first
    assert_eq!(ids(&snap["events"]), ["ev_3", "ev_2", "ev_1"]);

    w.drop().await;
}

#[tokio::test]
async fn full_mode_inlines_every_comment() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    let res = w.send(Req::get(&format!("{BASE}?comments=full")).session(&owner)).await;
    assert_eq!(res.status, 200, "{}", res.message());
    let snap = &res.body;

    assert_eq!(ids(&snap["comments"]), ["cm_1", "cm_2"]);
    assert_eq!(snap["comments"][0]["body"], "on the shared task");
    assert!(snap.get("commentIndex").is_none(), "no index in full mode");

    // an unknown mode is a 400, with the class-validator wording
    let res = w.send(Req::get(&format!("{BASE}?comments=both")).session(&owner)).await;
    assert_eq!(res.status, 400);
    assert_eq!(res.message(), "comments must be one of the following values: full, index");

    w.drop().await;
}

#[tokio::test]
async fn integration_connections_follow_the_manage_gate() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    // the owner may manage integrations
    let res = w.send(Req::get(BASE).session(&owner)).await;
    assert_eq!(res.status, 200);
    assert_eq!(ids(&res.body["integrations"]), ["ic_1"]);
    assert_eq!(res.body["integrations"][0]["account"], "acme");
    assert_eq!(res.body["integrations"][0]["provider"], "github");

    // viewers and members get an empty list
    for role in ["viewer", "member"] {
        let member = person(w.db(), "acme", &format!("usr_{role}"), role, None).await;
        let res = w.send(Req::get(BASE).session(&member)).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.body["integrations"], json!([]), "{role}");
    }

    // the workspace can grant it to a member-level role
    let mut roles = fresh_workspace_roles();
    roles.push(WorkspaceRole {
        id: "integrator".into(),
        name: "Integrator".into(),
        owner: false,
        capabilities: vec![Capability::ManageIntegrations],
        grants: Vec::new(),
    });
    workspace_with_roles(w.db(), "gated", &roles).await;
    let keeper = person(w.db(), "gated", "usr_keeper", "integrator", None).await;
    connection(w.db(), "ws_gated", "ic_2", "gated").await;
    let res = w.send(Req::get("/api/w/gated/snapshot").session(&keeper)).await;
    assert_eq!(res.status, 200);
    assert_eq!(ids(&res.body["integrations"]), ["ic_2"]);

    // a member of that workspace without the role still gets nothing
    let plain = person(w.db(), "gated", "usr_plain", "member", None).await;
    let res = w.send(Req::get("/api/w/gated/snapshot").session(&plain)).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body["integrations"], json!([]));

    w.drop().await;
}

#[tokio::test]
async fn includes_the_callers_attention_items() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    let res = w.send(Req::get(BASE).session(&owner)).await;
    assert_eq!(res.status, 200);
    let attention = res.body["attention"].as_array().expect("attention items");
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0]["id"], "review_requested:ar_1");
    assert_eq!(attention[0]["kind"], "review_requested");
    assert_eq!(attention[0]["artifactId"], "ar_1");
    assert_eq!(attention[0]["issueId"], "in_shared");
    assert_eq!(attention[0]["state"], "open");

    w.drop().await;
}

#[tokio::test]
async fn a_project_limited_member_only_meets_their_projects() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    // a member limited to the shared project; the agents (one per task) are already seeded
    let limited =
        person(w.db(), "acme", "usr_limited", "member", Some(only_projects(&["pj_shared"], false)))
            .await;
    let outsider =
        person(w.db(), "acme", "usr_out", "member", Some(only_projects(&["pj_hidden"], false)))
            .await;

    let res = w.send(Req::get(BASE).session(&limited)).await;
    assert_eq!(res.status, 200, "{}", res.message());
    let snap = &res.body;

    // records of the shared project only; a hidden parent is not named
    assert_eq!(ids(&snap["projects"]), ["pj_shared"]);
    let mut seen: Vec<&str> = ids(&snap["issues"]).clone();
    seen.sort_unstable();
    assert_eq!(seen, ["in_child", "in_shared"]);
    let child = snap["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .find(|i| i["id"] == "in_child")
        .expect("the child task");
    assert!(child.get("parentId").is_none(), "the hidden parent is not named: {child}");
    assert_eq!(ids(&snap["artifacts"]), ["ar_1"]);

    // only the people of the shared project: the caller, the unlimited owner, not the other
    // limited member; their agents only when they work on a visible task
    let mut people: Vec<&str> = ids(&snap["memberships"]).clone();
    people.sort_unstable();
    assert_eq!(people, ["mb_acme_usr_limited", "mb_acme_usr_owner"]);
    let mut users: Vec<&str> = ids(&snap["users"]).clone();
    users.sort_unstable();
    assert_eq!(users, ["usr_limited", "usr_owner"]);
    assert_eq!(ids(&snap["agents"]), ["ag_shared"]);

    // events and the comment index of the shared project only
    assert_eq!(ids(&snap["events"]), ["ev_1"]);
    let index = snap["commentIndex"].as_array().expect("the comment index");
    assert_eq!(index.len(), 1);
    assert_eq!(index[0]["subject"]["id"], "in_shared");
    assert!(!snap.to_string().contains("internal-only"));
    assert!(!snap.to_string().contains("pj_hidden"));

    // nothing is hidden from the unlimited owner
    let res = w.send(Req::get(BASE).session(&owner)).await;
    assert_eq!(ids(&res.body["projects"]).len(), 2);
    let mut people: Vec<&str> = ids(&res.body["memberships"]).clone();
    people.sort_unstable();
    assert_eq!(people.len(), 3);
    assert_eq!(ids(&res.body["agents"]).len(), 2);
    let _ = outsider;

    w.drop().await;
}

#[tokio::test]
async fn an_agent_actor_is_not_the_booting_user() {
    let Some(w) = World::new().await else { return };
    let owner = seeded(&w).await;

    // the agent rows themselves are part of the snapshot, in creation order
    agent(w.db(), "ws_acme", "ag_late").await;
    let res = w.send(Req::get(BASE).session(&owner)).await;
    assert_eq!(res.status, 200);
    assert_eq!(ids(&res.body["agents"]), ["ag_shared", "ag_hidden", "ag_late"]);
    let agent = &res.body["agents"][0];
    assert_eq!(agent["id"], "ag_shared");
    assert_eq!(agent["name"], "Bot");
    assert_eq!(agent["provider"], "claude_code");

    w.drop().await;
}
