//! AES-256-GCM encryption of secrets at rest, byte-compatible with the NestJS `SecretsService`
//! and `common/crypto.ts`: values either API wrote decrypt in the other.
//!
//! * [`Secrets::encrypt`] / [`Secrets::decrypt`]: integration credentials, `v2:<iv>:<tag>:<data>`
//!   (base64url), bound to an `aad` (connection id + field).
//! * [`Secrets::encrypt_secret`] / [`Secrets::decrypt_secret`]: other secrets (public view
//!   links), `v1:<iv>:<tag>:<data>` without `aad`; rows written with the pre-shared-key
//!   derivation still decrypt.
//!
//! The key is `TRAMA_ENCRYPTION_KEY` (then `NABLA_ENCRYPTION_KEY`, `SECRETS_KEY`): 64 hex
//! characters or 32 bytes in base64, otherwise any passphrase hashed with SHA-256. Without one a
//! fixed, public development key is used with a loud warning; in production the server refuses
//! to start ([`Secrets::from_config`] fails).

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use trama_core::{AppError, AppState, Config};

/// Hashed into the development key when no key is configured (the NestJS constant).
const DEV_KEY_MATERIAL: &str = "nabla-dev-only-integration-key";
/// What `common/crypto.ts` hashed before it shared the integrations key.
const LEGACY_DEFAULT_MATERIAL: &str = "nabla-dev-only-secrets-key";

/// Node's base64 decoder: either padding style, extra trailing bits ignored.
const LENIENT_URL_SAFE: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);
const LENIENT_STANDARD: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// Production without an encryption key.
#[derive(Debug, thiserror::Error)]
#[error(
    "TRAMA_ENCRYPTION_KEY is required in production (integration secrets are encrypted at rest)"
)]
pub struct MissingKeyError;

/// A payload that cannot be decrypted.
#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// Not `vN:<iv>:<tag>:<data>` of the expected version.
    #[error("Unsupported secret format")]
    UnsupportedFormat,
    /// Wrong key, wrong `aad` or a tampered payload.
    #[error("Unsupported state or unable to authenticate data")]
    Authentication,
}

/// The process's encryption keys. Cheap to clone; `Debug` hides the keys.
#[derive(Clone)]
pub struct Secrets {
    key: [u8; 32],
    legacy_key: [u8; 32],
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets([redacted])")
    }
}

impl Secrets {
    /// Keys from the configuration.
    ///
    /// # Errors
    ///
    /// [`MissingKeyError`] in production without a key.
    pub fn from_config(config: &Config) -> Result<Self, MissingKeyError> {
        let key = resolve_key(
            config.encryption.key.as_ref().map(trama_core::config::Secret::expose),
            config.production,
        )?;
        let legacy_material = config
            .encryption
            .legacy_secrets_key
            .as_ref()
            .map_or(LEGACY_DEFAULT_MATERIAL, trama_core::config::Secret::expose);
        Ok(Self { key, legacy_key: Sha256::digest(legacy_material.as_bytes()).into() })
    }

    /// The instance registered on `state` at startup, else one built from its configuration.
    ///
    /// # Errors
    ///
    /// A 500 when no key is configured in production (startup refuses that already).
    pub fn of(state: &AppState) -> Result<Self, AppError> {
        if let Some(secrets) = state.extension::<Self>() {
            return Ok(secrets.clone());
        }
        Self::from_config(&state.config).map_err(AppError::internal)
    }

    /// `v2` payload of `plain`, bound to `aad`.
    #[must_use]
    pub fn encrypt(&self, plain: &str, aad: &str) -> String {
        seal("v2", &self.key, plain, aad.as_bytes())
    }

    /// Decrypts a [`Secrets::encrypt`] payload.
    ///
    /// # Errors
    ///
    /// [`SecretError`] for another format, key or `aad`, or a tampered payload.
    pub fn decrypt(&self, payload: &str, aad: &str) -> Result<String, SecretError> {
        let parts = split("v2", payload)?;
        open(&self.key, parts, aad.as_bytes())
    }

    /// `v1` payload of `plain` (no `aad`).
    #[must_use]
    pub fn encrypt_secret(&self, plain: &str) -> String {
        seal("v1", &self.key, plain, b"")
    }

    /// Decrypts a [`Secrets::encrypt_secret`] payload, also trying the legacy key.
    ///
    /// # Errors
    ///
    /// [`SecretError`] when neither key opens it.
    pub fn decrypt_secret(&self, payload: &str) -> Result<String, SecretError> {
        let parts = split("v1", payload)?;
        open(&self.key, parts, b"")
            .or_else(|err| open(&self.legacy_key, parts, b"").map_err(|_| err))
    }
}

/// The key `raw` selects, as `SecretsService.resolveKey` derives it.
///
/// # Errors
///
/// [`MissingKeyError`] when `raw` is unset or blank in production.
pub fn resolve_key(raw: Option<&str>, production: bool) -> Result<[u8; 32], MissingKeyError> {
    static WARNED: AtomicBool = AtomicBool::new(false);
    let value = raw.map(str::trim).unwrap_or_default();
    if value.is_empty() {
        if production {
            return Err(MissingKeyError);
        }
        if !WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "!!! TRAMA_ENCRYPTION_KEY is not set: using a FIXED, PUBLIC development key. \
                 Integration tokens are NOT safely encrypted. Set TRAMA_ENCRYPTION_KEY (e.g. \
                 `openssl rand -base64 32`) before storing real credentials."
            );
        }
        return Ok(Sha256::digest(DEV_KEY_MATERIAL.as_bytes()).into());
    }
    if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut key = [0; 32];
        if hex::decode_to_slice(value, &mut key).is_ok() {
            return Ok(key);
        }
    }
    let body = value.strip_suffix('=').unwrap_or(value);
    if body.len() == 43
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        && let Ok(bytes) = LENIENT_STANDARD.decode(value)
        && let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return Ok(key);
    }
    Ok(Sha256::digest(value.as_bytes()).into())
}

/// Lowercase hex SHA-256 of `value` (the NestJS `sha256`).
#[must_use]
pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// A fresh random webhook secret, `whsec_` and 24 random bytes in base64url.
#[must_use]
pub fn generate_webhook_secret() -> String {
    let bytes: [u8; 24] = rand::random();
    format!("whsec_{}", URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Clone, Copy)]
struct Parts<'a> {
    iv: &'a str,
    tag: &'a str,
    data: &'a str,
}

fn split<'a>(version: &str, payload: &'a str) -> Result<Parts<'a>, SecretError> {
    let mut it = payload.split(':');
    let (Some(v), Some(iv), Some(tag), Some(data)) = (it.next(), it.next(), it.next(), it.next())
    else {
        return Err(SecretError::UnsupportedFormat);
    };
    if v != version || iv.is_empty() || tag.is_empty() || data.is_empty() {
        return Err(SecretError::UnsupportedFormat);
    }
    Ok(Parts { iv, tag, data })
}

fn seal(version: &str, key: &[u8; 32], plain: &str, aad: &[u8]) -> String {
    let iv: [u8; 12] = rand::random();
    let cipher = Aes256Gcm::new(key.into());
    let mut buf = plain.as_bytes().to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&iv), aad, &mut buf)
        .expect("AES-GCM encryption of an in-memory buffer cannot fail");
    format!(
        "{version}:{}:{}:{}",
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(&buf)
    )
}

fn open(key: &[u8; 32], parts: Parts<'_>, aad: &[u8]) -> Result<String, SecretError> {
    let decode = |s: &str| LENIENT_URL_SAFE.decode(s).map_err(|_| SecretError::Authentication);
    let iv = decode(parts.iv)?;
    let tag = decode(parts.tag)?;
    let mut buf = decode(parts.data)?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err(SecretError::Authentication);
    }
    Aes256Gcm::new(key.into())
        .decrypt_in_place_detached(Nonce::from_slice(&iv), aad, &mut buf, Tag::from_slice(&tag))
        .map_err(|_| SecretError::Authentication)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets(vars: &[(&str, &str)]) -> Secrets {
        Secrets::from_config(&Config::from_vars(vars)).unwrap()
    }

    /// Written by the NestJS `SecretsService` with the development key,
    /// `encrypt('ghp_nest', 'conn_1:token')`.
    const NEST_V2_DEV: &str = "v2:2A_ejrVEmGxelCKx:4iZRyKNN-Q-6TNpQUoIvxQ:EqO1AWdirPc";
    /// `encryptSecret('vt_nest')` by NestJS with `TRAMA_ENCRYPTION_KEY=a-production-passphrase`.
    const NEST_V1_PASSPHRASE: &str = "v1:Ny5ZtxwsiFJASgec:HA9ITvaHyj5Gnuafn8LH6A:xQcHkRJJGA";

    #[test]
    fn decrypts_what_nest_wrote() {
        assert_eq!(secrets(&[]).decrypt(NEST_V2_DEV, "conn_1:token").unwrap(), "ghp_nest");
        assert!(secrets(&[]).decrypt(NEST_V2_DEV, "conn_2:token").is_err());
        let prod = secrets(&[("TRAMA_ENCRYPTION_KEY", "a-production-passphrase")]);
        assert_eq!(prod.decrypt_secret(NEST_V1_PASSPHRASE).unwrap(), "vt_nest");
    }

    #[test]
    fn round_trips_and_never_repeats() {
        let s = secrets(&[]);
        let a = s.encrypt_secret("ghp_secret");
        let b = s.encrypt_secret("ghp_secret");
        assert_ne!(a, b);
        assert!(!a.contains("ghp_secret"));
        assert_eq!(s.decrypt_secret(&a).unwrap(), "ghp_secret");
        let v2 = s.encrypt("tok", "conn:field");
        assert!(v2.starts_with("v2:"));
        assert_eq!(s.decrypt(&v2, "conn:field").unwrap(), "tok");
        assert!(matches!(s.decrypt(&a, "x"), Err(SecretError::UnsupportedFormat)));
        assert!(matches!(s.decrypt_secret("v1:a:b"), Err(SecretError::UnsupportedFormat)));
    }

    #[test]
    fn rejects_tampered_payloads() {
        let s = secrets(&[]);
        let payload = s.encrypt_secret("x");
        let parts: Vec<&str> = payload.split(':').collect();
        let tampered = format!("{}:{}:{}:{}A", parts[0], parts[1], parts[2], parts[3]);
        assert!(s.decrypt_secret(&tampered).is_err());
    }

    #[test]
    fn reads_rows_written_with_the_legacy_key() {
        // previous implementation: key = sha256(SECRETS_KEY ?? constant)
        let legacy_key: [u8; 32] = Sha256::digest(LEGACY_DEFAULT_MATERIAL.as_bytes()).into();
        let legacy = seal("v1", &legacy_key, "vt_old", b"");
        let prod = secrets(&[("TRAMA_ENCRYPTION_KEY", "a-production-passphrase")]);
        let fresh = prod.encrypt_secret("vt_new");
        assert_eq!(prod.decrypt_secret(&fresh).unwrap(), "vt_new");
        assert_eq!(prod.decrypt_secret(&legacy).unwrap(), "vt_old");
        // the new ciphertext is not readable with the public dev key
        assert!(secrets(&[]).decrypt_secret(&fresh).is_err());
    }

    #[test]
    fn resolves_keys_like_nest() {
        let hex_key = "00".repeat(31) + "ff";
        assert_eq!(resolve_key(Some(&hex_key), true).unwrap()[31], 0xff);
        let b64 = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        assert_eq!(resolve_key(Some(&b64), true).unwrap(), [7u8; 32]);
        assert_eq!(resolve_key(Some(b64.trim_end_matches('=')), true).unwrap(), [7u8; 32]);
        let phrase: [u8; 32] = Sha256::digest(b"passphrase").into();
        assert_eq!(resolve_key(Some(" passphrase "), true).unwrap(), phrase);
        let dev: [u8; 32] = Sha256::digest(DEV_KEY_MATERIAL.as_bytes()).into();
        assert_eq!(resolve_key(None, false).unwrap(), dev);
        assert_eq!(resolve_key(Some("  "), false).unwrap(), dev);
        assert!(resolve_key(None, true).is_err());
        assert!(Secrets::from_config(&Config::from_vars(&[("NODE_ENV", "production")])).is_err());
    }

    #[test]
    fn sha256_is_stable_hex() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn webhook_secrets_have_the_nest_shape() {
        let s = generate_webhook_secret();
        assert!(s.starts_with("whsec_") && s.len() == 6 + 32, "{s}");
        assert_ne!(s, generate_webhook_secret());
    }
}
