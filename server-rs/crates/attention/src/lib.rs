//! Attention items of the Trama API: the port of `server/src/attention`.
//!
//! "Where is my attention required?" is derived on the fly: every artifact of a visible issue
//! whose review is `requested` (medium) or whose CI is `failing` (high) is an item for every
//! member. A person can dismiss or snooze an item for themselves; that choice (the
//! `attention_state` table) only counts while the artifact has not changed since (`since` is
//! the artifact's `updatedAt`), and a snooze ends at its date.
//!
//! # Routes
//!
//! All of them need a user (an agent token gets 403), as `@RequireUser()` on the controller.
//!
//! | Route | Answers |
//! | --- | --- |
//! | `GET /api/w/{slug}/attention` | 200, the items |
//! | `DELETE /api/w/{slug}/attention/{id}` | 200, empty: dismiss |
//! | `POST /api/w/{slug}/attention/{id}/dismiss` | 201, empty: dismiss |
//! | `POST /api/w/{slug}/attention/{id}/snooze` | 201, empty; body `{ until }` |
//! | `POST /api/w/{slug}/attention/{id}/restore` | 201, the item, open again |
//!
//! Project scoping is the request's member access: a caller who cannot view issues gets no
//! items, issues of hidden projects (and their artifacts) are left out.
//!
//! # Public API for other crates
//!
//! | NestJS | Rust | Used by |
//! | --- | --- | --- |
//! | `AttentionService.list(ws, userId, snapshotRows?)` | [`service::list`] with [`service::SnapshotRows`] | the workspace snapshot |

pub mod iso;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{SnapshotRows, list};
