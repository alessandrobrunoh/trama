//! A person's own workspace time entries and running timer, ported from
//! `server/src/time-entries`.
//!
//! Every operation is scoped by workspace and authenticated user. Services
//! also apply the caller's project access before exposing linked entries.

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
