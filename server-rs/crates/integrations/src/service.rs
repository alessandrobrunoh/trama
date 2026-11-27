//! `IntegrationsService` (`integrations.service.ts`): connections to git hosts and Delta, owned
//! by a workspace or by one person, and everything the routes do with them. Other crates call
//! these functions (routing, webhooks, importers, the workspace snapshot).
//!
//! A [`ConnectionScope`] says whose connections a call works on; every lookup is filtered by
//! it, so a personal connection is simply "not found" for anyone else. Tokens and webhook
//! secrets are encrypted at rest (`trama_common::Secrets`, `v2`, bound to `<id>:secret` and
//! `<id>:webhook`) and never part of a response.

use std::collections::HashMap;

use axum::http::StatusCode;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, EntityTrait, IntoActiveModel,
    QueryFilter, QueryOrder, Set,
};
use serde_json::json;
use trama_common::Secrets;
use trama_common::crypto::generate_webhook_secret;
use trama_common::safe_fetch::outbound_url_problem;
use trama_common::util::is_unique_violation;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, GitProvider};
use trama_contracts::integrations::{
    ConnectionOwnerType, ConnectionProvider, ConnectionStatus, IntegrationConnection,
    connection_host,
};
use trama_contracts::js;
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{integration_connections, users};
use trama_events::{Events, LiveChange};

use crate::http::Http;
use crate::providers::{
    GitProviderClient, ProviderError, RemoteRepositoryPage, create_git_client, normalize_base_url,
};
use crate::schemas::{
    ConnectionCreated, CreateConnection, PresentedConnection, UpdateConnection, WebhookRotated,
    WebhookSetup,
};

/// Whose connections a call works on: a workspace's (managed by whoever has the integrations
/// permission) or one person's (only that person).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionScope {
    /// The workspace's own connections.
    Workspace {
        /// The workspace.
        workspace_id: String,
    },
    /// One person's personal connections, the same in every workspace.
    User {
        /// The owner.
        user_id: String,
    },
}

impl ConnectionScope {
    /// The scope of a workspace.
    #[must_use]
    pub fn workspace(workspace_id: impl Into<String>) -> Self {
        Self::Workspace { workspace_id: workspace_id.into() }
    }

    /// The scope of a person.
    #[must_use]
    pub fn user(user_id: impl Into<String>) -> Self {
        Self::User { user_id: user_id.into() }
    }

    fn owner_type(&self) -> ConnectionOwnerType {
        match self {
            Self::Workspace { .. } => ConnectionOwnerType::Workspace,
            Self::User { .. } => ConnectionOwnerType::User,
        }
    }

    /// The rows this scope owns.
    fn condition(&self) -> Condition {
        match self {
            Self::Workspace { workspace_id } => Condition::all()
                .add(integration_connections::Column::OwnerType.eq("workspace"))
                .add(integration_connections::Column::WorkspaceId.eq(workspace_id.as_str())),
            Self::User { user_id } => Condition::all()
                .add(integration_connections::Column::OwnerType.eq("user"))
                .add(integration_connections::Column::OwnerUserId.eq(user_id.as_str())),
        }
    }
}

/// Events to subscribe to in the git host, per provider (`WEBHOOK_EVENTS`).
#[must_use]
pub const fn webhook_events(provider: GitProvider) -> &'static [&'static str] {
    match provider {
        GitProvider::Github => &["pull_request", "issues", "check_suite", "check_run", "status"],
        GitProvider::Gitlab => &["merge_request", "issue", "pipeline"],
        GitProvider::Bitbucket => &[
            "pullrequest:created",
            "pullrequest:updated",
            "pullrequest:approved",
            "pullrequest:unapproved",
            "pullrequest:fulfilled",
            "pullrequest:rejected",
            "repo:commit_status_created",
            "repo:commit_status_updated",
        ],
    }
}

fn label(provider: ConnectionProvider) -> &'static str {
    provider.git().map_or("Delta", |g| g.meta().label)
}

/// AAD of a connection's encrypted token.
#[must_use]
pub fn secret_aad(id: &str) -> String {
    format!("{id}:secret")
}

/// AAD of a connection's encrypted webhook secret.
#[must_use]
pub fn webhook_aad(id: &str) -> String {
    format!("{id}:webhook")
}

/// Display name of a new connection when the caller gives none: `GitHub · octo`.
#[must_use]
pub fn default_label(provider: ConnectionProvider, account: &str) -> String {
    format!("{} · {account}", label(provider))
}

/// URL the git host posts webhooks to; none for Delta.
#[must_use]
pub fn webhook_url(row: &integration_connections::Model, origin: &str) -> Option<String> {
    (row.provider != "delta").then(|| format!("{origin}/api/webhooks/{}/{}", row.provider, row.id))
}

fn corrupt(row: &integration_connections::Model, field: &str) -> AppError {
    AppError::internal(format!("connection {} has an unknown {field}", row.id))
}

/// The contract `IntegrationConnection` of a row (`toJSON`): tokens, webhook secrets and the
/// private `config` are not part of it. `owner_name` is the display name of the owner of a
/// personal connection.
///
/// # Errors
///
/// 500 when the row holds an owner type, provider or status the contract does not know.
pub fn connection_view(
    row: &integration_connections::Model,
    owner_name: Option<String>,
) -> Result<IntegrationConnection, AppError> {
    Ok(IntegrationConnection {
        id: row.id.clone(),
        owner_type: ConnectionOwnerType::parse(&row.owner_type)
            .ok_or_else(|| corrupt(row, "ownerType"))?,
        workspace_id: row.workspace_id.clone(),
        owner_user_id: row.owner_user_id.clone(),
        owner_name: row.owner_user_id.as_ref().and(owner_name),
        label: row.label.clone(),
        provider: ConnectionProvider::parse(&row.provider)
            .ok_or_else(|| corrupt(row, "provider"))?,
        account: row.account.clone(),
        base_url: row.base_url.clone(),
        host: row.host.clone(),
        webhook_configured: row.webhook_secret.as_deref().is_some_and(|s| !s.is_empty()),
        status: ConnectionStatus::parse(&row.status).ok_or_else(|| corrupt(row, "status"))?,
        last_sync_at: row.last_sync_at.as_ref().map(to_iso),
        last_error: row.last_error.clone(),
        created_at: to_iso(&row.created_at),
    })
}

/// The contract connection of each row, with the owner's display name for personal ones.
///
/// # Errors
///
/// Database errors, or a corrupt row.
pub async fn summarize<C: ConnectionTrait>(
    db: &C,
    rows: &[integration_connections::Model],
) -> Result<Vec<IntegrationConnection>, AppError> {
    let mut ids: Vec<&str> = rows.iter().filter_map(|r| r.owner_user_id.as_deref()).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut names: HashMap<String, String> = HashMap::new();
    if !ids.is_empty() {
        for user in users::Entity::find().filter(users::Column::Id.is_in(ids)).all(db).await? {
            names.insert(user.id, user.name);
        }
    }
    rows.iter()
        .map(|r| connection_view(r, r.owner_user_id.as_ref().and_then(|id| names.get(id).cloned())))
        .collect()
}

/// [`summarize`] plus the webhook URL and the last delivery time (for the people who manage the
/// connection).
///
/// # Errors
///
/// Database errors, or a corrupt row.
pub async fn present<C: ConnectionTrait>(
    db: &C,
    row: &integration_connections::Model,
    origin: &str,
) -> Result<PresentedConnection, AppError> {
    let connection = summarize(db, std::slice::from_ref(row)).await?.remove(0);
    Ok(PresentedConnection {
        connection,
        webhook_url: webhook_url(row, origin),
        last_webhook_at: row
            .config
            .get("lastWebhookAt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

async fn get_row<C: ConnectionTrait>(
    db: &C,
    scope: &ConnectionScope,
    id: &str,
) -> Result<integration_connections::Model, AppError> {
    integration_connections::Entity::find()
        .filter(scope.condition())
        .filter(integration_connections::Column::Id.eq(id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Integration", id))
}

/// Personal connections have no workspace stream; the owner's page refetches after its own
/// calls.
fn publish(
    state: &AppState,
    scope: &ConnectionScope,
    change: fn(LiveEventEntity, String) -> LiveChange,
    id: &str,
) {
    if let ConnectionScope::Workspace { workspace_id } = scope {
        Events::of(state)
            .publish(workspace_id, change(LiveEventEntity::Integration, id.to_owned()));
    }
}

fn created(entity: LiveEventEntity, id: String) -> LiveChange {
    LiveChange::created(entity, id)
}
fn updated(entity: LiveEventEntity, id: String) -> LiveChange {
    LiveChange::updated(entity, id)
}
fn deleted(entity: LiveEventEntity, id: String) -> LiveChange {
    LiveChange::deleted(entity, id)
}

/// The connections of a scope, oldest first, as the people who manage them see them.
///
/// # Errors
///
/// Database errors.
pub async fn list(
    state: &AppState,
    scope: &ConnectionScope,
    origin: &str,
) -> Result<Vec<PresentedConnection>, AppError> {
    let rows = integration_connections::Entity::find()
        .filter(scope.condition())
        .order_by_asc(integration_connections::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(present(&state.db, row, origin).await?);
    }
    Ok(out)
}

/// One connection of a scope.
///
/// # Errors
///
/// 404 `Integration "<id>" not found`, also for another owner's connection.
pub async fn get(
    state: &AppState,
    scope: &ConnectionScope,
    id: &str,
    origin: &str,
) -> Result<PresentedConnection, AppError> {
    present(&state.db, &get_row(&state.db, scope, id).await?, origin).await
}

/// The decrypted token of a connection.
///
/// # Errors
///
/// 500 when the stored value cannot be decrypted.
pub fn connection_token(
    state: &AppState,
    row: &integration_connections::Model,
) -> Result<String, AppError> {
    Secrets::of(state)?
        .decrypt(row.secret.as_deref().unwrap_or_default(), &secret_aad(&row.id))
        .map_err(AppError::internal)
}

/// The decrypted webhook signing secret of a connection (`None` for Delta or a connection that
/// never had one). The webhook endpoint verifies signatures with it.
///
/// # Errors
///
/// 500 when the stored value cannot be decrypted.
pub fn connection_webhook_secret(
    state: &AppState,
    row: &integration_connections::Model,
) -> Result<Option<String>, AppError> {
    let Some(stored) = row.webhook_secret.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    Secrets::of(state)?.decrypt(stored, &webhook_aad(&row.id)).map(Some).map_err(AppError::internal)
}

fn client_with(
    state: &AppState,
    row: &integration_connections::Model,
    token_override: Option<&str>,
) -> Result<Box<dyn GitProviderClient>, AppError> {
    let Some(provider) = ConnectionProvider::parse(&row.provider) else {
        return Err(corrupt(row, "provider"));
    };
    let Some(git) = provider.git() else {
        return Err(AppError::bad_request("Delta connections have no repository API yet"));
    };
    if row.status == ConnectionStatus::Revoked.as_str() && token_override.is_none() {
        return Err(AppError::bad_request(
            "This connection was revoked. Reconnect it with a new token.",
        ));
    }
    let token = match token_override {
        Some(token) => token.to_owned(),
        None => connection_token(state, row)?,
    };
    Ok(create_git_client(git, &Http::of(state), &token, row.base_url.as_deref()))
}

/// The provider client of a connection, with its decrypted token (what routing uses to read
/// repositories).
///
/// # Errors
///
/// 400 for a Delta connection or a revoked one; 500 when the token cannot be decrypted.
pub fn connection_client(
    state: &AppState,
    row: &integration_connections::Model,
) -> Result<Box<dyn GitProviderClient>, AppError> {
    client_with(state, row, None)
}

/// Maps a provider failure to 400 (bad credential) / 502 (provider failing or unreachable).
///
/// # Errors
///
/// See above.
pub fn guard<T>(label: &str, result: Result<T, ProviderError>) -> Result<T, AppError> {
    result.map_err(|e| match e {
        ProviderError::Status(e) if matches!(e.status, 401 | 403 | 404) => {
            AppError::bad_request(format!("{label} rejected the request ({})", e.message))
        }
        ProviderError::Status(e) => {
            AppError::new(StatusCode::BAD_GATEWAY, format!("{label} failed: {}", e.message))
        }
        ProviderError::Unreachable(m) => {
            AppError::new(StatusCode::BAD_GATEWAY, format!("{label} is unreachable: {m}"))
        }
    })
}

/// Normalizes the base URL and refuses ones that point at internal addresses (SSRF), with a 400.
async fn base_url_of(
    state: &AppState,
    provider: ConnectionProvider,
    raw: Option<&str>,
) -> Result<Option<String>, AppError> {
    let invalid = |m: &str| AppError::bad_request(format!("Invalid baseUrl: {m}"));
    let normalized = normalize_base_url(raw).map_err(|m| invalid(&m))?;
    match provider.git() {
        None if normalized.is_none() => return Err(invalid("baseUrl is required for Delta")),
        Some(git) if normalized.is_some() && !git.meta().self_hosted => {
            return Err(invalid(&format!("{} has no custom base URL", label(provider))));
        }
        _ => {}
    }
    if let Some(url) = &normalized
        && let Some(problem) = outbound_url_problem(url, &state.config.outbound).await
    {
        return Err(invalid(&problem));
    }
    Ok(normalized)
}

fn webhook_setup(
    row: &integration_connections::Model,
    origin: &str,
    secret: String,
) -> Result<WebhookSetup, AppError> {
    let git = GitProvider::parse(&row.provider).ok_or_else(|| corrupt(row, "provider"))?;
    Ok(WebhookSetup {
        url: webhook_url(row, origin).unwrap_or_default(),
        secret,
        content_type: "application/json",
        events: webhook_events(git).to_vec(),
    })
}

/// JavaScript's `URL.host`: the host, with the port when it is not the scheme's default.
fn url_host(raw: &str) -> String {
    url::Url::parse(raw).ok().map_or_else(String::new, |u| {
        let host = u.host_str().unwrap_or_default();
        u.port().map_or_else(|| host.to_owned(), |p| format!("{host}:{p}"))
    })
}

/// Connects a git host or Delta: validates the credential against the provider, stores it
/// encrypted, and for a personal connection records the account login as one of the owner's
/// external identities.
///
/// # Errors
///
/// 400 `Invalid baseUrl: …` or a credential the provider rejects; 409 when the same account on
/// the same host is already connected for this owner; 502 when the provider fails.
pub async fn create(
    state: &AppState,
    scope: &ConnectionScope,
    _actor: &ActorRef,
    input: CreateConnection,
    origin: &str,
) -> Result<ConnectionCreated, AppError> {
    let provider = input.provider;
    let base_url = base_url_of(state, provider, input.base_url.as_deref()).await?;
    let id = uid("ic");
    let account = match (provider.git(), &base_url) {
        (Some(git), base) => {
            let client = create_git_client(git, &Http::of(state), &input.token, base.as_deref());
            guard(label(provider), client.current_user().await)?
        }
        // a stub: Delta has no validation call yet
        (None, base) => url_host(base.as_deref().unwrap_or_default()),
    };
    let default_base = provider.git().map(|g| format!("https://{}", g.meta().host));
    let stored = match &base_url {
        Some(url) if default_base.as_deref() != Some(url.as_str()) => Some(url.clone()),
        Some(url) if provider == ConnectionProvider::Delta => Some(url.clone()),
        _ => None,
    };
    let host = connection_host(provider, stored.as_deref());
    // Several accounts per provider are fine; the same account on the same host twice for one
    // owner is not.
    let clash = integration_connections::Entity::find()
        .filter(scope.condition())
        .filter(integration_connections::Column::Provider.eq(provider.as_str()))
        .filter(integration_connections::Column::Account.eq(account.as_str()))
        .all(&state.db)
        .await?
        .iter()
        .any(|c| c.host == host);
    let conflict =
        || AppError::conflict(format!("A {provider} connection for \"{account}\" already exists"));
    if clash {
        return Err(conflict());
    }

    let secrets = Secrets::of(state)?;
    let webhook_secret = provider.git().map(|_| generate_webhook_secret());
    let (workspace_id, owner_user_id) = match scope {
        ConnectionScope::Workspace { workspace_id } => (Some(workspace_id.clone()), None),
        ConnectionScope::User { user_id } => (None, Some(user_id.clone())),
    };
    let custom = input.label.as_deref().map(js::trim).filter(|l| !l.is_empty());
    let row = integration_connections::ActiveModel {
        id: Set(id.clone()),
        owner_type: Set(scope.owner_type().as_str().to_owned()),
        workspace_id: Set(workspace_id),
        owner_user_id: Set(owner_user_id),
        label: Set(custom.map_or_else(|| default_label(provider, &account), str::to_owned)),
        provider: Set(provider.as_str().to_owned()),
        account: Set(account.clone()),
        host: Set(host.clone()),
        base_url: Set(stored),
        secret: Set(Some(secrets.encrypt(&input.token, &secret_aad(&id)))),
        webhook_secret: Set(webhook_secret
            .as_deref()
            .map(|s| secrets.encrypt(s, &webhook_aad(&id)))),
        status: Set(ConnectionStatus::Connected.as_str().to_owned()),
        config: Set(json!({})),
        ..Default::default()
    }
    .insert(&state.db)
    .await
    .map_err(|e| if is_unique_violation(&e) { conflict() } else { e.into() })?;
    publish(state, scope, created, &id);
    // A personal connection proves its account login: record it as one of the owner's identities.
    if let (ConnectionScope::User { user_id }, Some(_)) = (scope, provider.git()) {
        trama_external_identities::service::ensure_from_connection(
            &state.db,
            user_id,
            provider.as_str(),
            Some(&host),
            Some(&account),
        )
        .await?;
    }
    let webhook = match webhook_secret {
        Some(secret) => Some(webhook_setup(&row, origin, secret)?),
        None => None,
    };
    Ok(ConnectionCreated { connection: present(&state.db, &row, origin).await?, webhook })
}

/// Rename, and/or give a new token or base URL (which re-validates against the provider and
/// brings a revoked or failing connection back to `connected`).
///
/// # Errors
///
/// 404 for an unknown connection or another owner's; 400 `Invalid baseUrl: …`, `Enter the
/// access token again when you change the base URL`, or a credential the provider rejects.
pub async fn update(
    state: &AppState,
    scope: &ConnectionScope,
    id: &str,
    patch: UpdateConnection,
    origin: &str,
) -> Result<PresentedConnection, AppError> {
    let current = get_row(&state.db, scope, id).await?;
    let mut row = current.clone();
    let provider =
        ConnectionProvider::parse(&row.provider).ok_or_else(|| corrupt(&row, "provider"))?;
    let revoked =
        |row: &integration_connections::Model| row.status == ConnectionStatus::Revoked.as_str();
    let base_patch = !patch.base_url.is_missing();
    if base_patch {
        let raw = patch.base_url.as_value().map(String::as_str);
        let base = base_url_of(state, provider, raw).await?;
        // The stored token would be sent to the new host to validate it: never without the owner
        // supplying it again.
        if provider.git().is_some() && base != row.base_url && patch.token.is_none() {
            return Err(AppError::bad_request(
                "Enter the access token again when you change the base URL",
            ));
        }
        row.host = connection_host(provider, base.as_deref());
        row.base_url = base;
    }
    // A revoked connection has no token left to re-check; only a new token brings it back.
    let revalidate = patch.token.is_some() || (base_patch && !revoked(&row));
    if revalidate {
        if provider.git().is_some() {
            let token = match &patch.token {
                Some(token) => token.clone(),
                None => connection_token(state, &row)?,
            };
            let client = client_with(state, &row, Some(&token))?;
            row.account = guard(label(provider), client.current_user().await)?;
            ConnectionStatus::Connected.as_str().clone_into(&mut row.status);
            row.last_error = None;
        }
        if let Some(token) = &patch.token {
            row.secret = Some(Secrets::of(state)?.encrypt(token, &secret_aad(id)));
            if provider == ConnectionProvider::Delta {
                ConnectionStatus::Connected.as_str().clone_into(&mut row.status);
                row.last_error = None;
            }
        }
    }
    if let Some(new_label) = &patch.label {
        row.label = js::trim(new_label).to_owned();
    }
    let row = save(state, &current, row).await?;
    publish(state, scope, updated, id);
    present(&state.db, &row, origin).await
}

/// Writes `row` when it differs from what was loaded (TypeORM's `save` of an unchanged entity
/// does nothing).
async fn save(
    state: &AppState,
    before: &integration_connections::Model,
    row: integration_connections::Model,
) -> Result<integration_connections::Model, AppError> {
    if &row == before {
        return Ok(row);
    }
    Ok(row.into_active_model().reset_all().update(&state.db).await?)
}

/// Withdraws the credential on purpose: the token is wiped and the status becomes `revoked`
/// with a reason in `lastError`. The row stays, so whatever reads through it (routing rules)
/// can show "reconnect, or switch to another connection" instead of failing silently. A new
/// token via [`update`] brings it back.
///
/// # Errors
///
/// 404 for an unknown connection or another owner's.
pub async fn revoke(
    state: &AppState,
    scope: &ConnectionScope,
    id: &str,
    origin: &str,
) -> Result<PresentedConnection, AppError> {
    let current = get_row(&state.db, scope, id).await?;
    let mut row = current.clone();
    ConnectionStatus::Revoked.as_str().clone_into(&mut row.status);
    row.secret = None;
    row.last_error = Some("Revoked".to_owned());
    let row = save(state, &current, row).await?;
    publish(state, scope, updated, id);
    present(&state.db, &row, origin).await
}

/// Deletes a connection.
///
/// # Errors
///
/// 404 for an unknown connection or another owner's.
pub async fn remove(state: &AppState, scope: &ConnectionScope, id: &str) -> Result<(), AppError> {
    get_row(&state.db, scope, id).await?;
    integration_connections::Entity::delete_by_id(id).exec(&state.db).await?;
    publish(state, scope, deleted, id);
    Ok(())
}

/// Replaces the webhook secret; the new one is returned once.
///
/// # Errors
///
/// 404 for an unknown connection or another owner's; 400 for Delta.
pub async fn rotate_webhook_secret(
    state: &AppState,
    scope: &ConnectionScope,
    id: &str,
    origin: &str,
) -> Result<WebhookRotated, AppError> {
    let current = get_row(&state.db, scope, id).await?;
    if current.provider == "delta" {
        return Err(AppError::bad_request("Delta connections have no webhook"));
    }
    let secret = generate_webhook_secret();
    let mut row = current.clone();
    row.webhook_secret = Some(Secrets::of(state)?.encrypt(&secret, &webhook_aad(id)));
    let row = save(state, &current, row).await?;
    publish(state, scope, updated, id);
    Ok(WebhookRotated {
        connection: present(&state.db, &row, origin).await?,
        webhook: webhook_setup(&row, origin, secret)?,
    })
}

/// One page of the repositories a connection can see.
///
/// # Errors
///
/// 404 for an unknown connection or another owner's; 400 for a revoked or Delta connection or a
/// credential the provider rejects; 502 when the provider fails.
pub async fn remote_repositories(
    state: &AppState,
    scope: &ConnectionScope,
    id: &str,
    page: u32,
    per_page: u32,
) -> Result<RemoteRepositoryPage, AppError> {
    let row = get_row(&state.db, scope, id).await?;
    // a revoked or Delta connection is a 400 here, not a provider failure
    let client = client_with(state, &row, None)?;
    let provider =
        ConnectionProvider::parse(&row.provider).ok_or_else(|| corrupt(&row, "provider"))?;
    guard(label(provider), client.list_repositories(page, per_page).await)
}
