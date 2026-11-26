//! Small helpers from `server/src/common/util.ts`. Ids (`uid`) and the `X "id" not found`
//! error live in `trama_core` (`ids::uid`, `AppError::entity_not_found`).

use std::collections::HashSet;
use std::hash::Hash;

use sea_orm::{DbErr, SqlErr};
use unicode_normalization::UnicodeNormalization;

/// A URL slug: lowercase, NFKD, every run of characters outside `a-z0-9` replaced by `-`,
/// no leading or trailing `-`, at most 40 characters (`Crème brûlée` → `cre-me-bru-le-e`, as
/// the NestJS `slugify` produces).
#[must_use]
pub fn slugify(input: &str) -> String {
    let normalized: String = input.to_lowercase().nfkd().collect();
    let mut out = String::with_capacity(normalized.len());
    let mut dash = false;
    for c in normalized.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.truncate(40);
    out
}

/// `items` without repeats, in first-seen order.
#[must_use]
pub fn unique<T: Clone + Eq + Hash>(items: &[T]) -> Vec<T> {
    let mut seen = HashSet::new();
    items.iter().filter(|i| seen.insert(*i)).cloned().collect()
}

/// `true` for a PostgreSQL unique-constraint violation (SQLSTATE 23505).
#[must_use]
pub fn is_unique_violation(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_like_nest() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  --Acme  Inc--  "), "acme-inc");
        assert_eq!(slugify("Café"), "cafe");
        assert_eq!(slugify("Crème brûlée"), "cre-me-bru-le-e");
        // NFKD runs after lowercasing: № becomes "No" and the capital N is dropped
        assert_eq!(slugify("ﬁle №5"), "file-o5");
        assert_eq!(slugify("日本"), "");
        assert_eq!(slugify(&"a".repeat(50)), "a".repeat(40));
        // the cut comes after trimming, so a slug may end with a dash, as in NestJS
        assert_eq!(slugify(&format!("{} b", "a".repeat(39))), format!("{}-", "a".repeat(39)));
    }

    #[test]
    fn unique_keeps_first_seen_order() {
        assert_eq!(unique(&["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
        assert!(unique::<u8>(&[]).is_empty());
    }

    #[test]
    fn other_errors_are_not_unique_violations() {
        assert!(!is_unique_violation(&DbErr::Custom("x".into())));
    }
}
