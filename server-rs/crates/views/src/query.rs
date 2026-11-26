//! Server-side evaluation of a saved view (filters, sort, group), used for the public link
//! (`view-query.ts`).
//!
//! It mirrors `src/app/core/query/{fields,query}.ts` with one deliberate difference: only the
//! fields listed in [`field_spec`] can be filtered, sorted or grouped on. An unknown field never
//! falls back to the raw property, so a crafted view cannot be used to probe columns the view
//! does not display.
//!
//! Rows are JSON objects keyed like the NestJS entities (`assigneeId`, `projectId`, …), with
//! dates already written as ISO strings.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde_json::{Map, Value};
use trama_contracts::views::{SortDirection, ViewEntity, ViewSort};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// A record of a view's entity, as the evaluator sees it.
pub type Row = Map<String, Value>;

/// What a field's value means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    /// One of a fixed list, sorted in the list's order.
    Enum,
    /// A reference to another record.
    Id,
    /// A list of references.
    MultiId,
    /// A list of labels.
    Tags,
    /// Free text.
    Text,
    /// An ISO date.
    Date,
}

/// What a reference field points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RefKind {
    /// A person.
    User,
    /// A project.
    Project,
}

/// One queryable field.
#[derive(Clone, Copy, Debug)]
pub struct FieldSpec {
    /// Kind of value.
    pub kind: FieldKind,
    /// The record a reference field names.
    pub refers_to: Option<RefKind>,
    /// Allowed values of an enum, in display order.
    pub values: &'static [&'static str],
}

const PRIORITIES: &[&str] = &["urgent", "high", "medium", "low", "none"];

const fn enum_of(values: &'static [&'static str]) -> FieldSpec {
    FieldSpec { kind: FieldKind::Enum, refers_to: None, values }
}
const fn reference(refers_to: RefKind) -> FieldSpec {
    FieldSpec { kind: FieldKind::Id, refers_to: Some(refers_to), values: &[] }
}
const fn plain(kind: FieldKind) -> FieldSpec {
    FieldSpec { kind, refers_to: None, values: &[] }
}

const ISSUE_FIELDS: &[(&str, FieldSpec)] = &[
    ("kind", enum_of(&["incident", "security", "bug", "feature", "tech_debt", "feedback", "idea"])),
    (
        "status",
        enum_of(&["draft", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]),
    ),
    ("assigneeId", reference(RefKind::User)),
    ("priority", enum_of(PRIORITIES)),
    ("source", enum_of(&["manual", "github", "gitlab", "linear", "email", "api", "agent"])),
    ("projectId", reference(RefKind::Project)),
    ("milestoneIds", plain(FieldKind::MultiId)),
    ("labels", plain(FieldKind::Tags)),
    ("title", plain(FieldKind::Text)),
    ("createdAt", plain(FieldKind::Date)),
    ("updatedAt", plain(FieldKind::Date)),
];

const PROJECT_FIELDS: &[(&str, FieldSpec)] = &[
    ("status", enum_of(&["backlog", "planned", "in_progress", "paused", "completed", "canceled"])),
    ("priority", enum_of(PRIORITIES)),
    ("health", enum_of(&["on_track", "at_risk", "off_track"])),
    ("leadId", reference(RefKind::User)),
    ("repository", plain(FieldKind::Text)),
    ("labels", plain(FieldKind::Tags)),
    ("targetDate", plain(FieldKind::Date)),
    ("startDate", plain(FieldKind::Date)),
    ("name", plain(FieldKind::Text)),
    ("createdAt", plain(FieldKind::Date)),
    ("updatedAt", plain(FieldKind::Date)),
];

/// `VIEW_FIELDS[entity][field]`: the queryable fields of an entity (own properties only, so
/// `__proto__` and the like are unknown).
#[must_use]
pub fn field_spec(entity: ViewEntity, field: &str) -> Option<&'static FieldSpec> {
    let fields = match entity {
        ViewEntity::Issue => ISSUE_FIELDS,
        ViewEntity::Project => PROJECT_FIELDS,
    };
    fields.iter().find(|(name, _)| *name == field).map(|(_, spec)| spec)
}

/// One filter of a stored view, read leniently: rows saved before the DTO validated `value` may
/// hold numbers or `null`, and an unreadable filter must match nothing, never throw.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryFilter {
    /// Filtered field (`""` when the stored filter had none).
    pub field: String,
    /// Operator (`""` when the stored filter had none).
    pub op: String,
    /// The stored value, whatever it is.
    pub value: Value,
}

impl QueryFilter {
    /// Reads one stored filter.
    #[must_use]
    pub fn from_json(value: &Value) -> Self {
        let text =
            |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        Self {
            field: text("field"),
            op: text("op"),
            value: value.get("value").cloned().unwrap_or(Value::Null),
        }
    }

    /// Reads a stored list of filters (anything but a list is no filters).
    #[must_use]
    pub fn list_from_json(value: &Value) -> Vec<Self> {
        value.as_array().map(|list| list.iter().map(Self::from_json).collect()).unwrap_or_default()
    }
}

/// `String(value)` for a JSON value, as JavaScript renders it.
#[must_use]
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `toStrings`: the value as strings (empty = no value).
fn to_strings(raw: Option<&Value>) -> Vec<String> {
    match raw {
        None | Some(Value::Null | Value::Object(_)) => Vec::new(),
        Some(Value::String(s)) if s.is_empty() => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Number(n)) => vec![n.to_string()],
        Some(Value::Bool(b)) => vec![b.to_string()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
    }
}

/// All values of `field` on `item` as strings (empty = no value). Unknown fields have no value.
#[must_use]
pub fn field_values(entity: ViewEntity, item: &Row, field: &str) -> Vec<String> {
    if field_spec(entity, field).is_none() {
        return Vec::new();
    }
    to_strings(item.get(field))
}

/// The filter's value as a list of strings; `null` and `undefined` entries read as `''`.
fn wanted(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(js_string).collect(),
        other => vec![js_string(other)],
    }
}

/// JavaScript's `Number(text)`.
fn js_number(text: &str) -> f64 {
    let t = trama_contracts::js::trim(text);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            #[allow(clippy::cast_precision_loss)]
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E')) {
        t.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `matchesFilter`. An operator this server does not know never matches, so it can never widen
/// what an anonymous reader sees.
#[must_use]
pub fn matches_filter(entity: ViewEntity, item: &Row, filter: &QueryFilter) -> bool {
    let values = field_values(entity, item, &filter.field);
    let want = wanted(&filter.value);
    let first = want.first().map(String::as_str);
    let has = |w: &str| values.iter().any(|v| v == w);
    match filter.op.as_str() {
        "is" => match first {
            Some("") => values.is_empty(),
            Some(w) => has(w),
            None => false,
        },
        "is_not" => match first {
            Some("") => !values.is_empty(),
            Some(w) => !has(w),
            None => true,
        },
        "in" => want.iter().any(|w| if w.is_empty() { values.is_empty() } else { has(w) }),
        "not_in" => !want.iter().any(|w| if w.is_empty() { values.is_empty() } else { has(w) }),
        "contains" => {
            let needle = first.unwrap_or_default().to_lowercase();
            values.iter().any(|v| v.to_lowercase().contains(&needle))
        }
        "before" => {
            matches!((values.first(), first), (Some(have), Some(limit)) if have.as_str() < limit)
        }
        "after" => {
            matches!((values.first(), first), (Some(have), Some(limit)) if have.as_str() > limit)
        }
        op @ ("gte" | "lte") => {
            let (Some(have), Some(limit)) = (values.first(), first) else { return false };
            let (have, limit) = (js_number(have), js_number(limit));
            if have.is_nan() || limit.is_nan() {
                return false;
            }
            if op == "gte" { have >= limit } else { have <= limit }
        }
        _ => false,
    }
}

/// `applyFilters`: the items that match every filter, in order.
#[must_use]
pub fn apply_filters<'a>(
    entity: ViewEntity,
    items: &'a [Row],
    filters: &[QueryFilter],
) -> Vec<&'a Row> {
    items.iter().filter(|item| filters.iter().all(|f| matches_filter(entity, item, f))).collect()
}

/// A character's rank in the collation: whitespace, then punctuation and symbols, digits,
/// letters.
fn char_class(c: char) -> u8 {
    if c.is_whitespace() {
        0
    } else if c.is_alphanumeric() {
        2
    } else {
        1
    }
}

/// The text without accents, in lower case (`sensitivity: 'base'`).
fn base_chars(text: &str) -> Vec<char> {
    text.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
}

/// One step of a natural-order comparison.
enum Piece<'a> {
    Number(&'a [char]),
    Char(char),
}

fn pieces(chars: &[char]) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            out.push(Piece::Number(&chars[start..i]));
        } else {
            out.push(Piece::Char(chars[i]));
            i += 1;
        }
    }
    out
}

fn compare_numbers(a: &[char], b: &[char]) -> Ordering {
    let strip = |digits: &[char]| {
        let zeros = digits.iter().take_while(|c| **c == '0').count();
        digits[zeros..].to_vec()
    };
    let (a, b) = (strip(a), strip(b));
    a.len().cmp(&b.len()).then_with(|| a.cmp(&b))
}

fn compare_pieces(a: &Piece<'_>, b: &Piece<'_>) -> Ordering {
    match (a, b) {
        (Piece::Number(x), Piece::Number(y)) => compare_numbers(x, y),
        // a digit sorts after punctuation and before letters
        (Piece::Number(_), Piece::Char(c)) => 2u8.cmp(&char_class(*c)).then(Ordering::Less),
        (Piece::Char(c), Piece::Number(_)) => char_class(*c).cmp(&2u8).then(Ordering::Greater),
        (Piece::Char(x), Piece::Char(y)) => {
            char_class(*x).cmp(&char_class(*y)).then_with(|| x.cmp(y))
        }
    }
}

/// `a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`: digit runs compare
/// as numbers, case and accents do not matter. An approximation of the ICU collation that
/// covers Latin text.
#[must_use]
pub fn compare_base(a: &str, b: &str) -> Ordering {
    let (a, b) = (base_chars(a), base_chars(b));
    let (pa, pb) = (pieces(&a), pieces(&b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let order = compare_pieces(x, y);
        if order != Ordering::Equal {
            return order;
        }
    }
    pa.len().cmp(&pb.len())
}

/// `a.localeCompare(b)`: like [`compare_base`] without the numeric mode, and lower case sorts
/// before upper case when nothing else differs.
fn compare_text(a: &str, b: &str) -> Ordering {
    let (ba, bb) = (base_chars(a), base_chars(b));
    let primary = ba
        .iter()
        .zip(bb.iter())
        .map(|(x, y)| char_class(*x).cmp(&char_class(*y)).then_with(|| x.cmp(y)))
        .find(|order| *order != Ordering::Equal)
        .unwrap_or_else(|| ba.len().cmp(&bb.len()));
    primary.then_with(|| {
        a.nfd()
            .zip(b.nfd())
            .map(|(x, y)| match (x.is_lowercase(), y.is_lowercase()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => x.cmp(&y),
            })
            .find(|order| *order != Ordering::Equal)
            .unwrap_or(Ordering::Equal)
    })
}

fn enum_order(entity: ViewEntity, field: &str, value: &str) -> usize {
    field_spec(entity, field)
        .and_then(|spec| spec.values.iter().position(|v| *v == value))
        .unwrap_or(usize::MAX)
}

fn compare_field(entity: ViewEntity, field: &str, a: &str, b: &str) -> Ordering {
    if field_spec(entity, field).is_some_and(|spec| spec.kind == FieldKind::Enum) {
        let (oa, ob) = (enum_order(entity, field, a), enum_order(entity, field, b));
        if oa != ob {
            return oa.cmp(&ob);
        }
    }
    compare_base(a, b)
}

/// `sortItems`: stable sort by a field; items without a value go last in both directions. A
/// field outside the whitelist does not sort.
#[must_use]
pub fn sort_items<'a>(
    entity: ViewEntity,
    items: Vec<&'a Row>,
    sort: Option<&ViewSort>,
) -> Vec<&'a Row> {
    let Some(sort) = sort.filter(|s| field_spec(entity, &s.field).is_some()) else {
        return items;
    };
    let descending = sort.direction == SortDirection::Desc;
    let mut keyed: Vec<(usize, Option<String>, &Row)> = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            (index, field_values(entity, item, &sort.field).into_iter().next(), item)
        })
        .collect();
    keyed.sort_by(|x, y| match (&x.1, &y.1) {
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (None, None) => x.0.cmp(&y.0),
        (Some(a), Some(b)) => {
            let order = compare_field(entity, &sort.field, a, b);
            let order = if descending { order.reverse() } else { order };
            order.then_with(|| x.0.cmp(&y.0))
        }
    });
    keyed.into_iter().map(|(_, _, item)| item).collect()
}

/// A group of items sharing a value.
#[derive(Clone, Debug)]
pub struct Group<'a> {
    /// `""` = no value.
    pub key: String,
    /// Members.
    pub items: Vec<&'a Row>,
}

/// `groupItems`: group by a field (multi-valued fields place an item in each group); the "no
/// value" group is last. A field outside the whitelist gives one group of everything.
#[must_use]
pub fn group_items<'a>(
    entity: ViewEntity,
    items: &[&'a Row],
    group_by: Option<&str>,
) -> Vec<Group<'a>> {
    let Some(group_by) = group_by.filter(|f| field_spec(entity, f).is_some()) else {
        return vec![Group { key: String::new(), items: items.to_vec() }];
    };
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Group<'a>> = Vec::new();
    for item in items {
        let mut keys = field_values(entity, item, group_by);
        if keys.is_empty() {
            keys.push(String::new());
        }
        for key in keys {
            let at = *positions.entry(key.clone()).or_insert_with(|| {
                groups.push(Group { key, items: Vec::new() });
                groups.len() - 1
            });
            groups[at].items.push(item);
        }
    }
    let is_enum = field_spec(entity, group_by).is_some_and(|spec| spec.kind == FieldKind::Enum);
    groups.sort_by(|a, b| {
        if a.key.is_empty() || b.key.is_empty() {
            return if a.key.is_empty() { Ordering::Greater } else { Ordering::Less };
        }
        if is_enum {
            let order =
                enum_order(entity, group_by, &a.key).cmp(&enum_order(entity, group_by, &b.key));
            if order != Ordering::Equal {
                return order;
            }
        }
        compare_text(&a.key, &b.key)
    });
    groups
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(value: &Value) -> Row {
        value.as_object().unwrap().clone()
    }

    fn items() -> Vec<Row> {
        vec![
            row(
                &json!({"id": "a", "status": "todo", "priority": "low", "title": "B", "teamId": "t1",
                "body": "secret", "updatedAt": "2026-01-02T00:00:00.000Z", "projectId": "p9"}),
            ),
            row(
                &json!({"id": "b", "status": "done", "priority": "urgent", "title": "A", "teamId": null,
                "body": "hidden", "updatedAt": "2026-01-01T00:00:00.000Z", "projectId": "p2"}),
            ),
            row(
                &json!({"id": "c", "status": "todo", "priority": "urgent", "title": "C", "teamId": "t1",
                "body": "x", "updatedAt": "2026-01-03T00:00:00.000Z", "projectId": null}),
            ),
        ]
    }

    fn filter(field: &str, op: &str, value: Value) -> QueryFilter {
        QueryFilter { field: field.into(), op: op.into(), value }
    }

    fn ids(rows: &[&Row]) -> Vec<String> {
        rows.iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
    }

    fn sorted(rows: &[Row], field: &str, direction: SortDirection) -> Vec<String> {
        let sort = ViewSort { field: field.into(), direction };
        ids(&sort_items(ViewEntity::Issue, rows.iter().collect(), Some(&sort)))
    }

    #[test]
    fn filters_sorts_by_enum_order_and_groups() {
        let rows = items();
        let issue = ViewEntity::Issue;
        assert_eq!(
            ids(&apply_filters(issue, &rows, &[filter("status", "is", json!("todo"))])),
            ["a", "c"]
        );
        assert_eq!(
            ids(&apply_filters(issue, &rows, &[filter("projectId", "is", json!(""))])),
            ["c"]
        );
        assert_eq!(sorted(&rows, "priority", SortDirection::Asc), ["b", "c", "a"]);
        assert_eq!(sorted(&rows, "title", SortDirection::Desc), ["c", "a", "b"]);
        let refs: Vec<&Row> = rows.iter().collect();
        let keys: Vec<String> =
            group_items(issue, &refs, Some("status")).into_iter().map(|g| g.key).collect();
        assert_eq!(keys, ["todo", "done"]);
    }

    #[test]
    fn filters_issues_by_their_direct_project_assignment() {
        let rows = items();
        assert_eq!(field_values(ViewEntity::Issue, &rows[0], "projectId"), ["p9"]);
        assert_eq!(
            ids(&apply_filters(
                ViewEntity::Issue,
                &rows,
                &[filter("projectId", "in", json!(["p9", "p2"]))]
            )),
            ["a", "b"]
        );
    }

    #[test]
    fn never_reads_fields_outside_the_queryable_whitelist() {
        let rows = items();
        let issue = ViewEntity::Issue;
        assert!(field_values(issue, &rows[0], "body").is_empty());
        assert!(field_values(issue, &rows[0], "workspaceId").is_empty());
        assert!(
            apply_filters(issue, &rows, &[filter("body", "contains", json!("secret"))]).is_empty()
        );
        assert_eq!(sorted(&rows, "body", SortDirection::Asc), ["a", "b", "c"]);
        let refs: Vec<&Row> = rows.iter().collect();
        let groups = group_items(issue, &refs, Some("body"));
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].key, "");
        assert_eq!(groups[0].items.len(), 3);
        assert!(field_values(issue, &rows[0], "__proto__").is_empty());
    }

    #[test]
    fn retired_fields_do_not_filter_read_or_group() {
        let issue = row(&json!({
            "id": "in_a", "title": "A", "teamId": "t1", "releaseId": "rel_1", "customerCount": 4
        }));
        let rows = [issue];
        for field in
            ["teamId", "releaseId", "customerId", "customerCount", "teamIds", "repositoryIds"]
        {
            assert!(field_values(ViewEntity::Issue, &rows[0], field).is_empty());
            assert!(
                apply_filters(ViewEntity::Issue, &rows, &[filter(field, "is", json!("t1"))])
                    .is_empty()
            );
            let refs: Vec<&Row> = rows.iter().collect();
            let groups = group_items(ViewEntity::Issue, &refs, Some(field));
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].key, "");
            assert_eq!(ids(&groups[0].items), ["in_a"]);
        }
    }

    #[test]
    fn legacy_filter_values_never_throw() {
        let rows = [row(&json!({"title": "Fix 5 bugs"}))];
        let issue = ViewEntity::Issue;
        let matches =
            |op: &str, value: Value| matches_filter(issue, &rows[0], &filter("title", op, value));
        assert!(matches("contains", json!(5)));
        assert!(matches("contains", Value::Null));
        assert!(!matches("is", json!(7)));
    }

    #[test]
    fn operators_follow_the_evaluator() {
        let rows = items();
        let issue = ViewEntity::Issue;
        let on = |field: &str, op: &str, value: Value| {
            ids(&apply_filters(issue, &rows, &[filter(field, op, value)]))
        };
        assert_eq!(on("status", "is_not", json!("todo")), ["b"]);
        assert_eq!(on("projectId", "is_not", json!("")), ["a", "b"]);
        assert_eq!(on("status", "in", json!(["done", "backlog"])), ["b"]);
        assert_eq!(on("status", "not_in", json!(["done"])), ["a", "c"]);
        assert_eq!(on("projectId", "not_in", json!([""])), ["a", "b"]);
        assert_eq!(on("title", "contains", json!("b")), ["a"]);
        assert_eq!(on("updatedAt", "before", json!("2026-01-02")), ["b"]);
        assert_eq!(on("updatedAt", "after", json!("2026-01-02T00:00:00.000Z")), ["c"]);
        // an operator the server does not know never widens the result
        assert!(on("status", "overdue", json!("todo")).is_empty());
        assert!(on("status", "", json!("todo")).is_empty());
        // numbers: values are compared as numbers, anything else does not match
        let numbers = [row(&json!({"id": "n", "title": "12"}))];
        let num = |op: &str, value: Value| {
            matches_filter(issue, &numbers[0], &filter("title", op, value))
        };
        assert!(num("gte", json!("9")));
        assert!(!num("lte", json!("9")));
        assert!(num("lte", json!("12")));
        assert!(!num("gte", json!("abc")));
    }

    #[test]
    fn multi_valued_fields_land_in_every_group() {
        let rows = [
            row(&json!({"id": "a", "labels": ["x", "y"]})),
            row(&json!({"id": "b", "labels": []})),
            row(&json!({"id": "c", "labels": ["y"]})),
        ];
        let refs: Vec<&Row> = rows.iter().collect();
        let groups = group_items(ViewEntity::Issue, &refs, Some("labels"));
        let summary: Vec<(String, Vec<String>)> =
            groups.iter().map(|g| (g.key.clone(), ids(&g.items))).collect();
        assert_eq!(
            summary,
            [
                ("x".to_owned(), vec!["a".to_owned()]),
                ("y".to_owned(), vec!["a".to_owned(), "c".to_owned()]),
                (String::new(), vec!["b".to_owned()]),
            ]
        );
    }

    #[test]
    fn items_without_a_value_sort_last_in_both_directions() {
        let rows = [
            row(&json!({"id": "a", "title": "b"})),
            row(&json!({"id": "n"})),
            row(&json!({"id": "c", "title": "a"})),
        ];
        assert_eq!(sorted(&rows, "title", SortDirection::Asc), ["c", "a", "n"]);
        assert_eq!(sorted(&rows, "title", SortDirection::Desc), ["a", "c", "n"]);
    }

    #[test]
    fn compares_text_naturally_ignoring_case() {
        assert_eq!(compare_base("item 2", "Item 10"), Ordering::Less);
        assert_eq!(compare_base("a", "A"), Ordering::Equal);
        assert_eq!(compare_base("é", "e"), Ordering::Equal);
        assert_eq!(compare_base("b", "a"), Ordering::Greater);
        assert_eq!(compare_base("a-1", "a1"), Ordering::Less);
        assert_eq!(compare_text("a", "A"), Ordering::Less);
        assert!((js_number(" 12 ") - 12.0).abs() < f64::EPSILON);
        assert!(js_number("1x").is_nan());
        assert!(js_number("").abs() < f64::EPSILON);
    }
}
