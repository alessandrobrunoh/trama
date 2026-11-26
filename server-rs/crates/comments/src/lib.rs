//! Comments of the Trama API: the port of `server/src/comments`.
//!
//! A comment is a Markdown body by one actor on an issue, artifact, project, milestone or
//! import. People limited to some projects only see and write comments on work in those
//! projects (`assertSubjectVisible`).
//!
//! # Routes
//!
//! | Route | Gate |
//! | --- | --- |
//! | `GET /api/w/{slug}/comments` | any member; a limited person must name a visible subject |
//! | `GET /api/w/{slug}/comments/page` | any member |
//! | `GET /api/w/{slug}/comments/{id}` | any member |
//! | `POST /api/w/{slug}/comments` | member; 201 |
//! | `PATCH /api/w/{slug}/comments/{id}` | member, and only the author |
//! | `DELETE /api/w/{slug}/comments/{id}` | `member` role (so not a viewer); the author or admin power; 204 |
//!
//! # Side effects
//!
//! * `POST` records the domain event `comment.created` (`{ commentId, excerpt }`, the first 200
//!   UTF-16 units of the body) with the live event `created comment <id>`, and keeps the files
//!   the body mentions ([`trama_uploads::service::retained`]).
//! * `PATCH` and `DELETE` publish a live `updated` / `deleted` event scoped by the comment's
//!   subject, and move the upload references.
//! * Notifications for new comments are not made here: NestJS's notifications module listens to
//!   the recorded `comment.created` events.
//!
//! # Public API for other crates
//!
//! | NestJS | Rust | Used by |
//! | --- | --- | --- |
//! | `listAll(ws)` | [`service::list_all`]`(&db, ws)` | the snapshot (`?comments=full`) |
//! | `index(ws)` | [`service::index`]`(&db, ws)` | the snapshot (`commentIndex`, the default) |
//! | `list(ws, filter)` | [`service::list`] | |
//! | `page(ws, query)` | [`service::page`] | |
//! | `get(ws, id)` | [`service::get`] | |
//!
//! All of them return the contract types of `trama_contracts::activity` ([`Comment`],
//! [`CommentPage`], [`CommentIndexEntry`]) and take the connection (`&state.db` or a
//! transaction). `list_all` and `index` do not scope by project: the snapshot does it afterwards.
//!
//! ```
//! use trama_comments::cursor::{CommentCursor, decode_comment_cursor, encode_comment_cursor};
//!
//! let at = chrono::DateTime::from_timestamp_millis(1_772_409_600_089).unwrap();
//! let cursor = CommentCursor { at, id: "cm_abc".into() };
//! assert_eq!(decode_comment_cursor(&encode_comment_cursor(&cursor)).unwrap(), cursor);
//! ```

pub mod cursor;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use trama_contracts::activity::{Comment, CommentIndexEntry, CommentPage};
