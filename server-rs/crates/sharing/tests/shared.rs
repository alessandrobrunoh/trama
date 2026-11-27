//! Shared with me and Show in (`sharing.e2e-spec.ts`, "Shared with me and Show in").

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use trama_contracts::activity::{LiveEvent, LiveEventEntity, LiveEventType};

use common::{
    Req, Res, World, member, only_projects, project, scalar, session, sql, token, user, workspace,
    workspace_with,
};

/// The e2e `scene()`: owner `u_owner` of the workspace `studio` with the projects
/// `pj_shared` and `pj_hidden`, and the guest Gina (viewer limited to `pj_shared`) with a
/// workspace of her own.
struct Scene {
    w: World,
    owner: String,
    gina: String,
}

async fn scene() -> Option<Scene> {
    let w = World::new().await?;
    let db = w.db();
    workspace_with(db, "studio", "Studio", json!({})).await;
    user(db, "u_owner").await;
    member(db, "ws_studio", "u_owner", "owner", None).await;
    project(db, "ws_studio", "pj_shared", "Brand refresh", "BRND").await;
    project(db, "ws_studio", "pj_hidden", "Internal only", "INTR").await;
    user(db, "u_gina").await;
    member(db, "ws_studio", "u_gina", "viewer", Some(only_projects(&["pj_shared"]))).await;
    workspace(db, "gina").await;
    member(db, "ws_gina", "u_gina", "owner", None).await;
    workspace(db, "owner").await;
    member(db, "ws_owner", "u_owner", "owner", None).await;
    let owner = session(db, "u_owner").await;
    let gina = session(db, "u_gina").await;
    Some(Scene { w, owner, gina })
}

async fn shared(w: &World, cookie: &str) -> Vec<Value> {
    let res = w.send(Req::get("/api/shared/projects").session(cookie)).await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    res.body.as_array().unwrap().clone()
}

async fn put(w: &World, cookie: &str, project: &str, body: &Value) -> Res {
    w.send(
        Req::put(&format!("/api/shared/projects/{project}/placement")).session(cookie).json(body),
    )
    .await
}

async fn delete(w: &World, cookie: &str, project: &str) -> Res {
    w.send(Req::delete(&format!("/api/shared/projects/{project}/placement")).session(cookie)).await
}

async fn leave(w: &World, cookie: &str, project: &str) -> Res {
    w.send(Req::post(&format!("/api/shared/projects/{project}/leave")).session(cookie)).await
}

#[tokio::test]
async fn lists_the_projects_a_person_reaches_as_a_guest_with_the_workspace_that_owns_them() {
    let Some(s) = scene().await else { return };
    let list = shared(&s.w, &s.gina).await;
    assert_eq!(list.len(), 1);
    assert_eq!(
        list[0],
        json!({
            "id": "pj_shared",
            "name": "Brand refresh",
            "key": "BRND",
            "color": "#6b7280",
            "workspace": { "id": "ws_studio", "slug": "studio", "name": "Studio" },
            "role": "viewer",
        })
    );
    assert!(list[0].get("placement").is_none());
    // the workspace's own people are not guests, and a person's own workspace never shows up
    assert_eq!(shared(&s.w, &s.owner).await, Vec::<Value>::new());
    user(s.w.db(), "u_colleague").await;
    member(s.w.db(), "ws_studio", "u_colleague", "member", None).await;
    let colleague = session(s.w.db(), "u_colleague").await;
    assert_eq!(shared(&s.w, &colleague).await, Vec::<Value>::new());
    s.w.drop().await;
}

#[tokio::test]
async fn lists_icons_and_orders_by_workspace_then_project_name() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    sql(db, r"UPDATE projects SET icon = 'rocket' WHERE id = 'pj_shared'").await;
    // a second workspace whose name sorts before "Studio", and a project that sorts first in it
    workspace_with(db, "acme", "Acme", json!({})).await;
    user(db, "u_boss").await;
    member(db, "ws_acme", "u_boss", "owner", None).await;
    project(db, "ws_acme", "pj_zeta", "Zeta", "ZETA").await;
    project(db, "ws_acme", "pj_alpha", "Alpha", "ALPH").await;
    member(db, "ws_acme", "u_gina", "viewer", Some(only_projects(&["pj_zeta", "pj_alpha"]))).await;
    let list = shared(&s.w, &s.gina).await;
    let names: Vec<&str> = list.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Alpha", "Zeta", "Brand refresh"]);
    assert_eq!(list[2]["icon"], "rocket");
    assert!(list[0].get("icon").is_none());
    s.w.drop().await;
}

#[tokio::test]
async fn a_membership_without_visible_projects_shares_nothing() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    // limited to a project that does not exist, and a role the workspace no longer has
    user(db, "u_x").await;
    member(db, "ws_studio", "u_x", "viewer", Some(only_projects(&["pj_missing"]))).await;
    user(db, "u_ghost").await;
    member(db, "ws_studio", "u_ghost", "ghost", Some(only_projects(&["pj_shared"]))).await;
    for id in ["u_x", "u_ghost"] {
        let cookie = session(db, id).await;
        assert_eq!(shared(&s.w, &cookie).await, Vec::<Value>::new());
    }
    s.w.drop().await;
}

#[tokio::test]
async fn places_a_shared_project_in_one_of_my_workspaces_without_giving_anybody_access() {
    let Some(s) = scene().await else { return };
    let placed = put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(placed.status, StatusCode::OK);
    assert_eq!(
        placed.body,
        json!({ "projectId": "pj_shared", "workspaceId": "ws_gina", "position": 0 })
    );
    assert_eq!(shared(&s.w, &s.gina).await[0]["placement"], placed.body);

    // somebody else in the workspace she placed it in gets nothing out of it
    let db = s.w.db();
    user(db, "u_mallory").await;
    member(db, "ws_gina", "u_mallory", "member", None).await;
    let mallory = session(db, "u_mallory").await;
    assert_eq!(shared(&s.w, &mallory).await, Vec::<Value>::new());
    // and the project still belongs to its own workspace
    let ws: Option<String> =
        scalar(db, r#"SELECT "workspaceId" AS v FROM projects WHERE id = 'pj_shared'"#).await;
    assert_eq!(ws.as_deref(), Some("ws_studio"));
    let mallory_access: Option<String> = scalar(
        db,
        r#"SELECT count(*)::text AS v FROM memberships WHERE "userId" = 'u_mallory' AND "workspaceId" = 'ws_studio'"#,
    )
    .await;
    assert_eq!(mallory_access.as_deref(), Some("0"));
    s.w.drop().await;
}

#[tokio::test]
async fn positions_default_to_the_end_of_the_workspace_and_can_be_chosen() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    project(db, "ws_studio", "pj_second", "Second", "SCND").await;
    sql(
        db,
        r#"UPDATE memberships SET access = '{"projects":{"all":false,"projectIds":["pj_shared","pj_second"]},"includeUnassigned":false,"grants":[]}' WHERE id = 'mb_ws_studio_u_gina'"#,
    )
    .await;
    let first = put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(first.body["position"], 0);
    let second = put(&s.w, &s.gina, "pj_second", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(second.body["position"], 1);
    let chosen =
        put(&s.w, &s.gina, "pj_second", &json!({ "workspaceId": "ws_gina", "position": 7 })).await;
    assert_eq!(chosen.body["position"], 7);
    // a repeated request replaces the row instead of failing
    let again = put(&s.w, &s.gina, "pj_second", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.body["position"], 8);
    let rows = scalar(
        db,
        r#"SELECT count(*)::text AS v FROM project_placements WHERE "userId" = 'u_gina'"#,
    )
    .await;
    assert_eq!(rows.as_deref(), Some("2"));
    // moving between workspaces keeps one row
    workspace(db, "gina2").await;
    member(db, "ws_gina2", "u_gina", "owner", None).await;
    let moved = put(&s.w, &s.gina, "pj_second", &json!({ "workspaceId": "ws_gina2" })).await;
    assert_eq!(
        moved.body,
        json!({ "projectId": "pj_second", "workspaceId": "ws_gina2", "position": 0 })
    );
    s.w.drop().await;
}

#[tokio::test]
async fn keeps_placements_per_person() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    user(db, "u_hugo").await;
    member(db, "ws_studio", "u_hugo", "viewer", Some(only_projects(&["pj_shared"]))).await;
    workspace(db, "hugo").await;
    member(db, "ws_hugo", "u_hugo", "owner", None).await;
    let hugo = session(db, "u_hugo").await;

    put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(shared(&s.w, &s.gina).await[0]["placement"]["workspaceId"], "ws_gina");
    assert!(shared(&s.w, &hugo).await[0].get("placement").is_none());
    // Hugo cannot place it into Gina's workspace: he does not belong there
    let denied = put(&s.w, &hugo, "pj_shared", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(denied.status, StatusCode::NOT_FOUND);
    assert_eq!(denied.message(), r#"Workspace "ws_gina" not found"#);
    // and clearing hers does not touch his
    let placed = put(&s.w, &hugo, "pj_shared", &json!({ "workspaceId": "ws_hugo" })).await;
    assert_eq!(placed.status, StatusCode::OK);
    assert_eq!(delete(&s.w, &s.gina, "pj_shared").await.status, StatusCode::NO_CONTENT);
    assert!(shared(&s.w, &s.gina).await[0].get("placement").is_none());
    assert_eq!(shared(&s.w, &hugo).await[0]["placement"]["workspaceId"], "ws_hugo");
    s.w.drop().await;
}

#[tokio::test]
async fn only_places_what_is_shared_into_workspaces_the_person_belongs_to() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    let home = json!({ "workspaceId": "ws_gina" });
    // not shared with her
    let hidden = put(&s.w, &s.gina, "pj_hidden", &home).await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND);
    assert_eq!(hidden.message(), r#"Project "pj_hidden" not found"#);
    assert_eq!(put(&s.w, &s.gina, "pj_missing", &home).await.status, StatusCode::NOT_FOUND);
    // it already lives there
    let lives = put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_studio" })).await;
    assert_eq!(lives.status, StatusCode::BAD_REQUEST);
    assert_eq!(lives.message(), "The project already lives in that workspace");
    user(db, "u_stranger").await;
    workspace(db, "stranger").await;
    member(db, "ws_stranger", "u_stranger", "owner", None).await;
    let stranger = put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_stranger" })).await;
    assert_eq!(stranger.status, StatusCode::NOT_FOUND);
    assert_eq!(put(&s.w, &s.gina, "pj_shared", &json!({})).await.status, StatusCode::BAD_REQUEST);
    let negative =
        put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_gina", "position": -1 })).await;
    assert_eq!(negative.status, StatusCode::BAD_REQUEST);
    assert_eq!(negative.message(), "position must not be less than 0");
    // the owner reaches the project as a member, not as a guest: nothing to place or hide
    let owner_home = json!({ "workspaceId": "ws_owner" });
    assert_eq!(put(&s.w, &s.owner, "pj_shared", &owner_home).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        put(&s.w, &s.owner, "pj_shared", &json!({ "workspaceId": null })).await.status,
        StatusCode::NOT_FOUND
    );
    // nothing was stored by any of that
    let rows = scalar(db, "SELECT count(*)::text AS v FROM project_placements").await;
    assert_eq!(rows.as_deref(), Some("0"));
    s.w.drop().await;
}

#[tokio::test]
async fn hides_a_project_brings_it_back_and_lets_a_guest_leave() {
    let Some(s) = scene().await else { return };
    let hidden = put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": null })).await;
    assert_eq!(hidden.status, StatusCode::OK);
    assert_eq!(
        hidden.body,
        json!({ "projectId": "pj_shared", "workspaceId": null, "position": 0 })
    );
    assert_eq!(shared(&s.w, &s.gina).await[0]["placement"], hidden.body);
    let cleared = delete(&s.w, &s.gina, "pj_shared").await;
    assert_eq!(cleared.status, StatusCode::NO_CONTENT);
    assert!(shared(&s.w, &s.gina).await[0].get("placement").is_none());
    // clearing what is not there is not an error either
    assert_eq!(delete(&s.w, &s.gina, "pj_shared").await.status, StatusCode::NO_CONTENT);
    assert_eq!(delete(&s.w, &s.gina, "pj_nowhere").await.status, StatusCode::NO_CONTENT);

    let mut live = s.w.events.subscribe();
    put(&s.w, &s.gina, "pj_shared", &json!({ "workspaceId": "ws_gina" })).await;
    assert_eq!(leave(&s.w, &s.gina, "pj_shared").await.status, StatusCode::NO_CONTENT);
    assert_eq!(shared(&s.w, &s.gina).await, Vec::<Value>::new());
    // her placement went with it
    let rows = scalar(s.w.db(), "SELECT count(*)::text AS v FROM project_placements").await;
    assert_eq!(rows.as_deref(), Some("0"));
    let again = leave(&s.w, &s.gina, "pj_shared").await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    // a viewer keeps the membership, with nothing left in it
    let access = scalar(
        s.w.db(),
        r"SELECT access->'projects'->>'projectIds' AS v FROM memberships WHERE id = 'mb_ws_studio_u_gina'",
    )
    .await;
    assert_eq!(access.as_deref(), Some("[]"));
    let event: LiveEvent = live.recv().await.unwrap().event;
    assert_eq!(
        (event.kind, event.entity, event.id.as_str()),
        (LiveEventType::Updated, LiveEventEntity::Membership, "mb_ws_studio_u_gina")
    );
    s.w.drop().await;
}

#[tokio::test]
async fn a_guest_left_with_nothing_loses_the_membership() {
    let Some(s) = scene().await else { return };
    let db = s.w.db();
    user(db, "u_guest").await;
    member(db, "ws_studio", "u_guest", "guest", Some(only_projects(&["pj_shared", "pj_hidden"])))
        .await;
    let guest = session(db, "u_guest").await;
    assert_eq!(shared(&s.w, &guest).await.len(), 2);
    let mut live = s.w.events.subscribe();
    assert_eq!(leave(&s.w, &guest, "pj_shared").await.status, StatusCode::NO_CONTENT);
    // one project left: the membership stays, limited to it
    let left = scalar(
        db,
        r"SELECT access->'projects'->>'projectIds' AS v FROM memberships WHERE id = 'mb_ws_studio_u_guest'",
    )
    .await;
    assert_eq!(left.as_deref(), Some(r#"["pj_hidden"]"#));
    assert_eq!(leave(&s.w, &guest, "pj_hidden").await.status, StatusCode::NO_CONTENT);
    let rows =
        scalar(db, r#"SELECT count(*)::text AS v FROM memberships WHERE "userId" = 'u_guest'"#)
            .await;
    assert_eq!(rows.as_deref(), Some("0"));
    let first = live.recv().await.unwrap().event;
    assert_eq!(first.kind, LiveEventType::Updated);
    let second = live.recv().await.unwrap().event;
    assert_eq!((second.kind, second.entity), (LiveEventType::Deleted, LiveEventEntity::Membership));
    s.w.drop().await;
}

#[tokio::test]
async fn is_an_account_route_a_browser_session_only_never_an_api_token() {
    let Some(s) = scene().await else { return };
    let secret = token(s.w.db(), "ws_studio", "u_owner").await;
    for req in [
        Req::get("/api/shared/projects"),
        Req::put("/api/shared/projects/pj_shared/placement").json(&json!({ "workspaceId": null })),
        Req::delete("/api/shared/projects/pj_shared/placement"),
        Req::post("/api/shared/projects/pj_shared/leave"),
    ] {
        let res = s.w.send(req.bearer(&secret)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{:?}", res.body);
    }
    // and nobody signed in is refused before anything else
    let res = s.w.send(Req::get("/api/shared/projects")).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    s.w.drop().await;
}
