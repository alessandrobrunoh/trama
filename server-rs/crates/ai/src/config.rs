//! The configured OpenAI-compatible provider (`server/src/ai/ai.config.ts`).

use axum::http::StatusCode;
use serde::Serialize;
use trama_core::AppError;
use trama_core::config::AiConfig;
use url::Url;
use utoipa::ToSchema;

/// `GET /ai/status` → `suggestions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct SuggestionsStatus {
    /// Whether `AI_API_URL`, `AI_API_KEY` and `AI_MODEL` are all set.
    pub configured: bool,
    /// `AI_MODEL`, `null` when unset.
    pub model: Option<String>,
}

/// Where and how to call the chat completions endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSettings {
    /// The full `…/chat/completions` URL.
    pub url: String,
    /// Bearer token.
    pub api_key: String,
    /// Model name.
    pub model: String,
}

fn unavailable(message: &str) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, message)
}

fn set(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// `AiConfig.status()`.
#[must_use]
pub fn status(config: &AiConfig) -> SuggestionsStatus {
    let configured = set(config.api_url.as_deref()).is_some()
        && set(config.api_key.as_ref().map(trama_core::config::Secret::expose)).is_some()
        && set(config.model.as_deref()).is_some();
    SuggestionsStatus { configured, model: config.model.clone() }
}

/// `AiConfig.provider()`: the settings, or 503 when the provider is not configured, its URL is
/// invalid, or it is not an HTTPS base URL without credentials, query or fragment.
///
/// # Errors
///
/// 503 with the NestJS wording.
pub fn provider(config: &AiConfig) -> Result<ProviderSettings, AppError> {
    let (Some(api_url), Some(api_key), Some(model)) = (
        set(config.api_url.as_deref()),
        set(config.api_key.as_ref().map(trama_core::config::Secret::expose)),
        set(config.model.as_deref()),
    ) else {
        return Err(unavailable("AI is not configured. Ask your administrator to enable it."));
    };
    let url = Url::parse(api_url).map_err(|_| unavailable("The AI provider URL is invalid."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return Err(unavailable(
            "The AI provider must use an HTTPS base URL without credentials or query parameters.",
        ));
    }
    let href = url.as_str();
    let base = href.strip_suffix('/').unwrap_or(href);
    Ok(ProviderSettings {
        url: format!("{base}/chat/completions"),
        api_key: api_key.to_owned(),
        model: model.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use trama_core::Config;

    use super::*;

    fn ai(vars: &[(&str, &str)]) -> AiConfig {
        Config::from_vars(vars).ai
    }

    #[test]
    fn reports_whether_the_provider_is_configured() {
        assert_eq!(status(&ai(&[])), SuggestionsStatus { configured: false, model: None });
        let full =
            ai(&[("AI_API_URL", "https://x.test/v1"), ("AI_API_KEY", "k"), ("AI_MODEL", "m")]);
        assert_eq!(status(&full), SuggestionsStatus { configured: true, model: Some("m".into()) });
        let partial = ai(&[("AI_API_URL", "https://x.test/v1"), ("AI_MODEL", "m")]);
        assert!(!status(&partial).configured);
        assert_eq!(status(&ai(&[("AI_MODEL", "")])).model.as_deref(), Some(""));
    }

    #[test]
    fn builds_the_completions_url() {
        let cfg = |url: &str| {
            provider(&ai(&[("AI_API_URL", url), ("AI_API_KEY", " k "), ("AI_MODEL", "m")]))
        };
        let settings = cfg("https://ai.example/v1").unwrap();
        assert_eq!(settings.url, "https://ai.example/v1/chat/completions");
        assert_eq!(settings.api_key, "k");
        assert_eq!(settings.model, "m");
        assert_eq!(
            cfg("https://ai.example/v1/").unwrap().url,
            "https://ai.example/v1/chat/completions"
        );
        assert_eq!(cfg("https://ai.example").unwrap().url, "https://ai.example/chat/completions");
    }

    #[test]
    fn refuses_unusable_provider_urls_with_503() {
        let err = |url: &str| {
            provider(&ai(&[("AI_API_URL", url), ("AI_API_KEY", "k"), ("AI_MODEL", "m")]))
                .unwrap_err()
        };
        assert_eq!(provider(&ai(&[])).unwrap_err().status_code(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(provider(&ai(&[])).unwrap_err().to_string().contains("AI is not configured"));
        assert!(err("not a url").to_string().contains("The AI provider URL is invalid."));
        for bad in [
            "http://ai.example/v1",
            "https://user:pw@ai.example/v1",
            "https://user@ai.example/v1",
            "https://ai.example/v1?key=1",
            "https://ai.example/v1#frag",
        ] {
            let e = err(bad);
            assert_eq!(e.status_code(), StatusCode::SERVICE_UNAVAILABLE, "{bad}");
            assert!(e.to_string().contains("HTTPS base URL without credentials"), "{bad}");
        }
    }
}
