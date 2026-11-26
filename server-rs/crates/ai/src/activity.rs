//! What the assistant did while preparing a reply (`server/src/ai/activity.ts`); shown collapsed
//! under the answer.

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use trama_contracts::js;
use utoipa::ToSchema;

/// Longer text is the model thinking out loud, not a status line for the user.
const MAX_NOTE: usize = 280;
const MAX_DETAIL: usize = 200;
const MAX_STEPS: usize = 60;

/// What a step was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    /// The model's own words.
    Note,
    /// A lookup.
    Read,
    /// A change.
    Write,
}

/// One step of an [`Activity`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct ActivityStep {
    /// `note`, `read` or `write`.
    pub kind: StepKind,
    /// Human-readable, e.g. "Looked at issues"; for notes, the model's own words.
    pub label: String,
    /// Set to false when the step failed or was refused (always present on writes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    /// Consecutive identical steps are merged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// Failed writes: why (the API's message, shortened).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The steps of one reply and how long it took.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct Activity {
    /// Whole seconds, at least 1.
    pub seconds: u64,
    /// At most 60 steps.
    pub steps: Vec<ActivityStep>,
}

/// Receives what happens while a reply is being prepared (server-sent events to the browser).
pub trait ChatSink: Send + Sync {
    /// A step was added (`index` is its position) or an existing one was updated (merged
    /// duplicate).
    fn step(&self, index: usize, step: &ActivityStep);
    /// A tool is about to run, e.g. "Looking at issues".
    fn working(&self, label: &str);
    /// The model wrote more text.
    fn text(&self, delta: &str);
    /// The text written so far was only thinking-out-loud before tool calls; discard it.
    fn text_reset(&self);
}

fn verb_past(verb: &str) -> Option<&'static str> {
    Some(match verb {
        "list" | "get" => "Looked at",
        "search" => "Searched",
        "create" => "Created",
        "add" => "Added",
        "update" | "change" => "Updated",
        "reorder" => "Reordered",
        "link" => "Linked",
        "answer" => "Answered",
        "dismiss" => "Dismissed",
        "snooze" => "Snoozed",
        "restore" => "Restored",
        "delete" => "Deleted",
        "remove" => "Removed",
        "revoke" => "Revoked",
        "accept" => "Accepted",
        "reject" => "Rejected",
        "supersede" => "Superseded",
        _ => return None,
    })
}

fn verb_now(verb: &str) -> Option<&'static str> {
    Some(match verb {
        "list" | "get" => "Looking at",
        "search" => "Searching",
        "create" => "Creating",
        "add" => "Adding",
        "update" | "change" => "Updating",
        "reorder" => "Reordering",
        "link" => "Linking",
        "answer" => "Answering",
        "dismiss" => "Dismissing",
        "snooze" => "Snoozing",
        "restore" => "Restoring",
        "delete" => "Deleting",
        "remove" => "Removing",
        "revoke" => "Revoking",
        "accept" => "Accepting",
        "reject" => "Rejecting",
        "supersede" => "Superseding",
        _ => return None,
    })
}

fn split_name(name: &str) -> (&str, String) {
    let mut parts = name.split('_');
    let verb = parts.next().unwrap_or_default();
    (verb, parts.collect::<Vec<_>>().join(" "))
}

/// `create_issue` becomes "Created issue", `list_input_requests` "Looked at input requests".
#[must_use]
pub fn describe_tool(name: &str) -> String {
    if name == "whoami" {
        return "Checked its permissions".to_owned();
    }
    let (verb, noun) = split_name(name);
    if verb == "search" {
        return if noun.is_empty() {
            "Searched the workspace".to_owned()
        } else {
            format!("Searched {noun}")
        };
    }
    let past = verb_past(verb).unwrap_or("Used");
    if noun.is_empty() { past.to_owned() } else { format!("{past} {noun}") }
}

/// `create_issue` becomes "Creating issue" (the step shown while the tool runs).
#[must_use]
pub fn describe_tool_running(name: &str) -> String {
    if name == "whoami" {
        return "Checking its permissions".to_owned();
    }
    let (verb, noun) = split_name(name);
    if verb == "search" {
        return if noun.is_empty() {
            "Searching the workspace".to_owned()
        } else {
            format!("Searching {noun}")
        };
    }
    let now = verb_now(verb).unwrap_or("Using");
    if noun.is_empty() { now.to_owned() } else { format!("{now} {noun}") }
}

/// Collects steps in order, merging consecutive duplicates.
pub struct ActivityLog {
    started: Instant,
    steps: Vec<ActivityStep>,
    sink: Option<Arc<dyn ChatSink>>,
}

impl ActivityLog {
    /// An empty log; every added or merged step is also sent to `sink`.
    #[must_use]
    pub fn new(sink: Option<Arc<dyn ChatSink>>) -> Self {
        Self { started: Instant::now(), steps: Vec::new(), sink }
    }

    fn notify(&self) {
        if let (Some(sink), Some(last)) = (&self.sink, self.steps.last()) {
            sink.step(self.steps.len() - 1, last);
        }
    }

    /// The model's words before a tool call; long ones are dropped.
    pub fn note(&mut self, text: &str) {
        let label = js::trim(text);
        if label.is_empty() || js::len(label) > MAX_NOTE {
            return;
        }
        self.steps.push(ActivityStep {
            kind: StepKind::Note,
            label: label.to_owned(),
            ok: None,
            count: None,
            detail: None,
        });
        self.notify();
    }

    /// A tool ran (`ok`), or was refused or failed with `error`.
    pub fn tool(&mut self, name: &str, write: bool, ok: bool, error: Option<&str>) {
        let label = describe_tool(name);
        let kind = if write { StepKind::Write } else { StepKind::Read };
        // a successful read needs no mark, a failed one does
        let show_ok = write || !ok;
        let error = error.filter(|e| !e.is_empty());
        if let Some(last) = self.steps.last_mut()
            && last.kind == kind
            && last.label == label
            && last.ok == show_ok.then_some(ok)
            && last.detail.is_none()
            && error.is_none()
        {
            last.count = Some(last.count.unwrap_or(1) + 1);
            self.notify();
            return;
        }
        let detail = error.filter(|_| !ok).map(|e| {
            let squashed = e.split(js::is_whitespace).filter(|p| !p.is_empty()).collect::<Vec<_>>();
            js::truncate(&squashed.join(" "), MAX_DETAIL).to_owned()
        });
        self.steps.push(ActivityStep {
            kind,
            label,
            ok: show_ok.then_some(ok),
            count: None,
            detail,
        });
        self.notify();
    }

    /// `None` when no tool ran; notes alone are not worth showing.
    #[must_use]
    pub fn result(&self) -> Option<Activity> {
        if self.steps.iter().all(|s| s.kind == StepKind::Note) {
            return None;
        }
        let elapsed = self.started.elapsed().as_secs_f64();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let seconds = (elapsed.round() as u64).max(1);
        Some(Activity { seconds, steps: self.steps.iter().take(MAX_STEPS).cloned().collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: StepKind, label: &str) -> ActivityStep {
        ActivityStep { kind, label: label.to_owned(), ok: None, count: None, detail: None }
    }

    #[test]
    fn turns_tool_names_into_short_past_tense_labels() {
        assert_eq!(describe_tool("list_issues"), "Looked at issues");
        assert_eq!(describe_tool("get_issue"), "Looked at issue");
        assert_eq!(describe_tool("create_issue"), "Created issue");
        assert_eq!(describe_tool("answer_input_request"), "Answered input request");
        assert_eq!(describe_tool("delete_view"), "Deleted view");
        assert_eq!(describe_tool("search"), "Searched the workspace");
        assert_eq!(describe_tool("whoami"), "Checked its permissions");
        assert_eq!(describe_tool("mystery_thing"), "Used thing");
    }

    #[test]
    fn turns_tool_names_into_present_tense_labels() {
        assert_eq!(describe_tool_running("create_issue"), "Creating issue");
        assert_eq!(describe_tool_running("list_input_requests"), "Looking at input requests");
        assert_eq!(describe_tool_running("search"), "Searching the workspace");
        assert_eq!(describe_tool_running("search_issues"), "Searching issues");
        assert_eq!(describe_tool_running("whoami"), "Checking its permissions");
        assert_eq!(describe_tool_running("mystery"), "Using");
    }

    #[test]
    fn merges_consecutive_identical_steps_and_keeps_notes_in_order() {
        let mut log = ActivityLog::new(None);
        log.note("  Checking your issues  ");
        log.note(&"x".repeat(400)); // thinking out loud: dropped
        log.tool("list_issues", false, true, None);
        log.tool("list_issues", false, true, None);
        log.tool("list_teams", false, false, Some("HTTP 403: nope"));
        log.tool("create_issue", true, true, None);
        log.tool("create_issue", true, false, Some("HTTP 400:\n kind must be one of bug|feature"));
        let activity = log.result().unwrap();
        assert_eq!(
            activity.steps,
            vec![
                step(StepKind::Note, "Checking your issues"),
                ActivityStep { count: Some(2), ..step(StepKind::Read, "Looked at issues") },
                ActivityStep {
                    ok: Some(false),
                    detail: Some("HTTP 403: nope".into()),
                    ..step(StepKind::Read, "Looked at teams")
                },
                ActivityStep { ok: Some(true), ..step(StepKind::Write, "Created issue") },
                ActivityStep {
                    ok: Some(false),
                    detail: Some("HTTP 400: kind must be one of bug|feature".into()),
                    ..step(StepKind::Write, "Created issue")
                },
            ]
        );
        assert!(activity.seconds >= 1);
    }

    #[test]
    fn reports_nothing_when_no_tool_ran() {
        let mut log = ActivityLog::new(None);
        log.note("just thinking");
        assert!(log.result().is_none());
    }

    #[test]
    fn serializes_without_empty_fields() {
        let json = serde_json::to_value(ActivityStep {
            ok: Some(true),
            ..step(StepKind::Write, "Created issue")
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "write", "label": "Created issue", "ok": true})
        );
    }
}
