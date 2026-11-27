//! Favorites of the Trama API: the port of `server/src/favorites`.
//!
//! A person's own pins (issues, projects, views) in one workspace. Personal, so agent tokens get
//! 403; viewers may keep favorites too.
//!
//! * [`router`]: `GET` and `POST /api/w/{slug}/favorites`, `DELETE
//!   /api/w/{slug}/favorites/{type}/{subjectId}`;
//! * [`service`]: the same operations for other crates.

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
