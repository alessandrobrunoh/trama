//! Request bodies of the AI routes (`server/src/ai/ai.dto.ts`), checked with class-validator's
//! rules and messages. The bodies are read as JSON values and validated by hand so that nested
//! and missing fields are reported the way the `ValidationPipe` reports them (decorators are
//! applied bottom-up, so the messages of one property come in reverse source order).

use serde_json::{Map, Value, json};
use trama_contracts::js;
use trama_core::AppError;

use crate::provider::{AiMessage, Role};

/// Where the person is looking when they chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatContextKind {
    /// A page without a record.
    Page,
    /// An issue.
    Issue,
    /// A project.
    Project,
}

/// `ChatContextDto`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatContext {
    /// `page`, `issue` or `project`.
    pub kind: ChatContextKind,
    /// Name of the page or record, at most 160 characters.
    pub label: String,
    /// Id or key of the record.
    pub id: Option<String>,
}

/// `ChatDto`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatRequest {
    /// 1 to 20 messages.
    pub messages: Vec<AiMessage>,
    /// Where the person is.
    pub context: Option<ChatContext>,
}

/// A person the draft may be assigned to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assignee {
    /// User id.
    pub id: String,
    /// Display name.
    pub label: String,
}

/// `IssueDraftOptionsDto`: the choices triage may pick from.
#[derive(Clone, Debug, PartialEq)]
pub struct IssueOptions {
    /// Allowed kinds.
    pub kinds: Vec<String>,
    /// Allowed priorities.
    pub priorities: Vec<String>,
    /// Allowed estimates.
    pub estimates: Vec<f64>,
    /// Allowed assignees.
    pub assignees: Vec<Assignee>,
    /// The options as sent to the model (known fields only).
    pub prompt: Value,
}

/// `SuggestionDto`.
#[derive(Clone, Debug, PartialEq)]
pub struct SuggestionRequest {
    /// Draft title, at most 300 characters.
    pub title: String,
    /// Draft description, at most 12000 characters.
    pub description: String,
    /// Triage choices.
    pub issue_options: Option<IssueOptions>,
}

/// Collects failed checks with class-validator's wording.
#[derive(Default)]
struct Problems(Vec<String>);

impl Problems {
    fn push(&mut self, message: String) {
        self.0.push(message);
    }

    fn finish(self) -> Result<(), AppError> {
        if self.0.is_empty() { Ok(()) } else { Err(AppError::validation(self.0)) }
    }

    /// `@IsString() [@MinLength(min)] @MaxLength(max)`.
    fn string(
        &mut self,
        path: &str,
        value: Option<&Value>,
        min: Option<usize>,
        max: usize,
    ) -> Option<String> {
        let text = value.and_then(Value::as_str);
        let length = text.map(js::len);
        if length.is_none_or(|n| n > max) {
            self.push(format!("{path} must be shorter than or equal to {max} characters"));
        }
        if let Some(min) = min
            && length.is_none_or(|n| n < min)
        {
            self.push(format!("{path} must be longer than or equal to {min} characters"));
        }
        if text.is_none() {
            self.push(format!("{path} must be a string"));
        }
        text.filter(|t| js::len(t) <= max && min.is_none_or(|m| js::len(t) >= m)).map(str::to_owned)
    }

    /// `@IsIn(allowed)`.
    fn one_of(&mut self, path: &str, value: Option<&Value>, allowed: &[&str]) -> Option<String> {
        let text = value.and_then(Value::as_str).filter(|t| allowed.contains(t));
        if text.is_none() {
            self.push(format!(
                "{path} must be one of the following values: {}",
                allowed.join(", ")
            ));
        }
        text.map(str::to_owned)
    }

    /// `@IsArray() @ArrayMaxSize(max) [@ArrayMinSize(min)]`, plus the nested-validation message
    /// when it is not an array.
    fn array<'a>(
        &mut self,
        path: &str,
        value: Option<&'a Value>,
        min: Option<usize>,
        max: usize,
        nested: bool,
    ) -> Option<&'a Vec<Value>> {
        let list = value.and_then(Value::as_array);
        if list.is_none() && nested {
            self.push(format!("nested property {path} must be either object or array"));
        }
        if let Some(min) = min
            && list.is_none_or(|l| l.len() < min)
        {
            self.push(format!("{path} must contain at least {min} elements"));
        }
        if list.is_none_or(|l| l.len() > max) {
            self.push(format!("{path} must contain no more than {max} elements"));
        }
        if list.is_none() {
            self.push(format!("{path} must be an array"));
        }
        list.filter(|l| l.len() <= max && min.is_none_or(|m| l.len() >= m))
    }

    /// `@IsString({ each: true }) @MaxLength(max, { each: true })` on the items of an array.
    fn strings(&mut self, path: &str, list: &[Value], max: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut not_strings = false;
        let mut too_long = false;
        for item in list {
            match item.as_str() {
                Some(text) if js::len(text) <= max => out.push(text.to_owned()),
                Some(_) => too_long = true,
                None => not_strings = true,
            }
        }
        if not_strings || too_long {
            self.push(format!(
                "each value in {path} must be shorter than or equal to {max} characters"
            ));
        }
        if not_strings {
            self.push(format!("each value in {path} must be a string"));
        }
        out
    }

    /// `@IsNumber({}, { each: true })` on the items of an array.
    fn numbers(&mut self, path: &str, list: &[Value]) -> Vec<f64> {
        let numbers: Vec<f64> = list.iter().filter_map(Value::as_f64).collect();
        if numbers.len() != list.len() {
            self.push(format!(
                "each value in {path} must be a number conforming to the specified constraints"
            ));
        }
        numbers
    }

    /// `@ValidateNested()` on one object: `Some` when it is an object.
    fn object<'a>(
        &mut self,
        path: &str,
        value: Option<&'a Value>,
    ) -> Option<&'a Map<String, Value>> {
        let object = value.and_then(Value::as_object);
        if object.is_none() {
            self.push(format!("nested property {path} must be either object or array"));
        }
        object
    }

    /// `@ValidateNested({ each: true })` on an array's items.
    fn objects<'a>(
        &mut self,
        path: &str,
        list: &'a [Value],
    ) -> Vec<(String, &'a Map<String, Value>)> {
        let mut out = Vec::new();
        for (i, item) in list.iter().enumerate() {
            match item.as_object() {
                Some(object) => out.push((format!("{path}.{i}"), object)),
                None => self.push(format!(
                    "each value in nested property {path} must be either object or array"
                )),
            }
        }
        out
    }

    /// `@IsOptional() @IsNumber()`: absent and `null` pass.
    fn optional_number(&mut self, path: &str, value: Option<&Value>) {
        if let Some(v) = value
            && !v.is_null()
            && !v.is_number()
        {
            self.push(format!("{path} must be a number conforming to the specified constraints"));
        }
    }
}

fn is_absent(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

fn body_object(body: &Value) -> Map<String, Value> {
    body.as_object().cloned().unwrap_or_default()
}

fn parse_options(problems: &mut Problems, value: &Value) -> Option<IssueOptions> {
    let object = problems.object("issueOptions", Some(value))?;
    let kinds = problems
        .array("issueOptions.kinds", object.get("kinds"), None, 10, false)
        .map(|l| problems.strings("issueOptions.kinds", l, 40));
    let priorities = problems
        .array("issueOptions.priorities", object.get("priorities"), None, 5, false)
        .map(|l| problems.strings("issueOptions.priorities", l, 40));
    let estimates = problems
        .array("issueOptions.estimates", object.get("estimates"), None, 12, false)
        .map(|l| problems.numbers("issueOptions.estimates", l));
    let mut assignees = Vec::new();
    if let Some(list) =
        problems.array("issueOptions.assignees", object.get("assignees"), None, 100, true)
    {
        for (path, item) in problems.objects("issueOptions.assignees", list) {
            let id = problems.string(&format!("{path}.id"), item.get("id"), None, 160);
            let label = problems.string(&format!("{path}.label"), item.get("label"), None, 240);
            if let (Some(id), Some(label)) = (id, label) {
                assignees.push(Assignee { id, label });
            }
        }
    }
    let mut similar = Vec::new();
    if let Some(list) = problems.array("issueOptions.similar", object.get("similar"), None, 4, true)
    {
        for (path, item) in problems.objects("issueOptions.similar", list) {
            let mut entry = Map::new();
            for (field, max) in [("key", 40), ("title", 240), ("kind", 40), ("priority", 40)] {
                if let Some(text) =
                    problems.string(&format!("{path}.{field}"), item.get(field), None, max)
                {
                    entry.insert(field.to_owned(), json!(text));
                }
            }
            for field in ["estimate", "cycleDays"] {
                problems.optional_number(&format!("{path}.{field}"), item.get(field));
                if let Some(v) = item.get(field).filter(|v| v.is_null() || v.is_number()) {
                    entry.insert(field.to_owned(), v.clone());
                }
            }
            similar.push(Value::Object(entry));
        }
    }
    let (kinds, priorities, estimates) = (kinds?, priorities?, estimates?);
    let prompt = json!({
        "kinds": kinds,
        "priorities": priorities,
        "estimates": estimates,
        "assignees": assignees.iter().map(|a| json!({ "id": a.id, "label": a.label })).collect::<Vec<_>>(),
        "similar": similar,
    });
    Some(IssueOptions { kinds, priorities, estimates, assignees, prompt })
}

/// `SuggestionDto`.
///
/// # Errors
///
/// 400 listing every failed rule.
pub fn parse_suggestion(body: &Value) -> Result<SuggestionRequest, AppError> {
    let body = body_object(body);
    let mut problems = Problems::default();
    let _ = problems.one_of("kind", body.get("kind"), &["issue"]);
    let title = problems.string("title", body.get("title"), None, 300);
    let description = problems.string("description", body.get("description"), None, 12_000);
    let issue_options = match body.get("issueOptions") {
        value if is_absent(value) => None,
        Some(value) => parse_options(&mut problems, value),
        None => None,
    };
    problems.finish()?;
    match (title, description) {
        (Some(title), Some(description)) => {
            Ok(SuggestionRequest { title, description, issue_options })
        }
        _ => Err(AppError::bad_request("Invalid request")),
    }
}

/// `ChatDto`.
///
/// # Errors
///
/// 400 listing every failed rule.
pub fn parse_chat(body: &Value) -> Result<ChatRequest, AppError> {
    let body = body_object(body);
    let mut problems = Problems::default();
    let mut messages = Vec::new();
    if let Some(list) = problems.array("messages", body.get("messages"), Some(1), 20, true) {
        for (path, item) in problems.objects("messages", list) {
            let role =
                problems.one_of(&format!("{path}.role"), item.get("role"), &["user", "assistant"]);
            let content =
                problems.string(&format!("{path}.content"), item.get("content"), Some(1), 16_000);
            if let (Some(role), Some(content)) = (role, content) {
                let role = if role == "user" { Role::User } else { Role::Assistant };
                messages.push(AiMessage::new(role, content));
            }
        }
    }
    let context = match body.get("context") {
        value if is_absent(value) => None,
        Some(value) => problems.object("context", Some(value)).map(|object| {
            let kind =
                problems.one_of("context.kind", object.get("kind"), &["page", "issue", "project"]);
            let label = problems.string("context.label", object.get("label"), None, 160);
            let id = if is_absent(object.get("id")) {
                None
            } else {
                problems.string("context.id", object.get("id"), None, 160)
            };
            (kind, label, id)
        }),
        None => None,
    };
    problems.finish()?;
    let context = context.and_then(|(kind, label, id)| {
        let kind = match kind?.as_str() {
            "issue" => ChatContextKind::Issue,
            "project" => ChatContextKind::Project,
            _ => ChatContextKind::Page,
        };
        Some(ChatContext { kind, label: label?, id })
    });
    Ok(ChatRequest { messages, context })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(err: &AppError) -> String {
        err.to_string()
    }

    #[test]
    fn accepts_a_valid_chat_and_drops_unknown_fields() {
        let chat = parse_chat(&json!({
            "messages": [{ "role": "user", "content": "hi", "extra": 1 }],
            "context": { "kind": "issue", "label": "BUG-1", "id": "BUG-1" },
        }))
        .unwrap();
        assert_eq!(chat.messages, vec![AiMessage::user("hi")]);
        assert_eq!(
            chat.context,
            Some(ChatContext {
                kind: ChatContextKind::Issue,
                label: "BUG-1".into(),
                id: Some("BUG-1".into())
            })
        );
        assert!(
            parse_chat(
                &json!({ "messages": [{ "role": "assistant", "content": "x" }], "context": null })
            )
            .unwrap()
            .context
            .is_none()
        );
    }

    #[test]
    fn reports_chat_problems_like_class_validator() {
        let err = parse_chat(&json!({})).unwrap_err();
        let text = messages(&err);
        assert!(text.contains("messages must contain at least 1 elements"), "{text}");
        assert!(text.contains("messages must be an array"), "{text}");

        let text = messages(&parse_chat(&json!({ "messages": [] })).unwrap_err());
        assert!(text.contains("messages must contain at least 1 elements"), "{text}");

        let many = vec![json!({ "role": "user", "content": "x" }); 21];
        let text = messages(&parse_chat(&json!({ "messages": many })).unwrap_err());
        assert!(text.contains("messages must contain no more than 20 elements"), "{text}");

        let text = messages(
            &parse_chat(&json!({ "messages": [{ "role": "system", "content": "" }] })).unwrap_err(),
        );
        assert!(
            text.contains("messages.0.role must be one of the following values: user, assistant"),
            "{text}"
        );
        assert!(
            text.contains("messages.0.content must be longer than or equal to 1 characters"),
            "{text}"
        );

        let long = "x".repeat(16_001);
        let text = messages(
            &parse_chat(&json!({ "messages": [{ "role": "user", "content": long }] })).unwrap_err(),
        );
        assert!(
            text.contains("messages.0.content must be shorter than or equal to 16000 characters"),
            "{text}"
        );

        let text = messages(
            &parse_chat(&json!({
                "messages": [{ "role": "user", "content": "x" }],
                "context": { "kind": "team", "label": 4 },
            }))
            .unwrap_err(),
        );
        assert!(
            text.contains("context.kind must be one of the following values: page, issue, project"),
            "{text}"
        );
        assert!(text.contains("context.label must be a string"), "{text}");
    }

    #[test]
    fn accepts_a_valid_suggestion_with_triage_options() {
        let request = parse_suggestion(&json!({
            "kind": "issue",
            "title": "Login fails",
            "description": "",
            "issueOptions": {
                "kinds": ["bug"], "priorities": ["high"], "estimates": [1, 2],
                "assignees": [{ "id": "u1", "label": "Ada", "x": 1 }],
                "similar": [{ "key": "A-1", "title": "t", "kind": "bug", "priority": "low", "estimate": null, "other": 1 }],
            },
        }))
        .unwrap();
        assert_eq!(request.title, "Login fails");
        let options = request.issue_options.unwrap();
        assert_eq!(options.estimates, vec![1.0, 2.0]);
        assert_eq!(options.assignees, vec![Assignee { id: "u1".into(), label: "Ada".into() }]);
        assert_eq!(
            options.prompt["similar"],
            json!([{ "key": "A-1", "title": "t", "kind": "bug", "priority": "low", "estimate": null }])
        );
    }

    #[test]
    fn reports_suggestion_problems_like_class_validator() {
        let text = messages(&parse_suggestion(&json!({ "kind": "project" })).unwrap_err());
        assert!(text.contains("kind must be one of the following values: issue"), "{text}");
        assert!(text.contains("title must be a string"), "{text}");
        assert!(text.contains("description must be a string"), "{text}");

        let text = messages(
            &parse_suggestion(&json!({
                "kind": "issue", "title": "t".repeat(301), "description": "d",
                "issueOptions": { "kinds": [1], "priorities": [], "estimates": ["a"], "assignees": [{}], "similar": 3 },
            }))
            .unwrap_err(),
        );
        assert!(text.contains("title must be shorter than or equal to 300 characters"), "{text}");
        assert!(text.contains("each value in issueOptions.kinds must be a string"), "{text}");
        assert!(text.contains("each value in issueOptions.estimates must be a number"), "{text}");
        assert!(text.contains("issueOptions.assignees.0.id must be a string"), "{text}");
        assert!(text.contains("issueOptions.similar must be an array"), "{text}");
    }
}
