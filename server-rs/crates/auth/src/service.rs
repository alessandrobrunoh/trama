//! Accounts and browser sessions: the port of `server/src/auth/auth.service.ts`.
//!
//! Passwords are argon2id PHC strings with the parameters of the NestJS `argon2` package
//! (64 MiB, 3 passes, 4 lanes, 32-byte hash, 16-byte salt), so hashes written by either server
//! verify on the other. Hashing runs on the blocking pool.
//!
//! A session cookie holds 32 random bytes in base64url; the `sessions` row stores only its
//! sha256 as the id.

use std::sync::LazyLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    Set,
};
use serde::Serialize;
use tokio::sync::OnceCell;
use trama_common::crypto::sha256_hex;
use trama_common::util::is_unique_violation;
use trama_contracts::identity::Workspace;
use trama_contracts::js;
use trama_core::AppError;
use trama_core::ids::uid;
use trama_entities::{memberships, sessions, users, workspaces};
use utoipa::ToSchema;

/// Name of the session cookie.
pub const SESSION_COOKIE: &str = "trama_session";
/// Cookie name before the rename: still read, so nobody is signed out; cleared whenever a
/// session is set or cleared.
pub const LEGACY_SESSION_COOKIE: &str = "nabla_session";
/// Session lifetime: 30 days.
pub const SESSION_TTL: chrono::TimeDelta = chrono::TimeDelta::days(30);

/// 401 of a failed login.
pub const INVALID_CREDENTIALS: &str = "Invalid email or password";

fn argon2() -> Argon2<'static> {
    let params = Params::new(65_536, 3, 4, Some(32)).unwrap_or_else(|e| unreachable!("{e}"));
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// argon2id hash of `password` (`argon2.hash`), off the async executor.
///
/// # Errors
///
/// 500 when hashing fails.
pub async fn hash_password(password: &str) -> Result<String, AppError> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        argon2().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .map_err(AppError::internal)?
    .map_err(|e| AppError::internal(e.to_string()))
}

/// Does `password` match the PHC `hash`? A malformed hash is a mismatch
/// (`argon2.verify(...).catch(() => false)`).
pub async fn verify_password(hash: &str, password: &str) -> bool {
    let (hash, password) = (hash.to_owned(), password.to_owned());
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .is_ok_and(|parsed| argon2().verify_password(password.as_bytes(), &parsed).is_ok())
    })
    .await
    .unwrap_or(false)
}

/// A real hash verified for unknown emails, so timing does not reveal whether one exists.
static DUMMY_HASH: LazyLock<OnceCell<String>> = LazyLock::new(OnceCell::new);

async fn dummy_hash() -> String {
    DUMMY_HASH
        .get_or_init(|| async { hash_password("trama-timing-equalizer").await.unwrap_or_default() })
        .await
        .clone()
}

/// `email.trim().toLowerCase()`.
#[must_use]
pub fn normalize_email(email: &str) -> String {
    js::trim(email).to_lowercase()
}

/// What sign-up stores.
#[derive(Clone, Debug)]
pub struct NewUser<'a> {
    /// Display name (trimmed here).
    pub name: &'a str,
    /// Email (trimmed and lower-cased here).
    pub email: &'a str,
    /// Plain password.
    pub password: &'a str,
}

/// Creates an account. 409 `Email already registered` when the email is taken.
///
/// # Errors
///
/// 409, or a database error.
pub async fn create_user<C: ConnectionTrait>(
    db: &C,
    input: NewUser<'_>,
) -> Result<users::Model, AppError> {
    const TAKEN: &str = "Email already registered";
    let email = normalize_email(input.email);
    let exists =
        users::Entity::find().filter(users::Column::Email.eq(email.clone())).one(db).await?;
    if exists.is_some() {
        return Err(AppError::conflict(TAKEN));
    }
    let password_hash = hash_password(input.password).await?;
    let hue: i32 = rand::random_range(0..360);
    users::ActiveModel {
        id: Set(uid("usr")),
        name: Set(js::trim(input.name).to_owned()),
        email: Set(email),
        password_hash: Set(password_hash),
        avatar_hue: Set(hue),
        ..Default::default()
    }
    .insert(db)
    .await
    // a parallel sign-up with the same email lost the race
    .map_err(|e| if is_unique_violation(&e) { AppError::conflict(TAKEN) } else { e.into() })
}

/// The account for these credentials, or 401 `Invalid email or password`.
///
/// # Errors
///
/// 401, or a database error.
pub async fn verify_credentials<C: ConnectionTrait>(
    db: &C,
    email: &str,
    password: &str,
) -> Result<users::Model, AppError> {
    let user = users::Entity::find()
        .filter(users::Column::Email.eq(normalize_email(email)))
        .one(db)
        .await?;
    // always verify something so timing doesn't reveal whether the email exists
    let hash = match &user {
        Some(u) => u.password_hash.clone(),
        None => dummy_hash().await,
    };
    let ok = verify_password(&hash, password).await;
    match user {
        Some(user) if ok => Ok(user),
        _ => Err(AppError::new(axum::http::StatusCode::UNAUTHORIZED, INVALID_CREDENTIALS)),
    }
}

/// `sha256(raw)` in hex: the session id stored for a cookie value.
#[must_use]
pub fn hash_session(raw: &str) -> String {
    sha256_hex(raw)
}

/// A new session: the raw cookie value (only its sha256 is stored) and the expiry.
#[derive(Clone, Debug)]
pub struct NewSession {
    /// Value of the cookie.
    pub raw: String,
    /// When the session ends.
    pub expires_at: chrono::DateTime<Utc>,
}

/// Creates a session row and removes expired ones.
///
/// # Errors
///
/// The database error.
pub async fn create_session<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    user_agent: Option<&str>,
) -> Result<NewSession, DbErr> {
    let bytes: [u8; 32] = rand::random();
    let raw = URL_SAFE_NO_PAD.encode(bytes);
    let expires_at = Utc::now() + SESSION_TTL;
    sessions::ActiveModel {
        id: Set(hash_session(&raw)),
        user_id: Set(user_id.to_owned()),
        expires_at: Set(expires_at.fixed_offset()),
        user_agent: Set(user_agent.map(|ua| js::truncate(ua, 255).to_owned())),
        ..Default::default()
    }
    .insert(db)
    .await?;
    // opportunistic cleanup
    sessions::Entity::delete_many()
        .filter(sessions::Column::ExpiresAt.lt(Utc::now()))
        .exec(db)
        .await?;
    Ok(NewSession { raw, expires_at })
}

/// The user behind a cookie value and the session id. An expired session, or one whose user is
/// gone, is deleted and yields `None`.
///
/// # Errors
///
/// The database error.
pub async fn authenticate_session<C: ConnectionTrait>(
    db: &C,
    raw: &str,
) -> Result<Option<(users::Model, String)>, DbErr> {
    let id = hash_session(raw);
    let Some(session) = sessions::Entity::find_by_id(id.clone()).one(db).await? else {
        return Ok(None);
    };
    if session.expires_at <= Utc::now() {
        destroy_session(db, &id).await?;
        return Ok(None);
    }
    let Some(user) = users::Entity::find_by_id(session.user_id).one(db).await? else {
        destroy_session(db, &id).await?;
        return Ok(None);
    };
    Ok(Some((user, id)))
}

/// Deletes a session.
///
/// # Errors
///
/// The database error.
pub async fn destroy_session<C: ConnectionTrait>(db: &C, session_id: &str) -> Result<(), DbErr> {
    sessions::Entity::delete_many().filter(sessions::Column::Id.eq(session_id)).exec(db).await?;
    Ok(())
}

/// A workspace with the caller's role in it (`WorkspaceWithRole`): the workspace JSON plus
/// `role`.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct WorkspaceWithRole {
    /// The workspace.
    #[serde(flatten)]
    pub workspace: Workspace,
    /// The caller's role id.
    pub role: String,
}

impl WorkspaceWithRole {
    /// `workspace` with `role`.
    #[must_use]
    pub fn new(row: &workspaces::Model, role: impl Into<String>) -> Self {
        Self { workspace: Workspace::from(row), role: role.into() }
    }
}

/// Workspaces the user belongs to, with their role, oldest first.
///
/// # Errors
///
/// The database error.
pub async fn workspaces_of<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
) -> Result<Vec<WorkspaceWithRole>, DbErr> {
    let rows = workspaces::Entity::find()
        .find_also_related(memberships::Entity)
        .filter(memberships::Column::UserId.eq(user_id))
        .order_by_asc(workspaces::Column::CreatedAt)
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(ws, m)| m.map(|m| WorkspaceWithRole::new(&ws, m.role)))
        .collect())
}
