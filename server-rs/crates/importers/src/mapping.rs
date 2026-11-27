//! Pure import mapping (`importers/mapping.ts`): states, priorities and kinds, matching tracker
//! people and names to the workspace, the preview and its mapping, issue conversion, issue URLs
//! and secret redaction.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

use chrono::{DateTime, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::common::Priority;
use trama_contracts::imports::{
    ExternalProvider, ExternalRef, ExternalRefOrigin, ExternalStateType, ImportMapping,
    ImportOptions, ImportPreview, ImportPreviewCounts, ImportPreviewEntity, ImportPreviewMilestone,
    ImportPreviewSample, ImportPreviewStatus, ImportPreviewUser, ImportTarget,
};
use trama_contracts::issues::{IssueKind, IssueStatus};
use trama_contracts::js;
use trama_contracts::labels::LABEL_NAME_MAX;
use trama_contracts::routing::RoutingFilters;
use trama_core::AppError;
use trama_routing::source_path::{source_includes, specificity};

use crate::types::{
    Discovery, ExternalIssue, ExternalState, ExternalUser, ParsedExternalUrl, state_type,
};

const MAX_MAPPING_ENTRIES: usize = 5_000;
const MAX_TITLE: usize = 300;
const MAX_BODY: usize = 100_000;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid built-in pattern")
}

// ───────────────────────────── states, priorities, kinds ─────────────────────────────

/// Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
#[must_use]
pub fn map_linear_priority(value: Option<i64>) -> Priority {
    match value {
        Some(1) => Priority::Urgent,
        Some(2) => Priority::High,
        Some(3) => Priority::Medium,
        Some(4) => Priority::Low,
        _ => Priority::None,
    }
}

static IN_REVIEW: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)review|qa\b|verif|testing|waiting|blocked|needs? (?:input|info)"));

/// Linear states are grouped by `type`: triage and backlog wait (backlog), unstarted is todo,
/// started is in progress (or in review when the team named the column that way), completed is
/// done and canceled is canceled.
#[must_use]
pub fn map_linear_state_type(kind: &str, name: &str) -> IssueStatus {
    match kind {
        "unstarted" => IssueStatus::Todo,
        "started" if IN_REVIEW.is_match(name) => IssueStatus::InReview,
        "started" => IssueStatus::InProgress,
        "completed" => IssueStatus::Done,
        "canceled" => IssueStatus::Canceled,
        _ => IssueStatus::Backlog,
    }
}

/// GitHub issues are open, or closed as completed / not planned.
#[must_use]
pub fn map_github_state(state: &str, reason: Option<&str>) -> ExternalState {
    let (id, name) = if state == "open" {
        ("open", "Open")
    } else if reason == Some("not_planned") {
        ("not_planned", "Closed (not planned)")
    } else {
        ("closed", "Closed")
    };
    ExternalState { id: id.into(), name: name.into(), kind: id.into() }
}

/// The Trama status a tracker state suggests.
#[must_use]
pub fn suggest_status(provider: ExternalProvider, state: &ExternalState) -> IssueStatus {
    if provider == ExternalProvider::Linear {
        return map_linear_state_type(&state.kind, &state.name);
    }
    match state.kind.as_str() {
        "open" => IssueStatus::Backlog,
        "not_planned" => IssueStatus::Canceled,
        _ => IssueStatus::Done,
    }
}

/// The normalized external state type (`open` when the tracker's category is unknown).
#[must_use]
pub fn state_type_of(state: &ExternalState) -> ExternalStateType {
    state_type(&state.kind).unwrap_or(ExternalStateType::Open)
}

static PRIORITY_WORD: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:priority\s*[:/\-–]\s*)?(urgent|critical|blocker|high|medium|normal|low)$")
});
static PRIORITY_RANK: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:priority\s*[:/\-–]?\s*)?p([0-4])$"));

/// `priority: high`, `P1`, `urgent`… on a GitHub label. Only labels that look like a priority
/// count.
#[must_use]
pub fn priority_from_labels<S: AsRef<str>>(names: &[S]) -> Option<Priority> {
    for raw in names {
        let name = js::trim(raw.as_ref()).to_lowercase();
        if let Some(word) = PRIORITY_WORD.captures(&name).and_then(|c| c.get(1)) {
            let word = word.as_str();
            // A bare "high" or "low" is too ambiguous: only "urgent" and "critical" stand alone.
            if name.starts_with("priority") || word == "urgent" || word == "critical" {
                return Some(match word {
                    "urgent" | "critical" | "blocker" => Priority::Urgent,
                    "high" => Priority::High,
                    "medium" | "normal" => Priority::Medium,
                    _ => Priority::Low,
                });
            }
        }
        if let Some(rank) = PRIORITY_RANK.captures(&name).and_then(|c| c.get(1)) {
            return Some(match rank.as_str() {
                "0" => Priority::Urgent,
                "1" => Priority::High,
                "2" => Priority::Medium,
                _ => Priority::Low,
            });
        }
    }
    None
}

static KIND_RULES: LazyLock<Vec<(Regex, IssueKind)>> = LazyLock::new(|| {
    vec![
        (re(r"(?i)\b(security|vulnerab|cve)\b"), IssueKind::Security),
        (re(r"(?i)\b(incident|outage|sev[0-9])\b"), IssueKind::Incident),
        (re(r"(?i)\b(bug|defect|regression|crash)\b"), IssueKind::Bug),
        (re(r"(?i)\b(tech[- ]?debt|chore|refactor|cleanup|maintenance)\b"), IssueKind::TechDebt),
        (re(r"(?i)\b(feedback|customer[- ]request|support)\b"), IssueKind::Feedback),
        (re(r"(?i)\b(idea|proposal|rfc|discussion)\b"), IssueKind::Idea),
        (re(r"(?i)\b(feature|enhancement|improvement|story)\b"), IssueKind::Feature),
    ]
});

/// The first rule a label matches names the kind; otherwise the configured default.
#[must_use]
pub fn infer_kind<S: AsRef<str>>(label_names: &[S], fallback: IssueKind) -> IssueKind {
    KIND_RULES
        .iter()
        .find(|(rule, _)| label_names.iter().any(|n| rule.is_match(n.as_ref())))
        .map_or(fallback, |(_, kind)| *kind)
}

// ───────────────────────────── people and names ─────────────────────────────

/// A workspace member, as the preview matches them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    /// User id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Email.
    pub email: String,
}

fn norm(s: &str) -> String {
    js::trim(s).to_lowercase()
}

fn squash(s: &str) -> String {
    norm(s).chars().filter(char::is_ascii_alphanumeric).collect()
}

/// Matches a tracker user to a workspace member: a known external identity first (`by_login`:
/// lower-cased login → member id), then same email, then login against the email's local part,
/// then the display name. A weaker rule that matches several members matches none.
#[must_use]
pub fn suggest_user<S: std::hash::BuildHasher>(
    user: &ExternalUser,
    members: &[Member],
    by_login: Option<&HashMap<String, String, S>>,
) -> Option<String> {
    let known = user.login.as_ref().and_then(|l| by_login?.get(&l.to_lowercase()));
    if let Some(known) = known
        && members.iter().any(|m| &m.id == known)
    {
        return Some(known.clone());
    }
    if let Some(email) = user.email.as_deref().filter(|e| !e.is_empty())
        && let Some(hit) = members.iter().find(|m| norm(&m.email) == norm(email))
    {
        return Some(hit.id.clone());
    }
    let unique = |found: Vec<&Member>| match found.as_slice() {
        [one] => Some(one.id.clone()),
        _ => None,
    };
    if let Some(login) = user.login.as_deref().filter(|l| !l.is_empty()) {
        let login = squash(login);
        let local = |m: &&Member| squash(m.email.split('@').next().unwrap_or_default()) == login;
        if let Some(id) = unique(members.iter().filter(local).collect()) {
            return Some(id);
        }
    }
    let keys = [user.login.as_deref(), user.name.as_deref()]
        .into_iter()
        .flatten()
        .filter(|k| !k.is_empty())
        .map(squash)
        .filter(|k| !k.is_empty());
    for key in keys {
        if let Some(id) = unique(members.iter().filter(|m| squash(&m.name) == key).collect()) {
            return Some(id);
        }
    }
    None
}

/// An existing entity with the same name (case-insensitive).
pub fn match_by_name<'a, T>(
    name: &str,
    existing: &'a [T],
    name_of: impl Fn(&T) -> &str,
) -> Option<&'a T> {
    let key = norm(name);
    existing.iter().find(|e| norm(name_of(e)) == key)
}

/// `ENG` from a Linear key, or letters from the name; always 2-8 uppercase letters/digits and
/// not in `taken`.
///
/// # Errors
///
/// 400 when every candidate is taken.
pub fn derive_team_key(
    hint: Option<&str>,
    name: &str,
    taken: &BTreeSet<String>,
) -> Result<String, AppError> {
    let clean = |s: &str| -> String {
        s.to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect()
    };
    let mut base = clean(hint.unwrap_or_default());
    if base.is_empty() {
        base = clean(name);
    }
    let mut base = base.trim_start_matches(|c: char| c.is_ascii_digit()).to_owned();
    if base.len() < 2 {
        base = format!("{base}TM").chars().take(8).collect();
    }
    let base: String = base.chars().take(6).collect();
    if !taken.contains(&base) {
        return Ok(base);
    }
    for n in 2..1000 {
        let suffix = n.to_string();
        let head: String = base.chars().take(8 - suffix.len()).collect();
        let candidate = format!("{head}{suffix}");
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(AppError::bad_request("Could not find a free team key"))
}

// ───────────────────────────── preview and mapping ─────────────────────────────

/// A workspace entity the preview can map to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
}

/// A routing rule: a GitHub source and the project it goes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    /// Source path (`owner/repo` or `owner/*`).
    pub source_path: String,
    /// Project id.
    pub project_id: String,
}

/// What the preview matches the source against.
#[derive(Clone, Debug, Default)]
pub struct PreviewContext {
    /// Workspace members.
    pub members: Vec<Member>,
    /// Workspace teams (`id`, `name`, `key`). Trama has none; kept for the shape.
    pub teams: Vec<(String, String, String)>,
    /// Projects.
    pub projects: Vec<Named>,
    /// Issue labels of the catalog.
    pub labels: Vec<Named>,
    /// External identities of the source's host that belong to members: lower-cased login →
    /// member id.
    pub by_login: Option<HashMap<String, String>>,
    /// Routing rules. A repository they cover is suggested as that rule's project.
    pub routes: Vec<Route>,
}

const fn map(id: String) -> ImportTarget {
    ImportTarget::Map { id }
}

fn count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// Discovery plus suggested targets (existing entity with the same name, otherwise create /
/// skip).
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn build_preview(discovery: &Discovery, ctx: &PreviewContext) -> ImportPreview {
    let teams = discovery
        .teams
        .iter()
        .map(|t| {
            let hit = ctx.teams.iter().find(|(_, name, key)| {
                t.key.as_ref().is_some_and(|k| !k.is_empty() && key.eq_ignore_ascii_case(k))
                    || norm(name) == norm(&t.name)
            });
            let suggested = match hit {
                Some((id, _, _)) => map(id.clone()),
                None if discovery.provider == ExternalProvider::Linear => ImportTarget::Create,
                None => ImportTarget::Skip,
            };
            entity(t, suggested)
        })
        .collect::<Vec<_>>();
    let projects = discovery
        .projects
        .iter()
        .map(|p| {
            // A routing rule already says where this repository's work goes: that wins over a
            // name match.
            let routed = if discovery.provider == ExternalProvider::Github {
                ctx.routes
                    .iter()
                    .filter(|r| source_includes(&r.source_path, &p.name))
                    .max_by_key(|r| specificity(&r.source_path, &RoutingFilters::default()))
            } else {
                None
            };
            let suggested = match routed {
                Some(r) => map(r.project_id.clone()),
                None => match_by_name(&p.name, &ctx.projects, |n| &n.name)
                    .map_or(ImportTarget::Create, |hit| map(hit.id.clone())),
            };
            entity(p, suggested)
        })
        .collect::<Vec<_>>();
    let labels = discovery
        .labels
        .iter()
        .map(|l| {
            let suggested = match_by_name(&l.name, &ctx.labels, |n| &n.name)
                .map_or(ImportTarget::Create, |hit| map(hit.id.clone()));
            entity(l, suggested)
        })
        .collect::<Vec<_>>();
    let users = discovery
        .users
        .iter()
        .map(|u| ImportPreviewUser {
            id: u.id.clone(),
            name: u.name.clone(),
            login: u.login.clone(),
            email: u.email.clone(),
            suggested_user_id: suggest_user(u, &ctx.members, ctx.by_login.as_ref()),
        })
        .collect::<Vec<_>>();
    let statuses = discovery
        .statuses
        .iter()
        .map(|s| ImportPreviewStatus {
            id: s.state.id.clone(),
            name: s.state.name.clone(),
            kind: s.state.kind.clone(),
            count: s.count,
            suggested: suggest_status(discovery.provider, &s.state),
        })
        .collect();
    ImportPreview {
        provider: discovery.provider,
        account: discovery.account.clone(),
        source_label: discovery.source_label.clone(),
        source_url: discovery.source_url.clone(),
        counts: ImportPreviewCounts {
            issues: discovery.counts.issues,
            open: discovery.counts.open,
            closed: discovery.counts.closed,
            projects: count(projects.len()),
            milestones: count(discovery.milestones.len()),
            labels: count(labels.len()),
            users: count(users.len()),
        },
        teams,
        projects,
        labels,
        milestones: discovery
            .milestones
            .iter()
            .map(|m| ImportPreviewMilestone {
                id: m.id.clone(),
                name: m.name.clone(),
                project_id: m.project_id.clone(),
                due_on: m.due_on.clone(),
            })
            .collect(),
        users,
        statuses,
        sample: discovery
            .sample
            .iter()
            .map(|s| ImportPreviewSample {
                key: s.key.clone(),
                title: s.title.clone(),
                state: s.state.clone(),
            })
            .collect(),
        warnings: discovery.warnings.clone(),
    }
}

fn entity(e: &crate::types::DiscoveredEntity, suggested: ImportTarget) -> ImportPreviewEntity {
    ImportPreviewEntity {
        id: e.id.clone(),
        name: e.name.clone(),
        key: e.key.clone(),
        color: e.color.clone(),
        count: e.count,
        suggested,
    }
}

/// The mapping the preview suggests, for callers (agents, "run with defaults") that do not edit
/// it.
#[must_use]
pub fn mapping_from_preview(preview: &ImportPreview) -> ImportMapping {
    let targets = |items: &[ImportPreviewEntity]| {
        items.iter().map(|e| (e.id.clone(), e.suggested.clone())).collect()
    };
    ImportMapping {
        teams: targets(&preview.teams),
        projects: targets(&preview.projects),
        labels: targets(&preview.labels),
        users: preview.users.iter().map(|u| (u.id.clone(), u.suggested_user_id.clone())).collect(),
        statuses: preview.statuses.iter().map(|s| (s.id.clone(), s.suggested)).collect(),
    }
}

fn record<'a>(
    raw: Option<&'a Value>,
    label: &str,
) -> Result<Vec<(&'a String, &'a Value)>, AppError> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let Some(object) = raw.as_object() else {
        return Err(AppError::bad_request(format!("mapping.{label} must be an object")));
    };
    if object.len() > MAX_MAPPING_ENTRIES {
        return Err(AppError::bad_request(format!("mapping.{label} has too many entries")));
    }
    if object.keys().any(|k| k.is_empty() || js::len(k) > 300) {
        return Err(AppError::bad_request(format!("mapping.{label} has an invalid key")));
    }
    Ok(object.iter().collect())
}

fn target(raw: &Value, place: &str) -> Result<ImportTarget, AppError> {
    if let Some(t) = raw.as_object() {
        match t.get("action").and_then(Value::as_str) {
            Some("skip") => return Ok(ImportTarget::Skip),
            Some("create") => return Ok(ImportTarget::Create),
            Some("map") => {
                if let Some(id) = t.get("id").and_then(Value::as_str)
                    && !id.is_empty()
                    && js::len(id) <= 100
                {
                    return Ok(map(id.to_owned()));
                }
            }
            _ => {}
        }
    }
    Err(AppError::bad_request(format!(
        r#"{place} must be {{action: "map", id}} | {{action: "create"}} | {{action: "skip"}}"#
    )))
}

/// Strict parse of a user-supplied mapping: unknown shapes are a 400, never silently dropped.
///
/// # Errors
///
/// 400 naming the first entry that does not fit.
pub fn parse_mapping(raw: Option<&Value>) -> Result<ImportMapping, AppError> {
    let mut out = ImportMapping::default();
    let Some(raw) = raw.filter(|v| !v.is_null()) else { return Ok(out) };
    let Some(m) = raw.as_object() else {
        return Err(AppError::bad_request("mapping must be an object"));
    };
    for (kind, slot) in
        [("teams", &mut out.teams), ("projects", &mut out.projects), ("labels", &mut out.labels)]
    {
        for (k, v) in record(m.get(kind), kind)? {
            slot.insert(k.clone(), target(v, &format!(r#"mapping.{kind}["{k}"]"#))?);
        }
    }
    for (k, v) in record(m.get("users"), "users")? {
        let user = match v {
            Value::Null => None,
            Value::String(s) if !s.is_empty() && js::len(s) <= 100 => Some(s.clone()),
            _ => {
                return Err(AppError::bad_request(format!(
                    r#"mapping.users["{k}"] must be a user id or null"#
                )));
            }
        };
        out.users.insert(k.clone(), user);
    }
    for (k, v) in record(m.get("statuses"), "statuses")? {
        let Some(status) = v.as_str().and_then(IssueStatus::parse) else {
            let all = IssueStatus::ALL.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            return Err(AppError::bad_request(format!(
                r#"mapping.statuses["{k}"] must be one of {all}"#
            )));
        };
        out.statuses.insert(k.clone(), status);
    }
    Ok(out)
}

/// Parses `options` over `defaults`.
///
/// # Errors
///
/// 400 for a non-object, a non-boolean flag or an unknown kind.
pub fn parse_options(
    raw: Option<&Value>,
    defaults: ImportOptions,
) -> Result<ImportOptions, AppError> {
    let empty = serde_json::Map::new();
    let o = match raw {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(o)) => o,
        Some(_) => return Err(AppError::bad_request("options must be an object")),
    };
    let flag = |name: &str, d: bool| match o.get(name) {
        None => Ok(d),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(AppError::bad_request(format!("options.{name} must be a boolean"))),
    };
    let default_kind = match o.get("defaultKind") {
        None => defaults.default_kind,
        Some(v) => v.as_str().and_then(IssueKind::parse).ok_or_else(|| {
            let all = IssueKind::ALL.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ");
            AppError::bad_request(format!("options.defaultKind must be one of {all}"))
        })?,
    };
    Ok(ImportOptions {
        include_comments: flag("includeComments", defaults.include_comments)?,
        include_closed: flag("includeClosed", defaults.include_closed)?,
        default_kind,
    })
}

// ───────────────────────────── issue conversion ─────────────────────────────

/// Trama ids the mapping resolved to, per external id. `None` = skipped. Stored in the job's
/// cursor (`cursor.plan`), so the JSON shape is the NestJS one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedPlan {
    /// Linear teams (always `null`: Trama has no teams).
    #[serde(default)]
    pub teams: BTreeMap<String, Option<String>>,
    /// Projects.
    #[serde(default)]
    pub projects: BTreeMap<String, Option<String>>,
    /// Labels.
    #[serde(default)]
    pub labels: BTreeMap<String, Option<String>>,
    /// Milestones.
    #[serde(default)]
    pub milestones: BTreeMap<String, Option<String>>,
    /// Users.
    #[serde(default)]
    pub users: BTreeMap<String, Option<String>>,
    /// States.
    #[serde(default)]
    pub statuses: BTreeMap<String, IssueStatus>,
}

/// The fields of a Trama issue created from an external one.
#[derive(Clone, Debug, PartialEq)]
pub struct NewIssue {
    /// The reference back to the tracker.
    pub external_ref: ExternalRef,
    /// Kind.
    pub kind: IssueKind,
    /// Title.
    pub title: String,
    /// Body.
    pub body: Option<String>,
    /// `github` / `linear`.
    pub source: ExternalProvider,
    /// The tracker author's name.
    pub reporter_name: Option<String>,
    /// Assignee.
    pub assignee_id: Option<String>,
    /// Team (always `None`).
    pub team_id: Option<String>,
    /// Project.
    pub project_id: Option<String>,
    /// Milestones.
    pub milestone_ids: Vec<String>,
    /// Priority.
    pub priority: Priority,
    /// Status.
    pub status: IssueStatus,
    /// Estimate.
    pub estimate: Option<f64>,
    /// Label ids.
    pub labels: Vec<String>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Update time.
    pub updated_at: DateTime<Utc>,
    /// Start time.
    pub started_at: Option<DateTime<Utc>>,
    /// Completion time.
    pub completed_at: Option<DateTime<Utc>>,
}

/// Parses a tracker timestamp like `new Date(value)` does for the shapes trackers send
/// (RFC 3339, or a bare `YYYY-MM-DD` as UTC midnight).
#[must_use]
pub fn parse_date(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).map(|d| d.with_timezone(&Utc)).ok().or_else(|| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|d| d.and_utc())
    })
}

fn date(value: Option<&str>, fallback: DateTime<Utc>) -> DateTime<Utc> {
    value.filter(|v| !v.is_empty()).and_then(parse_date).unwrap_or(fallback)
}

/// The `ExternalRef` of an external issue.
#[must_use]
pub fn external_ref_of(
    provider: ExternalProvider,
    ext: &ExternalIssue,
    origin: ExternalRefOrigin,
    now: DateTime<Utc>,
) -> ExternalRef {
    ExternalRef {
        provider,
        id: ext.id.clone(),
        url: ext.url.clone(),
        key: Some(ext.key.clone()),
        state: Some(ext.state.name.clone()),
        state_type: Some(state_type_of(&ext.state)),
        synced_at: Some(trama_core::time::to_iso(&now)),
        origin,
    }
}

/// Pure conversion of one external issue into the fields of a Trama issue, given the resolved
/// plan.
#[must_use]
pub fn to_new_issue(
    provider: ExternalProvider,
    ext: &ExternalIssue,
    plan: &ResolvedPlan,
    options: &ImportOptions,
    now: DateTime<Utc>,
) -> NewIssue {
    let label_names: Vec<&str> = ext.labels.iter().map(|l| l.name.as_str()).collect();
    let status = plan
        .statuses
        .get(&ext.state.id)
        .copied()
        .unwrap_or_else(|| suggest_status(provider, &ext.state));
    let created_at = date(Some(&ext.created_at), now);
    let updated_at = date(Some(&ext.updated_at), created_at);
    let mut labels: Vec<String> = Vec::new();
    for l in &ext.labels {
        if let Some(Some(id)) = plan.labels.get(&l.id)
            && !id.is_empty()
            && !labels.contains(id)
        {
            labels.push(id.clone());
        }
    }
    labels.truncate(20);
    let milestone_id =
        ext.milestone.as_ref().and_then(|m| plan.milestones.get(&m.id).cloned().flatten());
    let priority =
        ext.priority.or_else(|| priority_from_labels(&label_names)).unwrap_or(Priority::None);
    let finished = matches!(status, IssueStatus::Done | IssueStatus::Canceled);
    let started = matches!(status, IssueStatus::InProgress | IssueStatus::InReview);
    let estimate = ext.estimate.filter(|e| e.is_finite() && *e >= 0.0).map(|e| e.min(1000.0));
    let title = js::truncate(js::trim(&ext.title), MAX_TITLE);
    let title = if title.is_empty() { ext.key.clone() } else { title.to_owned() };
    let lookup = |map: &BTreeMap<String, Option<String>>, key: Option<&String>| {
        key.and_then(|k| map.get(k).cloned().flatten())
    };
    NewIssue {
        external_ref: external_ref_of(provider, ext, ExternalRefOrigin::Import, now),
        kind: infer_kind(&label_names, options.default_kind),
        title,
        body: ext
            .body
            .as_deref()
            .filter(|b| !b.is_empty())
            .map(|b| js::truncate(b, MAX_BODY).to_owned()),
        source: provider,
        reporter_name: ext
            .creator
            .as_ref()
            .and_then(|c| c.name.clone().or_else(|| c.login.clone())),
        assignee_id: lookup(&plan.users, ext.assignee.as_ref().map(|a| &a.id)),
        team_id: lookup(&plan.teams, ext.team_id.as_ref()),
        project_id: lookup(&plan.projects, ext.project_id.as_ref()),
        milestone_ids: milestone_id.into_iter().collect(),
        priority,
        status,
        estimate,
        labels,
        created_at,
        updated_at,
        started_at: (started || finished).then(|| date(ext.started_at.as_deref(), created_at)),
        completed_at: finished.then(|| date(ext.closed_at.as_deref(), updated_at)),
    }
}

static HEX_COLOR: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^#[0-9a-f]{6}$"));

/// Colour for a created label: the tracker's when valid, otherwise none (the catalog picks one).
#[must_use]
pub fn label_color(color: Option<&str>) -> Option<String> {
    color.filter(|c| HEX_COLOR.is_match(c)).map(str::to_lowercase)
}

/// A label name, trimmed and capped.
#[must_use]
pub fn label_name(name: &str) -> String {
    js::truncate(js::trim(name), LABEL_NAME_MAX).to_owned()
}

// ───────────────────────────── URLs ─────────────────────────────

static LINEAR_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r"^/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)(?:/|$)"));
static GITHUB_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r"^/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(?:issues|pull)/(\d+)/?$"));

/// Recognises an issue URL of GitHub (any host: the caller decides which hosts it trusts) or
/// Linear.
#[must_use]
pub fn parse_external_url(raw: &str) -> Option<ParsedExternalUrl> {
    let url = url::Url::parse(js::trim(raw)).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    let path = url.path();
    if host == "linear.app" {
        let identifier = LINEAR_PATH.captures(path)?.get(1)?.as_str().to_uppercase();
        let head = path.split('/').take(4).collect::<Vec<_>>().join("/");
        return Some(ParsedExternalUrl {
            provider: ExternalProvider::Linear,
            host,
            repository: None,
            number: None,
            url: format!("https://linear.app{head}/{identifier}"),
            identifier: Some(identifier),
        });
    }
    let caps = GITHUB_PATH.captures(path)?;
    let (owner, name, number) = (&caps[1], &caps[2], &caps[3]);
    let origin = url.origin().ascii_serialization();
    Some(ParsedExternalUrl {
        provider: ExternalProvider::Github,
        host,
        repository: Some(format!("{owner}/{name}")),
        number: number.parse().ok(),
        identifier: None,
        url: format!("{origin}/{owner}/{name}/issues/{number}"),
    })
}

/// GitHub external id: `owner/repo#12`, lower-cased so the same issue always has the same id.
#[must_use]
pub fn github_issue_id(repository: &str, number: u64) -> String {
    format!("{}#{number}", repository.to_lowercase())
}

// ───────────────────────────── secrets ─────────────────────────────

static TOKEN_SHAPES: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        re(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
        re(r"\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b"),
    ]
});
static AUTH_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}"));

/// Removes the given secrets and anything shaped like a GitHub / Linear token or auth header from
/// text that will be stored or logged.
#[must_use]
pub fn redact_secrets(text: &str, secrets: &[Option<&str>]) -> String {
    let mut out = text.to_owned();
    for s in secrets.iter().flatten() {
        if s.len() >= 6 {
            out = out.replace(s, "[redacted]");
        }
    }
    for shape in TOKEN_SHAPES.iter() {
        out = shape.replace_all(&out, "[redacted]").into_owned();
    }
    AUTH_SCHEME.replace_all(&out, "$1 [redacted]").into_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{
        DiscoveredEntity, DiscoveredState, DiscoveryCounts, ExternalLabel, ExternalMilestone,
    };

    fn member(id: &str, name: &str, email: &str) -> Member {
        Member { id: id.into(), name: name.into(), email: email.into() }
    }

    #[test]
    fn linear_states_and_priorities() {
        assert_eq!(map_linear_priority(Some(1)), Priority::Urgent);
        assert_eq!(map_linear_priority(Some(4)), Priority::Low);
        assert_eq!(map_linear_priority(None), Priority::None);
        assert_eq!(map_linear_state_type("triage", ""), IssueStatus::Backlog);
        assert_eq!(map_linear_state_type("unstarted", "Todo"), IssueStatus::Todo);
        assert_eq!(map_linear_state_type("started", "In Review"), IssueStatus::InReview);
        assert_eq!(map_linear_state_type("started", "QA"), IssueStatus::InReview);
        assert_eq!(map_linear_state_type("started", "In Progress"), IssueStatus::InProgress);
        assert_eq!(map_linear_state_type("completed", "Done"), IssueStatus::Done);
        assert_eq!(map_linear_state_type("weird", ""), IssueStatus::Backlog);
    }

    #[test]
    fn github_states_suggest_backlog_done_or_canceled() {
        let open = map_github_state("open", None);
        assert_eq!(suggest_status(ExternalProvider::Github, &open), IssueStatus::Backlog);
        let np = map_github_state("closed", Some("not_planned"));
        assert_eq!(np.name, "Closed (not planned)");
        assert_eq!(suggest_status(ExternalProvider::Github, &np), IssueStatus::Canceled);
        assert_eq!(state_type_of(&np), ExternalStateType::Canceled);
        let done = map_github_state("closed", Some("completed"));
        assert_eq!(suggest_status(ExternalProvider::Github, &done), IssueStatus::Done);
    }

    #[test]
    fn priorities_come_only_from_priority_shaped_labels() {
        assert_eq!(priority_from_labels(&["priority: high"]), Some(Priority::High));
        assert_eq!(priority_from_labels(&["P0"]), Some(Priority::Urgent));
        assert_eq!(priority_from_labels(&["priority-p3"]), Some(Priority::Low));
        assert_eq!(priority_from_labels(&["Critical"]), Some(Priority::Urgent));
        assert_eq!(priority_from_labels(&["high"]), None);
        assert_eq!(priority_from_labels(&["bug"]), None);
    }

    #[test]
    fn kinds_follow_the_first_matching_rule() {
        assert_eq!(infer_kind(&["Bug", "security"], IssueKind::Feature), IssueKind::Security);
        assert_eq!(infer_kind(&["type: bug"], IssueKind::Feature), IssueKind::Bug);
        assert_eq!(infer_kind(&["tech-debt"], IssueKind::Feature), IssueKind::TechDebt);
        assert_eq!(infer_kind(&["debugging"], IssueKind::Idea), IssueKind::Idea);
    }

    #[test]
    fn users_match_by_identity_email_login_then_unique_name() {
        let members = [
            member("u_ana", "Ana Lima", "ana@acme.test"),
            member("u_bo", "Bo", "bo.smith@acme.test"),
            member("u_bo2", "Bo", "other@acme.test"),
        ];
        let by_login = HashMap::from([("octo".to_owned(), "u_bo2".to_owned())]);
        let gh = |login: &str| ExternalUser {
            id: login.into(),
            login: Some(login.into()),
            ..Default::default()
        };
        assert_eq!(suggest_user(&gh("Octo"), &members, Some(&by_login)), Some("u_bo2".into()));
        let mail = ExternalUser {
            id: "1".into(),
            email: Some("ANA@acme.test".into()),
            ..Default::default()
        };
        assert_eq!(
            suggest_user(&mail, &members, None::<&HashMap<String, String>>),
            Some("u_ana".into())
        );
        assert_eq!(
            suggest_user(&gh("bo-smith"), &members, None::<&HashMap<String, String>>),
            Some("u_bo".into())
        );
        let named = ExternalUser { id: "2".into(), name: Some("Bo".into()), ..Default::default() };
        assert_eq!(suggest_user(&named, &members, None::<&HashMap<String, String>>), None);
    }

    #[test]
    fn team_keys_are_derived_and_unique() {
        let taken = BTreeSet::from(["ENG".to_owned()]);
        assert_eq!(derive_team_key(Some("eng"), "Engineering", &taken).unwrap(), "ENG2");
        assert_eq!(derive_team_key(None, "9 Lives", &BTreeSet::new()).unwrap(), "LIVES");
        assert_eq!(derive_team_key(None, "x", &BTreeSet::new()).unwrap(), "XTM");
    }

    fn discovery(provider: ExternalProvider) -> Discovery {
        Discovery {
            provider,
            account: "octocat".into(),
            source_label: "acme/app".into(),
            source_url: None,
            counts: DiscoveryCounts { issues: Some(3), open: Some(2), closed: Some(1) },
            teams: vec![],
            projects: vec![DiscoveredEntity {
                id: "repo".into(),
                name: "acme/app".into(),
                ..Default::default()
            }],
            labels: vec![
                DiscoveredEntity { id: "l1".into(), name: "Bug".into(), ..Default::default() },
                DiscoveredEntity { id: "l2".into(), name: "New".into(), ..Default::default() },
            ],
            milestones: vec![ExternalMilestone {
                id: "m1".into(),
                name: "v1".into(),
                project_id: Some("repo".into()),
                description: None,
                due_on: None,
            }],
            users: vec![ExternalUser {
                id: "9".into(),
                login: Some("ana".into()),
                ..Default::default()
            }],
            statuses: vec![DiscoveredState {
                state: map_github_state("open", None),
                count: Some(2),
            }],
            sample: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn the_preview_suggests_routes_names_and_people() {
        let ctx = PreviewContext {
            members: vec![member("u_ana", "Ana", "ana@acme.test")],
            labels: vec![Named { id: "lb_bug".into(), name: "bug".into() }],
            routes: vec![
                Route { source_path: "acme/*".into(), project_id: "pj_group".into() },
                Route { source_path: "acme/app".into(), project_id: "pj_app".into() },
            ],
            ..Default::default()
        };
        let preview = build_preview(&discovery(ExternalProvider::Github), &ctx);
        assert_eq!(preview.projects[0].suggested, map("pj_app".into()));
        assert_eq!(preview.labels[0].suggested, map("lb_bug".into()));
        assert_eq!(preview.labels[1].suggested, ImportTarget::Create);
        assert_eq!(preview.users[0].suggested_user_id.as_deref(), Some("u_ana"));
        assert_eq!(preview.counts.projects, 1);
        assert_eq!(preview.counts.milestones, 1);
        assert_eq!(preview.statuses[0].suggested, IssueStatus::Backlog);
        let mapping = mapping_from_preview(&preview);
        assert_eq!(mapping.projects["repo"], map("pj_app".into()));
        assert_eq!(mapping.users["9"].as_deref(), Some("u_ana"));
        assert_eq!(mapping.statuses["open"], IssueStatus::Backlog);
    }

    #[test]
    fn mappings_are_parsed_strictly() {
        let m = parse_mapping(Some(&json!({
            "projects": { "p": { "action": "map", "id": "pj_1" } },
            "labels": { "l": { "action": "create" } },
            "users": { "u": null, "v": "u_1" },
            "statuses": { "s": "done" },
        })))
        .unwrap();
        assert_eq!(m.projects["p"], map("pj_1".into()));
        assert_eq!(m.users["u"], None);
        assert_eq!(m.statuses["s"], IssueStatus::Done);
        assert_eq!(parse_mapping(None).unwrap(), ImportMapping::default());
        let bad = |v: Value| parse_mapping(Some(&v)).unwrap_err().to_string();
        assert!(bad(json!([])).contains("mapping must be an object"));
        assert!(
            bad(json!({ "projects": { "p": { "action": "map" } } }))
                .contains(r#"mapping.projects["p"] must be"#)
        );
        assert!(bad(json!({ "users": { "u": 3 } })).contains("must be a user id or null"));
        assert!(
            bad(json!({ "statuses": { "s": "nope" } })).contains("must be one of draft, backlog")
        );
        assert!(bad(json!({ "labels": [] })).contains("mapping.labels must be an object"));
    }

    #[test]
    fn options_fall_back_to_the_defaults() {
        let d = trama_contracts::imports::DEFAULT_IMPORT_OPTIONS;
        assert_eq!(parse_options(None, d).unwrap(), d);
        let o = parse_options(Some(&json!({ "includeComments": true, "defaultKind": "bug" })), d)
            .unwrap();
        assert!(o.include_comments && o.include_closed);
        assert_eq!(o.default_kind, IssueKind::Bug);
        assert!(parse_options(Some(&json!({ "includeClosed": "yes" })), d).is_err());
        assert!(parse_options(Some(&json!({ "defaultKind": "epic" })), d).is_err());
        assert!(parse_options(Some(&json!([])), d).is_err());
    }

    fn issue() -> ExternalIssue {
        ExternalIssue {
            id: "acme/app#7".into(),
            key: "#7".into(),
            url: "https://github.com/acme/app/issues/7".into(),
            title: "  Crash on start  ".into(),
            body: Some(String::new()),
            state: map_github_state("closed", None),
            priority: None,
            estimate: Some(5000.0),
            labels: vec![
                ExternalLabel { id: "l1".into(), name: "bug".into(), color: None },
                ExternalLabel { id: "l2".into(), name: "P1".into(), color: None },
                ExternalLabel { id: "l3".into(), name: "dup".into(), color: None },
            ],
            assignee: Some(ExternalUser { id: "9".into(), ..Default::default() }),
            creator: Some(ExternalUser {
                id: "8".into(),
                login: Some("octo".into()),
                ..Default::default()
            }),
            team_id: None,
            project_id: Some("repo".into()),
            milestone: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-03T00:00:00Z".into(),
            started_at: None,
            closed_at: Some("2025-01-02T00:00:00Z".into()),
        }
    }

    #[test]
    fn issues_convert_with_the_plan() {
        let plan = ResolvedPlan {
            projects: BTreeMap::from([("repo".into(), Some("pj_1".into()))]),
            labels: BTreeMap::from([
                ("l1".into(), Some("lb_bug".into())),
                ("l2".into(), None),
                ("l3".into(), Some("lb_bug".into())),
            ]),
            users: BTreeMap::from([("9".into(), Some("u_ana".into()))]),
            ..Default::default()
        };
        let now = Utc::now();
        let d = trama_contracts::imports::DEFAULT_IMPORT_OPTIONS;
        let n = to_new_issue(ExternalProvider::Github, &issue(), &plan, &d, now);
        assert_eq!(n.title, "Crash on start");
        assert_eq!(n.body, None);
        assert_eq!(n.kind, IssueKind::Bug);
        assert_eq!(n.priority, Priority::High);
        assert_eq!(n.status, IssueStatus::Done);
        assert_eq!(n.labels, vec!["lb_bug".to_owned()]);
        assert_eq!(n.project_id.as_deref(), Some("pj_1"));
        assert_eq!(n.assignee_id.as_deref(), Some("u_ana"));
        assert_eq!(n.reporter_name.as_deref(), Some("octo"));
        assert_eq!(n.estimate, Some(1000.0));
        assert_eq!(n.started_at, parse_date("2025-01-01T00:00:00Z"));
        assert_eq!(n.completed_at, parse_date("2025-01-02T00:00:00Z"));
        assert_eq!(n.external_ref.state_type, Some(ExternalStateType::Done));
        assert_eq!(n.external_ref.origin, ExternalRefOrigin::Import);
        let mut open = issue();
        open.state = map_github_state("open", None);
        open.title = "   ".into();
        let n = to_new_issue(ExternalProvider::Github, &open, &plan, &d, now);
        assert_eq!(n.title, "#7");
        assert_eq!(n.started_at, None);
        assert_eq!(n.completed_at, None);
    }

    #[test]
    fn urls_of_github_and_linear_are_recognised() {
        let gh = parse_external_url("https://github.com/Acme/App/pull/12/").unwrap();
        assert_eq!(gh.provider, ExternalProvider::Github);
        assert_eq!(gh.repository.as_deref(), Some("Acme/App"));
        assert_eq!(gh.number, Some(12));
        assert_eq!(gh.url, "https://github.com/Acme/App/issues/12");
        let lin = parse_external_url("https://linear.app/acme/issue/eng-123/some-slug").unwrap();
        assert_eq!(lin.identifier.as_deref(), Some("ENG-123"));
        assert!(parse_external_url("https://linear.app/acme/projects/x").is_none());
        assert!(parse_external_url("https://u:p@github.com/a/b/issues/1").is_none());
        assert!(parse_external_url("ftp://github.com/a/b/issues/1").is_none());
        assert!(parse_external_url("not a url").is_none());
        assert_eq!(github_issue_id("Acme/App", 3), "acme/app#3");
    }

    #[test]
    fn secrets_and_token_shapes_are_redacted() {
        let text =
            "failed with ghp_abcdefghijklmnopqrstuvwxyz and Bearer abc.def.ghi and mysecret1";
        let out = redact_secrets(text, &[Some("mysecret1"), None, Some("x")]);
        assert_eq!(out, "failed with [redacted] and Bearer [redacted] and [redacted]");
        assert_eq!(redact_secrets("lin_api_aaaaaaaaaaaaaaaaaaaaaaaa", &[]), "[redacted]");
    }

    #[test]
    fn label_colours_and_names() {
        assert_eq!(label_color(Some("#AABBCC")).as_deref(), Some("#aabbcc"));
        assert_eq!(label_color(Some("abc")), None);
        assert_eq!(label_name("  a  "), "a");
    }
}
