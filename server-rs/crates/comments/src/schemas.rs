//! Request bodies and queries of the comments routes (the DTOs of
//! `server/src/comments/comments.controller.ts`) and the wire form of a comment row.
//!
//! Responses are the contract types: [`Comment`], [`CommentPage`] and [`CommentIndexEntry`].

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::activity::{COMMENT_PAGE_SIZE_MAX, Comment};
use trama_contracts::common::{SubjectRef, SubjectType};
use trama_contracts::js::len as js_len;
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::time::to_iso;
use trama_core::validation::Checks;
use trama_entities::comments;
use utoipa::{IntoParams, ToSchema};

/// The subject types a comment can be on (`SUBJECTS`).
const SUBJECTS: [&str; 5] = ["issue", "artifact", "project", "milestone", "import"];

/// `@IsIn(SUBJECTS)` on a field that may be absent.
fn subject_in(c: &mut Checks, field: &str, value: Option<&Value>) -> Option<SubjectType> {
    let kind = value.and_then(Value::as_str).and_then(SubjectType::parse);
    c.check(
        kind.is_some(),
        format!("{field} must be one of the following values: {}", SUBJECTS.join(", ")),
    );
    kind
}

/// `@IsString() @MinLength(1) @MaxLength(20000) body`, reported in class-validator's order (the
/// decorators run bottom-up).
fn comment_body(c: &mut Checks, value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str);
    c.check(
        text.is_some_and(|s| js_len(s) <= 20_000),
        "body must be shorter than or equal to 20000 characters",
    );
    c.check(
        text.is_some_and(|s| js_len(s) >= 1),
        "body must be longer than or equal to 1 characters",
    );
    c.check(text.is_some(), "body must be a string");
    text.map(ToOwned::to_owned)
}

/// `POST /comments` (`CreateCommentDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateCommentBody {
    /// What the comment is about: `{ type, id }`.
    #[schema(value_type = trama_contracts::common::SubjectRef)]
    pub subject: Option<Value>,
    /// Markdown, 1 to 20000 characters.
    #[schema(value_type = String)]
    pub body: Option<Value>,
}

impl CreateCommentBody {
    /// `CreateCommentDto`'s rules (the nested `SubjectDto` included).
    ///
    /// A missing `subject` is a 400 here; NestJS lets it through the validator (`@ValidateNested`
    /// skips `undefined`) and answers 500 from a `TypeError`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<(SubjectRef, String), AppError> {
        let mut c = Checks::new();
        let mut subject = None;
        match self.subject.as_ref() {
            Some(Value::Object(map)) => {
                let kind = subject_in(&mut c, "subject.type", map.get("type"));
                let id = map.get("id").and_then(Value::as_str);
                c.check(id.is_some(), "subject.id must be a string");
                if let (Some(kind), Some(id)) = (kind, id) {
                    subject = Some(SubjectRef { kind, id: id.to_owned() });
                }
            }
            None | Some(Value::Null) => {
                c.check(false, "subject must be an object");
            }
            Some(_) => {
                c.check(false, "nested property subject must be either object or array");
            }
        }
        let body = comment_body(&mut c, self.body.as_ref());
        c.finish()?;
        match (subject, body) {
            (Some(subject), Some(body)) => Ok((subject, body)),
            _ => Err(AppError::bad_request("Invalid comment")),
        }
    }
}

/// `PATCH /comments/{id}` (`UpdateCommentDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateCommentBody {
    /// Markdown, 1 to 20000 characters.
    #[schema(value_type = String)]
    pub body: Option<Value>,
}

impl UpdateCommentBody {
    /// `UpdateCommentDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<String, AppError> {
        let mut c = Checks::new();
        let body = comment_body(&mut c, self.body.as_ref());
        c.finish()?;
        body.ok_or_else(|| AppError::bad_request("Invalid comment"))
    }
}

/// The query string as Express (`querystring`) hands it to class-transformer: a repeated key is
/// a list, so it is not a string.
struct RawQuery(Vec<(String, Vec<String>)>);

impl RawQuery {
    fn parse(raw: Option<&str>) -> Self {
        let mut values: Vec<(String, Vec<String>)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            match values.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(value.into_owned()),
                None => values.push((key.into_owned(), vec![value.into_owned()])),
            }
        }
        Self(values)
    }

    fn get(&self, name: &str) -> Option<&[String]> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice())
    }

    /// `@IsOptional() @IsString()`: absent is fine, a repeated key is not a string.
    fn optional_string(&self, c: &mut Checks, name: &str) -> Option<String> {
        let list = self.get(name)?;
        c.check(list.len() == 1, format!("{name} must be a string"));
        (list.len() == 1).then(|| list[0].clone())
    }

    /// `@IsOptional() @IsIn(SUBJECTS)`.
    fn optional_subject_type(&self, c: &mut Checks, name: &str) -> Option<String> {
        let list = self.get(name)?;
        let one = (list.len() == 1).then(|| list[0].as_str());
        subject_in(c, name, one.map(|s| Value::String(s.to_owned())).as_ref());
        one.map(ToOwned::to_owned)
    }
}

/// `GET /comments` (`ListCommentsQuery`): both fields optional.
#[derive(Clone, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListCommentsQuery {
    /// `issue`, `artifact`, `project`, `milestone` or `import`.
    #[param(rename = "subjectType")]
    pub subject_type: Option<String>,
    /// Id of the subject.
    #[param(rename = "subjectId")]
    pub subject_id: Option<String>,
}

impl ListCommentsQuery {
    /// Reads the raw query string with class-validator's rules; unknown keys are dropped.
    ///
    /// # Errors
    ///
    /// 400 with every message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let query = RawQuery::parse(raw);
        let mut c = Checks::new();
        let subject_type = query.optional_subject_type(&mut c, "subjectType");
        let subject_id = query.optional_string(&mut c, "subjectId");
        c.finish()?;
        Ok(Self { subject_type, subject_id })
    }
}

/// `GET /comments/page` (`PageCommentsQuery`) after validation.
#[derive(Clone, Debug, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PageCommentsQuery {
    /// `issue`, `artifact`, `project`, `milestone` or `import`.
    #[param(rename = "subjectType", value_type = String)]
    pub subject_type: SubjectType,
    /// Id of the subject (at most 64 characters).
    #[param(rename = "subjectId")]
    pub subject_id: String,
    /// 1..=100, default 50.
    #[param(value_type = Option<u32>, minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
    /// The `nextCursor` of the previous page.
    pub cursor: Option<String>,
}

impl PageCommentsQuery {
    /// Reads the raw query string the way Express, class-transformer (`limit` goes through
    /// `Number()`) and class-validator do.
    ///
    /// # Errors
    ///
    /// 400 with every message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let query = RawQuery::parse(raw);
        let mut c = Checks::new();

        let kind = {
            let one = query.get("subjectType").filter(|l| l.len() == 1).map(|l| l[0].clone());
            subject_in(&mut c, "subjectType", one.map(Value::String).as_ref())
        };

        // @IsString() @IsNotEmpty() @MaxLength(64), run bottom-up
        let id_list = query.get("subjectId");
        let id = id_list.filter(|l| l.len() == 1).map(|l| l[0].as_str());
        c.check(
            id.is_some_and(|s| js_len(s) <= 64),
            "subjectId must be shorter than or equal to 64 characters",
        );
        c.check(
            id_list.is_some_and(|l| l.len() != 1 || !l[0].is_empty()),
            "subjectId should not be empty",
        );
        c.check(id.is_some(), "subjectId must be a string");

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100), run bottom-up
        let limit = query.get("limit").map(|list| match list {
            [one] => js_number(one).unwrap_or(f64::NAN),
            _ => f64::NAN,
        });
        if let Some(n) = limit {
            c.check(
                n <= f64::from(COMMENT_PAGE_SIZE_MAX),
                format!("limit must not be greater than {COMMENT_PAGE_SIZE_MAX}"),
            )
            .check(n >= 1.0, "limit must not be less than 1")
            .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }

        // @IsOptional() @IsString() @MaxLength(200), run bottom-up
        let cursor_list = query.get("cursor");
        let cursor = cursor_list.filter(|l| l.len() == 1).map(|l| l[0].clone());
        if cursor_list.is_some() {
            c.check(
                cursor.as_deref().is_some_and(|s| js_len(s) <= 200),
                "cursor must be shorter than or equal to 200 characters",
            );
            c.check(cursor.is_some(), "cursor must be a string");
        }
        c.finish()?;

        match (kind, id) {
            (Some(subject_type), Some(id)) => Ok(Self {
                subject_type,
                subject_id: id.to_owned(),
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                limit: limit.map(|n| n as u32),
                cursor,
            }),
            _ => Err(AppError::bad_request("Invalid query")),
        }
    }
}

/// The wire form of a comment row (`CommentEntity.toJSON`).
///
/// # Errors
///
/// 500 when the stored `subject` or `author` is not a valid reference, which only a hand-edited
/// row can be.
pub fn comment_view(row: comments::Model) -> Result<Comment, AppError> {
    let corrupt = |what: &str, err: serde_json::Error| {
        AppError::internal(format!("comment {} has a malformed {what}: {err}", row.id))
    };
    Ok(Comment {
        subject: serde_json::from_value(row.subject.clone()).map_err(|e| corrupt("subject", e))?,
        author: serde_json::from_value(row.author.clone()).map_err(|e| corrupt("author", e))?,
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
        id: row.id,
        workspace_id: row.workspace_id,
        body: row.body,
    })
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::*;

    fn page_errors(raw: &str) -> String {
        text(&PageCommentsQuery::parse(Some(raw)).unwrap_err())
    }

    /// The message of a 400, without the status line `Display` adds.
    fn text(err: &AppError) -> String {
        err.to_string().replace("400 Bad Request: ", "")
    }

    #[test]
    fn the_page_query_requires_a_subject_and_bounds_limit_and_cursor() {
        let ok =
            PageCommentsQuery::parse(Some("subjectType=issue&subjectId=in_1&limit=25&cursor=abc"))
                .unwrap();
        assert_eq!(ok.subject_type, SubjectType::Issue);
        assert_eq!(ok.subject_id, "in_1");
        assert_eq!(ok.limit, Some(25));
        assert_eq!(ok.cursor.as_deref(), Some("abc"));
        let defaults =
            PageCommentsQuery::parse(Some("subjectType=project&subjectId=pj_1&x=1")).unwrap();
        assert_eq!((defaults.limit, defaults.cursor), (None, None));

        let none = page_errors("");
        assert!(none.contains("subjectType must be one of the following values: issue, artifact, project, milestone, import"), "{none}");
        assert!(
            none.contains(
                "subjectId must be shorter than or equal to 64 characters; subjectId should not be empty; subjectId must be a string"
            ),
            "{none}"
        );
        let base = "subjectType=issue&subjectId=in_1";
        assert!(
            page_errors("subjectType=bogus&subjectId=in_1")
                .starts_with("subjectType must be one of")
        );
        for (extra, message) in [
            ("limit=0", "limit must not be less than 1"),
            ("limit=101", "limit must not be greater than 100"),
            (
                "limit=x",
                "limit must not be greater than 100; limit must not be less than 1; limit must be an integer number",
            ),
            ("limit=1.5", "limit must be an integer number"),
            ("limit=1&limit=2", "limit must be an integer number"),
        ] {
            assert!(page_errors(&format!("{base}&{extra}")).contains(message), "{extra}");
        }
        let cursor = format!("{base}&cursor={}", "x".repeat(201));
        assert_eq!(page_errors(&cursor), "cursor must be shorter than or equal to 200 characters");
        assert_eq!(
            page_errors(&format!("{base}&cursor=a&cursor=b")),
            "cursor must be shorter than or equal to 200 characters; cursor must be a string"
        );
        assert_eq!(page_errors("subjectType=issue&subjectId="), "subjectId should not be empty");
        assert!(
            page_errors("subjectType=issue&subjectId=a&subjectId=b")
                .contains("subjectId must be a string")
        );
        let long = format!("subjectType=issue&subjectId={}", "a".repeat(65));
        assert_eq!(page_errors(&long), "subjectId must be shorter than or equal to 64 characters");
        assert_eq!(
            PageCommentsQuery::parse(Some("limit=0")).unwrap_err().status_code(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn the_list_query_is_all_optional() {
        assert_eq!(ListCommentsQuery::parse(None).unwrap(), ListCommentsQuery::default());
        let q = ListCommentsQuery::parse(Some("subjectType=issue&subjectId=in_1&other=1")).unwrap();
        assert_eq!(q.subject_type.as_deref(), Some("issue"));
        assert_eq!(q.subject_id.as_deref(), Some("in_1"));
        assert_eq!(
            text(
                &ListCommentsQuery::parse(Some("subjectType=bogus&subjectId=a&subjectId=b"))
                    .unwrap_err()
            ),
            "subjectType must be one of the following values: issue, artifact, project, milestone, import; subjectId must be a string"
        );
        // an empty value is a value: it is not in the list
        assert!(ListCommentsQuery::parse(Some("subjectType=")).is_err());
        assert_eq!(
            ListCommentsQuery::parse(Some("subjectId=")).unwrap().subject_id.as_deref(),
            Some("")
        );
    }

    fn create(body: &Value) -> Result<(SubjectRef, String), AppError> {
        serde_json::from_value::<CreateCommentBody>(body.clone()).unwrap().validate()
    }

    #[test]
    fn create_validates_like_the_dto() {
        let (subject, body) =
            create(&json!({ "subject": { "type": "issue", "id": "in_1" }, "body": "  hi " }))
                .unwrap();
        assert_eq!(subject, SubjectRef { kind: SubjectType::Issue, id: "in_1".into() });
        assert_eq!(body, "  hi ");

        let message = |v: Value| text(&create(&v).unwrap_err());
        assert_eq!(
            message(json!({})),
            "subject must be an object; body must be shorter than or equal to 20000 characters; body must be longer than or equal to 1 characters; body must be a string"
        );
        assert_eq!(
            message(json!({ "subject": { "type": "bogus", "id": 3 }, "body": "" })),
            "subject.type must be one of the following values: issue, artifact, project, milestone, import; subject.id must be a string; body must be longer than or equal to 1 characters"
        );
        assert_eq!(
            message(json!({ "subject": "issue", "body": "x" })),
            "nested property subject must be either object or array"
        );
        assert_eq!(
            message(
                json!({ "subject": { "type": "issue", "id": "a" }, "body": "x".repeat(20_001) })
            ),
            "body must be shorter than or equal to 20000 characters"
        );
        assert!(
            create(
                &json!({ "subject": { "type": "issue", "id": "a" }, "body": "x".repeat(20_000) })
            )
            .is_ok()
        );
        // an empty id is a string
        assert!(
            create(&json!({ "subject": { "type": "workstream", "id": "" }, "body": "x" })).is_err()
        );
        assert!(create(&json!({ "subject": { "type": "import", "id": "" }, "body": "x" })).is_ok());
        // class-validator counts UTF-16 units
        let emoji = "😀".repeat(10_001);
        assert!(
            create(&json!({ "subject": { "type": "issue", "id": "a" }, "body": emoji })).is_err()
        );
    }

    #[test]
    fn update_validates_the_body() {
        let parse = |v: Value| serde_json::from_value::<UpdateCommentBody>(v).unwrap().validate();
        assert_eq!(parse(json!({ "body": "new" })).unwrap(), "new");
        assert_eq!(
            text(&parse(json!({ "body": 3 })).unwrap_err()),
            "body must be shorter than or equal to 20000 characters; body must be longer than or equal to 1 characters; body must be a string"
        );
        assert!(parse(json!({ "body": "" })).is_err());
        assert!(parse(json!({})).is_err());
    }
}
