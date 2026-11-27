//! `/api/auth/*` against a real database: `server/test/auth.e2e-spec.ts` and the introspection
//! cases of `token-permissions.e2e-spec.ts`.

mod common;

use axum::http::StatusCode;
use sea_orm::{ConnectionTrait, EntityTrait};
use serde_json::json;
use trama_contracts::roles::TokenScope;
use trama_entities::{memberships, sessions, workspaces};

use common::{Req, Tok, World, agent, member, session, user, workspace};

#[tokio::test]
async fn signup_sets_the_session_cookie_and_creates_the_personal_workspace() {
    let Some(w) = World::new().await else { return };
    let signup = |email: &str| {
        Req::post("/api/auth/signup")
            .header("user-agent", "agent/1")
            .json(json!({ "name": "  Ada Lovelace ", "email": email, "password": "password123" }))
    };
    // stored lower-cased (`@IsEmail` refuses surrounding spaces before the trim could apply)
    let res = w.send(signup("Ada@Test.dev")).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    let user = &res.body["user"];
    assert_eq!(user["name"], "Ada Lovelace");
    assert_eq!(user["email"], "ada@test.dev");
    assert!(user["id"].as_str().unwrap().starts_with("usr_"));
    assert!(user.get("passwordHash").is_none() && user.get("notificationSettings").is_none());
    let personal = &res.body["workspaces"][0];
    assert_eq!(res.body["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(personal["slug"], "ada-lovelace");
    assert_eq!(personal["name"], "Ada Lovelace");
    assert_eq!(personal["personal"], true);
    assert_eq!(personal["role"], "owner");
    assert_eq!(personal["primaryOwnerId"], user["id"]);
    assert!(personal["settings"]["roles"].as_array().unwrap().iter().any(|r| r["id"] == "guest"));

    let cookies = res.set_cookies();
    assert_eq!(cookies.len(), 2);
    assert!(cookies[0].starts_with("trama_session="), "{cookies:?}");
    assert!(cookies[0].contains("; Max-Age=2592000; Path=/; Expires="));
    assert!(cookies[0].ends_with("; HttpOnly; SameSite=Lax"));
    assert!(cookies[1].starts_with("nabla_session=; Path=/; Expires=Thu, 01 Jan 1970"));

    // the stored session is the sha256 of the cookie, with the user agent
    let rows = sessions::Entity::find().all(w.db()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].user_agent.as_deref(), Some("agent/1"));
    assert_ne!(cookies[0].split(';').next().unwrap(), format!("trama_session={}", rows[0].id));

    let again = w.send(signup("ADA@TEST.DEV")).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(
        again.body,
        json!({ "statusCode": 409, "message": "Email already registered", "error": "Conflict" })
    );

    // a second person with the same name gets the next free slug
    let other = w.send(signup("grace@test.dev")).await;
    assert_eq!(other.body["workspaces"][0]["slug"], "ada-lovelace-2");
    w.drop().await;
}

#[tokio::test]
async fn signup_and_login_validate_like_class_validator() {
    let Some(w) = World::new().await else { return };
    let res = w
        .send(
            Req::post("/api/auth/signup")
                .json(json!({ "name": "A", "email": "nope", "password": "short" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.body["message"],
        json!(["email must be an email", "password must be longer than or equal to 8 characters"])
    );
    let res = w.send(Req::post("/api/auth/login").json(json!({}))).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["message"][0], "email must be an email");
    // a public write must still be JSON
    let res = w.send(Req::post("/api/auth/login").raw("text/plain", "email=a")).await;
    assert_eq!(res.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        res.body,
        json!({ "statusCode": 415, "message": "Content-Type must be application/json", "error": "Unsupported Media Type" })
    );
    w.drop().await;
}

#[tokio::test]
async fn login_me_and_logout_round_trip_with_the_cookie_session() {
    let Some(w) = World::new().await else { return };
    // a row hashed by the NestJS server
    let u = user(w.db(), "u_ada").await;
    let wrong = w
        .send(
            Req::post("/api/auth/login")
                .json(json!({ "email": u.email, "password": "wrong-password" })),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        wrong.body,
        json!({ "statusCode": 401, "message": "Invalid email or password", "error": "Unauthorized" })
    );
    let unknown = w
        .send(
            Req::post("/api/auth/login")
                .json(json!({ "email": "who@test.dev", "password": "password123" })),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);

    let login = w
        .send(
            Req::post("/api/auth/login")
                .json(json!({ "email": "U_ADA@test.dev", "password": "password123" })),
        )
        .await;
    assert_eq!(login.status, StatusCode::OK, "{}", login.body);
    // the account predates personal workspaces: login creates one
    assert_eq!(login.body["workspaces"][0]["personal"], true);
    assert_eq!(login.body["workspaces"][0]["slug"], "user-u-ada");
    let cookie = login.cookie_header();

    let me = w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["user"]["email"], "u_ada@test.dev");

    // logging in again does not create a second personal workspace
    let again = w
        .send(
            Req::post("/api/auth/login")
                .json(json!({ "email": "u_ada@test.dev", "password": "password123" })),
        )
        .await;
    assert_eq!(again.body["workspaces"].as_array().unwrap().len(), 1);

    // logout is a write: it needs the CSRF header
    let csrf = w.send(Req::post("/api/auth/logout").header("cookie", &cookie)).await;
    assert_eq!(csrf.status, StatusCode::FORBIDDEN);
    assert_eq!(csrf.message(), "Missing X-Requested-With or X-Client-Id header");

    let logout = w
        .send(
            Req::post("/api/auth/logout").header("cookie", &cookie).header("x-requested-with", "x"),
        )
        .await;
    assert_eq!(logout.status, StatusCode::NO_CONTENT);
    let cleared = logout.set_cookies().join("\n");
    assert!(cleared.contains(
        "trama_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
    ));
    assert!(cleared.contains("nabla_session=; Path=/"));
    let me = w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    w.drop().await;
}

#[tokio::test]
async fn the_legacy_cookie_name_still_signs_in_and_production_cookies_are_secure() {
    let config = trama_core::Config::from_vars(&[
        ("NODE_ENV", "production"),
        ("TRAMA_ENCRYPTION_KEY", &"a".repeat(64)),
    ]);
    let Some(w) = World::with_config(config).await else { return };
    user(w.db(), "u_old").await;
    let cookie = session(w.db(), "u_old").await.replace("trama_session", "nabla_session");
    let me = w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await;
    assert_eq!(me.status, StatusCode::OK);
    let login = w
        .send(
            Req::post("/api/auth/login")
                .json(json!({ "email": "u_old@test.dev", "password": "password123" })),
        )
        .await;
    assert!(login.set_cookies().iter().all(|c| c.ends_with("; HttpOnly; Secure; SameSite=Lax")));
    w.drop().await;
}

#[tokio::test]
async fn unauthenticated_and_expired_callers_get_401() {
    let Some(w) = World::new().await else { return };
    let res = w.send(Req::get("/api/auth/me")).await;
    assert_eq!(
        res.body,
        json!({ "statusCode": 401, "message": "Authentication required", "error": "Unauthorized" })
    );
    user(w.db(), "u_1").await;
    let cookie = session(w.db(), "u_1").await;
    assert_eq!(
        w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await.status,
        StatusCode::OK
    );
    w.db()
        .execute_unprepared(r#"UPDATE sessions SET "expiresAt" = now() - interval '1 minute'"#)
        .await
        .unwrap();
    assert_eq!(
        w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await.status,
        StatusCode::UNAUTHORIZED
    );
    // the expired row is gone
    assert!(sessions::Entity::find().all(w.db()).await.unwrap().is_empty());
    w.drop().await;
}

#[tokio::test]
async fn me_and_token_introspection_for_api_tokens() {
    let Some(w) = World::new().await else { return };
    user(w.db(), "u_1").await;
    workspace(w.db(), "alpha").await;
    workspace(w.db(), "beta").await;
    member(w.db(), "ws_alpha", "u_1", "owner", None).await;
    member(w.db(), "ws_beta", "u_1", "member", None).await;

    // a session sees every workspace, oldest first, with the role
    let cookie = session(w.db(), "u_1").await;
    let me = w.send(Req::get("/api/auth/me").header("cookie", &cookie)).await;
    let slugs: Vec<_> = me.body["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["slug"].clone(), w["role"].clone()))
        .collect();
    assert_eq!(slugs, [(json!("alpha"), json!("owner")), (json!("beta"), json!("member"))]);
    // a token only learns about its own workspace
    let (_, secret) = Tok::user("ws_beta", "u_1", TokenScope::Write).mint(w.db()).await;
    let me = w.send(Req::get("/api/auth/me").bearer(&secret)).await;
    assert_eq!(me.body["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(me.body["workspaces"][0]["slug"], "beta");

    // introspection is for tokens only
    let res = w.send(Req::get("/api/auth/token").header("cookie", &cookie)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Call this endpoint with an API token");

    let intro = w.send(Req::get("/api/auth/token").bearer(&secret)).await;
    assert_eq!(intro.status, StatusCode::OK);
    assert_eq!(intro.body["workspace"], json!({ "id": "ws_beta", "slug": "beta", "name": "BETA" }));
    assert_eq!(intro.body["actor"], json!({ "type": "user", "id": "u_1" }));
    assert_eq!(intro.body["permissions"].as_array().unwrap().len(), 42);
    let token = &intro.body["token"];
    assert_eq!(token["scope"], "write");
    assert!(token.get("tokenHash").is_none() && token.get("createdByUserId").is_none());
    assert!(token.get("permissions").is_none() && token.get("expiresAt").is_none());
    assert!(token["lastUsedAt"].is_string());
    assert!(!intro.body.to_string().contains(&secret));

    let (_, read) = Tok::user("ws_beta", "u_1", TokenScope::Read).mint(w.db()).await;
    let perms = w.send(Req::get("/api/auth/token").bearer(&read)).await.body["permissions"].clone();
    assert_eq!(perms.as_array().unwrap().len(), 17);
    assert!(perms.as_array().unwrap().iter().all(|p| p.as_str().unwrap().ends_with(":read")));

    // custom tokens: their list and limits; other account routes stay closed
    let (_, custom) = Tok::custom("ws_beta", "u_1", &["search:read"])
        .limits(json!({ "writesPerDay": 5 }))
        .mint(w.db())
        .await;
    let intro = w.send(Req::get("/api/auth/token").bearer(&custom)).await;
    assert_eq!(intro.status, StatusCode::OK);
    assert_eq!(intro.body["permissions"], json!(["search:read"]));
    assert_eq!(
        intro.body["token"]["limits"],
        json!({ "requestsPerMinute": 600, "writesPerMinute": 60, "writesPerDay": 5 })
    );
    for path in ["/api/workspaces", "/api/auth/me"] {
        let res = w.send(Req::get(path).bearer(&custom)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(res.message(), "This route is not available to custom API tokens");
    }

    // agents: no user-only endpoints
    agent(w.db(), "ws_beta", "ag_1").await;
    let (_, bot) = Tok::agent("ws_beta", "ag_1", TokenScope::Write).mint(w.db()).await;
    let res = w.send(Req::get("/api/auth/me").bearer(&bot)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This endpoint requires a user, not an agent token");
    let intro = w.send(Req::get("/api/auth/token").bearer(&bot)).await;
    assert_eq!(intro.body["actor"], json!({ "type": "agent", "id": "ag_1" }));

    // the workspace rows are untouched by introspection
    assert_eq!(workspaces::Entity::find().all(w.db()).await.unwrap().len(), 2);
    assert_eq!(memberships::Entity::find().all(w.db()).await.unwrap().len(), 2);
    w.drop().await;
}

#[tokio::test]
async fn an_unregistered_method_is_a_nest_404() {
    let Some(w) = World::new().await else { return };
    let res = w.send(Req::new(axum::http::Method::PUT, "/api/auth/me")).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(
        res.body,
        json!({ "statusCode": 404, "message": "Cannot PUT /api/auth/me", "error": "Not Found" })
    );
    w.drop().await;
}
