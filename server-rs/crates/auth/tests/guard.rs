//! The access guard against a real database, through a stand-in router with the decorators of
//! the NestJS workspace controllers: `access.guard.spec.ts`, and the behaviour of
//! `auth.e2e-spec.ts`, `token-permissions.e2e-spec.ts` and `access.e2e-spec.ts` that the guard
//! decides.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use sea_orm::{ConnectionTrait, EntityTrait, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use trama_auth::member_access::{apply_project_scope, with_access};
use trama_contracts::access::MemberAccess;
use trama_contracts::roles::{TokenScope, fresh_workspace_roles};
use trama_entities::{api_tokens, issues};

use common::{Req, Tok, World, agent, member, session, user, workspace, workspace_with};

/// Owner `u_owner`, admin `u_admin`, member `u_member`, viewer `u_viewer` in workspace `acme`;
/// `u_out` belongs elsewhere.
async fn people(w: &World) {
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    for (id, role) in
        [("u_owner", "owner"), ("u_admin", "admin"), ("u_member", "member"), ("u_viewer", "viewer")]
    {
        user(w.db(), id).await;
        member(w.db(), "ws_acme", id, role, None).await;
    }
    user(w.db(), "u_out").await;
    member(w.db(), "ws_other", "u_out", "owner", None).await;
}

async fn status(w: &World, req: Req) -> StatusCode {
    w.send(req).await.status
}

#[tokio::test]
async fn cookie_sessions_need_the_csrf_header_and_json_bodies() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let cookie = session(w.db(), "u_owner").await;
    let plain = || Req::post("/api/workspaces").header("cookie", &cookie);
    let res = w.send(plain().json(json!({ "name": "Nope" }))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Missing X-Requested-With or X-Client-Id header");
    // the content type is checked first
    let res = w.send(plain().raw("text/plain", "name=Nope")).await;
    assert_eq!(res.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let res =
        w.send(plain().header("x-requested-with", "test").raw("text/plain", "name=Nope")).await;
    assert_eq!(res.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        status(&w, plain().header("x-requested-with", "test").json(json!({}))).await,
        StatusCode::CREATED
    );
    // multipart only where the route accepts it
    let multipart = "multipart/form-data; boundary=x";
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").session(&cookie).raw(multipart, "--x--")).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        status(&w, Req::post("/api/w/acme/uploads").session(&cookie).raw(multipart, "--x--")).await,
        StatusCode::CREATED
    );
    // an empty X-Requested-With does not count; no body needs no content type
    assert_eq!(
        status(
            &w,
            Req::post("/api/w/acme/tasks").header("cookie", &cookie).header("x-requested-with", "")
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").session(&cookie)).await,
        StatusCode::CREATED
    );
    // tokens are not subject to CSRF rules
    let (_, secret) = Tok::user("ws_acme", "u_owner", TokenScope::Write).mint(w.db()).await;
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").bearer(&secret).raw("text/plain", "x")).await,
        StatusCode::CREATED
    );
    w.drop().await;
}

#[tokio::test]
async fn bearer_tokens_act_as_users_and_agents() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let cookie = session(w.db(), "u_owner").await;
    let (row, secret) = Tok::user("ws_acme", "u_owner", TokenScope::Admin).mint(w.db()).await;
    assert!(secret.starts_with("trm_"));
    assert_eq!(row.prefix, format!("{}…", &secret[..8]));
    let snap = w.send(Req::get("/api/w/acme/snapshot").bearer(&secret)).await;
    assert_eq!(snap.status, StatusCode::OK);
    assert_eq!(snap.body["role"], "owner");
    assert_eq!(snap.body["tokenScope"], "admin");
    assert_eq!(status(&w, Req::get("/api/workspaces").bearer(&secret)).await, StatusCode::OK);
    // lastUsedAt is touched
    let stored = api_tokens::Entity::find_by_id(row.id.clone()).one(w.db()).await.unwrap().unwrap();
    assert!(stored.last_used_at.is_some());

    // a bogus bearer authenticates as nobody, even next to a valid cookie
    assert_eq!(
        status(&w, Req::get("/api/workspaces").bearer("nbl_bogus")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(&w, Req::get("/api/auth/me").header("cookie", &cookie).bearer("nbl_bogus")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(
            &w,
            Req::get("/api/auth/me").header("cookie", &cookie).header("authorization", "Basic x")
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    // a token of another workspace does not reach this one
    assert_eq!(
        status(&w, Req::get("/api/w/other/tasks").bearer(&secret)).await,
        StatusCode::NOT_FOUND
    );

    // agent token: member permissions, actor = agent, no user-only routes
    agent(w.db(), "ws_acme", "ag_bot").await;
    let (_, bot) = Tok::agent("ws_acme", "ag_bot", TokenScope::Write).mint(w.db()).await;
    let projects = w.send(Req::get("/api/w/acme/projects").bearer(&bot)).await;
    assert_eq!(projects.status, StatusCode::OK);
    assert_eq!(projects.body["role"], "member");
    assert_eq!(projects.body["actor"], json!({ "type": "agent", "id": "ag_bot" }));
    assert_eq!(projects.body["owner"], false);
    let res = w.send(Req::post("/api/w/acme/agents").bearer(&bot).json(json!({}))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "You are not allowed to manage agents");
    assert_eq!(
        status(&w, Req::get("/api/w/acme/snapshot").bearer(&bot)).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(status(&w, Req::post("/api/w/acme/tasks").bearer(&bot)).await, StatusCode::CREATED);
    // the agent is removed: its token no longer reaches the workspace
    w.db().execute_unprepared("DELETE FROM agents WHERE id = 'ag_bot'").await.unwrap();
    assert_eq!(
        status(&w, Req::get("/api/w/acme/projects").bearer(&bot)).await,
        StatusCode::NOT_FOUND
    );

    // legacy nbl_ secrets still work
    let legacy = "nbl_abcdefghijklmnop";
    w.db()
        .execute_unprepared(&format!(
            r#"UPDATE api_tokens SET "tokenHash" = '{}' WHERE id = '{}'"#,
            trama_common::crypto::sha256_hex(legacy),
            row.id
        ))
        .await
        .unwrap();
    assert_eq!(status(&w, Req::get("/api/w/acme/tasks").bearer(legacy)).await, StatusCode::OK);

    // revoked or expired → 401
    trama_auth::tokens::revoke(w.db(), &row.id).await.unwrap();
    assert_eq!(
        status(&w, Req::get("/api/workspaces").bearer(legacy)).await,
        StatusCode::UNAUTHORIZED
    );
    let (expiring, secret) = Tok::user("ws_acme", "u_owner", TokenScope::Read).mint(w.db()).await;
    assert_eq!(status(&w, Req::get("/api/workspaces").bearer(&secret)).await, StatusCode::OK);
    w.db()
        .execute_unprepared(&format!(
            r#"UPDATE api_tokens SET "expiresAt" = now() - interval '1 minute' WHERE id = '{}'"#,
            expiring.id
        ))
        .await
        .unwrap();
    assert_eq!(
        status(&w, Req::get("/api/workspaces").bearer(&secret)).await,
        StatusCode::UNAUTHORIZED
    );
    w.drop().await;
}

#[tokio::test]
async fn workspace_resolution_hides_workspaces_from_non_members() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let outsider = session(w.db(), "u_out").await;
    for path in ["/api/w/acme/tasks", "/api/w/nowhere/tasks"] {
        let res = w.send(Req::get(path).session(&outsider)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        let slug = path.split('/').nth(3).unwrap();
        assert_eq!(
            res.body,
            json!({ "statusCode": 404, "message": format!("Workspace \"{slug}\" not found"), "error": "Not Found" })
        );
    }
    // a role deleted from the settings
    let viewer = session(w.db(), "u_viewer").await;
    let roles: Vec<_> = fresh_workspace_roles().into_iter().filter(|r| r.id != "viewer").collect();
    w.db()
        .execute_unprepared(&format!(
            r"UPDATE workspaces SET settings = '{}' WHERE id = 'ws_acme'",
            json!({ "roles": roles })
        ))
        .await
        .unwrap();
    let res = w.send(Req::get("/api/w/acme/tasks").session(&viewer)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This role is no longer available");
    w.drop().await;
}

#[tokio::test]
async fn roles_and_capabilities_gate_routes() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let [owner, admin, member, viewer] = [
        session(w.db(), "u_owner").await,
        session(w.db(), "u_admin").await,
        session(w.db(), "u_member").await,
        session(w.db(), "u_viewer").await,
    ];
    let post = |path: &str, cookie: &str| Req::post(path).session(cookie).json(json!({}));
    assert_eq!(status(&w, post("/api/w/acme/projects", &member)).await, StatusCode::CREATED);
    let res = w.send(post("/api/w/acme/projects", &viewer)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "You are not allowed to manage projects");
    assert_eq!(status(&w, Req::get("/api/w/acme/projects").session(&viewer)).await, StatusCode::OK);
    // the viewer gate for reads, the member gate for writes without a capability
    let res = w.send(Req::patch("/api/w/acme/tasks/T-1").session(&viewer).json(json!({}))).await;
    assert_eq!(res.message(), "You are not allowed to do that");
    assert_eq!(
        status(&w, Req::patch("/api/w/acme/tasks/T-1").session(&member).json(json!({}))).await,
        StatusCode::OK
    );
    // @Roles('admin')
    assert_eq!(
        status(&w, Req::patch("/api/w/acme").session(&member).json(json!({}))).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status(&w, Req::patch("/api/w/acme").session(&admin).json(json!({}))).await,
        StatusCode::OK
    );
    assert_eq!(status(&w, post("/api/w/acme/agents", &admin)).await, StatusCode::CREATED);
    assert_eq!(status(&w, post("/api/w/acme/agents", &member)).await, StatusCode::FORBIDDEN);

    // capabilities follow the workspace settings: take manageProjects from members
    let mut roles = fresh_workspace_roles();
    for role in &mut roles {
        if role.id == "member" {
            role.capabilities
                .retain(|c| c.as_str() != "manageProjects" && c.as_str() != "deleteIssues");
        }
    }
    w.db()
        .execute_unprepared(&format!(
            r"UPDATE workspaces SET settings = '{}' WHERE id = 'ws_acme'",
            json!({ "roles": roles })
        ))
        .await
        .unwrap();
    assert_eq!(status(&w, post("/api/w/acme/projects", &member)).await, StatusCode::FORBIDDEN);
    let res = w.send(Req::delete("/api/w/acme/tasks/T-1").session(&member)).await;
    assert_eq!(res.message(), "You are not allowed to delete issues");
    assert_eq!(
        status(&w, Req::delete("/api/w/acme/tasks/T-1").session(&admin)).await,
        StatusCode::NO_CONTENT
    );
    let ctx = w.send(Req::get("/api/w/acme").session(&owner)).await;
    assert_eq!(ctx.body["owner"], true);
    assert!(ctx.body["currentAccess"].is_null());
    w.drop().await;
}

#[tokio::test]
async fn token_scopes_cap_the_role() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let mint = |scope| Tok::user("ws_acme", "u_owner", scope).mint(w.db());
    let (_, read) = mint(TokenScope::Read).await;
    let (_, write) = mint(TokenScope::Write).await;
    let (_, admin) = mint(TokenScope::Admin).await;

    // read: GET only, and no capability
    let snap = w.send(Req::get("/api/w/acme/snapshot").bearer(&read)).await;
    assert_eq!(snap.status, StatusCode::OK);
    assert_eq!(snap.body["role"], "owner");
    assert_eq!(snap.body["owner"], false);
    let denied = w.send(Req::post("/api/w/acme/tasks").bearer(&read).json(json!({}))).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(
        denied.message(),
        "This API token has the \"read\" scope and can only call GET routes"
    );
    let res = w.send(Req::get("/api/w/acme/integrations").bearer(&read)).await;
    assert_eq!(res.message(), "This route needs more than the \"read\" token scope allows");

    // write: everyday work, not workspace administration, even for the owner
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").bearer(&write).json(json!({}))).await,
        StatusCode::CREATED
    );
    let res = w.send(Req::post("/api/w/acme/agents").bearer(&write).json(json!({}))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This route needs more than the \"write\" token scope allows");
    assert_eq!(
        status(&w, Req::patch("/api/w/acme").bearer(&write).json(json!({}))).await,
        StatusCode::FORBIDDEN
    );

    // admin: the full role
    assert_eq!(
        status(&w, Req::post("/api/w/acme/agents").bearer(&admin).json(json!({}))).await,
        StatusCode::CREATED
    );
    assert_eq!(w.send(Req::get("/api/w/acme").bearer(&admin)).await.body["owner"], true);
    // an agent token with read scope
    agent(w.db(), "ws_acme", "ag_r").await;
    let (_, bot) = Tok::agent("ws_acme", "ag_r", TokenScope::Read).mint(w.db()).await;
    assert_eq!(status(&w, Req::get("/api/w/acme/tasks").bearer(&bot)).await, StatusCode::OK);
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").bearer(&bot)).await,
        StatusCode::FORBIDDEN
    );
    w.drop().await;
}

#[tokio::test]
async fn custom_tokens_only_reach_the_listed_permissions() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let (row, secret) =
        Tok::custom("ws_acme", "u_owner", &["tasks:write", "projects:read"]).mint(w.db()).await;
    assert_eq!(row.scope, "custom");
    assert_eq!(row.permissions, Some(json!(["projects:read", "tasks:read", "tasks:write"])));
    let (world, key) = (&w, &secret);
    let ok = move |req: Req| async move { status(world, req.bearer(key)).await };
    assert_eq!(ok(Req::get("/api/w/acme/tasks")).await, StatusCode::OK);
    assert_eq!(ok(Req::post("/api/w/acme/tasks").json(json!({}))).await, StatusCode::CREATED);
    assert_eq!(ok(Req::get("/api/w/acme/projects")).await, StatusCode::OK);
    let res = w.send(Req::delete("/api/w/acme/tasks/BUG-1").bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This API token lacks the \"tasks:delete\" permission");
    let res = w.send(Req::post("/api/w/acme/projects").bearer(&secret).json(json!({}))).await;
    assert_eq!(res.message(), "This API token lacks the \"projects:write\" permission");
    for (req, message) in [
        (Req::get("/api/w/acme/snapshot"), "This API token lacks the \"snapshot:read\" permission"),
        (Req::get("/api/w/acme/tokens"), "This API token lacks the \"tokens:read\" permission"),
        (Req::post("/api/w/acme/ai/chat"), "This route is not available to custom API tokens"),
    ] {
        let res = w.send(req.bearer(&secret)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.message(), message);
    }
    // upload bytes are checked by the uploads service, not by a permission
    let upload = w.send(Req::get("/api/w/acme/uploads/up_1").bearer(&secret)).await;
    assert_eq!(upload.status, StatusCode::OK);
    assert_eq!(
        upload.body["uploadPermissions"],
        json!(["projects:read", "tasks:read", "tasks:write"])
    );

    // nested artifacts need artifacts:*, not the parent's permission
    assert_eq!(ok(Req::get("/api/w/acme/tasks/T-1/artifacts")).await, StatusCode::FORBIDDEN);
    let (_, artifacts) = Tok::custom("ws_acme", "u_owner", &["artifacts:write"]).mint(w.db()).await;
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks/T-1/artifacts").bearer(&artifacts).json(json!({})))
            .await,
        StatusCode::CREATED
    );
    assert_eq!(
        status(&w, Req::get("/api/w/acme/tasks/T-1/artifacts").bearer(&artifacts)).await,
        StatusCode::OK
    );
    w.drop().await;
}

#[tokio::test]
async fn custom_tokens_stay_bounded_by_the_role() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let (_, secret) = Tok::custom("ws_acme", "u_member", &["tasks:write"]).mint(w.db()).await;
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").bearer(&secret)).await,
        StatusCode::CREATED
    );
    w.db()
        .execute_unprepared(r#"UPDATE memberships SET role = 'viewer' WHERE "userId" = 'u_member'"#)
        .await
        .unwrap();
    assert_eq!(
        status(&w, Req::post("/api/w/acme/tasks").bearer(&secret)).await,
        StatusCode::FORBIDDEN
    );
    w.drop().await;
}

#[tokio::test]
async fn per_token_budgets_answer_429() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let (_, per_minute) = Tok::custom("ws_acme", "u_owner", &["tasks:write"])
        .limits(json!({ "writesPerMinute": 2 }))
        .mint(w.db())
        .await;
    let post = |s: &str| Req::post("/api/w/acme/tasks").bearer(s);
    assert_eq!(status(&w, post(&per_minute)).await, StatusCode::CREATED);
    assert_eq!(status(&w, post(&per_minute)).await, StatusCode::CREATED);
    let blocked = w.send(post(&per_minute)).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        blocked.body,
        json!({ "statusCode": 429, "message": "Token limit reached: 2 writes per minute. Slow down." })
    );
    assert_eq!(status(&w, Req::get("/api/w/acme/tasks").bearer(&per_minute)).await, StatusCode::OK);

    let (row, per_day) = Tok::custom("ws_acme", "u_owner", &["tasks:write"])
        .limits(json!({ "writesPerDay": 1 }))
        .mint(w.db())
        .await;
    assert_eq!(status(&w, post(&per_day)).await, StatusCode::CREATED);
    let day = w.send(post(&per_day)).await;
    assert_eq!(day.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(day.message().contains("1 writes per day"), "{}", day.message());
    let writes = w
        .db()
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            format!(r#"SELECT writes FROM api_token_usage WHERE "tokenId" = '{}'"#, row.id),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i32>("", "writes")
        .unwrap();
    assert_eq!(writes, 2);

    let (_, reads) = Tok::custom("ws_acme", "u_owner", &["tasks:read"])
        .limits(json!({ "requestsPerMinute": 2 }))
        .mint(w.db())
        .await;
    let get = || Req::get("/api/w/acme/tasks").bearer(&reads);
    assert_eq!(status(&w, get()).await, StatusCode::OK);
    assert_eq!(status(&w, get()).await, StatusCode::OK);
    assert_eq!(status(&w, get()).await, StatusCode::TOO_MANY_REQUESTS);
    w.drop().await;
}

#[tokio::test]
async fn session_only_routes_refuse_tokens_before_counting_them() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    let (_, secret) = Tok::user("ws_acme", "u_owner", TokenScope::Admin)
        .limits(json!({ "requestsPerMinute": 1 }))
        .mint(w.db())
        .await;
    let res = w
        .send(Req::post("/api/workspaces").bearer(&secret).json(json!({ "name": "Escape" })))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        res.message(),
        "This account-level route is only available to signed-in browser sessions, not API tokens"
    );
    // the refused call did not use the one request of the budget
    assert_eq!(status(&w, Req::get("/api/workspaces").bearer(&secret)).await, StatusCode::OK);
    assert_eq!(
        status(&w, Req::get("/api/workspaces").bearer(&secret)).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    let cookie = session(w.db(), "u_owner").await;
    assert_eq!(
        status(&w, Req::post("/api/workspaces").session(&cookie).json(json!({}))).await,
        StatusCode::CREATED
    );
    w.drop().await;
}

#[tokio::test]
async fn member_access_narrows_the_role() {
    let Some(w) = World::new().await else { return };
    people(&w).await;
    // a viewer allowed to file issues, on one project only
    user(w.db(), "u_extra").await;
    member(
        w.db(),
        "ws_acme",
        "u_extra",
        "viewer",
        Some(json!({ "projects": { "all": false, "projectIds": ["pj_1"] }, "includeUnassigned": false, "grants": ["issues:create"] })),
    )
    .await;
    let extra = session(w.db(), "u_extra").await;
    let list = w.send(Req::get("/api/w/acme/tasks").session(&extra)).await;
    assert_eq!(list.status, StatusCode::OK);
    let access = &list.body["access"];
    assert_eq!(access["projects"], json!({ "all": false, "projectIds": ["pj_1"] }));
    assert_eq!(access["includeUnassigned"], false);
    assert!(access["grants"].as_array().unwrap().contains(&json!("issues:create")));
    // the task-local carries the same access
    assert_eq!(list.body["currentAccess"], list.body["access"]);
    // the grant stands in for the member gate, but only for creating
    assert_eq!(
        status(&w, Req::post("/api/w/acme/projects").session(&extra)).await,
        StatusCode::FORBIDDEN
    );
    let res = w.send(Req::patch("/api/w/acme/tasks/T-1").session(&extra).json(json!({}))).await;
    assert_eq!(res.message(), "You are not allowed to do that");

    // a role that can write but whose grants are view-only: the grant narrows the route
    let mut roles = fresh_workspace_roles();
    roles.push(trama_contracts::roles::WorkspaceRole {
        id: "role_triage".into(),
        name: "Triage".into(),
        owner: false,
        capabilities: vec![trama_contracts::roles::Capability::CreateIssues],
        grants: trama_contracts::access::role_grants(trama_contracts::roles::LegacyRole::Viewer),
    });
    workspace_with(w.db(), "triage", json!({ "roles": roles })).await;
    member(w.db(), "ws_triage", "u_extra", "role_triage", None).await;
    let res = w.send(Req::patch("/api/w/triage/tasks/T-1").session(&extra).json(json!({}))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Your access does not include \"issues:update\"");
    // capability-gated routes are not narrowed by grants
    assert_eq!(
        status(&w, Req::post("/api/w/triage/tasks").session(&extra)).await,
        StatusCode::CREATED
    );

    // guests: projects only from their list, and no workspace-wide routes
    user(w.db(), "u_guest").await;
    member(w.db(), "ws_acme", "u_guest", "guest", None).await;
    let guest = session(w.db(), "u_guest").await;
    let seen = w.send(Req::get("/api/w/acme/tasks").session(&guest)).await;
    assert_eq!(seen.status, StatusCode::OK);
    assert_eq!(seen.body["access"]["projects"], json!({ "all": false, "projectIds": [] }));
    let res = w.send(Req::get("/api/w/acme/tokens").session(&guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Guests cannot do that");
    w.drop().await;
}

#[tokio::test]
async fn apply_project_scope_filters_queries() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    for (id, key) in [("pj_1", "ONE"), ("pj_2", "TWO")] {
        w.db()
            .execute_unprepared(&format!(
                r#"INSERT INTO projects (id, "workspaceId", name, key) VALUES ('{id}', 'ws_acme', '{id}', '{key}')"#
            ))
            .await
            .unwrap();
    }
    for (n, project) in [(1, "'pj_1'"), (2, "'pj_2'"), (3, "NULL")] {
        w.db()
            .execute_unprepared(&format!(
                r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, "projectId")
                   VALUES ('in_{n}', 'ws_acme', 'T-{n}', {n}, 'bug', 't', {project})"#
            ))
            .await
            .unwrap();
    }
    let db = w.db();
    let ids = move |access: Option<Value>| async move {
        let access = access.map(|v| Arc::new(serde_json::from_value::<MemberAccess>(v).unwrap()));
        with_access(access, async {
            apply_project_scope(issues::Entity::find(), issues::Column::ProjectId)
                .select_only()
                .column(issues::Column::Id)
                .order_by_asc(issues::Column::Id)
                .into_tuple::<String>()
                .all(db)
                .await
                .unwrap()
        })
        .await
    };
    assert_eq!(ids(None).await, ["in_1", "in_2", "in_3"]);
    let scoped = |ids: &[&str], unassigned: bool| {
        Some(
            json!({ "projects": { "all": false, "projectIds": ids }, "includeUnassigned": unassigned, "grants": [] }),
        )
    };
    assert_eq!(ids(scoped(&["pj_1"], false)).await, ["in_1"]);
    assert_eq!(ids(scoped(&["pj_1"], true)).await, ["in_1", "in_3"]);
    assert_eq!(ids(scoped(&[], true)).await, ["in_3"]);
    assert!(ids(scoped(&[], false)).await.is_empty());
    w.drop().await;
}
