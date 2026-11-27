//! Written status updates of a project: the port of `project-updates.controller.ts` and
//! `project-updates.service.ts`.
//!
//! | Route | Gate |
//! | --- | --- |
//! | `GET /api/w/{slug}/projects/{id}/updates` | any member who can see the project; newest first, at most 200 |
//! | `POST /api/w/{slug}/projects/{id}/updates` | 201, `manageProjects`; a reported health also sets the project's |
//! | `PATCH /api/w/{slug}/projects/{id}/updates/{updateId}` | `manageProjects` and the author |
//! | `DELETE /api/w/{slug}/projects/{id}/updates/{updateId}` | 204, the author or `manageProjects` |
//!
//! A project the caller cannot see is a 404 on every route. Posting records the domain event
//! `project.update_posted` (`{ updateId, excerpt, health }`) with the live event
//! `created project_update`; editing and deleting only publish live events.

pub mod router;
pub mod schemas;
pub mod service;
