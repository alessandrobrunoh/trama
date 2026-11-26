//! API tokens: issuing, resolving a bearer secret, revoking and per-token request budgets. The
//! port of `server/src/auth/tokens.service.ts`.
//!
//! The plaintext secret (`trm_` + 32 random bytes in base64url) is returned once by
//! [`create_token`]; only its sha256 is stored. Tokens minted before the rename (`nbl_…`) keep
//! working.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, Set, Statement,
};
use serde::Serialize;
use serde_json::{Value, json};
use trama_common::crypto::sha256_hex;
use trama_contracts::common::ActorRef;
use trama_contracts::roles::{
    ApiPermission, DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS, TokenLimits, TokenScope,
};
use trama_core::AppError;
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_entities::api_tokens;
use utoipa::ToSchema;

use crate::context::AuthToken;

/// New tokens are issued with this prefix.
pub const TOKEN_PREFIX: &str = "trm_";
/// Tokens minted before the rename to Trama keep working.
pub const LEGACY_TOKEN_PREFIX: &str = "nbl_";

/// How often `lastUsedAt` is written at most.
const TOUCH_EVERY: chrono::TimeDelta = chrono::TimeDelta::seconds(60);
const WINDOW: Duration = Duration::from_secs(60);

/// Clamps a stored or requested (partial) limits object to the allowed range, filling gaps with
/// the defaults (`resolveLimits`). Only finite numbers count; they are floored, then kept within
/// `1..=MAX_TOKEN_LIMITS`.
#[must_use]
pub fn resolve_limits(input: Option<&Value>) -> TokenLimits {
    let pick = |key: &str, default: i64, max: i64| {
        input
            .and_then(|v| v.get(key))
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            // JS clamps in floating point; the result fits easily once clamped to `max`
            .map_or(default, |v| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
                let clamped = v.floor().max(1.0).min(max as f64) as i64;
                clamped
            })
    };
    TokenLimits {
        requests_per_minute: pick(
            "requestsPerMinute",
            DEFAULT_TOKEN_LIMITS.requests_per_minute,
            MAX_TOKEN_LIMITS.requests_per_minute,
        ),
        writes_per_minute: pick(
            "writesPerMinute",
            DEFAULT_TOKEN_LIMITS.writes_per_minute,
            MAX_TOKEN_LIMITS.writes_per_minute,
        ),
        writes_per_day: pick(
            "writesPerDay",
            DEFAULT_TOKEN_LIMITS.writes_per_day,
            MAX_TOKEN_LIMITS.writes_per_day,
        ),
    }
}

#[derive(Clone, Copy)]
struct MinuteWindow {
    at: Instant,
    requests: i64,
    writes: i64,
}

/// Per-minute counters, per process (like the NestJS service); the daily write cap is persisted.
static MINUTE: LazyLock<Mutex<HashMap<String, MinuteWindow>>> = LazyLock::new(Mutex::default);

fn too_many(message: &str) -> AppError {
    // `new HttpException(message, 429)`: no `error` field
    AppError::with_body(
        StatusCode::TOO_MANY_REQUESTS,
        json!({ "statusCode": 429, "message": message }),
    )
}

/// Enforces a token's request and write budget (HTTP 429). Reads count as requests, mutations as
/// requests and writes; the daily write counter lives in `api_token_usage`, so it survives
/// restarts. A mutation refused by the daily cap still counts toward it, as in NestJS.
///
/// # Errors
///
/// 429 with the NestJS wording, or a database error.
pub async fn enforce_limits<C: ConnectionTrait>(
    db: &C,
    token: &api_tokens::Model,
    mutating: bool,
) -> Result<(), AppError> {
    let limits = resolve_limits(Some(&token.limits));
    let now = Instant::now();
    let window = {
        let mut map = MINUTE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        map.retain(|_, w| now.duration_since(w.at) < WINDOW);
        map.get(&token.id).copied().unwrap_or(MinuteWindow { at: now, requests: 0, writes: 0 })
    };
    if window.requests >= limits.requests_per_minute {
        return Err(too_many(&format!(
            "Token limit reached: {} requests per minute. Slow down.",
            limits.requests_per_minute
        )));
    }
    if mutating && window.writes >= limits.writes_per_minute {
        return Err(too_many(&format!(
            "Token limit reached: {} writes per minute. Slow down.",
            limits.writes_per_minute
        )));
    }
    if mutating {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                db.get_database_backend(),
                r#"INSERT INTO api_token_usage ("tokenId", "day", "writes") VALUES ($1, CURRENT_DATE, 1)
                   ON CONFLICT ("tokenId", "day") DO UPDATE SET "writes" = api_token_usage."writes" + 1 RETURNING "writes""#,
                vec![token.id.clone().into()],
            ))
            .await?
            .ok_or_else(|| AppError::internal("api_token_usage returned no row"))?;
        let writes: i32 = row.try_get("", "writes")?;
        if i64::from(writes) > limits.writes_per_day {
            return Err(too_many(&format!(
                "Token limit reached: {} writes per day. Try again tomorrow or raise the limit in Settings.",
                limits.writes_per_day
            )));
        }
    }
    let mut map = MINUTE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let entry = map.entry(token.id.clone()).or_insert(window);
    if mutating {
        entry.writes += 1;
    }
    entry.requests += 1;
    Ok(())
}

/// What [`create_token`] stores.
#[derive(Clone, Debug)]
pub struct NewToken {
    /// Workspace the token belongs to.
    pub workspace_id: String,
    /// Display name.
    pub name: String,
    /// Who the token acts as.
    pub actor: ActorRef,
    /// Scope; `write` when `None`.
    pub scope: Option<TokenScope>,
    /// Permissions of a `custom` token (ignored for other scopes).
    pub permissions: Option<Vec<ApiPermission>>,
    /// Requested limits, partial (see [`resolve_limits`]).
    pub limits: Option<Value>,
    /// The person who created it.
    pub created_by_user_id: Option<String>,
    /// Expiry; never when `None`.
    pub expires_at: Option<chrono::DateTime<chrono::FixedOffset>>,
}

/// A new random secret with the current prefix.
#[must_use]
pub fn generate_secret() -> String {
    let bytes: [u8; 32] = rand::random();
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// `trm_3f9a…`: the first eight characters of the secret and an ellipsis.
#[must_use]
pub fn display_prefix(secret: &str) -> String {
    format!("{}…", secret.chars().take(8).collect::<String>())
}

/// Creates a token; the plaintext secret is returned once and only its sha256 is stored.
///
/// # Errors
///
/// The database error.
pub async fn create_token<C: ConnectionTrait>(
    db: &C,
    input: NewToken,
) -> Result<(api_tokens::Model, String), DbErr> {
    let secret = generate_secret();
    let scope = input.scope.unwrap_or(TokenScope::Write);
    let permissions = (input.scope == Some(TokenScope::Custom))
        .then(|| json!(input.permissions.unwrap_or_default()));
    let limits = resolve_limits(input.limits.as_ref());
    let row = api_tokens::ActiveModel {
        id: Set(uid("tk")),
        workspace_id: Set(input.workspace_id),
        name: Set(input.name),
        prefix: Set(display_prefix(&secret)),
        token_hash: Set(sha256_hex(&secret)),
        actor: Set(json!(input.actor)),
        scope: Set(scope.as_str().to_owned()),
        permissions: Set(permissions),
        limits: Set(json!(limits)),
        created_by_user_id: Set(input.created_by_user_id),
        expires_at: Set(input.expires_at),
        last_used_at: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok((row, secret))
}

/// Deletes a token (and, through the foreign key, its usage counters).
///
/// # Errors
///
/// The database error.
pub async fn revoke<C: ConnectionTrait>(db: &C, id: &str) -> Result<(), DbErr> {
    api_tokens::Entity::delete_many().filter(api_tokens::Column::Id.eq(id)).exec(db).await?;
    Ok(())
}

/// Resolves a bearer secret to its unexpired token, touching `lastUsedAt` at most once a
/// minute. A secret without a known prefix is refused without a query.
///
/// # Errors
///
/// The database error.
pub async fn authenticate<C: ConnectionTrait>(
    db: &C,
    secret: &str,
) -> Result<Option<AuthToken>, DbErr> {
    if !secret.starts_with(TOKEN_PREFIX) && !secret.starts_with(LEGACY_TOKEN_PREFIX) {
        return Ok(None);
    }
    let now = Utc::now();
    let Some(mut row) = api_tokens::Entity::find()
        .filter(api_tokens::Column::TokenHash.eq(sha256_hex(secret)))
        .filter(
            sea_orm::Condition::any()
                .add(api_tokens::Column::ExpiresAt.is_null())
                .add(api_tokens::Column::ExpiresAt.gt(now)),
        )
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    if row.expires_at.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    if row.last_used_at.is_none_or(|at| now.signed_duration_since(at) > TOUCH_EVERY) {
        let at = now.fixed_offset();
        api_tokens::Entity::update_many()
            .col_expr(api_tokens::Column::LastUsedAt, Expr::value(at))
            .filter(api_tokens::Column::Id.eq(row.id.clone()))
            .exec(db)
            .await?;
        row.last_used_at = Some(at);
    }
    Ok(AuthToken::from_row(row))
}

/// An API token as the API sends it (`ApiTokenEntity.toJSON()`): the row without `tokenHash`
/// and `createdByUserId`, null fields omitted, JSON columns as stored.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ApiToken)]
pub struct ApiTokenView {
    /// Token id.
    pub id: String,
    /// Workspace id.
    pub workspace_id: String,
    /// Display name.
    pub name: String,
    /// First characters of the secret, e.g. `trm_3f9a…`.
    pub prefix: String,
    /// The actor the token acts as.
    #[schema(value_type = ActorRef)]
    pub actor: Value,
    /// `read`, `write`, `admin` or `custom`.
    #[schema(value_type = TokenScope)]
    pub scope: String,
    /// Granted permissions; only for `custom` tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Vec<ApiPermission>>)]
    pub permissions: Option<Value>,
    /// Request and write budget.
    #[schema(value_type = TokenLimits)]
    pub limits: Value,
    /// Last use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    /// Creation time.
    pub created_at: String,
    /// Expiry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl From<&api_tokens::Model> for ApiTokenView {
    fn from(row: &api_tokens::Model) -> Self {
        Self {
            id: row.id.clone(),
            workspace_id: row.workspace_id.clone(),
            name: row.name.clone(),
            prefix: row.prefix.clone(),
            actor: row.actor.clone(),
            scope: row.scope.clone(),
            permissions: row.permissions.clone().filter(|v| !v.is_null()),
            limits: row.limits.clone(),
            last_used_at: row.last_used_at.as_ref().map(to_iso),
            created_at: to_iso(&row.created_at),
            expires_at: row.expires_at.as_ref().map(to_iso),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_limits() {
        assert_eq!(resolve_limits(None), DEFAULT_TOKEN_LIMITS);
        assert_eq!(
            resolve_limits(Some(
                &json!({ "writesPerDay": 5, "writesPerMinute": 2.9, "requestsPerMinute": -4 })
            )),
            TokenLimits { requests_per_minute: 1, writes_per_minute: 2, writes_per_day: 5 }
        );
        assert_eq!(
            resolve_limits(Some(&json!({ "writesPerDay": 10_000_000, "requestsPerMinute": "9" }))),
            TokenLimits { writes_per_day: MAX_TOKEN_LIMITS.writes_per_day, ..DEFAULT_TOKEN_LIMITS }
        );
    }

    #[test]
    fn issues_trm_secrets_with_a_display_prefix() {
        let secret = generate_secret();
        assert!(secret.starts_with(TOKEN_PREFIX));
        assert_eq!(TOKEN_PREFIX, "trm_");
        assert_eq!(secret.len(), 4 + 43);
        assert_eq!(display_prefix(&secret), format!("{}…", &secret[..8]));
    }

    #[tokio::test]
    async fn rejects_unknown_prefixes_without_a_query() {
        // a disconnected pool: any query would panic
        let db = sea_orm::DatabaseConnection::default();
        assert_eq!(authenticate(&db, "xyz_abcdef").await.unwrap(), None);
        assert_eq!(authenticate(&db, "").await.unwrap(), None);
    }
}
