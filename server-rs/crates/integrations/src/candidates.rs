//! Normalized provider data (`candidates.ts`): what webhooks and routing hand to the
//! [artifact linker](crate::linker).

use trama_contracts::common::GitProvider;
use trama_contracts::issues::{ArtifactKind, ArtifactState, CiState, ReviewState};

/// A normalized PR/MR as reported by a webhook (or, later, a sync). Fields left `None` are not
/// touched on existing artifacts and defaulted on new ones.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactCandidate {
    /// `pull_request` or `merge_request`.
    pub kind: ArtifactKind,
    /// The git host.
    pub provider: GitProvider,
    /// `#182` (GitHub, Bitbucket) / `!12` (GitLab).
    pub external_id: String,
    /// Title.
    pub title: String,
    /// Link.
    pub url: Option<String>,
    /// Lifecycle state.
    pub state: Option<ArtifactState>,
    /// CI status.
    pub ci: Option<CiState>,
    /// Review status.
    pub review: Option<ReviewState>,
    /// Merge conflicts.
    pub has_conflicts: Option<bool>,
    /// Head commit.
    pub head_sha: Option<String>,
    /// Head branch.
    pub head_branch: Option<String>,
    /// Free text scanned (case-sensitively) for issue keys: title, body.
    pub texts: Vec<String>,
    /// Branch names, scanned case-insensitively (`auth-42/replay`).
    pub branch_texts: Vec<String>,
    /// Only apply `review` when the artifact's current review is one of these.
    pub review_only_from: Option<Vec<ReviewState>>,
    /// Logins asked to review, as the provider spells them. Mapped to people through external
    /// identities.
    pub reviewer_logins: Vec<String>,
    /// Login of whoever caused the event (the webhook sender), as the provider spells it.
    pub actor_login: Option<String>,
}

impl ArtifactCandidate {
    /// A candidate with only the required fields.
    #[must_use]
    pub fn new(
        kind: ArtifactKind,
        provider: GitProvider,
        external_id: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            provider,
            external_id: external_id.into(),
            title: title.into(),
            url: None,
            state: None,
            ci: None,
            review: None,
            has_conflicts: None,
            head_sha: None,
            head_branch: None,
            texts: Vec::new(),
            branch_texts: Vec::new(),
            review_only_from: None,
            reviewer_logins: Vec::new(),
            actor_login: None,
        }
    }
}

/// Labels and milestone of an issue or PR, which routing rules filter on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemMeta {
    /// Label names.
    pub labels: Vec<String>,
    /// Milestone title.
    pub milestone: Option<String>,
}

/// Open or closed, as a provider reports an issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueCandidateState {
    /// Open.
    Open,
    /// Closed.
    Closed,
}

/// GitHub's `state_reason` of a closed issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateReason {
    /// Done.
    Completed,
    /// Dropped.
    NotPlanned,
}

impl StateReason {
    /// The wire string GitHub uses.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::NotPlanned => "not_planned",
        }
    }
}

/// A normalized issue as reported by a webhook. Only routing rules turn it into a task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueCandidate {
    /// The git host.
    pub provider: GitProvider,
    /// `#12`.
    pub external_id: String,
    /// Issue number.
    pub number: i64,
    /// Title.
    pub title: String,
    /// Body.
    pub body: Option<String>,
    /// Link.
    pub url: Option<String>,
    /// Open or closed.
    pub state: IssueCandidateState,
    /// GitHub's `state_reason` of a closed issue.
    pub state_reason: Option<StateReason>,
    /// Label names.
    pub labels: Vec<String>,
    /// Milestone title.
    pub milestone: Option<String>,
    /// Login of the person who opened it.
    pub author: Option<String>,
}

/// CI result for a commit; applied to every PR/MR whose head is `sha` (or listed explicitly).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CiPatch {
    /// Head commit.
    pub sha: Option<String>,
    /// PR/MR external ids.
    pub pr_external_ids: Vec<String>,
    /// The new CI status.
    pub ci: CiState,
}

/// A repository as a webhook names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoMeta {
    /// `owner/name`.
    pub full_name: String,
    /// Web URL.
    pub url: Option<String>,
    /// Default branch.
    pub default_branch: Option<String>,
}
