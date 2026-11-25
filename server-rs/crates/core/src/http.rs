//! Layers every response passes through: CORS, security headers, body limit and tracing.

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, HeaderValue, Method, header};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::Config;
use crate::json::JSON_BODY_LIMIT;

/// Headers a browser may send cross-origin (the NestJS CORS allow-list).
const ALLOWED_HEADERS: [HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::AUTHORIZATION,
    HeaderName::from_static("x-client-id"),
    HeaderName::from_static("x-requested-with"),
    header::ACCEPT,
];

const ALLOWED_METHODS: [Method; 6] =
    [Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS];

/// Wraps `router` with the layers of the NestJS `configureApp`.
///
/// Security headers are only added when the handler did not set them, so a route can send a
/// stricter policy (file downloads do). HSTS is production-only.
pub fn with_http_layers<S>(router: Router<S>, config: &Config) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let mut router = router
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(header_layer(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(header_layer(header::REFERRER_POLICY, "no-referrer"))
        .layer(header_layer(header::X_FRAME_OPTIONS, "DENY"));
    if config.production {
        router = router.layer(header_layer(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=15552000; includeSubDomains",
        ));
    }
    router.layer(cors(config)).layer(TraceLayer::new_for_http())
}

fn header_layer(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
}

fn cors(config: &Config) -> CorsLayer {
    let origins = config.cors_origins.iter().filter_map(|origin| {
        HeaderValue::from_str(origin)
            .inspect_err(|_| tracing::warn!(%origin, "ignoring invalid CORS origin"))
            .ok()
    });
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_headers(ALLOWED_HEADERS)
        .allow_methods(ALLOWED_METHODS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    fn app(production: bool) -> Router {
        let config = Config { production, ..Config::from_lookup(|_| None).unwrap() };
        let router = Router::new()
            .route("/plain", get(|| async { "ok" }))
            .route("/strict", get(|| async { ([(header::X_FRAME_OPTIONS, "SAMEORIGIN")], "ok") }));
        with_http_layers(router, &config)
    }

    #[tokio::test]
    async fn adds_security_headers_unless_set() {
        let res =
            app(false).oneshot(Request::get("/plain").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(res.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(res.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert!(!res.headers().contains_key(header::STRICT_TRANSPORT_SECURITY));

        let res =
            app(true).oneshot(Request::get("/strict").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.headers()[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        assert!(res.headers().contains_key(header::STRICT_TRANSPORT_SECURITY));
    }

    #[tokio::test]
    async fn answers_preflight_for_allowed_origins_only() {
        let preflight = |origin: &str| {
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/plain")
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PATCH")
                .body(Body::empty())
                .unwrap()
        };
        let res = app(false).oneshot(preflight("http://localhost:4300")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://localhost:4300");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");

        let res = app(false).oneshot(preflight("https://evil.example")).await.unwrap();
        assert!(!res.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }
}
