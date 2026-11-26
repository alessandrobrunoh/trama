//! Request bodies of the sharing routes and the wire form of a moved project.

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::common::Priority;
use trama_contracts::projects::Project;
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_core::validation::{Checks, Patch, js_len};
use trama_entities::projects;
use utoipa::ToSchema;

/// Longest workspace id or slug the DTOs accept.
const TARGET_MAX: usize = 80;

/// `@IsString() @MinLength(1) @MaxLength(80)` on `field`, reported in class-validator's order
/// (the decorators run bottom-up).
fn short_text(c: &mut Checks, field: &str, value: Option<&Value>) {
    let text = value.and_then(Value::as_str);
    c.check(
        text.is_some_and(|s| js_len(s) <= TARGET_MAX),
        format!("{field} must be shorter than or equal to {TARGET_MAX} characters"),
    );
    c.check(
        text.is_some_and(|s| js_len(s) >= 1),
        format!("{field} must be longer than or equal to 1 characters"),
    );
    c.check(text.is_some(), format!("{field} must be a string"));
}

/// `PUT /shared/projects/:projectId/placement` (`PlaceProjectDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaceProjectBody {
    /// The workspace to show the project in, or `null` to hide it from Shared with me.
    #[serde(default)]
    #[schema(value_type = Option<String>, min_length = 1, max_length = 80)]
    pub workspace_id: Patch<Value>,
    /// Order inside that workspace's list; defaults to the end. 0..=100000.
    #[schema(value_type = Option<i32>, minimum = 0, maximum = 100_000)]
    pub position: Option<Value>,
}

/// Where a [`PlaceProjectBody`] puts the project.
#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    /// `workspaceId: null`: hidden from Shared with me.
    Hidden,
    /// Shown in one of the caller's workspaces.
    In {
        /// Workspace id.
        workspace_id: String,
        /// Explicit order, if sent.
        position: Option<i32>,
    },
}

impl PlaceProjectBody {
    /// `PlaceProjectDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<Placement, AppError> {
        let mut c = Checks::new();
        // `@ValidateIf(value !== null)`: a null skips every rule of the property
        let workspace_id = match &self.workspace_id {
            Patch::Null => None,
            Patch::Missing => {
                short_text(&mut c, "workspaceId", None);
                None
            }
            Patch::Value(value) => {
                short_text(&mut c, "workspaceId", Some(value));
                value.as_str().map(ToOwned::to_owned)
            }
        };
        // `@IsOptional() @IsInt() @Min(0) @Max(100_000)`
        let mut position = None;
        if let Some(value) = self.position.as_ref().filter(|v| !v.is_null()) {
            let number = value.as_f64();
            c.check(
                number.is_some_and(|n| n <= 100_000.0),
                "position must not be greater than 100000",
            );
            c.check(number.is_some_and(|n| n >= 0.0), "position must not be less than 0");
            c.check(number.is_some_and(|n| n.fract() == 0.0), "position must be an integer number");
            #[allow(clippy::cast_possible_truncation)]
            if let Some(n) = number.filter(|n| (0.0..=100_000.0).contains(n) && n.fract() == 0.0) {
                position = Some(n as i32);
            }
        }
        c.finish()?;
        Ok(workspace_id
            .map_or(Placement::Hidden, |workspace_id| Placement::In { workspace_id, position }))
    }
}

/// `POST /w/:slug/projects/:id/transfer` (`TransferProjectDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct TransferProjectBody {
    /// Slug of the workspace to move the project to.
    #[schema(value_type = String, min_length = 1, max_length = 80)]
    pub target: Option<Value>,
}

impl TransferProjectBody {
    /// `TransferProjectDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<String, AppError> {
        let mut c = Checks::new();
        short_text(&mut c, "target", self.target.as_ref());
        c.finish()?;
        Ok(self.target.and_then(|v| v.as_str().map(ToOwned::to_owned)).unwrap_or_default())
    }
}

/// `target` of `GET /w/:slug/projects/:id/transfer-preview` (`TransferTargetQuery`), read the way
/// Express and class-validator do: a repeated key is an array, which is not a string.
///
/// # Errors
///
/// 400 listing every failed rule.
pub fn parse_target_query(raw: Option<&str>) -> Result<String, AppError> {
    let mut values: Vec<String> = Vec::new();
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        if key == "target" {
            values.push(value.into_owned());
        }
    }
    let mut c = Checks::new();
    let single = (values.len() == 1).then(|| Value::String(values[0].clone()));
    short_text(&mut c, "target", single.as_ref());
    c.finish()?;
    Ok(values.remove(0))
}

/// A project row as every project route returns it (`Wire.toJSON`: nulls left out).
#[must_use]
pub fn project_wire(row: &projects::Model) -> Project {
    Project {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        name: row.name.clone(),
        key: row.key.clone(),
        summary: row.summary.clone(),
        description: row.description.clone(),
        color: row.color.clone(),
        icon: row.icon.clone(),
        status: row.status.clone(),
        health: row.health.clone(),
        priority: Priority::parse(&row.priority).unwrap_or(Priority::None),
        lead_id: row.lead_id.clone(),
        repository: row.repository.clone(),
        labels: row
            .labels
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
            .unwrap_or_default(),
        start_date: row.start_date.as_ref().map(to_iso),
        target_date: row.target_date.as_ref().map(to_iso),
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
        completed_at: row.completed_at.as_ref().map(to_iso),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body(value: &Value) -> PlaceProjectBody {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn problem(value: &Value) -> String {
        body(value).validate().unwrap_err().to_string()
    }

    #[test]
    fn a_workspace_places_and_null_hides() {
        assert_eq!(
            body(&json!({ "workspaceId": "ws_1", "position": 3 })).validate().unwrap(),
            Placement::In { workspace_id: "ws_1".into(), position: Some(3) }
        );
        assert_eq!(
            body(&json!({ "workspaceId": "ws_1", "position": null })).validate().unwrap(),
            Placement::In { workspace_id: "ws_1".into(), position: None }
        );
        assert_eq!(body(&json!({ "workspaceId": null })).validate().unwrap(), Placement::Hidden);
        // a null workspace skips every rule of that property only
        assert_eq!(
            problem(&json!({ "workspaceId": null, "position": -1 })),
            "400 Bad Request: position must not be less than 0"
        );
    }

    #[test]
    fn workspace_id_is_required_and_bounded() {
        let all = "workspaceId must be shorter than or equal to 80 characters; workspaceId must be longer than or equal to 1 characters; workspaceId must be a string";
        assert!(problem(&json!({})).ends_with(all));
        assert!(problem(&json!({ "workspaceId": 5 })).ends_with(all));
        assert_eq!(
            problem(&json!({ "workspaceId": "" })),
            "400 Bad Request: workspaceId must be longer than or equal to 1 characters"
        );
        assert_eq!(
            problem(&json!({ "workspaceId": "a".repeat(81) })),
            "400 Bad Request: workspaceId must be shorter than or equal to 80 characters"
        );
    }

    #[test]
    fn position_is_a_bounded_integer() {
        let with =
            |position: Value| problem(&json!({ "workspaceId": "ws_1", "position": position }));
        assert_eq!(with(json!(-1)), "400 Bad Request: position must not be less than 0");
        assert_eq!(
            with(json!(100_001)),
            "400 Bad Request: position must not be greater than 100000"
        );
        assert_eq!(with(json!(1.5)), "400 Bad Request: position must be an integer number");
        assert_eq!(
            with(json!("2")),
            "400 Bad Request: position must not be greater than 100000; position must not be less than 0; position must be an integer number"
        );
        assert!(body(&json!({ "workspaceId": "ws_1", "position": 100_000 })).validate().is_ok());
        assert!(body(&json!({ "workspaceId": "ws_1", "position": 0 })).validate().is_ok());
    }

    #[test]
    fn the_transfer_target_is_a_short_string() {
        let parse =
            |value: Value| serde_json::from_value::<TransferProjectBody>(value).unwrap().validate();
        assert_eq!(parse(json!({ "target": "acme" })).unwrap(), "acme");
        assert!(parse(json!({})).is_err());
        assert!(parse(json!({ "target": "" })).is_err());
        assert!(parse(json!({ "target": 1 })).is_err());
    }

    #[test]
    fn the_preview_target_comes_from_the_query_string() {
        assert_eq!(parse_target_query(Some("target=acme&x=1")).unwrap(), "acme");
        assert_eq!(parse_target_query(Some("target=a%20b")).unwrap(), "a b");
        assert!(parse_target_query(None).is_err());
        assert!(parse_target_query(Some("target=")).is_err());
        // an array is not a string
        assert!(parse_target_query(Some("target=a&target=b")).is_err());
        assert!(parse_target_query(Some(&format!("target={}", "a".repeat(81)))).is_err());
    }
}
