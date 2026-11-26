//! External identities of the Trama API: the port of `server/src/external-identities`.
//!
//! A person's logins in other tools (GitHub, GitLab, Bitbucket, Linear, Jira), and the one
//! resolver that maps a login back to them.
//!
//! * [`router`]: `GET` and `POST /api/me/external-identities`, `DELETE
//!   /api/me/external-identities/{id}`;
//! * [`service`]: what other crates call. Every function takes a connection (`&state.db` or a
//!   transaction):
//!   * [`service::ensure_from_connection`] when a personal integration connection is created:
//!     its account login becomes an identity of the owner (never fails on a conflict);
//!   * [`service::resolve_user_by_login`], [`service::resolve_member_by_login`] and
//!     [`service::resolve_members_by_logins`] for assignees, review requests, mentions and
//!     activity, with [`service::ResolveOptions::verified_only`] to ignore logins typed by hand;
//!   * [`service::logins_of`], [`service::identity_key`] and the list, add and remove behind the
//!     routes.

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{IdentityKey, ResolveOptions, identity_key};
