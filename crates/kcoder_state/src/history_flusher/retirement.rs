//! Observe the original writer's termination without retaining its sender or a State.
use super::*;
use std::time::Duration;

pub(super) struct WriterLifetimeGuard {
    _owned: Box<dyn Send>,
}
impl std::fmt::Debug for WriterLifetimeGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WriterLifetimeGuard")
    }
}

/// No Deserialize or public constructor: only an actual State supplies this observer.
#[derive(Clone, Debug)]
pub struct HistoryWriterRetirement {
    queue: Option<Arc<HistoryFlusherQueue>>,
    sender: Option<mpsc::WeakUnboundedSender<QueuedHistoryCommand>>,
}

impl AppState {
    pub fn capture_history_writer_retirement(&self) -> anyhow::Result<HistoryWriterRetirement> {
        let inner = self
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("original history writer is busy"))?;
        Ok(HistoryWriterRetirement {
            queue: inner
                .history_flusher
                .as_ref()
                .map(|flusher| Arc::clone(&flusher.queue)),
            sender: inner
                .history_flusher
                .as_ref()
                .map(|flusher| flusher.tx.downgrade()),
        })
    }
}

impl HistoryWriterRetirement {
    pub fn is_quiescent(&self) -> bool {
        self.queue.as_ref().is_none_or(|queue| {
            queue.worker_is_stopped() && queue.active_jobs.load(Ordering::Acquire) == 0
        })
    }

    /// A stopped supervisor alone is insufficient: its blocking job may still run.
    pub async fn wait_for_quiescence(&self) -> bool {
        while !self.is_quiescent() {
            futures_timer::Delay::new(Duration::from_millis(5)).await;
        }
        self.queue
            .as_ref()
            .is_none_or(|queue| !queue.worker_is_unknown())
    }

    /// Stop admission to this original writer and drain only its already
    /// accepted commands. No sender, replacement State or timeout is authority.
    pub fn request_retirement(&self) {
        let Some(queue) = &self.queue else {
            return;
        };
        queue.retiring.store(true, Ordering::Release);
        if let Some(sender) = self
            .sender
            .as_ref()
            .and_then(mpsc::WeakUnboundedSender::upgrade)
        {
            let _ = sender.send(QueuedHistoryCommand {
                command: HistoryFlusherCommand::Retire,
                epoch: queue.current_epoch(),
            });
        }
    }

    /// Cancellation keeps an owned resource with the actual queue and its
    /// blocking jobs. The resource carries no reference back to this observer.
    pub fn retain_until_writer_released(self, guard: impl Send + 'static) {
        if self.is_quiescent() {
            return;
        }
        if let Some(queue) = &self.queue {
            queue
                .retirement_guards
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(WriterLifetimeGuard {
                    _owned: Box::new(guard),
                });
            queue.release_retirement_guards_if_quiescent();
        }
    }
}

impl HistoryFlusherQueue {
    pub(super) fn release_retirement_guards_if_quiescent(&self) {
        if !self.worker_is_stopped() || self.active_jobs.load(Ordering::Acquire) != 0 {
            return;
        }
        let guards = {
            let mut retained = self
                .retirement_guards
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *retained)
        };
        drop(guards);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn original_writer_retirement_waits_for_real_queued_job_after_session_replacement() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
        let queue = state
            .inner
            .read()
            .unwrap()
            .history_flusher
            .as_ref()
            .unwrap()
            .queue
            .clone();
        let retirement = state.capture_history_writer_retirement().unwrap();
        struct OwnedProbe(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for OwnedProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let lease_path = root.path().join("original-writer.lease");
        let native_lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lease_path)
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&native_lease).unwrap();
        let competing = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
            .unwrap();
        retirement
            .clone()
            .retain_until_writer_released((OwnedProbe(released.clone()), native_lease));
        let held_observer = retirement.clone();
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let job = tokio::spawn(worker_pool::run(queue, move || {
            let _ = entered.send(());
            release_rx.recv().unwrap();
        }));
        entered_rx.await.unwrap();
        state.add_message(kcoder_types::Message::assistant_text(
            "Original pending completion",
        ));
        let original = state.history_path().unwrap();
        state.start_new_session().unwrap();
        let waiter = tokio::spawn(async move { retirement.wait_for_quiescence().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiter.is_finished(),
            "a new State never certifies the original blocking job ended"
        );
        assert!(!released.load(Ordering::Acquire));
        assert!(
            fs2::FileExt::try_lock_exclusive(&competing).is_err(),
            "the actual original kernel lease outlives the blocked writer"
        );
        release.send(()).unwrap();
        job.await.unwrap().unwrap();
        assert!(waiter.await.unwrap());
        tokio::time::timeout(Duration::from_secs(1), async {
            while fs2::FileExt::try_lock_exclusive(&competing).is_err() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("observer Arcs never retain a quiescent writer lease");
        assert!(released.load(Ordering::Acquire));
        assert!(held_observer.is_quiescent());
        assert!(
            std::fs::read_to_string(original)
                .unwrap()
                .contains("Original pending completion")
        );
    }
}
