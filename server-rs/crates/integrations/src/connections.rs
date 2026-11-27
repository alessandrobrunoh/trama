//! `ConnectionsService` (`connections.service.ts`): who may use which connection. This is what
//! routing rules read: they never look at owners themselves, they ask for the connections a
//! person may pick, and read `status` to know whether one still works.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder};
use trama_contracts::integrations::{
    ConnectionOwnerType, ConnectionProvider, ConnectionStatus, IntegrationConnection,
    UsableConnection,
};
use trama_contracts::roles::{Capability, role_has_capability};
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::AppError;
use trama_entities::{integration_connections, memberships, workspaces};

use crate::service::summarize;

/// Marks which of the connections a person can pick for the same provider and host is the one
/// to preselect: the workspace's (it outlives people) when there is a healthy one, else the only
/// healthy one there is. Pure, so the rule is easy to test.
#[must_use]
pub fn mark_suggested(connections: Vec<IntegrationConnection>) -> Vec<UsableConnection> {
    let mut groups: HashMap<
        (ConnectionProvider, String),
        Vec<(ConnectionOwnerType, ConnectionStatus)>,
    > = HashMap::new();
    for c in &connections {
        groups.entry((c.provider, c.host.clone())).or_default().push((c.owner_type, c.status));
    }
    connections
        .into_iter()
        .map(|c| {
            let healthy: Vec<_> = groups[&(c.provider, c.host.clone())]
                .iter()
                .filter(|(_, status)| *status == ConnectionStatus::Connected)
                .collect();
            let workspace_ones = healthy
                .iter()
                .filter(|(owner, _)| *owner == ConnectionOwnerType::Workspace)
                .count();
            let suggested = c.status == ConnectionStatus::Connected
                && if workspace_ones > 0 {
                    c.owner_type == ConnectionOwnerType::Workspace
                } else {
                    healthy.len() == 1
                };
            UsableConnection { connection: c, suggested }
        })
        .collect()
}

/// The connections `user_id` may pick for a rule on a project of `workspace_id`: their own
/// personal ones, plus the workspace's when their role has the integrations permission. Empty
/// for someone who is not a member. Revoked connections are left out (they cannot read
/// anything); `error` ones stay, with their status, so the UI can say why they are not
/// preselected.
///
/// `suggested` is true on the workspace connection when both a workspace and a personal one
/// reach the same provider and host, so work does not depend on one person's token; with no
/// workspace connection, on the only candidate. Tokens are never part of the result.
///
/// # Errors
///
/// Database errors.
pub async fn usable_for<C: ConnectionTrait>(
    db: &C,
    user_id: &str,
    workspace_id: &str,
) -> Result<Vec<UsableConnection>, AppError> {
    let membership = memberships::Entity::find()
        .filter(memberships::Column::UserId.eq(user_id))
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?;
    let Some(membership) = membership else { return Ok(Vec::new()) };
    let workspace = workspaces::Entity::find_by_id(workspace_id).one(db).await?;
    let may_use_workspace = workspace.is_some_and(|w| {
        let settings = resolve_workspace_settings(&w.settings);
        role_has_capability(&settings.roles, &membership.role, Capability::ManageIntegrations)
    });

    let mut rows = Vec::new();
    if may_use_workspace {
        rows.extend(
            integration_connections::Entity::find()
                .filter(integration_connections::Column::OwnerType.eq("workspace"))
                .filter(integration_connections::Column::WorkspaceId.eq(workspace_id))
                .order_by_asc(integration_connections::Column::CreatedAt)
                .all(db)
                .await?,
        );
    }
    rows.extend(
        integration_connections::Entity::find()
            .filter(integration_connections::Column::OwnerType.eq("user"))
            .filter(integration_connections::Column::OwnerUserId.eq(user_id))
            .order_by_asc(integration_connections::Column::CreatedAt)
            .all(db)
            .await?,
    );
    rows.retain(|r| r.status != ConnectionStatus::Revoked.as_str());
    Ok(mark_suggested(summarize(db, &rows).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(
        id: &str,
        owner: ConnectionOwnerType,
        status: ConnectionStatus,
        host: &str,
    ) -> IntegrationConnection {
        IntegrationConnection {
            id: id.to_owned(),
            owner_type: owner,
            workspace_id: None,
            owner_user_id: None,
            owner_name: None,
            label: "l".to_owned(),
            provider: ConnectionProvider::Github,
            account: "a".to_owned(),
            base_url: None,
            host: host.to_owned(),
            webhook_configured: true,
            status,
            last_sync_at: None,
            last_error: None,
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    use ConnectionOwnerType::{User, Workspace};
    use ConnectionStatus::{Connected, Error};

    fn suggested(list: Vec<IntegrationConnection>) -> Vec<(String, bool)> {
        mark_suggested(list).into_iter().map(|u| (u.connection.id, u.suggested)).collect()
    }

    #[test]
    fn prefers_a_healthy_workspace_connection_over_personal_ones_for_the_same_host() {
        let out = suggested(vec![
            c("p", User, Connected, "github.com"),
            c("w", Workspace, Connected, "github.com"),
        ]);
        assert_eq!(out, [("p".to_owned(), false), ("w".to_owned(), true)]);
    }

    #[test]
    fn falls_back_to_a_personal_connection_when_the_workspace_one_is_failing() {
        let out = suggested(vec![
            c("p", User, Connected, "github.com"),
            c("w", Workspace, Error, "github.com"),
        ]);
        assert_eq!(out, [("p".to_owned(), true), ("w".to_owned(), false)]);
    }

    #[test]
    fn does_not_pick_between_several_personal_accounts_on_one_host() {
        let out = suggested(vec![
            c("p1", User, Connected, "github.com"),
            c("p2", User, Connected, "github.com"),
        ]);
        assert!(out.iter().all(|(_, s)| !s));
    }

    #[test]
    fn treats_hosts_separately() {
        let out = suggested(vec![
            c("a", User, Connected, "github.com"),
            c("b", User, Connected, "ghe.example.com"),
        ]);
        assert!(out.iter().all(|(_, s)| *s));
    }
}
