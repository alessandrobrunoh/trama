//! Repository paths of a thread record (`server/src/threads/thread-paths.ts`): cleaning what an
//! agent sends and matching a decision's paths against a file.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use trama_contracts::js;
use trama_contracts::threads::THREAD_PATH_MAX;
use trama_core::AppError;

/// Why a path was refused, or `None` when it is fine (`pathProblem`).
#[must_use]
pub fn path_problem(raw: &str) -> Option<String> {
    let path = js::trim(raw);
    if path.is_empty() {
        return Some("is empty".to_owned());
    }
    if js::len(path) > THREAD_PATH_MAX {
        return Some(format!("is longer than {THREAD_PATH_MAX} characters"));
    }
    if path.contains('\0') {
        return Some("contains a null character".to_owned());
    }
    let mut chars = path.chars();
    let first = chars.next();
    let drive = first.is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':');
    if matches!(first, Some('/' | '\\' | '~')) || drive {
        return Some("must be relative to the repository".to_owned());
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Some("must not contain \"..\" segments".to_owned());
    }
    None
}

/// Trims a repository path and refuses absolute paths and `..` segments. The path is otherwise
/// kept as given (a prefix like `src/auth/` or a glob like `src/auth/*` stays what the agent
/// wrote).
///
/// # Errors
///
/// 400 `Path "<path>" <problem>`.
pub fn clean_thread_path(raw: &str) -> Result<String, AppError> {
    let path = js::trim(raw);
    match path_problem(path) {
        Some(problem) => {
            Err(AppError::bad_request(format!("Path \"{}\" {problem}", js::truncate(path, 80))))
        }
        None => Ok(path.to_owned()),
    }
}

/// Cleans a list of paths and drops duplicates, keeping the order.
///
/// # Errors
///
/// 400 for the first path that is refused.
pub fn clean_thread_paths<S: AsRef<str>>(raw: &[S]) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for path in raw {
        let clean = clean_thread_path(path.as_ref())?;
        if !out.contains(&clean) {
            out.push(clean);
        }
    }
    Ok(out)
}

/// Merges the files of a sync into the record: the new ones first (in the order sent), then the
/// ones the record already had, without duplicates, at most `max`.
#[must_use]
pub fn merge_files(existing: &[String], incoming: &[String], max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for file in incoming.iter().chain(existing) {
        if !out.contains(file) {
            out.push(file.clone());
        }
    }
    out.truncate(max);
    out
}

/// `./src//a\b` becomes `src/a/b`. Only used for comparing, never for storing.
fn normalize(path: &str) -> String {
    let mut out = js::trim(path).replace('\\', "/");
    while let Some(rest) = out.strip_prefix("./") {
        out = rest.to_owned();
    }
    while out.contains("//") {
        out = out.replace("//", "/");
    }
    out
}

static GLOBS: LazyLock<Mutex<HashMap<String, Regex>>> = LazyLock::new(Mutex::default);

/// `*` stays inside one path segment, `**` crosses segments, `**` followed by `/` may match
/// nothing.
fn glob_to_regex(pattern: &str) -> Regex {
    if let Some(cached) = GLOBS.lock().ok().and_then(|cache| cache.get(pattern).cloned()) {
        return cached;
    }
    // JavaScript's `.` leaves out every line terminator
    let any = "[^\\n\\r\\u{2028}\\u{2029}]";
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                    out.push_str("(?:");
                    out.push_str(any);
                    out.push_str("*/)?");
                } else {
                    out.push_str(any);
                    out.push('*');
                }
            } else {
                out.push_str("[^/]*");
            }
        } else {
            out.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    let re = Regex::new(&format!("^{out}$")).unwrap_or_else(|_| {
        // an escaped literal cannot fail to compile; a pattern that does matches nothing
        Regex::new("^$a").unwrap_or_else(|e| unreachable!("{e}"))
    });
    if let Ok(mut cache) = GLOBS.lock() {
        if cache.len() > 500 {
            cache.clear();
        }
        cache.insert(pattern.to_owned(), re.clone());
    }
    re
}

/// Does one decision path cover `file`? It does when it is the file itself, a directory the file
/// is in (`src/auth/` or `src/auth`), or a glob that matches the whole file path.
#[must_use]
pub fn path_matches(pattern: &str, file: &str) -> bool {
    let p = normalize(pattern);
    let f = normalize(file);
    if p.is_empty() || f.is_empty() {
        return false;
    }
    if p.contains('*') {
        return glob_to_regex(&p).is_match(&f);
    }
    let dir = p.trim_end_matches('/');
    f == dir || f.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// A decision covers a file when any of its paths does. A decision without paths covers none.
#[must_use]
pub fn decision_matches_path<S: AsRef<str>>(paths: &[S], file: &str) -> bool {
    paths.iter().any(|pattern| path_matches(pattern.as_ref(), file))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    #[test]
    fn matches_the_file_itself() {
        assert!(path_matches("src/auth/session.ts", "src/auth/session.ts"));
        assert!(!path_matches("src/auth/session.ts", "src/auth/session.tsx"));
        assert!(!path_matches("src/auth/session.ts", "src/auth/other.ts"));
    }

    #[test]
    fn matches_a_directory_prefix_with_or_without_the_trailing_slash() {
        assert!(path_matches("src/auth/", "src/auth/session.ts"));
        assert!(path_matches("src/auth", "src/auth/token/refresh.ts"));
        assert!(path_matches("src/auth", "src/auth"));
        assert!(!path_matches("src/auth", "src/authz/policy.ts"));
        assert!(!path_matches("src/auth/token", "src/auth/session.ts"));
    }

    #[test]
    fn keeps_a_star_inside_one_segment() {
        assert!(path_matches("src/auth/*", "src/auth/session.ts"));
        assert!(!path_matches("src/auth/*", "src/auth/token/refresh.ts"));
        assert!(path_matches("src/*/session.ts", "src/auth/session.ts"));
        assert!(!path_matches("src/*/session.ts", "src/auth/x/session.ts"));
        assert!(path_matches("*.md", "README.md"));
        assert!(!path_matches("*.md", "docs/README.md"));
    }

    #[test]
    fn lets_a_double_star_cross_segments() {
        assert!(path_matches("src/auth/**", "src/auth/token/refresh.ts"));
        assert!(path_matches("src/**/refresh.ts", "src/auth/token/refresh.ts"));
        assert!(path_matches("src/**/refresh.ts", "src/refresh.ts"));
        assert!(path_matches("**/*.spec.ts", "server/src/a/b.spec.ts"));
        assert!(path_matches("**/*.spec.ts", "b.spec.ts"));
        assert!(!path_matches("src/auth/**", "src/other/token.ts"));
    }

    #[test]
    fn treats_regex_characters_in_a_path_literally() {
        assert!(path_matches("src/a+b/(x).ts", "src/a+b/(x).ts"));
        assert!(!path_matches("src/*.ts", "src/axts"));
    }

    #[test]
    fn ignores_dot_slash_and_backslashes_when_comparing() {
        assert!(path_matches("./src/auth/", "src/auth/session.ts"));
        assert!(path_matches("src\\auth\\*", "src/auth/session.ts"));
        assert!(path_matches("src/auth/*", "./src/auth/session.ts"));
    }

    #[test]
    fn a_decision_matches_when_any_path_does_and_never_without_paths() {
        assert!(decision_matches_path(&["docs/", "src/auth/*"], "src/auth/session.ts"));
        assert!(!decision_matches_path(&["docs/", "src/db/*"], "src/auth/session.ts"));
        assert!(!decision_matches_path::<&str>(&[], "src/auth/session.ts"));
    }

    #[test]
    fn cleaning_trims_and_keeps_the_rest_as_given() {
        assert_eq!(clean_thread_path("  src/auth/*  ").unwrap(), "src/auth/*");
        assert_eq!(clean_thread_path("src/auth/").unwrap(), "src/auth/");
    }

    #[test]
    fn cleaning_refuses_absolute_paths_dot_dot_empty_and_oversized_paths() {
        let long = format!("src/{}", "a".repeat(600));
        for bad in [
            "",
            "   ",
            "/etc/passwd",
            "\\windows\\system32",
            "C:\\temp\\x",
            "~/secrets",
            "../outside",
            "src/../../outside",
            "src\\..\\x",
            long.as_str(),
        ] {
            let error = clean_thread_path(bad).expect_err(bad);
            assert_eq!(error.status_code(), StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(clean_thread_path("src/..hidden/file").unwrap(), "src/..hidden/file");
    }

    #[test]
    fn a_refused_path_is_named_with_the_reason() {
        let message = |raw: &str| clean_thread_path(raw).unwrap_err().to_string();
        assert_eq!(
            message("/etc/passwd"),
            "400 Bad Request: Path \"/etc/passwd\" must be relative to the repository"
        );
        assert_eq!(
            message("a/../b"),
            "400 Bad Request: Path \"a/../b\" must not contain \"..\" segments"
        );
        assert_eq!(message("  "), "400 Bad Request: Path \"\" is empty");
        assert_eq!(message("a\0b"), "400 Bad Request: Path \"a\0b\" contains a null character");
    }

    #[test]
    fn cleaning_a_list_drops_duplicates() {
        assert_eq!(clean_thread_paths(&[" a.ts", "b.ts", "a.ts "]).unwrap(), ["a.ts", "b.ts"]);
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn merging_puts_the_new_files_first_without_duplicates() {
        assert_eq!(
            merge_files(&strings(&["old.ts", "shared.ts"]), &strings(&["new.ts", "shared.ts"]), 10),
            ["new.ts", "shared.ts", "old.ts"]
        );
    }

    #[test]
    fn merging_keeps_the_record_when_nothing_new_is_sent() {
        assert_eq!(merge_files(&strings(&["a.ts", "b.ts"]), &[], 10), ["a.ts", "b.ts"]);
    }

    #[test]
    fn merging_caps_the_list_dropping_the_oldest() {
        assert_eq!(
            merge_files(&strings(&["c.ts", "d.ts"]), &strings(&["a.ts", "b.ts"]), 3),
            ["a.ts", "b.ts", "c.ts"]
        );
    }
}
