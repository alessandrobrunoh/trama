//! A person's logins in other tools, and the one place that decides who a login belongs to
//! (`external-identities.service.ts`).
//!
//! Hosts are compared lower-case without scheme or path, logins case-insensitively (the unique
//! index of the table is over `lower(provider)`, `lower(host)` and `lower(login)`).
//!
//! Every function takes the connection to use: `&state.db`, or a transaction.

use std::collections::HashMap;

use sea_orm::sea_query::{Expr, ExprTrait, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Set,
};
use trama_common::util::{is_unique_violation, unique};
use trama_contracts::identity::{
    EXTERNAL_IDENTITIES_MAX, ExternalIdentityInput, ExternalIdentityProvider,
    ExternalIdentitySource, normalize_identity_host, normalize_identity_login,
};
use trama_contracts::js;
use trama_core::AppError;
use trama_core::ids::uid;
use trama_entities::{external_identities, memberships};

/// A (provider, host, login) triple in the form the table compares: lower-case host, trimmed
/// login.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityKey {
    /// The tool.
    pub provider: ExternalIdentityProvider,
    /// Lower-case host without scheme or path.
    pub host: String,
    /// The login without a leading `@`, as it was spelled.
    pub login: String,
}

/// Options of the resolvers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResolveOptions {
    /// Only identities that came from a connection (proven with a token), not typed in by hand.
    pub verified_only: bool,
}

impl ResolveOptions {
    /// Only identities proven by a connection.
    pub const VERIFIED: Self = Self { verified_only: true };
}

/// Normalizes a triple. `host` may be a bare host, a URL, or empty (the provider's public
/// host). Returns `None` when the provider is unknown, the host cannot be derived or is
/// malformed, or the login is empty or unusable. Lookups use this and treat `None` as "nobody".
#[must_use]
pub fn identity_key(
    provider: &str,
    host: Option<&str>,
    login: Option<&str>,
) -> Option<IdentityKey> {
    let provider = ExternalIdentityProvider::parse(provider)?;
    let host = match host.filter(|h| !js::trim(h).is_empty()) {
        Some(host) => normalize_identity_host(host),
        None => provider.meta().1.map(str::to_owned),
    };
    let login = login.filter(|l| !l.is_empty()).and_then(normalize_identity_login);
    Some(IdentityKey { provider, host: host?, login: login? })
}

// ───────────── a person's own list ─────────────

/// Everything this person has, oldest first.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
) -> Result<Vec<external_identities::Model>, AppError> {
    Ok(external_identities::Entity::find()
        .filter(external_identities::Column::UserId.eq(user_id))
        .order_by_asc(external_identities::Column::CreatedAt)
        .order_by_asc(external_identities::Column::Id)
        .all(db)
        .await?)
}

/// Adds a login by hand (`source: manual`).
///
/// # Errors
///
/// 400 when the login or host is unusable, the provider needs a host (Jira), or the person
/// already has [`EXTERNAL_IDENTITIES_MAX`]; 409 when anyone (including this person) already has
/// the login.
pub async fn add<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    input: &ExternalIdentityInput,
) -> Result<external_identities::Model, AppError> {
    let Some(key) =
        identity_key(input.provider.as_str(), input.host.as_deref(), Some(&input.login))
    else {
        if normalize_identity_login(&input.login).is_none() {
            return Err(AppError::bad_request("login is not a valid login"));
        }
        if input.host.as_deref().is_some_and(|h| !js::trim(h).is_empty())
            && input.host.as_deref().and_then(normalize_identity_host).is_none()
        {
            return Err(AppError::bad_request("host is not a valid host name"));
        }
        return Err(AppError::bad_request("host is required for this provider"));
    };
    if count_of(db, user_id).await? >= EXTERNAL_IDENTITIES_MAX {
        return Err(AppError::bad_request(format!(
            "At most {EXTERNAL_IDENTITIES_MAX} external identities per account"
        )));
    }
    if let Some(existing) = find(db, &key).await? {
        return Err(AppError::conflict(if existing.user_id == user_id {
            "You already have this identity"
        } else {
            "This login is already linked to another account"
        }));
    }
    match insert(db, user_id, &key, ExternalIdentitySource::Manual).await {
        Err(err) if is_unique_violation(&err) => {
            Err(AppError::conflict("This login is already linked to another account"))
        }
        other => Ok(other?),
    }
}

/// Removes one of the person's own identities. Someone else's is a 404, not a 403: its
/// existence is not revealed.
///
/// # Errors
///
/// 404 `External identity "<id>" not found`.
pub async fn remove<C: ConnectionTrait>(db: &C, user_id: &str, id: &str) -> Result<(), AppError> {
    let row = external_identities::Entity::find_by_id(id)
        .filter(external_identities::Column::UserId.eq(user_id))
        .one(db)
        .await?;
    if row.is_none() {
        return Err(AppError::entity_not_found("External identity", id));
    }
    external_identities::Entity::delete_many()
        .filter(external_identities::Column::Id.eq(id))
        .filter(external_identities::Column::UserId.eq(user_id))
        .exec(db)
        .await?;
    Ok(())
}

// ───────────── for other modules ─────────────

/// Called when a personal connection is created: its account login becomes an identity of the
/// owner (`source: connection`). Never fails on a conflict (the connection must still be
/// created): a login that belongs to someone else, a malformed one, or a full list returns
/// `None`. An identity the person had typed in by hand becomes a connection one (it is proven
/// now).
///
/// # Errors
///
/// 500 when the database fails.
pub async fn ensure_from_connection<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    provider: &str,
    host: Option<&str>,
    login: Option<&str>,
) -> Result<Option<external_identities::Model>, AppError> {
    let Some(key) = identity_key(provider, host, login) else { return Ok(None) };
    if let Some(existing) = find(db, &key).await? {
        if existing.user_id != user_id {
            tracing::warn!(
                "Login {}/{}/{} is linked to another account; not added to {user_id}",
                key.provider,
                key.host,
                key.login
            );
            return Ok(None);
        }
        if existing.source != ExternalIdentitySource::Connection.as_str() {
            let mut row = existing.into_active_model();
            row.source = Set(ExternalIdentitySource::Connection.as_str().to_owned());
            return Ok(Some(row.update(db).await?));
        }
        return Ok(Some(existing));
    }
    if count_of(db, user_id).await? >= EXTERNAL_IDENTITIES_MAX {
        return Ok(None);
    }
    match insert(db, user_id, &key, ExternalIdentitySource::Connection).await {
        Ok(row) => Ok(Some(row)),
        // a concurrent add won
        Err(err) if is_unique_violation(&err) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// The Trama account that owns this external login, or `None`. The single resolver for
/// assignees, review requests, mentions and activity: every login of one person resolves to
/// that person.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn resolve_user_by_login<C: ConnectionTrait>(
    db: &C,
    provider: &str,
    host: Option<&str>,
    login: Option<&str>,
    opts: ResolveOptions,
) -> Result<Option<String>, AppError> {
    let Some(key) = identity_key(provider, host, login) else { return Ok(None) };
    let Some(row) = find(db, &key).await? else { return Ok(None) };
    if opts.verified_only && row.source != ExternalIdentitySource::Connection.as_str() {
        return Ok(None);
    }
    Ok(Some(row.user_id))
}

/// Like [`resolve_user_by_login`], but `None` unless that account is a member of the workspace.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn resolve_member_by_login<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    provider: &str,
    host: Option<&str>,
    login: Option<&str>,
    opts: ResolveOptions,
) -> Result<Option<String>, AppError> {
    let Some(key) = identity_key(provider, host, login) else { return Ok(None) };
    let logins: Vec<&str> = login.filter(|l| !l.is_empty()).into_iter().collect();
    let found = resolve_members_by_logins(db, workspace_id, provider, host, &logins, opts).await?;
    Ok(found.get(&js_lower(&key.login)).cloned())
}

/// Resolves many logins of one provider and host at once. The result maps the lower-cased login
/// to the user id, and only holds accounts that are members of the workspace.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn resolve_members_by_logins<C: ConnectionTrait, S: AsRef<str>>(
    db: &C,
    workspace_id: &str,
    provider: &str,
    host: Option<&str>,
    logins: &[S],
    opts: ResolveOptions,
) -> Result<HashMap<String, String>, AppError> {
    let mut found = HashMap::new();
    let keys: Vec<IdentityKey> =
        logins.iter().filter_map(|l| identity_key(provider, host, Some(l.as_ref()))).collect();
    let Some(first) = keys.first() else { return Ok(found) };
    let lowered = unique(&keys.iter().map(|k| js_lower(&k.login)).collect::<Vec<_>>());
    let mut query = external_identities::Entity::find()
        .filter(external_identities::Column::Provider.eq(first.provider.as_str()))
        .filter(external_identities::Column::Host.eq(first.host.as_str()))
        .filter(Func::lower(Expr::col(external_identities::Column::Login)).is_in(lowered));
    if opts.verified_only {
        query = query.filter(
            external_identities::Column::Source.eq(ExternalIdentitySource::Connection.as_str()),
        );
    }
    let rows = query.all(db).await?;
    if rows.is_empty() {
        return Ok(found);
    }
    // only accounts that are members of the workspace
    let members: Vec<String> = memberships::Entity::find()
        .select_only()
        .column(memberships::Column::UserId)
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .filter(memberships::Column::UserId.is_in(rows.iter().map(|r| r.user_id.clone())))
        .into_tuple()
        .all(db)
        .await?;
    for row in rows.into_iter().filter(|r| members.contains(&r.user_id)) {
        found.insert(js_lower(&row.login), row.user_id);
    }
    Ok(found)
}

/// Every login this person has at a provider (and host, when given), as stored.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn logins_of<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    provider: Option<&str>,
    host: Option<&str>,
) -> Result<Vec<external_identities::Model>, AppError> {
    let rows = list(db, user_id).await?;
    let host = host.filter(|h| !h.is_empty()).and_then(normalize_identity_host);
    Ok(rows
        .into_iter()
        .filter(|r| {
            provider.is_none_or(|p| p.is_empty() || r.provider == p)
                && host.as_ref().is_none_or(|h| &r.host == h)
        })
        .collect())
}

// ───────────── internals ─────────────

/// `String.prototype.toLowerCase`.
fn js_lower(value: &str) -> String {
    value.to_lowercase()
}

async fn count_of<C: ConnectionTrait>(db: &C, user_id: &str) -> Result<usize, AppError> {
    let count = external_identities::Entity::find()
        .filter(external_identities::Column::UserId.eq(user_id))
        .count(db)
        .await?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

async fn find<C: ConnectionTrait>(
    db: &C,
    key: &IdentityKey,
) -> Result<Option<external_identities::Model>, AppError> {
    Ok(external_identities::Entity::find()
        .filter(external_identities::Column::Provider.eq(key.provider.as_str()))
        .filter(external_identities::Column::Host.eq(key.host.as_str()))
        .filter(Func::lower(Expr::col(external_identities::Column::Login)).eq(js_lower(&key.login)))
        .one(db)
        .await?)
}

async fn insert<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    key: &IdentityKey,
    source: ExternalIdentitySource,
) -> Result<external_identities::Model, sea_orm::DbErr> {
    external_identities::ActiveModel {
        id: Set(uid("xid")),
        user_id: Set(user_id.to_owned()),
        provider: Set(key.provider.as_str().to_owned()),
        host: Set(key.host.clone()),
        login: Set(key.login.clone()),
        source: Set(source.as_str().to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
}
