//! Which entities and layouts a saved view may have (`view-rules.ts`) and the public link token
//! (`view-token.ts`).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use trama_common::crypto::sha256_hex;
use trama_contracts::views::{ViewEntity, ViewLayout};

/// `VIEW_ENTITIES`: what a view may list.
pub const VIEW_ENTITIES: [ViewEntity; 2] = [ViewEntity::Issue, ViewEntity::Project];

/// `VIEW_LAYOUTS`.
pub const VIEW_LAYOUTS: [ViewLayout; 3] =
    [ViewLayout::List, ViewLayout::Board, ViewLayout::Timeline];

/// Entities that carry dates, so a timeline (Gantt) layout makes sense for them.
const TIMELINE_ENTITIES: [ViewEntity; 1] = [ViewEntity::Project];

/// `VIEW_ENTITIES.includes(entity)` for a stored string.
#[must_use]
pub fn stored_entity(entity: &str) -> Option<ViewEntity> {
    ViewEntity::parse(entity).filter(|e| VIEW_ENTITIES.contains(e))
}

/// Why `layout` cannot be used with `entity`, or `None` when the combination is valid
/// (`viewLayoutProblem`). `layout` is the stored string: only `timeline` is ever refused.
#[must_use]
pub fn view_layout_problem(entity: ViewEntity, layout: &str) -> Option<String> {
    if layout == ViewLayout::Timeline.as_str() && !TIMELINE_ENTITIES.contains(&entity) {
        let allowed: Vec<&str> = TIMELINE_ENTITIES.iter().map(|e| e.as_str()).collect();
        return Some(format!(
            "The timeline layout is only available for {} views, not {entity} views",
            allowed.join(" and ")
        ));
    }
    None
}

/// `vt_` followed by 43 base64url characters (32 random bytes).
const TOKEN_PREFIX: &str = "vt_";
const TOKEN_BODY_LEN: usize = 43;

/// `vt_` + 32 random bytes (256 bits) in base64url: unguessable, URL-safe.
#[must_use]
pub fn generate_public_token() -> String {
    let bytes: [u8; 32] = rand::random();
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Only this hash is looked up; a leaked database row cannot be turned into a working link
/// without the encrypted copy and the secrets key.
#[must_use]
pub fn hash_public_token(token: &str) -> String {
    sha256_hex(token)
}

/// Cheap shape check before touching the database (`/^vt_[A-Za-z0-9_-]{43}$/`).
#[must_use]
pub fn is_public_token(value: &str) -> bool {
    value.strip_prefix(TOKEN_PREFIX).is_some_and(|body| {
        body.len() == TOKEN_BODY_LEN
            && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_rules_accept_projects_and_the_timeline() {
        assert!(VIEW_ENTITIES.contains(&ViewEntity::Project));
        assert!(VIEW_LAYOUTS.contains(&ViewLayout::Timeline));
    }

    #[test]
    fn the_timeline_is_for_project_views_only() {
        assert_eq!(view_layout_problem(ViewEntity::Project, "timeline"), None);
        let problem = view_layout_problem(ViewEntity::Issue, "timeline").unwrap();
        assert!(problem.contains("timeline"));
        assert_eq!(
            problem,
            "The timeline layout is only available for project views, not issue views"
        );
        assert_eq!(view_layout_problem(ViewEntity::Issue, "board"), None);
        assert_eq!(view_layout_problem(ViewEntity::Project, "list"), None);
        // a retired entity is not a view entity
        assert_eq!(stored_entity("decision"), None);
        assert_eq!(stored_entity("workstream"), None);
        assert_eq!(stored_entity("project"), Some(ViewEntity::Project));
    }

    #[test]
    fn public_tokens_are_long_url_safe_unique_and_hashed_for_lookup() {
        let a = generate_public_token();
        let b = generate_public_token();
        assert_ne!(a, b);
        assert!(is_public_token(&a));
        assert!(a.len() >= 46);
        let hash = hash_public_token(&a);
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert!(!hash.contains(&a));
        for bad in [
            String::new(),
            "abc".into(),
            "vt_short".into(),
            format!("vt_{}", "a".repeat(44)),
            format!("xx_{}", "a".repeat(43)),
            format!("vt_{}/", "a".repeat(42)),
            format!("vt_{}\n", "a".repeat(43)),
        ] {
            assert!(!is_public_token(&bad), "{bad:?}");
        }
    }

    #[test]
    fn hashes_like_node() {
        // createHash('sha256').update('vt_x').digest('hex')
        assert_eq!(
            hash_public_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
