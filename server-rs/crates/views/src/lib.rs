//! Saved views of the Trama API: the port of `server/src/views`.
//!
//! * [`router`]: `/api/w/{slug}/views` (list, read, create, edit, invite, rotate the public
//!   link, delete) and the unauthenticated `GET /api/public/views/{token}`;
//! * [`service`]: the same operations for other crates. [`list`] (`ViewsService.list`) is what
//!   the workspace snapshot embeds; it takes the request's `WorkspaceContext`, so the caller's
//!   own, shared and invited views are the ones returned;
//! * [`access`]: who may read, edit and share a view;
//! * [`query`]: the server-side evaluation of a view (filters, sort, group) used by the public
//!   link, which only ever reads the whitelisted fields of its entity;
//! * [`public`]: the public link's fixed projection of a view;
//! * [`rules`]: the entities and layouts a view may have, and the public token.

pub mod access;
pub mod public;
pub mod query;
pub mod router;
pub mod rules;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::list;
