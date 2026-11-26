//! The person's own workspace, created at sign-up (and at a login that finds none): the port of
//! `server/src/workspaces/personal-workspace.ts`, with the slug rules of
//! `server/src/workspaces/workspace-slug.ts` it needs.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, Set, TransactionError, TransactionTrait,
};
use serde_json::json;
use trama_common::util::{is_unique_violation, slugify};
use trama_contracts::js;
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::AppError;
use trama_core::ids::uid;
use trama_entities::{memberships, users, workspaces};

use crate::service::WorkspaceWithRole;

/// Slugs that would collide with client routes (`RESERVED_SLUGS`).
pub const RESERVED_SLUGS: &[&str] = &[
    "login",
    "signup",
    "register",
    "blog",
    "roadmap",
    "changelog",
    "compare",
    "why",
    "brand",
    "404",
    "new-workspace",
    "settings",
    "api",
    "admin",
    "auth",
    "workspaces",
    "invite",
    "shared",
    "my-tasks",
];

/// Longest slug (`SLUG_MAX`).
pub const SLUG_MAX: usize = 40;

/// `SLUG_RE`: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`.
#[must_use]
pub fn is_valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (3..=SLUG_MAX).contains(&bytes.len())
        && alnum(&bytes[0])
        && alnum(&bytes[bytes.len() - 1])
        && bytes.iter().all(|b| alnum(b) || *b == b'-')
}

fn trim_trailing_dashes(s: &str) -> &str {
    s.trim_end_matches('-')
}

/// A valid, non-reserved slug derived from a name, never longer than [`SLUG_MAX`] (`baseSlug`).
#[must_use]
pub fn base_slug(name: &str, fallback: &str) -> String {
    let slug = slugify(name);
    let base = if slug.is_empty() { fallback.to_owned() } else { slug };
    if !RESERVED_SLUGS.contains(&base.as_str()) && base.len() >= 3 {
        return base;
    }
    let cut: String = base.chars().take(SLUG_MAX - 3).collect();
    format!("{}-ws", trim_trailing_dashes(&cut))
}

/// `root-2`, `root-3`… trimmed so the result still fits [`SLUG_MAX`] (`slugWithSuffix`).
#[must_use]
pub fn slug_with_suffix(root: &str, n: usize) -> String {
    let suffix = format!("-{n}");
    let cut: String = root.chars().take(SLUG_MAX.saturating_sub(suffix.len())).collect();
    format!("{}{suffix}", trim_trailing_dashes(&cut))
}

/// First free slug for `name`, given a synchronous "is it taken" check (`freeSlug`).
#[must_use]
pub fn free_slug(name: &str, is_taken: impl Fn(&str) -> bool, fallback: &str) -> String {
    let root = base_slug(name, fallback);
    let mut slug = root.clone();
    let mut n = 2;
    while is_taken(&slug) {
        slug = slug_with_suffix(&root, n);
        n += 1;
    }
    slug
}

const ATTEMPTS: usize = 6;

async fn find_personal<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
) -> Result<Option<workspaces::Model>, AppError> {
    Ok(workspaces::Entity::find()
        .filter(workspaces::Column::PrimaryOwnerId.eq(user_id))
        .filter(workspaces::Column::Personal.eq(true))
        .one(db)
        .await?)
}

async fn slug_taken<C: ConnectionTrait>(db: &C, slug: &str) -> Result<bool, AppError> {
    Ok(workspaces::Entity::find().filter(workspaces::Column::Slug.eq(slug)).count(db).await? > 0)
}

/// The person's personal workspace, created when they have none yet. Named after them, with a
/// free, non-reserved slug derived from the name. Idempotent and safe under concurrency: the
/// partial unique index on `primaryOwnerId` allows one, and a slug collision retries.
///
/// # Errors
///
/// 409 `Could not pick an address for your personal workspace` after six collisions, or a
/// database error.
pub async fn ensure_personal_workspace(
    db: &DatabaseConnection,
    user: &users::Model,
) -> Result<WorkspaceWithRole, AppError> {
    if let Some(existing) = find_personal(db, &user.id).await? {
        return Ok(WorkspaceWithRole::new(&existing, "owner"));
    }
    let root = base_slug(&user.name, "personal");
    let name = js::truncate(js::trim(&user.name), 80);
    let name = if name.is_empty() { "Personal" } else { name };
    for attempt in 0..ATTEMPTS {
        let mut slug = root.clone();
        let mut n = 2;
        while slug_taken(db, &slug).await? {
            slug = slug_with_suffix(&root, n + attempt);
            n += 1;
        }
        let (user_id, name, slug) = (user.id.clone(), name.to_owned(), slug);
        let created = db
            .transaction::<_, workspaces::Model, sea_orm::DbErr>(|txn| {
                Box::pin(async move {
                    let workspace = workspaces::ActiveModel {
                        id: Set(uid("ws")),
                        name: Set(name),
                        slug: Set(slug),
                        primary_owner_id: Set(Some(user_id.clone())),
                        personal: Set(true),
                        settings: Set(json!({ "roles": fresh_workspace_roles() })),
                        ..Default::default()
                    }
                    .insert(txn)
                    .await?;
                    memberships::ActiveModel {
                        id: Set(uid("mb")),
                        workspace_id: Set(workspace.id.clone()),
                        user_id: Set(user_id),
                        role: Set("owner".to_owned()),
                        access: Set(None),
                        ..Default::default()
                    }
                    .insert(txn)
                    .await?;
                    Ok(workspace)
                })
            })
            .await;
        match created {
            Ok(workspace) => return Ok(WorkspaceWithRole::new(&workspace, "owner")),
            Err(TransactionError::Transaction(err) | TransactionError::Connection(err))
                if is_unique_violation(&err) =>
            {
                // either the person already got one in a parallel request, or the slug was
                // taken in between
                if let Some(raced) = find_personal(db, &user.id).await? {
                    return Ok(WorkspaceWithRole::new(&raced, "owner"));
                }
            }
            Err(TransactionError::Transaction(err) | TransactionError::Connection(err)) => {
                return Err(err.into());
            }
        }
    }
    Err(AppError::conflict("Could not pick an address for your personal workspace"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_slugs_like_nest() {
        assert_eq!(base_slug("Ada Lovelace", "personal"), "ada-lovelace");
        assert_eq!(base_slug("日本", "personal"), "personal");
        assert_eq!(base_slug("Al", "personal"), "al-ws");
        assert_eq!(base_slug("Settings", "personal"), "settings-ws");
        assert_eq!(base_slug(&"a".repeat(60), "x").len(), 40);
        assert_eq!(slug_with_suffix("ada", 2), "ada-2");
        assert_eq!(slug_with_suffix(&"a".repeat(40), 12), format!("{}-12", "a".repeat(37)));
        assert_eq!(free_slug("Ada", |s| s == "ada" || s == "ada-2", "workspace"), "ada-3");
        assert!(is_valid_slug("ada-3"));
        assert!(!is_valid_slug("ad"));
        assert!(!is_valid_slug("-ada"));
        assert!(!is_valid_slug("Ada"));
    }
}
