//! Explicit archive retirement shares the bounded connection worker budget.
use super::*;
use kcoder_state::external_history::lifecycle::{
    ArchiveRetirementExecutionState, ArchiveRetirementPhase, ArchiveRetirementView,
};
#[cfg(test)]
mod tests;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_ARCHIVE_RETIREMENT_PREVIEW
            | method::MIGRATION_ARCHIVE_RETIREMENT_PREPARE
            | method::MIGRATION_ARCHIVE_RETIREMENT_READ
            | method::MIGRATION_ARCHIVE_RETIREMENT_LIST
            | method::MIGRATION_ARCHIVE_RETIREMENT_RUN
            | method::MIGRATION_ARCHIVE_RETIREMENT_CANCEL
            | method::MIGRATION_ARCHIVE_RETIREMENT_RESUME
    )
}

fn project(view: ArchiveRetirementView) -> MigrationArchiveRetirement {
    MigrationArchiveRetirement {
        operation_id: view.operation_id,
        job_id: view.source_operation_id,
        archive_id: view.archive_id,
        sequence: view.sequence,
        phase: match view.phase {
            ArchiveRetirementPhase::Prepared => MigrationArchiveRetirementPhase::Prepared,
            ArchiveRetirementPhase::Blocked => MigrationArchiveRetirementPhase::Blocked,
            ArchiveRetirementPhase::Retired => MigrationArchiveRetirementPhase::Retired,
            ArchiveRetirementPhase::Collecting => MigrationArchiveRetirementPhase::Collecting,
            ArchiveRetirementPhase::Collected => MigrationArchiveRetirementPhase::Collected,
            ArchiveRetirementPhase::Cancelled => MigrationArchiveRetirementPhase::Cancelled,
            ArchiveRetirementPhase::OutcomeUnknown => {
                MigrationArchiveRetirementPhase::OutcomeUnknown
            }
        },
        cancel_requested: view.cancel_requested,
        cancel_revision: view.cancel_revision,
        owns_archive: view.owns_archive,
        logical_retired: view.logical_retired,
        retained_references: view.retained_references,
        collected_bytes: view.collected_bytes,
        failure_code: view.failure_code,
    }
}

fn source(store: &HistoryJobStore, operation: &str, job: &str) -> Result<()> {
    ensure!(
        store.read_retirement(operation)?.source_operation_id == job,
        "history_job_retirement_binding_changed"
    );
    Ok(())
}

impl BranchWorkers {
    fn retirement_local(&self, operation: &str) -> Result<(Option<Arc<Worker>>, bool)> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        let worker = tasks
            .workers
            .get(&format!("archive-retirement:{operation}"))
            .cloned();
        let running = worker
            .as_ref()
            .is_some_and(|worker| worker.running.load(Ordering::Acquire));
        Ok((worker, running))
    }
    fn retirement_observe(
        &self,
        store: &HistoryJobStore,
        operation: &str,
    ) -> Result<MigrationArchiveRetirementStateResult> {
        self.retirement_observe_interleaved(store, operation, || Ok(()))
    }
    fn retirement_observe_interleaved(
        &self,
        store: &HistoryJobStore,
        operation: &str,
        mut after_snapshot: impl FnMut() -> Result<()>,
    ) -> Result<MigrationArchiveRetirementStateResult> {
        for _ in 0..4 {
            let before = self.retirement_local(operation)?;
            let (view, state) = store.observe_retirement(operation)?;
            after_snapshot()?;
            let after = self.retirement_local(operation)?;
            let same_worker = match (&before.0, &after.0) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            };
            // A short accepted worker can start AND finish between the Native read
            // and queue read. Its incarnation, not just a false bit, must stay stable.
            if !same_worker || before.1 != after.1 {
                continue;
            }
            let worker = after.0.as_ref();
            let scheduled = after.1;
            let error = worker.and_then(|worker| {
                worker
                    .error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone()
            });
            let worker_error = if state == ArchiveRetirementExecutionState::Unknown {
                Some("external_history_retirement_execution_unknown".into())
            } else if state == ArchiveRetirementExecutionState::Stopped
                && !scheduled
                && view.phase == ArchiveRetirementPhase::Collecting
            {
                Some("external_history_retirement_resume_required".into())
            } else if view.phase == ArchiveRetirementPhase::Collected {
                None
            } else {
                error
            };
            return Ok(MigrationArchiveRetirementStateResult {
                retirement: project(view),
                worker_state: match state {
                    ArchiveRetirementExecutionState::Running => {
                        MigrationArchiveRetirementWorkerState::Running
                    }
                    ArchiveRetirementExecutionState::Stopped => {
                        MigrationArchiveRetirementWorkerState::Stopped
                    }
                    ArchiveRetirementExecutionState::Unknown => {
                        MigrationArchiveRetirementWorkerState::Unknown
                    }
                },
                worker_scheduled: scheduled,
                worker_error,
            });
        }
        anyhow::bail!("history_retirement_observation_busy")
    }

    fn retirement_start(
        &self,
        store: HistoryJobStore,
        params: MigrationArchiveRetirementControlParams,
    ) -> Result<MigrationArchiveRetirementStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        source(&store, &params.operation_id, &params.job_id)?;
        let before = self.retirement_observe(&store, &params.operation_id)?;
        if before.worker_scheduled
            || before.worker_state == MigrationArchiveRetirementWorkerState::Running
        {
            return Ok(before);
        }
        ensure!(
            before.worker_state == MigrationArchiveRetirementWorkerState::Stopped,
            "external_history_retirement_execution_unknown"
        );
        ensure!(
            before.retirement.sequence == params.expected_sequence,
            "external_history_retirement_stale_sequence"
        );
        if before.retirement.phase == MigrationArchiveRetirementPhase::Collected
            || (before.retirement.logical_retired && !before.retirement.owns_archive)
        {
            return Ok(before);
        }
        ensure!(
            !before.retirement.cancel_requested
                && matches!(
                    before.retirement.phase,
                    MigrationArchiveRetirementPhase::Prepared
                        | MigrationArchiveRetirementPhase::Retired
                ),
            "external_history_retirement_resume_required"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Archive retirement worker exited unexpectedly");
            }
        }
        let key = format!("archive-retirement:{}", params.operation_id);
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            return Ok(MigrationArchiveRetirementStateResult {
                worker_scheduled: true,
                ..before
            });
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
            let result =
                store.run_retirement(&params.operation_id, params.expected_sequence, || {
                    !token.is_cancelled()
                });
            *guard
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = result
                .err()
                .map(|error| super::super::super::safe_error(&error));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationArchiveRetirementStateResult {
            worker_scheduled: true,
            ..before
        })
    }
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_ARCHIVE_RETIREMENT_LIST {
        let params: MigrationArchiveRetirementListParams = decode(params)?;
        let after = params
            .cursor
            .as_deref()
            .map(|cursor| processor.views.open_page(profile, cursor))
            .transpose()?;
        let Some(store) = HistoryJobStore::open_existing(profile)? else {
            return Ok(serde_json::to_value(
                MigrationArchiveRetirementListResult {
                    items: Vec::new(),
                    next_cursor: None,
                },
            )?);
        };
        let (items, next) = store.retirement_records(after.as_deref())?;
        let next_cursor = next
            .as_deref()
            .map(|next| processor.views.seal_page(profile, next))
            .transpose()?;
        return Ok(serde_json::to_value(
            MigrationArchiveRetirementListResult {
                items: items
                    .into_iter()
                    .map(|view| {
                        processor
                            .branches
                            .retirement_observe(&store, &view.operation_id)
                    })
                    .collect::<Result<_>>()?,
                next_cursor,
            },
        )?);
    }
    let store = HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
    if operation == method::MIGRATION_ARCHIVE_RETIREMENT_PREVIEW {
        let params: MigrationArchiveRetirementPreviewParams = decode(params)?;
        let preview = store.retirement_preview(&params.job_id)?;
        let existing = preview
            .existing
            .map(|view| {
                processor
                    .branches
                    .retirement_observe(&store, &view.operation_id)
            })
            .transpose()?;
        return Ok(serde_json::to_value(
            MigrationArchiveRetirementPreviewResult {
                job_id: preview.job_id,
                job_sequence: preview.job_sequence,
                archive_id: preview.archive_id,
                can_prepare: preview.can_prepare,
                owns_archive: preview.owns_archive,
                retained_references: preview.retained_references,
                readers_idle: preview.readers_idle,
                reason_code: preview.reason_code,
                existing,
            },
        )?);
    }
    let id = match operation {
        method::MIGRATION_ARCHIVE_RETIREMENT_PREPARE => {
            let params: MigrationArchiveRetirementPrepareParams = decode(params)?;
            store
                .prepare_retirement(
                    &params.operation_id,
                    &params.job_id,
                    params.expected_job_sequence,
                )?
                .operation_id
        }
        method::MIGRATION_ARCHIVE_RETIREMENT_READ => {
            let params: MigrationArchiveRetirementReadParams = decode(params)?;
            source(&store, &params.operation_id, &params.job_id)?;
            params.operation_id
        }
        method::MIGRATION_ARCHIVE_RETIREMENT_CANCEL => {
            let params: MigrationArchiveRetirementReadParams = decode(params)?;
            source(&store, &params.operation_id, &params.job_id)?;
            store.request_retirement_cancel(&params.operation_id)?;
            params.operation_id
        }
        method::MIGRATION_ARCHIVE_RETIREMENT_RUN => {
            let params: MigrationArchiveRetirementControlParams = decode(params)?;
            return Ok(serde_json::to_value(
                processor.branches.retirement_start(store, params)?,
            )?);
        }
        method::MIGRATION_ARCHIVE_RETIREMENT_RESUME => {
            let params: MigrationArchiveRetirementControlParams = decode(params)?;
            source(&store, &params.operation_id, &params.job_id)?;
            store.resume_retirement(&params.operation_id, params.expected_sequence)?;
            params.operation_id
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.branches.retirement_observe(&store, &id)?,
    )?)
}
