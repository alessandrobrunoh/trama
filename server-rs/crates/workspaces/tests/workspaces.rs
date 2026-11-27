//! Workspaces, settings, roles, members and ownership over HTTP: `rbac.e2e-spec.ts`,
//! `workspaces.service.spec.ts`, `member-permissions.spec.ts`, `roles.spec.ts` and
//! `guest-organizer-roles.spec.ts` as far as they run through these routes.

mod common;

use axum::http::StatusCode;
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use trama_contracts::roles::TokenScope;
use trama_entities::workspaces;

use common::{Req, World, member, people, session, user, workspace, workspace_with};

/// Creates `slug` through the API for a fresh `u_<slug>` and returns the creator's cookie.
async fn create(w: &World, slug: &str) -> String {
    let id = format!("u_{slug}");
    user(w.db(), &id).await;
    let cookie = session(w.db(), &id).await;
    let res = w
        .send(
            Req::post("/api/workspaces")
                .session(&cookie)
                .json(json!({ "name": slug, "slug": slug })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{:?}", res.body);
    cookie
}

#[tokio::test]
async fn creator_becomes_owner_and_primary_owner() {
    let Some(w) = World::new().await else { return };
    let cookie = create(&w, "acme").await;
    let mine = w.send(Req::get("/api/workspaces").session(&cookie)).await;
    assert_eq!(mine.status, StatusCode::OK);
    let acme = mine.body.as_array().unwrap().iter().find(|x| x["slug"] == "acme").unwrap();
    assert_eq!(acme["role"], "owner");
    assert_eq!(acme["primaryOwnerId"], "u_acme");
    assert!(acme["settings"]["roles"].as_array().is_some_and(|r| r.len() >= 4));
    w.drop().await;
}

#[tokio::test]
async fn creating_validates_the_name_and_slug() {
    let Some(w) = World::new().await else { return };
    user(w.db(), "u1").await;
    let cookie = session(w.db(), "u1").await;
    let post = |body: Value| Req::post("/api/workspaces").session(&cookie).json(body);

    let missing = w.send(post(json!({}))).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert!(missing.message().contains("name"), "{}", missing.message());

    let bad_slug = w.send(post(json!({ "name": "Ok", "slug": "Bad Slug!" }))).await;
    assert_eq!(bad_slug.status, StatusCode::BAD_REQUEST);

    let reserved = w.send(post(json!({ "name": "Ok", "slug": "api" }))).await;
    assert_eq!(reserved.status, StatusCode::CONFLICT);

    // the slug is derived from the name when omitted
    let derived = w.send(post(json!({ "name": "My Team" }))).await;
    assert_eq!(derived.status, StatusCode::CREATED);
    assert_eq!(derived.body["slug"], "my-team");
    let taken = w.send(post(json!({ "name": "Other", "slug": "my-team" }))).await;
    assert_eq!(taken.status, StatusCode::CONFLICT);

    // tokens cannot mint workspaces
    let secret =
        common::token(w.db(), derived.body["id"].as_str().unwrap(), "u1", TokenScope::Admin).await;
    let minted =
        w.send(Req::post("/api/workspaces").bearer(&secret).json(json!({ "name": "Nope" }))).await;
    assert_eq!(minted.status, StatusCode::FORBIDDEN);
    w.drop().await;
}

#[tokio::test]
async fn viewer_member_admin_and_owner_permissions() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;

    // everyone in the workspace reads it; outsiders get 404
    for cookie in [&p.owner, &p.admin, &p.member, &p.viewer] {
        assert_eq!(w.send(Req::get("/api/w/acme").session(cookie)).await.status, StatusCode::OK);
    }
    assert_eq!(w.send(Req::get("/api/w/acme").session(&p.out)).await.status, StatusCode::NOT_FOUND);

    // member: no agents, no members, no rename
    let agent = json!({ "name": "Bot", "provider": "codex" });
    let invite = json!({ "email": "x@y.dev", "role": "viewer" });
    let rename = json!({ "name": "Renamed" });
    assert_eq!(
        w.send(Req::post("/api/w/acme/agents").session(&p.member).json(agent.clone())).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(Req::post("/api/w/acme/members").session(&p.member).json(invite)).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(Req::patch("/api/w/acme").session(&p.member).json(rename.clone())).await.status,
        StatusCode::FORBIDDEN
    );

    // admin: agents and rename, not deletion
    let made = w.send(Req::post("/api/w/acme/agents").session(&p.admin).json(agent)).await;
    assert_eq!(made.status, StatusCode::CREATED, "{:?}", made.body);
    let renamed = w.send(Req::patch("/api/w/acme").session(&p.admin).json(rename)).await;
    assert_eq!(renamed.status, StatusCode::OK);
    assert_eq!(renamed.body["name"], "Renamed");
    assert_eq!(renamed.body["role"], "admin");
    let denied = w
        .send(Req::delete("/api/w/acme").session(&p.admin).json(json!({ "confirm": "acme" })))
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);

    // owner: the confirmation must repeat the slug or the name
    assert_eq!(
        w.send(Req::delete("/api/w/acme").session(&p.owner)).await.status,
        StatusCode::BAD_REQUEST
    );
    let wrong = w
        .send(Req::delete("/api/w/acme").session(&p.owner).json(json!({ "confirm": "nope" })))
        .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    let gone = w
        .send(Req::delete("/api/w/acme").session(&p.owner).json(json!({ "confirm": "acme" })))
        .await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT);
    assert_eq!(
        w.send(Req::get("/api/w/acme").session(&p.owner)).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(workspaces::Entity::find_by_id("ws_acme").one(w.db()).await.unwrap().is_none());
    w.drop().await;
}

#[tokio::test]
async fn slugs_are_validated_and_unique_when_renaming() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let patch = |body: Value| Req::patch("/api/w/acme").session(&p.admin).json(body);

    assert_eq!(w.send(patch(json!({ "slug": "other" }))).await.status, StatusCode::CONFLICT);
    assert_eq!(w.send(patch(json!({ "slug": "Not Valid" }))).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(w.send(patch(json!({ "name": "" }))).await.status, StatusCode::BAD_REQUEST);
    let ok = w.send(patch(json!({ "slug": "acme-2" }))).await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert_eq!(ok.body["slug"], "acme-2");
    assert_eq!(w.send(Req::get("/api/w/acme-2").session(&p.admin)).await.status, StatusCode::OK);
    w.drop().await;
}

#[tokio::test]
async fn members_roles_and_the_last_owner() {
    let Some(w) = World::new().await else { return };
    let cookie = create(&w, "acme").await;
    for (id, role) in [("u_admin", "admin"), ("u_member", "member")] {
        user(w.db(), id).await;
        let added = w
            .send(
                Req::post("/api/w/acme/members")
                    .session(&cookie)
                    .json(json!({ "email": format!("{id}@test.dev"), "role": role })),
            )
            .await;
        assert_eq!(added.status, StatusCode::CREATED, "{:?}", added.body);
        assert_eq!(added.body["user"]["email"], format!("{id}@test.dev"));
        assert!(added.body["user"].get("passwordHash").is_none());
    }
    let admin = session(w.db(), "u_admin").await;
    let member_cookie = session(w.db(), "u_member").await;

    let list = w.send(Req::get("/api/w/acme/members").session(&cookie)).await;
    assert_eq!(list.status, StatusCode::OK);
    let rows = list.body.as_array().unwrap();
    let id_of = |user: &str| {
        rows.iter().find(|m| m["userId"] == user).unwrap()["id"].as_str().unwrap().to_owned()
    };
    let (owner_m, member_m) = (id_of("u_acme"), id_of("u_member"));
    let url = |id: &str| format!("/api/w/acme/members/{id}");
    let set = |cookie: &str, id: &str, role: &str| {
        Req::patch(&url(id)).session(cookie).json(json!({ "role": role }))
    };

    assert_eq!(w.send(set(&cookie, &member_m, "admin")).await.status, StatusCode::OK);
    assert_eq!(w.send(set(&cookie, &owner_m, "admin")).await.status, StatusCode::CONFLICT);
    assert_eq!(
        w.send(Req::delete(&url(&owner_m)).session(&cookie)).await.status,
        StatusCode::CONFLICT
    );
    // an admin cannot grant owner or touch the owner
    assert_eq!(w.send(set(&admin, &member_m, "owner")).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        w.send(Req::delete(&url(&owner_m)).session(&admin)).await.status,
        StatusCode::FORBIDDEN
    );
    // existing accounts only, once
    let nobody = json!({ "email": "nobody@nowhere.dev", "role": "member" });
    assert_eq!(
        w.send(Req::post("/api/w/acme/members").session(&cookie).json(nobody)).await.status,
        StatusCode::NOT_FOUND
    );
    let again = json!({ "email": "u_admin@test.dev", "role": "member" });
    assert_eq!(
        w.send(Req::post("/api/w/acme/members").session(&cookie).json(again)).await.status,
        StatusCode::CONFLICT
    );
    // a second owner cannot demote or remove the primary owner
    assert_eq!(w.send(set(&cookie, &member_m, "owner")).await.status, StatusCode::OK);
    assert_eq!(w.send(set(&cookie, &owner_m, "admin")).await.status, StatusCode::CONFLICT);
    assert_eq!(w.send(set(&member_cookie, &owner_m, "admin")).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        w.send(Req::delete(&url(&owner_m)).session(&member_cookie)).await.status,
        StatusCode::FORBIDDEN
    );
    // after a transfer the former creator can step down
    let transfer = w
        .send(
            Req::post("/api/w/acme/transfer-ownership")
                .session(&cookie)
                .json(json!({ "membershipId": member_m })),
        )
        .await;
    assert_eq!(transfer.status, StatusCode::OK, "{:?}", transfer.body);
    assert_eq!(transfer.body["primaryOwnerId"], "u_member");
    assert_eq!(w.send(set(&cookie, &owner_m, "admin")).await.status, StatusCode::OK);
    // anyone can leave
    let leave = w.send(Req::delete(&url(&owner_m)).session(&cookie)).await;
    assert_eq!(leave.status, StatusCode::NO_CONTENT);
    w.drop().await;
}

#[tokio::test]
async fn ownership_transfer_is_for_the_primary_owner_and_real_workspaces() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let id = "mb_ws_acme_u_admin";
    let body = json!({ "membershipId": id });
    let res = w
        .send(Req::post("/api/w/acme/transfer-ownership").session(&p.owner).json(body.clone()))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    assert_eq!(res.body["primaryOwnerId"], "u_admin");
    // an owner who is no longer the primary owner cannot hand it on again
    let res = w
        .send(Req::post("/api/w/acme/transfer-ownership").session(&p.owner).json(body.clone()))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{:?}", res.body);
    // an unknown membership
    let res = w
        .send(
            Req::post("/api/w/acme/transfer-ownership")
                .session(&p.admin)
                .json(json!({ "membershipId": "mb_nope" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // API tokens cannot transfer
    let secret =
        common::token(w.db(), "ws_acme", "u_owner", trama_contracts::roles::TokenScope::Admin)
            .await;
    let res = w.send(Req::post("/api/w/acme/transfer-ownership").bearer(&secret).json(body)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    w.drop().await;
}

#[tokio::test]
async fn settings_are_validated_and_merged() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let patch = |body: Value| Req::patch("/api/w/acme/settings").session(&p.admin).json(body);

    let ok = w
        .send(patch(json!({ "weekStart": "monday", "timeZone": "Europe/Rome", "estimateScale": "fibonacci" })))
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert_eq!(ok.body["settings"]["weekStart"], "monday");
    assert_eq!(ok.body["settings"]["timeZone"], "Europe/Rome");
    // the roles survive a settings patch
    assert!(ok.body["settings"]["roles"].as_array().is_some_and(|r| !r.is_empty()));

    let bad_zone = w.send(patch(json!({ "timeZone": "Mars/Olympus" }))).await;
    assert_eq!(bad_zone.status, StatusCode::BAD_REQUEST);
    let bad_scale = w.send(patch(json!({ "estimateScale": "nope" }))).await;
    assert_eq!(bad_scale.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        w.send(Req::patch("/api/w/acme/settings").session(&p.member).json(json!({}))).await.status,
        StatusCode::FORBIDDEN
    );
    w.drop().await;
}

#[tokio::test]
async fn custom_roles_are_owner_only_and_guarded() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let post =
        |cookie: &str, body: Value| Req::post("/api/w/acme/roles").session(cookie).json(body);

    assert_eq!(
        w.send(post(&p.admin, json!({ "name": "Triager", "capabilities": ["createIssues"] })))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let created = w
        .send(post(&p.owner, json!({ "name": "Triager", "capabilities": ["createIssues"] })))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    let roles = created.body["settings"]["roles"].as_array().unwrap();
    let triager = roles.iter().find(|r| r["name"] == "Triager").unwrap().clone();
    let role_id = triager["id"].as_str().unwrap().to_owned();

    // duplicate names and unknown capabilities
    assert_eq!(
        w.send(post(&p.owner, json!({ "name": "triager", "capabilities": [] }))).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        w.send(post(&p.owner, json!({ "name": "X", "capabilities": ["fly"] }))).await.status,
        StatusCode::BAD_REQUEST
    );

    // rename it, then the role is held by someone and cannot be deleted
    let url = format!("/api/w/acme/roles/{role_id}");
    let renamed =
        w.send(Req::patch(&url).session(&p.owner).json(json!({ "name": "Triage lead" }))).await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    assert_eq!(
        w.send(
            Req::patch("/api/w/acme/roles/missing").session(&p.owner).json(json!({ "name": "A" }))
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let added = w
        .send(
            Req::patch("/api/w/acme/members/mb_ws_acme_u_viewer")
                .session(&p.owner)
                .json(json!({ "role": role_id })),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{:?}", added.body);
    assert_eq!(w.send(Req::delete(&url).session(&p.owner)).await.status, StatusCode::CONFLICT);
    let back = w
        .send(
            Req::patch("/api/w/acme/members/mb_ws_acme_u_viewer")
                .session(&p.owner)
                .json(json!({ "role": "viewer" })),
        )
        .await;
    assert_eq!(back.status, StatusCode::OK);
    assert_eq!(w.send(Req::delete(&url).session(&p.owner)).await.status, StatusCode::OK);
    // the owner role stays
    assert_eq!(
        w.send(Req::delete("/api/w/acme/roles/owner").session(&p.owner)).await.status,
        StatusCode::FORBIDDEN
    );
    w.drop().await;
}

#[tokio::test]
async fn guests_see_only_the_people_on_their_projects() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let on = |projects: &[&str]| {
        json!({
            "projects": { "all": false, "projectIds": projects },
            "includeUnassigned": false,
            "grants": [],
        })
    };
    user(w.db(), "u_guest").await;
    member(w.db(), "ws_acme", "u_guest", "guest", Some(on(&["p_1"]))).await;
    user(w.db(), "u_elsewhere").await;
    member(w.db(), "ws_acme", "u_elsewhere", "guest", Some(on(&["p_2"]))).await;
    let guest = session(w.db(), "u_guest").await;

    let everyone = w.send(Req::get("/api/w/acme/members").session(&p.owner)).await;
    assert_eq!(everyone.body.as_array().unwrap().len(), 6);
    let seen = w.send(Req::get("/api/w/acme/members").session(&guest)).await;
    assert_eq!(seen.status, StatusCode::OK);
    let ids: Vec<&str> =
        seen.body.as_array().unwrap().iter().filter_map(|m| m["userId"].as_str()).collect();
    // people with every project are on theirs; someone limited to another project is not
    assert!(ids.contains(&"u_guest"));
    assert!(ids.contains(&"u_viewer"), "{ids:?}");
    assert!(!ids.contains(&"u_elsewhere"), "{ids:?}");

    // guests do not manage anything
    for req in [
        Req::get("/api/w/acme/tokens"),
        Req::get("/api/w/acme/agents/ag_x"),
        Req::post("/api/w/acme/labels").json(json!({ "name": "x" })),
    ] {
        assert_eq!(w.send(req.session(&guest)).await.status, StatusCode::FORBIDDEN);
    }
    // a guest never gets the workspace roles' capability to invite
    let invite = json!({ "email": "u_viewer@test.dev", "role": "viewer" });
    assert_eq!(
        w.send(Req::post("/api/w/acme/members").session(&guest).json(invite)).await.status,
        StatusCode::FORBIDDEN
    );
    // the owner can still change a guest's access
    let patched = w
        .send(
            Req::patch("/api/w/acme/members/mb_ws_acme_u_guest")
                .session(&p.owner)
                .json(json!({ "access": on(&["p_1", "p_2"]) })),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{:?}", patched.body);
    assert_eq!(patched.body["access"]["projects"]["projectIds"], json!(["p_1", "p_2"]));
    w.drop().await;
}

#[tokio::test]
async fn a_workspace_only_lists_for_its_members_and_tokens_see_one() {
    let Some(w) = World::new().await else { return };
    let _ = people(&w).await;
    workspace_with(w.db(), "third", json!({})).await;
    member(w.db(), "ws_third", "u_owner", "owner", None).await;
    let cookie = session(w.db(), "u_owner").await;
    let all = w.send(Req::get("/api/workspaces").session(&cookie)).await;
    assert_eq!(all.body.as_array().unwrap().len(), 2);

    let secret =
        common::token(w.db(), "ws_acme", "u_owner", trama_contracts::roles::TokenScope::Read).await;
    let one = w.send(Req::get("/api/workspaces").bearer(&secret)).await;
    assert_eq!(one.status, StatusCode::OK, "{:?}", one.body);
    assert_eq!(one.body.as_array().unwrap().len(), 1);
    assert_eq!(one.body[0]["slug"], "acme");
    // agent tokens have no account at all
    common::agent(w.db(), "ws_acme", "ag_1").await;
    let agent =
        common::agent_token(w.db(), "ws_acme", "ag_1", trama_contracts::roles::TokenScope::Read)
            .await;
    assert_eq!(
        w.send(Req::get("/api/workspaces").bearer(&agent)).await.status,
        StatusCode::FORBIDDEN
    );
    let _ = workspace(w.db(), "unused").await;
    w.drop().await;
}
