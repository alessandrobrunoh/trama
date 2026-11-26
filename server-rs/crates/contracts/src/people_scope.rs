//! The people a project-limited caller may see (`server/src/workspaces/people-scope.ts`).
//!
//! A guest, or a member limited to a list of projects, sees themselves and everybody who works
//! on at least one of their projects. Someone with every project is on all of them, so they are
//! visible too. Anyone else is not listed. An unlimited caller sees everyone.

use std::collections::HashSet;

use crate::access::{
    MemberAccess, MemberProjectScope, accesses_share_project, effective_member_access,
    is_project_limited,
};
use crate::identity::{Membership, ProjectShareMember};
use crate::roles::{WorkspaceRole, find_workspace_role};

/// A membership row [`visible_memberships`] can filter.
pub trait MembershipLike: Clone {
    /// The member's user id.
    fn user_id(&self) -> &str;
    /// Their role id.
    fn role(&self) -> &str;
    /// Their stored access.
    fn access(&self) -> Option<&MemberAccess>;
    /// Replaces their stored access.
    fn set_access(&mut self, access: Option<MemberAccess>);
}

impl MembershipLike for Membership {
    fn user_id(&self) -> &str {
        &self.user_id
    }

    fn role(&self) -> &str {
        &self.role
    }

    fn access(&self) -> Option<&MemberAccess> {
        self.access.as_ref()
    }

    fn set_access(&mut self, access: Option<MemberAccess>) {
        self.access = access;
    }
}

impl MembershipLike for ProjectShareMember {
    fn user_id(&self) -> &str {
        &self.membership.user_id
    }

    fn role(&self) -> &str {
        &self.membership.role
    }

    fn access(&self) -> Option<&MemberAccess> {
        self.membership.access.as_ref()
    }

    fn set_access(&mut self, access: Option<MemberAccess>) {
        self.membership.access = access;
    }
}

/// The rows `caller` may see. Someone else's project list only names projects the caller also
/// has: the rest are not the caller's to know.
#[must_use]
pub fn visible_memberships<T: MembershipLike>(
    rows: &[T],
    roles: &[WorkspaceRole],
    caller: Option<&MemberAccess>,
    self_user_id: Option<&str>,
) -> Vec<T> {
    let Some(limited) = caller.filter(|c| is_project_limited(Some(c))) else {
        return rows.to_vec();
    };
    rows.iter()
        .filter(|row| {
            if Some(row.user_id()) == self_user_id {
                return true;
            }
            let theirs =
                effective_member_access(find_workspace_role(roles, Some(row.role())), row.access());
            accesses_share_project(Some(limited), theirs.as_ref())
        })
        .map(|row| {
            if Some(row.user_id()) == self_user_id {
                return row.clone();
            }
            hide_other_projects(row, limited)
        })
        .collect()
}

fn hide_other_projects<T: MembershipLike>(row: &T, caller: &MemberAccess) -> T {
    let Some(access) = row.access().filter(|a| !a.projects.all) else { return row.clone() };
    let project_ids = access
        .projects
        .project_ids
        .iter()
        .filter(|id| caller.projects.project_ids.contains(id))
        .cloned()
        .collect();
    let narrowed =
        MemberAccess { projects: MemberProjectScope { all: false, project_ids }, ..access.clone() };
    let mut copy = row.clone();
    copy.set_access(Some(narrowed));
    copy
}

/// Ids of the users who may appear next to the caller: the people of [`visible_memberships`].
#[must_use]
pub fn visible_user_ids<T: MembershipLike>(
    rows: &[T],
    roles: &[WorkspaceRole],
    caller: Option<&MemberAccess>,
    self_user_id: Option<&str>,
) -> HashSet<String> {
    visible_memberships(rows, roles, caller, self_user_id)
        .iter()
        .map(|row| row.user_id().to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{MemberGrant, accesses_share_project};
    use crate::roles::{
        Capability, GUEST_ROLE_ID, LegacyRole, ORGANIZER_ROLE_ID, RoleGate, TokenScope,
        apply_token_scope, fresh_workspace_roles, normalize_workspace_roles, role_allows,
        role_has_admin_power,
    };

    fn on_projects(ids: &[&str]) -> MemberAccess {
        MemberAccess {
            projects: MemberProjectScope {
                all: false,
                project_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
            },
            include_unassigned: false,
            grants: Vec::new(),
        }
    }

    fn gate(capability: Option<Capability>, min: LegacyRole) -> RoleGate {
        RoleGate { capability, min, needed_grant: None }
    }

    fn grant(g: &str) -> MemberGrant {
        MemberGrant::parse(g).unwrap()
    }

    // workspaces/guest-organizer-roles.spec.ts
    #[test]
    fn seeds_both_next_to_the_old_ranks() {
        let roles = fresh_workspace_roles();
        assert_eq!(
            roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["owner", "admin", "member", "viewer", "organizer", "guest"]
        );
    }

    #[test]
    fn organizer_runs_projects_and_tasks_but_administers_nothing() {
        let roles = fresh_workspace_roles();
        let organizer = find_workspace_role(&roles, Some(ORGANIZER_ROLE_ID)).unwrap();
        for cap in [
            Capability::ManageProjects,
            Capability::CreateIssues,
            Capability::DeleteIssues,
            Capability::InviteToProject,
        ] {
            assert!(organizer.capabilities.contains(&cap));
        }
        for cap in [
            Capability::InviteMembers,
            Capability::ManageIntegrations,
            Capability::ManageAgents,
            Capability::ManageTokens,
        ] {
            assert!(!organizer.capabilities.contains(&cap));
        }
        assert!(!role_has_admin_power(Some(organizer)));
        assert!(!role_allows(Some(organizer), &gate(None, LegacyRole::Admin), None));
        assert!(!role_allows(
            Some(organizer),
            &gate(Some(Capability::ManageIntegrations), LegacyRole::Member),
            None
        ));
        assert!(role_allows(
            Some(organizer),
            &gate(Some(Capability::InviteToProject), LegacyRole::Member),
            None
        ));
    }

    #[test]
    fn who_may_share_a_project_is_a_capability() {
        let roles = fresh_workspace_roles();
        let has = |id| {
            find_workspace_role(&roles, Some(id))
                .unwrap()
                .capabilities
                .contains(&Capability::InviteToProject)
        };
        assert_eq!([has("owner"), has("admin"), has("organizer")], [true, true, true]);
        assert_eq!([has("member"), has("viewer"), has("guest")], [false, false, false]);
        let organizer = find_workspace_role(&roles, Some(ORGANIZER_ROLE_ID)).unwrap();
        assert!(
            !apply_token_scope(organizer, Some(TokenScope::Write))
                .capabilities
                .contains(&Capability::InviteToProject)
        );
    }

    #[test]
    fn guest_creates_and_updates_tasks_and_comments_reads_the_rest_and_manages_nothing() {
        let roles = fresh_workspace_roles();
        let guest = find_workspace_role(&roles, Some(GUEST_ROLE_ID)).unwrap();
        assert_eq!(guest.capabilities, [Capability::CreateIssues]);
        for g in
            ["issues:view", "issues:create", "issues:update", "comments:create", "comments:update"]
        {
            assert!(guest.grants.contains(&grant(g)));
        }
        for g in [
            "issues:delete",
            "projects:create",
            "projects:update",
            "milestones:update",
            "comments:delete",
        ] {
            assert!(!guest.grants.contains(&grant(g)));
        }
        assert!(!role_allows(
            Some(guest),
            &gate(Some(Capability::ManageProjects), LegacyRole::Member),
            None
        ));
        assert!(!role_has_admin_power(Some(guest)));
    }

    #[test]
    fn a_guest_without_a_project_list_sees_no_project_at_all() {
        let roles = fresh_workspace_roles();
        let guest = find_workspace_role(&roles, Some(GUEST_ROLE_ID)).unwrap();
        let none = effective_member_access(Some(guest), None).unwrap();
        assert_eq!(none.projects, MemberProjectScope { all: false, project_ids: Vec::new() });
        assert!(!none.include_unassigned);
        let all = MemberAccess {
            projects: MemberProjectScope::every(),
            include_unassigned: true,
            grants: Vec::new(),
        };
        assert!(!effective_member_access(Some(guest), Some(&all)).unwrap().projects.all);
        let listed = effective_member_access(Some(guest), Some(&on_projects(&["pj_a"]))).unwrap();
        assert_eq!(listed.projects, on_projects(&["pj_a"]).projects);
        assert!(!listed.include_unassigned);
        assert_eq!(listed.grants, guest.grants);
    }

    #[test]
    fn a_stored_roles_list_keeps_working_without_them() {
        let roles: Vec<serde_json::Value> = fresh_workspace_roles()
            .into_iter()
            .filter(|r| r.id != GUEST_ROLE_ID && r.id != ORGANIZER_ROLE_ID)
            .map(|r| serde_json::to_value(r).unwrap())
            .collect();
        let stored = normalize_workspace_roles(&roles);
        assert_eq!(
            stored.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["owner", "admin", "member", "viewer"]
        );
    }

    fn memberships() -> Vec<Membership> {
        let row = |user: &str, role: &str, access: Option<MemberAccess>| Membership {
            id: format!("mb_{user}"),
            workspace_id: "ws_1".into(),
            user_id: user.into(),
            role: role.into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            access,
        };
        vec![
            row("owner", "owner", None),
            row("member", "member", None),
            row("limited-a", "member", Some(on_projects(&["pj_a", "pj_c"]))),
            row("guest-a", "guest", Some(on_projects(&["pj_a"]))),
            row("guest-b", "guest", Some(on_projects(&["pj_b"]))),
            row("guest-none", "guest", None),
        ]
    }

    #[test]
    fn shows_everybody_to_someone_who_sees_every_project() {
        let rows = memberships();
        assert_eq!(
            visible_memberships(&rows, &fresh_workspace_roles(), None, Some("member")).len(),
            rows.len()
        );
    }

    #[test]
    fn shows_a_guest_only_themselves_and_the_people_on_their_projects() {
        let roles = fresh_workspace_roles();
        let guest = find_workspace_role(&roles, Some(GUEST_ROLE_ID));
        let caller = effective_member_access(guest, Some(&on_projects(&["pj_a"])));
        let seen = visible_memberships(&memberships(), &roles, caller.as_ref(), Some("guest-a"));
        assert_eq!(
            seen.iter().map(|r| r.user_id.as_str()).collect::<Vec<_>>(),
            ["owner", "member", "limited-a", "guest-a"]
        );
        let ids = visible_user_ids(&memberships(), &roles, caller.as_ref(), Some("guest-a"));
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn does_not_tell_a_guest_which_other_projects_someone_is_on() {
        let roles = fresh_workspace_roles();
        let guest = find_workspace_role(&roles, Some(GUEST_ROLE_ID));
        let caller = effective_member_access(guest, Some(&on_projects(&["pj_a"])));
        let seen = visible_memberships(&memberships(), &roles, caller.as_ref(), Some("guest-a"));
        let limited = seen.iter().find(|r| r.user_id == "limited-a").unwrap();
        assert_eq!(limited.access.as_ref().unwrap().projects.project_ids, ["pj_a"]);
    }

    #[test]
    fn two_lists_share_a_project_only_when_they_overlap() {
        assert!(!accesses_share_project(
            Some(&on_projects(&["pj_a"])),
            Some(&on_projects(&["pj_b"]))
        ));
        assert!(accesses_share_project(
            Some(&on_projects(&["pj_a"])),
            Some(&on_projects(&["pj_a", "pj_b"]))
        ));
        assert!(accesses_share_project(Some(&on_projects(&["pj_a"])), None));
    }
}
