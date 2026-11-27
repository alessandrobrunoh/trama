//! The insights report (`GET /insights`): health signals, flow metrics and contributors.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{Id, IsoDate};

/// Time windows offered by `GET /insights`, in days.
pub const INSIGHT_RANGES: [u32; 3] = [7, 30, 90];

string_enum! {
    /// A health signal: something that is going wrong right now.
    pub enum InsightSignalId {
        StaleIssues = "stale_issues",
        OverdueMilestones = "overdue_milestones",
        PrsStuckInReview = "prs_stuck_in_review",
        CiFailing = "ci_failing",
    }
}

/// `INSIGHT_SIGNAL_IDS`.
pub const INSIGHT_SIGNAL_IDS: &[InsightSignalId] = InsightSignalId::ALL;

/// `INSIGHT_SIGNALS[id]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct InsightSignalMeta {
    /// Display name.
    pub label: &'static str,
    /// What exactly is counted.
    pub definition: &'static str,
    /// Singular noun used to describe the counted items.
    pub unit: &'static str,
}

impl InsightSignalId {
    /// `INSIGHT_SIGNALS[id]`.
    #[must_use]
    pub const fn meta(self) -> InsightSignalMeta {
        let (label, definition, unit) = match self {
            Self::StaleIssues => (
                "Stale issues",
                "Issues In Progress or In Review that were not updated for the stale threshold.",
                "issue",
            ),
            Self::OverdueMilestones => (
                "Overdue milestones",
                "Milestones past their target date that still have open issues, in projects that are not completed or canceled.",
                "milestone",
            ),
            Self::PrsStuckInReview => (
                "PRs stuck in review",
                "Open, non-draft pull requests without an approval and without an update for 3 days or more.",
                "pull request",
            ),
            Self::CiFailing => (
                "CI failing",
                "Open pull requests whose latest CI result is failing.",
                "pull request",
            ),
        };
        InsightSignalMeta { label, definition, unit }
    }
}

string_enum! {
    /// Kind of an insight item.
    pub enum InsightItemType {
        Issue = "issue",
        Milestone = "milestone",
        Artifact = "artifact",
        Project = "project",
    }
}

string_enum! {
    /// Who an insight actor is.
    pub enum InsightActorType {
        User = "user",
        Agent = "agent",
        Unassigned = "unassigned",
    }
}

/// A person, an agent, or nobody.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InsightActor {
    /// Kind.
    #[serde(rename = "type")]
    pub kind: InsightActorType,
    /// Id (absent for `unassigned`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    /// Display name.
    pub name: String,
}

/// One thing that causes a signal (or sits in a flow list).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightItem {
    /// Kind.
    #[serde(rename = "type")]
    pub kind: InsightItemType,
    /// Record id.
    pub id: Id,
    /// Human key when the type has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Title.
    pub title: String,
    /// Project of a milestone or project item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Id>,
    /// When the condition started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<IsoDate>,
    /// Days since `since` (rounded to one decimal).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub age_days: Option<f64>,
    /// Who has to act, when that is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_on: Option<InsightActor>,
    /// Metric-specific number, see `detail`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub value: Option<f64>,
    /// One sentence that says why the item is in the list.
    pub detail: String,
}

string_enum! {
    /// Severity of a signal.
    pub enum InsightSeverity {
        Ok = "ok",
        Info = "info",
        Warning = "warning",
        Critical = "critical",
    }
}

/// A computed health signal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightSignal {
    /// Signal id.
    pub id: InsightSignalId,
    /// Display name.
    pub label: String,
    /// What is counted.
    pub definition: String,
    /// Unit noun.
    pub unit: String,
    /// `ok` when nothing is wrong.
    pub severity: InsightSeverity,
    /// All matching items (before the item limit).
    pub count: i64,
    /// Age in days of the oldest item.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub oldest_days: Option<f64>,
    /// The worst items first, at most the requested `limit`.
    pub items: Vec<InsightItem>,
    /// More items matched than are listed.
    pub truncated: bool,
}

/// Reviews waiting on one actor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightBottleneck {
    /// Who.
    pub actor: InsightActor,
    /// Reviews waiting.
    pub reviews: i64,
    /// Oldest wait, days.
    #[serde(serialize_with = "crate::js::number")]
    pub oldest_days: f64,
    /// Sum of waiting days.
    #[serde(serialize_with = "crate::js::number")]
    pub total_wait_days: f64,
}

/// Percentiles of a duration, in days.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DurationStats {
    /// Samples.
    pub count: i64,
    /// Median.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub p50: Option<f64>,
    /// 85th percentile.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub p85: Option<f64>,
    /// 95th percentile.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub p95: Option<f64>,
    /// Mean.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub mean: Option<f64>,
    /// Maximum.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub max: Option<f64>,
}

/// One histogram bucket, in days.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct HistogramBucket {
    /// Label.
    pub label: String,
    /// Inclusive lower bound.
    #[serde(serialize_with = "crate::js::number")]
    pub from: f64,
    /// Exclusive upper bound. Omitted on the last bucket.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub to: Option<f64>,
    /// Items.
    pub count: i64,
}

/// A duration measure with comparison, histogram and tail.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct FlowDuration {
    /// This period.
    pub stats: DurationStats,
    /// Same measure over the period before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<DurationStats>,
    /// Distribution.
    pub histogram: Vec<HistogramBucket>,
    /// Slowest finished items in the range.
    pub slowest: Vec<InsightItem>,
}

/// Issues finished in one bucket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThroughputBucket {
    /// Start.
    pub start: IsoDate,
    /// End.
    pub end: IsoDate,
    /// Issues done.
    pub issues_done: i64,
}

/// Work in progress of one actor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct InsightWipRow {
    /// Who.
    pub actor: InsightActor,
    /// Issues In Progress or In Review assigned to them.
    pub issues: i64,
    /// Over the limit.
    pub overloaded: bool,
    /// The issues.
    pub items: Vec<InsightItem>,
}

/// An item that has been in progress for a while.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgingItem {
    /// The item.
    #[serde(flatten)]
    pub item: InsightItem,
    /// Issue status catalog id.
    pub status: String,
    /// Days in progress.
    #[serde(serialize_with = "crate::js::number")]
    pub in_progress_days: f64,
    /// Older than the p85 cycle time of recent work.
    pub over_baseline: bool,
}

/// One status series of the cumulative flow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct CumulativeFlowSeries {
    /// Issue status.
    pub status: String,
    /// One value per day.
    #[serde(serialize_with = "crate::js::numbers")]
    pub values: Vec<f64>,
}

/// Cumulative flow diagram.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct CumulativeFlow {
    /// One ISO day per column, oldest first.
    pub days: Vec<IsoDate>,
    /// Series.
    pub series: Vec<CumulativeFlowSeries>,
}

/// `previousThroughput`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviousThroughput {
    /// Issues done in the period before.
    pub issues_done: i64,
}

/// WIP limits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WipLimits {
    /// Issues per person.
    pub issues: i64,
}

/// Work in progress.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct InsightWip {
    /// People.
    pub people: Vec<InsightWipRow>,
    /// Agents.
    pub agents: Vec<InsightWipRow>,
    /// Limits.
    pub limits: WipLimits,
}

/// Aging work.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightAging {
    /// p85 cycle time baseline.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub baseline_days: Option<f64>,
    /// Samples behind the baseline.
    pub baseline_samples: i64,
    /// Items.
    pub items: Vec<AgingItem>,
}

/// Flow metrics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightFlow {
    /// Cycle time.
    pub issue_cycle: FlowDuration,
    /// Lead time.
    pub issue_lead: FlowDuration,
    /// Throughput.
    pub throughput: Vec<ThroughputBucket>,
    /// Throughput of the period before.
    pub previous_throughput: PreviousThroughput,
    /// Work in progress.
    pub wip: InsightWip,
    /// Aging work.
    pub aging: InsightAging,
    /// Cumulative flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative_flow: Option<CumulativeFlow>,
}

/// One contributor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightContributor {
    /// Who.
    pub actor: InsightActor,
    /// Events recorded by this actor in the range.
    pub events: i64,
    /// Issues done.
    pub issues_done: i64,
    /// Comments.
    pub comments: i64,
    /// Pull requests.
    pub pull_requests: i64,
    /// Last activity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<IsoDate>,
}

/// Failure counts of one agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentFailureRow {
    /// The agent.
    pub agent: InsightActor,
    /// Pull requests.
    pub pull_requests: i64,
    /// Closed without being merged.
    pub pull_requests_abandoned: i64,
    /// With failing CI.
    pub pull_requests_ci_failing: i64,
    /// Issues this agent moved to Done that someone moved out of Done again.
    pub issues_reopened: i64,
}

/// Share of recorded events.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ActorShare {
    /// People.
    #[serde(serialize_with = "crate::js::number")]
    pub people: f64,
    /// Agents.
    #[serde(serialize_with = "crate::js::number")]
    pub agents: f64,
}

/// Who did the work.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct InsightActors {
    /// People.
    pub people: Vec<InsightContributor>,
    /// Agents.
    pub agents: Vec<InsightContributor>,
    /// Share of recorded events: people vs agents.
    pub share: ActorShare,
    /// Agent failures.
    pub failures: Vec<AgentFailureRow>,
}

/// The report's range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InsightRange {
    /// Days.
    pub days: i64,
    /// Start.
    pub from: IsoDate,
    /// End.
    pub to: IsoDate,
}

/// The report's scope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightScope {
    /// Project filter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Id>,
}

/// `GET /insights`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InsightsReport {
    /// When it was computed.
    pub generated_at: IsoDate,
    /// Range.
    pub range: InsightRange,
    /// Scope.
    pub scope: InsightScope,
    /// Stale threshold, days.
    pub stale_days: i64,
    /// Signals.
    pub signals: Vec<InsightSignal>,
    /// Bottlenecks.
    pub bottlenecks: Vec<InsightBottleneck>,
    /// Flow.
    pub flow: InsightFlow,
    /// Actors.
    pub actors: InsightActors,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_metadata() {
        assert_eq!(INSIGHT_SIGNAL_IDS.len(), 4);
        assert_eq!(InsightSignalId::CiFailing.meta().unit, "pull request");
        assert_eq!(InsightSignalId::StaleIssues.as_str(), "stale_issues");
    }
}
