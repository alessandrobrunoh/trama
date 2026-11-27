//! `signature.ts`: the signature of an outgoing webhook delivery.

use ring::hmac;

/// Header carrying the signature of an outgoing webhook delivery.
pub const SIGNATURE_HEADER: &str = "X-Trama-Signature";

/// `sha256=<hex hmac-sha256 of the raw request body>`; a receiver verifies it with the webhook
/// secret.
#[must_use]
pub fn sign_body(secret: &str, body: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    format!("sha256={}", hex::encode(hmac::sign(&key, body.as_bytes())))
}

/// Constant-time check of a signature header.
#[must_use]
pub fn verify_signature(secret: &str, body: &str, header: Option<&str>) -> bool {
    header.is_some_and(|given| {
        let expected = sign_body(secret, body);
        // compare every byte, whatever the first difference is
        expected.len() == given.len()
            && expected.bytes().zip(given.bytes()).fold(0_u8, |diff, (a, b)| diff | (a ^ b)) == 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_sha256_hex_hmac_of_the_raw_body_and_verifies_in_constant_time() {
        let body = r#"{"event":"issue.created"}"#;
        let sig = sign_body("whsec_secret", body);
        let hex = sig.strip_prefix("sha256=").unwrap();
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        // known HMAC-SHA256 vector: key "key", message "The quick brown fox jumps over the lazy dog"
        assert_eq!(
            sign_body("key", "The quick brown fox jumps over the lazy dog"),
            "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        assert!(verify_signature("whsec_secret", body, Some(&sig)));
        assert!(!verify_signature("whsec_secret", &format!("{body} "), Some(&sig)));
        assert!(!verify_signature("other", body, Some(&sig)));
        assert!(!verify_signature("whsec_secret", body, None));
        assert!(!verify_signature("whsec_secret", body, Some("sha256=short")));
    }
}
