//! Connection-owned batch workers observe durable receipts instead of replaying lost calls.
use super::*;
use kcoder_config::{CredentialStoreMode, PrivateDirectory};
use kcoder_migration::batch::execution::{BatchExecution, BatchRunEvent, BatchRunMode};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct State {
    request: MigrationBatchRunParams,
    running: bool,
    error: Option<String>,
    progress: Option<MigrationBatchProgress>,
}

#[derive(Default)]
struct Workers {
    tasks: JoinSet<()>,
    states: BTreeMap<String, Arc<Mutex<State>>>,
}

pub(in super::super) struct BatchWorkers {
    cancellation: CancellationToken,
    workers: Mutex<Workers>,
}

struct Running(Arc<Mutex<State>>);
impl Drop for Running {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.running {
            state.running = false;
            state.error = Some("migration_batch_worker_aborted".into());
        }
    }
}

fn owner(profile: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(profile)?;
    directory.verify_trusted_config_directory()?;
    directory.directory_identity()
}

impl BatchWorkers {
    pub(in super::super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            workers: Mutex::new(Workers::default()),
        }
    }

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

    pub(in super::super) fn observe(
        &self,
        profile: &Path,
        id: &str,
    ) -> Result<MigrationBatchStateResult> {
        let key = format!("{}:{id}", owner(profile)?);
        let snapshot = self
            .workers
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_batch_worker_unavailable"))?
            .states
            .get(&key)
            .map(|state| {
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone()
            });
        let store = MigrationStore::open_existing(profile)?;
        let active = observe_checkpoint(|| store.batch_execution_active(id))?;
        let job = observe_checkpoint(|| store.read(id))?;
        ensure!(job.batch.is_some(), "migration_not_a_batch");
        Ok(MigrationBatchStateResult {
            state: read_result(&job),
            worker_running: active || snapshot.as_ref().is_some_and(|state| state.running),
            worker_error: if active {
                None
            } else {
                snapshot.as_ref().and_then(|state| state.error.clone())
            },
            progress: snapshot.and_then(|state| state.progress),
        })
    }

    pub(in super::super) fn start(
        &self,
        profile: &Path,
        request: MigrationBatchRunParams,
        credential_policy: CredentialStoreMode,
    ) -> Result<MigrationBatchStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "migration_batch_worker_stopping"
        );
        let identity = owner(profile)?;
        let key = format!("{identity}:{}", request.job_id);
        let store = MigrationStore::open_existing(profile)?;
        let job = store.read(&request.job_id)?;
        let batch = job
            .batch
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
        ensure!(
            batch.plan_id.as_deref() == Some(&request.plan_id),
            "migration_unknown_plan"
        );
        let kind = match request.mode {
            MigrationBatchRunMode::Apply => "apply",
            MigrationBatchRunMode::Resume => "resume",
            MigrationBatchRunMode::Rollback => "rollback",
        };
        if let Some(previous) = batch.request_kinds.get(&request.request_id) {
            ensure!(previous == kind, "migration_request_conflict");
        } else {
            ensure!(
                job.sequence == request.expected_sequence,
                "migration_revision_conflict"
            );
        }
        ensure!(
            !request.request_id.is_empty()
                && request.request_id.len() <= 256
                && request
                    .request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric()
                        || matches!(byte, b'-' | b'_' | b':' | b'.')),
            "migration_invalid_request_reference"
        );
        let mut workers = self
            .workers
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_batch_worker_unavailable"))?;
        while let Some(result) = workers.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Migration batch worker exited unexpectedly");
            }
        }
        if let Some(state) = workers.states.get(&key) {
            let state = state.lock().unwrap_or_else(|error| error.into_inner());
            if state.running {
                ensure!(state.request == request, "migration_batch_worker_busy");
                drop(state);
                drop(workers);
                return self.observe(profile, &request.job_id);
            }
        }
        ensure!(
            workers
                .states
                .values()
                .filter(|state| state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .running)
                .count()
                < 2,
            "migration_batch_worker_capacity_reached"
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
            request: request.clone(),
            running: true,
            error: None,
            progress: None,
        }));
        workers.states.insert(key, state.clone());
        let profile_owned = profile.to_path_buf();
        let cancellation = self.cancellation.clone();
        let id = request.job_id.clone();
        workers.tasks.spawn_blocking(move || {
            let running = Running(state);
            let result = run(
                profile_owned,
                &identity,
                &request,
                credential_policy,
                |event| {
                    if cancellation.is_cancelled() {
                        return false;
                    }
                    let mut state = running.0.lock().unwrap_or_else(|error| error.into_inner());
                    match event {
                        BatchRunEvent::Action {
                            action_id,
                            index,
                            total,
                        } => {
                            state.progress = Some(MigrationBatchProgress {
                                action_id: action_id.into(),
                                action_index: index,
                                total_actions: total,
                                history: None,
                            })
                        }
                        BatchRunEvent::History { action_id, event } => {
                            if let Some(progress) = &mut state.progress
                                && progress.action_id == action_id
                            {
                                progress.history = Some(super::super::history::progress(event));
                            }
                        }
                        BatchRunEvent::Checkpoint => {}
                    }
                    true
                },
            );
            let mut state = running.0.lock().unwrap_or_else(|error| error.into_inner());
            state.running = false;
            state.error = result.err().map(|error| super::super::safe_error(&error));
        });
        drop(workers);
        self.observe(profile, &id)
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
            tracing::warn!("Migration batch workers did not settle within the shutdown deadline");
            tasks.abort_all();
        }
    }
}

fn observe_checkpoint<T>(mut read: impl FnMut() -> Result<T>) -> Result<T> {
    for attempt in 0..16 {
        match read() {
            Err(error)
                if attempt < 15
                    && error
                        .downcast_ref::<kcoder_migration::contention::MigrationContention>()
                        .is_some_and(|contention| {
                            contention.lease == kcoder_migration::contention::LeaseKind::JournalRead
                        }) =>
            {
                // Only a short read lease is retried; a mutation is never submitted here.
                std::thread::sleep(Duration::from_millis(1));
            }
            result => return result,
        }
    }
    unreachable!("the final read attempt returns its result")
}

fn run(
    profile: PathBuf,
    identity: &str,
    request: &MigrationBatchRunParams,
    credential_policy: CredentialStoreMode,
    mut check: impl FnMut(BatchRunEvent<'_>) -> bool,
) -> Result<()> {
    ensure!(owner(&profile)? == identity, "migration_wrong_target");
    let store = MigrationStore::open_existing(&profile)?;
    let job = store.read(&request.job_id)?;
    let (provider, mcp) = super::settings_target::open(&profile, &job, false)?;
    let assets = AssetTarget::open(&profile)?;
    let history = kcoder_migration::history_jobs::HistoryJobStore::open_existing(&profile)?;
    let credential_target = kcoder_migration::credentials::CredentialTarget::open(&profile)?;
    let backend = kcoder_config::OsCredentialBackend::new();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: history.as_ref(),
        credentials: Some(kcoder_migration::store::CredentialTargets {
            target: &credential_target,
            backend: &backend,
            policy: credential_policy,
        }),
    };
    let mode = match request.mode {
        MigrationBatchRunMode::Apply => BatchRunMode::Apply,
        MigrationBatchRunMode::Resume => BatchRunMode::Resume,
        MigrationBatchRunMode::Rollback => BatchRunMode::Rollback,
    };
    store.run_batch_controlled(
        BatchExecution {
            job_id: &request.job_id,
            plan_id: &request.plan_id,
            request_id: &request.request_id,
            expected_sequence: request.expected_sequence,
            mode,
        },
        &targets,
        &mut check,
    )?;
    Ok(())
}
