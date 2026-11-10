//! A flush barrier observes one native session and one writer epoch.
use super::*;
use crate::history_store::TryHistoryGeneration;
use std::time::Duration;

enum Writer {
    Queued {
        queue: Arc<HistoryFlusherQueue>,
        epoch: u64,
        done: oneshot::Receiver<anyhow::Result<()>>,
    },
    Direct {
        source: HistorySource,
        generation: Option<uuid::Uuid>,
    },
    Ephemeral,
}

struct Capture {
    lifecycle: AppStateLifecycleIdentity,
    path: Option<PathBuf>,
    source: Option<HistorySource>,
    writer: Writer,
}

/// The first state lock is non-waiting: without an existing lifecycle witness,
/// waiting through a session replacement could otherwise capture a new owner.
/// Once a barrier has been accepted, lock contention only delays observation
/// of that same barrier and never causes its reissue.
pub(crate) async fn flush_history(state: &AppState) -> anyhow::Result<()> {
    let capture = {
        let inner = match state.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => {
                anyhow::bail!("history flush state is busy; its original session is unknown")
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("history flush state is unavailable")
            }
        };
        if let Some(fault) = &inner.history_write_fault {
            anyhow::bail!(
                "history persistence is faulted; save an explicit snapshot to recover: {fault}"
            );
        }
        let source = if inner.history_path.is_some() {
            Some(require_history_source(&inner)?.clone())
        } else {
            None
        };
        let lifecycle = crate::history_append_context::lifecycle_identity_locked(state, &inner);
        let writer = if let Some(flusher) = &inner.history_flusher {
            let (done, reply) = oneshot::channel();
            let epoch = flusher
                .send_queued(HistoryFlusherCommand::Flush(done))
                .map_err(|_| anyhow::anyhow!("history writer stopped before accepting flush"))?;
            Writer::Queued {
                queue: Arc::clone(&flusher.queue),
                epoch,
                done: reply,
            }
        } else if let Some(source) = source.as_ref() {
            let generation = match source.try_bound_generation()? {
                TryHistoryGeneration::Available(generation) => generation,
                TryHistoryGeneration::Busy => {
                    anyhow::bail!("history source is busy; its original generation is unknown")
                }
            };
            Writer::Direct {
                source: source.clone(),
                generation,
            }
        } else {
            Writer::Ephemeral
        };
        Capture {
            lifecycle,
            path: inner.history_path.clone(),
            source,
            writer,
        }
    };

    match &capture.writer {
        Writer::Queued { .. } => {}
        Writer::Direct { source, .. } => {
            let queue = Arc::new(HistoryFlusherQueue::new(source.clone()));
            let source = source.clone();
            let (done, mut reply) = oneshot::channel();
            worker_pool::run(queue, move || {
                let _ = done.send(source.check());
            })
            .await?;
            let result = reply.try_recv().context("history source check stopped")?;
            result.map_err(|error| {
                let message = format!("failed to validate bound history source: {error:#}");
                error.context(message)
            })?;
        }
        Writer::Ephemeral => {}
    }

    let Capture {
        lifecycle,
        path,
        source,
        writer,
    } = capture;
    let (queue, epoch, direct_generation) = match writer {
        Writer::Queued { queue, epoch, done } => {
            done.await
                .context("history flusher stopped before flush completed")??;
            (Some(queue), Some(epoch), None)
        }
        Writer::Direct { generation, .. } => (None, None, Some(generation)),
        Writer::Ephemeral => (None, None, None),
    };

    let mut delay = Duration::from_millis(5);
    loop {
        let observed = match state.inner.try_read() {
            Ok(inner) => {
                anyhow::ensure!(
                    lifecycle.matches_locked(state, &inner),
                    "history flush lifecycle changed"
                );
                anyhow::ensure!(inner.history_path == path, "history flush source changed");
                match (&source, &inner.history_source) {
                    (None, None) => {}
                    (Some(original), Some(current)) => anyhow::ensure!(
                        original.shares_binding(current),
                        "history flush source binding changed"
                    ),
                    _ => anyhow::bail!("history flush source binding changed"),
                }
                match (&queue, &inner.history_flusher) {
                    (Some(original), Some(current)) => {
                        anyhow::ensure!(
                            Arc::ptr_eq(original, &current.queue),
                            "history flush writer changed"
                        );
                        anyhow::ensure!(
                            Some(original.current_epoch()) == epoch,
                            "history flush epoch changed"
                        );
                        anyhow::ensure!(
                            !original.worker_is_unknown() && !original.worker_is_stopped(),
                            "history flush writer stopped"
                        );
                        true
                    }
                    (None, None) => {
                        if let (Some(current), Some(expected)) =
                            (&inner.history_source, direct_generation)
                        {
                            match current.try_bound_generation()? {
                                TryHistoryGeneration::Busy => false,
                                TryHistoryGeneration::Available(generation) => {
                                    anyhow::ensure!(
                                        generation == expected,
                                        "history flush generation changed"
                                    );
                                    true
                                }
                            }
                        } else {
                            true
                        }
                    }
                    _ => anyhow::bail!("history flush writer changed"),
                }
            }
            Err(std::sync::TryLockError::WouldBlock) => false,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("history flush state is unavailable")
            }
        };
        if observed {
            return Ok(());
        }
        futures_timer::Delay::new(delay).await;
        delay = delay.saturating_mul(2).min(Duration::from_millis(250));
    }
}
