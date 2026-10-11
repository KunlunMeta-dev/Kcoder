//! Bounded target-side execution, separate from model and catalog policy.
//! Database leases authorize a job; this queue only owns its running future.
use anyhow::Result;
use futures::FutureExt;
use std::{collections::HashMap, future::Future, panic::AssertUnwindSafe};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

type JobKey = (String, String);

pub(super) struct WikiJobScheduler {
    capacity: usize,
    active: HashMap<JobKey, CancellationToken>,
    tasks: JoinSet<(JobKey, Result<()>)>,
}

impl WikiJobScheduler {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            active: HashMap::new(),
            tasks: JoinSet::new(),
        }
    }
    pub(super) fn has_capacity(&self) -> bool {
        self.active.len() < self.capacity
    }
    pub(super) fn contains(&self, library: &str, job_id: &str) -> bool {
        self.active.contains_key(&(library.into(), job_id.into()))
    }
    pub(super) fn spawn<F, Fut>(
        &mut self,
        library: String,
        job_id: String,
        owner: &CancellationToken,
        start: F,
    ) -> bool
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let key = (library, job_id);
        if !self.has_capacity() || self.active.contains_key(&key) {
            return false;
        }
        let cancel = owner.child_token();
        self.active.insert(key.clone(), cancel.clone());
        self.tasks.spawn(async move {
            let outcome = AssertUnwindSafe(async move { start(cancel).await })
                .catch_unwind()
                .await;
            let result = match outcome {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("Wiki worker job panicked")),
            };
            (key, result)
        });
        true
    }
    pub(super) fn reap(&mut self) {
        while let Some(completed) = self.tasks.try_join_next() {
            if let Ok((key, result)) = completed {
                self.active.remove(&key);
                if result.is_err() {
                    tracing::warn!(
                        "Wiki worker job stopped; persisted status remains authoritative"
                    );
                }
            }
        }
    }
    pub(super) fn cancel_all(&self) {
        for token in self.active.values() {
            token.cancel();
        }
    }
    pub(super) async fn shutdown(&mut self) {
        self.cancel_all();
        let joined = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(completed) = self.tasks.join_next().await {
                if let Ok((key, _)) = completed {
                    self.active.remove(&key);
                }
            }
        })
        .await;
        if joined.is_err() {
            self.tasks.abort_all();
            while self.tasks.join_next().await.is_some() {}
        }
        self.active.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[tokio::test]
    async fn two_source_jobs_reach_execution_concurrently_and_third_remains_bounded() {
        let mut queue = WikiJobScheduler::new(2);
        let owner = CancellationToken::new();
        let started = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(tokio::sync::Notify::new());
        for id in ["one", "two"] {
            let started = started.clone();
            let ready = ready.clone();
            assert!(queue.spawn(
                "same-library".into(),
                id.into(),
                &owner,
                move |cancel| async move {
                    started.fetch_add(1, Ordering::SeqCst);
                    ready.notify_one();
                    cancel.cancelled().await;
                    Ok(())
                }
            ));
        }
        assert!(!queue.has_capacity());
        assert!(
            !queue.spawn("same-library".into(), "third".into(), &owner, |_| async {
                Ok(())
            })
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) != 2 {
                ready.notified().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 2);
        queue.shutdown().await;
        assert!(queue.has_capacity());
    }
    #[tokio::test]
    async fn cancellation_is_owned_by_one_job_and_does_not_cancel_a_sibling() {
        let mut queue = WikiJobScheduler::new(2);
        let owner = CancellationToken::new();
        let (sent, received) = tokio::sync::oneshot::channel();
        assert!(queue.spawn(
            "library".into(),
            "one".into(),
            &owner,
            move |cancel| async move {
                let _ = sent.send(cancel.clone());
                cancel.cancelled().await;
                Ok(())
            }
        ));
        let (sibling_sent, sibling_received) = tokio::sync::oneshot::channel();
        assert!(queue.spawn(
            "library".into(),
            "two".into(),
            &owner,
            move |cancel| async move {
                let _ = sibling_sent.send(cancel.clone());
                cancel.cancelled().await;
                Ok(())
            }
        ));
        let first = received.await.unwrap();
        let sibling = sibling_received.await.unwrap();
        first.cancel();
        tokio::task::yield_now().await;
        assert!(!sibling.is_cancelled());
        assert!(!owner.is_cancelled());
        queue.shutdown().await;
        assert!(sibling.is_cancelled());
    }
    #[tokio::test]
    async fn duplicate_identity_is_not_spawned_and_finished_identity_can_be_reclaimed() {
        let mut queue = WikiJobScheduler::new(2);
        let owner = CancellationToken::new();
        assert!(queue.spawn("library".into(), "one".into(), &owner, |_| async { Ok(()) }));
        assert!(
            !queue.spawn("library".into(), "one".into(), &owner, |_| async {
                panic!("duplicate job executed")
            })
        );
        tokio::task::yield_now().await;
        queue.reap();
        assert!(queue.spawn("library".into(), "one".into(), &owner, |_| async { Ok(()) }));
        queue.shutdown().await;
    }
}
