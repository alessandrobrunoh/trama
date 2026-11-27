//! Points suggested from similar finished tasks (`server/src/threads/estimate-suggestion.ts`).

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use trama_contracts::settings::EstimateScale;
use trama_contracts::threads::{EstimateBasis, EstimateSuggestion};

/// Fewest similar finished tasks a suggestion is based on.
pub const SUGGESTION_MIN_BASIS: usize = 2;
/// Most similar finished tasks kept as the basis.
pub const SUGGESTION_BASIS_MAX: usize = 5;

/// The values each workspace estimate scale offers, as the app shows them
/// (`src/app/core/estimates.ts`). `none` offers nothing: estimates are turned off.
#[must_use]
pub fn estimate_scale_values(scale: EstimateScale) -> Vec<f64> {
    let values: &[f64] = match scale {
        EstimateScale::None => &[],
        EstimateScale::Linear => &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0],
        EstimateScale::Fibonacci => &[0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0],
        EstimateScale::Exponential => &[1.0, 2.0, 4.0, 8.0, 16.0, 32.0],
        EstimateScale::Tshirt => &[1.0, 2.0, 3.0, 5.0, 8.0],
    };
    values.to_vec()
}

/// What the target task is compared on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimilarityTarget {
    /// Title.
    pub title: String,
    /// Project.
    pub project_id: Option<String>,
    /// Label ids.
    pub labels: Vec<String>,
}

/// A finished task that has an estimate.
#[derive(Clone, Debug, PartialEq)]
pub struct FinishedTask {
    /// Task id.
    pub id: String,
    /// Task key.
    pub key: String,
    /// What it is compared on.
    pub target: SimilarityTarget,
    /// Its estimate.
    pub estimate: f64,
    /// Minutes tracked on it, when any.
    pub tracked_minutes: Option<i64>,
    /// Used to break ties: the most recently finished task wins.
    pub completed_at: Option<DateTime<Utc>>,
}

/// A finished task with its similarity to the target.
#[derive(Clone, Debug, PartialEq)]
pub struct ScoredTask {
    /// The task.
    pub task: FinishedTask,
    /// How much it resembles the target; `0` means nothing in common.
    pub score: u64,
}

const PROJECT_WEIGHT: u64 = 10_000;
const LABEL_WEIGHT: u64 = 100;
const LABELS_COUNTED_MAX: usize = 50;
const WORDS_COUNTED_MAX: usize = 99;

static WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]{3,}").unwrap_or_else(|e| unreachable!("{e}")));

/// Lowercased words of three or more letters (or digits) of a title.
#[must_use]
pub fn title_words(title: &str) -> HashSet<String> {
    WORDS.find_iter(&title.to_lowercase()).map(|word| word.as_str().to_owned()).collect()
}

/// How much a finished task resembles the target: the same project first, then shared labels,
/// then the words their titles share. `0` means nothing in common.
#[must_use]
pub fn similarity(target: &SimilarityTarget, other: &SimilarityTarget) -> u64 {
    let same_project = target.project_id.is_some() && target.project_id == other.project_id;
    let labels: HashSet<&String> = target.labels.iter().collect();
    let shared_labels = other.labels.iter().filter(|label| labels.contains(label)).count();
    let words = title_words(&target.title);
    let shared_words = title_words(&other.title).iter().filter(|w| words.contains(*w)).count();
    (if same_project { PROJECT_WEIGHT } else { 0 })
        + shared_labels.min(LABELS_COUNTED_MAX) as u64 * LABEL_WEIGHT
        + shared_words.min(WORDS_COUNTED_MAX) as u64
}

/// The finished tasks that resemble the target, best first (ties: finished most recently).
#[must_use]
pub fn rank_similar(
    target: &SimilarityTarget,
    candidates: &[FinishedTask],
    limit: usize,
) -> Vec<ScoredTask> {
    let mut scored: Vec<ScoredTask> = candidates
        .iter()
        .map(|task| ScoredTask { task: task.clone(), score: similarity(target, &task.target) })
        .filter(|scored| scored.score > 0)
        .collect();
    let finished =
        |scored: &ScoredTask| scored.task.completed_at.map_or(0, |d| d.timestamp_millis());
    scored.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| finished(b).cmp(&finished(a)))
            .then_with(|| a.task.key.cmp(&b.task.key))
    });
    scored.truncate(limit);
    scored
}

/// Middle value; the mean of the two middle values for an even count.
#[must_use]
pub fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 { sorted[mid] } else { f64::midpoint(sorted[mid - 1], sorted[mid]) }
}

/// The scale value nearest to `value`. Halfway between two values, the larger one.
#[must_use]
pub fn snap_to_scale(value: f64, scale: &[f64]) -> Option<f64> {
    let mut best: Option<f64> = None;
    for &candidate in scale {
        let closer = match best {
            None => true,
            Some(current) => {
                let (a, b) = ((candidate - value).abs(), (current - value).abs());
                match a.total_cmp(&b) {
                    std::cmp::Ordering::Less => true,
                    std::cmp::Ordering::Equal => candidate > current,
                    std::cmp::Ordering::Greater => false,
                }
            }
        };
        if closer {
            best = Some(candidate);
        }
    }
    best
}

/// A number as JavaScript prints it in a template string: whole numbers without a fraction.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// The suggestion for `target`, from the finished tasks that have an estimate.
#[must_use]
pub fn build_estimate_suggestion(
    issue_id: &str,
    target: &SimilarityTarget,
    candidates: &[FinishedTask],
    scale_name: EstimateScale,
) -> EstimateSuggestion {
    let scale = estimate_scale_values(scale_name);
    let ranked = rank_similar(target, candidates, SUGGESTION_BASIS_MAX);
    let basis: Vec<EstimateBasis> = ranked
        .iter()
        .map(|scored| EstimateBasis {
            id: scored.task.id.clone(),
            key: scored.task.key.clone(),
            title: scored.task.target.title.clone(),
            estimate: scored.task.estimate,
            tracked_minutes: scored.task.tracked_minutes,
        })
        .collect();
    let issue_id = issue_id.to_owned();
    if scale.is_empty() {
        return EstimateSuggestion {
            issue_id,
            suggestion: None,
            scale,
            basis,
            reason: "Estimates are turned off in this workspace.".to_owned(),
        };
    }
    if ranked.len() < SUGGESTION_MIN_BASIS {
        let plural = if ranked.len() == 1 { "" } else { "s" };
        return EstimateSuggestion {
            issue_id,
            suggestion: None,
            scale,
            basis,
            reason: format!(
                "Not enough history: {} similar finished task{plural} with an estimate, at least {SUGGESTION_MIN_BASIS} are needed.",
                ranked.len()
            ),
        };
    }
    let estimates: Vec<f64> = ranked.iter().map(|scored| scored.task.estimate).collect();
    let mid = median(&estimates);
    let suggestion = snap_to_scale(mid, &scale);
    let listed = estimates.iter().map(|e| js_number(*e)).collect::<Vec<_>>().join(", ");
    let snapped = suggestion.map_or_else(|| "null".to_owned(), js_number);
    let reason = format!(
        "Median estimate of the {} most similar finished tasks ({listed}) is {}, snapped to {snapped} on the {scale_name} scale. Similar means the same project, shared labels and shared title words.",
        ranked.len(),
        js_number(mid),
    );
    EstimateSuggestion { issue_id, suggestion, scale, basis, reason }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn target() -> SimilarityTarget {
        SimilarityTarget {
            title: "Alerting when token refresh fails".into(),
            project_id: Some("pj_auth".into()),
            labels: vec!["lb_backend".into()],
        }
    }

    fn other(title: &str, project: Option<&str>, labels: &[&str]) -> SimilarityTarget {
        SimilarityTarget {
            title: title.into(),
            project_id: project.map(Into::into),
            labels: labels.iter().map(|l| (*l).to_owned()).collect(),
        }
    }

    /// A finished task numbered `n` (finished on day `n`), unrelated unless the caller says so.
    fn done(n: u32, estimate: f64, similar: SimilarityTarget) -> FinishedTask {
        FinishedTask {
            id: format!("in_{n}"),
            key: format!("TRM-{n}"),
            target: similar,
            estimate,
            tracked_minutes: None,
            completed_at: Utc.with_ymd_and_hms(2026, 1, n, 0, 0, 0).single(),
        }
    }

    fn unrelated() -> SimilarityTarget {
        other("Unrelated chore", None, &[])
    }

    fn in_auth() -> SimilarityTarget {
        other("Unrelated chore", Some("pj_auth"), &[])
    }

    #[test]
    fn title_words_keep_lowercased_words_of_three_or_more_letters() {
        let mut words: Vec<String> =
            title_words("Fix the OAuth refresh-token bug in UI").into_iter().collect();
        words.sort();
        assert_eq!(words, ["bug", "fix", "oauth", "refresh", "the", "token"]);
    }

    #[test]
    fn similarity_ranks_the_same_project_over_labels_and_labels_over_title_words() {
        let t = target();
        let same_project = similarity(&t, &other("x", Some("pj_auth"), &[]));
        let labelled = similarity(&t, &other("x", None, &["lb_backend"]));
        let worded = similarity(&t, &other("token refresh alerting", None, &[]));
        assert!(same_project > labelled);
        assert!(labelled > worded);
        assert!(worded > 0);
    }

    #[test]
    fn similarity_is_zero_for_tasks_with_nothing_in_common() {
        let t = target();
        assert_eq!(similarity(&t, &other("Unrelated chore", Some("pj_other"), &[])), 0);
        let no_project = SimilarityTarget { project_id: None, ..target() };
        assert_eq!(similarity(&no_project, &other("x", None, &[])), 0);
    }

    #[test]
    fn rank_similar_drops_unrelated_orders_by_score_then_latest_finish_and_keeps_five() {
        let mut late = done(4, 8.0, in_auth());
        late.completed_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).single();
        let mut tasks = vec![
            done(1, 1.0, unrelated()),
            done(2, 3.0, other("token refresh", None, &[])),
            done(3, 5.0, in_auth()),
            late,
        ];
        for n in 5..9 {
            tasks.push(done(n, 2.0, other("Unrelated chore", None, &["lb_backend"])));
        }
        let ranked = rank_similar(&target(), &tasks, SUGGESTION_BASIS_MAX);
        assert_eq!(ranked.len(), 5);
        let estimates: Vec<f64> = ranked.iter().map(|s| s.task.estimate).collect();
        assert_eq!(estimates[..2], [8.0, 5.0]);
        assert!(!ranked.iter().any(|s| s.task.estimate.total_cmp(&1.0).is_eq()));
    }

    #[test]
    fn median_takes_the_middle_value_or_the_mean_of_the_two_in_the_middle() {
        assert!(median(&[5.0, 1.0, 3.0]).total_cmp(&3.0).is_eq());
        assert!(median(&[3.0, 5.0]).total_cmp(&4.0).is_eq());
        assert!(median(&[1.0, 2.0, 8.0, 13.0]).total_cmp(&5.0).is_eq());
    }

    #[test]
    fn snap_to_scale_takes_the_nearest_value_upward_when_halfway() {
        let fib = estimate_scale_values(EstimateScale::Fibonacci);
        assert_eq!(snap_to_scale(4.0, &fib), Some(5.0));
        assert_eq!(snap_to_scale(6.0, &fib), Some(5.0));
        assert_eq!(snap_to_scale(6.5, &fib), Some(8.0));
        assert_eq!(snap_to_scale(100.0, &fib), Some(21.0));
        assert_eq!(snap_to_scale(2.4, &[1.0, 2.0, 4.0, 8.0]), Some(2.0));
        assert_eq!(snap_to_scale(3.0, &[1.0, 2.0, 4.0, 8.0]), Some(4.0));
        assert_eq!(snap_to_scale(3.0, &[]), None);
    }

    #[test]
    fn a_suggestion_is_the_median_of_the_basis_snapped_to_the_workspace_scale() {
        let mut first = done(1, 3.0, in_auth());
        first.tracked_minutes = Some(90);
        let tasks =
            vec![first, done(2, 5.0, in_auth()), done(3, 5.0, in_auth()), done(4, 13.0, in_auth())];
        let result =
            build_estimate_suggestion("in_target", &target(), &tasks, EstimateScale::Fibonacci);
        assert_eq!(result.issue_id, "in_target");
        assert_eq!(result.suggestion, Some(5.0));
        assert_eq!(result.scale, [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0]);
        assert_eq!(result.basis.len(), 4);
        let three = result.basis.iter().find(|b| b.estimate.total_cmp(&3.0).is_eq()).unwrap();
        assert_eq!(three.tracked_minutes, Some(90));
        assert!(result.reason.contains("fibonacci"), "{}", result.reason);
        assert_eq!(
            result.reason,
            "Median estimate of the 4 most similar finished tasks (13, 5, 5, 3) is 5, snapped to 5 on the fibonacci scale. Similar means the same project, shared labels and shared title words."
        );
    }

    #[test]
    fn an_in_between_median_snaps_to_the_scale_of_the_workspace() {
        let tasks = vec![done(1, 3.0, in_auth()), done(2, 5.0, in_auth())];
        let on = |scale| build_estimate_suggestion("in_t", &target(), &tasks, scale).suggestion;
        assert_eq!(on(EstimateScale::Fibonacci), Some(5.0));
        assert_eq!(on(EstimateScale::Linear), Some(4.0));
    }

    #[test]
    fn with_fewer_than_two_matches_there_is_no_suggestion_and_it_says_why() {
        let none = build_estimate_suggestion(
            "in_t",
            &target(),
            &[done(1, 3.0, unrelated())],
            EstimateScale::Fibonacci,
        );
        assert_eq!(none.suggestion, None);
        assert!(none.basis.is_empty());
        assert!(none.reason.contains("0 similar"), "{}", none.reason);
        let one = build_estimate_suggestion(
            "in_t",
            &target(),
            &[done(1, 3.0, in_auth())],
            EstimateScale::Fibonacci,
        );
        assert_eq!(one.suggestion, None);
        assert_eq!(one.basis.len(), 1);
        assert!(one.reason.contains("1 similar finished task "), "{}", one.reason);
    }

    #[test]
    fn nothing_is_suggested_when_estimates_are_turned_off() {
        let tasks = vec![done(1, 3.0, in_auth()), done(2, 5.0, in_auth())];
        let result = build_estimate_suggestion("in_t", &target(), &tasks, EstimateScale::None);
        assert_eq!(result.suggestion, None);
        assert!(result.scale.is_empty());
        assert_eq!(result.reason, "Estimates are turned off in this workspace.");
    }

    #[test]
    fn fractional_estimates_are_printed_like_javascript() {
        assert_eq!(js_number(4.0), "4");
        assert_eq!(js_number(4.5), "4.5");
        assert_eq!(js_number(0.0), "0");
    }
}
