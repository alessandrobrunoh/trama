//! `stream-auth.spec.ts` (`StreamAuthService.isStillValid`) against real rows: the credentials
//! and the workspace context come from the real access guard, then the database changes under
//! the open stream.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use sea_orm::{DatabaseConnection, EntityTrait};
use trama_auth::{Auth, AuthInfo, Ctx, Gate, Routes, WorkspaceContext};
use trama_contracts::common::ActorRef;
use trama_contracts::roles::TokenScope;
use trama_core::AppState;
use trama_entities::sessions;
use trama_events::stream_auth::is_still_valid;

use common::{Req, World, agent, member, only_projects, session, sql, token, user, workspace};
use tower::ServiceExt;

type Captured = Arc<Mutex<Option<(Arc<AuthInfo>, Arc<WorkspaceContext>)>>>;

#[derive(Clone, Default)]
struct Slot(Captured);

async fn capture_handler(ctx: Ctx, auth: Auth, State(state): State<AppState>) -> StatusCode {
    if let Some(slot) = state.extension::<Slot>() {
        *slot.0.lock().unwrap() = Some((auth.0, ctx.0));
    }
    StatusCode::NO_CONTENT
}

/// What the guard resolves for `req`, as an open stream would hold it.
async fn open(w: &World, req: Req) -> (Arc<AuthInfo>, Arc<WorkspaceContext>) {
    let slot = Slot::default();
    let state = w.state.clone().with_extension(slot.clone());
    let app: Router = Routes::new()
        .get("/w/{slug}/tasks", Gate::authenticated(), capture_handler)
        .into_app(state);
    let res = app.oneshot(req.build()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    slot.0.lock().unwrap().take().expect("the handler ran")
}

async fn valid(db: &DatabaseConnection, auth: &AuthInfo, ctx: &WorkspaceContext) -> bool {
    is_still_valid(db, auth, ctx, Utc::now()).await.unwrap()
}

/// Viewer `u_1` of `acme`, with a session.
async fn viewer(w: &World) -> (String, Arc<AuthInfo>, Arc<WorkspaceContext>) {
    workspace(w.db(), "acme").await;
    user(w.db(), "u_1").await;
    member(w.db(), "ws_acme", "u_1", "viewer", None).await;
    let cookie = session(w.db(), "u_1").await;
    let (auth, ctx) = open(w, Req::get("/api/w/acme/tasks").session(&cookie)).await;
    (cookie, auth, ctx)
}

#[tokio::test]
async fn accepts_a_live_session_of_a_current_member() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn rejects_a_deleted_logged_out_or_expired_session() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    sql(w.db(), r#"UPDATE sessions SET "expiresAt" = now() - interval '1 second'"#).await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    sql(w.db(), "DELETE FROM sessions").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn a_session_is_only_valid_until_its_expiry_instant() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    let session = sessions::Entity::find().one(w.db()).await.unwrap().unwrap();
    let at = session.expires_at.to_utc();
    assert!(is_still_valid(w.db(), &auth, &ctx, at - Duration::milliseconds(1)).await.unwrap());
    assert!(!is_still_valid(w.db(), &auth, &ctx, at).await.unwrap());
    w.drop().await;
}

#[tokio::test]
async fn rejects_a_member_who_was_removed_from_the_workspace() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    sql(w.db(), "DELETE FROM memberships").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn rejects_a_member_whose_role_changed() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    sql(w.db(), "UPDATE memberships SET role = 'admin'").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    sql(w.db(), "UPDATE memberships SET role = 'a_role_that_was_deleted'").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn closes_a_stream_when_effective_project_access_changes() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    user(w.db(), "u_1").await;
    member(w.db(), "ws_acme", "u_1", "viewer", Some(only_projects(&["pr_1"], false))).await;
    let cookie = session(w.db(), "u_1").await;
    let (auth, ctx) = open(&w, Req::get("/api/w/acme/tasks").session(&cookie)).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    let after = only_projects(&["pr_2"], false);
    sql(w.db(), &format!(r"UPDATE memberships SET access = '{after}'")).await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    // back to the original access: valid again
    let before = only_projects(&["pr_1"], false);
    sql(w.db(), &format!(r"UPDATE memberships SET access = '{before}'")).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    // the limit lifted
    sql(w.db(), "UPDATE memberships SET access = NULL").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn accepts_a_live_api_token_and_rejects_a_revoked_expired_or_foreign_one() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    user(w.db(), "u_1").await;
    member(w.db(), "ws_acme", "u_1", "viewer", None).await;

    let bearer = |secret: &str| Req::get("/api/w/acme/tasks").bearer(secret);
    let make =
        |expires| token(w.db(), "ws_acme", ActorRef::user("u_1"), TokenScope::Write, None, expires);

    let (_, secret) = make(None).await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    assert!(valid(w.db(), &auth, &ctx).await);

    // an expiry in the future
    let (row, secret) = make(Some((Utc::now() + Duration::seconds(60)).fixed_offset())).await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    // ... that has passed
    sql(
        w.db(),
        &format!(
            r#"UPDATE api_tokens SET "expiresAt" = now() - interval '1 second' WHERE id = '{}'"#,
            row.id
        ),
    )
    .await;
    assert!(!valid(w.db(), &auth, &ctx).await);

    // revoked
    let (row, secret) = make(None).await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    sql(w.db(), &format!("DELETE FROM api_tokens WHERE id = '{}'", row.id)).await;
    assert!(!valid(w.db(), &auth, &ctx).await);

    // moved to another workspace
    let (row, secret) = make(None).await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    sql(
        w.db(),
        &format!(r#"UPDATE api_tokens SET "workspaceId" = 'ws_other' WHERE id = '{}'"#, row.id),
    )
    .await;
    assert!(!valid(w.db(), &auth, &ctx).await);

    // a new scope or new permissions end the stream
    let (row, secret) = make(None).await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    sql(w.db(), &format!("UPDATE api_tokens SET scope = 'read' WHERE id = '{}'", row.id)).await;
    assert!(!valid(w.db(), &auth, &ctx).await);

    let (row, secret) = token(
        w.db(),
        "ws_acme",
        ActorRef::user("u_1"),
        TokenScope::Custom,
        Some(&["tasks:read"]),
        None,
    )
    .await;
    let (auth, ctx) = open(&w, bearer(&secret)).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    sql(
        w.db(),
        &format!(
            r#"UPDATE api_tokens SET permissions = '["tasks:read","tasks:write"]' WHERE id = '{}'"#,
            row.id
        ),
    )
    .await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn keeps_an_agent_token_open_only_while_the_agent_exists_in_the_workspace() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    agent(w.db(), "ws_acme", "ag_1").await;
    let (_, secret) =
        token(w.db(), "ws_acme", ActorRef::agent("ag_1"), TokenScope::Write, None, None).await;
    let (auth, ctx) = open(&w, Req::get("/api/w/acme/tasks").bearer(&secret)).await;
    assert!(valid(w.db(), &auth, &ctx).await);
    sql(w.db(), "DELETE FROM agents WHERE id = 'ag_1'").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}

#[tokio::test]
async fn rejects_a_stream_whose_workspace_is_gone() {
    let Some(w) = World::new().await else { return };
    let (_, auth, ctx) = viewer(&w).await;
    sql(w.db(), "DELETE FROM workspaces").await;
    assert!(!valid(w.db(), &auth, &ctx).await);
    w.drop().await;
}
