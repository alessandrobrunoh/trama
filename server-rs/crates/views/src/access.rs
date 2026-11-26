//! Who may read, edit and share a saved view (`view-access.ts`).

use trama_auth::WorkspaceContext;
use trama_contracts::roles::{GUEST_ROLE_ID, legacy_role_at_least};
use trama_contracts::views::{ShareLevel, ShareVisibility, SharingSettings};

/// The caller as far as view permissions are concerned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewActor {
    /// Absent for agent tokens (they can read shared views, never own or be granted one).
    pub user_id: Option<String>,
    /// The caller's role id.
    pub role: String,
    /// When `None`, derived from the old rank of `role`. Custom roles set it from their
    /// permissions.
    pub can_write: Option<bool>,
    /// When `None`, derived from the old rank of `role`.
    pub can_admin: Option<bool>,
}

impl ViewActor {
    /// An actor known only by user and role (the old ranks decide write and admin power).
    #[must_use]
    pub fn ranked(user_id: Option<&str>, role: &str) -> Self {
        Self {
            user_id: user_id.map(ToOwned::to_owned),
            role: role.to_owned(),
            can_write: None,
            can_admin: None,
        }
    }

    /// `actorOf(ctx)`: a workspace context always carries its capabilities and owner flag, so
    /// write and admin power come from them, not from the rank of the role.
    #[must_use]
    pub fn of_context(ctx: &WorkspaceContext) -> Self {
        // an unnarrowed member, or one granted any action beyond viewing
        let grant_write = ctx
            .access
            .as_ref()
            .is_none_or(|access| access.grants.iter().any(|grant| !grant.is_view()));
        Self {
            user_id: ctx.user_id.clone(),
            role: ctx.role.clone(),
            can_write: Some(ctx.owner || !ctx.capabilities.is_empty() || grant_write),
            can_admin: Some(ctx.has_admin_power()),
        }
    }

    fn writes(&self) -> bool {
        self.can_write.unwrap_or_else(|| legacy_role_at_least(&self.role, "member"))
    }

    fn administers(&self) -> bool {
        self.can_admin.unwrap_or_else(|| legacy_role_at_least(&self.role, "admin"))
    }
}

/// The part of a view the access rules look at.
#[derive(Clone, Copy, Debug)]
pub struct ViewAccessSubject<'a> {
    /// Owner user id.
    pub owner_id: &'a str,
    /// Visibility and invited people.
    pub sharing: &'a SharingSettings,
}

/// `DEFAULT_SHARING`: private, nobody invited.
#[must_use]
pub fn default_sharing() -> SharingSettings {
    SharingSettings { visibility: ShareVisibility::Private, grants: Vec::new() }
}

/// Is the actor the owner of the view?
#[must_use]
pub fn is_owner(view: ViewAccessSubject<'_>, actor: &ViewActor) -> bool {
    actor.user_id.as_deref().is_some_and(|id| id == view.owner_id)
}

/// The level `actor` was explicitly granted, if any.
#[must_use]
pub fn grant_level(view: ViewAccessSubject<'_>, actor: &ViewActor) -> Option<ShareLevel> {
    let user_id = actor.user_id.as_deref()?;
    view.sharing.grants.iter().find(|g| g.user_id == user_id).map(|g| g.level)
}

/// Owner, invited people, or (for workspace/link views) any workspace member. A guest is not
/// "the workspace": views shared with it by name still open, the ones shared with everybody do
/// not.
#[must_use]
pub fn can_read_view(view: ViewAccessSubject<'_>, actor: &ViewActor) -> bool {
    if is_owner(view, actor) || grant_level(view, actor).is_some() {
        return true;
    }
    view.sharing.visibility != ShareVisibility::Private && actor.role != GUEST_ROLE_ID
}

/// Change the view's definition (name, filters, sort…): the owner, people granted `edit`, and
/// workspace admins for views that are shared beyond their owner.
#[must_use]
pub fn can_edit_view(view: ViewAccessSubject<'_>, actor: &ViewActor) -> bool {
    if is_owner(view, actor) {
        return true;
    }
    if grant_level(view, actor) == Some(ShareLevel::Edit) && actor.writes() {
        return true;
    }
    view.sharing.visibility != ShareVisibility::Private && actor.administers()
}

/// Change who has access (visibility, invitations, public link) or delete the view.
#[must_use]
pub fn can_manage_sharing(view: ViewAccessSubject<'_>, actor: &ViewActor) -> bool {
    is_owner(view, actor)
        || (view.sharing.visibility != ShareVisibility::Private && actor.administers())
}

#[cfg(test)]
mod tests {
    use trama_contracts::views::ShareGrant;

    use super::*;

    fn sharing(visibility: ShareVisibility, grants: &[(&str, ShareLevel)]) -> SharingSettings {
        SharingSettings {
            visibility,
            grants: grants
                .iter()
                .map(|(user, level)| ShareGrant { user_id: (*user).to_owned(), level: *level })
                .collect(),
        }
    }

    fn actor(user: Option<&str>, role: &str) -> ViewActor {
        ViewActor::ranked(user, role)
    }

    fn subject(sharing: &SharingSettings) -> ViewAccessSubject<'_> {
        ViewAccessSubject { owner_id: "owner", sharing }
    }

    fn private_view() -> SharingSettings {
        sharing(
            ShareVisibility::Private,
            &[("viewer1", ShareLevel::View), ("editor1", ShareLevel::Edit)],
        )
    }

    #[test]
    fn private_views_are_visible_to_the_owner_and_invited_people_only() {
        let s = private_view();
        let v = subject(&s);
        assert!(can_read_view(v, &actor(Some("owner"), "member")));
        assert!(can_read_view(v, &actor(Some("viewer1"), "member")));
        assert!(!can_read_view(v, &actor(Some("stranger"), "member")));
        assert!(!can_read_view(v, &actor(Some("stranger"), "admin")));
        assert!(!can_read_view(v, &actor(None, "member")));
    }

    #[test]
    fn workspace_and_link_views_are_visible_to_every_member_and_agent() {
        for visibility in [ShareVisibility::Workspace, ShareVisibility::Link] {
            let s = sharing(visibility, &[]);
            assert!(can_read_view(subject(&s), &actor(Some("stranger"), "viewer")));
            assert!(can_read_view(subject(&s), &actor(None, "member")));
        }
    }

    #[test]
    fn a_guest_only_reads_what_was_shared_with_it_by_name() {
        let everybody = sharing(ShareVisibility::Workspace, &[]);
        assert!(!can_read_view(subject(&everybody), &actor(Some("g1"), "guest")));
        let named = sharing(ShareVisibility::Workspace, &[("g1", ShareLevel::View)]);
        assert!(can_read_view(subject(&named), &actor(Some("g1"), "guest")));
    }

    #[test]
    fn view_grants_cannot_edit_edit_grants_can() {
        let s = private_view();
        let v = subject(&s);
        assert!(!can_edit_view(v, &actor(Some("viewer1"), "member")));
        assert!(can_edit_view(v, &actor(Some("editor1"), "member")));
        assert!(!can_edit_view(v, &actor(Some("editor1"), "viewer")));
        let ws = sharing(ShareVisibility::Workspace, &[]);
        assert!(!can_edit_view(subject(&ws), &actor(Some("stranger"), "member")));
    }

    #[test]
    fn admins_manage_shared_views_but_not_private_ones() {
        let ws = sharing(ShareVisibility::Workspace, &[]);
        let link = sharing(ShareVisibility::Link, &[]);
        let admin = actor(Some("admin1"), "admin");
        assert!(can_edit_view(subject(&ws), &admin));
        assert!(can_manage_sharing(subject(&ws), &admin));
        assert!(can_manage_sharing(subject(&link), &admin));
        let s = private_view();
        assert!(!can_edit_view(subject(&s), &admin));
        assert!(!can_manage_sharing(subject(&s), &admin));
    }

    #[test]
    fn editors_cannot_change_sharing_the_owner_always_can() {
        let s = private_view();
        assert!(!can_manage_sharing(subject(&s), &actor(Some("editor1"), "member")));
        assert!(can_manage_sharing(subject(&s), &actor(Some("owner"), "member")));
    }

    #[test]
    fn explicit_write_and_admin_power_override_the_rank() {
        let ws = sharing(ShareVisibility::Workspace, &[("u1", ShareLevel::Edit)]);
        let custom = ViewActor {
            user_id: Some("u1".into()),
            role: "reviewer".into(),
            can_write: Some(false),
            can_admin: Some(true),
        };
        // an edit grant needs write power; admin power covers the shared view anyway
        assert!(can_edit_view(subject(&ws), &custom));
        let private = sharing(ShareVisibility::Private, &[("u1", ShareLevel::Edit)]);
        assert!(!can_edit_view(subject(&private), &custom));
        assert!(!can_manage_sharing(subject(&private), &custom));
    }
}
