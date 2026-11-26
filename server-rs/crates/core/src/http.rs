//! Layers every response passes through, as the NestJS `configureApp` sets them up: CORS,
//! security headers, the body limit, the NUL check on paths and queries, and tracing.

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::json::JSON_BODY_LIMIT;
use crate::{AppError, Config};

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

/// Wraps `router` with the layers of the NestJS `configureApp`, outermost first:
///
/// 1. tracing;
/// 2. CORS (credentials, the NestJS allow-lists); a preflight is answered here with 204, as
///    the `cors` package does, without the security headers;
/// 3. security headers, only added when the handler did not set them, so a route can send a
///    stricter policy (file downloads do); HSTS is production-only;
/// 4. a 400 for a path or query string holding an encoded NUL (`%00`), which PostgreSQL cannot
///    store (the NestJS `RejectUnsafeInputPipe` does this for `@Param` and `@Query` values);
/// 5. the 2 MB body limit.
///
/// Layers added to `router` before this call (the rate limiter, the client id) end up inside
/// these, so their responses carry CORS and security headers too.
pub fn with_http_layers<S>(router: Router<S>, config: &Config) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let mut router = router
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(middleware::from_fn(reject_nul_in_uri))
        .layer(header_layer(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(header_layer(header::REFERRER_POLICY, "no-referrer"))
        .layer(header_layer(header::X_FRAME_OPTIONS, "DENY"));
    if config.production {
        router = router.layer(header_layer(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=15552000; includeSubDomains",
        ));
    }
    router
        .layer(cors(config))
        .layer(middleware::from_fn(preflight_no_content))
        .layer(TraceLayer::new_for_http())
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

/// Every `OPTIONS` request is a preflight the CORS layer answers; send it as 204 No Content.
async fn preflight_no_content(req: Request, next: Next) -> Response {
    let preflight = req.method() == Method::OPTIONS;
    let mut res = next.run(req).await;
    if preflight && res.status() == StatusCode::OK {
        *res.status_mut() = StatusCode::NO_CONTENT;
    }
    res
}

/// `true` when the percent-decoded path or query of `uri` holds a NUL character: `%00` is the
/// only way to write one in a URI.
#[must_use]
pub fn uri_has_nul(uri: &axum::http::Uri) -> bool {
    uri.path_and_query().is_some_and(|pq| pq.as_str().contains("%00"))
}

async fn reject_nul_in_uri(req: Request, next: Next) -> Response {
    if uri_has_nul(req.uri()) {
        return AppError::bad_request("Text must not contain NUL characters").into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app(production: bool) -> Router {
        let config =
            Config::from_vars(&[("NODE_ENV", if production { "production" } else { "test" })]);
        let router = Router::new()
            .route("/plain", get(|| async { "ok" }))
            .route("/strict", get(|| async { ([(header::X_FRAME_OPTIONS, "SAMEORIGIN")], "ok") }))
            .route(
                "/csp",
                get(|| async {
                    ([(header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox")], "ok")
                }),
            );
        with_http_layers(router, &config)
    }

    async fn send(app: Router, req: Request) -> Response {
        app.oneshot(req).await.unwrap()
    }

    #[tokio::test]
    async fn adds_security_headers_unless_set() {
        let res = send(app(false), Request::get("/plain").body(Body::empty()).unwrap()).await;
        assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(res.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(res.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert!(!res.headers().contains_key(header::STRICT_TRANSPORT_SECURITY));
        assert!(!res.headers().contains_key(header::CONTENT_SECURITY_POLICY));

        let res = send(app(true), Request::get("/strict").body(Body::empty()).unwrap()).await;
        assert_eq!(res.headers()[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        assert_eq!(
            res.headers()[header::STRICT_TRANSPORT_SECURITY],
            "max-age=15552000; includeSubDomains"
        );
    }

    #[tokio::test]
    async fn keeps_a_stricter_csp_set_by_the_route() {
        let res = send(app(false), Request::get("/csp").body(Body::empty()).unwrap()).await;
        assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], "default-src 'none'; sandbox");
        assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
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
        let res = send(app(false), preflight("http://localhost:4300")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://localhost:4300");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");
        let allowed = res.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap();
        assert!(allowed.contains("x-client-id"), "{allowed}");

        let res = send(app(false), preflight("https://evil.example")).await;
        assert!(!res.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[tokio::test]
    async fn simple_requests_carry_cors_headers() {
        let req = Request::get("/plain")
            .header(header::ORIGIN, "http://127.0.0.1:4301")
            .body(Body::empty())
            .unwrap();
        let res = send(app(false), req).await;
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://127.0.0.1:4301");
    }

    #[tokio::test]
    async fn rejects_nul_in_path_and_query() {
        for uri in ["/plain?q=%00", "/plain%00", "/plain?a%00=1"] {
            let res = send(app(false), Request::get(uri).body(Body::empty()).unwrap()).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            let body = res.into_body().collect().await.unwrap().to_bytes();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["message"], "Text must not contain NUL characters");
        }
        // an encoded percent sign is not a NUL
        let res =
            send(app(false), Request::get("/plain?q=%2500").body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), StatusCode::OK);
    }
}
