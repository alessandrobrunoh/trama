//! `StreamAuthService` and `closeWhenInvalid` of `server/src/events/stream-auth.ts`.
//!
//! An SSE stream is authenticated once, when it opens. [`is_still_valid`] re-runs the checks that
//! matter for a long-lived connection: the session or API token still exists and has not
//! expired, and the caller is still a member of the workspace (or the agent still exists in it)
//! with the same role, capabilities and project access the stream opened with.

use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::Value;
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use trama_auth::{AuthInfo, WorkspaceContext};
use trama_contracts::access::effective_member_access;
use trama_contracts::common::ActorType;
use trama_contracts::identity::stored_member_access;
use trama_contracts::roles::{agent_workspace_role, apply_token_scope, find_workspace_role};
use trama_contracts::settings::resolve_workspace_settings;
use trama_entities::{agents, api_tokens, memberships, sessions, workspaces};

/// `permissions ?? []`, as `JSON.stringify` compares them.
fn permissions_of(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(v) => v.clone(),
    }
}

/// Whether the stream that `auth` opened on `ctx` may stay open at `now`.
///
/// # Errors
///
/// A database error; the caller closes the stream then (authorization cannot be confirmed
/// during an outage).
pub async fn is_still_valid<C: ConnectionTrait>(
    db: &C,
    auth: &AuthInfo,
    ctx: &WorkspaceContext,
    now: DateTime<Utc>,
) -> Result<bool, DbErr> {
    let workspace_id = ctx.workspace_id();
    if let Some(captured) = &auth.token {
        let Some(token) = api_tokens::Entity::find_by_id(captured.row.id.clone()).one(db).await?
        else {
            return Ok(false);
        };
        if token.workspace_id != workspace_id {
            return Ok(false);
        }
        if token.expires_at.is_some_and(|at| at <= now) {
            return Ok(false);
        }
        if token.scope != captured.row.scope
            || permissions_of(token.permissions.as_ref())
                != permissions_of(captured.row.permissions.as_ref())
        {
            return Ok(false);
        }
    } else {
        let Some(session_id) = &auth.session_id else { return Ok(false) };
        let session = sessions::Entity::find_by_id(session_id.clone()).one(db).await?;
        if session.is_none_or(|s| s.expires_at <= now) {
            return Ok(false);
        }
    }

    let Some(workspace) = workspaces::Entity::find_by_id(workspace_id).one(db).await? else {
        return Ok(false);
    };
    let (member_role, stored_access) = if let Some(user) = &auth.user {
        let Some(membership) = memberships::Entity::find()
            .filter(memberships::Column::WorkspaceId.eq(workspace_id))
            .filter(memberships::Column::UserId.eq(user.id.clone()))
            .one(db)
            .await?
        else {
            return Ok(false);
        };
        (membership.role, stored_member_access(membership.access.as_ref()))
    } else if auth.actor.kind == ActorType::Agent
        && let Some(id) = auth.actor.id.as_ref().filter(|id| !id.is_empty())
    {
        let exists = agents::Entity::find()
            .filter(agents::Column::Id.eq(id.clone()))
            .filter(agents::Column::WorkspaceId.eq(workspace_id))
            .count(db)
            .await?
            > 0;
        if !exists {
            return Ok(false);
        }
        ("member".to_owned(), None)
    } else {
        return Ok(false);
    };

    let role = if auth.actor.kind == ActorType::Agent {
        agent_workspace_role()
    } else {
        let settings = resolve_workspace_settings(&workspace.settings);
        let Some(role) = find_workspace_role(&settings.roles, Some(&member_role)).cloned() else {
            return Ok(false);
        };
        role
    };
    let effective = apply_token_scope(&role, auth.token_scope());
    let access = effective_member_access(Some(&effective), stored_access.as_ref());
    Ok(ctx.role == member_role
        && ctx.member_role == member_role
        && ctx.token_scope == auth.token_scope()
        && ctx.owner == effective.owner
        && ctx.capabilities == effective.capabilities
        && ctx.access == access)
}

/// Resolves the first time `is_valid` answers `false` or fails (`closeWhenInvalid`), checking
/// every `every` from `every` on. A tick that falls while a check runs is skipped, like
/// `exhaustMap`. Select on it next to the stream to close the stream then.
pub async fn invalidated<F, Fut, E>(mut is_valid: F, every: Duration)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<bool, E>>,
{
    let mut ticks = interval_at(Instant::now() + every, every);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        if !matches!(is_valid().await, Ok(true)) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn resolves_on_the_first_failed_check_and_not_before() {
        let valid = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let check = {
            let (valid, calls) = (Arc::clone(&valid), Arc::clone(&calls));
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let ok = valid.load(Ordering::SeqCst);
                async move { Ok::<_, ()>(ok) }
            }
        };
        let done = tokio::spawn(invalidated(check, Duration::from_secs(1)));
        tokio::time::sleep(Duration::from_millis(3_100)).await;
        assert!(!done.is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        valid.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(done.is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn resolves_when_authorization_cannot_be_revalidated() {
        let calls = Arc::new(AtomicUsize::new(0));
        let check = {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err::<bool, _>("db down") }
            }
        };
        let done = tokio::spawn(invalidated(check, Duration::from_secs(1)));
        tokio::time::sleep(Duration::from_millis(1_001)).await;
        assert!(done.is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn recheck_interval_defaults_to_30_seconds_and_accepts_an_override() {
        use trama_core::Config;
        assert_eq!(Config::from_vars(&[]).sse_recheck_ms, 30_000);
        assert_eq!(Config::from_vars(&[("TRAMA_SSE_RECHECK_MS", "abc")]).sse_recheck_ms, 30_000);
        assert_eq!(Config::from_vars(&[("TRAMA_SSE_RECHECK_MS", "5000")]).sse_recheck_ms, 5_000);
    }
}
