//! Request body of the favorites routes (`AddFavoriteDto`). Responses are
//! `trama_contracts::identity::Favorite`.

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::identity::{FAVORITE_TYPES, Favorite, FavoriteType};
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_core::validation::{Checks, js_len};
use trama_entities::favorites;
use utoipa::ToSchema;

/// The longest subject id.
const SUBJECT_ID_MAX: usize = 100;

/// Body of `POST /api/w/{slug}/favorites`.
///
/// The fields are read as raw JSON so a wrong type produces the class-validator message, as
/// NestJS does.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddFavoriteDto {
    /// `issue`, `project` or `view`.
    #[serde(default, rename = "type")]
    #[schema(value_type = FavoriteType, rename = "type")]
    pub kind: Option<Value>,
    /// Id (not key) of the thing to pin; at most 100 characters.
    #[serde(default)]
    #[schema(value_type = String, max_length = 100)]
    pub subject_id: Option<Value>,
}

impl AddFavoriteDto {
    /// `@IsIn(FAVORITE_TYPES) type` and `@IsString() @MaxLength(100) subjectId`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule (class-validator reports the decorator nearest the
    /// property first).
    pub fn validate(&self) -> Result<(FavoriteType, String), AppError> {
        let kind = self.kind.as_ref().and_then(Value::as_str).and_then(FavoriteType::parse);
        let subject_id = self.subject_id.as_ref().and_then(Value::as_str);
        let allowed: Vec<&str> = FAVORITE_TYPES.iter().map(|t| t.as_str()).collect();
        let mut c = Checks::new();
        c.check(
            kind.is_some(),
            format!("type must be one of the following values: {}", allowed.join(", ")),
        )
        .check(
            subject_id.is_some_and(|s| js_len(s) <= SUBJECT_ID_MAX),
            format!("subjectId must be shorter than or equal to {SUBJECT_ID_MAX} characters"),
        )
        .check(subject_id.is_some(), "subjectId must be a string");
        c.finish()?;
        match (kind, subject_id) {
            (Some(kind), Some(subject_id)) => Ok((kind, subject_id.to_owned())),
            _ => Err(AppError::bad_request("invalid favorite")),
        }
    }
}

/// A stored favorite as the API shows it: the owner is not part of it. `None` for a row whose
/// type is no longer a favorite type (removed kinds stay stored but are never listed).
#[must_use]
pub fn favorite(row: favorites::Model) -> Option<Favorite> {
    Some(Favorite {
        kind: FavoriteType::parse(&row.r#type)?,
        created_at: to_iso(&row.created_at),
        id: row.id,
        workspace_id: row.workspace_id,
        subject_id: row.subject_id,
    })
}
