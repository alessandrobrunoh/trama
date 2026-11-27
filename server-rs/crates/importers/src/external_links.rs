//! Links from an existing Trama issue to an issue in GitHub or Linear, and the read-only mirror
//! of its status (`importers/external-links.service.ts` and `IssueExternalRefController`).
//!
//! | Route | Notes |
//! | --- | --- |
//! | `POST /w/{slug}/tasks/{idOrKey}/external-ref` | `{ url }`; reads the external issue and links it (replacing an earlier link); 200 the issue |
//! | `POST /w/{slug}/tasks/{idOrKey}/external-ref/refresh` | re-reads the external status; the Trama status never changes; 200 the issue |
//! | `DELETE /w/{slug}/tasks/{idOrKey}/external-ref` | 200 the issue |
//!
//! Same permission as editing the issue (the member-access guard decides, as for every task
//! route).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use trama_auth::{Actor, Ctx, Gate, Routes};
use trama_contracts::common::ActorRef;
use trama_contracts::imports::{ExternalProvider, ExternalRef, ExternalRefOrigin, ImportSource};
use trama_contracts::issues::Issue;
use trama_core::validation::Checks;
use trama_core::{ApiJson, AppError, AppState};
use trama_integrations::Http;
use trama_issues::service::ExternalRefRefresh;

use crate::adapter::{create_adapter, provider_failure};
use crate::credentials;
use crate::mapping::{external_ref_of, github_issue_id, parse_external_url};
use crate::types::ExternalIssue;

/// The three external-ref routes of a task.
pub fn routes() -> Routes {
    Routes::new()
        .post("/w/{slug}/tasks/{idOrKey}/external-ref", Gate::authenticated(), link_handler)
        .post(
            "/w/{slug}/tasks/{idOrKey}/external-ref/refresh",
            Gate::authenticated(),
            refresh_handler,
        )
        .delete("/w/{slug}/tasks/{idOrKey}/external-ref", Gate::authenticated(), unlink_handler)
}

#[derive(Deserialize)]
struct LinkExternalBody {
    #[serde(default)]
    url: Value,
}

async fn link_handler(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<LinkExternalBody>,
) -> Result<Json<Issue>, AppError> {
    // `@IsString() @MinLength(8) @MaxLength(500) url`
    let mut checks = Checks::new();
    match body.url.as_str() {
        Some(url) => {
            checks.max_length("url", url, 500).min_length("url", url, 8);
        }
        None => {
            checks
                .check(false, "url must be shorter than or equal to 500 characters")
                .check(false, "url must be longer than or equal to 8 characters")
                .check(false, "url must be a string");
        }
    }
    checks.finish()?;
    let url = body.url.as_str().unwrap_or_default();
    Ok(Json(link(&state, &ctx.workspace.id, &actor, &id, url).await?))
}

async fn refresh_handler(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Issue>, AppError> {
    Ok(Json(refresh(&state, &ctx.workspace.id, &id).await?))
}

async fn unlink_handler(
    ctx: Ctx,
    Actor(actor): Actor,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<Issue>, AppError> {
    Ok(Json(unlink(&state, &ctx.workspace.id, &actor, &id).await?))
}

/// What to read at the tracker: GitHub needs the repository, Linear only the id.
struct Lookup<'a> {
    repository: Option<String>,
    id: &'a str,
}

/// Reads one issue at `host` with the credential the workspace configured for it.
async fn read(
    state: &AppState,
    workspace_id: &str,
    provider: ExternalProvider,
    host: &str,
    lookup: Lookup<'_>,
) -> Result<ExternalIssue, AppError> {
    let label = provider.label();
    let cred = credentials::for_host(state, workspace_id, provider, host).await?;
    let source = ImportSource { repository: lookup.repository, team_ids: None };
    let failure = match create_adapter(Http::of(state), provider, &cred, &source) {
        Ok(adapter) => match adapter.get_issue(lookup.id).await {
            Ok(issue) => return Ok(issue),
            Err(e) => provider_failure(label, &e, &[cred.token.as_deref()]),
        },
        Err(e) => e,
    };
    if cred.token.is_none()
        && provider == ExternalProvider::Github
        && failure.status_code() == StatusCode::BAD_REQUEST
    {
        return Err(AppError::bad_request(format!(
            "{label} could not read that issue without a token. If the repository is private, add a credential under Settings → Import."
        )));
    }
    Err(failure)
}

/// The link-origin reference for the issue at `url`.
async fn reference_of(
    state: &AppState,
    workspace_id: &str,
    url: &str,
) -> Result<ExternalRef, AppError> {
    let parsed = parse_external_url(url).ok_or_else(|| {
        AppError::bad_request(
            "Paste the URL of a GitHub issue (https://github.com/owner/repo/issues/12) or a Linear issue",
        )
    })?;
    let (repository, id) = match parsed.provider {
        ExternalProvider::Github => {
            let repository = parsed.repository.clone().unwrap_or_default();
            let id = github_issue_id(&repository, parsed.number.unwrap_or_default());
            (Some(repository), id)
        }
        ExternalProvider::Linear => (None, parsed.identifier.clone().unwrap_or_default()),
    };
    let external =
        read(state, workspace_id, parsed.provider, &parsed.host, Lookup { repository, id: &id })
            .await?;
    Ok(external_ref_of(parsed.provider, &external, ExternalRefOrigin::Link, Utc::now()))
}

/// Reads the external issue behind `url` and links the issue to it (replacing an earlier link).
///
/// # Errors
///
/// 400 for a URL that is neither GitHub nor Linear, for a host without a configured credential
/// or one the tracker rejects; 404 for an unknown issue; 409 when another issue carries the
/// external one; 429 / 502 for a tracker that is rate limiting or unreachable.
pub async fn link(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id_or_key: &str,
    url: &str,
) -> Result<Issue, AppError> {
    let reference = reference_of(state, workspace_id, url).await?;
    trama_issues::service::set_external_ref(state, workspace_id, actor, id_or_key, Some(&reference))
        .await
}

/// Re-reads the external status. The Trama status is never touched.
///
/// # Errors
///
/// 404 for an unknown issue; 400 `This issue is not linked to an external issue`, or the
/// tracker's failure as for [`link`].
pub async fn refresh(
    state: &AppState,
    workspace_id: &str,
    id_or_key: &str,
) -> Result<Issue, AppError> {
    let row = trama_issues::service::get(&state.db, workspace_id, id_or_key).await?;
    let current: ExternalRef = row
        .external_ref
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| AppError::bad_request("This issue is not linked to an external issue"))?;
    let host = match parse_external_url(&current.url) {
        Some(parsed) => parsed.host,
        None => url::Url::parse(&current.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_lowercase))
            .ok_or_else(|| AppError::internal("The stored external link is not a URL"))?,
    };
    let repository = (current.provider == ExternalProvider::Github).then(|| {
        // `ref.id.slice(0, ref.id.lastIndexOf('#'))`
        current.id.rfind('#').map_or_else(
            || {
                let mut chars = current.id.chars();
                chars.next_back();
                chars.as_str().to_owned()
            },
            |at| current.id[..at].to_owned(),
        )
    });
    let external =
        read(state, workspace_id, current.provider, &host, Lookup { repository, id: &current.id })
            .await?;
    let next = external_ref_of(current.provider, &external, current.origin, Utc::now());
    trama_issues::service::refresh_external_ref(
        state,
        workspace_id,
        id_or_key,
        ExternalRefRefresh {
            state: next.state,
            state_type: next.state_type,
            synced_at: next.synced_at,
            key: next.key,
            url: Some(next.url),
        },
    )
    .await
}

/// Removes the link.
///
/// # Errors
///
/// 404 for an unknown issue.
pub async fn unlink(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    id_or_key: &str,
) -> Result<Issue, AppError> {
    trama_issues::service::set_external_ref(state, workspace_id, actor, id_or_key, None).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::http::Method;
    use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, Set};
    use sea_orm_migration::MigratorTrait;
    use serde_json::json;
    use trama_common::Secrets;
    use trama_contracts::imports::ExternalStateType;
    use trama_contracts::roles::fresh_workspace_roles;
    use trama_core::{Config, testkit::TestDb};
    use trama_entities::{issues, tracker_credentials, workspaces};
    use trama_integrations::{HttpRequest, HttpResponse};

    use super::*;
    use crate::adapter::testing::{Calls, FakeHttp, reply, reply_with};

    const WS: &str = "ws_links";
    const GH_TOKEN: &str = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const LINEAR_KEY: &str = "lin_api_secretsecretsecretsecretsecret12";

    fn gh_issue(state: &str) -> Value {
        json!({
            "number": 12,
            "html_url": "https://github.com/Acme/API/issues/12",
            "title": "Crash",
            "state": state,
            "labels": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
        })
    }

    fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
        req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn actor() -> ActorRef {
        ActorRef::user("usr_me")
    }

    /// A migrated database with a workspace and one issue, `BUG-1`.
    async fn setup(
        route: impl Fn(&HttpRequest) -> Option<HttpResponse> + Send + Sync + 'static,
    ) -> Option<(TestDb, AppState, Calls)> {
        let test = TestDb::create().await?;
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        workspaces::ActiveModel {
            id: Set(WS.into()),
            name: Set("Links".into()),
            slug: Set("links".into()),
            settings: Set(json!({ "roles": fresh_workspace_roles() })),
            personal: Set(false),
            ..Default::default()
        }
        .insert(&test.db)
        .await
        .unwrap();
        test.db
            .execute_unprepared(&format!(
                r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, aliases)
                   VALUES ('iss_1', '{WS}', 'BUG-1', 1, 'bug', 'Crash', 'manual', 'none', 'backlog', '[]')"#
            ))
            .await
            .unwrap();
        let (http, calls) = FakeHttp::new(route);
        let state = AppState::new(
            test.db.clone(),
            Config::from_vars(&[("TRAMA_ENCRYPTION_KEY", "test-links-key")]),
        )
        .with_extension(http);
        Some((test, state, calls))
    }

    async fn credential(
        state: &AppState,
        id: &str,
        provider: &str,
        base_url: Option<&str>,
        token: &str,
    ) {
        tracker_credentials::ActiveModel {
            id: Set(id.into()),
            workspace_id: Set(WS.into()),
            provider: Set(provider.into()),
            account: Set("someone".into()),
            base_url: Set(base_url.map(str::to_owned)),
            secret: Set(Secrets::of(state).unwrap().encrypt(token, &format!("{id}:tracker"))),
            created_by: Set(json!({ "type": "user", "id": "usr_me" })),
            ..Default::default()
        }
        .insert(&state.db)
        .await
        .unwrap();
    }

    async fn stored(state: &AppState) -> issues::Model {
        issues::Entity::find_by_id("iss_1").one(&state.db).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn reads_the_github_issue_behind_the_url_and_stores_a_link_origin_reference() {
        let Some((test, state, calls)) = setup(|_| Some(reply(gh_issue("open")))).await else {
            return;
        };
        let issue =
            link(&state, WS, &actor(), "BUG-1", "https://github.com/Acme/API/issues/12?utm=x")
                .await
                .unwrap();
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].url, "https://api.github.com/repos/Acme/API/issues/12");
            // github.com without a stored credential is read anonymously
            assert_eq!(header(&calls[0], "Authorization"), None);
        }
        let reference = issue.external_ref.unwrap();
        assert_eq!(reference.provider, ExternalProvider::Github);
        assert_eq!(reference.id, "acme/api#12");
        assert_eq!(reference.key.as_deref(), Some("#12"));
        assert_eq!(reference.state.as_deref(), Some("Open"));
        assert_eq!(reference.state_type, Some(ExternalStateType::Open));
        assert_eq!(reference.origin, ExternalRefOrigin::Link);
        assert!(reference.synced_at.is_some());
        let row = stored(&state).await;
        assert_eq!(row.external_ref.unwrap()["id"], "acme/api#12");
        assert_eq!(row.status, "backlog");
        test.drop().await;
    }

    #[tokio::test]
    async fn refuses_a_url_that_is_neither_github_nor_linear_without_calling_anything() {
        let Some((test, state, calls)) = setup(|_| None).await else { return };
        for url in ["https://example.com/a/b", "https://127.0.0.1/private", "not a url"] {
            let err = link(&state, WS, &actor(), "BUG-1", url).await.unwrap_err();
            assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "{url}");
            assert!(err.to_string().contains("Paste the URL of a GitHub issue"), "{err}");
        }
        assert!(calls.lock().unwrap().is_empty());
        test.drop().await;
    }

    #[tokio::test]
    async fn explains_how_to_get_access_when_an_anonymous_read_of_a_private_repository_fails() {
        let Some((test, state, _)) =
            setup(|_| Some(reply_with(404, json!({ "message": "Not Found" }), &[]))).await
        else {
            return;
        };
        let err = link(&state, WS, &actor(), "BUG-1", "https://github.com/acme/private/issues/1")
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(err.to_string().contains("Settings → Import"), "{err}");
        assert!(err.to_string().contains("GitHub Issues could not read that issue"), "{err}");
        test.drop().await;
    }

    #[tokio::test]
    async fn a_failure_with_a_token_names_the_tracker_and_never_leaks_the_token() {
        let Some((test, state, _)) = setup(|_| {
            Some(reply_with(404, json!({ "message": format!("Not Found {GH_TOKEN}") }), &[]))
        })
        .await
        else {
            return;
        };
        credential(&state, "tcr_gh", "github", None, GH_TOKEN).await;
        let err = link(&state, WS, &actor(), "BUG-1", "https://github.com/acme/private/issues/1")
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(err.to_string().contains("GitHub Issues rejected the request"), "{err}");
        assert!(!err.to_string().contains(GH_TOKEN));
        test.drop().await;
    }

    #[tokio::test]
    async fn a_rate_limited_tracker_answers_429() {
        let Some((test, state, _)) = setup(|_| {
            Some(reply_with(429, json!({ "message": "slow down" }), &[("retry-after", "30")]))
        })
        .await
        else {
            return;
        };
        let err = link(&state, WS, &actor(), "BUG-1", "https://github.com/acme/api/issues/1")
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::TOO_MANY_REQUESTS);
        assert!(err.to_string().contains("rate limit reached; try again after"), "{err}");
        test.drop().await;
    }

    #[tokio::test]
    async fn refreshes_by_the_stored_id_and_keeps_the_trama_status_out_of_it() {
        let closed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed);
        let Some((test, state, calls)) = setup(move |_| {
            let state = if flag.load(Ordering::Relaxed) { "closed" } else { "open" };
            Some(reply(gh_issue(state)))
        })
        .await
        else {
            return;
        };
        link(&state, WS, &actor(), "BUG-1", "https://github.com/Acme/API/issues/12").await.unwrap();
        closed.store(true, Ordering::Relaxed);
        let issue = refresh(&state, WS, "BUG-1").await.unwrap();
        assert_eq!(calls.lock().unwrap()[1].url, "https://api.github.com/repos/acme/api/issues/12");
        let reference = issue.external_ref.unwrap();
        assert_eq!(reference.state.as_deref(), Some("Closed"));
        assert_eq!(reference.state_type, Some(ExternalStateType::Done));
        assert_eq!(reference.origin, ExternalRefOrigin::Link);
        assert_eq!(reference.id, "acme/api#12");
        assert_eq!(stored(&state).await.status, "backlog");
        test.drop().await;
    }

    #[tokio::test]
    async fn does_not_refresh_an_issue_that_is_not_linked() {
        let Some((test, state, calls)) = setup(|_| None).await else { return };
        let err = refresh(&state, WS, "BUG-1").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(err.to_string().contains("This issue is not linked to an external issue"));
        assert!(calls.lock().unwrap().is_empty());
        let err = refresh(&state, WS, "BUG-404").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::NOT_FOUND);
        test.drop().await;
    }

    #[tokio::test]
    async fn unlinking_clears_the_reference() {
        let Some((test, state, _)) = setup(|_| Some(reply(gh_issue("open")))).await else {
            return;
        };
        link(&state, WS, &actor(), "BUG-1", "https://github.com/Acme/API/issues/12").await.unwrap();
        let issue = unlink(&state, WS, &actor(), "BUG-1").await.unwrap();
        assert_eq!(issue.external_ref, None);
        assert_eq!(stored(&state).await.external_ref, None);
        test.drop().await;
    }

    #[tokio::test]
    async fn links_a_github_enterprise_issue_with_the_credential_of_that_host() {
        let Some((test, state, calls)) = setup(|_| {
            Some(reply(json!({
                "number": 7,
                "html_url": "https://ghe.example.com/acme/api/issues/7",
                "title": "Crash", "state": "closed", "state_reason": "not_planned",
                "created_at": "2026-01-01T00:00:00Z",
            })))
        })
        .await
        else {
            return;
        };
        // a credential of github.com must not be sent to the Enterprise host
        credential(&state, "tcr_dotcom", "github", None, GH_TOKEN).await;
        let err = link(&state, WS, &actor(), "BUG-1", "https://ghe.example.com/acme/api/issues/7")
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(
            err.to_string().ends_with("No GitHub credential is configured for ghe.example.com"),
            "{err}"
        );
        assert!(calls.lock().unwrap().is_empty());

        credential(
            &state,
            "tcr_ghe",
            "github",
            Some("https://ghe.example.com"),
            "ghp_enterprise_token_0000000",
        )
        .await;
        let issue =
            link(&state, WS, &actor(), "BUG-1", "https://ghe.example.com/acme/api/issues/7")
                .await
                .unwrap();
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls[0].url, "https://ghe.example.com/api/v3/repos/acme/api/issues/7");
            assert_eq!(
                header(&calls[0], "Authorization"),
                Some("Bearer ghp_enterprise_token_0000000")
            );
        }
        let reference = issue.external_ref.unwrap();
        assert_eq!(reference.state_type, Some(ExternalStateType::Canceled));
        assert_eq!(reference.state.as_deref(), Some("Closed (not planned)"));
        test.drop().await;
    }

    #[tokio::test]
    async fn links_a_linear_issue_through_the_stored_key_and_refreshes_it_by_uuid() {
        let Some((test, state, calls)) = setup(|req| {
            assert_eq!(req.method, Method::POST);
            let id = req.body.as_ref().unwrap()["variables"]["id"].as_str().unwrap().to_owned();
            assert!(id == "ENG-1" || id == "uuid-1", "{id}");
            let state_type = if id == "ENG-1" { "started" } else { "completed" };
            Some(reply(json!({ "data": { "issue": {
                "id": "uuid-1", "identifier": "ENG-1", "title": "Crash",
                "url": "https://linear.app/acme/issue/ENG-1/crash",
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z",
                "state": { "id": "s1", "name": "State", "type": state_type },
            } } })))
        })
        .await
        else {
            return;
        };
        let err = link(&state, WS, &actor(), "BUG-1", "https://linear.app/acme/issue/ENG-1/crash")
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(
            err.to_string()
                .ends_with("Add a Linear API key under Settings → Import to link Linear issues"),
            "{err}"
        );
        assert!(calls.lock().unwrap().is_empty());

        credential(&state, "tcr_lin", "linear", None, LINEAR_KEY).await;
        let issue = link(&state, WS, &actor(), "BUG-1", "https://linear.app/acme/issue/eng-1")
            .await
            .unwrap();
        let reference = issue.external_ref.unwrap();
        assert_eq!(reference.provider, ExternalProvider::Linear);
        assert_eq!(reference.id, "uuid-1");
        assert_eq!(reference.key.as_deref(), Some("ENG-1"));
        assert_eq!(reference.state_type, Some(ExternalStateType::InProgress));
        assert_eq!(header(&calls.lock().unwrap()[0], "Authorization"), Some(LINEAR_KEY));
        let issue = refresh(&state, WS, "BUG-1").await.unwrap();
        let reference = issue.external_ref.unwrap();
        assert_eq!(reference.state_type, Some(ExternalStateType::Done));
        assert_eq!(reference.id, "uuid-1");
        test.drop().await;
    }

    #[test]
    fn the_routes_are_the_three_external_ref_endpoints() {
        let routes = routes().routes();
        assert_eq!(routes.len(), 3);
        assert!(routes.iter().any(|(m, p)| m == Method::DELETE && p.ends_with("/external-ref")));
        assert!(routes.iter().any(|(m, p)| m == Method::POST && p.ends_with("/external-ref")));
        assert!(
            routes.iter().any(|(m, p)| m == Method::POST && p.ends_with("/external-ref/refresh"))
        );
    }
}
