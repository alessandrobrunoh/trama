//! Request validation in the style of the NestJS `ValidationPipe` (class-validator).
//!
//! Type errors come from serde when [`crate::ApiJson`] deserializes the body (their wording
//! differs from class-validator's). Value rules are checked with [`Checks`], which collects every
//! failure and reports them together, with class-validator's messages:
//!
//! ```
//! use trama_core::validation::Checks;
//!
//! # fn run(name: &str, priority: &str) -> Result<(), trama_core::AppError> {
//! let mut c = Checks::new();
//! c.not_empty("name", name)
//!     .max_length("name", name, 200)
//!     .one_of("priority", priority, &["low", "medium", "high"]);
//! c.finish()
//! # }
//! ```
//!
//! For PATCH bodies, use [`Patch`] where NestJS used `@Clearable()`: it tells an absent field
//! (leave unchanged) from `null` (clear) and a value (set).

use serde::{Deserialize, Deserializer};

use crate::AppError;

/// A PATCH field: absent, `null`, or a value.
///
/// The field must carry `#[serde(default)]` so an absent key becomes [`Patch::Missing`]:
///
/// ```
/// #[derive(serde::Deserialize)]
/// struct UpdateIssue {
///     #[serde(default)]
///     estimate: trama_core::validation::Patch<f64>,
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Patch<T> {
    /// The key was not sent: leave the stored value alone.
    #[default]
    Missing,
    /// The key was sent as `null`: clear the stored value.
    Null,
    /// The key was sent with a value: store it.
    Value(T),
}

impl<T> Patch<T> {
    /// `true` when the key was not sent.
    #[must_use]
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    /// `None` when absent, `Some(None)` for `null`, `Some(Some(v))` for a value.
    #[must_use]
    pub fn into_option(self) -> Option<Option<T>> {
        match self {
            Self::Missing => None,
            Self::Null => Some(None),
            Self::Value(v) => Some(Some(v)),
        }
    }

    /// The value, when one was sent.
    #[must_use]
    pub fn as_value(&self) -> Option<&T> {
        match self {
            Self::Value(v) => Some(v),
            _ => None,
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::<T>::deserialize(deserializer)?.map_or(Self::Null, Self::Value))
    }
}

/// Collects failed checks and turns them into one 400 with every message.
#[derive(Debug, Default)]
#[must_use = "call finish() to report the failures"]
pub struct Checks(Vec<String>);

impl Checks {
    /// No failures yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `message` unless `ok`.
    pub fn check(&mut self, ok: bool, message: impl Into<String>) -> &mut Self {
        if !ok {
            self.0.push(message.into());
        }
        self
    }

    /// `@IsNotEmpty()`: the text is not empty.
    pub fn not_empty(&mut self, field: &str, value: &str) -> &mut Self {
        self.check(!value.is_empty(), format!("{field} should not be empty"))
    }

    /// `@MinLength(n)`, counted in UTF-16 units as JavaScript does.
    pub fn min_length(&mut self, field: &str, value: &str, n: usize) -> &mut Self {
        self.check(
            js_len(value) >= n,
            format!("{field} must be longer than or equal to {n} characters"),
        )
    }

    /// `@MaxLength(n)`, counted in UTF-16 units as JavaScript does.
    pub fn max_length(&mut self, field: &str, value: &str, n: usize) -> &mut Self {
        self.check(
            js_len(value) <= n,
            format!("{field} must be shorter than or equal to {n} characters"),
        )
    }

    /// `@Min(n)`.
    pub fn min(&mut self, field: &str, value: f64, n: f64) -> &mut Self {
        self.check(value >= n, format!("{field} must not be less than {n}"))
    }

    /// `@Max(n)`.
    pub fn max(&mut self, field: &str, value: f64, n: f64) -> &mut Self {
        self.check(value <= n, format!("{field} must not be greater than {n}"))
    }

    /// `@IsIn([...])`.
    pub fn one_of(&mut self, field: &str, value: &str, allowed: &[&str]) -> &mut Self {
        self.check(
            allowed.contains(&value),
            format!("{field} must be one of the following values: {}", allowed.join(", ")),
        )
    }

    /// `@IsEmail()`: a pragmatic check (one `@`, a dot in the domain, no spaces).
    pub fn email(&mut self, field: &str, value: &str) -> &mut Self {
        self.check(is_email(value), format!("{field} must be an email"))
    }

    /// `@ArrayMaxSize(n)`.
    pub fn max_items(&mut self, field: &str, len: usize, n: usize) -> &mut Self {
        self.check(len <= n, format!("{field} must contain no more than {n} elements"))
    }

    /// `Ok` when every check passed, otherwise a 400 listing the failures.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::validation`] with every recorded message.
    pub fn finish(self) -> Result<(), AppError> {
        if self.0.is_empty() { Ok(()) } else { Err(AppError::validation(self.0)) }
    }
}

/// Length of `value` as JavaScript's `String.length` reports it.
#[must_use]
pub fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else { return false };
    !local.is_empty()
        && !domain.contains('@')
        && !value.chars().any(char::is_whitespace)
        && domain.split('.').count() >= 2
        && domain.split('.').all(|part| !part.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[derive(Debug, Deserialize)]
    struct Body {
        #[serde(default)]
        estimate: Patch<f64>,
    }

    fn parse(json: &str) -> Patch<f64> {
        serde_json::from_str::<Body>(json).unwrap().estimate
    }

    #[test]
    fn patch_tells_missing_from_null() {
        assert_eq!(parse("{}"), Patch::Missing);
        assert_eq!(parse(r#"{"estimate":null}"#), Patch::Null);
        assert_eq!(parse(r#"{"estimate":3}"#), Patch::Value(3.0));
        assert_eq!(parse(r#"{"estimate":null}"#).into_option(), Some(None));
    }

    #[test]
    fn collects_every_failure() {
        let mut c = Checks::new();
        c.not_empty("title", "").max_length("title", "abcd", 3).one_of("p", "x", &["a", "b"]);
        let err = c.finish().unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
        assert!(err.to_string().contains("title should not be empty"));
        assert!(err.to_string().contains("must be one of the following values: a, b"));
    }

    #[test]
    fn passes_when_valid() {
        let mut c = Checks::new();
        c.min_length("name", "ab", 2).email("email", "a@b.dev").min("n", 1.0, 0.0);
        assert!(c.finish().is_ok());
    }

    #[test]
    fn counts_like_javascript() {
        assert_eq!(js_len("😀"), 2);
        let mut c = Checks::new();
        c.max_length("name", "😀😀", 3);
        assert!(c.finish().is_err());
    }

    #[test]
    fn checks_emails() {
        for ok in ["a@b.dev", "first.last+tag@sub.example.com"] {
            assert!(is_email(ok), "{ok}");
        }
        for bad in ["", "a", "a@b", "@b.dev", "a@@b.dev", "a b@c.dev", "a@b..dev"] {
            assert!(!is_email(bad), "{bad}");
        }
    }
}
