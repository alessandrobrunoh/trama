//! Request body of the preview and start routes (`ImportTargetDto` and `StartImportDto` of
//! `imports.controller.ts`).
//!
//! The fields keep the raw JSON so that a value of the wrong type is reported with
//! class-validator's messages rather than serde's. Messages of one field come in the order
//! class-validator reports them: the decorator nearest the property last.

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::imports::{EXTERNAL_PROVIDERS, ExternalProvider, ImportSource};
use trama_core::AppError;
use trama_core::validation::{Checks, js_len};
use utoipa::ToSchema;

use crate::service::ImportRequest;

const ID_MAX: usize = 100;
const REPOSITORY_MAX: usize = 300;
const TEAM_IDS_MAX: usize = 50;

/// `POST /api/w/{slug}/imports/preview` and `POST /api/w/{slug}/imports`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequestDto {
    /// `github` or `linear`.
    #[schema(value_type = String)]
    pub provider: Option<Value>,
    /// A saved tracker credential.
    #[schema(value_type = Option<String>)]
    pub credential_id: Option<Value>,
    /// A GitHub connection of the workspace.
    #[schema(value_type = Option<String>)]
    pub connection_id: Option<Value>,
    /// GitHub: `{ repository: "owner/name" }`; Linear: `{ teamIds: [...] }`.
    #[schema(value_type = Option<Object>)]
    pub source: Option<Value>,
    /// The editable mapping from the preview (start only); omit to use the suggestions.
    #[schema(value_type = Option<Object>)]
    pub mapping: Option<Value>,
    /// Options (start only).
    #[schema(value_type = Option<Object>)]
    pub options: Option<Value>,
}

/// `@IsOptional() @IsString() @MaxLength(max)`: absent and `null` skip the rules.
fn optional_text(c: &mut Checks, field: &str, value: Option<&Value>, max: usize) -> Option<String> {
    let value = value.filter(|v| !v.is_null())?;
    let text = value.as_str();
    c.check(
        text.is_some_and(|s| js_len(s) <= max),
        format!("{field} must be shorter than or equal to {max} characters"),
    );
    c.check(text.is_some(), format!("{field} must be a string"));
    text.map(str::to_owned)
}

/// `@IsOptional() @IsObject()`.
fn optional_object(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<Value> {
    let value = value.filter(|v| !v.is_null())?;
    c.check(value.is_object(), format!("{field} must be an object"));
    value.is_object().then(|| value.clone())
}

/// `@IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true })`.
fn team_ids(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<Vec<String>> {
    let value = value.filter(|v| !v.is_null())?;
    let Some(items) = value.as_array() else {
        c.check(false, format!("{field} must contain no more than {TEAM_IDS_MAX} elements"));
        c.check(false, format!("{field} must be an array"));
        return None;
    };
    let texts: Vec<Option<&str>> = items.iter().map(Value::as_str).collect();
    c.check(
        texts.iter().all(|t| t.is_none_or(|t| js_len(t) <= ID_MAX)),
        format!("each value in {field} must be shorter than or equal to {ID_MAX} characters"),
    );
    c.check(texts.iter().all(Option::is_some), format!("each value in {field} must be a string"));
    c.max_items(field, items.len(), TEAM_IDS_MAX);
    Some(texts.into_iter().flatten().map(str::to_owned).collect())
}

impl ImportRequestDto {
    /// The class-validator rules of `ImportTargetDto` (preview) and, with `start`, of
    /// `StartImportDto` too.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(&self, start: bool) -> Result<ImportRequest, AppError> {
        let mut c = Checks::new();
        let provider =
            self.provider.as_ref().and_then(Value::as_str).and_then(ExternalProvider::parse);
        let names: Vec<&str> = EXTERNAL_PROVIDERS.iter().map(|p| p.as_str()).collect();
        c.check(
            provider.is_some(),
            format!("provider must be one of the following values: {}", names.join(", ")),
        );
        let credential_id =
            optional_text(&mut c, "credentialId", self.credential_id.as_ref(), ID_MAX);
        let connection_id =
            optional_text(&mut c, "connectionId", self.connection_id.as_ref(), ID_MAX);
        // `@ValidateNested()`: a missing source is left to the service
        let source = match self.source.as_ref().filter(|v| !v.is_null()) {
            None => None,
            Some(Value::Object(fields)) => {
                let repository = optional_text(
                    &mut c,
                    "source.repository",
                    fields.get("repository"),
                    REPOSITORY_MAX,
                );
                let team_ids = team_ids(&mut c, "source.teamIds", fields.get("teamIds"));
                Some(ImportSource { repository, team_ids })
            }
            Some(Value::Array(_)) => Some(ImportSource::default()),
            Some(_) => {
                c.check(false, "nested property source must be either object or array");
                None
            }
        };
        let (mapping, options) = if start {
            (
                optional_object(&mut c, "mapping", self.mapping.as_ref()),
                optional_object(&mut c, "options", self.options.as_ref()),
            )
        } else {
            (None, None)
        };
        c.finish()?;
        Ok(ImportRequest {
            provider: provider.unwrap_or(ExternalProvider::Github),
            credential_id,
            connection_id,
            source,
            mapping,
            options,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dto(body: Value) -> ImportRequestDto {
        serde_json::from_value(body).unwrap()
    }

    fn messages(error: &AppError) -> String {
        error.to_string()
    }

    #[test]
    fn a_valid_request_keeps_its_parts() {
        let req = dto(json!({
            "provider": "linear", "credentialId": "tcr_1",
            "source": { "teamIds": ["a", "b"] },
            "mapping": { "teams": {} }, "options": { "includeComments": true },
            "unknown": 1,
        }))
        .validate(true)
        .unwrap();
        assert_eq!(req.provider, ExternalProvider::Linear);
        assert_eq!(req.credential_id.as_deref(), Some("tcr_1"));
        assert_eq!(req.source.unwrap().team_ids, Some(vec!["a".to_owned(), "b".to_owned()]));
        assert_eq!(req.mapping, Some(json!({ "teams": {} })));
        assert_eq!(req.options, Some(json!({ "includeComments": true })));
    }

    #[test]
    fn the_preview_ignores_mapping_and_options() {
        let req = dto(json!({ "provider": "github", "mapping": "x", "options": 3 }))
            .validate(false)
            .unwrap();
        assert_eq!((req.mapping, req.options), (None, None));
    }

    #[test]
    fn reports_every_failed_rule_in_class_validator_wording() {
        let error = dto(json!({
            "provider": "jira", "credentialId": 5, "connectionId": "x".repeat(101),
            "source": { "repository": "r".repeat(301), "teamIds": ["ok", 3, "y".repeat(101)] },
            "mapping": [], "options": "no",
        }))
        .validate(true)
        .unwrap_err();
        let shown = messages(&error);
        for expected in [
            "provider must be one of the following values: github, linear",
            "credentialId must be shorter than or equal to 100 characters; credentialId must be a string",
            "connectionId must be shorter than or equal to 100 characters",
            "source.repository must be shorter than or equal to 300 characters",
            "each value in source.teamIds must be shorter than or equal to 100 characters",
            "each value in source.teamIds must be a string",
            "mapping must be an object",
            "options must be an object",
        ] {
            assert!(shown.contains(expected), "{expected}\n{shown}");
        }
        assert_eq!(error.status_code(), 400);
    }

    #[test]
    fn limits_the_team_list() {
        let ids: Vec<String> = (0..51).map(|i| format!("t{i}")).collect();
        let error = dto(json!({ "provider": "linear", "source": { "teamIds": ids } }))
            .validate(false)
            .unwrap_err();
        assert!(messages(&error).contains("source.teamIds must contain no more than 50 elements"));
        let error = dto(json!({ "provider": "linear", "source": { "teamIds": "a" } }))
            .validate(false)
            .unwrap_err();
        assert!(messages(&error).contains("source.teamIds must be an array"));
    }

    #[test]
    fn a_missing_source_is_left_to_the_service_and_a_scalar_one_is_refused() {
        assert!(dto(json!({ "provider": "linear" })).validate(false).unwrap().source.is_none());
        assert!(dto(json!({ "provider": "linear", "source": null })).validate(false).is_ok());
        let error =
            dto(json!({ "provider": "linear", "source": "x" })).validate(false).unwrap_err();
        assert!(messages(&error).contains("nested property source must be either object or array"));
    }
}
