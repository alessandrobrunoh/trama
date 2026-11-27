//! Source path, filter and specificity rules shared by routing-rule management and ingestion.

use trama_contracts::routing::RoutingFilters;

/// Rejects paths that are not valid source identifiers.
///
/// # Errors
///
/// Returns a user-facing validation message when the path is malformed.
pub fn normalize_source_path(provider: &str, raw: &str) -> Result<String, String> {
    let path = raw.trim().split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("/");
    let group = path.ends_with("/*");
    let parts: Vec<_> = (if group { &path[..path.len() - 2] } else { &path }).split('/').collect();
    if path.is_empty()
        || parts.len() > 20
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        })
    {
        return Err("Enter a valid source path".to_owned());
    }
    if (group && provider != "gitlab" && parts.len() != 1)
        || (!group && if provider == "gitlab" { parts.len() < 2 } else { parts.len() != 2 })
    {
        return Err("Use a valid repository path or group path".to_owned());
    }
    Ok(path)
}

/// Whether `rule` includes this repository. Matching is case-insensitive and group paths respect
/// segment boundaries, so `acme/*` does not match `acme-tools/repo`.
#[must_use]
pub fn source_includes(rule: &str, repository: &str) -> bool {
    if let Some(prefix) = rule.strip_suffix("/*") {
        repository
            .to_ascii_lowercase()
            .strip_prefix(&format!("{}/", prefix.to_ascii_lowercase()))
            .is_some()
    } else {
        rule.eq_ignore_ascii_case(repository)
    }
}

/// Whether two source paths could address the same repository.
#[must_use]
pub fn sources_overlap(a: &str, b: &str) -> bool {
    source_includes(a, b) || source_includes(b, a)
}

/// Returns true when an item satisfies every filter on a rule.
#[must_use]
pub fn filters_match(filters: &RoutingFilters, labels: &[String], milestone: Option<&str>) -> bool {
    if let Some(wanted) = &filters.labels
        && !wanted.iter().all(|w| labels.iter().any(|l| l.eq_ignore_ascii_case(w)))
    {
        return false;
    }
    filters
        .milestone
        .as_deref()
        .is_none_or(|wanted| milestone.is_some_and(|m| m.eq_ignore_ascii_case(wanted)))
}

/// Rules with a repository source outrank groups; deeper groups and additional filters win ties.
#[must_use]
pub fn specificity(path: &str, filters: &RoutingFilters) -> usize {
    let repo = usize::from(!path.ends_with("/*")) * 100_000;
    let depth = path.len() * 10;
    repo + depth
        + filters.labels.as_ref().map_or(0, Vec::len)
        + usize::from(filters.milestone.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_obeys_provider_path_shapes() {
        assert_eq!(normalize_source_path("github", " Acme/api.git ").unwrap(), "Acme/api.git");
        assert!(normalize_source_path("github", "a/b/c").is_err());
        assert!(normalize_source_path("gitlab", "group/subgroup/*").is_ok());
        assert!(normalize_source_path("github", "../repo").is_err());
    }

    #[test]
    fn groups_match_only_path_segments_and_sources_overlap() {
        assert!(source_includes("Acme/*", "acme/tools/api"));
        assert!(!source_includes("acme/*", "acme-tools/api"));
        assert!(sources_overlap("acme/*", "acme/api"));
        assert!(!sources_overlap("acme/api", "other/*"));
    }

    #[test]
    fn filters_are_all_of_and_case_insensitive() {
        let filters = RoutingFilters {
            labels: Some(vec!["bug".into(), "urgent".into()]),
            milestone: Some("v1".into()),
        };
        assert!(filters_match(&filters, &["BUG".into(), "Urgent".into()], Some("V1")));
        assert!(!filters_match(&filters, &["bug".into()], Some("v1")));
    }
}
