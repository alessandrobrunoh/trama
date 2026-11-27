//! Invitation endpoints preserve the NestJS session, email binding and expiry contract.

mod common;

use axum::http::StatusCode;
use common::{Req, World, member, only_projects, project, session, sql, token, user, workspace};
use serde_json::json;
use trama_common::mail::Mailer;

#[tokio::test]
async fn creates_lists_previews_and_accepts_only_for_the_invited_session_user() {
    let Some(world) = World::new().await else { return };
    let db = world.db();
    workspace(db, "studio").await;
    user(db, "u_owner").await;
    member(db, "ws_studio", "u_owner", "owner", None).await;
    let owner_session = session(db, "u_owner").await;
    user(db, "u_target").await;

    let created = world
        .send(
            Req::post("/api/w/studio/invites")
                .session(&owner_session)
                .json(&json!({"email":"u_target@test.dev","role":"member"})),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.message());
    assert_eq!(created.body["invite"]["email"], "u_target@test.dev");
    assert_eq!(created.body["emailed"], true);
    let mailer = Mailer::of(&world.state);
    assert_eq!(mailer.sent().len(), 1);
    let url = created.body["url"].as_str().unwrap();
    let invitation_token = url.rsplit('/').next().unwrap();
    let listed = world.send(Req::get("/api/w/studio/invites").session(&owner_session)).await;
    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(listed.body.as_array().unwrap().len(), 1);

    let preview = world.send(Req::get(&format!("/api/invites/{invitation_token}"))).await;
    assert_eq!(preview.status, StatusCode::OK);
    assert_eq!(preview.body["workspaceName"], "STUDIO");
    assert_eq!(preview.body["role"], "member");

    let wrong = session(db, "u_owner").await;
    let denied = world
        .send(Req::post(&format!("/api/invites/{invitation_token}/accept")).session(&wrong))
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let api_token = token(db, "ws_studio", "u_owner").await;
    let token_accept = world
        .send(Req::post(&format!("/api/invites/{invitation_token}/accept")).bearer(&api_token))
        .await;
    assert_eq!(token_accept.status, StatusCode::FORBIDDEN);

    let target_session = session(db, "u_target").await;
    let accepted = world
        .send(
            Req::post(&format!("/api/invites/{invitation_token}/accept")).session(&target_session),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.message());
    assert_eq!(accepted.body["workspace"]["slug"], "studio");

    let consumed = world.send(Req::get(&format!("/api/invites/{invitation_token}"))).await;
    assert_eq!(consumed.status, StatusCode::NOT_FOUND);
    world.drop().await;
}

#[tokio::test]
async fn revokes_workspace_invites_and_rejects_unknown_tokens() {
    let Some(world) = World::new().await else { return };
    let db = world.db();
    workspace(db, "studio").await;
    user(db, "u_owner").await;
    member(db, "ws_studio", "u_owner", "owner", None).await;
    let owner_session = session(db, "u_owner").await;
    let created = world
        .send(
            Req::post("/api/w/studio/invites")
                .session(&owner_session)
                .json(&json!({"email":"nobody@test.dev","role":"member"})),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.message());
    let id = created.body["invite"]["id"].as_str().unwrap();
    let revoked = world
        .send(Req::delete(&format!("/api/w/studio/invites/{id}")).session(&owner_session))
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    let token = created.body["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        world.send(Req::get(&format!("/api/invites/{token}"))).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        world.send(Req::get("/api/invites/not-a-token")).await.status,
        StatusCode::NOT_FOUND
    );
    world.drop().await;
}

#[tokio::test]
async fn resend_rotates_an_expired_pending_invite_and_accept_preserves_existing_role() {
    let Some(world) = World::new().await else { return };
    let db = world.db();
    workspace(db, "studio").await;
    user(db, "u_owner").await;
    member(db, "ws_studio", "u_owner", "owner", None).await;
    user(db, "u_target").await;
    let owner_session = session(db, "u_owner").await;
    let created = world
        .send(
            Req::post("/api/w/studio/invites")
                .session(&owner_session)
                .json(&json!({"email":"u_target@test.dev","role":"viewer"})),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.message());
    let invite_id = created.body["invite"]["id"].as_str().unwrap();
    let old_token = created.body["url"].as_str().unwrap().rsplit('/').next().unwrap();
    sql(
        db,
        &format!(
            "UPDATE invites SET \"expiresAt\" = NOW() - INTERVAL '1 day' WHERE id = '{invite_id}'"
        ),
    )
    .await;
    assert_eq!(
        world.send(Req::get(&format!("/api/invites/{old_token}"))).await.status,
        StatusCode::NOT_FOUND
    );

    let resent = world
        .send(
            Req::post(&format!("/api/w/studio/invites/{invite_id}/resend")).session(&owner_session),
        )
        .await;
    assert_eq!(resent.status, StatusCode::OK, "{}", resent.message());
    let new_token = resent.body["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_ne!(old_token, new_token);
    assert_eq!(
        world.send(Req::get(&format!("/api/invites/{new_token}"))).await.status,
        StatusCode::OK
    );

    // The invitation was issued first; a membership added meanwhile must keep its stronger role.
    member(db, "ws_studio", "u_target", "admin", None).await;
    let target_session = session(db, "u_target").await;
    let accepted = world
        .send(Req::post(&format!("/api/invites/{new_token}/accept")).session(&target_session))
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.message());
    assert_eq!(accepted.body["role"], "admin");
    world.drop().await;
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn project_invite_accept_share_remove_and_revoke_are_workspace_scoped() {
    let Some(world) = World::new().await else { return };
    let db = world.db();
    workspace(db, "studio").await;
    user(db, "u_owner").await;
    member(db, "ws_studio", "u_owner", "owner", None).await;
    project(db, "ws_studio", "pj_shared", "Brand refresh", "BRND").await;
    workspace(db, "other").await;
    project(db, "ws_other", "pj_other", "Private", "PRIV").await;
    project(db, "ws_studio", "pj_existing", "Existing", "EXST").await;
    user(db, "u_guest").await;
    user(db, "u_existing").await;
    member(db, "ws_studio", "u_existing", "viewer", Some(only_projects(&["pj_existing"]))).await;
    let owner_session = session(db, "u_owner").await;

    let cross_workspace =
        world.send(Req::get("/api/w/studio/projects/pj_other/share").session(&owner_session)).await;
    assert_eq!(cross_workspace.status, StatusCode::NOT_FOUND);

    let added = world
        .send(
            Req::post("/api/w/studio/projects/pj_shared/invites")
                .session(&owner_session)
                .json(&json!({"email":"u_existing@test.dev"})),
        )
        .await;
    assert_eq!(added.status, StatusCode::CREATED, "{}", added.message());
    assert_eq!(added.body["status"], "added");
    assert_eq!(
        added.body["member"]["access"]["projects"]["projectIds"],
        json!(["pj_existing", "pj_shared"])
    );

    let invited = world
        .send(
            Req::post("/api/w/studio/projects/pj_shared/invites")
                .session(&owner_session)
                .json(&json!({"email":"u_guest@test.dev"})),
        )
        .await;
    assert_eq!(invited.status, StatusCode::CREATED, "{}", invited.message());
    assert_eq!(invited.body["status"], "invited");
    let link = invited.body["link"]["url"].as_str().unwrap().to_owned();
    let token = link.rsplit('/').next().unwrap();
    let guest_session = session(db, "u_guest").await;
    let accepted = world
        .send(Req::post(&format!("/api/invites/{token}/accept")).session(&guest_session))
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.message());

    let share = world
        .send(Req::get("/api/w/studio/projects/pj_shared/share").session(&owner_session))
        .await;
    assert_eq!(share.status, StatusCode::OK, "{}", share.message());
    let guest = share.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["userId"] == "u_guest")
        .unwrap();
    assert_eq!(guest["allProjects"], false);
    let membership_id = guest["id"].as_str().unwrap();
    let removed = world
        .send(
            Req::delete(&format!("/api/w/studio/projects/pj_shared/share/{membership_id}"))
                .session(&owner_session),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.message());
    assert_eq!(removed.body["membershipEnded"], true);

    let revoked = world
        .send(
            Req::post("/api/w/studio/projects/pj_shared/invites")
                .session(&owner_session)
                .json(&json!({"email":"another@test.dev"})),
        )
        .await;
    assert_eq!(revoked.status, StatusCode::CREATED);
    let invite_id = revoked.body["link"]["invite"]["id"].as_str().unwrap();
    let old_token = revoked.body["link"]["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let added_project = world
        .send(
            Req::post("/api/w/studio/projects/pj_existing/invites")
                .session(&owner_session)
                .json(&json!({"email":"another@test.dev"})),
        )
        .await;
    assert_eq!(added_project.status, StatusCode::CREATED, "{}", added_project.message());
    assert_eq!(added_project.body["link"]["invite"]["id"], invite_id);
    let resent = world
        .send(
            Req::post(&format!("/api/w/studio/projects/pj_shared/invites/{invite_id}/resend"))
                .session(&owner_session),
        )
        .await;
    assert_eq!(resent.status, StatusCode::OK, "{}", resent.message());
    let new_token = resent.body["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_ne!(old_token, new_token);
    assert_eq!(
        world.send(Req::get(&format!("/api/invites/{old_token}"))).await.status,
        StatusCode::NOT_FOUND
    );
    let removed_project = world
        .send(
            Req::delete(&format!("/api/w/studio/projects/pj_shared/invites/{invite_id}"))
                .session(&owner_session),
        )
        .await;
    assert_eq!(removed_project.status, StatusCode::NO_CONTENT);
    let remaining = world
        .send(Req::get("/api/w/studio/projects/pj_existing/share").session(&owner_session))
        .await;
    assert_eq!(remaining.status, StatusCode::OK);
    assert_eq!(remaining.body["invites"].as_array().unwrap().len(), 1);
    world.drop().await;
}
