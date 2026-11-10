use super::*;
use kcoder_types::historical_tool_links::HistoricalToolLinkStage;

impl BranchWorkers {
    fn tools_observe(
        &self,
        store: &HistoryBranchStore,
        job: &str,
        id: &str,
    ) -> Result<MigrationBranchToolsStateResult> {
        super::super::super::observations::read_catalog(|| self.tools_observe_once(store, job, id))
    }
    fn tools_observe_once(
        &self,
        store: &HistoryBranchStore,
        job: &str,
        id: &str,
    ) -> Result<MigrationBranchToolsStateResult> {
        let key = format!("tools:{id}");
        let (queued, error) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
            let local = tasks.workers.get(&key);
            (
                local.is_some_and(|worker| worker.running.load(Ordering::Acquire)),
                local.and_then(|worker| {
                    worker
                        .error
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone()
                }),
            )
        };
        let mut state = store.tools_state(job, id)?;
        // A resumed worker may still be queued while the durable run is cancelled.
        state.worker_running |= queued;
        Ok(MigrationBranchToolsStateResult {
            worker_error: if state
                .run
                .as_ref()
                .is_some_and(|run| run.stage == HistoricalToolLinkStage::Ready)
            {
                None
            } else {
                error
            },
            state,
        })
    }
    fn tools_start(
        &self,
        store: HistoryBranchStore,
        job: String,
        id: String,
        resume: Option<u64>,
    ) -> Result<MigrationBranchToolsStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        let before = self.tools_observe(&store, &job, &id)?;
        if before.state.worker_running
            || before
                .state
                .run
                .as_ref()
                .is_some_and(|run| run.stage == HistoricalToolLinkStage::Ready)
        {
            return Ok(before);
        }
        if let Some(run) = &before.state.run
            && matches!(
                run.stage,
                HistoricalToolLinkStage::Cancelled | HistoricalToolLinkStage::Failed
            )
        {
            ensure!(
                resume == Some(run.sequence),
                "history_tool_links_resume_required"
            );
        }
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Historical tool correlation worker exited unexpectedly");
            }
        }
        let key = format!("tools:{id}");
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.tools_observe(&store, &job, &id);
        }
        ensure!(
            tasks
                .workers
                .values()
                .filter(|worker| worker.running.load(Ordering::Acquire))
                .count()
                < kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY,
            "history_branch_worker_capacity_reached"
        );
        if tasks.workers.len() >= 32 {
            tasks
                .workers
                .retain(|_, worker| worker.running.load(Ordering::Acquire));
        }
        let worker = Arc::new(Worker::default());
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key, worker.clone());
        let token = self.cancellation.clone();
        tasks.tasks.spawn_blocking(move || {
            let guard = Guard(worker);
            let result = store.correlate(&job, &id, resume, || !token.is_cancelled());
            *guard
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = result
                .err()
                .map(|error| super::super::super::safe_error(&error));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationBranchToolsStateResult {
            state: kcoder_types::historical_tool_links::HistoricalBranchToolState {
                worker_running: true,
                ..before.state
            },
            worker_error: None,
        })
    }
}

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_BRANCH_TOOLS_READ
            | method::MIGRATION_BRANCH_TOOLS_RUN
            | method::MIGRATION_BRANCH_TOOLS_RESUME
            | method::MIGRATION_BRANCH_TOOLS_CANCEL
            | method::MIGRATION_BRANCH_TOOLS_PAGE
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = HistoryBranchStore::open(profile)?;
    match operation {
        method::MIGRATION_BRANCH_TOOLS_READ => {
            let params: MigrationBranchOperationParams = decode(params)?;
            Ok(serde_json::to_value(processor.branches.tools_observe(
                &store,
                &params.job_id,
                &params.view_id,
            )?)?)
        }
        method::MIGRATION_BRANCH_TOOLS_RUN => {
            let params: MigrationBranchOperationParams = decode(params)?;
            Ok(serde_json::to_value(processor.branches.tools_start(
                store,
                params.job_id,
                params.view_id,
                None,
            )?)?)
        }
        method::MIGRATION_BRANCH_TOOLS_RESUME => {
            let params: MigrationBranchResumeParams = decode(params)?;
            Ok(serde_json::to_value(processor.branches.tools_start(
                store,
                params.job_id,
                params.view_id,
                Some(params.expected_sequence),
            )?)?)
        }
        method::MIGRATION_BRANCH_TOOLS_CANCEL => {
            let params: MigrationBranchOperationParams = decode(params)?;
            store.cancel_tools(&params.job_id, &params.view_id)?;
            Ok(serde_json::to_value(MigrationBranchCancelResult {
                view_id: params.view_id,
                cancel_requested: true,
            })?)
        }
        method::MIGRATION_BRANCH_TOOLS_PAGE => {
            let params: MigrationBranchToolsPageParams = decode(params)?;
            Ok(serde_json::to_value(store.tools_page(
                &params.job_id,
                &params.view_id,
                params.cursor.as_deref(),
            )?)?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}
