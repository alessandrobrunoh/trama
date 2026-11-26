//! Request and response bodies of the external identities routes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::identity::{
    EXTERNAL_IDENTITY_LOGIN_MAX, EXTERNAL_IDENTITY_PROVIDERS, ExternalIdentityInput,
    ExternalIdentityProvider, ExternalIdentitySource,
};
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_core::validation::{Checks, js_len};
use trama_entities::external_identities;
use utoipa::ToSchema;

/// A stored identity as the API shows it (`ExternalIdentityEntity` as JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ExternalIdentity)]
pub struct ExternalIdentityView {
    /// Identity id (`xid_…`).
    pub id: String,
    /// Owner.
    pub user_id: String,
    /// Tool.
    #[schema(value_type = ExternalIdentityProvider)]
    pub provider: String,
    /// Lower-case host without scheme or path, e.g. `github.com`.
    pub host: String,
    /// The login as the tool spells it. Compared case-insensitively.
    pub login: String,
    /// How it was added.
    #[schema(value_type = ExternalIdentitySource)]
    pub source: String,
    /// Creation time.
    pub created_at: String,
}

impl From<external_identities::Model> for ExternalIdentityView {
    fn from(row: external_identities::Model) -> Self {
        Self {
            created_at: to_iso(&row.created_at),
            id: row.id,
            user_id: row.user_id,
            provider: row.provider,
            host: row.host,
            login: row.login,
            source: row.source,
        }
    }
}

/// The longest `host` the body accepts.
const HOST_MAX: usize = 300;

/// Body of `POST /api/me/external-identities` (`AddExternalIdentityDto`).
///
/// The fields are read as raw JSON so a wrong type produces the class-validator message, as
/// NestJS does.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct AddExternalIdentityDto {
    /// `github`, `gitlab`, `bitbucket`, `linear` or `jira`.
    #[serde(default)]
    #[schema(value_type = ExternalIdentityProvider)]
    pub provider: Option<Value>,
    /// A bare host or a URL; defaults to the provider's public host. Required for Jira.
    #[serde(default)]
    #[schema(value_type = Option<String>, max_length = 300)]
    pub host: Option<Value>,
    /// The login, with or without a leading `@` (1 to 101 characters).
    #[serde(default)]
    #[schema(value_type = String, min_length = 1, max_length = 101)]
    pub login: Option<Value>,
}

impl AddExternalIdentityDto {
    /// `@IsIn(EXTERNAL_IDENTITY_PROVIDERS) provider`, `@IsOptional() @IsString()
    /// @MaxLength(300) host` and `@IsString() @MinLength(1) @MaxLength(login max + 1) login`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule (class-validator reports the decorator nearest the
    /// property first).
    pub fn validate(&self) -> Result<ExternalIdentityInput, AppError> {
        let provider = self
            .provider
            .as_ref()
            .and_then(Value::as_str)
            .and_then(ExternalIdentityProvider::parse);
        let host = self.host.as_ref().filter(|v| !v.is_null());
        let host_text = host.and_then(Value::as_str);
        let login = self.login.as_ref().and_then(Value::as_str);
        let allowed: Vec<&str> = EXTERNAL_IDENTITY_PROVIDERS.iter().map(|p| p.as_str()).collect();
        let login_max = EXTERNAL_IDENTITY_LOGIN_MAX + 1;
        let mut c = Checks::new();
        c.check(
            provider.is_some(),
            format!("provider must be one of the following values: {}", allowed.join(", ")),
        );
        if host.is_some() {
            c.check(
                host_text.is_some_and(|h| js_len(h) <= HOST_MAX),
                format!("host must be shorter than or equal to {HOST_MAX} characters"),
            )
            .check(host_text.is_some(), "host must be a string");
        }
        c.check(
            login.is_some_and(|l| js_len(l) <= login_max),
            format!("login must be shorter than or equal to {login_max} characters"),
        )
        .check(
            login.is_some_and(|l| js_len(l) >= 1),
            "login must be longer than or equal to 1 characters",
        )
        .check(login.is_some(), "login must be a string");
        c.finish()?;
        match (provider, login) {
            (Some(provider), Some(login)) => Ok(ExternalIdentityInput {
                provider,
                host: host_text.map(ToOwned::to_owned),
                login: login.to_owned(),
            }),
            _ => Err(AppError::bad_request("invalid external identity")),
        }
    }
}
