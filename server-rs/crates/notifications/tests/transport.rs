//! The real push transport against a local "push service": the request `web-push` would make
//! (VAPID `Authorization`, `aes128gcm` body, `TTL`, `Urgency`) and how answers map to errors.

#![allow(missing_docs)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::agreement;
use ring::rand::SystemRandom;
use trama_common::safe_fetch::OutboundPolicy;
use trama_notifications::push::{HttpTransport, PushRequest, WebPushTransport};
use trama_notifications::webpush::Vapid;

const PUBLIC: &str =
    "BODXrduVbuNQrOUZnGQKeSq5sPxxQOtPmx1HX6J03ehUsEywbhn8bBWqABFvJhVD-C4bWM6Bg3Z0lpyXwtN6_dk";
const PRIVATE: &str = "NHeMxO592vKDztwSEkdk_APEXUt6aq56IbJqsdZzR2s";

type Seen = Arc<Mutex<Vec<(HeaderMap, Vec<u8>)>>>;

/// A push service that answers `status` to every request.
async fn push_service(status: u16) -> (String, Seen) {
    let seen: Seen = Seen::default();
    async fn handle(
        State((seen, status)): State<(Seen, u16)>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        seen.lock().unwrap().push((headers, body.to_vec()));
        StatusCode::from_u16(status).unwrap()
    }
    let app = Router::new().route("/push", post(handle)).with_state((Arc::clone(&seen), status));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{port}/push"), seen)
}

fn subscription_key() -> String {
    let rng = SystemRandom::new();
    let key = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
    URL_SAFE_NO_PAD.encode(key.compute_public_key().unwrap().as_ref())
}

fn transport() -> HttpTransport {
    let policy = OutboundPolicy { allow_private: true, ..OutboundPolicy::default() };
    HttpTransport::new(Vapid::new("mailto:test@example.com", PUBLIC, PRIVATE).unwrap(), &policy)
}

fn request(endpoint: &str) -> PushRequest {
    PushRequest {
        endpoint: endpoint.to_owned(),
        p256dh: subscription_key(),
        auth: URL_SAFE_NO_PAD.encode([9_u8; 16]),
        payload: r#"{"notification":{"title":"Hi"}}"#.to_owned(),
        ttl: 86_400,
        timeout: Duration::from_secs(5),
    }
}

#[tokio::test]
async fn posts_an_encrypted_message_signed_with_the_vapid_key() {
    let (endpoint, seen) = push_service(201).await;
    transport().send(request(&endpoint)).await.unwrap();

    let seen = seen.lock().unwrap();
    let (headers, body) = &seen[0];
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default();
    assert_eq!(header("ttl"), "86400");
    assert_eq!(header("urgency"), "normal");
    assert_eq!(header("content-encoding"), "aes128gcm");
    assert_eq!(header("content-type"), "application/octet-stream");
    assert!(header("authorization").starts_with("vapid t="), "{}", header("authorization"));
    assert!(header("authorization").ends_with(&format!(", k={PUBLIC}")));
    // salt | record size | key id length | key id | ciphertext with its tag
    assert_eq!(&body[16..20], &4096_u32.to_be_bytes());
    assert_eq!(body[20], 65);
    assert_eq!(body.len(), 86 + request(&endpoint).payload.len() + 1 + 16);
    // the audience of the token is the push service's origin
    let token = header("authorization").trim_start_matches("vapid t=").split(',').next().unwrap();
    let claims = token.split('.').nth(1).unwrap();
    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
    assert_eq!(claims["aud"], endpoint.trim_end_matches("/push"));
    assert_eq!(claims["sub"], "mailto:test@example.com");
}

#[tokio::test]
async fn reports_the_status_of_a_push_service_that_refuses() {
    for status in [404, 410, 500] {
        let (endpoint, _) = push_service(status).await;
        let err = transport().send(request(&endpoint)).await.unwrap_err();
        assert_eq!(err.status, Some(status));
        assert_eq!(err.message, "Received unexpected response code");
    }
}

#[tokio::test]
async fn refuses_to_contact_internal_addresses_unless_the_operator_allows_it() {
    let (endpoint, seen) = push_service(201).await;
    let strict = HttpTransport::new(
        Vapid::new("mailto:test@example.com", PUBLIC, PRIVATE).unwrap(),
        &OutboundPolicy::default(),
    );
    let err = strict.send(request(&endpoint)).await.unwrap_err();
    assert_eq!(err.status, None);
    assert_eq!(err.message, "url must use https://");
    assert!(seen.lock().unwrap().is_empty());
    // https to an internal address is refused too
    let err = strict.send(request("https://127.0.0.1/push")).await.unwrap_err();
    assert!(err.message.contains("not allowed"), "{}", err.message);
}

#[tokio::test]
async fn a_subscription_with_unusable_keys_fails_before_any_request() {
    let (endpoint, seen) = push_service(201).await;
    let mut bad = request(&endpoint);
    bad.p256dh = "BPlaceholderKeyForTests".to_owned();
    let err = transport().send(bad).await.unwrap_err();
    assert_eq!(err.status, None);
    assert_eq!(err.message, "The subscription p256dh value should be 65 bytes long.");
    assert!(seen.lock().unwrap().is_empty());
}
