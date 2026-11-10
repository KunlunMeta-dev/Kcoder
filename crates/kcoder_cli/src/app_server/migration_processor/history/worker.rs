//! A connection owns bounded workers; persistent receipts outlive all transient progress.
use super::*;
use kcoder_migration::history_jobs::{
    HISTORY_PROJECTION_RECOVERY_REQUIRED, HistoryExecutionState, HistoryImportEvent,
};
use kcoder_types::external_history::{ExternalHistoryPhase, HistoryImportStage};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Default, Clone)]
struct State {
    running: bool,
    progress: Option<MigrationHistoryProgress>,
    error: Option<String>,
}
#[derive(Default)]
struct Workers {
    tasks: JoinSet<()>,
    states: BTreeMap<String, Arc<Mutex<State>>>,
}
#[derive(Default)]
pub(in super::super) struct HistoryWorkers {
    cancellation: CancellationToken,
    workers: Mutex<Workers>,
}

struct WorkerState(Arc<Mutex<State>>);
impl Drop for WorkerState {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.running {
            state.running = false;
            state.error = Some("history_job_worker_aborted".into());
        }
    }
}
impl HistoryWorkers {
    pub(in super::super) fn activity(&self) -> usize {
        self.workers
            .lock()
            .map(|workers| {
                workers
                    .states
                    .values()
                    .filter(|state| {
                        state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .running
                    })
                    .count()
            })
            .unwrap_or(1)
    }
    pub(in super::super) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub(in super::super) fn cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub(in super::super) fn observe(
        &self,
        store: &HistoryJobStore,
        id: &str,
    ) -> Result<MigrationHistoryJobResult> {
        // Runtime ownership must be sampled before reading its durable checkpoint.
        let snapshot = {
            let workers = self
                .workers
                .lock()
                .map_err(|_| anyhow::anyhow!("history_job_worker_unavailable"))?;
            workers.states.get(id).map(|state| {
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone()
            })
        };
        let (job, execution) = store.observe_execution(id)?;
        let needs_recovery =
            job.failure_code.as_deref() == Some(HISTORY_PROJECTION_RECOVERY_REQUIRED);
        Ok(MigrationHistoryJobResult {
            worker_running: execution == HistoryExecutionState::Running,
            worker_state: Some(match execution {
                HistoryExecutionState::Running => MigrationHistoryWorkerState::Running,
                HistoryExecutionState::Stopped => MigrationHistoryWorkerState::Stopped,
                HistoryExecutionState::Unknown => MigrationHistoryWorkerState::Unknown,
            }),
            progress: snapshot
                .as_ref()
                .filter(|state| state.running && execution == HistoryExecutionState::Running)
                .and_then(|state| state.progress.clone()),
            worker_error: if execution == HistoryExecutionState::Unknown {
                Some(store.execution_unknown_code(id)?.into())
            } else if execution == HistoryExecutionState::Running
                || (job.stage == HistoryImportStage::Normalized && !needs_recovery)
            {
                None
            } else {
                snapshot.and_then(|state| state.error)
            },
            job,
        })
    }

    pub(in super::super) fn start(
        &self,
        store: HistoryJobStore,
        id: &str,
        sequence: u64,
    ) -> Result<MigrationHistoryJobResult> {
        ensure!(!self.cancelled(), "history_job_worker_stopping");
        let store = Arc::new(store);
        let (job, execution_state) = store.observe_execution(id)?;
        ensure!(
            execution_state != HistoryExecutionState::Unknown,
            "{}",
            store.execution_unknown_code(id)?
        );
        if execution_state == HistoryExecutionState::Running
            || (job.stage == HistoryImportStage::Normalized
                && job.failure_code.as_deref() != Some(HISTORY_PROJECTION_RECOVERY_REQUIRED)
                && job.sequence != sequence)
        {
            return self.observe(&store, id);
        }
        let execution = match store.claim_execution(id, sequence) {
            Ok(execution) => execution,
            Err(error) if error.to_string() == "history_job_execution_busy" => {
                return self.observe(&store, id);
            }
            Err(error) => return Err(error),
        };
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| anyhow::anyhow!("history_job_worker_unavailable"))?;
        while let Some(result) = workers.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("History archive worker exited unexpectedly");
            }
        }
        if workers.states.get(id).is_some_and(|state| {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .running
        }) {
            drop(workers);
            drop(execution);
            return self.observe(&store, id);
        }
        if job.stage == HistoryImportStage::Normalized
            && job.failure_code.as_deref() != Some(HISTORY_PROJECTION_RECOVERY_REQUIRED)
        {
            drop(workers);
            drop(execution);
            return self.observe(&store, id);
        }
        ensure!(job.sequence == sequence, "history_job_revision_conflict");
        ensure!(
            !matches!(
                job.stage,
                HistoryImportStage::Cancelled | HistoryImportStage::Failed
            ),
            "history_job_resume_required"
        );
        ensure!(
            workers
                .states
                .values()
                .filter(|state| state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .running)
                .count()
                < kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY,
            "history_job_worker_capacity_reached"
        );
        if workers.states.len() >= 32 {
            workers.states.retain(|_, state| {
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .running
            });
        }
        let state = Arc::new(Mutex::new(State {
            running: true,
            ..State::default()
        }));
        workers.states.insert(id.into(), state.clone());
        let cancellation = self.cancellation.clone();
        let initial = job.clone();
        let worker_store = store.clone();
        workers.tasks.spawn_blocking(move || {
            let state = WorkerState(state);
            let mut current = initial;
            let result: Result<()> = (|| {
                while (current.stage == HistoryImportStage::Normalized
                    && current.failure_code.as_deref()
                        == Some(HISTORY_PROJECTION_RECOVERY_REQUIRED))
                    || !matches!(
                        current.stage,
                        HistoryImportStage::Normalized
                            | HistoryImportStage::Cancelled
                            | HistoryImportStage::Failed
                    )
                {
                    current =
                        worker_store.step_owned(&execution, current.sequence, 10, |event| {
                            if cancellation.is_cancelled() {
                                return false;
                            }
                            state
                                .0
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .progress = Some(progress(event));
                            true
                        })?;
                }
                Ok(())
            })();
            let mut snapshot = state.0.lock().unwrap_or_else(|error| error.into_inner());
            snapshot.running = false;
            snapshot.error = result.err().map(|error| super::super::safe_error(&error));
        });
        drop(workers);
        self.observe(&store, id)
    }

    pub(in super::super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut workers = self
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut workers.tasks)
        };
        if tokio::time::timeout(Duration::from_secs(10), async {
            while tasks.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            tracing::warn!("History archive workers did not settle within the shutdown deadline");
            tasks.abort_all();
        }
    }
}

pub(in super::super) fn progress(event: HistoryImportEvent) -> MigrationHistoryProgress {
    let (phase, processed, total, unit) = match event {
        HistoryImportEvent::Capture {
            processed_bytes,
            total_bytes,
        } => (
            MigrationHistoryPhase::Capturing,
            processed_bytes,
            total_bytes,
            MigrationHistoryProgressUnit::Bytes,
        ),
        HistoryImportEvent::Archive(value) => (
            match value.phase {
                ExternalHistoryPhase::CopyingOriginal => MigrationHistoryPhase::CopyingOriginal,
                ExternalHistoryPhase::ReadingOriginal => MigrationHistoryPhase::ReadingOriginal,
                ExternalHistoryPhase::Decoding => MigrationHistoryPhase::Decoding,
                ExternalHistoryPhase::Copying => MigrationHistoryPhase::Copying,
                ExternalHistoryPhase::Indexing => MigrationHistoryPhase::Indexing,
                ExternalHistoryPhase::Verifying => MigrationHistoryPhase::Verifying,
            },
            value.processed_bytes,
            value.total_bytes,
            MigrationHistoryProgressUnit::Bytes,
        ),
        HistoryImportEvent::Normalize(value) => (
            MigrationHistoryPhase::Normalizing,
            value.committed.normalized_records,
            value.committed.source_records,
            MigrationHistoryProgressUnit::Records,
        ),
    };
    MigrationHistoryProgress {
        phase,
        processed,
        total,
        unit,
    }
}
