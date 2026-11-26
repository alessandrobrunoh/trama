//! Cancellation, the Rust form of the `AbortSignal` the NestJS code threads through every call.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

/// Cancelled by [`Signal::cancel`], or when its parent is. Cheap to clone; all clones share state.
#[derive(Clone, Debug)]
pub struct Signal {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    tx: watch::Sender<bool>,
    parent: Option<Signal>,
}

impl Default for Signal {
    fn default() -> Self {
        Self::new()
    }
}

impl Signal {
    /// A signal nobody has cancelled yet.
    #[must_use]
    pub fn new() -> Self {
        Self { inner: Arc::new(Inner { tx: watch::channel(false).0, parent: None }) }
    }

    /// A signal that is cancelled when this one is (or on its own).
    #[must_use]
    pub fn child(&self) -> Self {
        Self { inner: Arc::new(Inner { tx: watch::channel(false).0, parent: Some(self.clone()) }) }
    }

    /// `AbortSignal.any([self, AbortSignal.timeout(after)])`: the child, and the timer that
    /// cancels it. Dropping the [`Deadline`] stops the timer.
    #[must_use]
    pub fn with_deadline(&self, after: Duration) -> Deadline {
        let signal = self.child();
        let timer = signal.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            timer.cancel();
        });
        Deadline { signal, task }
    }

    /// Cancels this signal (and so every child).
    pub fn cancel(&self) {
        self.inner.tx.send_replace(true);
    }

    /// Whether this signal or an ancestor was cancelled.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.inner.tx.borrow() || self.inner.parent.as_ref().is_some_and(Signal::is_cancelled)
    }

    /// Resolves once this signal or an ancestor is cancelled.
    #[must_use]
    pub fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let mut rx = self.inner.tx.subscribe();
            let own = async {
                let _ = rx.wait_for(|cancelled| *cancelled).await;
            };
            match &self.inner.parent {
                Some(parent) => {
                    tokio::select! {
                        () = own => {}
                        () = parent.cancelled() => {}
                    }
                }
                None => own.await,
            }
        })
    }

    /// Cancels this signal when the returned guard is dropped (the client went away).
    #[must_use]
    pub fn cancel_on_drop(&self) -> CancelOnDrop {
        CancelOnDrop(self.clone())
    }
}

/// A child [`Signal`] with a timer; the timer stops when this is dropped.
#[derive(Debug)]
pub struct Deadline {
    /// The signal that is cancelled on timeout or with its parent.
    pub signal: Signal,
    task: JoinHandle<()>,
}

impl Drop for Deadline {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Cancels its [`Signal`] on drop.
#[derive(Debug)]
pub struct CancelOnDrop(Signal);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn children_follow_their_parent() {
        let parent = Signal::new();
        let child = parent.child();
        assert!(!child.is_cancelled());
        parent.cancel();
        assert!(child.is_cancelled());
        child.cancelled().await;
    }

    #[tokio::test]
    async fn a_deadline_cancels_after_the_time() {
        let parent = Signal::new();
        let deadline = parent.with_deadline(Duration::from_millis(20));
        deadline.signal.cancelled().await;
        assert!(deadline.signal.is_cancelled());
        assert!(!parent.is_cancelled());
    }

    #[tokio::test]
    async fn dropping_the_guard_cancels() {
        let signal = Signal::new();
        drop(signal.cancel_on_drop());
        assert!(signal.is_cancelled());
    }
}
