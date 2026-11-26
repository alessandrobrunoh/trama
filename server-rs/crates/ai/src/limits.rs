//! Who may run an AI request now, and the daily budget of assistant changes
//! (`AiService.run` and `AiService.spendWrite`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use chrono::Utc;
use trama_core::AppError;

/// AI requests running at once, across everyone.
const MAX_ACTIVE: usize = 20;
/// Requests per person per window.
const MAX_PER_WINDOW: u32 = 10;
const WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
struct State {
    active: HashSet<String>,
    usage: HashMap<String, (u32, Instant)>,
    writes_today: HashMap<String, (u32, String)>,
}

/// Process-wide request limits; clones share the same counters.
#[derive(Clone, Default)]
pub struct Limits(Arc<Mutex<State>>);

/// Holds a person's one running AI request; releases it when dropped.
#[must_use = "the request is released when the permit is dropped"]
pub struct RunPermit {
    limits: Limits,
    user_id: String,
}

impl std::fmt::Debug for RunPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunPermit").field("user_id", &self.user_id).finish_non_exhaustive()
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        self.limits.state().active.remove(&self.user_id);
    }
}

fn too_many(message: &str) -> AppError {
    AppError::new(StatusCode::TOO_MANY_REQUESTS, message)
}

impl Limits {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts a request for `user_id`: one at a time per person, 20 overall, 10 per minute.
    ///
    /// # Errors
    ///
    /// 429 when a limit is reached.
    pub fn acquire(&self, user_id: &str) -> Result<RunPermit, AppError> {
        let mut state = self.state();
        if state.active.contains(user_id) || state.active.len() >= MAX_ACTIVE {
            return Err(too_many("An AI request is already running. Please try again shortly."));
        }
        let now = Instant::now();
        state.usage.retain(|_, (_, expires)| *expires > now);
        let usage = state.usage.entry(user_id.to_owned()).or_insert((0, now + WINDOW));
        if usage.0 >= MAX_PER_WINDOW {
            return Err(too_many(
                "AI is limited to 10 requests per minute. Please wait before trying again.",
            ));
        }
        usage.0 += 1;
        state.active.insert(user_id.to_owned());
        drop(state);
        Ok(RunPermit { limits: self.clone(), user_id: user_id.to_owned() })
    }

    /// `AiService.run`: `work` runs under a permit.
    ///
    /// # Errors
    ///
    /// 429 when a limit is reached; otherwise the result of `work`.
    pub async fn run<T>(
        &self,
        user_id: &str,
        work: impl Future<Output = T>,
    ) -> Result<T, AppError> {
        let _permit = self.acquire(user_id)?;
        Ok(work.await)
    }

    /// Spends one change from the person's daily budget; false when it is used up.
    #[must_use]
    pub fn spend_write(&self, user_id: &str, max_per_day: u32) -> bool {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        let mut state = self.state();
        let entry = state.writes_today.entry(user_id.to_owned()).or_insert((0, day.clone()));
        if entry.1 != day {
            *entry = (0, day);
        }
        if entry.0 >= max_per_day {
            return false;
        }
        entry.0 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_request_at_a_time_per_person() {
        let limits = Limits::default();
        let first = limits.acquire("u1").unwrap();
        let err = limits.acquire("u1").unwrap_err();
        assert_eq!(err.status_code(), StatusCode::TOO_MANY_REQUESTS);
        assert!(err.to_string().contains("An AI request is already running."));
        assert!(limits.acquire("u2").is_ok());
        drop(first);
        assert!(limits.acquire("u1").is_ok());
    }

    #[test]
    fn twenty_requests_at_once_across_everyone() {
        let limits = Limits::default();
        let permits: Vec<_> = (0..20).map(|n| limits.acquire(&format!("u{n}")).unwrap()).collect();
        assert!(limits.acquire("late").is_err());
        drop(permits);
        assert!(limits.acquire("late").is_ok());
    }

    #[test]
    fn ten_requests_per_minute_per_person() {
        let limits = Limits::default();
        for _ in 0..10 {
            drop(limits.acquire("u1").unwrap());
        }
        let err = limits.acquire("u1").unwrap_err();
        assert!(err.to_string().contains("AI is limited to 10 requests per minute."));
        assert!(limits.acquire("u2").is_ok());
    }

    #[tokio::test]
    async fn run_releases_the_permit_when_the_work_ends() {
        let limits = Limits::default();
        assert_eq!(limits.run("u1", async { 7 }).await.unwrap(), 7);
        assert_eq!(limits.run("u1", async { 8 }).await.unwrap(), 8);
    }

    #[test]
    fn a_daily_write_budget_per_person() {
        let limits = Limits::default();
        let mut granted = 0;
        while limits.spend_write("usr_budget", 200) {
            granted += 1;
        }
        assert_eq!(granted, 200);
        assert!(limits.spend_write("usr_other", 200)); // budgets are per person
        assert!(!limits.spend_write("usr_budget", 200));
    }

    #[test]
    fn the_budget_follows_the_configured_maximum() {
        let limits = Limits::default();
        assert!(limits.spend_write("u", 1));
        assert!(!limits.spend_write("u", 1));
    }
}
