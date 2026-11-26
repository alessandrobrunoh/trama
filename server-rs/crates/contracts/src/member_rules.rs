//! Who may remove or demote whom (`server/src/workspaces/member-rules.ts`).
//!
//! - The primary owner (the creator, until ownership is transferred) can never be removed or
//!   demoted by anyone else (403). To stop being owner they transfer ownership first; leaving or
//!   stepping down before that is 409.
//! - Only the primary owner removes or demotes other owners (403 for admins, who cannot touch
//!   owners at all, and for other owners). An owner may always step down or leave on their own.
//! - A workspace always keeps at least one owner (409).
//! - Workspaces without a recorded primary owner (legacy rows) fall back to "any owner may act
//!   on owners".

use trama_core::AppError;

use crate::roles::{TokenScope, legacy_role_at_least};

/// The caller of a membership change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemberActor<'a> {
    /// Role id of the caller. A read or write token does not change this;
    /// `can_manage_members` does.
    pub role: &'a str,
    /// The caller's user id (absent for an agent token).
    pub user_id: Option<&'a str>,
    /// When set, replaces the legacy admin rank for acting on someone who is not an owner.
    pub can_manage_members: Option<bool>,
    /// Caps what this caller can grant. A write token cannot hand out the owner role.
    pub token_scope: Option<TokenScope>,
}

/// The membership being changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberTarget<'a> {
    /// Their user id.
    pub user_id: &'a str,
    /// Their current role id.
    pub role: &'a str,
}

/// The workspace facts the rules need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberRuleContext<'a> {
    /// `workspaces.primaryOwnerId`.
    pub primary_owner_id: Option<&'a str>,
    /// Number of owners the workspace has right now.
    pub owner_count: u64,
}

/// 403 message when someone else tries to remove or demote the primary owner.
pub const PRIMARY_OWNER_PROTECTED: &str = "The workspace owner cannot be removed or demoted by someone else. They can transfer ownership first.";

fn is_primary(primary_owner_id: Option<&str>, user_id: Option<&str>) -> bool {
    matches!((primary_owner_id, user_id), (Some(p), Some(u)) if !p.is_empty() && !u.is_empty() && p == u)
}

fn is_self(actor: &MemberActor<'_>, target: &MemberTarget<'_>) -> bool {
    actor.user_id.is_some_and(|u| !u.is_empty() && u == target.user_id)
}

fn has_primary(ws: Option<&str>) -> bool {
    ws.is_some_and(|p| !p.is_empty())
}

/// May this caller act on `target` as an owner-level change (remove or demote)?
fn assert_can_act_on_owner(
    ws: &MemberRuleContext<'_>,
    actor: &MemberActor<'_>,
    target: &MemberTarget<'_>,
    verb: &str,
) -> Result<(), AppError> {
    if is_self(actor, target) {
        return Ok(());
    }
    if is_primary(ws.primary_owner_id, Some(target.user_id)) {
        return Err(AppError::forbidden(PRIMARY_OWNER_PROTECTED));
    }
    if actor.role != "owner" {
        return Err(AppError::forbidden(format!("Only an owner can {verb} an owner")));
    }
    // with a recorded primary owner, other owners are peers: only the primary owner governs them
    if has_primary(ws.primary_owner_id) && !is_primary(ws.primary_owner_id, actor.user_id) {
        return Err(AppError::forbidden(format!(
            "Only the workspace owner can {verb} another owner"
        )));
    }
    Ok(())
}

fn assert_still_has_owner(
    ws: &MemberRuleContext<'_>,
    target: &MemberTarget<'_>,
    verb: &str,
) -> Result<(), AppError> {
    if target.role == "owner" && ws.owner_count <= 1 {
        return Err(AppError::conflict(format!(
            "A workspace needs at least one owner: transfer ownership before you {verb}"
        )));
    }
    Ok(())
}

fn assert_primary_owner_transfers_first(
    ws: &MemberRuleContext<'_>,
    target: &MemberTarget<'_>,
    verb: &str,
) -> Result<(), AppError> {
    if is_primary(ws.primary_owner_id, Some(target.user_id)) {
        return Err(AppError::conflict(format!(
            "Transfer ownership to another member before you {verb}"
        )));
    }
    Ok(())
}

/// Removing a membership (or leaving: caller = target).
///
/// # Errors
///
/// 403 or 409 as described in the module docs.
pub fn assert_can_remove_member(
    ws: &MemberRuleContext<'_>,
    actor: &MemberActor<'_>,
    target: &MemberTarget<'_>,
) -> Result<(), AppError> {
    let own = is_self(actor, target);
    let can_manage =
        actor.can_manage_members.unwrap_or_else(|| legacy_role_at_least(actor.role, "admin"));
    if !own && !can_manage {
        return Err(AppError::forbidden("You are not allowed to remove members"));
    }
    if target.role != "owner" {
        return Ok(());
    }
    assert_can_act_on_owner(ws, actor, target, "remove")?;
    if own {
        assert_primary_owner_transfers_first(ws, target, "leave")?;
    }
    assert_still_has_owner(ws, target, "leave")
}

/// Changing a role to `next`. Demoting an owner counts as removing them; promoting is checked by
/// the caller.
///
/// # Errors
///
/// 403 or 409 as described in the module docs.
pub fn assert_can_change_role(
    ws: &MemberRuleContext<'_>,
    actor: &MemberActor<'_>,
    target: &MemberTarget<'_>,
    next: &str,
) -> Result<(), AppError> {
    if target.role != "owner" || next == "owner" {
        return Ok(());
    }
    assert_can_act_on_owner(ws, actor, target, "demote")?;
    if is_self(actor, target) {
        assert_primary_owner_transfers_first(ws, target, "step down")?;
    }
    assert_still_has_owner(ws, target, "step down")
}

/// Only the primary owner (any owner when none is recorded) hands the workspace over, and only to
/// another member.
///
/// # Errors
///
/// 403 when the caller may not transfer, 409 when the target already owns the workspace.
pub fn assert_can_transfer_ownership(
    primary_owner_id: Option<&str>,
    actor: &MemberActor<'_>,
    target_user_id: &str,
) -> Result<(), AppError> {
    if actor.role != "owner" {
        return Err(AppError::forbidden("Only an owner can transfer ownership"));
    }
    if has_primary(primary_owner_id) && !is_primary(primary_owner_id, actor.user_id) {
        return Err(AppError::forbidden("Only the workspace owner can transfer ownership"));
    }
    if primary_owner_id == Some(target_user_id) {
        return Err(AppError::conflict("That person already owns the workspace"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORBIDDEN: u16 = 403;
    const CONFLICT: u16 = 409;

    const PRIMARY: &str = "u_primary";
    const OTHER_OWNER: &str = "u_owner2";
    const ADMIN: &str = "u_admin";
    const MEMBER: &str = "u_member";

    fn ws(primary: Option<&'static str>, owner_count: u64) -> MemberRuleContext<'static> {
        MemberRuleContext { primary_owner_id: primary, owner_count }
    }

    fn default_ws() -> MemberRuleContext<'static> {
        ws(Some(PRIMARY), 2)
    }

    fn actor<'a>(user_id: &'a str, role: &'a str) -> MemberActor<'a> {
        MemberActor { role, user_id: Some(user_id), ..MemberActor::default() }
    }

    fn target<'a>(user_id: &'a str, role: &'a str) -> MemberTarget<'a> {
        MemberTarget { user_id, role }
    }

    fn status(result: Result<(), AppError>) -> Option<u16> {
        result.err().map(|e| e.status_code().as_u16())
    }

    fn message(result: Result<(), AppError>) -> String {
        result.err().map(|e| e.to_string()).unwrap_or_default()
    }

    // removing a member
    #[test]
    fn members_cannot_remove_anyone_else_but_may_leave() {
        assert_eq!(
            status(assert_can_remove_member(
                &default_ws(),
                &actor(MEMBER, "member"),
                &target(ADMIN, "admin")
            )),
            Some(FORBIDDEN)
        );
        assert_eq!(
            status(assert_can_remove_member(
                &default_ws(),
                &actor(MEMBER, "member"),
                &target(MEMBER, "member")
            )),
            None
        );
    }

    #[test]
    fn admins_remove_members_and_other_admins_but_never_an_owner() {
        let w = default_ws();
        assert_eq!(
            status(assert_can_remove_member(&w, &actor(ADMIN, "admin"), &target(MEMBER, "member"))),
            None
        );
        assert_eq!(
            status(assert_can_remove_member(
                &w,
                &actor(ADMIN, "admin"),
                &target(OTHER_OWNER, "owner")
            )),
            Some(FORBIDDEN)
        );
        assert!(
            message(assert_can_remove_member(
                &w,
                &actor(ADMIN, "admin"),
                &target(PRIMARY, "owner")
            ))
            .ends_with(PRIMARY_OWNER_PROTECTED)
        );
    }

    #[test]
    fn the_primary_owner_can_never_be_removed_by_another_owner() {
        let w = default_ws();
        let result = || {
            assert_can_remove_member(&w, &actor(OTHER_OWNER, "owner"), &target(PRIMARY, "owner"))
        };
        assert!(message(result()).ends_with(PRIMARY_OWNER_PROTECTED));
        assert_eq!(status(result()), Some(FORBIDDEN));
    }

    #[test]
    fn a_non_primary_owner_cannot_remove_another_non_primary_owner() {
        let w = ws(Some(PRIMARY), 3);
        assert_eq!(
            status(assert_can_remove_member(
                &w,
                &actor(OTHER_OWNER, "owner"),
                &target("u_owner3", "owner")
            )),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn the_primary_owner_can_remove_another_owner() {
        assert_eq!(
            status(assert_can_remove_member(
                &default_ws(),
                &actor(PRIMARY, "owner"),
                &target(OTHER_OWNER, "owner")
            )),
            None
        );
    }

    #[test]
    fn an_owner_who_is_not_the_primary_owner_may_leave_on_their_own() {
        assert_eq!(
            status(assert_can_remove_member(
                &default_ws(),
                &actor(OTHER_OWNER, "owner"),
                &target(OTHER_OWNER, "owner")
            )),
            None
        );
    }

    #[test]
    fn the_primary_owner_cannot_leave_before_transferring_ownership() {
        assert_eq!(
            status(assert_can_remove_member(
                &default_ws(),
                &actor(PRIMARY, "owner"),
                &target(PRIMARY, "owner")
            )),
            Some(CONFLICT)
        );
    }

    #[test]
    fn the_last_owner_can_never_be_removed() {
        let solo = ws(None, 1);
        assert_eq!(
            status(assert_can_remove_member(
                &solo,
                &actor(OTHER_OWNER, "owner"),
                &target(OTHER_OWNER, "owner")
            )),
            Some(CONFLICT)
        );
        assert_eq!(
            status(assert_can_remove_member(
                &solo,
                &actor(PRIMARY, "owner"),
                &target(PRIMARY, "owner")
            )),
            Some(CONFLICT)
        );
    }

    #[test]
    fn legacy_workspaces_without_a_primary_owner_keep_the_old_rule() {
        let legacy = ws(None, 2);
        assert_eq!(
            status(assert_can_remove_member(
                &legacy,
                &actor(OTHER_OWNER, "owner"),
                &target(PRIMARY, "owner")
            )),
            None
        );
        assert_eq!(
            status(assert_can_remove_member(
                &legacy,
                &actor(ADMIN, "admin"),
                &target(PRIMARY, "owner")
            )),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn a_token_without_a_user_cannot_remove_an_owner() {
        let agent = MemberActor { role: "member", ..MemberActor::default() };
        assert_eq!(
            status(assert_can_remove_member(&default_ws(), &agent, &target(OTHER_OWNER, "owner"))),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn can_manage_members_replaces_the_admin_rank() {
        let custom = MemberActor {
            role: "role_support",
            user_id: Some("u_s"),
            can_manage_members: Some(true),
            token_scope: None,
        };
        assert_eq!(
            status(assert_can_remove_member(&default_ws(), &custom, &target(MEMBER, "member"))),
            None
        );
        let capped = MemberActor {
            role: "admin",
            user_id: Some(ADMIN),
            can_manage_members: Some(false),
            token_scope: None,
        };
        assert_eq!(
            status(assert_can_remove_member(&default_ws(), &capped, &target(MEMBER, "member"))),
            Some(FORBIDDEN)
        );
    }

    // changing a role
    #[test]
    fn promoting_or_moving_non_owners_is_not_restricted_here() {
        let w = default_ws();
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(ADMIN, "admin"),
                &target(MEMBER, "member"),
                "admin"
            )),
            None
        );
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(OTHER_OWNER, "owner"),
                &target(MEMBER, "member"),
                "owner"
            )),
            None
        );
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(ADMIN, "admin"),
                &target(OTHER_OWNER, "owner"),
                "owner"
            )),
            None
        );
    }

    #[test]
    fn demoting_the_primary_owner_is_refused_to_everyone_else() {
        let w = default_ws();
        assert!(
            message(assert_can_change_role(
                &w,
                &actor(OTHER_OWNER, "owner"),
                &target(PRIMARY, "owner"),
                "admin"
            ))
            .ends_with(PRIMARY_OWNER_PROTECTED)
        );
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(ADMIN, "admin"),
                &target(PRIMARY, "owner"),
                "member"
            )),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn the_primary_owner_cannot_step_down_before_transferring_ownership() {
        assert_eq!(
            status(assert_can_change_role(
                &default_ws(),
                &actor(PRIMARY, "owner"),
                &target(PRIMARY, "owner"),
                "admin"
            )),
            Some(CONFLICT)
        );
    }

    #[test]
    fn an_owner_cannot_demote_another_non_primary_owner_unless_they_are_the_primary_owner() {
        let w = ws(Some(PRIMARY), 3);
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(OTHER_OWNER, "owner"),
                &target("u_owner3", "owner"),
                "admin"
            )),
            Some(FORBIDDEN)
        );
        assert_eq!(
            status(assert_can_change_role(
                &w,
                &actor(PRIMARY, "owner"),
                &target("u_owner3", "owner"),
                "admin"
            )),
            None
        );
    }

    #[test]
    fn admins_cannot_demote_an_owner() {
        let result = assert_can_change_role(
            &default_ws(),
            &actor(ADMIN, "admin"),
            &target(OTHER_OWNER, "owner"),
            "member",
        );
        assert!(message(result).ends_with("Only an owner can demote an owner"));
    }

    #[test]
    fn a_non_primary_owner_may_step_down_on_their_own() {
        assert_eq!(
            status(assert_can_change_role(
                &default_ws(),
                &actor(OTHER_OWNER, "owner"),
                &target(OTHER_OWNER, "owner"),
                "admin"
            )),
            None
        );
    }

    #[test]
    fn the_last_owner_can_never_be_demoted() {
        let solo = ws(Some(PRIMARY), 1);
        assert_eq!(
            status(assert_can_change_role(
                &solo,
                &actor(PRIMARY, "owner"),
                &target(PRIMARY, "owner"),
                "admin"
            )),
            Some(CONFLICT)
        );
        let legacy = ws(None, 1);
        let result = assert_can_change_role(
            &legacy,
            &actor(OTHER_OWNER, "owner"),
            &target(OTHER_OWNER, "owner"),
            "admin",
        );
        assert!(message(result).ends_with(
            "A workspace needs at least one owner: transfer ownership before you step down"
        ));
    }

    #[test]
    fn legacy_workspaces_without_a_primary_owner_let_owners_demote_each_other() {
        assert_eq!(
            status(assert_can_change_role(
                &ws(None, 2),
                &actor(OTHER_OWNER, "owner"),
                &target(PRIMARY, "owner"),
                "admin"
            )),
            None
        );
    }

    // transferring ownership
    #[test]
    fn only_the_primary_owner_can_transfer() {
        let p = Some(PRIMARY);
        assert_eq!(
            status(assert_can_transfer_ownership(p, &actor(PRIMARY, "owner"), MEMBER)),
            None
        );
        assert_eq!(
            status(assert_can_transfer_ownership(p, &actor(OTHER_OWNER, "owner"), MEMBER)),
            Some(FORBIDDEN)
        );
        assert_eq!(
            status(assert_can_transfer_ownership(p, &actor(ADMIN, "admin"), MEMBER)),
            Some(FORBIDDEN)
        );
        assert_eq!(
            status(assert_can_transfer_ownership(p, &actor(MEMBER, "member"), MEMBER)),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn a_token_capped_below_owner_cannot_transfer_even_for_the_primary_owner() {
        assert_eq!(
            status(assert_can_transfer_ownership(Some(PRIMARY), &actor(PRIMARY, "member"), MEMBER)),
            Some(FORBIDDEN)
        );
    }

    #[test]
    fn transferring_to_the_current_primary_owner_is_a_conflict() {
        assert_eq!(
            status(assert_can_transfer_ownership(Some(PRIMARY), &actor(PRIMARY, "owner"), PRIMARY)),
            Some(CONFLICT)
        );
    }

    #[test]
    fn without_a_recorded_primary_owner_any_owner_may_claim_it() {
        assert_eq!(
            status(assert_can_transfer_ownership(None, &actor(OTHER_OWNER, "owner"), OTHER_OWNER)),
            None
        );
    }
}
