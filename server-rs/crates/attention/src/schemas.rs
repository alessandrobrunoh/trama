//! Request bodies of the attention routes.

use serde::Deserialize;
use serde_json::Value;
use trama_core::AppError;
use trama_core::validation::Checks;
use utoipa::ToSchema;

use crate::iso::is_date_string;

/// `POST /attention/{id}/snooze` (`SnoozeAttentionDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct SnoozeBody {
    /// ISO 8601 date and time the item comes back at; must be in the future.
    #[schema(value_type = String, format = DateTime)]
    pub until: Option<Value>,
}

impl SnoozeBody {
    /// `@IsDateString() until`.
    ///
    /// # Errors
    ///
    /// 400 `until must be a valid ISO 8601 date string`.
    pub fn validate(self) -> Result<String, AppError> {
        let until = match self.until {
            Some(Value::String(text)) if is_date_string(&text) => Some(text),
            _ => None,
        };
        let mut checks = Checks::new();
        checks.check(until.is_some(), "until must be a valid ISO 8601 date string");
        checks.finish()?;
        until.ok_or_else(|| AppError::bad_request("until must be a valid ISO 8601 date string"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::SnoozeBody;

    fn body(value: serde_json::Value) -> SnoozeBody {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn needs_an_iso_date_string() {
        assert_eq!(
            body(json!({ "until": "2030-01-01T00:00:00.000Z" })).validate().unwrap(),
            "2030-01-01T00:00:00.000Z"
        );
        for bad in
            [json!({}), json!({ "until": null }), json!({ "until": 5 }), json!({ "until": "soon" })]
        {
            let err = body(bad).validate().unwrap_err();
            assert_eq!(
                err.to_string(),
                "400 Bad Request: until must be a valid ISO 8601 date string"
            );
        }
    }
}
