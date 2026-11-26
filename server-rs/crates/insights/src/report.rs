//! The report itself: signals, flow metrics, bottlenecks and contributors computed from the rows
//! the service loaded (the second half of `InsightsService.load`). Pure, so it is tested without
//! a database.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use trama_contracts::insights::{
    ActorShare, InsightActor, InsightActorType, InsightActors, InsightAging, InsightBottleneck,
    InsightContributor, InsightFlow, InsightItem, InsightItemType, InsightRange, InsightScope,
    InsightSeverity, InsightSignal, InsightSignalId, InsightWip, InsightWipRow, InsightsReport,
    PreviousThroughput, ThroughputBucket, WipLimits,
};
use trama_contracts::insights::{DurationStats, FlowDuration};
use trama_core::time::to_iso;

const DAY_MS: f64 = 86_400_000.0;
const ACTIVE: [&str; 2] = ["in_progress", "in_review"];
/// More issues than this in flight makes a person `overloaded`.
const WIP_LIMIT: usize = 5;
/// A pull request without an update for this many days is stuck in review.
const STUCK_REVIEW_DAYS: f64 = 3.0;

/// An issue the report may use (already limited to the caller's projects).
#[derive(Clone, Debug)]
pub struct IssueRow {
    /// Id.
    pub id: String,
    /// Key, e.g. `BUG-1`.
    pub key: String,
    /// Title.
    pub title: String,
    /// Status id.
    pub status: String,
    /// Project.
    pub project_id: Option<String>,
    /// Assignee.
    pub assignee_id: Option<String>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last update.
    pub updated_at: DateTime<Utc>,
    /// When work started.
    pub started_at: Option<DateTime<Utc>>,
    /// When it was completed.
    pub completed_at: Option<DateTime<Utc>>,
}

/// An open pull request or merge request of a visible issue.
#[derive(Clone, Debug)]
pub struct ArtifactRow {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// CI result.
    pub ci: Option<String>,
    /// Review state.
    pub review: Option<String>,
    /// Last update.
    pub updated_at: DateTime<Utc>,
}

/// A milestone past its target date with the number of its open issues.
#[derive(Clone, Debug)]
pub struct MilestoneRow {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Project.
    pub project_id: String,
    /// The target date, which has passed.
    pub target_date: DateTime<Utc>,
    /// Status id of the project.
    pub project_status: String,
    /// Open issues that belong to the milestone.
    pub open_issues: i64,
}

/// What one actor recorded for one event type in the range.
#[derive(Clone, Debug)]
pub struct EventRow {
    /// Actor id.
    pub actor_id: Option<String>,
    /// `user` or `agent`.
    pub actor_type: String,
    /// Event type.
    pub kind: String,
    /// Latest event of the group.
    pub last_at: DateTime<Utc>,
    /// Events in the group.
    pub events: i64,
}

/// Everything [`build`] needs.
#[derive(Clone, Debug)]
pub struct Inputs {
    /// The time the report is computed at.
    pub now: DateTime<Utc>,
    /// Range length.
    pub days: i64,
    /// Stale threshold.
    pub stale_days: i64,
    /// Items per signal.
    pub limit: usize,
    /// Project filter.
    pub project_id: Option<String>,
    /// Issues visible to the caller.
    pub issues: Vec<IssueRow>,
    /// Open pull requests of those issues.
    pub artifacts: Vec<ArtifactRow>,
    /// Overdue milestones (all of the workspace or project, not yet limited to visible ones).
    pub milestones: Vec<MilestoneRow>,
    /// Events of those issues in the range.
    pub events: Vec<EventRow>,
    /// Names of the event actors, by id.
    pub actor_names: HashMap<String, String>,
    /// Names of the assignees, by id.
    pub user_names: HashMap<String, String>,
}

/// `Math.round(x * 10) / 10`.
fn tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn days_between(from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let ms = (to - from).num_milliseconds() as f64;
    ms / DAY_MS
}

/// `age(date, now)`: whole days with one decimal, never negative.
#[must_use]
pub fn age(date: DateTime<Utc>, now: DateTime<Utc>) -> f64 {
    tenth(days_between(date, now)).max(0.0)
}

/// `duration(from, to)`.
fn duration(from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    tenth(days_between(from, to)).max(0.0)
}

/// `stats(values)`: count and percentiles of a list of durations.
#[must_use]
pub fn stats(values: &[f64]) -> DurationStats {
    if values.is_empty() {
        return DurationStats { count: 0, p50: None, p85: None, p95: None, mean: None, max: None };
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let len = sorted.len();
    let percentile = |p: f64| {
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss
        )]
        let rank = ((len as f64) * p).ceil() as usize;
        sorted[rank.saturating_sub(1).min(len - 1)]
    };
    #[allow(clippy::cast_precision_loss)]
    let mean = tenth(values.iter().sum::<f64>() / len as f64);
    DurationStats {
        count: i64::try_from(len).unwrap_or(i64::MAX),
        p50: Some(percentile(0.5)),
        p85: Some(percentile(0.85)),
        p95: Some(percentile(0.95)),
        mean: Some(mean),
        max: sorted.last().copied(),
    }
}

/// What an item says about the record it names.
struct Subject<'a> {
    kind: InsightItemType,
    id: &'a str,
    key: Option<&'a str>,
    title: &'a str,
    project_id: Option<&'a str>,
}

/// `item(...)` of the NestJS service: a row that explains a signal or fills a list.
fn item(
    subject: &Subject<'_>,
    since: DateTime<Utc>,
    now: DateTime<Utc>,
    detail: &str,
) -> InsightItem {
    InsightItem {
        kind: subject.kind,
        id: subject.id.to_owned(),
        key: subject.key.filter(|k| !k.is_empty()).map(ToOwned::to_owned),
        title: subject.title.to_owned(),
        project_id: subject.project_id.filter(|p| !p.is_empty()).map(ToOwned::to_owned),
        since: Some(to_iso(&since)),
        age_days: Some(age(since, now)),
        waiting_on: None,
        value: None,
        detail: detail.to_owned(),
    }
}

fn issue_item(issue: &IssueRow, now: DateTime<Utc>, detail: &str) -> InsightItem {
    item(
        &Subject {
            kind: InsightItemType::Issue,
            id: &issue.id,
            key: Some(&issue.key),
            title: &issue.title,
            project_id: issue.project_id.as_deref(),
        },
        issue.updated_at,
        now,
        detail,
    )
}

fn artifact_item(artifact: &ArtifactRow, now: DateTime<Utc>, detail: &str) -> InsightItem {
    item(
        &Subject {
            kind: InsightItemType::Artifact,
            id: &artifact.id,
            key: None,
            title: &artifact.title,
            project_id: None,
        },
        artifact.updated_at,
        now,
        detail,
    )
}

fn sort_oldest_first(items: &mut [InsightItem]) {
    items.sort_by(|a, b| b.age_days.unwrap_or(0.0).total_cmp(&a.age_days.unwrap_or(0.0)));
}

fn user_actor(id: &str, names: &HashMap<String, String>) -> InsightActor {
    InsightActor {
        kind: InsightActorType::User,
        id: Some(id.to_owned()),
        name: names.get(id).cloned().unwrap_or_else(|| "Unknown".to_owned()),
    }
}

/// The signal lists, in the order of `INSIGHT_SIGNAL_IDS`, each oldest first and not yet cut to
/// the limit.
fn signal_items(input: &Inputs) -> Vec<(InsightSignalId, Vec<InsightItem>)> {
    let now = input.now;
    #[allow(clippy::cast_precision_loss)]
    let stale_days = input.stale_days as f64;
    let stale = input
        .issues
        .iter()
        .filter(|i| ACTIVE.contains(&i.status.as_str()) && age(i.updated_at, now) >= stale_days)
        .map(|i| issue_item(i, now, "In-flight Issue has not been updated recently."))
        .collect();
    // only milestones of a project that has a visible issue in the report's window
    let overdue = input
        .milestones
        .iter()
        .filter(|m| input.issues.iter().any(|i| i.project_id.as_deref() == Some(&m.project_id)))
        .filter(|m| {
            m.open_issues > 0 && !["completed", "canceled"].contains(&m.project_status.as_str())
        })
        .map(|m| {
            item(
                &Subject {
                    kind: InsightItemType::Milestone,
                    id: &m.id,
                    key: None,
                    title: &m.name,
                    project_id: Some(&m.project_id),
                },
                m.target_date,
                now,
                &format!("{} open Issues remain.", m.open_issues),
            )
        })
        .collect();
    // `review` is a plain string column, so NestJS's `review?.approved !== true` and
    // `review?.state !== 'approved'` hold for every row: only the age decides.
    let stuck = input
        .artifacts
        .iter()
        .filter(|a| age(a.updated_at, now) >= STUCK_REVIEW_DAYS)
        .map(|a| {
            artifact_item(
                a,
                now,
                "Open pull request has no approval and has been inactive for at least 3 days.",
            )
        })
        .collect();
    let failing = input
        .artifacts
        .iter()
        .filter(|a| a.ci.as_deref() == Some("failing"))
        .map(|a| artifact_item(a, now, "Latest pull request CI result is failing."))
        .collect();
    vec![
        (InsightSignalId::StaleIssues, stale),
        (InsightSignalId::OverdueMilestones, overdue),
        (InsightSignalId::PrsStuckInReview, stuck),
        (InsightSignalId::CiFailing, failing),
    ]
}

fn signal(id: InsightSignalId, all: &[InsightItem], limit: usize) -> InsightSignal {
    let meta = id.meta();
    let severity = match (all.is_empty(), id) {
        (true, _) => InsightSeverity::Ok,
        (false, InsightSignalId::OverdueMilestones | InsightSignalId::StaleIssues) => {
            InsightSeverity::Warning
        }
        (false, _) => InsightSeverity::Info,
    };
    InsightSignal {
        id,
        label: meta.label.to_owned(),
        definition: meta.definition.to_owned(),
        unit: meta.unit.to_owned(),
        severity,
        count: i64::try_from(all.len()).unwrap_or(i64::MAX),
        oldest_days: all.first().and_then(|i| i.age_days),
        items: all.iter().take(limit).cloned().collect(),
        truncated: all.len() > limit,
    }
}

fn contributors(input: &Inputs) -> Vec<InsightContributor> {
    let mut rows: Vec<InsightContributor> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for event in &input.events {
        let key = format!("{}:{}", event.actor_type, event.actor_id.as_deref().unwrap_or("null"));
        let slot = *at.entry(key).or_insert_with(|| {
            let kind = if event.actor_type == "agent" {
                InsightActorType::Agent
            } else {
                InsightActorType::User
            };
            let name = event
                .actor_id
                .as_ref()
                .and_then(|id| input.actor_names.get(id))
                .cloned()
                .unwrap_or_else(|| "Unknown".to_owned());
            rows.push(InsightContributor {
                actor: InsightActor { kind, id: event.actor_id.clone(), name },
                events: 0,
                issues_done: 0,
                comments: 0,
                pull_requests: 0,
                last_active_at: Some(to_iso(&event.last_at)),
            });
            rows.len() - 1
        });
        let row = &mut rows[slot];
        row.events += event.events;
        if event.kind == "issue.status_changed" {
            row.issues_done += event.events;
        }
        let latest = row
            .last_active_at
            .as_deref()
            .and_then(|iso| DateTime::parse_from_rfc3339(iso).ok())
            .map_or(event.last_at, |t| t.to_utc().max(event.last_at));
        row.last_active_at = Some(to_iso(&latest));
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.events));
    rows
}

fn wip_rows(input: &Inputs) -> Vec<InsightWipRow> {
    let mut order: Vec<&str> = Vec::new();
    let mut by_assignee: HashMap<&str, Vec<&IssueRow>> = HashMap::new();
    for issue in &input.issues {
        let Some(assignee) = issue.assignee_id.as_deref().filter(|a| !a.is_empty()) else {
            continue;
        };
        if !ACTIVE.contains(&issue.status.as_str()) {
            continue;
        }
        by_assignee
            .entry(assignee)
            .or_insert_with(|| {
                order.push(assignee);
                Vec::new()
            })
            .push(issue);
    }
    let mut rows: Vec<InsightWipRow> = order
        .into_iter()
        .map(|id| {
            let assigned = &by_assignee[id];
            InsightWipRow {
                actor: user_actor(id, &input.user_names),
                issues: i64::try_from(assigned.len()).unwrap_or(i64::MAX),
                overloaded: assigned.len() > WIP_LIMIT,
                items: assigned
                    .iter()
                    .map(|issue| issue_item(issue, input.now, "Assigned in-flight Issue."))
                    .collect(),
            }
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.issues));
    rows
}

/// Reviews waiting on someone. NestJS never knows who a review waits on, so every stuck pull
/// request is waiting on `unassigned`.
fn bottlenecks(stuck: &[InsightItem]) -> Vec<InsightBottleneck> {
    let mut rows: Vec<InsightBottleneck> = Vec::new();
    for waiting in stuck {
        let age = waiting.age_days.unwrap_or(0.0);
        let actor = waiting.waiting_on.clone().unwrap_or(InsightActor {
            kind: InsightActorType::Unassigned,
            id: None,
            name: "Unassigned".to_owned(),
        });
        let key = actor.id.clone().unwrap_or_else(|| "unassigned".to_owned());
        let slot = rows
            .iter()
            .position(|row| row.actor.id.clone().unwrap_or_else(|| "unassigned".to_owned()) == key);
        let row = if let Some(slot) = slot {
            &mut rows[slot]
        } else {
            rows.push(InsightBottleneck {
                actor,
                reviews: 0,
                oldest_days: 0.0,
                total_wait_days: 0.0,
            });
            let last = rows.len() - 1;
            &mut rows[last]
        };
        row.reviews += 1;
        row.oldest_days = row.oldest_days.max(age);
        row.total_wait_days += age;
    }
    rows.sort_by(|a, b| b.total_wait_days.total_cmp(&a.total_wait_days));
    rows
}

fn throughput(input: &Inputs, from: DateTime<Utc>, done: &[&IssueRow]) -> Vec<ThroughputBucket> {
    let buckets = (input.days + 6) / 7;
    (0..buckets)
        .map(|n| {
            let start = from + Duration::days(7 * n);
            let end = (start + Duration::days(7)).min(input.now);
            let issues_done = done
                .iter()
                .filter(|i| i.completed_at.is_some_and(|at| at >= start && at < end))
                .count();
            ThroughputBucket {
                start: to_iso(&start),
                end: to_iso(&end),
                issues_done: i64::try_from(issues_done).unwrap_or(i64::MAX),
            }
        })
        .collect()
}

/// Computes the report.
#[must_use]
pub fn build(input: &Inputs) -> InsightsReport {
    let now = input.now;
    let from = now - Duration::days(input.days);

    let mut lists = signal_items(input);
    for (_, items) in &mut lists {
        sort_oldest_first(items);
    }
    let signals: Vec<InsightSignal> =
        lists.iter().map(|(id, all)| signal(*id, all, input.limit)).collect();
    let stuck: Vec<InsightItem> = lists
        .iter()
        .find(|(id, _)| *id == InsightSignalId::PrsStuckInReview)
        .map(|(_, items)| items.clone())
        .unwrap_or_default();

    let done: Vec<&IssueRow> = input
        .issues
        .iter()
        .filter(|i| i.status == "done" && i.completed_at.is_some_and(|at| at >= from))
        .collect();
    let cycle: Vec<f64> =
        done.iter().filter_map(|i| Some(duration(i.started_at?, i.completed_at?))).collect();
    let lead: Vec<f64> =
        done.iter().filter_map(|i| Some(duration(i.created_at, i.completed_at?))).collect();

    let contributor_rows = contributors(input);
    let event_total: i64 = contributor_rows.iter().map(|row| row.events).sum();
    let people_events: i64 = contributor_rows
        .iter()
        .filter(|row| row.actor.kind == InsightActorType::User)
        .map(|row| row.events)
        .sum();
    #[allow(clippy::cast_precision_loss)]
    let share = if event_total == 0 {
        ActorShare { people: 0.0, agents: 0.0 }
    } else {
        ActorShare {
            people: people_events as f64 / event_total as f64,
            agents: (event_total - people_events) as f64 / event_total as f64,
        }
    };

    InsightsReport {
        generated_at: to_iso(&now),
        range: InsightRange { days: input.days, from: to_iso(&from), to: to_iso(&now) },
        scope: InsightScope { project_id: input.project_id.clone() },
        stale_days: input.stale_days,
        signals,
        bottlenecks: bottlenecks(&stuck),
        flow: InsightFlow {
            issue_cycle: FlowDuration {
                stats: stats(&cycle),
                previous: None,
                histogram: Vec::new(),
                slowest: Vec::new(),
            },
            issue_lead: FlowDuration {
                stats: stats(&lead),
                previous: None,
                histogram: Vec::new(),
                slowest: Vec::new(),
            },
            throughput: throughput(input, from, &done),
            previous_throughput: PreviousThroughput { issues_done: 0 },
            wip: InsightWip {
                people: wip_rows(input),
                agents: Vec::new(),
                limits: WipLimits { issues: i64::try_from(WIP_LIMIT).unwrap_or(5) },
            },
            aging: InsightAging { baseline_days: None, baseline_samples: 0, items: Vec::new() },
            cumulative_flow: None,
        },
        actors: InsightActors {
            people: contributor_rows
                .iter()
                .filter(|row| row.actor.kind == InsightActorType::User)
                .cloned()
                .collect(),
            agents: contributor_rows
                .iter()
                .filter(|row| row.actor.kind == InsightActorType::Agent)
                .cloned()
                .collect(),
            share,
            failures: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, day, 12, 0, 0).unwrap()
    }

    fn inputs() -> Inputs {
        Inputs {
            now: at(20),
            days: 30,
            stale_days: 7,
            limit: 25,
            project_id: None,
            issues: Vec::new(),
            artifacts: Vec::new(),
            milestones: Vec::new(),
            events: Vec::new(),
            actor_names: HashMap::new(),
            user_names: HashMap::new(),
        }
    }

    fn issue(id: &str, status: &str, updated: DateTime<Utc>) -> IssueRow {
        IssueRow {
            id: id.into(),
            key: format!("K-{id}"),
            title: format!("Issue {id}"),
            status: status.into(),
            project_id: Some("pr_1".into()),
            assignee_id: None,
            created_at: at(1),
            updated_at: updated,
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn rounds_ages_to_a_tenth_and_never_below_zero() {
        assert!((age(at(10), at(20)) - 10.0).abs() < f64::EPSILON);
        assert!((age(at(20), at(10))).abs() < f64::EPSILON);
        let part = at(10) + Duration::hours(7);
        assert!((age(at(10), part) - 0.3).abs() < f64::EPSILON);
    }

    #[test]
    fn stats_use_nearest_rank_percentiles() {
        assert_eq!(stats(&[]).count, 0);
        assert_eq!(stats(&[]).p50, None);
        let s = stats(&[4.0, 1.0, 2.0, 3.0]);
        assert_eq!(
            (s.count, s.p50, s.p85, s.p95, s.max),
            (4, Some(2.0), Some(4.0), Some(4.0), Some(4.0))
        );
        assert_eq!(s.mean, Some(2.5));
        let one = stats(&[7.0]);
        assert_eq!((one.p50, one.p95, one.mean), (Some(7.0), Some(7.0), Some(7.0)));
    }

    #[test]
    fn an_empty_scope_has_every_signal_at_zero() {
        let report = build(&inputs());
        let ids: Vec<_> = report.signals.iter().map(|s| s.id).collect();
        assert_eq!(ids, InsightSignalId::ALL);
        assert!(report.signals.iter().all(|s| s.count == 0
            && s.items.is_empty()
            && s.severity == InsightSeverity::Ok
            && s.oldest_days.is_none()
            && !s.truncated));
        assert_eq!(report.flow.throughput.len(), 5);
        assert!(report.actors.people.is_empty() && report.actors.agents.is_empty());
        assert!((report.actors.share.people).abs() < f64::EPSILON);
    }

    #[test]
    fn finds_stale_in_flight_issues_oldest_first() {
        let mut input = inputs();
        input.issues = vec![
            issue("a", "in_progress", at(10)),
            issue("b", "in_review", at(5)),
            issue("c", "todo", at(1)),
            issue("d", "in_progress", at(19)),
        ];
        let report = build(&input);
        let stale = &report.signals[0];
        assert_eq!(stale.count, 2);
        assert_eq!(stale.severity, InsightSeverity::Warning);
        assert_eq!(stale.oldest_days, Some(15.0));
        let ids: Vec<_> = stale.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(stale.items[0].key.as_deref(), Some("K-b"));
        assert_eq!(stale.items[0].project_id.as_deref(), Some("pr_1"));
    }

    #[test]
    fn cuts_signal_items_to_the_limit() {
        let mut input = inputs();
        input.limit = 1;
        input.issues = vec![issue("a", "in_progress", at(1)), issue("b", "in_progress", at(2))];
        let stale = &build(&input).signals[0];
        assert_eq!((stale.count, stale.items.len(), stale.truncated), (2, 1, true));
    }

    #[test]
    fn milestones_need_open_issues_a_live_project_and_a_visible_issue_in_it() {
        let milestone = |id: &str, project: &str, status: &str, open: i64| MilestoneRow {
            id: id.into(),
            name: format!("M {id}"),
            project_id: project.into(),
            target_date: at(1),
            project_status: status.into(),
            open_issues: open,
        };
        let mut input = inputs();
        input.issues = vec![issue("a", "todo", at(19))];
        input.milestones = vec![
            milestone("m1", "pr_1", "started", 2),
            milestone("m2", "pr_1", "started", 0),
            milestone("m3", "pr_1", "completed", 2),
            milestone("m4", "pr_1", "canceled", 2),
            milestone("m5", "pr_other", "started", 2),
        ];
        let overdue = &build(&input).signals[1];
        assert_eq!(overdue.count, 1);
        let m = &overdue.items[0];
        assert_eq!(
            (m.id.as_str(), m.kind, m.project_id.as_deref()),
            ("m1", InsightItemType::Milestone, Some("pr_1"))
        );
        assert_eq!(m.detail, "2 open Issues remain.");
        assert_eq!(m.key, None);
        assert_eq!(m.age_days, Some(19.0));
    }

    #[test]
    fn pull_request_signals_and_bottlenecks() {
        let pr = |id: &str, ci: Option<&str>, updated| ArtifactRow {
            id: id.into(),
            title: format!("PR {id}"),
            ci: ci.map(Into::into),
            review: Some("requested".into()),
            updated_at: updated,
        };
        let mut input = inputs();
        input.artifacts = vec![
            pr("a", Some("failing"), at(10)),
            pr("b", Some("passing"), at(18)),
            pr("c", None, at(15)),
        ];
        let report = build(&input);
        let ci = &report.signals[3];
        assert_eq!((ci.count, ci.severity), (1, InsightSeverity::Info));
        assert_eq!(ci.items[0].id, "a");
        let stuck = &report.signals[2];
        let ids: Vec<_> = stuck.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(report.bottlenecks.len(), 1);
        let row = &report.bottlenecks[0];
        assert_eq!((row.reviews, row.oldest_days, row.total_wait_days), (2, 10.0, 15.0));
        assert_eq!(
            (row.actor.kind, row.actor.id.clone(), row.actor.name.as_str()),
            (InsightActorType::Unassigned, None, "Unassigned")
        );
    }

    #[test]
    fn flow_metrics_cover_the_range() {
        let mut input = inputs();
        let finished = |id: &str, started: Option<u32>, done: u32| IssueRow {
            started_at: started.map(at),
            completed_at: Some(at(done)),
            ..issue(id, "done", at(done))
        };
        input.issues = vec![finished("a", Some(2), 4), finished("b", None, 18), {
            // completed before the range
            IssueRow {
                completed_at: Some(at(20) - Duration::days(40)),
                ..issue("c", "done", at(1))
            }
        }];
        let flow = build(&input).flow;
        assert_eq!(flow.issue_cycle.stats.count, 1);
        assert_eq!(flow.issue_cycle.stats.p50, Some(2.0));
        assert_eq!(flow.issue_lead.stats.count, 2);
        assert_eq!(flow.issue_lead.stats.max, Some(17.0));
        let counts: Vec<_> = flow.throughput.iter().map(|b| b.issues_done).collect();
        assert_eq!(counts, [0, 0, 1, 0, 1]);
        assert_eq!(flow.throughput[4].end, to_iso(&at(20)));
        assert_eq!(flow.previous_throughput.issues_done, 0);
        assert_eq!(flow.wip.limits.issues, 5);
        assert!(flow.cumulative_flow.is_none() && flow.issue_cycle.previous.is_none());
    }

    #[test]
    fn work_in_progress_flags_overloaded_people() {
        let mut input = inputs();
        for n in 0..6 {
            input.issues.push(IssueRow {
                assignee_id: Some("u1".into()),
                ..issue(&format!("a{n}"), "in_progress", at(19))
            });
        }
        input
            .issues
            .push(IssueRow { assignee_id: Some("u2".into()), ..issue("b", "in_review", at(19)) });
        input
            .issues
            .push(IssueRow { assignee_id: Some("u2".into()), ..issue("c", "todo", at(19)) });
        input.user_names.insert("u1".into(), "Ada".into());
        let wip = build(&input).flow.wip;
        assert_eq!(wip.people.len(), 2);
        assert_eq!(
            (wip.people[0].actor.name.as_str(), wip.people[0].issues, wip.people[0].overloaded),
            ("Ada", 6, true)
        );
        assert_eq!(
            (wip.people[1].actor.name.as_str(), wip.people[1].issues, wip.people[1].overloaded),
            ("Unknown", 1, false)
        );
        assert_eq!(wip.people[1].items[0].detail, "Assigned in-flight Issue.");
    }

    #[test]
    fn contributors_are_grouped_per_actor_and_split_people_from_agents() {
        let event = |actor: &str, kind: &str, event_type: &str, n: i64, day: u32| EventRow {
            actor_id: Some(actor.into()),
            actor_type: kind.into(),
            kind: event_type.into(),
            last_at: at(day),
            events: n,
        };
        let mut input = inputs();
        input.events = vec![
            event("u1", "user", "issue.updated", 2, 5),
            event("u1", "user", "issue.status_changed", 3, 9),
            event("u1", "user", "issue.created", 1, 7),
            event("ag1", "agent", "issue.updated", 4, 8),
        ];
        input.actor_names.insert("u1".into(), "Ada".into());
        let actors = build(&input).actors;
        assert_eq!(actors.people.len(), 1);
        let ada = &actors.people[0];
        assert_eq!((ada.actor.name.as_str(), ada.events, ada.issues_done), ("Ada", 6, 3));
        assert_eq!(ada.last_active_at.as_deref(), Some(to_iso(&at(9)).as_str()));
        assert_eq!((actors.agents[0].actor.name.as_str(), actors.agents[0].events), ("Unknown", 4));
        assert!((actors.share.people - 0.6).abs() < f64::EPSILON);
        assert!((actors.share.agents - 0.4).abs() < f64::EPSILON);
    }
}
