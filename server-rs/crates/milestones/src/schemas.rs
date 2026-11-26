//! Request bodies of the milestones routes (the DTOs of `milestones.controller.ts`) and what
//! they become once validated. Responses are `trama_contracts::projects::Milestone`.
//!
//! The DTO fields keep the raw JSON so that a value of the wrong type is reported with
//! class-validator's messages (`name must be a string`) rather than serde's. Messages of one
//! field come in the order class-validator reports them: the decorator nearest the property
//! last.

use serde::Deserialize;
use serde_json::Value;
use trama_core::AppError;
use trama_core::validation::{Checks, Patch, js_len};
use utoipa::{IntoParams, ToSchema};

use crate::dates;
use crate::service::{MilestonePatch, NewMilestone};

/// Longest milestone name.
pub const NAME_MAX: usize = 200;
/// Longest milestone description.
pub const DESCRIPTION_MAX: usize = 20_000;
/// Most ids a reorder may list.
pub const REORDER_MAX: usize = 500;

const DATE_MESSAGE: &str = "targetDate must be a valid ISO 8601 date string";

/// `POST /api/w/{slug}/milestones`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMilestoneDto {
    /// Project the milestone belongs to.
    #[schema(value_type = String)]
    pub project_id: Option<Value>,
    /// Display name (1 to 200 characters).
    #[schema(value_type = String)]
    pub name: Option<Value>,
    /// Description (at most 20000 characters).
    #[schema(value_type = Option<String>)]
    pub description: Option<Value>,
    /// ISO 8601 target date.
    #[schema(value_type = Option<String>)]
    pub target_date: Option<Value>,
    /// Position inside the project (0 or more); defaults to after the last milestone.
    #[schema(value_type = Option<f64>)]
    pub sort_order: Option<Value>,
}

/// `PATCH /api/w/{slug}/milestones/{id}`: `description` and `targetDate` accept `null` to clear
/// them; the other fields refuse it.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMilestoneDto {
    /// New name (1 to 200 characters).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Patch<Value>,
    /// New description; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub description: Patch<Value>,
    /// New target date; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub target_date: Patch<Value>,
    /// New position (0 or more).
    #[serde(default)]
    #[schema(value_type = Option<f64>)]
    pub sort_order: Patch<Value>,
}

/// `POST /api/w/{slug}/milestones/reorder`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReorderMilestonesDto {
    /// Project whose milestones are reordered.
    #[schema(value_type = String)]
    pub project_id: Option<Value>,
    /// Milestone ids in their new order (at most 500).
    #[schema(value_type = Vec<String>)]
    pub ids: Option<Value>,
}

/// `GET /api/w/{slug}/milestones`.
#[derive(Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListMilestonesQuery {
    /// Only the milestones of this project.
    pub project_id: Option<String>,
}

impl ListMilestonesQuery {
    /// Reads the raw query string.
    ///
    /// # Errors
    ///
    /// 400 `projectId must be a string` when the key is repeated.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut found = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
            .filter(|(key, _)| key == "projectId")
            .map(|(_, value)| value.into_owned());
        let project_id = found.next();
        if found.next().is_some() {
            return Err(AppError::validation(vec!["projectId must be a string".to_owned()]));
        }
        Ok(Self { project_id })
    }
}

/// `@IsString() @MinLength(min)? @MaxLength(max)`.
fn text(c: &mut Checks, field: &str, value: Option<&Value>, min: Option<usize>, max: usize) {
    let s = value.and_then(Value::as_str);
    c.check(
        s.is_some_and(|s| js_len(s) <= max),
        format!("{field} must be shorter than or equal to {max} characters"),
    );
    if let Some(min) = min {
        c.check(
            s.is_some_and(|s| js_len(s) >= min),
            format!("{field} must be longer than or equal to {min} characters"),
        );
    }
    c.check(s.is_some(), format!("{field} must be a string"));
}

/// `@IsNumber() @Min(0)`.
fn non_negative(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<f64> {
    let n = value.and_then(Value::as_f64);
    c.check(n.is_some_and(|n| n >= 0.0), format!("{field} must not be less than 0"));
    c.check(
        n.is_some(),
        format!("{field} must be a number conforming to the specified constraints"),
    );
    n
}

/// `@IsISO8601()`, and a date JavaScript can read.
fn date(c: &mut Checks, value: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    let parsed = value.as_str().filter(|s| dates::is_iso8601(s)).and_then(dates::parse);
    c.check(parsed.is_some(), DATE_MESSAGE);
    parsed
}

fn string_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

impl CreateMilestoneDto {
    /// The class-validator rules of `CreateMilestoneDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewMilestone, AppError> {
        let mut c = Checks::new();
        c.check(
            self.project_id.as_ref().is_some_and(Value::is_string),
            "projectId must be a string",
        );
        text(&mut c, "name", self.name.as_ref(), Some(1), NAME_MAX);
        if let Some(v) = &self.description {
            text(&mut c, "description", Some(v), None, DESCRIPTION_MAX);
        }
        let target_date = self.target_date.as_ref().and_then(|v| date(&mut c, v));
        let sort_order = match &self.sort_order {
            Some(v) => non_negative(&mut c, "sortOrder", Some(v)),
            None => None,
        };
        c.finish()?;
        Ok(NewMilestone {
            project_id: string_of(self.project_id.as_ref()),
            name: string_of(self.name.as_ref()),
            description: self.description.as_ref().map(|v| string_of(Some(v))),
            target_date,
            sort_order,
        })
    }
}

impl UpdateMilestoneDto {
    /// The class-validator rules of `UpdateMilestoneDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<MilestonePatch, AppError> {
        let mut c = Checks::new();
        // `@OptionalNotNull()`: absent is fine, `null` is validated (and fails)
        let name = match &self.name {
            Patch::Missing => None,
            Patch::Null => {
                text(&mut c, "name", None, Some(1), NAME_MAX);
                None
            }
            Patch::Value(v) => {
                text(&mut c, "name", Some(v), Some(1), NAME_MAX);
                v.as_str().map(str::to_owned)
            }
        };
        // `@Clearable()`: absent and `null` skip the rules
        let description = match &self.description {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => {
                text(&mut c, "description", Some(v), None, DESCRIPTION_MAX);
                Some(Some(string_of(Some(v))))
            }
        };
        let target_date = match &self.target_date {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => Some(date(&mut c, v)),
        };
        let sort_order = match &self.sort_order {
            Patch::Missing => None,
            Patch::Null => {
                non_negative(&mut c, "sortOrder", None);
                None
            }
            Patch::Value(v) => non_negative(&mut c, "sortOrder", Some(v)),
        };
        c.finish()?;
        Ok(MilestonePatch { name, description, target_date, sort_order })
    }
}

impl ReorderMilestonesDto {
    /// The class-validator rules of `ReorderMilestonesDto`: the project id and the ids.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<(String, Vec<String>), AppError> {
        let mut c = Checks::new();
        c.check(
            self.project_id.as_ref().is_some_and(Value::is_string),
            "projectId must be a string",
        );
        let list = self.ids.as_ref().and_then(Value::as_array);
        c.check(
            list.is_some_and(|l| l.iter().all(Value::is_string)),
            "each value in ids must be a string",
        );
        c.check(
            list.is_some_and(|l| l.len() <= REORDER_MAX),
            format!("ids must contain no more than {REORDER_MAX} elements"),
        );
        c.check(list.is_some(), "ids must be an array");
        c.finish()?;
        let ids = list.into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        Ok((string_of(self.project_id.as_ref()), ids))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::*;

    fn create(body: &Value) -> Result<NewMilestone, AppError> {
        serde_json::from_value::<CreateMilestoneDto>(body.clone()).unwrap().validate()
    }

    fn update(body: &Value) -> Result<MilestonePatch, AppError> {
        serde_json::from_value::<UpdateMilestoneDto>(body.clone()).unwrap().validate()
    }

    fn problems(err: &AppError) -> String {
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        err.to_string()
    }

    #[test]
    fn create_accepts_the_documented_body() {
        let m = create(&json!({
            "projectId": "pj_1", "name": "Alpha", "description": "d",
            "targetDate": "2026-12-01T00:00:00.000Z", "sortOrder": 2
        }))
        .unwrap();
        assert_eq!(m.project_id, "pj_1");
        assert_eq!(m.name, "Alpha");
        assert_eq!(m.description.as_deref(), Some("d"));
        assert_eq!(m.target_date.map(|d| d.timestamp()), Some(1_796_083_200));
        assert_eq!(m.sort_order, Some(2.0));
        // `@IsOptional()` lets null through
        let m = create(&json!({ "projectId": "p", "name": "x", "description": null,
            "targetDate": null, "sortOrder": null }))
        .unwrap();
        assert!(m.description.is_none() && m.target_date.is_none() && m.sort_order.is_none());
    }

    #[test]
    fn create_reports_every_failed_rule() {
        let text = problems(&create(&json!({})).unwrap_err());
        for message in [
            "projectId must be a string",
            "name must be shorter than or equal to 200 characters",
            "name must be longer than or equal to 1 characters",
            "name must be a string",
        ] {
            assert!(text.contains(message), "{text}");
        }
        let text = problems(
            &create(&json!({
                "projectId": 3, "name": "", "description": "x".repeat(20_001),
                "targetDate": "tomorrow", "sortOrder": -1
            }))
            .unwrap_err(),
        );
        for message in [
            "projectId must be a string",
            "name must be longer than or equal to 1 characters",
            "description must be shorter than or equal to 20000 characters",
            "targetDate must be a valid ISO 8601 date string",
            "sortOrder must not be less than 0",
        ] {
            assert!(text.contains(message), "{text}");
        }
        let text = problems(
            &create(&json!({ "projectId": "p", "name": "x",
            "sortOrder": "1", "targetDate": 5, "description": 1 }))
            .unwrap_err(),
        );
        assert!(
            text.contains("sortOrder must be a number conforming to the specified constraints")
        );
        assert!(text.contains("targetDate must be a valid ISO 8601 date string"));
        assert!(text.contains("description must be a string"));
        assert!(create(&json!({ "projectId": "p", "name": "x".repeat(201) })).is_err());
    }

    #[test]
    fn update_tells_absent_null_and_values_apart() {
        let patch = update(&json!({})).unwrap();
        assert_eq!(patch, MilestonePatch::default());
        let patch = update(&json!({ "description": null, "targetDate": null })).unwrap();
        assert_eq!(patch.description, Some(None));
        assert_eq!(patch.target_date, Some(None));
        let patch = update(&json!({ "name": "B", "sortOrder": 0, "description": "d",
            "targetDate": "2026-12-15" }))
        .unwrap();
        assert_eq!(patch.name.as_deref(), Some("B"));
        assert_eq!(patch.sort_order, Some(0.0));
        assert_eq!(patch.description, Some(Some("d".to_owned())));
        assert!(patch.target_date.flatten().is_some());
    }

    #[test]
    fn update_refuses_null_for_name_and_sort_order() {
        let text = problems(&update(&json!({ "name": null, "sortOrder": null })).unwrap_err());
        assert!(text.contains("name must be a string"), "{text}");
        assert!(text.contains("sortOrder must not be less than 0"), "{text}");
        assert!(update(&json!({ "name": "" })).is_err());
        assert!(update(&json!({ "sortOrder": -0.5 })).is_err());
        assert!(update(&json!({ "targetDate": "not a date" })).is_err());
        assert!(update(&json!({ "description": "x".repeat(20_001) })).is_err());
    }

    #[test]
    fn reorder_checks_the_ids() {
        let ok = |body: Value| serde_json::from_value::<ReorderMilestonesDto>(body).unwrap();
        let (project, ids) =
            ok(json!({ "projectId": "pj", "ids": ["a", "b"] })).validate().unwrap();
        assert_eq!((project.as_str(), ids), ("pj", vec!["a".to_owned(), "b".to_owned()]));
        for body in [
            json!({ "ids": [] }),
            json!({ "projectId": "pj" }),
            json!({ "projectId": "pj", "ids": "a" }),
            json!({ "projectId": "pj", "ids": ["a", 1] }),
            json!({ "projectId": "pj", "ids": vec!["a"; 501] }),
        ] {
            assert!(ok(body.clone()).validate().is_err(), "{body}");
        }
        assert!(ok(json!({ "projectId": "pj", "ids": vec!["a"; 500] })).validate().is_ok());
    }

    #[test]
    fn query_reads_the_project_id() {
        assert_eq!(ListMilestonesQuery::parse(None).unwrap().project_id, None);
        assert_eq!(
            ListMilestonesQuery::parse(Some("projectId=pj_1&x=1")).unwrap().project_id.as_deref(),
            Some("pj_1")
        );
        assert!(ListMilestonesQuery::parse(Some("projectId=a&projectId=b")).is_err());
    }
}
