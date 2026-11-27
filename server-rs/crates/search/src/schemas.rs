//! The query string and the response of `GET /api/w/{slug}/search`.

use serde::Serialize;
use trama_core::AppError;
use trama_core::config::js_number;
use trama_core::validation::Checks;
use utoipa::{IntoParams, ToSchema};

/// What a search can find (`SEARCH_TYPES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SearchType {
    /// A project.
    Project,
    /// An issue.
    Issue,
    /// An artifact (pull request, build, …).
    Artifact,
    /// A decision an agent recorded on a task.
    Decision,
    /// The thread record of a task (the hit id is the task id).
    Record,
}

impl SearchType {
    /// `SEARCH_TYPES`, in the order the validation message lists them.
    pub const ALL: [Self; 5] =
        [Self::Project, Self::Issue, Self::Artifact, Self::Decision, Self::Record];

    /// The wire string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Issue => "issue",
            Self::Artifact => "artifact",
            Self::Decision => "decision",
            Self::Record => "record",
        }
    }

    /// The type a wire string names.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == value)
    }
}

/// One hit (`SearchResult`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Kind of record.
    #[serde(rename = "type")]
    pub kind: SearchType,
    /// Record id.
    pub id: String,
    /// Human key: the issue key (or an alias), the artifact's external id, the task key of a
    /// decision or a record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Name or title; the decision itself for a decision, the task's title for a record.
    pub title: String,
    /// Project status, `kind · status` of an issue, `kind · state` of an artifact, the title of
    /// a decision's task, the start of a record's summary.
    pub subtitle: String,
    /// The retired Workstream an artifact came from, kept as provenance only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_workstream_key: Option<String>,
    /// The task a `decision` or `record` hit belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    /// Relevance: key match 60 to 100, title match 30 to 70, body match 20, anything else 10.
    pub score: u32,
}

/// `GET /search`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct SearchResponse {
    /// Best first.
    pub results: Vec<SearchResult>,
}

/// `SearchQuery` after validation.
#[derive(Clone, Debug, Default, PartialEq, Eq, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchQuery {
    /// The text to look for; every word must match.
    pub q: String,
    /// Comma-separated resource types: `project`, `issue`, `artifact`, `decision`, `record`.
    /// Empty: all.
    #[param(value_type = Option<String>)]
    pub types: Vec<SearchType>,
    /// 1..=100, default 20.
    #[param(value_type = Option<u32>, minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
}

impl SearchQuery {
    /// Reads the raw query string the way Express (`querystring`), class-transformer and
    /// class-validator do: a repeated key is an array (not a string), `types` is split on commas
    /// and trimmed unless it is already an array, `limit` goes through `Number()`, unknown keys
    /// are dropped.
    ///
    /// # Errors
    ///
    /// 400 with every class-validator message, in declaration order.
    pub fn parse(raw: Option<&str>) -> Result<Self, AppError> {
        let mut values: Vec<(String, Vec<String>)> = Vec::new();
        for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
            match values.iter_mut().find(|(k, _)| *k == key) {
                Some((_, list)) => list.push(value.into_owned()),
                None => values.push((key.into_owned(), vec![value.into_owned()])),
            }
        }
        let get = |name: &str| values.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice());
        let mut checks = Checks::new();

        // @IsString()
        let q = get("q").filter(|list| list.len() == 1).map(|list| list[0].clone());
        checks.check(q.is_some(), "q must be a string");

        // @IsOptional() @Transform(split) @IsArray() @IsIn(SEARCH_TYPES, { each: true })
        let mut types = Vec::new();
        if let Some(list) = get("types") {
            let names: Vec<&str> = match list {
                [one] => one.split(',').map(str::trim).filter(|s| !s.is_empty()).collect(),
                many => many.iter().map(String::as_str).collect(),
            };
            let parsed: Vec<Option<SearchType>> =
                names.iter().map(|name| SearchType::parse(name)).collect();
            checks.check(
                parsed.iter().all(Option::is_some),
                format!(
                    "each value in types must be one of the following values: {}",
                    SearchType::ALL.map(SearchType::as_str).join(", ")
                ),
            );
            types = parsed.into_iter().flatten().collect();
        }

        // @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100), run bottom-up
        let limit = get("limit").map(|list| match list {
            [one] => js_number(one).unwrap_or(f64::NAN),
            _ => f64::NAN,
        });
        if let Some(n) = limit {
            checks
                .check(n <= 100.0, "limit must not be greater than 100")
                .check(n >= 1.0, "limit must not be less than 1")
                .check(n.is_finite() && n.fract() == 0.0, "limit must be an integer number");
        }
        checks.finish()?;
        Ok(Self {
            q: q.unwrap_or_default(),
            types,
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            limit: limit.map(|n| n as u32),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(raw: &str) -> String {
        let err = SearchQuery::parse(Some(raw)).unwrap_err().to_string();
        err.trim_start_matches("400 Bad Request: ").to_owned()
    }

    #[test]
    fn reads_every_field() {
        let q = SearchQuery::parse(Some("q=zebra%20x&types=project,%20issue,&limit=5&other=1"))
            .unwrap();
        assert_eq!(q.q, "zebra x");
        assert_eq!(q.types, [SearchType::Project, SearchType::Issue]);
        assert_eq!(q.limit, Some(5));
        let none = SearchQuery::parse(Some("q=")).unwrap();
        assert_eq!((none.q.as_str(), none.types.len(), none.limit), ("", 0, None));
        assert!(SearchQuery::parse(Some("q=a&types=")).unwrap().types.is_empty());
    }

    #[test]
    fn validates_like_class_validator() {
        assert_eq!(message(""), "q must be a string");
        assert_eq!(message("q=a&q=b"), "q must be a string");
        let types = "each value in types must be one of the following values: project, issue, artifact, decision, record";
        assert_eq!(message("q=a&types=nope"), types);
        assert_eq!(message("q=a&types=issue&types=nope"), types);
        let limit = "limit must not be greater than 100; limit must not be less than 1; limit must be an integer number";
        assert_eq!(message("q=a&limit=abc"), limit);
        assert_eq!(message("q=a&limit=101"), "limit must not be greater than 100");
        assert_eq!(message("q=a&limit=0"), "limit must not be less than 1");
        assert_eq!(message("q=a&limit=1.5"), "limit must be an integer number");
        assert_eq!(
            message("limit=0&types=x"),
            format!("q must be a string; {types}; limit must not be less than 1")
        );
    }
}
