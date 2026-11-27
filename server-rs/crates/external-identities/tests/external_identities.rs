//! The external identities routes and service against a real database and the real access guard:
//! `external-identities.service.spec.ts` and the endpoint and resolver parts of
//! `server/test/external-identities.e2e-spec.ts`. The e2e case about inbound review requests
//! drives the GitHub webhook and the artifact linker, which live in the integrations crate; it
//! uses the resolver exercised here.

mod common;

use axum::http::StatusCode;
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use trama_contracts::identity::{
    EXTERNAL_IDENTITIES_MAX, ExternalIdentityInput, ExternalIdentityProvider,
};
use trama_entities::external_identities;
use trama_external_identities::service::{self, ResolveOptions};

use common::{Req, Res, World, agent_token, member, signed_up, sql, user, workspace};

const URL: &str = "/api/me/external-identities";

struct Fx {
    w: World,
    ada: String,
    bob: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    let ada = signed_up(w.db(), "ada").await;
    let bob = signed_up(w.db(), "bob").await;
    Some(Fx { w, ada, bob })
}

impl Fx {
    async fn post(&self, cookie: &str, body: Value) -> Res {
        self.w.send(Req::post(URL).session(cookie).json(body)).await
    }
    async fn list(&self, cookie: &str) -> Vec<Value> {
        let res = self.w.send(Req::get(URL).session(cookie)).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body.as_array().unwrap().clone()
    }
}

fn input(
    provider: ExternalIdentityProvider,
    host: Option<&str>,
    login: &str,
) -> ExternalIdentityInput {
    ExternalIdentityInput { provider, host: host.map(ToOwned::to_owned), login: login.to_owned() }
}

const NONE: ResolveOptions = ResolveOptions { verified_only: false };

// ───────────────────────────── endpoints ─────────────────────────────

#[tokio::test]
async fn adds_lists_and_removes_the_logins_of_the_current_person_only() {
    let Some(f) = fx().await else { return };
    let res = f.post(&f.ada, json!({ "provider": "github", "login": "@Ada-GH" })).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let added = res.body;
    assert_eq!(added["provider"], "github");
    assert_eq!(added["host"], "github.com");
    assert_eq!(added["login"], "Ada-GH");
    assert_eq!(added["source"], "manual");
    assert_eq!(added["userId"], "ada");
    assert!(added["id"].as_str().unwrap().starts_with("xid_"));
    assert!(added["createdAt"].as_str().unwrap().ends_with('Z'));

    let id = added["id"].as_str().unwrap();
    assert_eq!(
        f.list(&f.ada).await.iter().map(|i| i["id"].clone()).collect::<Vec<_>>(),
        [json!(id)]
    );
    assert!(f.list(&f.bob).await.is_empty());

    // someone else's identity looks like it does not exist
    let res = f.w.send(Req::delete(&format!("{URL}/{id}")).session(&f.bob)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), format!("External identity \"{id}\" not found"));
    assert_eq!(f.list(&f.ada).await.len(), 1);

    let gone = f.w.send(Req::delete(&format!("{URL}/{id}")).session(&f.ada)).await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT);
    assert_eq!(
        f.w.send(Req::delete(&format!("{URL}/{id}")).session(&f.ada)).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(f.list(&f.ada).await.is_empty());
    f.w.drop().await;
}

#[tokio::test]
async fn answers_409_for_a_login_another_person_already_has_however_it_is_spelled() {
    let Some(f) = fx().await else { return };
    let login = "Shared-Login";
    assert_eq!(
        f.post(&f.ada, json!({ "provider": "github", "login": login })).await.status,
        StatusCode::CREATED
    );

    let res = f.post(&f.bob, json!({ "provider": "github", "login": login.to_uppercase() })).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.message(), "This login is already linked to another account");
    let res = f
        .post(
            &f.bob,
            json!({ "provider": "github", "host": "https://GitHub.com/", "login": format!("@{login}") }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    // the owner cannot add it twice either
    let res = f.post(&f.ada, json!({ "provider": "github", "login": login.to_lowercase() })).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.message(), "You already have this identity");
    // the same name on another provider or host is another identity
    for body in [
        json!({ "provider": "gitlab", "login": login }),
        json!({ "provider": "github", "host": "ghe.acme.dev", "login": login }),
    ] {
        assert_eq!(f.post(&f.bob, body).await.status, StatusCode::CREATED);
    }
    f.w.drop().await;
}

#[tokio::test]
async fn validates_the_input_and_needs_a_signed_in_person() {
    let Some(f) = fx().await else { return };
    for body in [
        json!({ "provider": "svn", "login": "x" }),
        json!({ "provider": "github" }),
        json!({ "provider": "github", "login": "has space" }),
        json!({ "provider": "github", "host": "not a host", "login": "x" }),
        // Jira needs a site
        json!({ "provider": "jira", "login": "x" }),
    ] {
        let res = f.post(&f.ada, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let created = f
        .post(&f.ada, json!({ "provider": "jira", "host": "acme.atlassian.net", "login": "x" }))
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(created.body["host"], "acme.atlassian.net");
    assert_eq!(f.w.send(Req::get(URL)).await.status, StatusCode::UNAUTHORIZED);
    f.w.drop().await;
}

#[tokio::test]
async fn reports_every_failed_body_rule_with_class_validators_wording() {
    let Some(f) = fx().await else { return };
    let providers =
        "provider must be one of the following values: github, gitlab, bitbucket, linear, jira";
    let res = f.post(&f.ada, json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        format!(
            "{providers}; login must be shorter than or equal to 101 characters; login must be longer than or equal to 1 characters; login must be a string"
        )
    );
    assert_eq!(
        f.post(&f.ada, json!({ "provider": "github", "login": "" })).await.message(),
        "login must be longer than or equal to 1 characters"
    );
    assert_eq!(
        f.post(&f.ada, json!({ "provider": "github", "login": "x".repeat(102) })).await.message(),
        "login must be shorter than or equal to 101 characters"
    );
    assert_eq!(
        f.post(&f.ada, json!({ "provider": "github", "login": "x", "host": 5 })).await.message(),
        "host must be shorter than or equal to 300 characters; host must be a string"
    );
    assert_eq!(
        f.post(&f.ada, json!({ "provider": "github", "login": "x", "host": "h".repeat(301) }))
            .await
            .message(),
        "host must be shorter than or equal to 300 characters"
    );
    // a null or empty host is the provider's public host
    for host in [Value::Null, json!("")] {
        let res = f
            .post(&f.ada, json!({ "provider": "github", "login": "nullhost", "host": host }))
            .await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        assert_eq!(res.body["host"], "github.com");
        f.w.send(
            Req::delete(&format!("{URL}/{}", res.body["id"].as_str().unwrap())).session(&f.ada),
        )
        .await;
    }
    // service messages
    let message = |body: Value| {
        let (f, ada) = (&f, f.ada.clone());
        async move { f.post(&ada, body).await.message() }
    };
    assert_eq!(
        message(json!({ "provider": "github", "login": "a b" })).await,
        "login is not a valid login"
    );
    assert_eq!(
        message(json!({ "provider": "github", "host": "no host", "login": "ada" })).await,
        "host is not a valid host name"
    );
    assert_eq!(
        message(json!({ "provider": "jira", "login": "ada" })).await,
        "host is required for this provider"
    );
    // 101 characters pass the body check and fail the login rule
    assert_eq!(
        message(json!({ "provider": "github", "login": "x".repeat(101) })).await,
        "login is not a valid login"
    );
    f.w.drop().await;
}

#[tokio::test]
async fn caps_the_list_per_account() {
    let Some(f) = fx().await else { return };
    for n in 0..EXTERNAL_IDENTITIES_MAX {
        let res = f.post(&f.ada, json!({ "provider": "github", "login": format!("l{n}") })).await;
        assert_eq!(res.status, StatusCode::CREATED, "{n}");
    }
    let res = f.post(&f.ada, json!({ "provider": "github", "login": "more" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "At most 20 external identities per account");
    // oldest first
    let logins: Vec<String> =
        f.list(&f.ada).await.iter().map(|i| i["login"].as_str().unwrap().to_owned()).collect();
    assert_eq!(logins, (0..EXTERNAL_IDENTITIES_MAX).map(|n| format!("l{n}")).collect::<Vec<_>>());
    f.w.drop().await;
}

#[tokio::test]
async fn agent_tokens_have_no_identities() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "acme").await;
    member(f.w.db(), "ws_acme", "ada", "owner").await;
    let secret = agent_token(f.w.db(), "ws_acme", "ag_1").await;
    for req in [
        Req::get(URL),
        Req::post(URL).json(json!({ "provider": "github", "login": "x" })),
        Req::delete(&format!("{URL}/xid_1")),
    ] {
        let res = f.w.send(req.bearer(&secret)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.message(), "This endpoint requires a user, not an agent token");
    }
    f.w.drop().await;
}

// ───────────────────────────── the service ─────────────────────────────

#[tokio::test]
async fn add_stores_a_manual_identity_with_the_normalized_host() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let made = service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "@Ada"))
        .await
        .unwrap();
    assert_eq!(
        (made.user_id.as_str(), made.provider.as_str(), made.host.as_str(), made.login.as_str()),
        ("ada", "github", "github.com", "Ada")
    );
    assert_eq!(made.source, "manual");
    let made = service::add(
        db,
        "ada",
        &input(ExternalIdentityProvider::Gitlab, Some(" https://GitLab.Acme.dev:8443/x "), "ada"),
    )
    .await
    .unwrap();
    assert_eq!(made.host, "gitlab.acme.dev:8443");
    assert_eq!(service::list(db, "ada").await.unwrap().len(), 2);
    f.w.drop().await;
}

#[tokio::test]
async fn add_refuses_a_login_another_account_has_and_a_duplicate_of_its_own() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    service::add(db, "bob", &input(ExternalIdentityProvider::Github, None, "Ada")).await.unwrap();
    for (host, login) in [(None, "ADA"), (Some("https://GITHUB.com"), "ada")] {
        let err = service::add(db, "ada", &input(ExternalIdentityProvider::Github, host, login))
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::CONFLICT);
        assert!(err.to_string().contains("another account"), "{err}");
    }
    service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "mine")).await.unwrap();
    let err = service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "mine"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already have"), "{err}");
    // the same login on another host is allowed
    let other = service::add(
        db,
        "ada",
        &input(ExternalIdentityProvider::Github, Some("ghe.acme.dev"), "mine"),
    )
    .await
    .unwrap();
    assert_eq!(other.host, "ghe.acme.dev");
    f.w.drop().await;
}

#[tokio::test]
async fn add_validates_the_input_and_caps_the_list() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let bad = |provider, host: Option<&str>, login: &str| {
        let body = input(provider, host, login);
        async move { service::add(db, "ada", &body).await.unwrap_err() }
    };
    let err = bad(ExternalIdentityProvider::Jira, None, "ada").await;
    assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    assert!(err.to_string().contains("host is required"));
    assert!(
        bad(ExternalIdentityProvider::Github, None, "a b")
            .await
            .to_string()
            .contains("valid login")
    );
    assert!(
        bad(ExternalIdentityProvider::Github, Some("no host"), "ada")
            .await
            .to_string()
            .contains("valid host")
    );
    for n in 0..EXTERNAL_IDENTITIES_MAX {
        service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, &format!("l{n}")))
            .await
            .unwrap();
    }
    assert!(
        bad(ExternalIdentityProvider::Github, None, "more").await.to_string().contains("At most")
    );
    f.w.drop().await;
}

#[tokio::test]
async fn remove_deletes_your_own_identity_and_treats_someone_elses_as_missing() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let mine = service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "ada"))
        .await
        .unwrap();
    let theirs = service::add(db, "bob", &input(ExternalIdentityProvider::Github, None, "bob"))
        .await
        .unwrap();
    let err = service::remove(db, "ada", &theirs.id).await.unwrap_err();
    assert_eq!(err.status_code(), StatusCode::NOT_FOUND);
    service::remove(db, "ada", &mine.id).await.unwrap();
    let left: Vec<String> = external_identities::Entity::find()
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(left, [theirs.id]);
    f.w.drop().await;
}

#[tokio::test]
async fn ensure_from_connection_adds_the_login_once_as_a_connection_identity() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let a = service::ensure_from_connection(
        db,
        "ada",
        "github",
        Some("https://github.com"),
        Some("Ada"),
    )
    .await
    .unwrap()
    .unwrap();
    let b = service::ensure_from_connection(db, "ada", "github", None, Some("ada"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (a.source.as_str(), a.login.as_str(), a.host.as_str()),
        ("connection", "Ada", "github.com")
    );
    assert_eq!(a.id, b.id);
    assert_eq!(external_identities::Entity::find().all(db).await.unwrap().len(), 1);
    f.w.drop().await;
}

#[tokio::test]
async fn ensure_from_connection_promotes_a_hand_typed_identity_of_the_same_person() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let typed = service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "ada"))
        .await
        .unwrap();
    let out = service::ensure_from_connection(db, "ada", "github", None, Some("ada"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!((out.id.as_str(), out.source.as_str()), (typed.id.as_str(), "connection"));
    let stored = external_identities::Entity::find_by_id(&typed.id).one(db).await.unwrap().unwrap();
    assert_eq!(stored.source, "connection");
    f.w.drop().await;
}

#[tokio::test]
async fn ensure_from_connection_never_steals_nor_fails() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    service::add(db, "bob", &input(ExternalIdentityProvider::Github, None, "ada")).await.unwrap();
    assert!(
        service::ensure_from_connection(db, "ada", "github", None, Some("ada"))
            .await
            .unwrap()
            .is_none()
    );
    let rows = external_identities::Entity::find().all(db).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].user_id, "bob");

    // logins it cannot use
    for (provider, login) in
        [("github", Some("")), ("github", None), ("jira", Some("ada")), ("svn", Some("x"))]
    {
        assert!(
            service::ensure_from_connection(db, "ada", provider, None, login)
                .await
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(external_identities::Entity::find().all(db).await.unwrap().len(), 1);

    // a full list still lets the connection be created
    for n in 0..EXTERNAL_IDENTITIES_MAX {
        service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, &format!("l{n}")))
            .await
            .unwrap();
    }
    assert!(
        service::ensure_from_connection(db, "ada", "github", None, Some("one-more"))
            .await
            .unwrap()
            .is_none()
    );
    f.w.drop().await;
}

/// Ada has a connection login and a typed one, Bob one on GitLab.
async fn resolver_fixture(f: &Fx) {
    let db = f.w.db();
    service::ensure_from_connection(db, "ada", "github", None, Some("ada-work")).await.unwrap();
    service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "ada-home"))
        .await
        .unwrap();
    service::add(db, "bob", &input(ExternalIdentityProvider::Gitlab, None, "bob")).await.unwrap();
}

#[tokio::test]
async fn resolves_every_login_of_one_person_to_that_person() {
    let Some(f) = fx().await else { return };
    resolver_fixture(&f).await;
    let db = f.w.db();
    let resolve =
        |provider: &'static str, host: Option<&'static str>, login: Option<&'static str>| {
            service::resolve_user_by_login(db, provider, host, login, NONE)
        };
    assert_eq!(resolve("github", None, Some("ADA-WORK")).await.unwrap().as_deref(), Some("ada"));
    assert_eq!(
        resolve("github", Some("github.com"), Some("@ada-home")).await.unwrap().as_deref(),
        Some("ada")
    );
    assert_eq!(resolve("gitlab", None, Some("bob")).await.unwrap().as_deref(), Some("bob"));

    // another provider, another host, a stranger, nothing
    assert_eq!(resolve("gitlab", None, Some("ada-work")).await.unwrap(), None);
    assert_eq!(resolve("github", Some("ghe.acme.dev"), Some("ada-work")).await.unwrap(), None);
    assert_eq!(resolve("github", None, Some("mallory")).await.unwrap(), None);
    assert_eq!(resolve("github", None, None).await.unwrap(), None);
    assert_eq!(resolve("svn", None, Some("ada-work")).await.unwrap(), None);
    f.w.drop().await;
}

#[tokio::test]
async fn can_be_limited_to_identities_proven_by_a_connection() {
    let Some(f) = fx().await else { return };
    resolver_fixture(&f).await;
    let db = f.w.db();
    let verified = |login: &'static str| {
        service::resolve_user_by_login(db, "github", None, Some(login), ResolveOptions::VERIFIED)
    };
    assert_eq!(verified("ada-work").await.unwrap().as_deref(), Some("ada"));
    assert_eq!(verified("ada-home").await.unwrap(), None);
    f.w.drop().await;
}

#[tokio::test]
async fn member_lookups_only_hold_accounts_of_the_workspace() {
    let Some(f) = fx().await else { return };
    resolver_fixture(&f).await;
    let db = f.w.db();
    workspace(db, "acme").await;
    member(db, "ws_acme", "ada", "member").await;
    // bob has a github login too, but is not a member
    service::add(db, "bob", &input(ExternalIdentityProvider::Github, None, "bob-gh"))
        .await
        .unwrap();

    // lower-cased, de-duplicated logins of one host; unusable ones are skipped
    let found = service::resolve_members_by_logins(
        db,
        "ws_acme",
        "github",
        None,
        &["Ada-Work", "ADA-WORK", "ada-home", "bad login", "bob-gh"],
        NONE,
    )
    .await
    .unwrap();
    let mut entries: Vec<(&str, &str)> =
        found.iter().map(|(l, u)| (l.as_str(), u.as_str())).collect();
    entries.sort_unstable();
    assert_eq!(entries, [("ada-home", "ada"), ("ada-work", "ada")]);

    let verified = service::resolve_members_by_logins(
        db,
        "ws_acme",
        "github",
        None,
        &["ada-work", "ada-home"],
        ResolveOptions::VERIFIED,
    )
    .await
    .unwrap();
    assert_eq!(verified.keys().collect::<Vec<_>>(), ["ada-work"]);

    assert!(
        service::resolve_members_by_logins::<_, &str>(db, "ws_acme", "github", None, &[], NONE)
            .await
            .unwrap()
            .is_empty()
    );

    // one login to a member, or to nobody
    assert_eq!(
        service::resolve_member_by_login(db, "ws_acme", "github", None, Some("Ada-Work"), NONE)
            .await
            .unwrap()
            .as_deref(),
        Some("ada")
    );
    assert_eq!(
        service::resolve_member_by_login(db, "ws_acme", "github", None, Some("bob-gh"), NONE)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        service::resolve_member_by_login(db, "ws_acme", "github", None, Some("nobody"), NONE)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        service::resolve_member_by_login(db, "ws_acme", "github", None, None, NONE).await.unwrap(),
        None
    );
    assert_eq!(
        service::resolve_member_by_login(db, "ws_acme", "github", None, Some(""), NONE)
            .await
            .unwrap(),
        None
    );
    // another workspace has no such member
    workspace(db, "globex").await;
    user(db, "carol").await;
    member(db, "ws_globex", "carol", "member").await;
    assert_eq!(
        service::resolve_member_by_login(db, "ws_globex", "github", None, Some("ada-work"), NONE)
            .await
            .unwrap(),
        None
    );
    f.w.drop().await;
}

#[tokio::test]
async fn logins_of_filters_by_provider_and_host() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    service::add(db, "ada", &input(ExternalIdentityProvider::Github, None, "a1")).await.unwrap();
    service::add(db, "ada", &input(ExternalIdentityProvider::Github, Some("ghe.acme.dev"), "a2"))
        .await
        .unwrap();
    service::add(db, "ada", &input(ExternalIdentityProvider::Gitlab, None, "a3")).await.unwrap();
    let names = |rows: Vec<external_identities::Model>| -> Vec<String> {
        rows.into_iter().map(|r| r.login).collect()
    };
    assert_eq!(names(service::logins_of(db, "ada", None, None).await.unwrap()), ["a1", "a2", "a3"]);
    assert_eq!(
        names(service::logins_of(db, "ada", Some("github"), None).await.unwrap()),
        ["a1", "a2"]
    );
    assert_eq!(
        names(
            service::logins_of(db, "ada", Some("github"), Some("https://GHE.acme.dev/"))
                .await
                .unwrap()
        ),
        ["a2"]
    );
    assert!(service::logins_of(db, "bob", None, None).await.unwrap().is_empty());
    // a login that belongs to a deleted user goes with it (the table cascades)
    sql(db, "DELETE FROM users WHERE id = 'ada'").await;
    assert!(service::logins_of(db, "ada", None, None).await.unwrap().is_empty());
    f.w.drop().await;
}

// ───────────────────────────── unit ─────────────────────────────

#[test]
fn identity_key_defaults_the_host_from_the_provider_and_jira_has_none() {
    use trama_external_identities::{IdentityKey, identity_key};
    assert_eq!(
        identity_key("gitlab", None, Some("ada")),
        Some(IdentityKey {
            provider: ExternalIdentityProvider::Gitlab,
            host: "gitlab.com".into(),
            login: "ada".into()
        })
    );
    assert_eq!(
        identity_key("github", Some("https://ghe.acme.dev/"), Some("@ada")),
        Some(IdentityKey {
            provider: ExternalIdentityProvider::Github,
            host: "ghe.acme.dev".into(),
            login: "ada".into()
        })
    );
    // a blank host is the public one
    assert_eq!(identity_key("github", Some("  "), Some("ada")).unwrap().host, "github.com");
    assert_eq!(identity_key("bitbucket", None, Some("ada")).unwrap().host, "bitbucket.org");
    assert_eq!(identity_key("linear", None, Some("ada")).unwrap().host, "linear.app");
    assert_eq!(identity_key("jira", None, Some("ada")), None);
    assert!(identity_key("jira", Some("acme.atlassian.net"), Some("ada")).is_some());
    assert_eq!(identity_key("svn", Some("x.dev"), Some("ada")), None);
    assert_eq!(identity_key("github", Some("not a host"), Some("ada")), None);
    assert_eq!(identity_key("github", None, Some("")), None);
    assert_eq!(identity_key("github", None, None), None);
    assert_eq!(identity_key("github", None, Some("a b")), None);
}
