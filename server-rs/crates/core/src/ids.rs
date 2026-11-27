//! Entity ids: a type prefix and 12 random lowercase characters (`iss_k3xq9vbmtw2a`).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A new id such as `ws_abcxdefghijk`, built like the NestJS `uid()`: nine random bytes in
/// base64url, `-` and `_` replaced by `x`, lowercased.
#[must_use]
pub fn uid(prefix: &str) -> String {
    let bytes: [u8; 9] = rand::random();
    let rand = URL_SAFE_NO_PAD.encode(bytes).replace(['-', '_'], "x").to_lowercase();
    format!("{prefix}_{rand}")
}

#[cfg(test)]
mod tests {
    use super::uid;

    #[test]
    fn has_the_nest_shape() {
        for _ in 0..200 {
            let id = uid("iss");
            let (prefix, rest) = id.split_once('_').unwrap();
            assert_eq!(prefix, "iss");
            assert_eq!(rest.len(), 12);
            assert!(rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), "{id}");
        }
    }

    #[test]
    fn is_random() {
        assert_ne!(uid("x"), uid("x"));
    }
}
