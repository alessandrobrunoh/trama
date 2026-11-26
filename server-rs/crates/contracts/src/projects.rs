//! Projects, milestones, project tags (issue key prefixes), shared projects, project transfer
//! and the project AI suggestions.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use utoipa::ToSchema;

use crate::activity::AttentionSeverity;
use crate::common::{Id, IsoDate, Priority};
use crate::roles::Role;

string_enum! {
    /// Linear-style project lifecycle (the semantic types of the project status catalog).
    pub enum ProjectStatus {
        Backlog = "backlog",
        Planned = "planned",
        InProgress = "in_progress",
        Paused = "paused",
        Completed = "completed",
        Canceled = "canceled",
    }
}

/// `PROJECT_STATUSES`.
pub const PROJECT_STATUSES: &[ProjectStatus] = ProjectStatus::ALL;

string_enum! {
    /// Project health: set by hand, and what the AI risk assessment reports.
    pub enum ProjectHealth {
        OnTrack = "on_track",
        AtRisk = "at_risk",
        OffTrack = "off_track",
    }
}

/// `PROJECT_HEALTHS`.
pub const PROJECT_HEALTHS: &[ProjectHealth] = ProjectHealth::ALL;

/// A planned outcome: what we want to achieve and by when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Project id (`pj_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Display name.
    pub name: String,
    /// Uppercase project tag used as the prefix for issue keys, e.g. `CORA-12`.
    pub key: String,
    /// One-line summary shown in lists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Longer description (markdown).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Color.
    pub color: String,
    /// Lucide icon name or a single emoji. Absent = the default project glyph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Project status catalog id (seeded ids equal [`ProjectStatus`] strings).
    pub status: String,
    /// Project health catalog id. Absent until set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    /// Priority.
    pub priority: Priority,
    /// Lead user id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<Id>,
    /// One git repository: a URL or `owner/name`. Omitted when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Workspace label ids.
    pub labels: Vec<Id>,
    /// Start date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<IsoDate>,
    /// Target date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<IsoDate>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
    /// Set when the status becomes completed or canceled; cleared on reopen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<IsoDate>,
}

/// Linear-style milestone inside a project.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    /// Milestone id (`ms_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Project id.
    pub project_id: Id,
    /// Display name.
    pub name: String,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Target date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<IsoDate>,
    /// Ascending order inside the project.
    #[serde(serialize_with = "crate::js::number")]
    pub sort_order: f64,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
}

// ───────────────────────────── Shared projects and transfer ─────────────────────────────

/// Where one person chose to show a project that was shared with them. `workspace_id` `None`
/// (`null`) means "hidden from Shared with me".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPlacement {
    /// Project id.
    pub project_id: Id,
    /// Workspace it shows in, or `null`.
    pub workspace_id: Option<Id>,
    /// Order.
    pub position: i32,
}

/// `{ id, slug, name }` of a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceRef {
    /// Workspace id.
    pub id: Id,
    /// Slug.
    pub slug: String,
    /// Name.
    pub name: String,
}

/// A project the caller reaches through a limited (guest) membership in a workspace that is not
/// theirs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SharedProject {
    /// Project id.
    pub id: Id,
    /// Project name.
    pub name: String,
    /// Project tag.
    pub key: String,
    /// Color.
    pub color: String,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The workspace that owns the project.
    pub workspace: WorkspaceRef,
    /// The caller's role in that workspace.
    pub role: Role,
    /// Absent: shown under Shared with me.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<ProjectPlacement>,
}

string_enum! {
    /// What a transfer mapping is about: a status subject or a label.
    pub enum TransferMappingKind {
        Issue = "issue",
        Project = "project",
        ProjectHealth = "project_health",
        Label = "label",
    }
}

string_enum! {
    /// What a transfer does to a status or label.
    pub enum TransferMappingAction {
        Map = "map",
        Create = "create",
    }
}

/// What a project transfer will do to one status or label.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectTransferMapping {
    /// `issue`, `project` or `project_health` for statuses; `label` for labels.
    pub kind: TransferMappingKind,
    /// Name in the source workspace.
    pub from: String,
    /// Name in the target workspace.
    pub to: String,
    /// `create` only for labels the target does not have yet.
    pub action: TransferMappingAction,
    /// Records that carry it.
    pub count: i64,
}

string_enum! {
    /// `add`: new guest in the target. `extend`: already a limited member there. `keep`: already
    /// has full access.
    pub enum TransferGuestAction {
        Add = "add",
        Extend = "extend",
        Keep = "keep",
    }
}

/// One person a transfer brings along.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTransferGuest {
    /// User id.
    pub user_id: Id,
    /// Name.
    pub name: String,
    /// Email.
    pub email: String,
    /// What happens to their access.
    pub action: TransferGuestAction,
    /// Role they get in the target.
    pub role: Role,
}

/// `{ id, name, key }` of a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectRef {
    /// Project id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Tag.
    pub key: String,
}

/// Records a transfer moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferCounts {
    /// Issues.
    pub issues: i64,
    /// Milestones.
    pub milestones: i64,
    /// Time entries.
    pub time_entries: i64,
}

/// Dry run of a project transfer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectTransferPreview {
    /// The project.
    pub project: ProjectRef,
    /// Where it is now.
    pub source: WorkspaceRef,
    /// Where it goes.
    pub target: WorkspaceRef,
    /// What moves.
    pub counts: TransferCounts,
    /// Status and label mappings.
    pub mappings: Vec<ProjectTransferMapping>,
    /// People brought along.
    pub guests: Vec<ProjectTransferGuest>,
    /// Records whose assignee, lead or reporter is not a member of the target.
    pub unassigned: i64,
    /// Anything in here blocks the transfer.
    pub blockers: Vec<String>,
}

/// Result of a project transfer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectTransferResult {
    /// The moved project.
    pub project: Project,
    /// Where it went.
    pub target: WorkspaceRef,
    /// What moved.
    pub counts: TransferCounts,
    /// Records that lost their person.
    pub unassigned: i64,
}

// ───────────────────────────── AI suggestions ─────────────────────────────

string_enum! {
    /// `POST /w/:slug/projects/:id/ai/:kind`.
    pub enum ProjectAiKind {
        Summary = "summary",
        Issues = "issues",
        Risks = "risks",
    }
}

/// `PROJECT_AI_KINDS`.
pub const PROJECT_AI_KINDS: &[ProjectAiKind] = ProjectAiKind::ALL;

/// `kind: 'summary'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectAiSummary {
    /// One-line summary.
    pub summary: String,
    /// Longer description.
    pub description: String,
}

/// One suggested issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAiIssueSuggestion {
    /// Issue id.
    pub issue_id: Id,
    /// Why.
    pub reason: String,
}

/// `kind: 'issues'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectAiIssues {
    /// Suggestions.
    pub suggestions: Vec<ProjectAiIssueSuggestion>,
}

/// One risk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAiRisk {
    /// Headline.
    pub title: String,
    /// Explanation.
    pub detail: String,
    /// Severity.
    pub severity: AttentionSeverity,
    /// The issue it is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
}

/// `kind: 'risks'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectAiRisks {
    /// Assessed health.
    pub health: ProjectHealth,
    /// Risks.
    pub risks: Vec<ProjectAiRisk>,
}

/// `ProjectAiResult`, tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectAiResult {
    /// A summary and description.
    Summary(ProjectAiSummary),
    /// Issues that belong to the project.
    Issues(ProjectAiIssues),
    /// Risks and a health assessment.
    Risks(ProjectAiRisks),
}

// ───────────────────────────── Project tags ─────────────────────────────

/// Reserved prefix used by issues that are not assigned to a project.
pub const UNASSIGNED_ISSUE_KEY_PREFIX: &str = "UNPR";
/// Prefixes already used by non-project keys.
pub const RESERVED_PROJECT_KEYS: &[&str] = &[UNASSIGNED_ISSUE_KEY_PREFIX, "ADR"];
/// Longest project tag.
pub const PROJECT_KEY_MAX: usize = 4;

/// `value.trim().toUpperCase()`.
#[must_use]
pub fn normalize_project_key(value: &str) -> String {
    crate::js::trim(value).to_uppercase()
}

/// `^[A-Z][A-Z0-9]{0,3}$`.
#[must_use]
pub fn is_project_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=PROJECT_KEY_MAX).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// One of [`RESERVED_PROJECT_KEYS`], in any case.
#[must_use]
pub fn is_reserved_project_key(value: &str) -> bool {
    RESERVED_PROJECT_KEYS.contains(&normalize_project_key(value).as_str())
}

fn is_vowel(b: u8) -> bool {
    matches!(b, b'A' | b'E' | b'I' | b'O' | b'U')
}

/// Suggests a short uppercase project tag from its name.
#[must_use]
pub fn suggest_project_key(name: &str) -> String {
    let cleaned: String = name
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect::<String>()
        .to_uppercase();
    let words: Vec<&str> = cleaned
        .split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
        .collect();
    let word = words.first().copied().unwrap_or("");
    let raw: String = if words.len() > 1 {
        words.iter().filter_map(|w| w.chars().next()).collect()
    } else if word.len() > PROJECT_KEY_MAX && is_vowel(word.as_bytes()[word.len() - 1]) {
        // `word` only holds A-Z and 0-9 here.
        let head: String = word.as_bytes()[..word.len() - 1]
            .iter()
            .filter(|b| !is_vowel(**b))
            .take(PROJECT_KEY_MAX - 1)
            .map(|b| char::from(*b))
            .collect();
        format!("{head}{}", &word[word.len() - 1..])
    } else {
        word.chars().take(PROJECT_KEY_MAX).collect()
    };
    let candidate: String = raw
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .take(PROJECT_KEY_MAX)
        .collect();
    if candidate.is_empty() {
        return "PROJ".to_owned();
    }
    if candidate.as_bytes()[0].is_ascii_uppercase() {
        candidate
    } else {
        format!("P{candidate}").chars().take(PROJECT_KEY_MAX).collect()
    }
}

/// `n.toString(36).toUpperCase()`.
fn base36(mut n: u32) -> String {
    let mut digits = Vec::new();
    while n > 0 {
        let d = u8::try_from(n % 36).unwrap_or(0);
        digits.push(if d < 10 { b'0' + d } else { b'A' + d - 10 });
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// A valid unused project tag, adding a short suffix when the name's suggestion is taken.
/// `None` when no tag is left (NestJS throws `No available project tags remain`, a 500).
#[must_use]
pub fn unique_project_key<'a>(
    name: &str,
    used_keys: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let taken: HashSet<String> = used_keys.into_iter().map(str::to_uppercase).collect();
    let base = suggest_project_key(name);
    if !is_reserved_project_key(&base) && !taken.contains(&base) {
        return Some(base);
    }
    for n in 1..36u32.pow(3) {
        let suffix = base36(n);
        let keep = PROJECT_KEY_MAX - suffix.len();
        let candidate = format!("{}{suffix}", &base[..base.len().min(keep)]);
        if is_project_key(&candidate)
            && !is_reserved_project_key(&candidate)
            && !taken.contains(&candidate)
        {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // projects/project-key.spec.ts
    #[test]
    fn suggests_short_tags_and_normalizes_custom_tags() {
        assert_eq!(suggest_project_key("Cora"), "CORA");
        assert_eq!(suggest_project_key("Trama"), "TRMA");
        assert_eq!(suggest_project_key("Security"), "SECU");
        assert_eq!(suggest_project_key("Project"), "PROJ");
        assert_eq!(normalize_project_key("trma"), "TRMA");
        assert!(is_project_key("TRMA"));
    }

    #[test]
    fn limits_tags_to_four_uppercase_letters_or_digits_and_reserves_special_prefixes() {
        assert!(is_project_key("A"));
        assert!(is_project_key("A1B2"));
        assert!(!is_project_key("1ABC"));
        assert!(!is_project_key("ABCDE"));
        assert!(is_reserved_project_key("adr"));
        assert_eq!(unique_project_key("Unpr", []).as_deref(), Some("UNP1"));
        assert_eq!(unique_project_key("ADR", []).as_deref(), Some("ADR1"));
        assert_eq!(unique_project_key("Cora", ["CORA"]).as_deref(), Some("COR1"));
    }

    #[test]
    fn suggests_from_several_words_accents_and_digits() {
        assert_eq!(suggest_project_key("Mobile app redesign"), "MAR");
        assert_eq!(suggest_project_key("Équipe"), "QPE");
        assert_eq!(suggest_project_key("2026 roadmap"), "P2R");
        assert_eq!(suggest_project_key("!!!"), "PROJ");
        assert_eq!(suggest_project_key("Q4"), "Q4");
        assert_eq!(suggest_project_key("Api"), "API");
    }

    #[test]
    fn counts_suffixes_in_base_36() {
        assert_eq!(base36(1), "1");
        assert_eq!(base36(35), "Z");
        assert_eq!(base36(36), "10");
        let used: Vec<String> =
            (1..36).map(|n| format!("COR{}", base36(n))).chain(["CORA".to_owned()]).collect();
        assert_eq!(
            unique_project_key("Cora", used.iter().map(String::as_str)).as_deref(),
            Some("CO10")
        );
    }

    #[test]
    fn ai_results_are_tagged_by_kind() {
        let out = serde_json::to_value(ProjectAiResult::Summary(ProjectAiSummary {
            summary: "s".into(),
            description: "d".into(),
        }))
        .unwrap();
        assert_eq!(
            out,
            serde_json::json!({ "kind": "summary", "summary": "s", "description": "d" })
        );
    }
}
