//! Request bodies and the query string of the projects routes (the DTOs of
//! `projects.controller.ts`) and what they become once validated. Responses are
//! `trama_contracts::projects::Project`.
//!
//! The DTO fields keep the raw JSON so that a value of the wrong type is reported with
//! class-validator's messages (`name must be a string`) rather than serde's. The messages of one
//! field come in the order class-validator reports them (the decorator listed last first). Where
//! NestJS reports an icon `@Matches` failure with the pattern's source text, the port reports the
//! wording of the service (`icon must be a lucide icon name (kebab-case) or a single emoji`):
//! both are 400s for the same values.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use trama_contracts::common::{PROJECT_REPOSITORY_MAX, Priority};
use trama_core::AppError;
use trama_core::validation::{Checks, Patch, js_len};
use trama_milestones::dates;
use utoipa::{IntoParams, ToSchema};

use crate::icon::{PROJECT_ICON_MAX, is_project_icon};
use crate::service::{NewProject, ProjectFilter, ProjectPatch};

/// Longest project name.
pub const NAME_MAX: usize = 200;
/// Longest summary.
pub const SUMMARY_MAX: usize = 300;
/// Longest description.
pub const DESCRIPTION_MAX: usize = 20_000;
/// Most labels one project carries.
pub const LABELS_MAX: usize = 20;
/// Longest status or health value a filter names.
pub const FILTER_MAX: usize = 80;

const PRIORITIES: &[&str] = &["none", "urgent", "high", "medium", "low"];
const KEY_PATTERN: &str = "/^[A-Za-z][A-Za-z0-9]{0,3}$/";
const COLOR_PATTERN: &str = "/^#[0-9a-fA-F]{6}$/";
const ICON_MESSAGE: &str = "icon must be a lucide icon name (kebab-case) or a single emoji";
const DATE_MESSAGE: &str = " must be a valid ISO 8601 date string";

// ───────────────────────── rules, one per class-validator decorator ─────────────────────────

/// `PROJECT_KEY` of the controller: 1 to 4 alphanumerics, starting with a letter, either case.
fn is_key_input(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=4).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..].iter().all(u8::is_ascii_alphanumeric)
}

/// `COLOR` of the controller: `#rrggbb`, either case.
fn is_color_input(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// `@IsString() @MinLength(min)? @MaxLength(max)?`: the length rules also fail on a non-string.
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

/// `@IsString() @MaxLength(max) @Matches(pattern)`.
fn matched(
    c: &mut Checks,
    field: &str,
    value: Option<&Value>,
    max: Option<usize>,
    pattern: &str,
    ok: fn(&str) -> bool,
) -> Option<String> {
    let s = value.and_then(Value::as_str);
    c.check(s.is_some_and(ok), format!("{field} must match {pattern} regular expression"));
    if let Some(max) = max {
        c.check(
            s.is_some_and(|s| js_len(s) <= max),
            format!("{field} must be shorter than or equal to {max} characters"),
        );
    }
    c.check(s.is_some(), format!("{field} must be a string"));
    s.map(str::to_owned)
}

/// `@Matches(pattern)` alone (no `@IsString()`).
fn matches_only(
    c: &mut Checks,
    field: &str,
    value: Option<&Value>,
    pattern: &str,
    ok: fn(&str) -> bool,
) -> Option<String> {
    let s = value.and_then(Value::as_str);
    c.check(s.is_some_and(ok), format!("{field} must match {pattern} regular expression"));
    s.map(str::to_owned)
}

/// `@IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN)`; the `@Matches`
/// failure reports the service's wording.
fn icon(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<String> {
    let s = value.and_then(Value::as_str);
    c.check(s.is_some_and(is_project_icon), ICON_MESSAGE);
    c.check(
        s.is_some_and(|s| js_len(s) <= PROJECT_ICON_MAX),
        format!("{field} must be shorter than or equal to {PROJECT_ICON_MAX} characters"),
    );
    c.check(s.is_some(), format!("{field} must be a string"));
    s.map(str::to_owned)
}

/// `@IsIn(PRIORITIES)`.
fn priority(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<Priority> {
    let found = value.and_then(Value::as_str).filter(|s| PRIORITIES.contains(s));
    c.check(
        found.is_some(),
        format!("{field} must be one of the following values: {}", PRIORITIES.join(", ")),
    );
    found.and_then(Priority::parse)
}

/// `@IsISO8601()`, and a date JavaScript can read (`new Date(value)`).
fn date(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<DateTime<Utc>> {
    let parsed =
        value.and_then(Value::as_str).filter(|s| dates::is_iso8601(s)).and_then(dates::parse);
    c.check(parsed.is_some(), format!("{field}{DATE_MESSAGE}"));
    parsed
}

/// `@IsArray() @ArrayMaxSize(20) @IsString({ each: true })`.
fn label_ids(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<Vec<String>> {
    let list = value.and_then(Value::as_array);
    c.check(
        list.is_some_and(|l| l.iter().all(Value::is_string)),
        format!("each value in {field} must be a string"),
    );
    c.check(
        list.is_some_and(|l| l.len() <= LABELS_MAX),
        format!("{field} must contain no more than {LABELS_MAX} elements"),
    );
    c.check(list.is_some(), format!("{field} must be an array"));
    list.map(|l| l.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}

/// `POST /api/w/{slug}/projects`. Optional fields skip their rules when absent or `null`
/// (`@IsOptional()` / `@Clearable()`).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectDto {
    /// Display name (1 to 200 characters).
    #[schema(value_type = String)]
    pub name: Option<Value>,
    /// Project tag used as the prefix for issue keys (1 to 4 alphanumerics, starting with a
    /// letter; uppercased when stored).
    #[schema(value_type = Option<String>)]
    pub key: Option<Value>,
    /// One-line summary (at most 300 characters).
    #[schema(value_type = Option<String>)]
    pub summary: Option<Value>,
    /// Longer description (at most 20000 characters).
    #[schema(value_type = Option<String>)]
    pub description: Option<Value>,
    /// `#rrggbb`.
    #[schema(value_type = Option<String>)]
    pub color: Option<Value>,
    /// Lucide icon name (kebab-case) or a single emoji; at most 48 characters.
    #[schema(value_type = Option<String>)]
    pub icon: Option<Value>,
    /// Catalog id, or a legacy enum (at most 80 characters).
    #[schema(value_type = Option<String>)]
    pub status: Option<Value>,
    /// Health catalog id, or a legacy enum (at most 80 characters).
    #[schema(value_type = Option<String>)]
    pub health: Option<Value>,
    /// `none`, `urgent`, `high`, `medium` or `low`.
    #[schema(value_type = Option<String>)]
    pub priority: Option<Value>,
    /// Lead user id.
    #[schema(value_type = Option<String>)]
    pub lead_id: Option<Value>,
    /// One git repository: a URL or `owner/name` (at most 2048 characters).
    #[schema(value_type = Option<String>)]
    pub repository: Option<Value>,
    /// Workspace label ids (at most 20).
    #[schema(value_type = Option<Vec<String>>)]
    pub labels: Option<Value>,
    /// ISO 8601 start date.
    #[schema(value_type = Option<String>)]
    pub start_date: Option<Value>,
    /// ISO 8601 target date.
    #[schema(value_type = Option<String>)]
    pub target_date: Option<Value>,
}

impl CreateProjectDto {
    /// The class-validator rules of `CreateProjectDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewProject, AppError> {
        let Self {
            name,
            key,
            summary,
            description,
            color,
            icon: icon_value,
            status,
            health,
            priority: priority_value,
            lead_id,
            repository,
            labels,
            start_date,
            target_date,
        } = self;
        // absent and null both skip the rules of an optional field
        let is_set = |v: &Option<Value>| v.as_ref().is_some_and(|v| !v.is_null());
        let mut c = Checks::new();
        text(&mut c, "name", name.as_ref(), Some(1), Some(NAME_MAX));
        let key = if is_set(&key) {
            matched(&mut c, "key", key.as_ref(), Some(4), KEY_PATTERN, is_key_input)
        } else {
            None
        };
        let summary = if is_set(&summary) {
            text(&mut c, "summary", summary.as_ref(), None, Some(SUMMARY_MAX))
        } else {
            None
        };
        let description = if is_set(&description) {
            text(&mut c, "description", description.as_ref(), None, Some(DESCRIPTION_MAX))
        } else {
            None
        };
        let color = if is_set(&color) {
            matches_only(&mut c, "color", color.as_ref(), COLOR_PATTERN, is_color_input)
        } else {
            None
        };
        let icon =
            if is_set(&icon_value) { icon(&mut c, "icon", icon_value.as_ref()) } else { None };
        let status = if is_set(&status) {
            text(&mut c, "status", status.as_ref(), None, Some(FILTER_MAX))
        } else {
            None
        };
        let health = if is_set(&health) {
            text(&mut c, "health", health.as_ref(), None, Some(FILTER_MAX))
        } else {
            None
        };
        let priority_found = if is_set(&priority_value) {
            priority(&mut c, "priority", priority_value.as_ref())
        } else {
            None
        };
        let lead_id = if is_set(&lead_id) {
            text(&mut c, "leadId", lead_id.as_ref(), None, None)
        } else {
            None
        };
        let repository = if is_set(&repository) {
            text(&mut c, "repository", repository.as_ref(), None, Some(PROJECT_REPOSITORY_MAX))
        } else {
            None
        };
        let labels =
            if is_set(&labels) { label_ids(&mut c, "labels", labels.as_ref()) } else { None };
        let start_date =
            if is_set(&start_date) { date(&mut c, "startDate", start_date.as_ref()) } else { None };
        let target_date = if is_set(&target_date) {
            date(&mut c, "targetDate", target_date.as_ref())
        } else {
            None
        };
        c.finish()?;
        Ok(NewProject {
            name: name.as_ref().and_then(Value::as_str).unwrap_or_default().to_owned(),
            key,
            summary,
            description,
            color,
            icon,
            status,
            health,
            priority: priority_found,
            lead_id,
            repository,
            labels,
            start_date,
            target_date,
        })
    }
}

/// `PATCH /api/w/{slug}/projects/{id}`: `summary`, `description`, `icon`, `health`, `leadId`,
/// `repository`, `startDate` and `targetDate` accept `null` to clear them; the other fields
/// refuse it.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectDto {
    /// New name (1 to 200 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Patch<Value>,
    /// New project tag (1 to 4 alphanumerics, starting with a letter); re-keys the issues.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub key: Patch<Value>,
    /// New summary; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub summary: Patch<Value>,
    /// New description; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub description: Patch<Value>,
    /// New `#rrggbb` color.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub color: Patch<Value>,
    /// New icon; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub icon: Patch<Value>,
    /// New catalog id or legacy enum (at most 80 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub status: Patch<Value>,
    /// New health catalog id or legacy enum; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub health: Patch<Value>,
    /// `none`, `urgent`, `high`, `medium` or `low`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub priority: Patch<Value>,
    /// New lead user id; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub lead_id: Patch<Value>,
    /// New repository; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub repository: Patch<Value>,
    /// Workspace label ids; replaces the whole list.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub labels: Patch<Value>,
    /// New ISO 8601 start date; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub start_date: Patch<Value>,
    /// New ISO 8601 target date; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub target_date: Patch<Value>,
}

impl UpdateProjectDto {
    /// The class-validator rules of `UpdateProjectDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    #[allow(clippy::too_many_lines, reason = "one rule per field, in the order NestJS checks them")]
    pub fn validate(self) -> Result<ProjectPatch, AppError> {
        let Self {
            name,
            key,
            summary,
            description,
            color,
            icon: icon_patch,
            status,
            health,
            priority: priority_patch,
            lead_id,
            repository,
            labels,
            start_date,
            target_date,
        } = self;
        let mut c = Checks::new();
        // `@OptionalNotNull()`: absent is fine, `null` is validated (and fails)
        let name = match &name {
            Patch::Missing => None,
            Patch::Null => {
                text(&mut c, "name", None, Some(1), Some(NAME_MAX));
                None
            }
            Patch::Value(v) => text(&mut c, "name", Some(v), Some(1), Some(NAME_MAX)),
        };
        let key = match &key {
            Patch::Missing => None,
            Patch::Null => {
                matched(&mut c, "key", None, Some(4), KEY_PATTERN, is_key_input);
                None
            }
            Patch::Value(v) => matched(&mut c, "key", Some(v), Some(4), KEY_PATTERN, is_key_input),
        };
        // `@Clearable()`: absent and `null` skip the rules
        let clearable = |c: &mut Checks, field: &str, v: &Patch<Value>, max: Option<usize>| match v
        {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => text(c, field, Some(v), None, max).map(Some),
        };
        let summary = clearable(&mut c, "summary", &summary, Some(SUMMARY_MAX));
        let description = clearable(&mut c, "description", &description, Some(DESCRIPTION_MAX));
        let color = match &color {
            Patch::Missing => None,
            Patch::Null => {
                matches_only(&mut c, "color", None, COLOR_PATTERN, is_color_input);
                None
            }
            Patch::Value(v) => {
                matches_only(&mut c, "color", Some(v), COLOR_PATTERN, is_color_input)
            }
        };
        let icon = match &icon_patch {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => icon(&mut c, "icon", Some(v)).map(Some),
        };
        let status = match &status {
            Patch::Missing => None,
            Patch::Null => {
                text(&mut c, "status", None, None, Some(FILTER_MAX));
                None
            }
            Patch::Value(v) => text(&mut c, "status", Some(v), None, Some(FILTER_MAX)),
        };
        let health = clearable(&mut c, "health", &health, Some(FILTER_MAX));
        let priority = match &priority_patch {
            Patch::Missing => None,
            Patch::Null => {
                priority(&mut c, "priority", None);
                None
            }
            Patch::Value(v) => priority(&mut c, "priority", Some(v)),
        };
        let lead_id = clearable(&mut c, "leadId", &lead_id, None);
        let repository = clearable(&mut c, "repository", &repository, Some(PROJECT_REPOSITORY_MAX));
        let labels = match &labels {
            Patch::Missing => None,
            Patch::Null => {
                label_ids(&mut c, "labels", None);
                None
            }
            Patch::Value(v) => label_ids(&mut c, "labels", Some(v)),
        };
        let start_date = match &start_date {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => date(&mut c, "startDate", Some(v)).map(Some),
        };
        let target_date = match &target_date {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => date(&mut c, "targetDate", Some(v)).map(Some),
        };
        c.finish()?;
        Ok(ProjectPatch {
            name,
            key,
            summary,
            description,
            color,
            icon,
            status,
            health,
            priority,
            lead_id,
            repository,
            labels,
            start_date,
            target_date,
        })
    }
}

/// `GET /api/w/{slug}/projects`.
#[derive(Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListProjectsQuery {
    /// Only projects with this status (catalog id or legacy enum).
    pub status: Option<String>,
    /// Only projects with this health (catalog id or legacy enum).
    pub health: Option<String>,
    /// Only projects led by this user.
    pub lead_id: Option<String>,
    /// Substring of the name (case-insensitive).
    pub q: Option<String>,
}

impl ListProjectsQuery {
    /// Reads the raw query string; an empty value is the same as an absent one, as the service's
    /// `if (f.x)` treats it.
    ///
    /// # Errors
    ///
    /// 400 `<field> must be a string` when a key is repeated; 400 when `status` or `health` is
    /// longer than 80 characters.
    pub fn parse(raw: Option<&str>) -> Result<ProjectFilter, AppError> {
        let mut c = Checks::new();
        let mut query = ListProjectsQuery::default();
        for key in ["status", "health", "leadId", "q"] {
            let mut found = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned());
            let value = found.next();
            if found.next().is_some() {
                c.check(false, format!("{key} must be a string"));
            }
            let value = value.filter(|v| !v.is_empty());
            match key {
                "status" => {
                    if let Some(v) = &value {
                        c.max_length("status", v, FILTER_MAX);
                    }
                    query.status = value;
                }
                "health" => {
                    if let Some(v) = &value {
                        c.max_length("health", v, FILTER_MAX);
                    }
                    query.health = value;
                }
                "leadId" => query.lead_id = value,
                _ => query.q = value,
            }
        }
        c.finish()?;
        Ok(ProjectFilter {
            status: query.status,
            health: query.health,
            lead_id: query.lead_id,
            q: query.q,
        })
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::*;

    fn create(body: &Value) -> Result<NewProject, AppError> {
        serde_json::from_value::<CreateProjectDto>(body.clone()).unwrap().validate()
    }

    fn update(body: &Value) -> Result<ProjectPatch, AppError> {
        serde_json::from_value::<UpdateProjectDto>(body.clone()).unwrap().validate()
    }

    fn problems(err: &AppError) -> String {
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        err.to_string()
    }

    #[test]
    fn create_accepts_the_documented_body() {
        let p = create(&json!({
            "name": "Checkout v2", "key": "DLTA", "summary": "s", "description": "d",
            "color": "#10b981", "icon": "rocket", "status": "in_progress",
            "health": "at_risk", "priority": "high", "leadId": "usr_1",
            "repository": "acme/api", "labels": ["lb_1"],
            "startDate": "2026-12-01T00:00:00.000Z", "targetDate": "2026-12-15"
        }))
        .unwrap();
        assert_eq!(p.name, "Checkout v2");
        assert_eq!(p.key.as_deref(), Some("DLTA"));
        assert_eq!(p.color.as_deref(), Some("#10b981"));
        assert_eq!(p.priority, Some(Priority::High));
        assert_eq!(p.labels, Some(vec!["lb_1".to_owned()]));
        assert_eq!(p.start_date.map(|d| d.timestamp()), Some(1_796_083_200));
        assert_eq!(
            p.target_date.map(|d| d.to_string()),
            Some("2026-12-15 00:00:00 UTC".to_owned())
        );
        // optional fields let null through
        let p = create(&json!({ "name": "x", "key": null, "summary": null, "description": null,
            "color": null, "icon": null, "status": null, "health": null, "priority": null,
            "leadId": null, "repository": null, "labels": null,
            "startDate": null, "targetDate": null }))
        .unwrap();
        assert_eq!(p.key, None);
        assert_eq!(p.labels, None);
    }

    #[test]
    fn create_reports_every_failed_rule() {
        let text = problems(&create(&json!({})).unwrap_err());
        for message in [
            "name must be shorter than or equal to 200 characters",
            "name must be longer than or equal to 1 characters",
            "name must be a string",
        ] {
            assert!(text.contains(message), "{text}");
        }
        let text = problems(
            &create(&json!({
                "name": "x", "key": "abcde", "summary": "s".repeat(301),
                "description": "d".repeat(20_001), "color": "red",
                "icon": "Rocket", "status": 5, "health": "h".repeat(81),
                "priority": "asap", "repository": "r".repeat(2049),
                "labels": ["a", 1],
                "startDate": "tomorrow"
            }))
            .unwrap_err(),
        );
        for message in [
            "key must match /^[A-Za-z][A-Za-z0-9]{0,3}$/ regular expression",
            "summary must be shorter than or equal to 300 characters",
            "description must be shorter than or equal to 20000 characters",
            "color must match /^#[0-9a-fA-F]{6}$/ regular expression",
            "icon must be a lucide icon name (kebab-case) or a single emoji",
            "status must be a string",
            "health must be shorter than or equal to 80 characters",
            "priority must be one of the following values: none, urgent, high, medium, low",
            "repository must be shorter than or equal to 2048 characters",
            "each value in labels must be a string",
            "startDate must be a valid ISO 8601 date string",
        ] {
            assert!(text.contains(message), "{text}");
        }
        let text = problems(&create(&json!({ "name": "x", "labels": vec!["a"; 21] })).unwrap_err());
        assert!(text.contains("labels must contain no more than 20 elements"), "{text}");
        let text = problems(&create(&json!({ "name": "x", "labels": "a" })).unwrap_err());
        assert!(text.contains("labels must be an array"), "{text}");
    }

    #[test]
    fn update_tells_absent_null_and_values_apart() {
        let patch = update(&json!({})).unwrap();
        assert_eq!(patch, ProjectPatch::default());
        let patch = update(&json!({
            "summary": null, "description": null, "icon": null, "health": null,
            "leadId": null, "repository": null, "startDate": null, "targetDate": null
        }))
        .unwrap();
        assert_eq!(patch.summary, Some(None));
        assert_eq!(patch.description, Some(None));
        assert_eq!(patch.icon, Some(None));
        assert_eq!(patch.health, Some(None));
        assert_eq!(patch.lead_id, Some(None));
        assert_eq!(patch.repository, Some(None));
        assert_eq!(patch.start_date, Some(None));
        assert_eq!(patch.target_date, Some(None));
        let patch = update(&json!({
            "name": "B", "key": "TRMA", "color": "#000000", "icon": "🚀",
            "status": "completed", "health": "on_track", "priority": "low",
            "leadId": "usr_2", "repository": "acme/web", "labels": [],
            "startDate": "2026-12-01", "targetDate": "2026-12-15"
        }))
        .unwrap();
        assert_eq!(patch.name.as_deref(), Some("B"));
        assert_eq!(patch.key.as_deref(), Some("TRMA"));
        assert_eq!(patch.icon, Some(Some("🚀".to_owned())));
        assert_eq!(patch.labels, Some(Vec::new()));
        assert!(patch.start_date.flatten().is_some());
    }

    #[test]
    fn update_refuses_null_for_the_strict_fields() {
        let text = problems(
            &update(&json!({
                "name": null, "key": null, "color": null, "status": null,
                "priority": null, "labels": null
            }))
            .unwrap_err(),
        );
        for message in [
            "name must be a string",
            "key must be a string",
            "color must match /^#[0-9a-fA-F]{6}$/ regular expression",
            "status must be a string",
            "priority must be one of the following values: none, urgent, high, medium, low",
            "labels must be an array",
        ] {
            assert!(text.contains(message), "{text}");
        }
        for body in [
            json!({ "name": "" }),
            json!({ "key": "1ABC" }),
            json!({ "color": "green" }),
            json!({ "status": "s".repeat(81) }),
            json!({ "icon": "two words" }),
            json!({ "icon": 42 }),
            json!({ "summary": "s".repeat(301) }),
            json!({ "repository": "r".repeat(2049) }),
            json!({ "startDate": "soon" }),
            json!({ "labels": vec!["a"; 21] }),
        ] {
            assert!(update(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn query_reads_the_filters() {
        let f = ListProjectsQuery::parse(None).unwrap();
        assert_eq!(f, ProjectFilter::default());
        let f =
            ListProjectsQuery::parse(Some("status=backlog&health=at_risk&leadId=usr_1&q=web&x=1"))
                .unwrap();
        assert_eq!(f.status.as_deref(), Some("backlog"));
        assert_eq!(f.health.as_deref(), Some("at_risk"));
        assert_eq!(f.lead_id.as_deref(), Some("usr_1"));
        assert_eq!(f.q.as_deref(), Some("web"));
        // an empty value is the same as an absent one
        let f = ListProjectsQuery::parse(Some("status=")).unwrap();
        assert_eq!(f.status, None);
        assert!(ListProjectsQuery::parse(Some("status=a&status=b")).is_err());
        assert!(ListProjectsQuery::parse(Some("q=a&q=b")).is_err());
        assert!(ListProjectsQuery::parse(Some(&"health=h".repeat(81))).is_err());
    }
}
