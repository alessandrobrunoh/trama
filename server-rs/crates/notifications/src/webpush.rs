//! The Web Push protocol, in the part of the `web-push` npm package the API uses: VAPID
//! (RFC 8292) authorization and `aes128gcm` payload encryption (RFC 8291 / RFC 8188).
//!
//! Built on `ring` (P-256 ECDSA and ECDH, HKDF, AES-128-GCM), which is already part of the
//! TLS stack. The HTTP request itself is made by [`crate::push::HttpTransport`] through the
//! SSRF guard of `trama-common`.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, agreement, hkdf, signature};
use url::Url;

/// A VAPID JWT lives 12 hours (`DEFAULT_EXPIRATION_SECONDS`).
const VAPID_EXPIRATION_SECONDS: u64 = 12 * 60 * 60;
/// The record size announced in the `aes128gcm` header.
const RECORD_SIZE: u32 = 4096;
/// The largest payload one record carries (`web-push` refuses more).
pub const MAX_PAYLOAD_BYTES: usize = 4078;

/// `urlBase64Helper.validate`: only the URL-safe alphabet, no padding.
fn is_url_safe_base64(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `Buffer.from(value, 'base64url')`: tolerates padding and the standard alphabet.
#[must_use]
pub fn decode_base64url(value: &str) -> Vec<u8> {
    let cleaned: String = value
        .chars()
        .filter(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    URL_SAFE_NO_PAD.decode(cleaned).unwrap_or_default()
}

/// The server's VAPID identity (`webpush.setVapidDetails`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vapid {
    subject: String,
    public_key: String,
    public_bytes: Vec<u8>,
    private_bytes: Vec<u8>,
}

impl Vapid {
    /// Checks the details like `setVapidDetails` does.
    ///
    /// # Errors
    ///
    /// The message `web-push` throws for an unusable subject or key.
    pub fn new(subject: &str, public_key: &str, private_key: &str) -> Result<Self, String> {
        if subject.is_empty() {
            return Err("No subject set in vapidDetails.subject.".to_owned());
        }
        let parsed = Url::parse(subject)
            .map_err(|_| format!("Vapid subject is not a valid URL. {subject}"))?;
        if !matches!(parsed.scheme(), "https" | "mailto") {
            return Err(format!("Vapid subject is not an https: or mailto: URL. {subject}"));
        }
        if public_key.is_empty() {
            return Err("No key set vapidDetails.publicKey".to_owned());
        }
        if !is_url_safe_base64(public_key) {
            return Err("Vapid public key must be a URL safe Base 64 (without \"=\")".to_owned());
        }
        let public_bytes = decode_base64url(public_key);
        if public_bytes.len() != 65 {
            return Err("Vapid public key should be 65 bytes long when decoded.".to_owned());
        }
        if private_key.is_empty() {
            return Err("No key set in vapidDetails.privateKey".to_owned());
        }
        if !is_url_safe_base64(private_key) {
            return Err("Vapid private key must be a URL safe Base 64 (without \"=\")".to_owned());
        }
        let private_bytes = decode_base64url(private_key);
        if private_bytes.len() != 32 {
            return Err("Vapid private key should be 32 bytes long when decoded.".to_owned());
        }
        Ok(Self {
            subject: subject.to_owned(),
            public_key: public_key.to_owned(),
            public_bytes,
            private_bytes,
        })
    }

    /// The public key the browser subscribes with (base64url).
    #[must_use]
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// The `Authorization` header for a push service at `audience` (`scheme://host[:port]`):
    /// `vapid t=<jwt>, k=<public key>`.
    ///
    /// # Errors
    ///
    /// When the key pair is unusable (the public key does not belong to the private one).
    pub fn authorization(&self, audience: &str) -> Result<String, String> {
        let exp = now_seconds() + VAPID_EXPIRATION_SECONDS;
        Ok(format!("vapid t={}, k={}", self.jwt(audience, exp)?, self.public_key))
    }

    fn jwt(&self, audience: &str, exp: u64) -> Result<String, String> {
        let header = URL_SAFE_NO_PAD.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": audience, "exp": exp, "sub": self.subject });
        let signing_input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let rng = SystemRandom::new();
        let key = signature::EcdsaKeyPair::from_private_key_and_public_key(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &self.private_bytes,
            &self.public_bytes,
            &rng,
        )
        .map_err(|e| format!("VAPID keys are not a P-256 key pair: {e}"))?;
        let sig = key
            .sign(&rng, signing_input.as_bytes())
            .map_err(|_| "Could not sign the VAPID token".to_owned())?;
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref())))
    }
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Encrypts `payload` for a subscription (`encryptionHelper.encrypt` with `aes128gcm`): returns
/// the whole request body (header and one record).
///
/// # Errors
///
/// The messages `web-push` throws for an unusable `p256dh` or `auth`, or a payload that does
/// not fit one record.
pub fn encrypt(p256dh: &str, auth: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    if p256dh.is_empty() {
        return Err("No user public key provided for encryption.".to_owned());
    }
    let ua_public = decode_base64url(p256dh);
    if ua_public.len() != 65 {
        return Err("The subscription p256dh value should be 65 bytes long.".to_owned());
    }
    if auth.is_empty() {
        return Err("No user auth provided for encryption.".to_owned());
    }
    let auth_secret = decode_base64url(auth);
    if auth_secret.len() < 16 {
        return Err("The subscription auth key should be at least 16 bytes long".to_owned());
    }
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("Payload is too large: the limit is {MAX_PAYLOAD_BYTES} bytes."));
    }
    let rng = SystemRandom::new();
    let ephemeral = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| "Could not generate a key".to_owned())?;
    let as_public = ephemeral
        .compute_public_key()
        .map_err(|_| "Could not generate a key".to_owned())?
        .as_ref()
        .to_vec();
    let mut salt = [0_u8; 16];
    rng.fill(&mut salt).map_err(|_| "Could not generate a salt".to_owned())?;
    let secret = agreement::agree_ephemeral(
        ephemeral,
        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &ua_public),
        <[u8]>::to_vec,
    )
    .map_err(|_| "The subscription p256dh value is not a valid public key.".to_owned())?;
    seal(&secret, &auth_secret, &ua_public, &as_public, &salt, payload)
}

struct Length(usize);

impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        self.0
    }
}

fn expand(prk: &hkdf::Prk, info: &[u8], len: usize) -> Result<Vec<u8>, String> {
    let mut out = vec![0_u8; len];
    prk.expand(&[info], Length(len))
        .and_then(|okm| okm.fill(&mut out))
        .map_err(|_| "Key derivation failed".to_owned())?;
    Ok(out)
}

/// The deterministic part of RFC 8291: derives the content key from the shared `ecdh_secret`
/// and seals `payload` in a single `aes128gcm` record.
fn seal(
    ecdh_secret: &[u8],
    auth_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    salt: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, auth_secret).extract(ecdh_secret);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let ikm = expand(&prk_key, &key_info, 32)?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
    let cek = expand(&prk, b"Content-Encoding: aes128gcm\0", 16)?;
    let nonce = expand(&prk, b"Content-Encoding: nonce\0", 12)?;

    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_128_GCM, &cek)
            .map_err(|_| "Could not set up the cipher".to_owned())?,
    );
    let mut record = payload.to_vec();
    // the last (here: only) record ends with the padding delimiter 0x02
    record.push(2);
    key.seal_in_place_append_tag(
        aead::Nonce::try_assume_unique_for_key(&nonce)
            .map_err(|_| "Could not set up the nonce".to_owned())?,
        aead::Aad::empty(),
        &mut record,
    )
    .map_err(|_| "Could not encrypt the payload".to_owned())?;

    let mut body = Vec::with_capacity(21 + as_public.len() + record.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    // the key id is the sender's public key, whose length fits one byte
    body.push(u8::try_from(as_public.len()).unwrap_or(65));
    body.extend_from_slice(as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key pair from `webpush.generateVAPIDKeys()`.
    const PUBLIC: &str =
        "BODXrduVbuNQrOUZnGQKeSq5sPxxQOtPmx1HX6J03ehUsEywbhn8bBWqABFvJhVD-C4bWM6Bg3Z0lpyXwtN6_dk";
    const PRIVATE: &str = "NHeMxO592vKDztwSEkdk_APEXUt6aq56IbJqsdZzR2s";

    fn vapid() -> Vapid {
        Vapid::new("mailto:test@example.com", PUBLIC, PRIVATE).unwrap()
    }

    #[test]
    fn validates_the_details_like_web_push() {
        assert!(Vapid::new("https://example.com/contact", PUBLIC, PRIVATE).is_ok());
        assert_eq!(
            Vapid::new("", PUBLIC, PRIVATE).unwrap_err(),
            "No subject set in vapidDetails.subject."
        );
        assert!(Vapid::new("not a url", PUBLIC, PRIVATE).unwrap_err().contains("not a valid URL"));
        assert!(
            Vapid::new("http://example.com", PUBLIC, PRIVATE)
                .unwrap_err()
                .contains("not an https: or mailto: URL")
        );
        assert!(Vapid::new("mailto:a@b.dev", "abc+/", PRIVATE).unwrap_err().contains("URL safe"));
        assert!(
            Vapid::new("mailto:a@b.dev", "abcd", PRIVATE).unwrap_err().contains("65 bytes long")
        );
        assert!(
            Vapid::new("mailto:a@b.dev", PUBLIC, "abcd").unwrap_err().contains("32 bytes long")
        );
    }

    #[test]
    fn signs_a_verifiable_es256_token() {
        let jwt = vapid().jwt("https://push.example.com", 1_900_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(URL_SAFE_NO_PAD.decode(parts[0]).unwrap(), br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            claims,
            serde_json::json!({
                "aud": "https://push.example.com",
                "exp": 1_900_000_000_u64,
                "sub": "mailto:test@example.com",
            })
        );
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
        let public = signature::UnparsedPublicKey::new(
            &signature::ECDSA_P256_SHA256_FIXED,
            decode_base64url(PUBLIC),
        );
        public.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();

        let header = vapid().authorization("https://push.example.com").unwrap();
        assert!(header.starts_with("vapid t="));
        assert!(header.ends_with(&format!(", k={PUBLIC}")));
    }

    #[test]
    fn rejects_a_mismatched_key_pair_when_signing() {
        let other = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
        let v = Vapid::new("mailto:test@example.com", other, PRIVATE).unwrap();
        assert!(v.authorization("https://push.example.com").is_err());
    }

    /// The vector of RFC 8291 §5: `When I grow up, I want to be a watermelon`.
    #[test]
    fn derives_and_seals_like_rfc_8291() {
        let body = seal(
            &decode_base64url("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"),
            &decode_base64url("BTBZMqHH6r4Tts7J_aSIgg"),
            &decode_base64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            &decode_base64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
            &decode_base64url("DGv6ra1nlYgDCS1FRnbzlw"),
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn a_browser_can_decrypt_what_encrypt_produces() {
        let rng = SystemRandom::new();
        let ua_private =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_public = ua_private.compute_public_key().unwrap().as_ref().to_vec();
        let auth_secret = [7_u8; 16];
        let message = "{\"notification\":{\"title\":\"Ana assigned you BUG-1\"}}";
        let body = encrypt(
            &URL_SAFE_NO_PAD.encode(&ua_public),
            &URL_SAFE_NO_PAD.encode(auth_secret),
            message.as_bytes(),
        )
        .unwrap();

        // header: salt(16) | record size(4) | key id length(1) | key id | record
        assert_eq!(&body[16..20], &RECORD_SIZE.to_be_bytes());
        assert_eq!(body[20], 65);
        let salt = &body[..16];
        let as_public = &body[21..86];
        let record = &body[86..];

        let secret = agreement::agree_ephemeral(
            ua_private,
            &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, as_public),
            <[u8]>::to_vec,
        )
        .unwrap();
        let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, &auth_secret).extract(&secret);
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(&ua_public);
        info.extend_from_slice(as_public);
        let ikm = expand(&prk_key, &info, 32).unwrap();
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
        let cek = expand(&prk, b"Content-Encoding: aes128gcm\0", 16).unwrap();
        let nonce = expand(&prk, b"Content-Encoding: nonce\0", 12).unwrap();
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek).unwrap());
        let mut buf = record.to_vec();
        let plain = key
            .open_in_place(
                aead::Nonce::try_assume_unique_for_key(&nonce).unwrap(),
                aead::Aad::empty(),
                &mut buf,
            )
            .unwrap();
        assert_eq!(plain.last(), Some(&2));
        assert_eq!(&plain[..plain.len() - 1], message.as_bytes());
    }

    #[test]
    fn refuses_unusable_subscription_keys() {
        let key = URL_SAFE_NO_PAD.encode([4_u8; 65]);
        let auth = URL_SAFE_NO_PAD.encode([1_u8; 16]);
        assert_eq!(
            encrypt("", &auth, b"x").unwrap_err(),
            "No user public key provided for encryption."
        );
        assert!(encrypt("BPlaceholderKeyForTests", &auth, b"x").unwrap_err().contains("65 bytes"));
        assert!(encrypt(&key, "", b"x").unwrap_err().contains("No user auth"));
        assert!(encrypt(&key, "abcd", b"x").unwrap_err().contains("16 bytes"));
        assert!(encrypt(&key, &auth, b"x").unwrap_err().contains("valid public key"));
        let ok_key = {
            let rng = SystemRandom::new();
            let k = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
            URL_SAFE_NO_PAD.encode(k.compute_public_key().unwrap().as_ref())
        };
        assert!(
            encrypt(&ok_key, &auth, &vec![b'x'; MAX_PAYLOAD_BYTES + 1])
                .unwrap_err()
                .contains("too large")
        );
        assert!(encrypt(&ok_key, &auth, &vec![b'x'; MAX_PAYLOAD_BYTES]).is_ok());
    }

    #[test]
    fn decodes_base64url_like_node() {
        assert_eq!(decode_base64url("YWJj"), b"abc");
        assert_eq!(decode_base64url("YWJj=="), b"abc");
        assert_eq!(decode_base64url("-_-_"), decode_base64url("+/+/"));
    }
}
