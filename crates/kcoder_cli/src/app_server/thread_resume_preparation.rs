//! Bounded preparation of cold resumes. Only the owning dispatcher installs a runtime.

use super::*;
use std::{collections::HashSet, sync::Weak};
use tokio::sync::{Semaphore, SemaphorePermit};

const PREPARATION_LIMIT: usize = 4;
const COLD_PEER_WAIT: Duration = Duration::from_secs(15);
static PREPARATIONS: Semaphore = Semaphore::const_new(PREPARATION_LIMIT);

pub(super) fn preparations_active() -> bool {
    PREPARATIONS.available_permits() < PREPARATION_LIMIT
}

#[derive(Debug)]
pub(super) enum Input {
    Client(String),
    Native,
}

pub(super) struct ReadyThreadResume {
    pub input: Input,
    pub id: Value,
    params: Value,
    thread_id: String,
    source: Weak<()>,
    prepared: Result<PreparedThreadResume>,
    // Keep admitted results, including their potentially large histories, bounded until consumed.
    _slot: Option<SemaphorePermit<'static>>,
    _reservation: Arc<()>,
}

impl std::fmt::Debug for ReadyThreadResume {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReadyThreadResume")
            .finish_non_exhaustive()
    }
}

impl ReadyThreadResume {
    pub fn verify(&self, id: &Value, params: &Value, state: &ConnectionState) -> Result<()> {
        ensure!(
            &self.id == id
                && &self.params == params
                && matches!(self.input, Input::Native) == state.native_source_dispatch
                && !state.input_ended.is_cancelled()
                && self
                    .source
                    .ptr_eq(&Arc::downgrade(&state.source_management_owner)),
            "THREAD_RESUME_PREPARATION_OWNER_CHANGED"
        );
        Ok(())
    }

    pub fn into_prepared(self) -> Result<PreparedThreadResume> {
        self.prepared
    }
}

#[derive(Debug, Default)]
pub(super) struct DeferredThreadResumes {
    jobs: tokio::task::JoinSet<ReadyThreadResume>,
    pending: HashSet<String>,
    #[cfg(test)]
    test_gate: Option<Arc<Mutex<()>>>,
}

impl DeferredThreadResumes {
    #[expect(
        clippy::too_many_arguments,
        reason = "Capture the original request and source token separately"
    )]
    pub fn start(
        &mut self,
        input: Input,
        id: &Value,
        params: &Value,
        thread_id: &str,
        workspace_engine: &QueryEngine,
        source: &Arc<()>,
        ended: &CancellationToken,
        reservation: Arc<()>,
        cold_preparation: Option<CancellationToken>,
    ) -> bool {
        if self.pending.contains(thread_id) || ended.is_cancelled() {
            return false;
        }
        let Ok(slot) = PREPARATIONS.try_acquire() else {
            return false;
        };
        self.pending.insert(thread_id.to_owned());
        let id = id.clone();
        let params = params.clone();
        let thread_id = thread_id.to_owned();
        let source = Arc::downgrade(source);
        let ended = ended.clone();
        let workspace_engine = workspace_engine.clone();
        #[cfg(test)]
        let test_gate = self.test_gate.clone();
        self.jobs.spawn(async move {
            let target = thread_id.clone();
            #[cfg(test)]
            let _test_gate = match test_gate {
                Some(gate) => Some(gate.lock_owned().await),
                None => None,
            };
            let waited = match cold_preparation {
                Some(finished) => tokio::select! {
                    biased;
                    _ = ended.cancelled() => Err(anyhow::anyhow!("THREAD_RESUME_SOURCE_ENDED")),
                    result = tokio::time::timeout(COLD_PEER_WAIT, finished.cancelled()) =>
                        result.context("THREAD_RESUME_COLD_PEER_WAIT_EXPIRED"),
                },
                None => Ok(()),
            };
            let (prepared, slot, reservation) = match waited {
                Err(error) => (Err(error), Some(slot), reservation),
                Ok(()) => {
                    // Both reservations outlive a cancelled observer until
                    // this blocking preparation drops or transfers its lease.
                    let held = Arc::clone(&reservation);
                    match task_spawn::spawn_blocking(move || {
                        let result = if ended.is_cancelled() {
                            Err(anyhow::anyhow!("THREAD_RESUME_SOURCE_ENDED"))
                        } else {
                            thread_restore_requests::prepare_cold_resume(&workspace_engine, &target)
                        };
                        (result, slot, held)
                    })
                    .await
                    {
                        Ok((prepared, slot, held)) => (prepared, Some(slot), held),
                        Err(error) => (
                            Err(anyhow::Error::new(error)
                                .context("THREAD_RESUME_PREPARATION_FAILED")),
                            None,
                            reservation,
                        ),
                    }
                }
            };
            ReadyThreadResume {
                input,
                id,
                params,
                thread_id,
                source,
                prepared,
                _slot: slot,
                _reservation: reservation,
            }
        });
        true
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub async fn next(&mut self) -> Option<ReadyThreadResume> {
        let reply = self.jobs.join_next().await?.ok()?;
        self.pending.remove(&reply.thread_id);
        Some(reply)
    }

    pub async fn shutdown(&mut self) {
        self.jobs.shutdown().await;
        self.pending.clear();
    }

    #[cfg(test)]
    pub fn set_test_gate(&mut self, gate: Arc<Mutex<()>>) {
        self.test_gate = Some(gate);
    }
}
