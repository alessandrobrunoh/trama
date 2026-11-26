//! Request bodies and query strings of the tasks routes (the DTOs of `issues.controller.ts`) and
//! what they become once validated. Responses are `trama_contracts::issues::{Issue, IssueContext}`.
//!
//! The DTO fields keep the raw JSON so that a value of the wrong type is reported with
//! class-validator's messages (`title must be a string`) rather than serde's. The messages of
//! one field come in the order class-validator reports them (the decorator listed last first)
//! and the fields in declaration order.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use trama_common::validation::{ISSUE_THREAD_URL_MAX, is_thread_url};
use trama_contracts::common::Priority;
use trama_contracts::issues::{IssueKind, IssueSource};
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::{Checks, Patch, js_len};
use trama_milestones::dates;
use utoipa::{IntoParams, ToSchema};

use crate::service::{BulkIssuePatch, IssueFilter, IssueInput, NewIssue};

/// Most issues a bulk request acts on (`BULK_ISSUES_MAX`).
pub const BULK_ISSUES_MAX: usize = 100;
/// Most labels one issue carries (`@ArrayMaxSize(20)`).
pub const LABELS_MAX: usize = 20;
/// Longest issue title.
pub const TITLE_MAX: usize = 300;
/// Longest issue body.
pub const BODY_MAX: usize = 20_000;
/// Longest reporter name.
pub const REPORTER_MAX: usize = 200;
/// Longest external URL.
pub const EXTERNAL_URL_MAX: usize = 500;

const KINDS: &[&str] = &["bug", "feature", "incident", "tech_debt", "feedback", "idea", "security"];
const PRIORITIES: &[&str] = &["none", "low", "medium", "high", "urgent"];
const SOURCES: &[&str] = &["manual", "github", "gitlab", "linear", "email", "api", "agent"];
const STATUS_PATTERN: &str =
    "/^(draft|backlog|todo|in_progress|in_review|done|canceled|st_[a-z0-9]+)$/";
const DATE_MESSAGE: &str = " must be a valid ISO 8601 date string";

/// `ISSUE_STATUS_INPUT`: a seeded issue status, or an id created in workspace settings
/// (`st_…`).
fn is_status_input(value: &str) -> bool {
    matches!(
        value,
        "draft" | "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled"
    ) || value.strip_prefix("st_").is_some_and(|rest| {
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

// ───────────────────────── rules, one per class-validator decorator ─────────────────────────

/// `@IsIn(values)`.
fn one_of(c: &mut Checks, field: &str, value: Option<&Value>, allowed: &[&str]) -> Option<String> {
    let found = value.and_then(Value::as_str).filter(|s| allowed.contains(s));
    c.check(
        found.is_some(),
        format!("{field} must be one of the following values: {}", allowed.join(", ")),
    );
    found.map(str::to_owned)
}

/// `@Matches(ISSUE_STATUS_INPUT)`.
fn status(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<String> {
    let found = value.and_then(Value::as_str).filter(|s| is_status_input(s));
    c.check(found.is_some(), format!("{field} must match {STATUS_PATTERN} regular expression"));
    found.map(str::to_owned)
}

/// `@IsString() @MinLength(min)? @MaxLength(max)?`: the length rules also fail on a non-string, so
/// they report before `IsString`.
fn text(
    c: &mut Checks,
    field: &str,
    value: Option<&Value>,
    min: Option<usize>,
    max: Option<usize>,
) -> Option<String> {
    let s = value.and_then(Value::as_str);
    if let Some(max) = max {
        c.check(
            s.is_some_and(|s| js_len(s) <= max),
            format!("{field} must be shorter than or equal to {max} characters"),
        );
    }
    if let Some(min) = min {
        c.check(
            s.is_some_and(|s| js_len(s) >= min),
            format!("{field} must be longer than or equal to {min} characters"),
        );
    }
    c.check(s.is_some(), format!("{field} must be a string"));
    s.map(str::to_owned)
}

/// `@IsString() @IsThreadUrl()`.
fn thread_url(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<String> {
    let s = value.and_then(Value::as_str);
    c.check(
        s.is_some_and(is_thread_url),
        format!(
            "{field} must be an http or https URL of at most {ISSUE_THREAD_URL_MAX} characters"
        ),
    );
    c.check(s.is_some(), format!("{field} must be a string"));
    s.map(str::to_owned)
}

/// `@IsNumber() @Min(0) @Max(1000)`.
fn estimate(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<f64> {
    let n = value.and_then(Value::as_f64);
    c.check(n.is_some_and(|n| n <= 1000.0), format!("{field} must not be greater than 1000"));
    c.check(n.is_some_and(|n| n >= 0.0), format!("{field} must not be less than 0"));
    c.check(
        n.is_some(),
        format!("{field} must be a number conforming to the specified constraints"),
    );
    n
}

/// `@IsISO8601()`, and a date JavaScript can read (`new Date(value)`).
fn date(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<DateTime<Utc>> {
    let parsed =
        value.and_then(Value::as_str).filter(|s| dates::is_iso8601(s)).and_then(dates::parse);
    c.check(parsed.is_some(), format!("{field}{DATE_MESSAGE}"));
    parsed
}

/// The bounds of an array of strings; a field lists the decorators it has.
#[derive(Clone, Copy, Default)]
struct ListRules {
    /// `@MaxLength(n, { each: true })`
    each_max_len: Option<usize>,
    /// `@ArrayUnique()`
    unique: bool,
    /// `@ArrayMaxSize(n)`
    max: Option<usize>,
    /// `@ArrayMinSize(n)`
    min: Option<usize>,
}

/// `@IsArray() @ArrayMinSize? @ArrayMaxSize? @ArrayUnique? @IsString({ each: true })
/// @MaxLength(n, { each: true })?`. `each` rules apply to the elements of an array and to a lone
/// value otherwise, as class-validator does.
fn string_list(
    c: &mut Checks,
    field: &str,
    value: Option<&Value>,
    rules: ListRules,
) -> Vec<String> {
    let value = value.unwrap_or(&Value::Null);
    let list = value.as_array();
    let elements: Vec<&Value> = list.map_or_else(|| vec![value], |l| l.iter().collect());
    if let Some(max) = rules.each_max_len {
        c.check(
            elements.iter().all(|v| v.as_str().is_some_and(|s| js_len(s) <= max)),
            format!("each value in {field} must be shorter than or equal to {max} characters"),
        );
    }
    c.check(
        elements.iter().all(|v| v.is_string()),
        format!("each value in {field} must be a string"),
    );
    if rules.unique {
        let strings: Vec<&str> = elements.iter().filter_map(|v| v.as_str()).collect();
        let distinct = strings.iter().enumerate().all(|(i, s)| strings[..i].iter().all(|p| p != s));
        c.check(list.is_some() && distinct, format!("All {field}'s elements must be unique"));
    }
    if let Some(max) = rules.max {
        c.check(
            list.is_some_and(|l| l.len() <= max),
            format!("{field} must contain no more than {max} elements"),
        );
    }
    if let Some(min) = rules.min {
        c.check(
            list.is_some_and(|l| l.len() >= min),
            format!("{field} must contain at least {min} elements"),
        );
    }
    c.check(list.is_some(), format!("{field} must be an array"));
    list.into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

const LABELS: ListRules =
    ListRules { each_max_len: None, unique: false, max: Some(LABELS_MAX), min: None };

/// The value of an `@IsOptional()` field: absent and `null` skip every rule.
fn optional(value: &Patch<Value>) -> Option<&Value> {
    value.as_value()
}

/// A `@Clearable()` field (`null` clears it, absent leaves it): `None` when absent,
/// `Some(None)` for `null`, else the value to check.
#[allow(clippy::option_option, reason = "absent, null and a value are three different requests")]
fn clearable(value: &Patch<Value>) -> Option<Option<&Value>> {
    match value {
        Patch::Missing => None,
        Patch::Null => Some(None),
        Patch::Value(v) => Some(Some(v)),
    }
}

/// An `@OptionalNotNull()` field: absent skips the rules, `null` is checked (and fails them).
fn not_null(value: &Patch<Value>) -> Option<&Value> {
    match value {
        Patch::Missing => None,
        Patch::Null => Some(&Value::Null),
        Patch::Value(v) => Some(v),
    }
}

// ───────────────────────────────────── bodies ─────────────────────────────────────

/// `POST /api/w/{slug}/tasks`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueDto {
    /// `bug`, `feature`, `incident`, `tech_debt`, `feedback`, `idea` or `security`.
    #[schema(value_type = String)]
    pub kind: Option<Value>,
    /// Title (1 to 300 characters).
    #[schema(value_type = String)]
    pub title: Option<Value>,
    /// Description (at most 20000 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub body: Patch<Value>,
    /// `manual`, `github`, `gitlab`, `linear`, `email`, `api` or `agent`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub source: Patch<Value>,
    /// Free-text reporter (at most 200 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub reporter_name: Patch<Value>,
    /// Assignee.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub assignee_id: Patch<Value>,
    /// Project.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub project_id: Patch<Value>,
    /// Id or key of the parent issue.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub parent_id: Patch<Value>,
    /// `none`, `low`, `medium`, `high` or `urgent`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub priority: Patch<Value>,
    /// A seeded status or an id created in workspace settings (`st_…`).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub status: Patch<Value>,
    /// Link to the issue elsewhere (at most 500 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub external_url: Patch<Value>,
    /// Link to the Delta thread worked on for this task (http/https, at most 2048 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub thread_url: Patch<Value>,
    /// Story points (0 to 1000).
    #[serde(default)]
    #[schema(value_type = Option<f64>)]
    pub estimate: Patch<Value>,
    /// The day the task should be done (ISO 8601).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub due_date: Patch<Value>,
    /// Workspace label ids (at most 20).
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub labels: Patch<Value>,
}

impl CreateIssueDto {
    /// The class-validator rules of `CreateIssueDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewIssue, AppError> {
        let mut c = Checks::new();
        let kind = one_of(&mut c, "kind", self.kind.as_ref(), KINDS);
        let title = text(&mut c, "title", self.title.as_ref(), Some(1), Some(TITLE_MAX));
        let body =
            optional(&self.body).and_then(|v| text(&mut c, "body", Some(v), None, Some(BODY_MAX)));
        let source =
            optional(&self.source).and_then(|v| one_of(&mut c, "source", Some(v), SOURCES));
        let reporter_name = optional(&self.reporter_name)
            .and_then(|v| text(&mut c, "reporterName", Some(v), None, Some(REPORTER_MAX)));
        let assignee_id = optional(&self.assignee_id)
            .and_then(|v| text(&mut c, "assigneeId", Some(v), None, None));
        let project_id =
            optional(&self.project_id).and_then(|v| text(&mut c, "projectId", Some(v), None, None));
        let parent_id =
            optional(&self.parent_id).and_then(|v| text(&mut c, "parentId", Some(v), None, None));
        let priority =
            optional(&self.priority).and_then(|v| one_of(&mut c, "priority", Some(v), PRIORITIES));
        let status_value = optional(&self.status).and_then(|v| status(&mut c, "status", Some(v)));
        let external_url = optional(&self.external_url)
            .and_then(|v| text(&mut c, "externalUrl", Some(v), None, Some(EXTERNAL_URL_MAX)));
        let thread =
            optional(&self.thread_url).and_then(|v| thread_url(&mut c, "threadUrl", Some(v)));
        let points = optional(&self.estimate).and_then(|v| estimate(&mut c, "estimate", Some(v)));
        let due_date = optional(&self.due_date).and_then(|v| date(&mut c, "dueDate", Some(v)));
        let labels = optional(&self.labels).map(|v| string_list(&mut c, "labels", Some(v), LABELS));
        c.finish()?;
        Ok(NewIssue {
            kind: kind.and_then(|k| IssueKind::parse(&k)).unwrap_or(IssueKind::Bug),
            title: title.unwrap_or_default(),
            body,
            source: source.and_then(|s| IssueSource::parse(&s)),
            reporter_name,
            // `null` is an explicit "nobody": the claim rule leaves it alone
            assignee_id: match self.assignee_id {
                Patch::Missing => None,
                Patch::Null => Some(None),
                Patch::Value(_) => Some(assignee_id),
            },
            project_id,
            parent_id,
            priority: priority.and_then(|p| Priority::parse(&p)),
            status: status_value,
            external_url,
            thread_url: thread,
            estimate: points,
            due_date,
            labels,
        })
    }
}

/// `PATCH /api/w/{slug}/tasks/{idOrKey}`: `null` clears the fields that can be cleared and is
/// refused on the others.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIssueDto {
    /// New title (1 to 300 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub title: Patch<Value>,
    /// New classification; the key stays.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub kind: Patch<Value>,
    /// Story points: non-negative number, `null` clears.
    #[serde(default)]
    #[schema(value_type = Option<f64>)]
    pub estimate: Patch<Value>,
    /// The day the task should be done (ISO 8601); `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub due_date: Patch<Value>,
    /// Description; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub body: Patch<Value>,
    /// Free-text reporter; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub reporter_name: Patch<Value>,
    /// Assignee; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub assignee_id: Patch<Value>,
    /// Project; `null` clears it and drops that project's milestone.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub project_id: Patch<Value>,
    /// Id or key of the parent issue; `null` makes this a root issue.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub parent_id: Patch<Value>,
    /// New priority.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub priority: Patch<Value>,
    /// New status: a seeded one or an id created in workspace settings (`st_…`).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub status: Patch<Value>,
    /// Link to the issue elsewhere; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub external_url: Patch<Value>,
    /// Link to the Delta thread; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub thread_url: Patch<Value>,
    /// At most one milestone per project, from the issue's project.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub milestone_ids: Patch<Value>,
    /// Id or key of the issue this duplicates; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub duplicate_of_id: Patch<Value>,
    /// Workspace label ids; replaces the whole list.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub labels: Patch<Value>,
}

/// A `@Clearable()` string field with optional length rules.
#[allow(clippy::option_option, reason = "absent, null and a value are three different requests")]
fn clearable_text(
    c: &mut Checks,
    field: &str,
    value: &Patch<Value>,
    max: Option<usize>,
) -> Option<Option<String>> {
    clearable(value).map(|v| v.and_then(|v| text(c, field, Some(v), None, max)))
}

impl UpdateIssueDto {
    /// The class-validator rules of `UpdateIssueDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<IssueInput, AppError> {
        let mut c = Checks::new();
        let title = not_null(&self.title)
            .and_then(|v| text(&mut c, "title", Some(v), Some(1), Some(TITLE_MAX)));
        let kind = not_null(&self.kind).and_then(|v| one_of(&mut c, "kind", Some(v), KINDS));
        let points = clearable(&self.estimate)
            .map(|v| v.and_then(|v| estimate(&mut c, "estimate", Some(v))));
        let due_date =
            clearable(&self.due_date).map(|v| v.and_then(|v| date(&mut c, "dueDate", Some(v))));
        let body = clearable_text(&mut c, "body", &self.body, Some(BODY_MAX));
        let reporter_name =
            clearable_text(&mut c, "reporterName", &self.reporter_name, Some(REPORTER_MAX));
        let assignee_id = clearable_text(&mut c, "assigneeId", &self.assignee_id, None);
        let project_id = clearable_text(&mut c, "projectId", &self.project_id, None);
        let parent_id = clearable_text(&mut c, "parentId", &self.parent_id, None);
        let priority =
            not_null(&self.priority).and_then(|v| one_of(&mut c, "priority", Some(v), PRIORITIES));
        let status_value = not_null(&self.status).and_then(|v| status(&mut c, "status", Some(v)));
        let external_url =
            clearable_text(&mut c, "externalUrl", &self.external_url, Some(EXTERNAL_URL_MAX));
        let thread = clearable(&self.thread_url)
            .map(|v| v.and_then(|v| thread_url(&mut c, "threadUrl", Some(v))));
        let milestone_ids = not_null(&self.milestone_ids)
            .map(|v| string_list(&mut c, "milestoneIds", Some(v), ListRules::default()));
        let duplicate_of_id = clearable_text(&mut c, "duplicateOfId", &self.duplicate_of_id, None);
        let labels = not_null(&self.labels).map(|v| string_list(&mut c, "labels", Some(v), LABELS));
        c.finish()?;
        Ok(IssueInput {
            title,
            kind: kind.and_then(|k| IssueKind::parse(&k)),
            estimate: points,
            due_date,
            body,
            reporter_name,
            assignee_id,
            project_id,
            parent_id,
            priority: priority.and_then(|p| Priority::parse(&p)),
            status: status_value,
            external_url,
            thread_url: thread,
            milestone_ids,
            duplicate_of_id,
            labels,
        })
    }
}

/// The `patch` of a bulk request (`BulkIssuePatchDto`): one change applied to every issue.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkIssuePatchDto {
    /// New status.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub status: Patch<Value>,
    /// New priority.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub priority: Patch<Value>,
    /// Assignee; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub assignee_id: Patch<Value>,
    /// Project; `null` clears it and drops that project's milestone.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub project_id: Patch<Value>,
    /// Labels to add (at most 20).
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub add_labels: Patch<Value>,
    /// Labels to remove (at most 20).
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub remove_labels: Patch<Value>,
}

impl BulkIssuePatchDto {
    /// The class-validator rules of `BulkIssuePatchDto`; messages name `patch.<field>`.
    fn validate(&self, c: &mut Checks) -> BulkIssuePatch {
        let status_value = not_null(&self.status).and_then(|v| status(c, "patch.status", Some(v)));
        let priority =
            not_null(&self.priority).and_then(|v| one_of(c, "patch.priority", Some(v), PRIORITIES));
        let assignee_id = clearable_text(c, "patch.assigneeId", &self.assignee_id, None);
        let project_id = clearable_text(c, "patch.projectId", &self.project_id, None);
        let add_labels =
            not_null(&self.add_labels).map(|v| string_list(c, "patch.addLabels", Some(v), LABELS));
        let remove_labels = not_null(&self.remove_labels)
            .map(|v| string_list(c, "patch.removeLabels", Some(v), LABELS));
        BulkIssuePatch {
            status: status_value,
            priority: priority.and_then(|p| Priority::parse(&p)),
            assignee_id,
            project_id,
            add_labels,
            remove_labels,
        }
    }
}

/// `ids` of a bulk request: 1 to 100 distinct ids or keys.
fn issue_refs(c: &mut Checks, value: Option<&Value>) -> Vec<String> {
    string_list(
        c,
        "ids",
        value,
        ListRules {
            each_max_len: Some(100),
            unique: true,
            max: Some(BULK_ISSUES_MAX),
            min: Some(1),
        },
    )
}

/// `POST /api/w/{slug}/tasks/bulk`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdateIssuesDto {
    /// Ids or keys of the issues to change (1 to 100, distinct).
    #[schema(value_type = Vec<String>)]
    pub ids: Option<Value>,
    /// The change applied to every issue; labels are added / removed, not replaced.
    #[schema(value_type = BulkIssuePatchDto)]
    pub patch: Option<Value>,
}

impl BulkUpdateIssuesDto {
    /// The class-validator rules of `BulkUpdateIssuesDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<(Vec<String>, BulkIssuePatch), AppError> {
        let mut c = Checks::new();
        let ids = issue_refs(&mut c, self.ids.as_ref());
        // `@IsDefined() @ValidateNested()`: a value that is not an object is refused by the
        // nested rule; absent and `null` by `IsDefined`
        let nested = match &self.patch {
            Some(Value::Object(map)) => Some(map),
            Some(_) => {
                c.check(false, "nested property patch must be either object or array");
                None
            }
            None => None,
        };
        c.check(self.patch.is_some(), "patch should not be null or undefined");
        let patch = nested.map_or_else(BulkIssuePatch::default, |map| {
            let dto: BulkIssuePatchDto =
                serde_json::from_value(Value::Object(map.clone())).unwrap_or_default();
            dto.validate(&mut c)
        });
        c.finish()?;
        Ok((ids, patch))
    }
}

/// `POST /api/w/{slug}/tasks/bulk-delete`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteIssuesDto {
    /// Ids or keys of the issues to delete (1 to 100, distinct).
    #[schema(value_type = Vec<String>)]
    pub ids: Option<Value>,
}

impl BulkDeleteIssuesDto {
    /// The class-validator rules of `BulkDeleteIssuesDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<Vec<String>, AppError> {
        let mut c = Checks::new();
        let ids = issue_refs(&mut c, self.ids.as_ref());
        c.finish()?;
        Ok(ids)
    }
}

/// The result of `POST /api/w/{slug}/tasks/bulk-delete`.
#[derive(Debug, serde::Serialize, ToSchema)]
pub struct BulkDeleteResult {
    /// Ids of the issues that were deleted, in the order of the request.
    pub deleted: Vec<String>,
}

// ───────────────────────────────────── query strings ─────────────────────────────────────

/// The values of each key of a raw query string, as Express (`querystring`) reads them: a
/// repeated key is an array.
fn query_values(raw: Option<&str>) -> Vec<(String, Vec<String>)> {
    let mut values: Vec<(String, Vec<String>)> = Vec::new();
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        match values.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(value.into_owned()),
            None => values.push((key.into_owned(), vec![value.into_owned()])),
        }
    }
    values
}

#[allow(clippy::option_option, reason = "absent, empty and a value are different queries")]
fn single<'a>(values: &'a [(String, Vec<String>)], name: &str) -> Option<Option<&'a str>> {
    values
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, list)| if let [one] = list.as_slice() { Some(one.as_str()) } else { None })
}

/// `ListIssueQuery`, for the documentation: every filter is optional.
#[derive(Clone, Debug, Default, IntoParams)]
#[into_params(parameter_in = Query)]
#[allow(dead_code)]
pub struct ListIssuesQuery {
    /// Only this kind.
    #[param(inline)]
    pub kind: Option<IssueKind>,
    /// A seeded status or an id created in workspace settings (`st_…`).
    pub status: Option<String>,
    /// Only issues of this assignee.
    #[param(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    /// Only issues of this project.
    #[param(rename = "projectId")]
    pub project_id: Option<String>,
    /// Only issues in this milestone.
    #[param(rename = "milestoneId")]
    pub milestone_id: Option<String>,
    /// Text in the title, key or an alias.
    pub q: Option<String>,
    /// Comma-separated priorities, e.g. `high,urgent`.
    pub priority: Option<String>,
    /// `true`: only issues still being worked on (backlog, todo, in progress, in review).
    pub open: Option<bool>,
    /// Newest first; at most this many (1-500).
    #[param(minimum = 1, maximum = 500)]
    pub limit: Option<u32>,
}

impl IssueFilter {
    /// Reads the raw query string the way Express, class-transformer and class-validator do: a
    /// repeated key is an array (not a string), `priority` is split on commas unless it is
    /// already an array, `open` accepts `true` and `false`, `limit` goes through `Number()`,
    /// unknown keys are dropped.
    ///
    /// # Errors
    ///
    /// 400 with every class-validator message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let values = query_values(raw);
        let mut c = Checks::new();

        let kind = single(&values, "kind").and_then(|v| {
            one_of(&mut c, "kind", v.map(|s| Value::String(s.to_owned())).as_ref(), KINDS)
        });
        let status_value = single(&values, "status").and_then(|v| {
            status(&mut c, "status", v.map(|s| Value::String(s.to_owned())).as_ref())
        });
        let mut string = |name: &str| {
            single(&values, name).and_then(|v| {
                c.check(v.is_some(), format!("{name} must be a string"));
                v.map(str::to_owned)
            })
        };
        let assignee_id = string("assigneeId");
        let project_id = string("projectId");
        let milestone_id = string("milestoneId");
        let q = string("q");

        // @IsOptional() @Transform(split) @IsArray() @IsIn(PRIORITIES, { each: true })
        let mut priority: Vec<Priority> = Vec::new();
        if let Some((_, list)) = values.iter().find(|(k, _)| k == "priority") {
            let names: Vec<&str> = match list.as_slice() {
                [one] => one.split(',').map(str::trim).filter(|s| !s.is_empty()).collect(),
                many => many.iter().map(String::as_str).collect(),
            };
            let parsed: Vec<Option<Priority>> = names.iter().map(|n| Priority::parse(n)).collect();
            c.check(
                parsed.iter().all(Option::is_some),
                format!(
                    "each value in priority must be one of the following values: {}",
                    PRIORITIES.join(", ")
                ),
            );
            priority = parsed.into_iter().flatten().collect();
        }

        // @IsOptional() @Transform(true/false) @IsBoolean()
        let open = single(&values, "open").and_then(|v| {
            let parsed = match v {
                Some("true") => Some(true),
                Some("false") => Some(false),
                _ => None,
            };
            c.check(parsed.is_some(), "open must be a boolean value");
            parsed
        });

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500), reported bottom-up
        let limit = single(&values, "limit").and_then(|v| {
            let n = v.and_then(js_number).unwrap_or(f64::NAN);
            c.check(n <= 500.0, "limit must not be greater than 500");
            c.check(n >= 1.0, "limit must not be less than 1");
            c.check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            (n.is_finite() && n.fract() == 0.0 && (1.0..=500.0).contains(&n)).then_some(n as u64)
        });
        c.finish()?;
        Ok(Self {
            kind: kind.and_then(|k| IssueKind::parse(&k)),
            status: status_value,
            assignee_id,
            project_id,
            milestone_id,
            q,
            priority,
            open: open.unwrap_or(false),
            limit,
        })
    }
}

/// The `format` of `GET /api/w/{slug}/tasks/{idOrKey}/context`.
#[derive(Clone, Debug, Default, IntoParams)]
#[into_params(parameter_in = Query)]
#[allow(dead_code)]
pub struct ContextQuery {
    /// `markdown` or `json`; by default the `Accept` header decides.
    pub format: Option<String>,
}

/// The `format` of a context request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextFormat {
    /// The briefing as markdown.
    Markdown,
    /// The issue, its plan summary and artifacts as JSON.
    Json,
}

impl ContextFormat {
    /// Reads `?format=`.
    ///
    /// # Errors
    ///
    /// 400 `format must be one of the following values: markdown, json`.
    pub fn parse(raw: Option<&str>) -> Result<Option<Self>, AppError> {
        let values = query_values(raw);
        let mut c = Checks::new();
        let format = single(&values, "format").and_then(|v| {
            one_of(
                &mut c,
                "format",
                v.map(|s| Value::String(s.to_owned())).as_ref(),
                &["markdown", "json"],
            )
        });
        c.finish()?;
        Ok(format.map(|f| if f == "markdown" { Self::Markdown } else { Self::Json }))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::*;

    fn create(body: &Value) -> Result<NewIssue, AppError> {
        serde_json::from_value::<CreateIssueDto>(body.clone()).unwrap().validate()
    }

    fn update(body: &Value) -> Result<IssueInput, AppError> {
        serde_json::from_value::<UpdateIssueDto>(body.clone()).unwrap().validate()
    }

    fn bulk(body: &Value) -> Result<(Vec<String>, BulkIssuePatch), AppError> {
        serde_json::from_value::<BulkUpdateIssuesDto>(body.clone()).unwrap().validate()
    }

    fn problems(err: &AppError) -> String {
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        err.to_string().trim_start_matches("400 Bad Request: ").to_owned()
    }

    #[test]
    fn create_accepts_the_documented_body() {
        let issue = create(&json!({
            "kind": "feature", "title": "Ship it", "body": "b", "source": "api",
            "reporterName": "Ana", "assigneeId": "usr_1", "projectId": "pj_1", "parentId": "BUG-1",
            "priority": "high", "status": "st_abc1", "externalUrl": "https://x.dev",
            "threadUrl": "https://delta.dev/t/1", "estimate": 3, "dueDate": "2026-12-02",
            "labels": ["lb_1"],
        }))
        .unwrap();
        assert_eq!(issue.kind, IssueKind::Feature);
        assert_eq!(issue.title, "Ship it");
        assert_eq!(issue.assignee_id, Some(Some("usr_1".to_owned())));
        assert_eq!(issue.status.as_deref(), Some("st_abc1"));
        assert_eq!(issue.due_date.map(|d| d.timestamp()), Some(1_796_169_600));
        assert_eq!(issue.labels, Some(vec!["lb_1".to_owned()]));
        // `@IsOptional()` lets null through; null assignee is an explicit nobody
        let issue =
            create(&json!({ "kind": "bug", "title": "t", "body": null, "assigneeId": null }))
                .unwrap();
        assert_eq!(issue.body, None);
        assert_eq!(issue.assignee_id, Some(None));
        assert_eq!(create(&json!({ "kind": "bug", "title": "t" })).unwrap().assignee_id, None);
    }

    #[test]
    fn create_reports_every_failed_rule_in_class_validator_order() {
        assert_eq!(
            problems(&create(&json!({})).unwrap_err()),
            "kind must be one of the following values: bug, feature, incident, tech_debt, feedback, idea, security; \
             title must be shorter than or equal to 300 characters; \
             title must be longer than or equal to 1 characters; title must be a string"
        );
        let text = problems(
            &create(&json!({
                "kind": "bug", "title": "t", "status": "nope", "priority": "x", "source": 1,
                "threadUrl": "ftp://x", "estimate": 1001, "dueDate": "tomorrow",
                "labels": vec!["a"; 21], "externalUrl": "x".repeat(501), "reporterName": 5,
            }))
            .unwrap_err(),
        );
        for message in [
            "source must be one of the following values: manual, github, gitlab, linear, email, api, agent",
            "reporterName must be shorter than or equal to 200 characters; reporterName must be a string",
            "priority must be one of the following values: none, low, medium, high, urgent",
            "status must match /^(draft|backlog|todo|in_progress|in_review|done|canceled|st_[a-z0-9]+)$/ regular expression",
            "externalUrl must be shorter than or equal to 500 characters",
            "threadUrl must be an http or https URL of at most 2048 characters",
            "estimate must not be greater than 1000",
            "dueDate must be a valid ISO 8601 date string",
            "labels must contain no more than 20 elements",
        ] {
            assert!(text.contains(message), "{message}\n{text}");
        }
        for bad in ["tomorrow", "12/02/2026", ""] {
            assert!(create(&json!({ "kind": "bug", "title": "t", "dueDate": bad })).is_err());
        }
        assert!(create(&json!({ "kind": "bug", "title": "t", "dueDate": 42 })).is_err());
        let text =
            problems(&create(&json!({ "kind": "bug", "title": "t", "labels": "x" })).unwrap_err());
        assert_eq!(text, "labels must contain no more than 20 elements; labels must be an array");
    }

    #[test]
    fn update_tells_absent_from_null_and_refuses_null_on_required_fields() {
        let patch = update(&json!({})).unwrap();
        assert_eq!(patch, IssueInput::default());
        let patch = update(&json!({
            "estimate": null, "dueDate": null, "body": null, "reporterName": null,
            "assigneeId": null, "projectId": null, "parentId": null, "externalUrl": null,
            "threadUrl": null, "duplicateOfId": null,
        }))
        .unwrap();
        assert_eq!(patch.estimate, Some(None));
        assert_eq!(patch.due_date, Some(None));
        assert_eq!(patch.assignee_id, Some(None));
        assert_eq!(patch.parent_id, Some(None));
        assert_eq!(patch.thread_url, Some(None));
        assert_eq!(patch.duplicate_of_id, Some(None));
        for field in ["title", "kind", "priority", "status", "milestoneIds", "labels"] {
            assert!(update(&json!({ field: null })).is_err(), "{field}");
        }
        assert_eq!(
            problems(&update(&json!({ "title": null })).unwrap_err()),
            "title must be shorter than or equal to 300 characters; \
             title must be longer than or equal to 1 characters; title must be a string"
        );
        let patch =
            update(&json!({ "dueDate": "2026-12-05T00:00:00.000Z", "milestoneIds": ["m"] }))
                .unwrap();
        assert_eq!(patch.due_date.flatten().map(|d| d.timestamp()), Some(1_796_428_800));
        assert_eq!(patch.milestone_ids, Some(vec!["m".to_owned()]));
        assert!(update(&json!({ "threadUrl": 12 })).is_err());
        assert!(update(&json!({ "threadUrl": "" })).is_err());
        assert!(update(&json!({ "threadUrl": " https://delta.dev/t/1" })).is_err());
    }

    #[test]
    fn bulk_accepts_a_well_formed_request_including_null_to_clear_a_field() {
        let (ids, patch) = bulk(&json!({
            "ids": ["BUG-1", "in_b"],
            "patch": { "status": "done", "assigneeId": null, "addLabels": ["lb_1"] },
        }))
        .unwrap();
        assert_eq!(ids, ["BUG-1", "in_b"]);
        assert_eq!(patch.status.as_deref(), Some("done"));
        assert_eq!(patch.assignee_id, Some(None));
        assert_eq!(patch.add_labels, Some(vec!["lb_1".to_owned()]));
    }

    #[test]
    fn bulk_requires_ids_and_a_patch_caps_the_batch_and_rejects_repeats() {
        assert!(bulk(&json!({ "patch": { "status": "done" } })).is_err());
        assert!(bulk(&json!({ "ids": [], "patch": { "status": "done" } })).is_err());
        let text = problems(&bulk(&json!({ "ids": ["in_a"] })).unwrap_err());
        assert_eq!(text, "patch should not be null or undefined");
        let many: Vec<String> = (0..=BULK_ISSUES_MAX).map(|i| format!("in_{i}")).collect();
        assert!(bulk(&json!({ "ids": many, "patch": { "status": "done" } })).is_err());
        let ok: Vec<String> = many.iter().take(BULK_ISSUES_MAX).cloned().collect();
        assert!(
            serde_json::from_value::<BulkDeleteIssuesDto>(json!({ "ids": ok }))
                .unwrap()
                .validate()
                .is_ok()
        );
        let repeated =
            serde_json::from_value::<BulkDeleteIssuesDto>(json!({ "ids": ["in_a", "in_a"] }))
                .unwrap()
                .validate();
        assert_eq!(problems(&repeated.unwrap_err()), "All ids's elements must be unique");
    }

    #[test]
    fn bulk_rejects_invalid_values_null_on_non_clearable_fields_and_non_string_ids() {
        for patch in [
            json!({ "status": "nope" }),
            json!({ "priority": null }),
            json!({ "addLabels": [1] }),
            json!({ "removeLabels": vec!["a"; 21] }),
        ] {
            assert!(bulk(&json!({ "ids": ["in_a"], "patch": patch })).is_err(), "{patch}");
        }
        let err = serde_json::from_value::<BulkDeleteIssuesDto>(json!({ "ids": [5] }))
            .unwrap()
            .validate()
            .unwrap_err();
        assert_eq!(
            problems(&err),
            "each value in ids must be shorter than or equal to 100 characters; each value in ids must be a string"
        );
        let text =
            problems(&bulk(&json!({ "ids": ["a"], "patch": { "status": "x" } })).unwrap_err());
        assert!(text.starts_with("patch.status must match"), "{text}");
        let text = problems(&bulk(&json!({ "ids": ["a"], "patch": "x" })).unwrap_err());
        assert_eq!(text, "nested property patch must be either object or array");
    }

    #[test]
    fn the_list_query_reads_every_filter() {
        let f = IssueFilter::parse(Some(
            "kind=bug&status=todo&assigneeId=u&projectId=p&milestoneId=m&q=a%20b&priority=high,%20urgent,&open=true&limit=2&x=1",
        ))
        .unwrap();
        assert_eq!(f.kind, Some(IssueKind::Bug));
        assert_eq!(f.status.as_deref(), Some("todo"));
        assert_eq!(f.q.as_deref(), Some("a b"));
        assert_eq!(f.priority, [Priority::High, Priority::Urgent]);
        assert!(f.open);
        assert_eq!(f.limit, Some(2));
        assert_eq!(IssueFilter::parse(None).unwrap(), IssueFilter::default());
        assert!(!IssueFilter::parse(Some("open=false&priority=low")).unwrap().open);
        assert_eq!(
            IssueFilter::parse(Some("priority=high&priority=low")).unwrap().priority,
            [Priority::High, Priority::Low]
        );
        assert!(IssueFilter::parse(Some("priority=")).unwrap().priority.is_empty());
    }

    #[test]
    fn the_list_query_validates_like_class_validator() {
        let message = |raw: &str| problems(&IssueFilter::parse(Some(raw)).unwrap_err());
        assert_eq!(
            message("limit=abc"),
            "limit must not be greater than 500; limit must not be less than 1; limit must be an integer number"
        );
        assert_eq!(message("limit=0"), "limit must not be less than 1");
        assert_eq!(message("limit=501"), "limit must not be greater than 500");
        assert_eq!(message("limit=1.5"), "limit must be an integer number");
        assert_eq!(
            message("priority=bogus"),
            "each value in priority must be one of the following values: none, low, medium, high, urgent"
        );
        assert_eq!(message("open=maybe"), "open must be a boolean value");
        assert_eq!(message("open=true&open=false"), "open must be a boolean value");
        assert_eq!(message("q=a&q=b"), "q must be a string");
        assert!(message("kind=nope").starts_with("kind must be one of the following values: bug,"));
        assert!(message("status=nope").starts_with("status must match"));
        assert_eq!(
            message("open=x&limit=0"),
            "open must be a boolean value; limit must not be less than 1"
        );
    }

    #[test]
    fn the_context_format_is_markdown_or_json() {
        assert_eq!(ContextFormat::parse(None).unwrap(), None);
        assert_eq!(
            ContextFormat::parse(Some("format=markdown")).unwrap(),
            Some(ContextFormat::Markdown)
        );
        assert_eq!(ContextFormat::parse(Some("format=json")).unwrap(), Some(ContextFormat::Json));
        let err = ContextFormat::parse(Some("format=html")).unwrap_err();
        assert_eq!(problems(&err), "format must be one of the following values: markdown, json");
    }
}
