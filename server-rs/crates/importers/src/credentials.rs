//! Tracker credentials: validate remotely, encrypt at rest, and resolve only inside a workspace.
use axum::http::Method;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde_json::{Value, json};
use trama_common::Secrets;
use trama_contracts::{common::ActorRef, imports::ExternalProvider};
use trama_core::{AppError, AppState, ids::uid};
use trama_entities::{integration_connections, tracker_credentials};
use trama_integrations::{
    Http, HttpRequest, ProviderError,
    providers::{create_git_client, ensure_ok, normalize_base_url},
};

const fn label(provider: ExternalProvider) -> &'static str {
    provider.label()
}

fn provider_error(provider: ExternalProvider, error: &ProviderError, token: &str) -> AppError {
    let message = error.to_string().replace(token, "[redacted]");
    if let ProviderError::Status(status) = error {
        if status.rate_limited() {
            return AppError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                format!("{} rate limit reached", label(provider)),
            );
        }
        if matches!(status.status, 401 | 403 | 404) {
            return AppError::bad_request(format!(
                "{} rejected the request ({message})",
                label(provider)
            ));
        }
        return AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("{} failed: {message}", label(provider)),
        );
    }
    AppError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        format!("{} is unreachable: {message}", label(provider)),
    )
}

/// A credential usable by a provider adapter. The plaintext token never leaves this module's
/// server-side call path.
#[derive(Clone, Debug)]
pub struct ResolvedCredential {
    /// Decrypted tracker token.
    pub token: Option<String>,
    /// GitHub Enterprise base URL.
    pub base_url: Option<String>,
    /// Account label stored when the token was validated.
    pub account: Option<String>,
}

/// Validate and store a tracker credential; updates the existing same-account/same-host row.
#[allow(clippy::too_many_lines)]
pub async fn create(
    state: &AppState,
    workspace_id: &str,
    actor: &ActorRef,
    provider: ExternalProvider,
    raw_token: &str,
    raw_base_url: Option<&str>,
) -> Result<Value, AppError> {
    let token = raw_token.trim();
    let mut base_url = None;
    if provider == ExternalProvider::Github {
        let normalized = normalize_base_url(raw_base_url)
            .map_err(|e| AppError::bad_request(format!("Invalid baseUrl: {e}")))?;
        if let Some(url) = normalized
            && url != "https://github.com"
            && url != "http://github.com"
        {
            if let Some(problem) =
                trama_common::safe_fetch::outbound_url_problem(&url, &state.config.outbound).await
            {
                return Err(AppError::bad_request(format!("Invalid baseUrl: {problem}")));
            }
            base_url = Some(url);
        }
    } else if raw_base_url.is_some_and(|v| !v.trim().is_empty()) {
        return Err(AppError::bad_request("Linear has no custom base URL"));
    }

    let http = Http::of(state);
    let account = match provider {
        ExternalProvider::Github => {
            let client = create_git_client(
                trama_contracts::common::GitProvider::Github,
                &http,
                token,
                base_url.as_deref(),
            );
            client.current_user().await.map_err(|e| provider_error(provider, &e, token))?
        }
        ExternalProvider::Linear => {
            let response = http
                .request(
                    HttpRequest::new(Method::POST, "https://api.linear.app/graphql")
                        .header("Authorization", token)
                        .header("Content-Type", "application/json")
                        .json(json!({"query":"query { viewer { id name email } }"})),
                )
                .await
                .map_err(|e| {
                    AppError::new(
                        axum::http::StatusCode::BAD_GATEWAY,
                        format!(
                            "Linear is unreachable: {}",
                            e.to_string().replace(token, "[redacted]")
                        ),
                    )
                })?;
            ensure_ok(&response)
                .map_err(|e| provider_error(provider, &ProviderError::Status(e), token))?;
            response
                .json
                .get("data")
                .and_then(|v| v.get("viewer"))
                .and_then(|v| v.get("email"))
                .and_then(Value::as_str)
                .or_else(|| {
                    response
                        .json
                        .get("data")
                        .and_then(|v| v.get("viewer"))
                        .and_then(|v| v.get("name"))
                        .and_then(Value::as_str)
                })
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    AppError::bad_request(
                        "Linear rejected the request (Unexpected response from Linear viewer)",
                    )
                })?
        }
    };

    let rows = tracker_credentials::Entity::find()
        .filter(tracker_credentials::Column::WorkspaceId.eq(workspace_id))
        .filter(tracker_credentials::Column::Provider.eq(provider.as_str()))
        .all(&state.db)
        .await?;
    let existing = rows.into_iter().find(|row| row.account == account && row.base_url == base_url);
    let id = existing.as_ref().map_or_else(|| uid("tcr"), |row| row.id.clone());
    let created_by = existing.as_ref().map_or_else(
        || serde_json::to_value(actor).unwrap_or(Value::Null),
        |row| row.created_by.clone(),
    );
    let created_at = existing.as_ref().map(|row| row.created_at);
    let last_used_at = existing.as_ref().and_then(|row| row.last_used_at);
    let secret = Secrets::of(state)?.encrypt(token, &format!("{id}:tracker"));
    let model = tracker_credentials::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        provider: Set(provider.to_string()),
        account: Set(account.clone()),
        base_url: Set(base_url.clone()),
        secret: Set(secret),
        created_by: Set(created_by),
        created_at: created_at.map_or(sea_orm::ActiveValue::NotSet, Set),
        last_used_at: Set(last_used_at),
    };
    if existing.is_some() {
        model.update(&state.db).await?;
    } else {
        model.insert(&state.db).await?;
    }
    let model = tracker_credentials::Entity::find_by_id(&id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::internal("Saved tracker credential could not be read"))?;
    Ok(json!({
        "id": model.id, "workspaceId": model.workspace_id, "provider": model.provider,
        "account": model.account, "baseUrl": model.base_url,
        "createdAt": model.created_at.to_rfc3339(),
        "lastUsedAt": model.last_used_at.map(|v| v.to_rfc3339())
    }))
}

/// Resolve a saved tracker credential or workspace GitHub connection. All lookups are workspace
/// scoped; credential ciphertext and tokens are never returned in API responses.
pub async fn resolve(
    state: &AppState,
    workspace_id: &str,
    provider: ExternalProvider,
    credential_id: Option<&str>,
    connection_id: Option<&str>,
) -> Result<ResolvedCredential, AppError> {
    if credential_id.is_some() && connection_id.is_some() {
        return Err(AppError::bad_request("Pass credentialId or connectionId, not both"));
    }
    if let Some(id) = credential_id {
        let row = tracker_credentials::Entity::find_by_id(id)
            .filter(tracker_credentials::Column::WorkspaceId.eq(workspace_id))
            .filter(tracker_credentials::Column::Provider.eq(provider.as_str()))
            .one(&state.db)
            .await?
            .ok_or_else(|| {
                AppError::bad_request(format!("Unknown {provider} credential \"{id}\""))
            })?;
        tracker_credentials::Entity::update_many()
            .col_expr(
                tracker_credentials::Column::LastUsedAt,
                sea_orm::sea_query::Expr::value(chrono::Utc::now()),
            )
            .filter(tracker_credentials::Column::Id.eq(id))
            .exec(&state.db)
            .await?;
        return Ok(ResolvedCredential {
            token: Some(
                Secrets::of(state)?
                    .decrypt(&row.secret, &format!("{id}:tracker"))
                    .map_err(|_| AppError::internal("Unable to decrypt tracker credential"))?,
            ),
            base_url: row.base_url,
            account: Some(row.account),
        });
    }
    if let Some(id) = connection_id {
        if provider != ExternalProvider::Github {
            return Err(AppError::bad_request("connectionId is only for GitHub"));
        }
        let row = integration_connections::Entity::find_by_id(id)
            .filter(integration_connections::Column::OwnerType.eq("workspace"))
            .filter(integration_connections::Column::WorkspaceId.eq(workspace_id))
            .filter(integration_connections::Column::Provider.eq("github"))
            .one(&state.db)
            .await?
            .filter(|row| row.secret.is_some())
            .ok_or_else(|| AppError::bad_request(format!("Unknown GitHub connection \"{id}\"")))?;
        return Ok(ResolvedCredential {
            token: Some(
                Secrets::of(state)?
                    .decrypt(
                        row.secret.as_deref().unwrap_or_default(),
                        &trama_integrations::service::secret_aad(id),
                    )
                    .map_err(|_| AppError::internal("Unable to decrypt integration credential"))?,
            ),
            base_url: row.base_url,
            account: Some(row.account),
        });
    }
    match provider {
        ExternalProvider::Github => {
            Ok(ResolvedCredential { token: None, base_url: None, account: None })
        }
        ExternalProvider::Linear => {
            Err(AppError::bad_request("A Linear API key is required: add a credential first"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use async_trait::async_trait;
    use sea_orm_migration::MigratorTrait;
    use trama_common::Secrets;
    use trama_contracts::{common::ActorRef, roles::fresh_workspace_roles};
    use trama_core::{AppState, Config, testkit::TestDb};
    use trama_entities::{integration_connections, workspaces};
    use trama_integrations::{HttpClient, HttpFailure, HttpRequest, HttpResponse};

    use super::*;

    struct Github {
        status: u16,
    }

    #[async_trait]
    impl HttpClient for Github {
        async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            assert!(req.url.ends_with("/user"));
            assert!(
                req.headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("authorization")
                    && value == "Bearer ghp_valid_token")
            );
            Ok(HttpResponse {
                status: self.status,
                headers: BTreeMap::new(),
                json: if self.status == 200 {
                    json!({"login":"octocat"})
                } else {
                    json!({"message":"Bad credentials"})
                },
            })
        }
    }

    #[tokio::test]
    async fn validates_encrypts_and_resolves_scoped_tracker_credentials() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        workspaces::ActiveModel {
            id: Set("ws_import_test".into()),
            name: Set("Import test".into()),
            slug: Set("import-test".into()),
            settings: Set(json!({"roles": fresh_workspace_roles()})),
            personal: Set(false),
            ..Default::default()
        }
        .insert(&test.db)
        .await
        .unwrap();
        let http = Http::new(Github { status: 200 });
        let state = AppState::new(
            test.db.clone(),
            Config::from_vars(&[("TRAMA_ENCRYPTION_KEY", "test-import-key")]),
        )
        .with_extension(http);
        let actor = ActorRef::user("u_importer");
        let saved = create(
            &state,
            "ws_import_test",
            &actor,
            ExternalProvider::Github,
            " ghp_valid_token ",
            None,
        )
        .await
        .unwrap();
        assert_eq!(saved["account"], "octocat");
        assert!(saved.get("secret").is_none());

        let row = tracker_credentials::Entity::find_by_id(saved["id"].as_str().unwrap())
            .one(&state.db)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(row.secret, "ghp_valid_token");
        assert_eq!(
            Secrets::of(&state)
                .unwrap()
                .decrypt(&row.secret, &format!("{}:tracker", row.id))
                .unwrap(),
            "ghp_valid_token"
        );

        let resolved =
            resolve(&state, "ws_import_test", ExternalProvider::Github, Some(&row.id), None)
                .await
                .unwrap();
        assert_eq!(resolved.token.as_deref(), Some("ghp_valid_token"));
        let secret = Secrets::of(&state).unwrap().encrypt("ghp_connection_token", "ic_test:secret");
        integration_connections::ActiveModel {
            id: Set("ic_test".into()),
            workspace_id: Set(Some("ws_import_test".into())),
            provider: Set("github".into()),
            account: Set("connection-user".into()),
            secret: Set(Some(secret)),
            status: Set("connected".into()),
            config: Set(json!({})),
            owner_type: Set("workspace".into()),
            label: Set("GitHub".into()),
            host: Set("github.com".into()),
            ..Default::default()
        }
        .insert(&state.db)
        .await
        .unwrap();
        let connected =
            resolve(&state, "ws_import_test", ExternalProvider::Github, None, Some("ic_test"))
                .await
                .unwrap();
        assert_eq!(connected.token.as_deref(), Some("ghp_connection_token"));
        assert!(
            resolve(&state, "ws_other", ExternalProvider::Github, None, Some("ic_test"))
                .await
                .is_err()
        );
        assert!(
            resolve(&state, "ws_other", ExternalProvider::Github, Some(&row.id), None)
                .await
                .is_err()
        );
        test.drop().await;
    }

    #[tokio::test]
    async fn rejects_provider_credentials_without_disclosing_token() {
        let Some(test) = TestDb::create().await else { return };
        trama_migration::Migrator::up(&test.db, None).await.unwrap();
        let state = AppState::new(
            test.db.clone(),
            Config::from_vars(&[("TRAMA_ENCRYPTION_KEY", "test-import-key")]),
        )
        .with_extension(Http::new(Github { status: 401 }));
        let error = create(
            &state,
            "ws_missing",
            &ActorRef::user("u"),
            ExternalProvider::Github,
            "ghp_valid_token",
            None,
        )
        .await
        .unwrap_err();
        assert!(!error.to_string().contains("ghp_valid_token"));
        test.drop().await;
    }
}
