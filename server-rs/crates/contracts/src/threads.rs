//! Thread records of the `/trama` skill: what the agent working in a task's thread keeps in Trama
//! (`Thread records` of `contracts/domain.ts`).
//!
//! One task links at most one Delta thread (`Issue.threadUrl`). The agent working in that thread
//! keeps a read-only record of it with `trama sync`: a summary, the files it touched, the
//! decisions it made and, optionally, the PR it opened and the active time it suggests.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{ActorRef, Id, IsoDate};
use crate::issues::Artifact;

/// Error code of the 409 returned when a task already links a different thread.
pub const THREAD_ALREADY_LINKED: &str = "thread_already_linked";
/// Longest [`ThreadRecord::summary`], in characters.
pub const THREAD_SUMMARY_MAX: usize = 4000;
/// Most files one record keeps (the newest sync wins).
pub const THREAD_FILES_MAX: usize = 500;
/// Longest file path, in characters.
pub const THREAD_PATH_MAX: usize = 512;
/// Longest [`ThreadDecision::text`], in characters.
pub const DECISION_TEXT_MAX: usize = 1000;
/// Most decisions one sync may add.
pub const DECISIONS_PER_SYNC_MAX: usize = 20;
/// Most paths one decision may name.
pub const DECISION_PATHS_MAX: usize = 50;
/// Most active minutes one sync may suggest (a working day).
pub const THREAD_SUGGESTED_MINUTES_MAX: i64 = 720;

string_enum! {
    /// Where a time entry came from. `suggested` entries come from `trama sync` and do not count
    /// until a person accepts them.
    pub enum TimeEntrySource {
        Timer = "timer",
        Manual = "manual",
        Suggested = "suggested",
    }
}

/// A decision an agent recorded while working on a task, scoped to the files (or path prefixes /
/// globs) it concerns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDecision {
    /// Decision id (`dc_…`).
    pub id: Id,
    /// The task.
    pub issue_id: Id,
    /// Task key (`TRM-128`), for display.
    pub issue_key: String,
    /// What was decided.
    pub text: String,
    /// Repository paths, path prefixes (`src/auth/`) or globs (`src/auth/*`). Empty: applies to
    /// the whole task.
    pub paths: Vec<String>,
    /// Thread the decision came from, when the task had one linked.
    pub thread_url: Option<String>,
    /// Who recorded it.
    pub created_by: ActorRef,
    /// When.
    pub created_at: IsoDate,
}

/// The read-only record of the thread linked to a task, as last synced by the agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    /// The task.
    pub issue_id: Id,
    /// The thread the task linked when the record was last synced.
    pub thread_url: Option<String>,
    /// Latest summary sent by `trama sync` (replaces the previous one).
    pub summary: Option<String>,
    /// Files touched in the thread, deduplicated, newest sync first.
    pub files: Vec<String>,
    /// Turns of the thread so far, when the agent reports it.
    pub turns: Option<i32>,
    /// Number of syncs received.
    pub sync_count: i32,
    /// When the last sync arrived.
    pub last_sync_at: IsoDate,
    /// Who sent it.
    pub last_sync_by: ActorRef,
    /// Decisions of this task, oldest first.
    pub decisions: Vec<ThreadDecision>,
}

/// One decision of a sync.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ThreadSyncDecision {
    /// What was decided (at most [`DECISION_TEXT_MAX`] characters).
    pub text: String,
    /// The files, directory prefixes or globs it concerns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

/// Body of `POST /w/:slug/tasks/:idOrKey/thread/sync`. Every field is optional; send what
/// changed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSyncInput {
    /// Links this thread when the task has none; 409 `thread_already_linked` when it links a
    /// different one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_url: Option<String>,
    /// What the thread did so far (replaces the previous summary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Decisions made since the last sync (appended, never replaced).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decisions: Option<Vec<ThreadSyncDecision>>,
    /// Files touched since the last sync (merged into the record).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    /// A PR / MR the thread opened: attached (or refreshed) as a `pull_request` artifact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_url: Option<String>,
    /// Active minutes in the thread since the last sync: stored as a suggested time entry a
    /// person accepts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_minutes: Option<i64>,
    /// Turns of the thread so far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<i64>,
}

/// The suggested time entry a sync created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimeSuggestion {
    /// The time entry.
    pub id: Id,
    /// Who it is for.
    pub user_id: Id,
    /// Its length.
    pub minutes: i64,
}

/// Answer of `POST /w/:slug/tasks/:idOrKey/thread/sync`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSyncResult {
    /// The record after the sync.
    pub record: ThreadRecord,
    /// How many decisions this sync added.
    pub decisions_added: usize,
    /// True when this sync linked `threadUrl` to the task.
    pub linked: bool,
    /// The artifact created or refreshed from `pullRequestUrl`.
    pub artifact: Option<Artifact>,
    /// The suggested time entry created from `activeMinutes`; null when none was sent or nobody
    /// can own it.
    pub time_suggestion: Option<TimeSuggestion>,
}

/// A finished task an estimate suggestion is based on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EstimateBasis {
    /// The task.
    pub id: Id,
    /// Its key.
    pub key: String,
    /// Its title.
    pub title: String,
    /// Its estimate.
    #[serde(serialize_with = "crate::js::number")]
    pub estimate: f64,
    /// Minutes tracked on it (finished entries that count), `null` when none.
    pub tracked_minutes: Option<i64>,
}

/// `GET /w/:slug/tasks/:idOrKey/estimate-suggestion`: points suggested from similar finished
/// tasks. People decide.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EstimateSuggestion {
    /// The task.
    pub issue_id: Id,
    /// A value of the workspace estimate scale, or `null` when there is too little history.
    #[serde(serialize_with = "crate::js::opt_number")]
    pub suggestion: Option<f64>,
    /// The workspace estimate scale.
    #[serde(serialize_with = "crate::js::numbers")]
    pub scale: Vec<f64>,
    /// The finished tasks the suggestion is based on, most similar first (at most 5).
    pub basis: Vec<EstimateBasis>,
    /// One sentence on how the suggestion was made, for the agent to relay.
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_entry_sources_match_the_contract() {
        let all: Vec<&str> = TimeEntrySource::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(all, ["timer", "manual", "suggested"]);
        assert_eq!(TimeEntrySource::parse("suggested"), Some(TimeEntrySource::Suggested));
        assert_eq!(TimeEntrySource::parse("other"), None);
    }

    #[test]
    fn a_suggestion_without_history_is_null_and_whole_numbers_have_no_fraction() {
        let none = EstimateSuggestion {
            issue_id: "in_1".into(),
            suggestion: None,
            scale: vec![0.0, 1.0, 2.0],
            basis: vec![],
            reason: "r".into(),
        };
        let json = serde_json::to_value(&none).unwrap();
        assert!(json["suggestion"].is_null());
        assert_eq!(serde_json::to_string(&json["scale"]).unwrap(), "[0,1,2]");
        let some = EstimateSuggestion { suggestion: Some(5.0), ..none };
        assert_eq!(serde_json::to_value(&some).unwrap()["suggestion"].to_string(), "5");
    }

    #[test]
    fn a_decision_without_a_thread_serializes_null() {
        let decision = ThreadDecision {
            id: "dc_1".into(),
            issue_id: "in_1".into(),
            issue_key: "TRM-1".into(),
            text: "t".into(),
            paths: vec![],
            thread_url: None,
            created_by: ActorRef::user("u_1"),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = serde_json::to_value(&decision).unwrap();
        assert!(json["threadUrl"].is_null());
        assert_eq!(json["issueKey"], "TRM-1");
    }
}
