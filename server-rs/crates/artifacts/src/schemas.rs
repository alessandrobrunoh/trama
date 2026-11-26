//! Request bodies and queries of the artifacts routes, validated with the wording and order of
//! the class-validator rules of `CreateArtifactDto`, `UpdateArtifactDto` and the list queries.
//!
//! Fields are read as JSON values and checked by hand rather than typed by serde, so a wrong
//! type is reported as `title must be a string` like NestJS (not as a serde error), and the
//! messages of one property come in class-validator's order (the last decorator first).

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::issues::{
    ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState,
};
use trama_core::AppError;
use trama_core::validation::{Checks, Patch, js_len};
use utoipa::{IntoParams, ToSchema};

use crate::service::{ArtifactFilter, ArtifactInput};

/// A parsed enum: `@IsIn(Enum.ALL)` then the enum's own parser.
fn one_of<T: Copy>(
    c: &mut Checks,
    name: &str,
    value: &Value,
    all: &[T],
    as_str: impl Fn(T) -> &'static str,
) -> Option<T> {
    let found = value.as_str().and_then(|s| all.iter().copied().find(|v| as_str(*v) == s));
    let names: Vec<&str> = all.iter().map(|v| as_str(*v)).collect();
    c.check(
        found.is_some(),
        format!("{name} must be one of the following values: {}", names.join(", ")),
    );
    found
}

/// `@IsString() @MinLength(min) @MaxLength(max)` (bounds optional). `MinLength` and
/// `MaxLength` also fail on a non-string, so they report before `IsString`.
fn text(
    c: &mut Checks,
    name: &str,
    value: &Value,
    min: Option<usize>,
    max: Option<usize>,
) -> Option<String> {
    let s = value.as_str();
    if let Some(max) = max {
        c.check(
            s.is_some_and(|s| js_len(s) <= max),
            format!("{name} must be shorter than or equal to {max} characters"),
        );
    }
    if let Some(min) = min {
        c.check(
            s.is_some_and(|s| js_len(s) >= min),
            format!("{name} must be longer than or equal to {min} characters"),
        );
    }
    c.check(s.is_some(), format!("{name} must be a string"));
    s.map(str::to_owned)
}

/// `@IsBoolean()`.
fn boolean(c: &mut Checks, name: &str, value: &Value) -> Option<bool> {
    let b = value.as_bool();
    c.check(b.is_some(), format!("{name} must be a boolean value"));
    b
}

/// `@Clearable()`: skipped while absent or `null` (`null` clears the field).
fn clearable<T>(patch: Patch<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Patch<T> {
    match patch {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(v) => check(&v).map_or(Patch::Missing, Patch::Value),
    }
}

/// `@OptionalNotNull()`: skipped while absent; `null` is validated (and fails).
fn not_null<T>(patch: Patch<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    match patch {
        Patch::Missing => None,
        Patch::Null => check(&Value::Null),
        Patch::Value(v) => check(&v),
    }
}

/// `@IsOptional()`: skipped while absent or `null`.
fn optional<T>(value: Option<Value>, mut check: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    value.and_then(|v| check(&v))
}

fn into_patch<T>(value: Option<T>) -> Patch<T> {
    value.map_or(Patch::Missing, Patch::Value)
}

/// Body of `POST /api/w/{slug}/artifacts` and `POST /api/w/{slug}/tasks/{idOrKey}/artifacts`
/// (`CreateArtifactDto`).
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtifactBody {
    /// The task that owns it (the nested task route fills it).
    #[schema(value_type = Option<String>)]
    issue_id: Option<Value>,
    /// Short note on what it is, up to 10000 characters.
    #[schema(value_type = Option<String>, max_length = 10000)]
    description: Option<Value>,
    /// What the artifact is.
    #[schema(value_type = ArtifactKind)]
    kind: Option<Value>,
    /// Title, 1 to 300 characters. Required in practice (400 when missing).
    #[schema(value_type = Option<String>, min_length = 1, max_length = 300)]
    title: Option<Value>,
    /// Git full name or URL.
    #[schema(value_type = Option<String>)]
    repository: Option<Value>,
    /// Where it lives; defaults to the kind's usual provider.
    #[schema(value_type = Option<ArtifactProvider>)]
    provider: Option<Value>,
    /// Link: an http(s) URL, up to 1000 characters.
    #[schema(value_type = Option<String>, max_length = 1000)]
    url: Option<Value>,
    /// e.g. `#182`, a commit sha.
    #[schema(value_type = Option<String>, max_length = 200)]
    external_id: Option<Value>,
    /// Lifecycle state; defaults to the kind's initial state.
    #[schema(value_type = Option<ArtifactState>)]
    state: Option<Value>,
    /// PR/MR CI status.
    #[schema(value_type = Option<CiState>)]
    ci: Option<Value>,
    /// PR/MR review status.
    #[schema(value_type = Option<ReviewState>)]
    review: Option<Value>,
    /// PR/MR has merge conflicts.
    #[schema(value_type = Option<bool>)]
    has_conflicts: Option<Value>,
    /// Deployment or release environment, up to 100 characters.
    #[schema(value_type = Option<String>, max_length = 100)]
    environment: Option<Value>,
}

impl CreateArtifactBody {
    /// Runs the DTO rules and builds the service input.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<(ArtifactKind, ArtifactInput), AppError> {
        let mut c = Checks::new();
        let issue_id = optional(self.issue_id, |v| text(&mut c, "issueId", v, None, None));
        let description =
            optional(self.description, |v| text(&mut c, "description", v, None, Some(10000)));
        let kind = one_of(
            &mut c,
            "kind",
            self.kind.as_ref().unwrap_or(&Value::Null),
            ArtifactKind::ALL,
            ArtifactKind::as_str,
        );
        let title = optional(self.title, |v| text(&mut c, "title", v, Some(1), Some(300)));
        let repository = optional(self.repository, |v| text(&mut c, "repository", v, None, None));
        let provider = optional(self.provider, |v| {
            one_of(&mut c, "provider", v, ArtifactProvider::ALL, ArtifactProvider::as_str)
        });
        let url = optional(self.url, |v| text(&mut c, "url", v, None, Some(1000)));
        let external_id =
            optional(self.external_id, |v| text(&mut c, "externalId", v, None, Some(200)));
        let state = optional(self.state, |v| {
            one_of(&mut c, "state", v, ArtifactState::ALL, ArtifactState::as_str)
        });
        let ci = optional(self.ci, |v| one_of(&mut c, "ci", v, CiState::ALL, CiState::as_str));
        let review = optional(self.review, |v| {
            one_of(&mut c, "review", v, ReviewState::ALL, ReviewState::as_str)
        });
        let has_conflicts = optional(self.has_conflicts, |v| boolean(&mut c, "hasConflicts", v));
        let environment =
            optional(self.environment, |v| text(&mut c, "environment", v, None, Some(100)));
        c.finish()?;
        let kind = kind.ok_or_else(|| AppError::bad_request("kind is required"))?;
        Ok((
            kind,
            ArtifactInput {
                issue_id: into_patch(issue_id),
                repository: into_patch(repository),
                description: into_patch(description),
                provider,
                title,
                url: into_patch(url),
                external_id: into_patch(external_id),
                state,
                ci: into_patch(ci),
                review: into_patch(review),
                has_conflicts: into_patch(has_conflicts),
                environment: into_patch(environment),
                reviewer_user_ids: Vec::new(),
            },
        ))
    }
}

/// Body of `PATCH /api/w/{slug}/artifacts/{id}` (`UpdateArtifactDto`). Absent fields stay;
/// `null` clears a nullable field.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArtifactBody {
    /// Move to another task. `null` is refused: an artifact keeps a task owner.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    issue_id: Patch<Value>,
    /// Short note, up to 10000 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 10000)]
    description: Patch<Value>,
    /// Title, 1 to 300 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, min_length = 1, max_length = 300)]
    title: Patch<Value>,
    /// Git full name or URL.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    repository: Patch<Value>,
    /// Provider.
    #[serde(default)]
    #[schema(value_type = Option<ArtifactProvider>)]
    provider: Patch<Value>,
    /// Link, up to 1000 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 1000)]
    url: Patch<Value>,
    /// e.g. `#182`, a commit sha.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 200)]
    external_id: Patch<Value>,
    /// Lifecycle state.
    #[serde(default)]
    #[schema(value_type = Option<ArtifactState>)]
    state: Patch<Value>,
    /// PR/MR CI status.
    #[serde(default)]
    #[schema(value_type = Option<CiState>)]
    ci: Patch<Value>,
    /// PR/MR review status.
    #[serde(default)]
    #[schema(value_type = Option<ReviewState>)]
    review: Patch<Value>,
    /// PR/MR has merge conflicts.
    #[serde(default)]
    #[schema(value_type = Option<bool>)]
    has_conflicts: Patch<Value>,
    /// Deployment or release environment, up to 100 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 100)]
    environment: Patch<Value>,
}

impl UpdateArtifactBody {
    /// Runs the DTO rules and builds the service patch.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule, properties in declaration order.
    pub fn validate(self) -> Result<ArtifactInput, AppError> {
        let mut c = Checks::new();
        let issue_id = clearable(self.issue_id, |v| text(&mut c, "issueId", v, None, None));
        let description =
            clearable(self.description, |v| text(&mut c, "description", v, None, Some(10000)));
        let title = not_null(self.title, |v| text(&mut c, "title", v, Some(1), Some(300)));
        let repository = clearable(self.repository, |v| text(&mut c, "repository", v, None, None));
        let provider = not_null(self.provider, |v| {
            one_of(&mut c, "provider", v, ArtifactProvider::ALL, ArtifactProvider::as_str)
        });
        let url = clearable(self.url, |v| text(&mut c, "url", v, None, Some(1000)));
        let external_id =
            clearable(self.external_id, |v| text(&mut c, "externalId", v, None, Some(200)));
        let state = not_null(self.state, |v| {
            one_of(&mut c, "state", v, ArtifactState::ALL, ArtifactState::as_str)
        });
        let ci = clearable(self.ci, |v| one_of(&mut c, "ci", v, CiState::ALL, CiState::as_str));
        let review = clearable(self.review, |v| {
            one_of(&mut c, "review", v, ReviewState::ALL, ReviewState::as_str)
        });
        let has_conflicts = clearable(self.has_conflicts, |v| boolean(&mut c, "hasConflicts", v));
        let environment =
            clearable(self.environment, |v| text(&mut c, "environment", v, None, Some(100)));
        c.finish()?;
        Ok(ArtifactInput {
            issue_id,
            repository,
            description,
            provider,
            title,
            url,
            external_id,
            state,
            ci,
            review,
            has_conflicts,
            environment,
            reviewer_user_ids: Vec::new(),
        })
    }
}

/// `ListArtifactsQuery`, for the documentation: every filter is optional.
#[derive(Clone, Debug, Default, IntoParams)]
#[into_params(parameter_in = Query)]
#[allow(dead_code)]
pub struct ListArtifactsQuery {
    /// Only the artifacts of this task (an id).
    #[param(rename = "issueId")]
    pub issue_id: Option<String>,
    /// Only this repository.
    pub repository: Option<String>,
    /// Only this kind.
    pub kind: Option<ArtifactKind>,
    /// Only this state.
    pub state: Option<ArtifactState>,
}

/// `ListOwnedArtifactsQuery`, for the documentation: the filters of [`ListArtifactsQuery`]
/// minus the owner, which comes from the route.
#[derive(Clone, Debug, Default, IntoParams)]
#[into_params(parameter_in = Query)]
#[allow(dead_code)]
pub struct ListOwnedArtifactsQuery {
    /// Only this repository.
    pub repository: Option<String>,
    /// Only this kind.
    pub kind: Option<ArtifactKind>,
    /// Only this state.
    pub state: Option<ArtifactState>,
}

/// Reads the raw query string the way Express and class-validator do: a repeated key is an array
/// (not a string, not one of the allowed values), unknown keys are dropped. `with_owner` is
/// `ListArtifactsQuery` (reads `issueId`); without it, `ListOwnedArtifactsQuery`.
///
/// # Errors
///
/// 400 with every class-validator message, in declaration order.
pub fn parse_filter(raw: Option<&str>, with_owner: bool) -> Result<ArtifactFilter, AppError> {
    let mut values: Vec<(String, Vec<String>)> = Vec::new();
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        match values.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(value.into_owned()),
            None => values.push((key.into_owned(), vec![value.into_owned()])),
        }
    }
    // a repeated key is a list, which is neither a string nor an allowed value
    let get = |name: &str| -> Option<Value> {
        let (_, list) = values.iter().find(|(k, _)| k == name)?;
        Some(match list.as_slice() {
            [one] => Value::String(one.clone()),
            _ => Value::Array(list.iter().cloned().map(Value::String).collect()),
        })
    };
    let mut c = Checks::new();
    let issue_id = if with_owner {
        optional(get("issueId"), |v| text(&mut c, "issueId", v, None, None))
    } else {
        None
    };
    let repository = optional(get("repository"), |v| text(&mut c, "repository", v, None, None));
    let kind = optional(get("kind"), |v| {
        one_of(&mut c, "kind", v, ArtifactKind::ALL, ArtifactKind::as_str)
    });
    let state = optional(get("state"), |v| {
        one_of(&mut c, "state", v, ArtifactState::ALL, ArtifactState::as_str)
    });
    c.finish()?;
    Ok(ArtifactFilter { issue_id, repository, kind, state })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn create(body: &Value) -> Result<(ArtifactKind, ArtifactInput), String> {
        serde_json::from_value::<CreateArtifactBody>(body.clone())
            .unwrap()
            .validate()
            .map_err(|e| msg(&e))
    }

    fn update(body: &Value) -> Result<ArtifactInput, String> {
        serde_json::from_value::<UpdateArtifactBody>(body.clone())
            .unwrap()
            .validate()
            .map_err(|e| msg(&e))
    }

    /// The message without the status `Display` puts in front of it.
    fn msg(err: &AppError) -> String {
        err.to_string().split_once(": ").map(|(_, m)| m.to_owned()).unwrap_or_default()
    }

    #[test]
    fn create_reads_every_field() {
        let (kind, input) = create(&json!({
            "issueId": "in_1", "description": "d", "kind": "pull_request", "title": "t",
            "repository": "a/b", "provider": "github", "url": "https://x.test",
            "externalId": "#1", "state": "draft", "ci": "failing", "review": "requested",
            "hasConflicts": true, "environment": "prod", "extra": 1,
        }))
        .unwrap();
        assert_eq!(kind, ArtifactKind::PullRequest);
        assert_eq!(input.issue_id, Patch::Value("in_1".into()));
        assert_eq!(input.provider, Some(ArtifactProvider::Github));
        assert_eq!(input.state, Some(ArtifactState::Draft));
        assert_eq!(input.ci, Patch::Value(CiState::Failing));
        assert_eq!(input.review, Patch::Value(ReviewState::Requested));
        assert_eq!(input.has_conflicts, Patch::Value(true));
        assert!(input.reviewer_user_ids.is_empty());
    }

    #[test]
    fn create_treats_null_as_absent() {
        let (_, input) =
            create(&json!({ "kind": "document", "title": null, "url": null, "issueId": null }))
                .unwrap();
        assert_eq!(input.title, None);
        assert!(input.url.is_missing() && input.issue_id.is_missing());
    }

    #[test]
    fn create_reports_class_validator_messages() {
        let kinds = "kind must be one of the following values: pull_request, merge_request, document, link, design, image, file, build, test_report, deployment, release";
        assert_eq!(create(&json!({})).unwrap_err(), kinds);
        assert_eq!(create(&json!({ "kind": "x" })).unwrap_err(), kinds);
        assert_eq!(
            create(&json!({ "kind": "document", "title": 5, "hasConflicts": "y" })).unwrap_err(),
            "title must be shorter than or equal to 300 characters; title must be longer than or equal to 1 characters; title must be a string; hasConflicts must be a boolean value"
        );
        assert_eq!(
            create(&json!({ "kind": "document", "title": "", "description": "x".repeat(10001) }))
                .unwrap_err(),
            "description must be shorter than or equal to 10000 characters; title must be longer than or equal to 1 characters"
        );
        assert_eq!(
            create(&json!({
                "kind": "link", "url": "x".repeat(1001), "externalId": "y".repeat(201),
                "environment": "z".repeat(101), "issueId": 3, "repository": [],
            }))
            .unwrap_err(),
            "issueId must be a string; repository must be a string; url must be shorter than or equal to 1000 characters; externalId must be shorter than or equal to 200 characters; environment must be shorter than or equal to 100 characters"
        );
        let err = create(&json!({ "kind": "link", "provider": "svn", "state": "x", "ci": "x" }))
            .unwrap_err();
        assert!(err.contains("provider must be one of the following values: github, gitlab, bitbucket, delta, figma, docs, ci, other; state must be one of the following values: draft, open"), "{err}");
        assert!(err.ends_with("ci must be one of the following values: pending, passing, failing"));
    }

    #[test]
    fn update_tells_clearable_from_not_null() {
        let patch = update(&json!({
            "issueId": null, "description": null, "repository": null, "url": null,
            "externalId": null, "ci": null, "review": null, "hasConflicts": null,
            "environment": null,
        }))
        .unwrap();
        assert_eq!(patch.issue_id, Patch::Null);
        assert_eq!(patch.ci, Patch::Null);
        assert_eq!(patch.has_conflicts, Patch::Null);
        assert_eq!(patch.title, None);

        let err = update(&json!({ "title": null, "provider": null, "state": null })).unwrap_err();
        assert!(err.starts_with("title must be shorter than or equal to 300 characters; title must be longer than or equal to 1 characters; title must be a string; provider must be one of"), "{err}");
        assert!(err.contains("state must be one of the following values: draft"));
    }

    #[test]
    fn update_ignores_what_it_does_not_carry() {
        let patch = update(&json!({ "kind": "nope", "title": "t" })).unwrap();
        assert_eq!(patch.title.as_deref(), Some("t"));
    }

    #[test]
    fn queries_are_checked() {
        let all =
            parse_filter(Some("issueId=in_1&repository=a%2Fb&kind=link&state=open&x=1"), true)
                .unwrap();
        assert_eq!(all.issue_id.as_deref(), Some("in_1"));
        assert_eq!(all.repository.as_deref(), Some("a/b"));
        assert_eq!(all.kind, Some(ArtifactKind::Link));
        assert_eq!(all.state, Some(ArtifactState::Open));
        // the owner of a nested route is not read from the query
        assert_eq!(parse_filter(Some("issueId=in_1"), false).unwrap().issue_id, None);
        assert_eq!(parse_filter(None, true).unwrap(), ArtifactFilter::default());
        let err = parse_filter(Some("issueId=a&issueId=b&kind=x&state="), true).unwrap_err();
        assert!(
            msg(&err).starts_with(
                "issueId must be a string; kind must be one of the following values: pull_request"
            ),
            "{err}"
        );
        assert!(msg(&err).contains("state must be one of the following values: draft"));
        assert!(parse_filter(Some("kind=link&kind=link"), true).is_err());
    }
}
