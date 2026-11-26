//! The markdown handoff of one issue (`issue-briefing.ts`): what a person or agent needs to pick
//! the work up, without the conversation that produced it.

use trama_contracts::issues::{Artifact, Issue};
use trama_contracts::js;

/// `s.replace(/_/g, ' ')`.
fn words(s: &str) -> String {
    s.replace('_', " ")
}

/// `value.trimEnd()`.
fn trim_end(value: &str) -> &str {
    value.trim_end_matches(js::is_whitespace)
}

/// One `## title` block, left out when it has no lines.
fn section(out: &mut Vec<String>, title: &str, lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    out.push(format!("## {title}"));
    out.push(String::new());
    out.extend(lines);
    out.push(String::new());
}

fn artifact_line(a: &Artifact) -> String {
    let mut bits: Vec<String> = vec![a.state.as_str().to_owned()];
    if let Some(ci) = a.ci.filter(|ci| !ci.as_str().is_empty()) {
        bits.push(format!("CI {ci}"));
    }
    if let Some(review) = a.review.filter(|r| r.as_str() != "none") {
        bits.push(format!("review {}", words(review.as_str())));
    }
    if a.has_conflicts == Some(true) {
        bits.push("has conflicts".to_owned());
    }
    if let Some(environment) = a.environment.as_deref().filter(|e| !e.is_empty()) {
        bits.push(environment.to_owned());
    }
    let id = a
        .external_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map_or_else(String::new, |id| format!(" {id}"));
    let url = a
        .url
        .as_deref()
        .filter(|url| !url.is_empty())
        .map_or_else(String::new, |url| format!(" \u{2014} {url}"));
    format!("- {}{id}: {}{url} ({})", words(a.kind.as_str()), a.title, bits.join(", "))
}

/// The markdown briefing of `issue`: its header, the external tracker link, the thread, the
/// description and the artifacts. Ends with exactly one newline.
#[must_use]
pub fn render_issue_briefing(issue: &Issue, artifacts: &[Artifact]) -> String {
    let mut out: Vec<String> = Vec::new();
    out.push(format!("# {} \u{2014} {}", issue.key, issue.title));
    out.push(String::new());
    out.push(format!(
        "Status: {} \u{b7} Priority: {} \u{b7} Kind: {}",
        words(&issue.status),
        issue.priority,
        words(issue.kind.as_str()),
    ));
    out.push(String::new());

    if let Some(external) = &issue.external_ref {
        let name = external.key.as_deref().unwrap_or(&external.id);
        let state = external
            .state
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(String::new, |s| format!(" ({s})"));
        out.push(format!(
            "External: {} {name}{state} \u{2014} {}",
            external.provider, external.url
        ));
        out.push(String::new());
    }

    if let Some(thread) = issue.thread_url.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("Thread: {thread}"));
        out.push(String::new());
    }

    let body = issue.body.as_deref().map(js::trim).filter(|b| !b.is_empty());
    section(&mut out, "Description", body.map(str::to_owned).into_iter().collect());
    section(&mut out, "Artifacts", artifacts.iter().map(artifact_line).collect());

    format!("{}\n", trim_end(&out.join("\n")))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn issue(extra: &Value) -> Issue {
        let mut base = json!({
            "id": "in_1", "workspaceId": "ws_1", "key": "BUG-142", "number": 142,
            "kind": "bug", "title": "Login loops", "source": "manual", "priority": "high",
            "status": "in_progress", "milestoneIds": [], "labels": [], "aliases": [],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn artifact(extra: &Value) -> Artifact {
        let mut base = json!({
            "id": "ar_1", "kind": "pull_request", "provider": "other", "title": "Fix loop",
            "state": "open", "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    // issues/issue-briefing.spec.ts
    #[test]
    fn renders_only_the_header_for_a_simple_issue() {
        assert_eq!(
            render_issue_briefing(&issue(&json!({})), &[]),
            "# BUG-142 \u{2014} Login loops\n\nStatus: in progress \u{b7} Priority: high \u{b7} Kind: bug\n"
        );
    }

    #[test]
    fn names_the_delta_thread_when_the_task_has_one() {
        let md = render_issue_briefing(
            &issue(&json!({ "threadUrl": "https://delta.dev/t/login-loop-1f2e" })),
            &[],
        );
        assert!(md.contains("Thread: https://delta.dev/t/login-loop-1f2e"));
        assert!(!render_issue_briefing(&issue(&json!({})), &[]).contains("Thread"));
    }

    #[test]
    fn keeps_the_description_and_artifacts() {
        let md = render_issue_briefing(
            &issue(&json!({ "body": "Cookie is dropped." })),
            &[artifact(&json!({
                "externalId": "#12", "ci": "failing", "review": "none", "hasConflicts": true
            }))],
        );
        assert!(!md.contains("Goal"));
        assert!(md.contains("## Description\n\nCookie is dropped."));
        assert!(!md.contains("Decision"));
        assert!(!md.contains("input"));
        assert!(md.contains("- pull request #12: Fix loop (open, CI failing, has conflicts)"));
    }

    #[test]
    fn names_the_linked_external_issue() {
        let md = render_issue_briefing(
            &issue(&json!({ "externalRef": {
                "provider": "github", "id": "acme/api#12", "url": "https://github.com/acme/api/issues/12",
                "key": "#12", "state": "Open", "origin": "link"
            } })),
            &[],
        );
        assert!(md.contains(
            "External: github #12 (Open) \u{2014} https://github.com/acme/api/issues/12"
        ));
    }
}
