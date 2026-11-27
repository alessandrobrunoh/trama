//! Request and response bodies of `/api/auth/*`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_contracts::common::ActorRef;
use trama_contracts::identity::User;
use trama_contracts::roles::ApiPermission;
use trama_core::AppError;
use trama_core::validation::{Checks, js_len};
use utoipa::ToSchema;

use crate::service::WorkspaceWithRole;
use crate::tokens::ApiTokenView;

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `@IsString() @MinLength(min) @MaxLength(max)`, reported in class-validator's order (the
/// decorators run bottom-up).
fn string_between(c: &mut Checks, field: &str, value: Option<&Value>, min: usize, max: usize) {
    let s = text(value);
    c.check(
        s.is_some_and(|s| js_len(s) <= max),
        format!("{field} must be shorter than or equal to {max} characters"),
    );
    c.check(
        s.is_some_and(|s| js_len(s) >= min),
        format!("{field} must be longer than or equal to {min} characters"),
    );
    c.check(s.is_some(), format!("{field} must be a string"));
}

fn email(c: &mut Checks, value: Option<&Value>) {
    let ok = text(value).is_some_and(|s| {
        let mut inner = Checks::new();
        inner.email("email", s);
        inner.finish().is_ok()
    });
    c.check(ok, "email must be an email");
}

/// `POST /auth/signup`.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct SignupBody {
    /// 1–100 characters.
    #[schema(value_type = String)]
    pub name: Option<Value>,
    /// An email address.
    #[schema(value_type = String)]
    pub email: Option<Value>,
    /// 8–200 characters.
    #[schema(value_type = String)]
    pub password: Option<Value>,
}

/// A validated [`SignupBody`].
#[derive(Debug)]
pub struct Signup {
    /// Display name.
    pub name: String,
    /// Email as sent.
    pub email: String,
    /// Password.
    pub password: String,
}

impl SignupBody {
    /// `SignupDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<Signup, AppError> {
        let mut c = Checks::new();
        string_between(&mut c, "name", self.name.as_ref(), 1, 100);
        email(&mut c, self.email.as_ref());
        string_between(&mut c, "password", self.password.as_ref(), 8, 200);
        c.finish()?;
        let owned = |v: Option<Value>| {
            v.and_then(|v| v.as_str().map(ToOwned::to_owned)).unwrap_or_default()
        };
        Ok(Signup {
            name: owned(self.name),
            email: owned(self.email),
            password: owned(self.password),
        })
    }
}

/// `POST /auth/login`.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct LoginBody {
    /// An email address.
    #[schema(value_type = String)]
    pub email: Option<Value>,
    /// 1–200 characters.
    #[schema(value_type = String)]
    pub password: Option<Value>,
}

impl LoginBody {
    /// `LoginDto`'s rules; returns `(email, password)`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<(String, String), AppError> {
        let mut c = Checks::new();
        email(&mut c, self.email.as_ref());
        string_between(&mut c, "password", self.password.as_ref(), 1, 200);
        c.finish()?;
        let owned = |v: Option<Value>| {
            v.and_then(|v| v.as_str().map(ToOwned::to_owned)).unwrap_or_default()
        };
        Ok((owned(self.email), owned(self.password)))
    }
}

/// The signed-in user and their workspaces (sign-up, login, `GET /auth/me`).
#[derive(Debug, Serialize, ToSchema)]
pub struct Session {
    /// The account.
    pub user: User,
    /// Workspaces with the user's role. An API token only sees its own workspace.
    pub workspaces: Vec<WorkspaceWithRole>,
}

/// The workspace of an API token.
#[derive(Debug, Serialize, ToSchema)]
pub struct TokenWorkspace {
    /// Workspace id.
    pub id: String,
    /// URL slug.
    pub slug: String,
    /// Display name.
    pub name: String,
}

/// `GET /auth/token`: what the presented API token is and may do.
#[derive(Debug, Serialize, ToSchema)]
pub struct TokenIntrospection {
    /// The token (no secret).
    pub token: ApiTokenView,
    /// Who it acts as.
    pub actor: ActorRef,
    /// Its workspace.
    pub workspace: TokenWorkspace,
    /// Effective permission list: the custom list, every `:read` for read tokens, else all.
    #[schema(value_type = Vec<ApiPermission>)]
    pub permissions: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[allow(clippy::needless_pass_by_value)] // takes `Result::unwrap_err()` directly
    fn messages(err: AppError) -> String {
        err.to_string()
    }

    #[test]
    fn signup_messages_follow_class_validator_order() {
        let body: SignupBody = serde_json::from_value(json!({})).unwrap();
        assert_eq!(
            messages(body.validate().unwrap_err()),
            "400 Bad Request: name must be shorter than or equal to 100 characters; name must be longer than or equal to 1 characters; name must be a string; email must be an email; password must be shorter than or equal to 200 characters; password must be longer than or equal to 8 characters; password must be a string"
        );
        let body: SignupBody = serde_json::from_value(
            json!({ "name": "", "email": "a@b.dev", "password": "x".repeat(201) }),
        )
        .unwrap();
        assert_eq!(
            messages(body.validate().unwrap_err()),
            "400 Bad Request: name must be longer than or equal to 1 characters; password must be shorter than or equal to 200 characters"
        );
        let ok: SignupBody = serde_json::from_value(
            json!({ "name": "Ada", "email": "a@b.dev", "password": "password123" }),
        )
        .unwrap();
        assert_eq!(ok.validate().unwrap().name, "Ada");
    }

    #[test]
    fn login_messages_follow_class_validator_order() {
        let body: LoginBody = serde_json::from_value(json!({})).unwrap();
        assert_eq!(
            messages(body.validate().unwrap_err()),
            "400 Bad Request: email must be an email; password must be shorter than or equal to 200 characters; password must be longer than or equal to 1 characters; password must be a string"
        );
        let body: LoginBody =
            serde_json::from_value(json!({ "email": "a@b.dev", "password": "" })).unwrap();
        assert_eq!(
            messages(body.validate().unwrap_err()),
            "400 Bad Request: password must be longer than or equal to 1 characters"
        );
    }
}
