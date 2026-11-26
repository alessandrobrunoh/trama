//! Saved views, sharing settings and publicly shared views.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{Id, IsoDate, Priority};

string_enum! {
    /// Saved-view discriminator. `issue` is the task list; it is not renamed to `task`.
    pub enum ViewEntity {
        Issue = "issue",
        Project = "project",
    }
}

string_enum! {
    /// Layout of a saved view. `timeline` (Gantt) is offered for project views.
    pub enum ViewLayout {
        List = "list",
        Board = "board",
        Timeline = "timeline",
    }
}

string_enum! {
    /// Filter operator. `gte` / `lte` compare numeric fields. `all`, `between`, `last`, `next`
    /// and `overdue` are only used by the task list filters.
    pub enum ViewFilterOp {
        Is = "is",
        IsNot = "is_not",
        In = "in",
        NotIn = "not_in",
        Contains = "contains",
        Before = "before",
        After = "after",
        Gte = "gte",
        Lte = "lte",
        All = "all",
        Between = "between",
        Last = "last",
        Next = "next",
        Overdue = "overdue",
    }
}

/// `string | string[]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum FilterValue {
    /// A single value.
    One(String),
    /// A list of values.
    Many(Vec<String>),
}

/// One filter of a saved view. Date values are `YYYY-MM-DD` or a relative token (`today`,
/// `-7d`, `week_start`…).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ViewFilter {
    /// Filtered field.
    pub field: String,
    /// Operator.
    pub op: ViewFilterOp,
    /// Value or values.
    pub value: FilterValue,
}

string_enum! {
    /// Sort direction.
    pub enum SortDirection {
        Asc = "asc",
        Desc = "desc",
    }
}

/// Sort of a saved view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ViewSort {
    /// Sorted field.
    pub field: String,
    /// Direction.
    pub direction: SortDirection,
}

string_enum! {
    /// Who may open a shareable object: only the invited, every workspace member, or anyone
    /// holding the link.
    pub enum ShareVisibility {
        Private = "private",
        Workspace = "workspace",
        Link = "link",
    }
}

string_enum! {
    /// What an invited person may do. The owner always has full control.
    pub enum ShareLevel {
        View = "view",
        Edit = "edit",
    }
}

/// One person a shareable object is shared with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShareGrant {
    /// A member of the workspace.
    pub user_id: Id,
    /// What they may do.
    pub level: ShareLevel,
}

/// Permission settings for a shareable object (saved views today).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SharingSettings {
    /// Who can open it.
    pub visibility: ShareVisibility,
    /// Invited people.
    pub grants: Vec<ShareGrant>,
}

/// A saved view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    /// View id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Owner user id.
    pub owner_id: Id,
    /// Display name.
    pub name: String,
    /// What the view lists.
    pub entity: ViewEntity,
    /// Filters.
    pub filters: Vec<ViewFilter>,
    /// Sort.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<ViewSort>,
    /// Grouping field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// Layout.
    pub layout: ViewLayout,
    /// Visible beyond the owner (`sharing.visibility` is `workspace` or `link`). Kept for older
    /// clients; `sharing` is the source of truth.
    pub shared: bool,
    /// Who can see and edit this view.
    pub sharing: SharingSettings,
    /// Secret token of the public link. Only sent to people who can manage the view's sharing,
    /// and only while `sharing.visibility` is `link`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_token: Option<String>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
}

/// One row of a publicly shared view: only what a list row shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicViewItem {
    /// Record id.
    pub id: Id,
    /// Human key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Title or name.
    pub title: String,
    /// Issue kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Status name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Priority.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Health (projects only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    /// Assignee name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Project name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Label names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// Start date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<IsoDate>,
    /// Target date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<IsoDate>,
    /// Last update.
    pub updated_at: IsoDate,
}

/// One group of a public view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PublicViewGroup {
    /// Raw group value (`''` = no value).
    pub key: String,
    /// Display name (resolved server-side for teams, people and projects).
    pub label: String,
    /// Rows.
    pub items: Vec<PublicViewItem>,
}

/// `GET /api/public/views/:token`: the fixed result of a view shared by link. Read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicView {
    /// View name.
    pub name: String,
    /// What it lists.
    pub entity: ViewEntity,
    /// Layout.
    pub layout: ViewLayout,
    /// Grouping field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// Workspace name.
    pub workspace_name: String,
    /// Groups.
    pub groups: Vec<PublicViewGroup>,
    /// Matching rows.
    pub total: i64,
    /// True when more rows matched than are returned.
    pub truncated: bool,
    /// When it was computed.
    pub generated_at: IsoDate,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn filter_values_are_a_string_or_a_list() {
        let filters: Vec<ViewFilter> = serde_json::from_value(json!([
            { "field": "labels", "op": "not_in", "value": ["lb_a"] },
            { "field": "status", "op": "is", "value": "todo" },
        ]))
        .unwrap();
        assert_eq!(filters[0].value, FilterValue::Many(vec!["lb_a".into()]));
        assert_eq!(filters[1].op, ViewFilterOp::Is);
        assert_eq!(
            serde_json::to_value(&filters[1]).unwrap(),
            json!({ "field": "status", "op": "is", "value": "todo" })
        );
    }
}
