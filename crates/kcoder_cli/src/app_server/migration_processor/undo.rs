//! A connection owns only its undo workers; reads and cancellation never replay source operations.
use super::*;
use kcoder_migration::history_undo::HistoryUndoJobs;
use kcoder_types::historical_undo::HistoricalUndoStage;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Worker {
    running: AtomicBool,
    error: Mutex<Option<String>>,
}
#[derive(Default)]
struct Tasks {
    tasks: JoinSet<()>,
    workers: BTreeMap<String, Arc<Worker>>,
}
pub(super) struct UndoWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<Tasks>,
}
struct Guard(Arc<Worker>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::Release);
    }
}
impl UndoWorkers {
    pub(super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            tasks: Mutex::new(Tasks::default()),
        }
    }
    pub(super) fn activity(&self) -> usize {
        self.tasks
            .lock()
            .map(|tasks| {
                tasks
                    .workers
                    .values()
                    .filter(|worker| worker.running.load(Ordering::Acquire))
                    .count()
            })
            .unwrap_or(1)
    }
    fn observe(
        &self,
        store: &HistoryUndoJobs,
        key: &str,
    ) -> Result<MigrationHistoryUndoStateResult> {
        let (local, error) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("historical_undo_worker_unavailable"))?;
            let worker = tasks.workers.get(key);
            (
                worker.is_some_and(|worker| worker.running.load(Ordering::Acquire)),
                worker.and_then(|worker| worker.error.lock().ok().and_then(|error| error.clone())),
            )
        };
        let job = store.read(key)?;
        let done = job.stage == HistoricalUndoStage::Undone;
        Ok(MigrationHistoryUndoStateResult {
            worker_running: !done && (local || store.running(key)?),
            worker_error: if done { None } else { error },
            job,
        })
    }
    fn start(
        &self,
        profile: PathBuf,
        workspace: PathBuf,
        store: HistoryUndoJobs,
        key: String,
        sequence: u64,
    ) -> Result<MigrationHistoryUndoStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "historical_undo_worker_stopping"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("historical_undo_worker_unavailable"))?;
        while tasks.tasks.try_join_next().is_some() {}
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.observe(&store, &key);
        }
        let job = store.read(&key)?;
        if job.stage == HistoricalUndoStage::Undone {
            drop(tasks);
            return self.observe(&store, &key);
        }
        ensure!(
            job.sequence == sequence,
            "historical_undo_revision_conflict"
        );
        ensure!(
            tasks
                .workers
                .values()
                .filter(|worker| worker.running.load(Ordering::Acquire))
                .count()
                < 2,
            "historical_undo_worker_capacity_reached"
        );
        let observer = HistoryUndoJobs::open_existing(&profile, &workspace)?
            .ok_or_else(|| anyhow::anyhow!("historical_undo_store_missing"))?;
        let worker = Arc::new(Worker::default());
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key.clone(), worker.clone());
        let token = self.cancellation.clone();
        let worker_key = key.clone();
        tasks.tasks.spawn_blocking(move || {
            let _guard = Guard(worker.clone());
            if let Err(error) =
                store.run_with_cancel(&worker_key, sequence, || !token.is_cancelled())
            {
                *worker
                    .error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(safe_error(&error));
            }
        });
        drop(tasks);
        self.observe(&observer, &key)
    }
    pub(super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut state = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut state.tasks)
        };
        while !tasks.is_empty() {
            let _ = tokio::time::timeout(Duration::from_millis(100), tasks.join_next()).await;
        }
    }
}
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_HISTORY_UNDO_LOOKUP
            | method::MIGRATION_HISTORY_UNDO_PREVIEW
            | method::MIGRATION_HISTORY_UNDO_CREATE
            | method::MIGRATION_HISTORY_UNDO_READ
            | method::MIGRATION_HISTORY_UNDO_RUN
            | method::MIGRATION_HISTORY_UNDO_CANCEL
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let workspace = factory.continuation_workspace();
    if operation == method::MIGRATION_HISTORY_UNDO_LOOKUP {
        let params: MigrationHistoryUndoLookupParams = decode(params)?;
        return Ok(serde_json::to_value(MigrationHistoryUndoLookupResult {
            existing_job: HistoryUndoJobs::existing_at(
                profile,
                workspace,
                &params.continuation_job_id,
            )?,
        })?);
    }
    if operation == method::MIGRATION_HISTORY_UNDO_PREVIEW {
        let params: MigrationHistoryUndoPreviewParams = decode(params)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        return Ok(serde_json::to_value(HistoryUndoJobs::preview_at(
            profile,
            workspace,
            &params.continuation_job_id,
            || !processor.history.cancelled() && Instant::now() < deadline,
        )?)?);
    }
    let store = if operation == method::MIGRATION_HISTORY_UNDO_CREATE {
        HistoryUndoJobs::open(profile, workspace)?
    } else {
        HistoryUndoJobs::open_existing(profile, workspace)?
            .ok_or_else(|| anyhow::anyhow!("historical_undo_store_missing"))?
    };
    let key = match operation {
        method::MIGRATION_HISTORY_UNDO_CREATE => {
            let params: MigrationHistoryUndoCreateParams = decode(params)?;
            store
                .create(
                    &params.request_id,
                    &params.continuation_job_id,
                    params.expected_continuation_sequence,
                )?
                .job_id
        }
        method::MIGRATION_HISTORY_UNDO_READ => {
            decode::<MigrationHistoryUndoReadParams>(params)?.job_id
        }
        method::MIGRATION_HISTORY_UNDO_CANCEL => {
            let params: MigrationHistoryUndoReadParams = decode(params)?;
            store.cancel(&params.job_id)?;
            params.job_id
        }
        method::MIGRATION_HISTORY_UNDO_RUN => {
            let params: MigrationHistoryUndoRunParams = decode(params)?;
            return Ok(serde_json::to_value(processor.undos.start(
                profile.into(),
                workspace.into(),
                store,
                params.job_id,
                params.expected_sequence,
            )?)?);
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.undos.observe(&store, &key)?,
    )?)
}
