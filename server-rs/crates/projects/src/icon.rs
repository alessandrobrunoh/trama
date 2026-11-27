//! Project icons (`project-icon.ts`): a Lucide icon name (kebab-case) or a single emoji.

use std::sync::LazyLock;

use regex::Regex;
use trama_contracts::js;

/// Longest project icon, in UTF-16 units.
pub const PROJECT_ICON_MAX: usize = 48;

/// `PROJECT_ICON_PATTERN`: a Lucide kebab-case name, or one emoji (pictograph, optionally
/// skin-toned / variation-selected / ZWJ-joined, or a flag).
pub const PROJECT_ICON_PATTERN: &str = r"^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?(?:\x{200D}\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?)*|\p{Regional_Indicator}{2})$";

static PROJECT_ICON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(PROJECT_ICON_PATTERN).expect("valid project icon pattern"));

/// Is `value` an acceptable `Project.icon`?
#[must_use]
pub fn is_project_icon(value: &str) -> bool {
    !value.is_empty() && js::len(value) <= PROJECT_ICON_MAX && PROJECT_ICON.is_match(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    // projects/project-icon.spec.ts
    #[test]
    fn accepts_lucide_kebab_case_names() {
        for name in ["rocket", "bar-chart-3", "git-pull-request"] {
            assert!(is_project_icon(name), "{name}");
        }
    }

    #[test]
    fn accepts_a_single_emoji_including_zwj_sequences_and_flags() {
        for e in ["🚀", "❤️", "👩‍💻", "👍🏽", "🇮🇹"] {
            assert!(is_project_icon(e), "{e}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for v in
            ["", "Rocket", "rocket_ship", "-rocket", "rocket-", "🚀🚀", "🚀 ", "a b", "<script>"]
        {
            assert!(!is_project_icon(v), "{v}");
        }
        assert!(!is_project_icon(&"a".repeat(49)));
    }
}
