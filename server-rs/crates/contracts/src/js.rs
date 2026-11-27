//! JavaScript semantics the contract relies on.
//!
//! `domain.ts` measures strings in UTF-16 code units (`.length`, `.slice`), trims with the JS
//! whitespace set, tests truthiness, and `JSON.stringify` writes `2` (not `2.0`) for a whole
//! number. These helpers reproduce that so results match the NestJS API exactly.

use serde::Serializer;
use serde_json::Value;

/// `s.length` in JavaScript: the number of UTF-16 code units.
#[must_use]
pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Whether `c` is whitespace for `String.prototype.trim` and the regex class `\s`.
#[must_use]
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()` in JavaScript.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}

/// `s.slice(0, n)` in JavaScript, counting UTF-16 code units. A surrogate pair that would be cut
/// in half is left out (JavaScript would keep a lone surrogate, which a Rust string cannot hold).
#[must_use]
pub fn truncate(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (at, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..at];
        }
    }
    s
}

/// JavaScript truthiness of a JSON value: `null`, `false`, `0`, `NaN` and `""` are falsy.
#[must_use]
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Serializes an `f64` the way `JSON.stringify` does: whole numbers without a fraction.
///
/// # Errors
///
/// Returns the serializer's error.
#[allow(clippy::trivially_copy_pass_by_ref)] // serde's `serialize_with` passes a reference
pub fn number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let whole = value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0;
    if whole {
        #[allow(clippy::cast_possible_truncation)]
        return serializer.serialize_i64(*value as i64);
    }
    serializer.serialize_f64(*value)
}

/// [`number`] for an optional field (used with `skip_serializing_if = "Option::is_none"`).
///
/// # Errors
///
/// Returns the serializer's error.
#[allow(clippy::ref_option)] // serde's `serialize_with` passes a reference
pub fn opt_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => number(v, serializer),
        None => serializer.serialize_none(),
    }
}

/// [`number`] for every element of a list.
///
/// # Errors
///
/// Returns the serializer's error.
pub fn numbers<S: Serializer>(values: &[f64], serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = serializer.serialize_seq(Some(values.len()))?;
    for v in values {
        seq.serialize_element(&Number(*v))?;
    }
    seq.end()
}

struct Number(f64);

impl serde::Serialize for Number {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        number(&self.0, serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(len("a😀"), 3);
        assert_eq!(truncate("abc", 2), "ab");
        assert_eq!(truncate("a😀b", 2), "a");
        assert_eq!(truncate("a😀b", 3), "a😀");
        assert_eq!(truncate("ab", 5), "ab");
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(trim("\u{FEFF} x \u{3000}"), "x");
        assert_eq!(trim("\u{0085}x"), "\u{0085}x");
    }

    #[test]
    fn writes_whole_numbers_without_a_fraction() {
        #[derive(serde::Serialize)]
        struct N {
            #[serde(serialize_with = "number")]
            a: f64,
            #[serde(serialize_with = "number")]
            b: f64,
            #[serde(serialize_with = "numbers")]
            c: Vec<f64>,
        }
        let out = serde_json::to_string(&N { a: 2.0, b: 1.5, c: vec![1.0, 0.25] }).unwrap();
        assert_eq!(out, r#"{"a":2,"b":1.5,"c":[1,0.25]}"#);
    }
}
