//! Fits `create_issue` / `update_issue` tool arguments to the issues API before they are sent
//! (`server/src/ai/issue-args.ts`): a title over 300 characters or a kind outside the enum would
//! be a 400 there.

use serde_json::{Map, Value, json};
use trama_contracts::js;

/// Matches `CreateIssueDto` / `UpdateIssueDto`.
const TITLE_MAX: usize = 300;
const BODY_MAX: usize = 20_000;
const REPORTER_MAX: usize = 200;
const URL_MAX: usize = 500;

const TITLE_ERROR: &str = "title must be a string of 1 to 300 characters.";
const KIND_ERROR: &str =
    "kind must be one of: bug, feature, incident, tech_debt, feedback, idea, security.";
const PARENT_ERROR: &str = "parentId must be an issue id or key, or null to clear it.";

/// Words the model uses that are not the stored enum.
fn kind_alias(key: &str) -> Option<&'static str> {
    Some(match key {
        "bug" | "bugs" | "defect" => "bug",
        "feature" | "feat" | "story" => "feature",
        "incident" | "inc" | "outage" => "incident",
        "tech_debt" | "techdebt" | "debt" => "tech_debt",
        "feedback" | "fb" => "feedback",
        "idea" => "idea",
        "security" | "sec" => "security",
        _ => return None,
    })
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = js::trim(value);
    if js::len(trimmed) <= max {
        trimmed.to_owned()
    } else {
        js::truncate(trimmed, max).trim_end_matches(js::is_whitespace).to_owned()
    }
}

/// `value.trim().toLowerCase().replace(/[\s-]+/g, '_')` looked up in the aliases.
fn kind_of(value: &Value) -> Option<&'static str> {
    let text = value.as_str()?;
    let mut key = String::new();
    let mut in_separator = false;
    for c in js::trim(text).to_lowercase().chars() {
        if c == '-' || js::is_whitespace(c) {
            if !in_separator {
                key.push('_');
            }
            in_separator = true;
        } else {
            key.push(c);
            in_separator = false;
        }
    }
    kind_alias(&key)
}

/// `Math.min(1000, Math.max(0, Math.round(value)))`.
fn clamp_estimate(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let rounded = (value + 0.5).floor().clamp(0.0, 1000.0) as i64;
    rounded
}

/// Fits the arguments of `create_issue` / `update_issue` to the issues API; other tools are
/// returned unchanged. `Err` is the message the model gets back instead of a call.
///
/// # Errors
///
/// The text to tell the model when a title, kind or parent cannot be fixed.
pub fn normalize_issue_tool_args(
    name: &str,
    args: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    if name != "create_issue" && name != "update_issue" {
        return Ok(args.clone());
    }
    let mut next = args.clone();
    let creating = name == "create_issue";

    match next.get("title").cloned() {
        Some(Value::Null) if !creating => {
            next.remove("title");
        }
        Some(title @ (Value::String(_) | Value::Number(_))) => {
            let text = match &title {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let clipped = clip(&text, TITLE_MAX);
            if clipped.is_empty() {
                return Err(TITLE_ERROR.to_owned());
            }
            next.insert("title".to_owned(), Value::String(clipped));
        }
        Some(_) => return Err(TITLE_ERROR.to_owned()),
        None if creating => return Err(TITLE_ERROR.to_owned()),
        None => {}
    }

    match next.get("kind") {
        Some(Value::Null) if !creating => {
            next.remove("kind");
        }
        Some(kind) => {
            let mapped = kind_of(kind).ok_or_else(|| KIND_ERROR.to_owned())?;
            next.insert("kind".to_owned(), json!(mapped));
        }
        None if creating => return Err(KIND_ERROR.to_owned()),
        None => {}
    }

    if next.get("parentId").is_some_and(|p| !p.is_null() && !p.is_string()) {
        return Err(PARENT_ERROR.to_owned());
    }

    for (field, max) in
        [("body", BODY_MAX), ("reporterName", REPORTER_MAX), ("externalUrl", URL_MAX)]
    {
        if let Some(Value::String(value)) = next.get(field) {
            let clipped = clip(value, max);
            next.insert(field.to_owned(), Value::String(clipped));
        }
    }

    if let Some(estimate) = next.get("estimate").and_then(Value::as_f64) {
        next.insert("estimate".to_owned(), json!(clamp_estimate(estimate)));
    }

    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: &Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn run(name: &str, input: &Value) -> Result<Value, String> {
        normalize_issue_tool_args(name, &args(input)).map(Value::Object)
    }

    #[test]
    fn clips_an_overlong_title_and_maps_kind_aliases_before_create() {
        let title = format!("  {}  ", "a".repeat(400));
        let result = run(
            "create_issue",
            &json!({ "title": title, "kind": "Inc", "body": "x".repeat(20_050) }),
        );
        assert_eq!(
            result,
            Ok(json!({ "title": "a".repeat(300), "kind": "incident", "body": "x".repeat(20_000) }))
        );
    }

    #[test]
    fn accepts_the_stored_kinds_and_common_spellings() {
        assert_eq!(
            run("create_issue", &json!({ "title": "Login fails", "kind": "tech debt" })),
            Ok(json!({ "title": "Login fails", "kind": "tech_debt" }))
        );
        assert_eq!(
            run("update_issue", &json!({ "idOrKey": "BUG-1", "kind": "FEAT" })),
            Ok(json!({ "idOrKey": "BUG-1", "kind": "feature" }))
        );
        assert_eq!(
            run("create_issue", &json!({ "title": "t", "kind": " Tech-Debt " })),
            Ok(json!({ "title": "t", "kind": "tech_debt" }))
        );
    }

    #[test]
    fn passes_parent_references_through_and_keeps_null_to_clear_on_update() {
        assert_eq!(
            run(
                "create_issue",
                &json!({ "title": "Child task", "kind": "bug", "parentId": "BUG-1" })
            ),
            Ok(json!({ "title": "Child task", "kind": "bug", "parentId": "BUG-1" }))
        );
        assert_eq!(
            run("update_issue", &json!({ "idOrKey": "BUG-2", "parentId": null })),
            Ok(json!({ "idOrKey": "BUG-2", "parentId": null }))
        );
    }

    #[test]
    fn rejects_non_string_parent_references_before_the_issues_api_call() {
        assert_eq!(
            run("update_issue", &json!({ "idOrKey": "BUG-2", "parentId": { "id": "BUG-1" } })),
            Err("parentId must be an issue id or key, or null to clear it.".to_owned())
        );
    }

    #[test]
    fn refuses_a_kind_or_title_the_issues_api_would_reject_without_calling_it() {
        assert_eq!(
            run("create_issue", &json!({ "title": "   ", "kind": "bug" })),
            Err("title must be a string of 1 to 300 characters.".to_owned())
        );
        assert_eq!(
            run("create_issue", &json!({ "title": { "text": "nope" }, "kind": "bug" })),
            Err("title must be a string of 1 to 300 characters.".to_owned())
        );
        assert_eq!(
            run("create_issue", &json!({ "kind": "bug" })),
            Err("title must be a string of 1 to 300 characters.".to_owned())
        );
        assert_eq!(
            run("update_issue", &json!({ "idOrKey": "BUG-1", "kind": "task" })),
            Err(
                "kind must be one of: bug, feature, incident, tech_debt, feedback, idea, security."
                    .to_owned()
            )
        );
        assert_eq!(
            run("create_issue", &json!({ "title": "t" })),
            Err(
                "kind must be one of: bug, feature, incident, tech_debt, feedback, idea, security."
                    .to_owned()
            )
        );
    }

    #[test]
    fn drops_null_title_and_kind_on_update_and_leaves_other_tools_alone() {
        assert_eq!(
            run(
                "update_issue",
                &json!({ "idOrKey": "BUG-1", "title": null, "kind": null, "estimate": 1001.2 })
            ),
            Ok(json!({ "idOrKey": "BUG-1", "estimate": 1000 }))
        );
        let other = json!({ "title": "x".repeat(500), "kind": "nope" });
        assert_eq!(run("create_decision", &other), Ok(other));
    }

    #[test]
    fn rounds_and_clamps_the_estimate() {
        let run_estimate = |value: Value| {
            run("update_issue", &json!({ "estimate": value })).unwrap()["estimate"].clone()
        };
        assert_eq!(run_estimate(json!(2.5)), json!(3));
        assert_eq!(run_estimate(json!(-4)), json!(0));
        assert_eq!(run_estimate(json!(7)), json!(7));
    }
}
