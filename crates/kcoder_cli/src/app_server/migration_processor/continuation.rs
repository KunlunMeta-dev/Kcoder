//! Connection-owned workers publish idle histories; no user turn or source operation is started.
use super::*;
use kcoder_migration::history_continuation_jobs::ContinuationJobs;
use kcoder_types::historical_continuation::HistoricalContinuationStage as Stage;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{runtime::Handle, task::JoinSet};
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
pub(super) struct ContinuationWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<Tasks>,
}
struct Guard(Arc<Worker>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::Release);
    }
}
impl ContinuationWorkers {
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
        store: &ContinuationJobs,
        key: &str,
    ) -> Result<MigrationContinuationStateResult> {
        let (local, error) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("continuation_worker_unavailable"))?;
            let worker = tasks.workers.get(key);
            (
                worker.is_some_and(|worker| worker.running.load(Ordering::Acquire)),
                worker.and_then(|worker| worker.error.lock().ok().and_then(|error| error.clone())),
            )
        };
        let job = store.read(key)?;
        let running = local || store.running(key)?;
        Ok(MigrationContinuationStateResult {
            worker_running: job.stage != Stage::Imported && running,
            worker_error: if job.stage == Stage::Imported {
                None
            } else {
                error
            },
            job,
        })
    }
    fn start(
        &self,
        factory: Arc<dyn MigrationHost>,
        profile: PathBuf,
        store: ContinuationJobs,
        key: String,
        sequence: u64,
        resume: bool,
    ) -> Result<MigrationContinuationStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "continuation_worker_stopping"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("continuation_worker_unavailable"))?;
        while tasks.tasks.try_join_next().is_some() {}
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.observe(&store, &key);
        }
        let view = store.read(&key)?;
        if view.stage == Stage::Imported {
            drop(tasks);
            return self.observe(&store, &key);
        }
        ensure!(view.sequence == sequence, "continuation_revision_conflict");
        ensure!(
            self.activity_without_lock(&tasks)
                < kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY,
            "continuation_worker_capacity_reached"
        );
        let worker = Arc::new(Worker::default());
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key.clone(), worker.clone());
        let observer = ContinuationJobs::open_existing(&profile, factory.continuation_workspace())?
            .ok_or_else(|| anyhow::anyhow!("continuation_store_missing"))?;
        let token = self.cancellation.clone();
        let runtime = Handle::current();
        let worker_key = key.clone();
        tasks.tasks.spawn_blocking(move || {
            let _guard = Guard(worker.clone());
            let result = (|| -> Result<()> {
                let mut run = store.begin(&worker_key, sequence, resume)?;
                let outcome =
                    runtime.block_on(factory.continue_history(&profile, &mut run, &token));
                if let Err(error) = outcome {
                    let publishing =
                        matches!(run.view().stage, Stage::Publishing | Stage::PublishUnknown);
                    let cancelled = token.is_cancelled() || run.cancelled().unwrap_or(false);
                    run.stop(
                        if publishing {
                            Stage::PublishUnknown
                        } else if cancelled {
                            Stage::Cancelled
                        } else {
                            Stage::Failed
                        },
                        Some(&safe_error(&error)),
                    )?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                *worker
                    .error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(safe_error(&error));
            }
        });
        drop(tasks);
        self.observe(&observer, &key)
    }
    fn activity_without_lock(&self, tasks: &Tasks) -> usize {
        tasks
            .workers
            .values()
            .filter(|worker| worker.running.load(Ordering::Acquire))
            .count()
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
        method::MIGRATION_CONTINUATION_SOURCE
            | method::MIGRATION_CONTINUATION_CREATE
            | method::MIGRATION_CONTINUATION_READ
            | method::MIGRATION_CONTINUATION_RUN
            | method::MIGRATION_CONTINUATION_RESUME
            | method::MIGRATION_CONTINUATION_CANCEL
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_CONTINUATION_SOURCE {
        let params: MigrationContinuationSourceParams = decode(params)?;
        return Ok(serde_json::to_value(MigrationContinuationSourceResult {
            source: factory.continuation_source(&params.thread_id)?,
        })?);
    }
    let workspace = factory.continuation_workspace();
    let store = if operation == method::MIGRATION_CONTINUATION_CREATE {
        ContinuationJobs::open(profile, workspace)?
    } else {
        ContinuationJobs::open_existing(profile, workspace)?
            .ok_or_else(|| anyhow::anyhow!("continuation_job_not_found"))?
    };
    let key = match operation {
        method::MIGRATION_CONTINUATION_CREATE => {
            let params: MigrationContinuationCreateParams = decode(params)?;
            store.create(
                &params.request_id,
                &params.source_job_id,
                &params.view_id,
                params.policy,
                params.options,
            )?;
            params.request_id
        }
        method::MIGRATION_CONTINUATION_READ => {
            decode::<MigrationContinuationReadParams>(params)?.job_id
        }
        method::MIGRATION_CONTINUATION_CANCEL => {
            let params: MigrationContinuationReadParams = decode(params)?;
            store.cancel(&params.job_id)?;
            params.job_id
        }
        method::MIGRATION_CONTINUATION_RUN | method::MIGRATION_CONTINUATION_RESUME => {
            let params: MigrationContinuationRunParams = decode(params)?;
            return Ok(serde_json::to_value(processor.continuations.start(
                factory.clone_host(),
                profile.into(),
                store,
                params.job_id,
                params.expected_sequence,
                operation == method::MIGRATION_CONTINUATION_RESUME,
            )?)?);
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.continuations.observe(&store, &key)?,
    )?)
}
