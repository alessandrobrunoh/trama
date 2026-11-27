//! Request and response bodies for the time-entry endpoints.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::threads::TimeEntrySource;
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_core::validation::{Checks, js_len};
use utoipa::{IntoParams, ToSchema};

use crate::service::{ManualTimeEntry, Target};

/// Shared target fields for starting or manually recording time.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TargetDto {
    /// Optional description, at most 500 characters.
    #[schema(value_type = Option<String>)]
    pub description: Option<Value>,
    /// Optional project id.
    #[schema(value_type = Option<String>)]
    pub project_id: Option<Value>,
    /// Optional issue id.
    #[schema(value_type = Option<String>)]
    pub issue_id: Option<Value>,
}

/// A manually recorded time interval.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManualTimeEntryDto {
    /// Optional description, at most 500 characters.
    #[schema(value_type = Option<String>)]
    pub description: Option<Value>,
    /// Optional project id.
    #[schema(value_type = Option<String>)]
    pub project_id: Option<Value>,
    /// Optional issue id.
    #[schema(value_type = Option<String>)]
    pub issue_id: Option<Value>,
    /// ISO 8601 interval start.
    #[schema(value_type = String)]
    pub started_at: Option<Value>,
    /// ISO 8601 interval end.
    #[schema(value_type = String)]
    pub ended_at: Option<Value>,
}

/// `GET /time-entries` (`ListTimeEntriesQuery`): `source` is optional.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListTimeEntriesQuery {
    /// Only entries of this source; without it suggestions are left out.
    #[param(inline)]
    pub source: Option<TimeEntrySource>,
}

impl ListTimeEntriesQuery {
    /// `@IsOptional() @IsIn(SOURCES) source`, from the raw query string. A repeated key is an
    /// array in Express and fails the check.
    ///
    /// # Errors
    ///
    /// 400 `source must be one of the following values: timer, manual, suggested`.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let values: Vec<String> = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
            .filter(|(key, _)| key == "source")
            .map(|(_, value)| value.into_owned())
            .collect();
        let mut c = Checks::new();
        let source = match values.as_slice() {
            [one] => TimeEntrySource::parse(one),
            _ => None,
        };
        if !values.is_empty() {
            let allowed: Vec<&str> = TimeEntrySource::ALL.iter().map(|s| s.as_str()).collect();
            c.check(
                source.is_some(),
                format!("source must be one of the following values: {}", allowed.join(", ")),
            );
        }
        c.finish()?;
        Ok(Self { source })
    }
}

/// The persisted time-entry wire representation (`TimeEntryEntity.toJSON()`: nulls are left
/// out).
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    /// Entry id.
    pub id: String,
    /// Workspace id.
    pub workspace_id: String,
    /// Owner user id.
    pub user_id: String,
    /// Project id, absent when none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Issue id, absent when none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    /// Description.
    pub description: String,
    /// Where the entry came from: `timer`, `manual`, or `suggested` by `trama sync` (it counts
    /// once its owner accepts it).
    pub source: TimeEntrySource,
    /// Start instant in ISO-8601 UTC form.
    pub started_at: String,
    /// End instant in ISO-8601 UTC form, absent while running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Creation instant.
    pub created_at: String,
    /// Last update instant.
    pub updated_at: String,
}

fn text(value: Option<&Value>, c: &mut Checks, field: &str, max: usize) -> Option<String> {
    if let Some(value) = value {
        let string = value.as_str();
        c.check(
            string.is_some_and(|s| js_len(s) <= max),
            format!("{field} must be shorter than or equal to {max} characters"),
        );
        c.check(string.is_some(), format!("{field} must be a string"));
        string.map(str::to_owned)
    } else {
        None
    }
}

fn optional_id(value: Option<&Value>, c: &mut Checks, field: &str) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(value) => {
            c.check(value.is_string(), format!("{field} must be a string"));
            value.as_str().map(str::to_owned)
        }
    }
}

fn timestamp(value: Option<&Value>, c: &mut Checks, field: &str) -> Option<DateTime<Utc>> {
    let parsed = value
        .and_then(Value::as_str)
        .filter(|s| trama_milestones::dates::is_iso8601(s))
        .and_then(trama_milestones::dates::parse);
    c.check(parsed.is_some(), format!("{field} must be a valid ISO 8601 date string"));
    parsed
}

impl TargetDto {
    /// Validates target DTO fields with NestJS class-validator wording.
    ///
    /// # Errors
    /// A 400 error containing each failed validation message.
    pub fn validate(self) -> Result<Target, AppError> {
        let mut c = Checks::new();
        let description = text(self.description.as_ref(), &mut c, "description", 500);
        let project_id = optional_id(self.project_id.as_ref(), &mut c, "projectId");
        let issue_id = optional_id(self.issue_id.as_ref(), &mut c, "issueId");
        c.finish()?;
        Ok(Target { description, project_id, issue_id })
    }
}

impl ManualTimeEntryDto {
    /// Validates a manually submitted entry.
    ///
    /// # Errors
    /// A 400 error containing each failed validation message.
    pub fn validate(self) -> Result<ManualTimeEntry, AppError> {
        let mut c = Checks::new();
        let description = text(self.description.as_ref(), &mut c, "description", 500);
        let project_id = optional_id(self.project_id.as_ref(), &mut c, "projectId");
        let issue_id = optional_id(self.issue_id.as_ref(), &mut c, "issueId");
        let started_at = timestamp(self.started_at.as_ref(), &mut c, "startedAt");
        let ended_at = timestamp(self.ended_at.as_ref(), &mut c, "endedAt");
        c.finish()?;
        Ok(ManualTimeEntry {
            target: Target { description, project_id, issue_id },
            started_at: started_at.ok_or_else(|| {
                AppError::bad_request("startedAt must be a valid ISO 8601 date string")
            })?,
            ended_at: ended_at.ok_or_else(|| {
                AppError::bad_request("endedAt must be a valid ISO 8601 date string")
            })?,
        })
    }
}

impl From<&trama_entities::time_entries::Model> for TimeEntry {
    fn from(row: &trama_entities::time_entries::Model) -> Self {
        Self {
            id: row.id.clone(),
            workspace_id: row.workspace_id.clone(),
            user_id: row.user_id.clone(),
            project_id: row.project_id.clone(),
            issue_id: row.issue_id.clone(),
            description: row.description.clone(),
            source: TimeEntrySource::parse(&row.source).unwrap_or(TimeEntrySource::Manual),
            started_at: to_iso(&row.started_at),
            ended_at: row.ended_at.as_ref().map(to_iso),
            created_at: to_iso(&row.created_at),
            updated_at: to_iso(&row.updated_at),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn target_validation_matches_optional_fields_and_limits() {
        let target: Target = serde_json::from_value::<TargetDto>(json!({
            "description": null, "projectId": null, "issueId": "in_1", "unknown": true
        }))
        .unwrap()
        .validate()
        .unwrap();
        assert_eq!(target.description, None);
        assert_eq!(target.project_id, None);
        assert_eq!(target.issue_id.as_deref(), Some("in_1"));

        let invalid: TargetDto = serde_json::from_value(json!({ "description": 3 })).unwrap();
        let error = invalid.validate().unwrap_err().to_string();
        assert!(error.contains("description must be a string"), "{error}");
        let invalid: TargetDto =
            serde_json::from_value(json!({ "description": "x".repeat(501) })).unwrap();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn manual_entry_validates_dates_and_preserves_instants() {
        let input: ManualTimeEntryDto = serde_json::from_value(json!({
            "startedAt": "2026-10-28T10:00:00.000Z",
            "endedAt": "2026-10-28T12:00:00+02:00",
            "description": "  focused  "
        }))
        .unwrap();
        let value = input.validate().unwrap();
        assert_eq!(value.started_at, value.ended_at);
        assert_eq!(value.target.description.as_deref(), Some("  focused  "));

        let invalid: ManualTimeEntryDto =
            serde_json::from_value(json!({ "startedAt": "tomorrow", "endedAt": "2026-10-28" }))
                .unwrap();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn wire_format_uses_camel_case_and_leaves_out_nulls() {
        let row = TimeEntry {
            id: "te_1".into(),
            workspace_id: "ws_1".into(),
            user_id: "usr_1".into(),
            project_id: None,
            issue_id: None,
            description: String::new(),
            source: TimeEntrySource::Suggested,
            started_at: "2026-10-28T10:00:00.000Z".into(),
            ended_at: None,
            created_at: "2026-10-28T10:00:00.000Z".into(),
            updated_at: "2026-10-28T10:00:00.000Z".into(),
        };
        let value = serde_json::to_value(row).unwrap();
        assert_eq!(value["workspaceId"], "ws_1");
        assert_eq!(value["source"], "suggested");
        assert!(value.get("started_at").is_none());
        assert!(value.get("endedAt").is_none());
        assert!(value.get("projectId").is_none());
        assert!(value.get("issueId").is_none());
    }

    #[test]
    fn the_list_query_accepts_a_source_and_refuses_anything_else() {
        let parse = |raw: Option<&str>| ListTimeEntriesQuery::parse(raw);
        assert_eq!(parse(None).unwrap().source, None);
        assert_eq!(parse(Some("")).unwrap().source, None);
        assert_eq!(parse(Some("other=1")).unwrap().source, None);
        assert_eq!(
            parse(Some("source=suggested")).unwrap().source,
            Some(TimeEntrySource::Suggested)
        );
        assert_eq!(parse(Some("source=timer")).unwrap().source, Some(TimeEntrySource::Timer));
        for bad in ["source=", "source=nope", "source=timer&source=manual"] {
            assert_eq!(
                parse(Some(bad)).unwrap_err().to_string(),
                "400 Bad Request: source must be one of the following values: timer, manual, suggested",
                "{bad}"
            );
        }
    }
}
