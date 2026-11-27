//! Request and response bodies of the snapshot route.

use trama_contracts::activity::SnapshotCommentsMode;
use trama_core::AppError;
use utoipa::IntoParams;

/// `SnapshotQuery`: `?comments=` on `GET /snapshot`.
#[derive(Clone, Debug, Default, PartialEq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SnapshotQuery {
    /// `full` inlines every comment; `index` (the default) is the bounded mode.
    pub comments: Option<SnapshotCommentsMode>,
}

/// The class-validator message of `@IsIn(SNAPSHOT_COMMENTS_MODES)`.
const INVALID_COMMENTS: &str = "comments must be one of the following values: full, index";

impl SnapshotQuery {
    /// Reads the raw query string the way Express and class-validator do: unknown keys are
    /// dropped, a repeated key is an array (so not one of the allowed values).
    ///
    /// # Errors
    ///
    /// 400 `comments must be one of the following values: full, index` when `comments` is not
    /// `full` or `index`.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let values: Vec<String> = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
            .filter(|(key, _)| key == "comments")
            .map(|(_, value)| value.into_owned())
            .collect();
        let comments = match values.as_slice() {
            [one] => SnapshotCommentsMode::parse(one),
            _ => None,
        };
        if !values.is_empty() && comments.is_none() {
            return Err(AppError::bad_request(INVALID_COMMENTS));
        }
        Ok(Self { comments })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_mode() {
        assert_eq!(SnapshotQuery::parse(None).unwrap().comments, None);
        assert_eq!(SnapshotQuery::parse(Some("x=1")).unwrap().comments, None);
        assert_eq!(
            SnapshotQuery::parse(Some("comments=full")).unwrap().comments,
            Some(SnapshotCommentsMode::Full)
        );
        assert_eq!(
            SnapshotQuery::parse(Some("comments=index&x=1")).unwrap().comments,
            Some(SnapshotCommentsMode::Index)
        );
    }

    #[test]
    fn rejects_anything_else() {
        for raw in ["comments=", "comments=both", "comments=full&comments=index", "comments=1"] {
            let err = SnapshotQuery::parse(Some(raw)).unwrap_err();
            assert!(err.to_string().contains(INVALID_COMMENTS), "{raw}: {err}");
        }
    }
}
