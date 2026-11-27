//! Request bodies of the project update routes (the DTOs of `project-updates.controller.ts`).
//! Responses are `trama_contracts::projects::ProjectUpdate`.
//!
//! Like the project DTOs, the fields keep the raw JSON so that a value of the wrong type is
//! reported with class-validator's messages (`body must be a string`), the rule listed last
//! first.

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::projects::PROJECT_UPDATE_BODY_MAX;
use trama_core::AppError;
use trama_core::validation::{Checks, Patch};
use utoipa::ToSchema;

use super::service::UpdatePatch;
use crate::schemas::{FILTER_MAX, text};

/// What `POST /projects/{id}/updates` carries once validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewProjectUpdate {
    /// The text, as sent (trimmed by the service).
    pub body: String,
    /// Project health catalog id (or legacy enum) reported with the update.
    pub health: Option<String>,
}

/// `POST /api/w/{slug}/projects/{id}/updates` (`CreateProjectUpdateDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateProjectUpdateDto {
    /// Markdown, 1 to 20000 characters once trimmed.
    #[schema(value_type = String)]
    pub body: Option<Value>,
    /// A project health catalog id (at most 80 characters); also sets the project's health.
    #[schema(value_type = Option<String>)]
    pub health: Option<Value>,
}

impl CreateProjectUpdateDto {
    /// The class-validator rules of `CreateProjectUpdateDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewProjectUpdate, AppError> {
        let mut c = Checks::new();
        let body = text(&mut c, "body", self.body.as_ref(), None, Some(PROJECT_UPDATE_BODY_MAX));
        // `@IsOptional()`: absent and `null` skip the rules
        let health = if self.health.as_ref().is_some_and(|v| !v.is_null()) {
            text(&mut c, "health", self.health.as_ref(), None, Some(FILTER_MAX))
        } else {
            None
        };
        c.finish()?;
        Ok(NewProjectUpdate { body: body.unwrap_or_default(), health })
    }
}

/// `PATCH /api/w/{slug}/projects/{id}/updates/{updateId}` (`UpdateProjectUpdateDto`): `body`
/// refuses `null`, `health` accepts it to clear the health reported with the update.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateProjectUpdateDto {
    /// New text (at most 20000 characters; the service trims it and refuses an empty one).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub body: Patch<Value>,
    /// New reported health; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub health: Patch<Value>,
}

impl UpdateProjectUpdateDto {
    /// The class-validator rules of `UpdateProjectUpdateDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<UpdatePatch, AppError> {
        let mut c = Checks::new();
        // `@OptionalNotNull()`: absent is fine, `null` is validated (and fails)
        let body = match &self.body {
            Patch::Missing => None,
            Patch::Null => {
                text(&mut c, "body", None, None, Some(PROJECT_UPDATE_BODY_MAX));
                None
            }
            Patch::Value(v) => text(&mut c, "body", Some(v), None, Some(PROJECT_UPDATE_BODY_MAX)),
        };
        // `@Clearable()`: absent and `null` skip the rules
        let health = match &self.health {
            Patch::Missing => None,
            Patch::Null => Some(None),
            Patch::Value(v) => text(&mut c, "health", Some(v), None, Some(FILTER_MAX)).map(Some),
        };
        c.finish()?;
        Ok(UpdatePatch { body, health })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trama_core::AppError;

    use super::*;

    fn create(body: &Value) -> Result<NewProjectUpdate, AppError> {
        serde_json::from_value::<CreateProjectUpdateDto>(body.clone()).unwrap().validate()
    }

    fn update(body: &Value) -> Result<UpdatePatch, AppError> {
        serde_json::from_value::<UpdateProjectUpdateDto>(body.clone()).unwrap().validate()
    }

    fn message(error: &AppError) -> String {
        error.to_string()
    }

    #[test]
    fn create_needs_a_string_body_and_an_optional_string_health() {
        assert_eq!(
            create(&json!({ "body": "Hi", "health": null })).unwrap(),
            NewProjectUpdate { body: "Hi".into(), health: None }
        );
        assert_eq!(
            create(&json!({ "body": "Hi", "health": "at_risk" })).unwrap().health.as_deref(),
            Some("at_risk")
        );
        // whitespace passes the DTO; the service refuses it
        assert!(create(&json!({ "body": "  " })).is_ok());
        for bad in [
            json!({}),
            json!({ "body": 12 }),
            json!({ "body": null }),
            json!({ "body": "Hi", "health": 42 }),
            json!({ "body": "x".repeat(PROJECT_UPDATE_BODY_MAX + 1) }),
        ] {
            assert!(create(&bad).is_err(), "{bad}");
        }
        assert!(create(&json!({ "body": "x".repeat(PROJECT_UPDATE_BODY_MAX) })).is_ok());
        assert!(message(&create(&json!({})).unwrap_err()).contains("body must be a string"),);
    }

    #[test]
    fn update_distinguishes_absent_null_and_a_value() {
        assert_eq!(update(&json!({})).unwrap(), UpdatePatch::default());
        assert_eq!(
            update(&json!({ "body": "New", "health": null })).unwrap(),
            UpdatePatch { body: Some("New".into()), health: Some(None) }
        );
        assert_eq!(
            update(&json!({ "health": "on_track" })).unwrap(),
            UpdatePatch { body: None, health: Some(Some("on_track".into())) }
        );
        // `body` does not accept `null`
        assert!(update(&json!({ "body": null })).is_err());
        assert!(update(&json!({ "body": 3 })).is_err());
        assert!(update(&json!({ "health": 3 })).is_err());
        assert!(update(&json!({ "health": "x".repeat(81) })).is_err());
    }
}
