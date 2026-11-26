//! Request and response bodies of the workspace routes: the DTO classes of
//! `workspaces.controller.ts`, `labels.controller.ts` and `statuses.controller.ts`.
//!
//! Every request body keeps its fields as [`Field`]s and `validate()` applies the
//! class-validator rules of the DTO (messages and order included), returning the typed input the
//! service takes.

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_auth::tokens::ApiTokenView;
use trama_contracts::common::AgentProvider;
use trama_contracts::identity::{Membership, User};
use trama_contracts::labels::{LABEL_NAME_MAX, LABEL_SCOPES, LabelScope};
use trama_contracts::roles::{MAX_TOKEN_LIMITS, ROLE_NAME_MAX, TokenScope};
use trama_contracts::settings::{ESTIMATE_SCALES, EstimateScale, WEEK_STARTS, WeekStart};
use trama_contracts::status::{STATUS_ICON_MAX, STATUS_NAME_MAX};
use trama_core::AppError;
use trama_core::validation::{Checks, Patch};
use utoipa::ToSchema;

use crate::validate::{
    self as v, Field,
    Presence::{Required, SkipMissing, SkipUnset},
};

fn finish(c: Checks) -> Result<(), AppError> {
    c.finish()
}

fn string_of(field: &Field) -> Option<String> {
    field.as_value().and_then(Value::as_str).map(ToOwned::to_owned)
}

/// A string field as a [`Patch`]: absent, cleared or set.
fn string_patch(field: &Field) -> Patch<String> {
    match field {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(value) => value.as_str().map_or(Patch::Null, |s| Patch::Value(s.to_owned())),
    }
}

fn list_of(field: &Field) -> Option<Vec<String>> {
    field.as_value().map(|_| v::strings(field))
}

// ───────────────────────────── workspaces ─────────────────────────────

/// `POST /workspaces` (`CreateWorkspaceDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateWorkspaceBody {
    /// 1-80 characters.
    #[serde(default)]
    #[schema(value_type = String)]
    pub name: Field,
    /// Up to 40 characters; derived from the name when omitted.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub slug: Field,
}

/// A validated [`CreateWorkspaceBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewWorkspace {
    /// Display name (trimmed when stored).
    pub name: String,
    /// The slug the caller asked for.
    pub slug: Option<String>,
}

impl CreateWorkspaceBody {
    /// `CreateWorkspaceDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewWorkspace, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "name", &self.name, Some(1), Some(80));
        v::string(&mut c, SkipUnset, "slug", &self.slug, None, Some(40));
        finish(c)?;
        Ok(NewWorkspace {
            name: string_of(&self.name).unwrap_or_default(),
            slug: string_of(&self.slug),
        })
    }
}

/// `PATCH /w/{slug}` (`UpdateWorkspaceDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateWorkspaceBody {
    /// 1-80 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// Up to 40 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub slug: Field,
}

/// A validated [`UpdateWorkspaceBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspacePatch {
    /// New name.
    pub name: Option<String>,
    /// New slug.
    pub slug: Option<String>,
}

impl UpdateWorkspaceBody {
    /// `UpdateWorkspaceDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<WorkspacePatch, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipMissing, "name", &self.name, Some(1), Some(80));
        v::string(&mut c, SkipMissing, "slug", &self.slug, None, Some(40));
        finish(c)?;
        Ok(WorkspacePatch { name: string_of(&self.name), slug: string_of(&self.slug) })
    }
}

/// `PATCH /w/{slug}/settings` (`UpdateSettingsDto`): everything optional; `null` clears
/// `iconColor` and `iconInitial`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsBody {
    /// `fibonacci`, `linear`, `exponential`, `tshirt` or `none`.
    #[serde(default)]
    #[schema(value_type = Option<EstimateScale>)]
    pub estimate_scale: Field,
    /// `monday`, `sunday` or `saturday`.
    #[serde(default)]
    #[schema(value_type = Option<WeekStart>)]
    pub week_start: Field,
    /// An IANA time zone or `auto`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub time_zone: Field,
    /// `#rrggbb`; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub icon_color: Field,
    /// 1-2 characters; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub icon_initial: Field,
}

/// A validated [`UpdateSettingsBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SettingsPatch {
    /// New estimate scale.
    pub estimate_scale: Option<EstimateScale>,
    /// New first day of the week.
    pub week_start: Option<WeekStart>,
    /// New time zone.
    pub time_zone: Option<String>,
    /// New icon color, or clear it.
    pub icon_color: Patch<String>,
    /// New icon initial, or clear it.
    pub icon_initial: Patch<String>,
}

impl UpdateSettingsBody {
    /// `UpdateSettingsDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<SettingsPatch, AppError> {
        let mut c = Checks::new();
        let scales: Vec<&str> = ESTIMATE_SCALES.iter().map(|s| s.as_str()).collect();
        let starts: Vec<&str> = WEEK_STARTS.iter().map(|s| s.as_str()).collect();
        v::one_of(&mut c, SkipMissing, "estimateScale", &self.estimate_scale, &scales);
        v::one_of(&mut c, SkipMissing, "weekStart", &self.week_start, &starts);
        v::string(&mut c, SkipMissing, "timeZone", &self.time_zone, None, Some(64));
        v::hex_color(&mut c, SkipUnset, "iconColor", &self.icon_color);
        v::string(&mut c, SkipUnset, "iconInitial", &self.icon_initial, None, Some(2));
        finish(c)?;
        Ok(SettingsPatch {
            estimate_scale: string_of(&self.estimate_scale).and_then(|s| EstimateScale::parse(&s)),
            week_start: string_of(&self.week_start).and_then(|s| WeekStart::parse(&s)),
            time_zone: string_of(&self.time_zone),
            icon_color: string_patch(&self.icon_color),
            icon_initial: string_patch(&self.icon_initial),
        })
    }
}

/// `DELETE /w/{slug}` (`DeleteWorkspaceDto`): repeat the slug or the name.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct DeleteWorkspaceBody {
    /// The workspace slug or its exact name.
    #[serde(default)]
    #[schema(value_type = String)]
    pub confirm: Field,
}

impl DeleteWorkspaceBody {
    /// `DeleteWorkspaceDto`'s rules; returns `confirm`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<String, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "confirm", &self.confirm, Some(1), Some(200));
        finish(c)?;
        Ok(string_of(&self.confirm).unwrap_or_default())
    }
}

/// `POST /w/{slug}/transfer-ownership` (`TransferOwnershipDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferOwnershipBody {
    /// Membership id of the new owner.
    #[serde(default)]
    #[schema(value_type = String)]
    pub membership_id: Field,
}

impl TransferOwnershipBody {
    /// `TransferOwnershipDto`'s rules; returns the membership id.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<String, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "membershipId", &self.membership_id, Some(1), None);
        finish(c)?;
        Ok(string_of(&self.membership_id).unwrap_or_default())
    }
}

// ───────────────────────────── roles ─────────────────────────────

/// `POST /w/{slug}/roles` (`RoleBodyDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateRoleBody {
    /// 1-40 characters.
    #[serde(default)]
    #[schema(value_type = String)]
    pub name: Field,
    /// Capability ids.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub capabilities: Field,
    /// Member grants (`<resource>:<action>`).
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub grants: Field,
}

/// A validated [`CreateRoleBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRole {
    /// Role name.
    pub name: String,
    /// Capability ids, as sent.
    pub capabilities: Option<Vec<String>>,
    /// Grants, as sent.
    pub grants: Option<Vec<String>>,
}

impl CreateRoleBody {
    /// `RoleBodyDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewRole, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "name", &self.name, Some(1), Some(ROLE_NAME_MAX));
        v::string_array(&mut c, SkipUnset, "capabilities", &self.capabilities, None);
        v::string_array(&mut c, SkipUnset, "grants", &self.grants, None);
        finish(c)?;
        Ok(NewRole {
            name: string_of(&self.name).unwrap_or_default(),
            capabilities: list_of(&self.capabilities),
            grants: list_of(&self.grants),
        })
    }
}

/// `PATCH /w/{slug}/roles/{roleId}` (`UpdateRoleDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateRoleBody {
    /// 1-40 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// Capability ids.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub capabilities: Field,
    /// Member grants (`<resource>:<action>`).
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub grants: Field,
}

/// A validated [`UpdateRoleBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RolePatch {
    /// New name.
    pub name: Option<String>,
    /// New capabilities, as sent.
    pub capabilities: Option<Vec<String>>,
    /// New grants, as sent.
    pub grants: Option<Vec<String>>,
}

impl UpdateRoleBody {
    /// `UpdateRoleDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<RolePatch, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipMissing, "name", &self.name, Some(1), Some(ROLE_NAME_MAX));
        v::string_array(&mut c, SkipUnset, "capabilities", &self.capabilities, None);
        v::string_array(&mut c, SkipUnset, "grants", &self.grants, None);
        finish(c)?;
        Ok(RolePatch {
            name: string_of(&self.name),
            capabilities: list_of(&self.capabilities),
            grants: list_of(&self.grants),
        })
    }
}

// ───────────────────────────── members ─────────────────────────────

/// `POST /w/{slug}/members` (`AddMemberDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct AddMemberBody {
    /// The person's account email.
    #[serde(default)]
    #[schema(value_type = String)]
    pub email: Field,
    /// A workspace role id.
    #[serde(default)]
    #[schema(value_type = String)]
    pub role: Field,
}

/// A validated [`AddMemberBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewMember {
    /// Email as sent.
    pub email: String,
    /// Role id.
    pub role: String,
}

impl AddMemberBody {
    /// `AddMemberDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewMember, AppError> {
        let mut c = Checks::new();
        v::email(&mut c, Required, "email", &self.email);
        v::string(&mut c, Required, "role", &self.role, Some(1), Some(80));
        finish(c)?;
        Ok(NewMember {
            email: string_of(&self.email).unwrap_or_default(),
            role: string_of(&self.role).unwrap_or_default(),
        })
    }
}

/// `PATCH /w/{slug}/members/{id}` (`ChangeRoleDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ChangeMemberBody {
    /// A workspace role id.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub role: Field,
    /// `null` clears a custom access and restores the role. Omitted leaves it unchanged.
    #[serde(default)]
    #[schema(value_type = Option<trama_contracts::access::MemberAccess>)]
    pub access: Field,
}

/// A validated [`ChangeMemberBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemberPatch {
    /// New role; `Null` is refused later as an unknown role, as NestJS does.
    pub role: Patch<String>,
    /// New access: absent, `null` (restore the role) or an object.
    pub access: Patch<Value>,
}

impl ChangeMemberBody {
    /// `ChangeRoleDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<MemberPatch, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipUnset, "role", &self.role, Some(1), Some(80));
        finish(c)?;
        Ok(MemberPatch { role: string_patch(&self.role), access: self.access })
    }
}

/// A membership with its person (`Object.assign(membership, { user })`).
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct MemberWithUser {
    /// The membership.
    #[serde(flatten)]
    pub membership: Membership,
    /// The account; absent when it no longer exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
}

// ───────────────────────────── agents ─────────────────────────────

const PROVIDERS: [&str; 5] = ["delta", "claude_code", "codex", "cursor", "other"];

/// `POST /w/{slug}/agents` (`CreateAgentDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentBody {
    /// 1-80 characters.
    #[serde(default)]
    #[schema(value_type = String)]
    pub name: Field,
    /// `delta`, `claude_code`, `codex`, `cursor` or `other`.
    #[serde(default)]
    #[schema(value_type = AgentProvider)]
    pub provider: Field,
    /// Up to 500 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub description: Field,
    /// A workspace member.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub owner_user_id: Field,
}

/// A validated [`CreateAgentBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewAgent {
    /// Display name.
    pub name: String,
    /// Runtime.
    pub provider: AgentProvider,
    /// What it does.
    pub description: Option<String>,
    /// The responsible person.
    pub owner_user_id: Option<String>,
}

impl CreateAgentBody {
    /// `CreateAgentDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewAgent, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "name", &self.name, Some(1), Some(80));
        v::one_of(&mut c, Required, "provider", &self.provider, &PROVIDERS);
        v::string(&mut c, SkipUnset, "description", &self.description, None, Some(500));
        v::string(&mut c, SkipUnset, "ownerUserId", &self.owner_user_id, None, None);
        finish(c)?;
        Ok(NewAgent {
            name: string_of(&self.name).unwrap_or_default(),
            provider: string_of(&self.provider)
                .and_then(|p| AgentProvider::parse(&p))
                .unwrap_or(AgentProvider::Other),
            description: string_of(&self.description),
            owner_user_id: string_of(&self.owner_user_id),
        })
    }
}

/// `PATCH /w/{slug}/agents/{id}` (`UpdateAgentDto`): `null` clears `description` and
/// `ownerUserId`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentBody {
    /// 1-80 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// `delta`, `claude_code`, `codex`, `cursor` or `other`.
    #[serde(default)]
    #[schema(value_type = Option<AgentProvider>)]
    pub provider: Field,
    /// Up to 500 characters; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub description: Field,
    /// A workspace member; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub owner_user_id: Field,
}

/// A validated [`UpdateAgentBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentPatch {
    /// New name.
    pub name: Option<String>,
    /// New runtime.
    pub provider: Option<AgentProvider>,
    /// New description, or clear it.
    pub description: Patch<String>,
    /// New owner, or clear it.
    pub owner_user_id: Patch<String>,
}

impl UpdateAgentBody {
    /// `UpdateAgentDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<AgentPatch, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipMissing, "name", &self.name, Some(1), Some(80));
        v::one_of(&mut c, SkipMissing, "provider", &self.provider, &PROVIDERS);
        v::string(&mut c, SkipUnset, "description", &self.description, None, Some(500));
        v::string(&mut c, SkipUnset, "ownerUserId", &self.owner_user_id, None, None);
        finish(c)?;
        Ok(AgentPatch {
            name: string_of(&self.name),
            provider: string_of(&self.provider).and_then(|p| AgentProvider::parse(&p)),
            description: string_patch(&self.description),
            owner_user_id: string_patch(&self.owner_user_id),
        })
    }
}

// ───────────────────────────── tokens ─────────────────────────────

/// `POST /w/{slug}/tokens` (`CreateTokenDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateTokenBody {
    /// 1-80 characters.
    #[serde(default)]
    #[schema(value_type = String)]
    pub name: Field,
    /// Default `write`. `admin` needs an admin caller and a user token.
    #[serde(default)]
    #[schema(value_type = Option<TokenScope>)]
    pub scope: Field,
    /// `<resource>:<action>` list; implies `scope: 'custom'`.
    #[serde(default)]
    #[schema(value_type = Option<Vec<String>>)]
    pub permissions: Field,
    /// Request / write budget; omitted values use the defaults.
    #[serde(default)]
    #[schema(value_type = Option<trama_contracts::roles::TokenLimits>)]
    pub limits: Field,
    /// Omit to create a token that acts as you; set to create an agent token (admin).
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub agent_id: Field,
    /// ISO 8601 expiry.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub expires_at: Field,
}

/// A validated [`CreateTokenBody`].
#[derive(Clone, Debug, PartialEq)]
pub struct NewApiToken {
    /// Display name.
    pub name: String,
    /// Requested scope.
    pub scope: Option<TokenScope>,
    /// Requested permissions, as sent.
    pub permissions: Option<Vec<String>>,
    /// Requested limits (an object with up to the three budgets).
    pub limits: Option<Value>,
    /// The agent the token acts as.
    pub agent_id: Option<String>,
    /// Expiry.
    pub expires_at: Option<DateTime<FixedOffset>>,
}

impl CreateTokenBody {
    /// `CreateTokenDto`'s rules, nested `limits` included.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewApiToken, AppError> {
        let mut c = Checks::new();
        let scopes = ["read", "write", "admin", "custom"];
        v::string(&mut c, Required, "name", &self.name, Some(1), Some(80));
        v::one_of(&mut c, SkipUnset, "scope", &self.scope, &scopes);
        v::string_array(&mut c, SkipUnset, "permissions", &self.permissions, Some(60));
        let limits = validate_limits(&mut c, &self.limits);
        v::starts_with(&mut c, SkipUnset, "agentId", &self.agent_id, "ag_");
        v::iso8601(&mut c, SkipUnset, "expiresAt", &self.expires_at);
        finish(c)?;
        Ok(NewApiToken {
            name: string_of(&self.name).unwrap_or_default(),
            scope: string_of(&self.scope).and_then(|s| TokenScope::parse(&s)),
            permissions: list_of(&self.permissions),
            limits,
            agent_id: string_of(&self.agent_id),
            expires_at: string_of(&self.expires_at).and_then(|s| v::parse_iso8601(&s)),
        })
    }
}

/// `@ValidateNested() @Type(() => TokenLimitsDto)`: keeps the three budgets of an object.
fn validate_limits(c: &mut Checks, field: &Field) -> Option<Value> {
    let value = field.as_value()?;
    let Value::Object(map) = value else {
        if !value.is_array() {
            c.check(false, "nested property limits must be either object or array");
        }
        return None;
    };
    let budgets = [
        ("requestsPerMinute", MAX_TOKEN_LIMITS.requests_per_minute),
        ("writesPerMinute", MAX_TOKEN_LIMITS.writes_per_minute),
        ("writesPerDay", MAX_TOKEN_LIMITS.writes_per_day),
    ];
    let mut kept = serde_json::Map::new();
    for (key, max) in budgets {
        let entry: Field = match map.get(key) {
            None => Patch::Missing,
            Some(Value::Null) => Patch::Null,
            Some(other) => Patch::Value(other.clone()),
        };
        v::integer(c, SkipUnset, &format!("limits.{key}"), &entry, 1, max);
        if let Patch::Value(value) = entry {
            kept.insert(key.to_owned(), value);
        }
    }
    Some(Value::Object(kept))
}

/// `{ token, secret }`: the secret is shown only this once.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct TokenCreated {
    /// The stored token (no secret).
    pub token: ApiTokenView,
    /// The bearer secret, `trm_…`.
    pub secret: String,
}

// ───────────────────────────── labels ─────────────────────────────

/// `POST /w/{slug}/labels` (`CreateLabelDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateLabelBody {
    /// 1-40 characters.
    #[serde(default)]
    #[schema(value_type = String)]
    pub name: Field,
    /// `#rrggbb`; the next free swatch when omitted.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub color: Field,
    /// `issue` or `project`.
    #[serde(default)]
    #[schema(value_type = LabelScope)]
    pub scope: Field,
}

/// A validated [`CreateLabelBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewLabel {
    /// Label name.
    pub name: String,
    /// Color as sent.
    pub color: Option<String>,
    /// Which records it applies to.
    pub scope: LabelScope,
}

impl CreateLabelBody {
    /// `CreateLabelDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewLabel, AppError> {
        let mut c = Checks::new();
        let scopes: Vec<&str> = LABEL_SCOPES.iter().map(|s| s.as_str()).collect();
        v::string(&mut c, Required, "name", &self.name, Some(1), Some(LABEL_NAME_MAX));
        v::hex_color(&mut c, SkipUnset, "color", &self.color);
        v::one_of(&mut c, Required, "scope", &self.scope, &scopes);
        finish(c)?;
        Ok(NewLabel {
            name: string_of(&self.name).unwrap_or_default(),
            color: string_of(&self.color),
            scope: string_of(&self.scope)
                .and_then(|s| LabelScope::parse(&s))
                .unwrap_or(LabelScope::Issue),
        })
    }
}

/// `PATCH /w/{slug}/labels/{id}` (`UpdateLabelDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateLabelBody {
    /// 1-40 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// `#rrggbb`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub color: Field,
    /// Archive or restore.
    #[serde(default)]
    #[schema(value_type = Option<bool>)]
    pub archived: Field,
    /// `issue` or `project`.
    #[serde(default)]
    #[schema(value_type = Option<LabelScope>)]
    pub scope: Field,
}

/// A validated [`UpdateLabelBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LabelPatch {
    /// New name.
    pub name: Option<String>,
    /// New color.
    pub color: Option<String>,
    /// Archive (`true`) or restore (`false`).
    pub archived: Option<bool>,
    /// New scope.
    pub scope: Option<LabelScope>,
}

impl UpdateLabelBody {
    /// `UpdateLabelDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<LabelPatch, AppError> {
        let mut c = Checks::new();
        let scopes: Vec<&str> = LABEL_SCOPES.iter().map(|s| s.as_str()).collect();
        v::string(&mut c, SkipMissing, "name", &self.name, Some(1), Some(LABEL_NAME_MAX));
        v::hex_color(&mut c, SkipMissing, "color", &self.color);
        v::boolean(&mut c, SkipMissing, "archived", &self.archived);
        v::one_of(&mut c, SkipMissing, "scope", &self.scope, &scopes);
        finish(c)?;
        Ok(LabelPatch {
            name: string_of(&self.name),
            color: string_of(&self.color),
            archived: self.archived.as_value().and_then(Value::as_bool),
            scope: string_of(&self.scope).and_then(|s| LabelScope::parse(&s)),
        })
    }
}

/// `POST /w/{slug}/labels/{id}/merge` (`MergeLabelDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct MergeLabelBody {
    /// The label that takes over.
    #[serde(default)]
    #[schema(value_type = String)]
    pub into: Field,
}

impl MergeLabelBody {
    /// `MergeLabelDto`'s rules; returns `into`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<String, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, Required, "into", &self.into, Some(1), Some(80));
        finish(c)?;
        Ok(string_of(&self.into).unwrap_or_default())
    }
}

// ───────────────────────────── statuses ─────────────────────────────

/// `POST /w/{slug}/statuses/{subject}` (`CreateStatusDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CreateStatusBody {
    /// 1-40 characters; derived from the type when omitted.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// A Lucide icon name (kebab-case) or one emoji.
    #[serde(default)]
    #[schema(value_type = String)]
    pub icon: Field,
    /// `#rrggbb`.
    #[serde(default)]
    #[schema(value_type = String)]
    pub color: Field,
    /// The semantic type.
    #[serde(default, rename = "type")]
    #[schema(value_type = String)]
    pub kind: Field,
}

/// A validated [`CreateStatusBody`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewStatus {
    /// Display name.
    pub name: Option<String>,
    /// Icon.
    pub icon: String,
    /// Color.
    pub color: String,
    /// Semantic type.
    pub kind: String,
}

impl CreateStatusBody {
    /// `CreateStatusDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewStatus, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipUnset, "name", &self.name, Some(1), Some(STATUS_NAME_MAX));
        v::string(&mut c, Required, "icon", &self.icon, Some(1), Some(STATUS_ICON_MAX));
        v::hex_color(&mut c, Required, "color", &self.color);
        v::string(&mut c, Required, "type", &self.kind, Some(1), Some(40));
        finish(c)?;
        Ok(NewStatus {
            name: string_of(&self.name),
            icon: string_of(&self.icon).unwrap_or_default(),
            color: string_of(&self.color).unwrap_or_default(),
            kind: string_of(&self.kind).unwrap_or_default(),
        })
    }
}

/// `PATCH /w/{slug}/statuses/{subject}/{id}` (`UpdateStatusDto`).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateStatusBody {
    /// 1-40 characters.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Field,
    /// A Lucide icon name (kebab-case) or one emoji.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub icon: Field,
    /// `#rrggbb`.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub color: Field,
}

/// A validated [`UpdateStatusBody`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusPatch {
    /// New name.
    pub name: Option<String>,
    /// New icon.
    pub icon: Option<String>,
    /// New color.
    pub color: Option<String>,
}

impl UpdateStatusBody {
    /// `UpdateStatusDto`'s rules.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<StatusPatch, AppError> {
        let mut c = Checks::new();
        v::string(&mut c, SkipMissing, "name", &self.name, Some(1), Some(STATUS_NAME_MAX));
        v::string(&mut c, SkipMissing, "icon", &self.icon, Some(1), Some(STATUS_ICON_MAX));
        v::hex_color(&mut c, SkipMissing, "color", &self.color);
        finish(c)?;
        Ok(StatusPatch {
            name: string_of(&self.name),
            icon: string_of(&self.icon),
            color: string_of(&self.color),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body<T: serde::de::DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).unwrap()
    }

    fn error(result: Result<impl std::fmt::Debug, AppError>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn workspace_bodies() {
        assert_eq!(
            error(body::<DeleteWorkspaceBody>(json!({})).validate()),
            "400 Bad Request: confirm must be shorter than or equal to 200 characters; confirm must be longer than or equal to 1 characters; confirm must be a string"
        );
        assert!(body::<DeleteWorkspaceBody>(json!({ "confirm": 42 })).validate().is_err());
        assert_eq!(
            body::<DeleteWorkspaceBody>(json!({ "confirm": "acme" })).validate().unwrap(),
            "acme"
        );
        assert!(body::<UpdateWorkspaceBody>(json!({ "name": null })).validate().is_err());
        let patch = body::<UpdateSettingsBody>(json!({ "iconColor": null, "weekStart": "sunday" }))
            .validate()
            .unwrap();
        assert_eq!(patch.week_start, Some(WeekStart::Sunday));
        assert_eq!(patch.icon_color, Patch::Null);
        assert_eq!(patch.icon_initial, Patch::Missing);
        assert_eq!(
            error(
                body::<UpdateSettingsBody>(json!({ "iconColor": "red", "estimateScale": "huge" }))
                    .validate()
            ),
            "400 Bad Request: estimateScale must be one of the following values: fibonacci, linear, exponential, tshirt, none; iconColor must be #rrggbb"
        );
    }

    #[test]
    fn token_bodies() {
        let token = body::<CreateTokenBody>(json!({
            "name": "k", "permissions": ["tasks:write"], "limits": { "writesPerDay": 5, "bogus": 1 },
            "expiresAt": "2026-11-25T14:01:36.424Z",
        }))
        .validate()
        .unwrap();
        assert_eq!(token.limits, Some(json!({ "writesPerDay": 5 })));
        assert!(token.expires_at.is_some());
        assert_eq!(
            error(
                body::<CreateTokenBody>(
                    json!({ "name": "k", "limits": { "writesPerDay": 10_000_000 }, "agentId": "x" })
                )
                .validate()
            ),
            "400 Bad Request: limits.writesPerDay must not be greater than 20000; agentId must match /^ag_/ regular expression"
        );
        assert_eq!(
            error(body::<CreateTokenBody>(json!({ "name": "k", "limits": "x" })).validate()),
            "400 Bad Request: nested property limits must be either object or array"
        );
    }

    #[test]
    fn label_and_status_bodies() {
        assert_eq!(
            error(body::<CreateLabelBody>(json!({ "name": "Bug" })).validate()),
            "400 Bad Request: scope must be one of the following values: issue, project"
        );
        assert_eq!(
            body::<CreateStatusBody>(json!({ "icon": "bug", "color": "#3F6BD6", "type": "todo" }))
                .validate()
                .unwrap()
                .name,
            None
        );
        assert!(body::<UpdateStatusBody>(json!({ "color": "blue" })).validate().is_err());
        assert!(body::<UpdateLabelBody>(json!({ "archived": "yes" })).validate().is_err());
    }

    #[test]
    fn member_and_agent_bodies() {
        let patch = body::<ChangeMemberBody>(json!({ "access": null })).validate().unwrap();
        assert_eq!(patch.access, Patch::Null);
        assert_eq!(patch.role, Patch::Missing);
        assert_eq!(
            body::<ChangeMemberBody>(json!({ "role": null })).validate().unwrap().role,
            Patch::Null
        );
        assert!(
            body::<AddMemberBody>(json!({ "email": "x", "role": "member" })).validate().is_err()
        );
        let agent = body::<UpdateAgentBody>(json!({ "description": null })).validate().unwrap();
        assert_eq!(agent.description, Patch::Null);
        assert!(
            body::<CreateAgentBody>(json!({ "name": "Bot", "provider": "gpt" }))
                .validate()
                .is_err()
        );
        assert_eq!(
            body::<CreateRoleBody>(
                json!({ "name": "Support", "capabilities": ["manageProjects"] })
            )
            .validate()
            .unwrap()
            .capabilities,
            Some(vec!["manageProjects".to_owned()])
        );
    }
}
