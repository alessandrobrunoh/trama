//! Issue keys such as `AUTH-42` (team key + number) found in free text (`keys.ts`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// `\b[A-Z][A-Z0-9]{1,9}-\d+\b`, with JavaScript's ASCII word boundary and digits.
static KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)[A-Z][A-Z0-9]{1,9}-[0-9]+(?-u:\b)").expect("the issue key pattern")
});
/// The same, case-insensitive, for branch names (`auth-42/replay-detection`).
static KEY_CI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)[A-Za-z][A-Za-z0-9]{1,9}-[0-9]+(?-u:\b)").expect("the issue key pattern")
});

/// Candidate issue keys found in free text (title, body, commit message).
///
/// `ignore_case` is for branch names. Results are upper-cased and de-duplicated (in order of
/// first appearance); with `known`, only keys it accepts are kept.
#[must_use]
pub fn extract_keys<S: AsRef<str>>(
    texts: &[S],
    ignore_case: bool,
    known: Option<&dyn Fn(&str) -> bool>,
) -> Vec<String> {
    let re = if ignore_case { &*KEY_CI } else { &*KEY };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for text in texts {
        for m in re.find_iter(text.as_ref()) {
            let key = m.as_str().to_uppercase();
            if known.is_none_or(|k| k(&key)) && seen.insert(key.clone()) {
                out.push(key);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_known(key: &str) -> bool {
        ["AUTH-42", "WEB-7", "PLAT-1"].contains(&key)
    }

    #[test]
    fn finds_keys_in_free_text_and_de_duplicates() {
        assert_eq!(
            extract_keys(&["Fix AUTH-42 and WEB-7 (see AUTH-42)"], false, None),
            ["AUTH-42", "WEB-7"]
        );
    }

    #[test]
    fn validates_against_known_issue_keys() {
        assert_eq!(
            extract_keys(&["AUTH-42 UTF-8 HTTP-2 NOPE-1"], false, Some(&is_known)),
            ["AUTH-42"]
        );
    }

    #[test]
    fn is_case_sensitive_for_text_but_not_for_branch_names() {
        assert!(extract_keys(&["auth-42 refactor"], false, None).is_empty());
        assert_eq!(
            extract_keys(&["feature/auth-42-refresh-rotation"], true, Some(&is_known)),
            ["AUTH-42"]
        );
    }

    #[test]
    fn respects_word_boundaries_and_ignores_empty_input() {
        assert!(extract_keys(&["XAUTH-420", "a-1", ""], false, Some(&is_known)).is_empty());
        assert_eq!(
            extract_keys(&["[AUTH-42]: title", "refs:WEB-7."], false, Some(&is_known)),
            ["AUTH-42", "WEB-7"]
        );
    }
}
