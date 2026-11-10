//! A connection cancels only its worker token, never a peer's durable control state.
use super::*;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Capture,
    Apply,
    Undo,
}
#[derive(Default)]
struct Worker {
    running: AtomicBool,
    error: Mutex<Option<String>>,
    action: Option<Action>,
}
#[derive(Default)]
struct Tasks {
    tasks: JoinSet<()>,
    workers: BTreeMap<String, Arc<Worker>>,
}
pub(in super::super) struct PluginWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<Tasks>,
}
struct Guard(Arc<Worker>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::Release)
    }
}
impl PluginWorkers {
    pub(in super::super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            tasks: Mutex::new(Tasks::default()),
        }
    }
    pub(in super::super) fn activity(&self) -> usize {
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
    pub(super) fn observe(
        &self,
        store: &PluginMigrationStore,
        key: &str,
    ) -> Result<MigrationPluginStateResult> {
        let (local, error, action) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("plugin_migration_worker_unavailable"))?;
            let worker = tasks.workers.get(key);
            (
                worker.is_some_and(|worker| worker.running.load(Ordering::Acquire)),
                worker.and_then(|worker| worker.error.lock().ok().and_then(|error| error.clone())),
                worker.and_then(|worker| worker.action),
            )
        };
        let job = store.read(key, &PluginCancellationToken::default())?;
        let settled = match action {
            Some(Action::Capture) => matches!(job.stage, Stage::Ready | Stage::Pending),
            Some(Action::Apply) => job.stage == Stage::Imported,
            Some(Action::Undo) => job.stage == Stage::Undone,
            None => false,
        };
        let running = local || store.running(key)?;
        let error = job
            .failure_code
            .clone()
            .or(if settled && !running { None } else { error });
        Ok(MigrationPluginStateResult {
            job: dto(job),
            worker_running: running,
            worker_error: error,
        })
    }
    pub(super) fn start(
        &self,
        profile: PathBuf,
        store: PluginMigrationStore,
        key: String,
        sequence: u64,
        action: Action,
    ) -> Result<MigrationPluginStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "plugin_migration_worker_stopping"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("plugin_migration_worker_unavailable"))?;
        while tasks.tasks.try_join_next().is_some() {}
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
            || store.running(&key)?
        {
            drop(tasks);
            return self.observe(&store, &key);
        }
        let job = store.read(&key, &PluginCancellationToken::default())?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        ensure!(
            job.batch_job_id.is_none(),
            "plugin_migration_claimed_by_another_owner"
        );
        let no_action = match action {
            Action::Capture => matches!(
                job.stage,
                Stage::Ready | Stage::Pending | Stage::Imported | Stage::Undone
            ),
            Action::Apply => matches!(job.stage, Stage::Imported | Stage::Undone | Stage::Pending),
            Action::Undo => job.stage == Stage::Undone,
        };
        if no_action {
            drop(tasks);
            return self.observe(&store, &key);
        }
        ensure!(!job.cancel_requested, "plugin_migration_cancelled");
        ensure!(
            tasks
                .workers
                .values()
                .filter(|worker| worker.running.load(Ordering::Acquire))
                .count()
                < 2,
            "plugin_migration_worker_capacity_reached"
        );
        while tasks.workers.len() >= 64 {
            let Some(old) = tasks
                .workers
                .iter()
                .find(|(_, worker)| !worker.running.load(Ordering::Acquire))
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            tasks.workers.remove(&old);
        }
        let observer = PluginMigrationStore::open_existing(&profile)?
            .ok_or_else(|| anyhow::anyhow!("plugin_migration_store_missing"))?;
        let worker = Arc::new(Worker {
            action: Some(action),
            ..Worker::default()
        });
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key.clone(), worker.clone());
        let token = self.cancellation.clone();
        let worker_key = key.clone();
        tasks.tasks.spawn_blocking(move || {
            let _guard = Guard(worker.clone());
            let cancel =
                PluginCancellationToken::default().with_probe(move || token.is_cancelled());
            let result = match action {
                Action::Capture => store.capture(&worker_key, sequence, &cancel),
                Action::Apply => store.apply(&worker_key, sequence, &cancel),
                Action::Undo => store.undo(&worker_key, sequence, &cancel),
            };
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
    pub(super) fn clear_finished_error(&self, key: &str) {
        if let Ok(tasks) = self.tasks.lock()
            && let Some(worker) = tasks.workers.get(key)
            && !worker.running.load(Ordering::Acquire)
        {
            *worker
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
    }
    pub(in super::super) async fn shutdown(&self) {
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
