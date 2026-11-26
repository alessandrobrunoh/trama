//! The class-validator rules the DTOs of this module use, with the messages (and the message
//! order) `ValidationPipe` produces.
//!
//! Bodies are read with every field as a [`Patch<Value>`](Patch), so a missing key, `null` and a
//! value of the wrong type all reach these checks the way they reach class-validator. A property's
//! decorators run bottom-up, so `@IsString() @MinLength(1) @MaxLength(80)` reports the maximum
//! first and `isString` last.

use serde_json::Value;
use trama_core::validation::{Checks, Patch, js_len};

/// What a property does when it is not set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// No `@IsOptional()`: every rule applies to a missing or `null` value.
    Required,
    /// `@IsOptional()` / `@Clearable()`: `null` and missing skip the rules.
    SkipUnset,
    /// `@OptionalNotNull()`: only a missing key skips the rules; `null` is checked.
    SkipMissing,
}

/// A body field: absent, `null` or a value.
pub type Field = Patch<Value>;

fn skipped(field: &Field, presence: Presence) -> bool {
    match presence {
        Presence::Required => false,
        Presence::SkipUnset => !matches!(field, Patch::Value(_)),
        Presence::SkipMissing => field.is_missing(),
    }
}

fn text(field: &Field) -> Option<&str> {
    field.as_value().and_then(Value::as_str)
}

/// `@IsString()`, then `@MinLength(min)` and `@MaxLength(max)` when given.
pub fn string(
    c: &mut Checks,
    presence: Presence,
    name: &str,
    field: &Field,
    min: Option<usize>,
    max: Option<usize>,
) {
    if skipped(field, presence) {
        return;
    }
    let s = text(field);
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
}

/// `@IsEmail()`.
pub fn email(c: &mut Checks, presence: Presence, name: &str, field: &Field) {
    if skipped(field, presence) {
        return;
    }
    let ok = text(field).is_some_and(|s| {
        let mut inner = Checks::new();
        inner.email(name, s);
        inner.finish().is_ok()
    });
    c.check(ok, format!("{name} must be an email"));
}

/// `@IsIn(allowed)`.
pub fn one_of(c: &mut Checks, presence: Presence, name: &str, field: &Field, allowed: &[&str]) {
    if skipped(field, presence) {
        return;
    }
    c.check(
        text(field).is_some_and(|s| allowed.contains(&s)),
        format!("{name} must be one of the following values: {}", allowed.join(", ")),
    );
}

/// `#rrggbb`, either case (`/^#[0-9a-fA-F]{6}$/`).
#[must_use]
pub fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// `@Matches(/^#[0-9a-fA-F]{6}$/, { message: '<name> must be #rrggbb' })`.
pub fn hex_color(c: &mut Checks, presence: Presence, name: &str, field: &Field) {
    if skipped(field, presence) {
        return;
    }
    c.check(text(field).is_some_and(is_hex_color), format!("{name} must be #rrggbb"));
}

/// `@IsString() @Matches(/^<prefix>/)`, with class-validator's default message.
pub fn starts_with(c: &mut Checks, presence: Presence, name: &str, field: &Field, prefix: &str) {
    if skipped(field, presence) {
        return;
    }
    let s = text(field);
    c.check(
        s.is_some_and(|s| s.starts_with(prefix)),
        format!("{name} must match /^{prefix}/ regular expression"),
    );
    c.check(s.is_some(), format!("{name} must be a string"));
}

/// `@IsBoolean()`.
pub fn boolean(c: &mut Checks, presence: Presence, name: &str, field: &Field) {
    if skipped(field, presence) {
        return;
    }
    c.check(
        matches!(field, Patch::Value(Value::Bool(_))),
        format!("{name} must be a boolean value"),
    );
}

/// `@IsArray() @IsString({ each: true })`, with `@MaxLength(each_max, { each: true })` when
/// given.
pub fn string_array(
    c: &mut Checks,
    presence: Presence,
    name: &str,
    field: &Field,
    each_max: Option<usize>,
) {
    if skipped(field, presence) {
        return;
    }
    // `each` validates every element of an array, and the value itself when it is not one
    let (all_short, all_strings, is_array) = match field.as_value() {
        Some(Value::Array(items)) => (
            items
                .iter()
                .all(|v| v.as_str().is_some_and(|s| each_max.is_none_or(|m| js_len(s) <= m))),
            items.iter().all(Value::is_string),
            true,
        ),
        other => (
            other.and_then(Value::as_str).is_some_and(|s| each_max.is_none_or(|m| js_len(s) <= m)),
            other.is_some_and(Value::is_string),
            false,
        ),
    };
    if let Some(max) = each_max {
        c.check(
            all_short,
            format!("each value in {name} must be shorter than or equal to {max} characters"),
        );
    }
    c.check(all_strings, format!("each value in {name} must be a string"));
    c.check(is_array, format!("{name} must be an array"));
}

/// The strings of an array field that passed [`string_array`] (anything else yields none).
#[must_use]
pub fn strings(field: &Field) -> Vec<String> {
    match field.as_value() {
        Some(Value::Array(items)) => {
            items.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect()
        }
        _ => Vec::new(),
    }
}

fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            n.is_i64()
                || n.is_u64()
                || n.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        }
        _ => false,
    }
}

/// `@IsInt() @Min(min) @Max(max)`.
#[allow(clippy::cast_precision_loss)]
pub fn integer(c: &mut Checks, presence: Presence, name: &str, field: &Field, min: i64, max: i64) {
    if skipped(field, presence) {
        return;
    }
    let n = field.as_value().and_then(Value::as_f64);
    c.check(n.is_some_and(|n| n <= max as f64), format!("{name} must not be greater than {max}"));
    c.check(n.is_some_and(|n| n >= min as f64), format!("{name} must not be less than {min}"));
    c.check(field.as_value().is_some_and(is_integer), format!("{name} must be an integer number"));
}

/// `@IsISO8601()`: the extended calendar forms JavaScript's `Date` also reads
/// (`2026-11-25`, `2026-11-25T14:01:36.424Z`, an offset instead of `Z`). Returns the instant.
pub fn iso8601(c: &mut Checks, presence: Presence, name: &str, field: &Field) {
    if skipped(field, presence) {
        return;
    }
    c.check(
        text(field).is_some_and(|s| parse_iso8601(s).is_some()),
        format!("{name} must be a valid ISO 8601 date string"),
    );
}

/// An ISO 8601 date or date-time as a UTC-anchored instant; a time without an offset is read as
/// UTC and a date alone is midnight UTC.
#[must_use]
pub fn parse_iso8601(value: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        return Some(at);
    }
    let value = value.replacen(' ', "T", 1);
    if let Ok(at) = DateTime::parse_from_rfc3339(&value) {
        return Some(at);
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(&value, format) {
            return Some(Utc.from_utc_datetime(&naive).fixed_offset());
        }
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M%:z", "%Y-%m-%dT%H:%M:%S%.f%#z"] {
        if let Ok(at) = DateTime::parse_from_str(&value, format) {
            return Some(at);
        }
    }
    let date = NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok()?;
    Some(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?).fixed_offset())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn value(v: Value) -> Field {
        Patch::Value(v)
    }

    fn messages(run: impl FnOnce(&mut Checks)) -> String {
        let mut c = Checks::new();
        run(&mut c);
        c.finish().map_or_else(|e| e.to_string(), |()| String::new())
    }

    #[test]
    fn strings_report_in_class_validator_order() {
        let missing = messages(|c| {
            string(c, Presence::Required, "name", &Patch::Missing, Some(1), Some(80));
        });
        assert_eq!(
            missing,
            "400 Bad Request: name must be shorter than or equal to 80 characters; name must be longer than or equal to 1 characters; name must be a string"
        );
        assert_eq!(
            messages(|c| string(
                c,
                Presence::Required,
                "name",
                &value(json!("")),
                Some(1),
                Some(80)
            )),
            "400 Bad Request: name must be longer than or equal to 1 characters"
        );
        assert_eq!(
            messages(|c| string(c, Presence::SkipMissing, "slug", &Patch::Null, None, Some(40))),
            "400 Bad Request: slug must be shorter than or equal to 40 characters; slug must be a string"
        );
        assert_eq!(
            messages(|c| string(c, Presence::SkipMissing, "slug", &Patch::Missing, None, Some(40))),
            ""
        );
        assert_eq!(
            messages(|c| string(c, Presence::SkipUnset, "slug", &Patch::Null, None, Some(40))),
            ""
        );
    }

    #[test]
    fn checks_the_other_decorators() {
        assert_eq!(
            messages(|c| one_of(
                c,
                Presence::Required,
                "scope",
                &value(json!("x")),
                &["issue", "project"]
            )),
            "400 Bad Request: scope must be one of the following values: issue, project"
        );
        assert_eq!(
            messages(|c| hex_color(c, Presence::SkipMissing, "color", &value(json!("#12345")))),
            "400 Bad Request: color must be #rrggbb"
        );
        assert_eq!(
            messages(|c| hex_color(c, Presence::Required, "color", &value(json!("#AbCdEf")))),
            ""
        );
        assert_eq!(
            messages(|c| starts_with(c, Presence::SkipUnset, "agentId", &value(json!("x")), "ag_")),
            "400 Bad Request: agentId must match /^ag_/ regular expression"
        );
        assert_eq!(
            messages(|c| boolean(c, Presence::SkipMissing, "archived", &value(json!("yes")))),
            "400 Bad Request: archived must be a boolean value"
        );
        assert_eq!(
            messages(|c| email(c, Presence::Required, "email", &value(json!("nope")))),
            "400 Bad Request: email must be an email"
        );
    }

    #[test]
    fn arrays_check_each_element() {
        assert_eq!(
            messages(|c| string_array(
                c,
                Presence::SkipUnset,
                "permissions",
                &value(json!(["a", 3])),
                Some(60)
            )),
            "400 Bad Request: each value in permissions must be shorter than or equal to 60 characters; each value in permissions must be a string"
        );
        assert_eq!(
            messages(|c| string_array(c, Presence::SkipUnset, "grants", &value(json!("x")), None)),
            "400 Bad Request: grants must be an array"
        );
        assert_eq!(
            messages(|c| string_array(c, Presence::SkipUnset, "grants", &value(json!(5)), None)),
            "400 Bad Request: each value in grants must be a string; grants must be an array"
        );
        assert_eq!(
            messages(|c| string_array(c, Presence::SkipUnset, "grants", &value(json!([])), None)),
            ""
        );
    }

    #[test]
    fn integers_are_bounded() {
        let run = |v: Value| {
            messages(|c| {
                integer(c, Presence::SkipUnset, "limits.writesPerDay", &value(v), 1, 20_000)
            })
        };
        assert_eq!(run(json!(5)), "");
        assert_eq!(run(json!(5.0)), "");
        assert_eq!(
            run(json!(10_000_000)),
            "400 Bad Request: limits.writesPerDay must not be greater than 20000"
        );
        assert_eq!(run(json!(0)), "400 Bad Request: limits.writesPerDay must not be less than 1");
        assert_eq!(
            run(json!(1.5)),
            "400 Bad Request: limits.writesPerDay must be an integer number"
        );
        assert_eq!(
            run(json!("5")),
            "400 Bad Request: limits.writesPerDay must not be greater than 20000; limits.writesPerDay must not be less than 1; limits.writesPerDay must be an integer number"
        );
    }

    #[test]
    fn reads_iso_dates() {
        for ok in [
            "2026-11-25",
            "2026-11-25T14:01:36.424Z",
            "2026-11-25T14:01:36+01:00",
            "2026-11-25T14:01",
        ] {
            assert!(parse_iso8601(ok).is_some(), "{ok}");
        }
        for bad in ["", "yesterday", "2026-13-01", "2026-02-31", "25/11/2026"] {
            assert!(parse_iso8601(bad).is_none(), "{bad}");
        }
        assert_eq!(parse_iso8601("2026-11-25").unwrap().to_rfc3339(), "2026-11-25T00:00:00+00:00");
        assert_eq!(
            messages(|c| iso8601(c, Presence::SkipUnset, "expiresAt", &value(json!("soon")))),
            "400 Bad Request: expiresAt must be a valid ISO 8601 date string"
        );
    }
}
