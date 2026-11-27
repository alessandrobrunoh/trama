//! Request bodies and queries of the thread routes: the DTOs of
//! `server/src/threads/threads.controller.ts`.
//!
//! Responses are the contract types of [`trama_contracts::threads`]. Messages come out in
//! class-validator's order: properties as declared, decorators bottom-up, nested errors after
//! the constraints of their parent and prefixed with its path (`decisions.0.text …`).

use serde::Deserialize;
use serde_json::Value;
use trama_common::validation::{ISSUE_THREAD_URL_MAX, is_thread_url};
use trama_contracts::js::len as js_len;
use trama_contracts::threads::{
    DECISION_PATHS_MAX, DECISION_TEXT_MAX, DECISIONS_PER_SYNC_MAX, THREAD_FILES_MAX,
    THREAD_PATH_MAX, THREAD_SUGGESTED_MINUTES_MAX, THREAD_SUMMARY_MAX, ThreadSyncDecision,
    ThreadSyncInput,
};
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::Checks;
use utoipa::{IntoParams, ToSchema};

/// Largest `limit` of `GET /decisions` (`DECISIONS_MAX_LIMIT`).
pub const DECISIONS_MAX_LIMIT: u64 = 200;
/// `limit` of `GET /decisions` when none is given.
pub const DECISIONS_DEFAULT_LIMIT: u64 = 50;

/// `@IsOptional() @IsString() @IsThreadUrl()`, bottom-up.
fn thread_url(c: &mut Checks, field: &str, value: &Value) -> Option<String> {
    let s = value.as_str();
    c.check(
        s.is_some_and(is_thread_url),
        format!(
            "{field} must be an http or https URL of at most {ISSUE_THREAD_URL_MAX} characters"
        ),
    );
    c.check(s.is_some(), format!("{field} must be a string"));
    s.map(str::to_owned)
}

/// `@IsString() @MaxLength(max)`, bottom-up, for `field` reported as `{prefix}{field}`.
fn text(c: &mut Checks, prefix: &str, field: &str, value: &Value, max: usize) -> Option<String> {
    let s = value.as_str();
    c.check(
        s.is_some_and(|s| js_len(s) <= max),
        format!("{prefix}{field} must be shorter than or equal to {max} characters"),
    );
    c.check(s.is_some(), format!("{prefix}{field} must be a string"));
    s.map(str::to_owned)
}

/// `@IsArray() @ArrayMaxSize(max_items) @IsString({ each: true }) @MaxLength(max_len, { each:
/// true })`, bottom-up. `each` validates the elements of an array and anything else as one value.
fn string_list(
    c: &mut Checks,
    prefix: &str,
    field: &str,
    value: &Value,
    max_items: usize,
    max_len: usize,
) -> Option<Vec<String>> {
    let list = value.as_array();
    let items: Vec<&Value> = list.map_or_else(|| vec![value], |l| l.iter().collect());
    c.check(
        items.iter().all(|v| v.as_str().is_some_and(|s| js_len(s) <= max_len)),
        format!(
            "{prefix}each value in {field} must be shorter than or equal to {max_len} characters"
        ),
    );
    c.check(
        items.iter().all(|v| v.is_string()),
        format!("{prefix}each value in {field} must be a string"),
    );
    c.check(
        list.is_some_and(|l| l.len() <= max_items),
        format!("{prefix}{field} must contain no more than {max_items} elements"),
    );
    c.check(list.is_some(), format!("{prefix}{field} must be an array"));
    let strings: Vec<String> = list?.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
    (strings.len() == list?.len()).then_some(strings)
}

/// `@IsInt() @Min(min) @Max(max)`, bottom-up.
fn int_in(c: &mut Checks, field: &str, value: &Value, min: i64, max: i64) -> Option<i64> {
    let n = value.as_f64();
    #[allow(clippy::cast_precision_loss)]
    let (lo, hi) = (min as f64, max as f64);
    c.check(n.is_some_and(|n| n <= hi), format!("{field} must not be greater than {max}"));
    c.check(n.is_some_and(|n| n >= lo), format!("{field} must not be less than {min}"));
    c.check(n.is_some_and(|n| n.fract() == 0.0), format!("{field} must be an integer number"));
    #[allow(clippy::cast_possible_truncation)]
    n.filter(|n| n.fract() == 0.0).map(|n| n as i64)
}

/// `POST /tasks/{idOrKey}/thread/sync` (`ThreadSyncDto`). Every field is optional.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSyncBody {
    /// Links this thread when the task has none; 409 when it links a different one.
    #[schema(value_type = Option<String>)]
    pub thread_url: Option<Value>,
    /// What the thread did so far (replaces the previous summary), at most 4000 characters.
    #[schema(value_type = Option<String>)]
    pub summary: Option<Value>,
    /// Decisions made since the last sync, at most 20.
    #[schema(value_type = Option<Vec<ThreadSyncDecision>>)]
    pub decisions: Option<Value>,
    /// Files touched since the last sync, at most 500.
    #[schema(value_type = Option<Vec<String>>)]
    pub files: Option<Value>,
    /// A PR / MR the thread opened.
    #[schema(value_type = Option<String>)]
    pub pull_request_url: Option<Value>,
    /// Active minutes since the last sync, 1 to 720.
    #[schema(value_type = Option<i64>)]
    pub active_minutes: Option<Value>,
    /// Turns of the thread so far.
    #[schema(value_type = Option<i64>)]
    pub turns: Option<Value>,
}

impl ThreadSyncBody {
    /// Runs the DTO rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<ThreadSyncInput, AppError> {
        let mut c = Checks::new();
        let thread = self.thread_url.as_ref().and_then(|v| thread_url(&mut c, "threadUrl", v));
        let summary =
            self.summary.as_ref().and_then(|v| text(&mut c, "", "summary", v, THREAD_SUMMARY_MAX));
        let decisions = self.decisions.as_ref().and_then(|v| decisions(&mut c, v));
        let files = self
            .files
            .as_ref()
            .and_then(|v| string_list(&mut c, "", "files", v, THREAD_FILES_MAX, THREAD_PATH_MAX));
        let pull_request =
            self.pull_request_url.as_ref().and_then(|v| thread_url(&mut c, "pullRequestUrl", v));
        let active_minutes = self
            .active_minutes
            .as_ref()
            .and_then(|v| int_in(&mut c, "activeMinutes", v, 1, THREAD_SUGGESTED_MINUTES_MAX));
        let turns = self.turns.as_ref().and_then(|v| int_in(&mut c, "turns", v, 0, 1_000_000));
        c.finish()?;
        Ok(ThreadSyncInput {
            thread_url: thread,
            summary,
            decisions,
            files,
            pull_request_url: pull_request,
            active_minutes,
            turns,
        })
    }
}

/// `@IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true })` on `decisions`.
fn decisions(c: &mut Checks, value: &Value) -> Option<Vec<ThreadSyncDecision>> {
    let list = value.as_array();
    c.check(
        list.is_some_and(|l| l.len() <= DECISIONS_PER_SYNC_MAX),
        format!("decisions must contain no more than {DECISIONS_PER_SYNC_MAX} elements"),
    );
    c.check(list.is_some(), "decisions must be an array");
    let Some(list) = list else {
        c.check(false, "nested property decisions must be either object or array");
        return None;
    };
    let mut out = Vec::with_capacity(list.len());
    let mut valid = true;
    for (index, element) in list.iter().enumerate() {
        let prefix = format!("decisions.{index}.");
        let Value::Object(map) = element else {
            c.check(
                false,
                format!("{prefix}nested property decisions must be either object or array"),
            );
            valid = false;
            continue;
        };
        let missing = Value::Null;
        let text = text(c, &prefix, "text", map.get("text").unwrap_or(&missing), DECISION_TEXT_MAX);
        let paths = match map.get("paths").filter(|v| !v.is_null()) {
            Some(v) => {
                let paths =
                    string_list(c, &prefix, "paths", v, DECISION_PATHS_MAX, THREAD_PATH_MAX);
                valid &= paths.is_some();
                paths
            }
            None => None,
        };
        match text {
            Some(text) => out.push(ThreadSyncDecision { text, paths }),
            None => valid = false,
        }
    }
    valid.then_some(out)
}

/// Query of `GET /decisions` (`ListDecisionsQuery`), all optional.
#[derive(Clone, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListDecisionsQuery {
    /// A repository file: matches decisions on that file, on a directory above it, or on a glob.
    pub path: Option<String>,
    /// Id or key of a task: only its decisions (and the ones without paths, when `path` is
    /// given).
    pub issue: Option<String>,
    /// Most decisions to return, 1 to 200 (50 by default).
    pub limit: Option<u64>,
}

impl ListDecisionsQuery {
    /// The DTO rules over the raw query string, read as Express and `@Type(() => Number)` do.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut values: Vec<(String, Vec<String>)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            match values.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(value.into_owned()),
                None => values.push((key.into_owned(), vec![value.into_owned()])),
            }
        }
        let get = |name: &str| values.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice());
        let mut c = Checks::new();

        let mut string = |name: &str, max: usize| -> Option<String> {
            let list = get(name)?;
            let one = (list.len() == 1).then(|| list[0].clone());
            c.check(
                one.as_deref().is_some_and(|s| js_len(s) <= max),
                format!("{name} must be shorter than or equal to {max} characters"),
            );
            c.check(one.is_some(), format!("{name} must be a string"));
            one
        };
        let path = string("path", 1024);
        let issue = string("issue", 100);

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200), bottom-up
        let limit = get("limit").map(|list| match list {
            [one] => js_number(one).unwrap_or(f64::NAN),
            _ => f64::NAN,
        });
        if let Some(n) = limit {
            #[allow(clippy::cast_precision_loss)]
            let max = DECISIONS_MAX_LIMIT as f64;
            c.check(n <= max, format!("limit must not be greater than {DECISIONS_MAX_LIMIT}"))
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        c.finish()?;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(Self { path, issue, limit: limit.map(|n| n as u64) })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message(body: Value) -> String {
        serde_json::from_value::<ThreadSyncBody>(body)
            .unwrap()
            .validate()
            .expect_err("invalid")
            .to_string()
    }

    #[test]
    fn an_empty_body_and_null_fields_are_fine() {
        let input = serde_json::from_value::<ThreadSyncBody>(json!({
            "threadUrl": null, "summary": null, "decisions": null, "files": null,
            "pullRequestUrl": null, "activeMinutes": null, "turns": null, "unknown": 1
        }))
        .unwrap()
        .validate()
        .unwrap();
        assert_eq!(input, ThreadSyncInput::default());
    }

    #[test]
    fn a_full_body_is_read_as_sent() {
        let input = serde_json::from_value::<ThreadSyncBody>(json!({
            "threadUrl": "https://delta.dev/t/th_1",
            "summary": " Done ",
            "decisions": [{ "text": " Keep it ", "paths": ["src/"] }, { "text": "No paths" }],
            "files": ["a.ts", "b.ts"],
            "pullRequestUrl": "https://github.com/acme/web/pull/1",
            "activeMinutes": 47,
            "turns": 0,
        }))
        .unwrap()
        .validate()
        .unwrap();
        assert_eq!(input.summary.as_deref(), Some(" Done "));
        assert_eq!(input.active_minutes, Some(47));
        assert_eq!(input.turns, Some(0));
        let decisions = input.decisions.unwrap();
        assert_eq!(decisions[0].paths.as_deref(), Some(&["src/".to_owned()][..]));
        assert_eq!(decisions[1].paths, None);
    }

    #[test]
    fn urls_must_be_http_urls() {
        assert_eq!(
            message(json!({ "threadUrl": "ftp://delta.dev/t/1" })),
            "400 Bad Request: threadUrl must be an http or https URL of at most 2048 characters"
        );
        assert_eq!(
            message(json!({ "pullRequestUrl": "javascript:alert(1)" })),
            "400 Bad Request: pullRequestUrl must be an http or https URL of at most 2048 characters"
        );
        assert_eq!(
            message(json!({ "threadUrl": 3 })),
            "400 Bad Request: threadUrl must be an http or https URL of at most 2048 characters; threadUrl must be a string"
        );
    }

    #[test]
    fn the_summary_and_the_numbers_have_limits() {
        assert_eq!(
            message(json!({ "summary": "x".repeat(4001) })),
            "400 Bad Request: summary must be shorter than or equal to 4000 characters"
        );
        assert_eq!(
            message(json!({ "activeMinutes": 0 })),
            "400 Bad Request: activeMinutes must not be less than 1"
        );
        assert_eq!(
            message(json!({ "activeMinutes": 721 })),
            "400 Bad Request: activeMinutes must not be greater than 720"
        );
        assert_eq!(
            message(json!({ "activeMinutes": 1.5, "turns": "x" })),
            "400 Bad Request: activeMinutes must be an integer number; turns must not be greater than 1000000; turns must not be less than 0; turns must be an integer number"
        );
    }

    #[test]
    fn lists_have_limits_and_nested_errors_carry_their_path() {
        let many: Vec<Value> = (0..21).map(|i| json!({ "text": format!("d{i}") })).collect();
        assert_eq!(
            message(json!({ "decisions": many })),
            "400 Bad Request: decisions must contain no more than 20 elements"
        );
        assert_eq!(
            message(json!({ "decisions": "x" })),
            "400 Bad Request: decisions must contain no more than 20 elements; decisions must be an array; nested property decisions must be either object or array"
        );
        assert_eq!(
            message(json!({ "decisions": [{ "paths": [1], "text": 4 }] })),
            "400 Bad Request: decisions.0.text must be shorter than or equal to 1000 characters; decisions.0.text must be a string; decisions.0.each value in paths must be shorter than or equal to 512 characters; decisions.0.each value in paths must be a string"
        );
        assert_eq!(
            message(json!({ "files": ["ok", 3] })),
            "400 Bad Request: each value in files must be shorter than or equal to 512 characters; each value in files must be a string"
        );
        assert_eq!(
            message(json!({ "files": { "a": 1 } })),
            "400 Bad Request: each value in files must be shorter than or equal to 512 characters; each value in files must be a string; files must contain no more than 500 elements; files must be an array"
        );
    }

    fn query(raw: &str) -> Result<ListDecisionsQuery, String> {
        ListDecisionsQuery::parse(Some(raw)).map_err(|e| e.to_string())
    }

    #[test]
    fn the_decisions_query_is_all_optional() {
        assert_eq!(ListDecisionsQuery::parse(None).unwrap(), ListDecisionsQuery::default());
        let q = query("path=src%2Fa.ts&issue=TRM-1&limit=2").unwrap();
        assert_eq!(q.path.as_deref(), Some("src/a.ts"));
        assert_eq!(q.issue.as_deref(), Some("TRM-1"));
        assert_eq!(q.limit, Some(2));
    }

    #[test]
    fn the_decisions_query_refuses_a_bad_limit_and_repeated_keys() {
        assert_eq!(
            query("limit=500").unwrap_err(),
            "400 Bad Request: limit must not be greater than 200"
        );
        assert_eq!(query("limit=0").unwrap_err(), "400 Bad Request: limit must not be less than 1");
        assert_eq!(
            query("limit=1.5").unwrap_err(),
            "400 Bad Request: limit must be an integer number"
        );
        assert_eq!(
            query("limit=abc").unwrap_err(),
            "400 Bad Request: limit must not be greater than 200; limit must not be less than 1; limit must be an integer number"
        );
        assert_eq!(
            query("issue=a&issue=b").unwrap_err(),
            "400 Bad Request: issue must be shorter than or equal to 100 characters; issue must be a string"
        );
        assert_eq!(
            query(&format!("path={}", "a".repeat(1025))).unwrap_err(),
            "400 Bad Request: path must be shorter than or equal to 1024 characters"
        );
    }
}
