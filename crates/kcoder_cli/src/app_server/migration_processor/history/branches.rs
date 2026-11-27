//! Connection-owned computation over immutable archives; no historical operation is resumed.
use super::*;
use kcoder_migration::history_branches::HistoryBranchStore;
use kcoder_types::historical_branch::HistoricalBranchStage;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
mod attachments;
mod local_attachments;
mod retirement;
mod tools;
mod upload_collection;

#[derive(Default)]
struct Worker {
    running: AtomicBool,
    error: Mutex<Option<String>>,
}
struct Guard(Arc<Worker>);
impl Drop for Guard {
    fn drop(&mut self) {
        if self.0.running.swap(false, Ordering::AcqRel) {
            *self
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                Some("history_branch_worker_aborted".into());
        }
    }
}
#[derive(Default)]
struct Tasks {
    tasks: JoinSet<()>,
    workers: BTreeMap<String, Arc<Worker>>,
}
pub(in super::super) struct BranchWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<Tasks>,
}
impl BranchWorkers {
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
    fn observe(
        &self,
        store: &HistoryBranchStore,
        job: &str,
        id: Option<&str>,
    ) -> Result<MigrationBranchStateResult> {
        super::super::observations::read_catalog(|| self.observe_once(store, job, id))
    }
    fn observe_once(
        &self,
        store: &HistoryBranchStore,
        job: &str,
        id: Option<&str>,
    ) -> Result<MigrationBranchStateResult> {
        let choice = store.last_choice(job)?;
        let selected = id
            .map(str::to_owned)
            .or_else(|| choice.as_ref().map(|choice| choice.view_id.clone()));
        let Some(id) = selected else {
            return Ok(MigrationBranchStateResult {
                choice,
                progress: None,
                worker_running: false,
                worker_error: None,
            });
        };
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        let local = tasks.workers.get(&id);
        let local_running = local.is_some_and(|worker| worker.running.load(Ordering::Acquire));
        let mut error = local.and_then(|worker| {
            worker
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        });
        drop(tasks);
        let running_before = local_running || store.running(job, &id)?;
        let progress = store.progress(job, &id)?;
        let running = !matches!(
            progress.stage,
            HistoricalBranchStage::Ready
                | HistoricalBranchStage::Cancelled
                | HistoricalBranchStage::Failed
        ) && (running_before || store.running(job, &id)?);
        if progress.stage == HistoricalBranchStage::Ready {
            error = None;
        }
        Ok(MigrationBranchStateResult {
            choice: choice.filter(|choice| choice.view_id == id),
            progress: Some(progress),
            worker_running: running,
            worker_error: error,
        })
    }
    fn start(
        &self,
        store: HistoryBranchStore,
        job: String,
        id: String,
    ) -> Result<MigrationBranchStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        let before = self.observe(&store, &job, Some(&id))?;
        if before.worker_running
            || before
                .progress
                .as_ref()
                .is_some_and(|progress| progress.stage == HistoricalBranchStage::Ready)
        {
            return Ok(before);
        }
        ensure!(
            !before.progress.as_ref().is_some_and(|progress| matches!(
                progress.stage,
                HistoricalBranchStage::Cancelled | HistoricalBranchStage::Failed
            )),
            "history_branch_resume_required"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Historical branch worker exited unexpectedly");
            }
        }
        if tasks
            .workers
            .get(&id)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.observe(&store, &job, Some(&id));
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
        tasks.workers.insert(id.clone(), worker.clone());
        let token = self.cancellation.clone();
        tasks.tasks.spawn_blocking(move || {
            let guard = Guard(worker);
            let result = store.build(&job, &id, || !token.is_cancelled());
            *guard
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                result.err().map(|error| super::super::safe_error(&error));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationBranchStateResult {
            worker_running: true,
            worker_error: None,
            ..before
        })
    }
    pub(in super::super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut tasks.tasks)
        };
        if tokio::time::timeout(Duration::from_secs(10), async {
            while tasks.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            tracing::warn!("Historical branch workers did not settle within the shutdown deadline");
            tasks.abort_all();
        }
    }
}

pub(super) fn handles(operation: &str) -> bool {
    if retirement::handles(operation) {
        return true;
    }
    if upload_collection::handles(operation) {
        return true;
    }
    if local_attachments::handles(operation) {
        return true;
    }
    attachments::handles(operation)
        || tools::handles(operation)
        || matches!(
            operation,
            method::MIGRATION_BRANCH_PREPARE
                | method::MIGRATION_BRANCH_READ
                | method::MIGRATION_BRANCH_RUN
                | method::MIGRATION_BRANCH_CANCEL
                | method::MIGRATION_BRANCH_RESUME
                | method::MIGRATION_BRANCH_PAGE
                | method::MIGRATION_BRANCH_BLOCKS
                | method::MIGRATION_BRANCH_TEXT
        )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if retirement::handles(operation) {
        return retirement::execute(processor, profile, operation, params);
    }
    if upload_collection::handles(operation) {
        return upload_collection::execute(processor, profile, operation, params);
    }
    if local_attachments::handles(operation) {
        return local_attachments::execute(processor, profile, operation, params);
    }
    if attachments::handles(operation) {
        return attachments::execute(processor, profile, operation, params);
    }
    if tools::handles(operation) {
        return tools::execute(processor, profile, operation, params);
    }
    let store = HistoryBranchStore::open(profile)?;
    match operation {
        method::MIGRATION_BRANCH_PREPARE => {
            let params: MigrationBranchPrepareParams = decode(params)?;
            let progress = if params.reconstruct_readable {
                anyhow::ensure!(
                    params.related_job_ids.is_empty(),
                    "history_reconstruction_source_incomplete"
                );
                store.prepare_readable_reconstruction(&params.job_id)?
            } else {
                store.prepare(&params.job_id, &params.related_job_ids)?
            };
            Ok(serde_json::to_value(processor.branches.observe(
                &store,
                &params.job_id,
                Some(&progress.view_id),
            )?)?)
        }
        method::MIGRATION_BRANCH_READ => {
            let params: MigrationBranchReadParams = decode(params)?;
            Ok(serde_json::to_value(processor.branches.observe(
                &store,
                &params.job_id,
                params.view_id.as_deref(),
            )?)?)
        }
        method::MIGRATION_BRANCH_RUN => {
            let params: MigrationBranchOperationParams = decode(params)?;
            Ok(serde_json::to_value(processor.branches.start(
                store,
                params.job_id,
                params.view_id,
            )?)?)
        }
        method::MIGRATION_BRANCH_CANCEL => {
            let params: MigrationBranchOperationParams = decode(params)?;
            store.cancel(&params.job_id, &params.view_id)?;
            Ok(serde_json::to_value(MigrationBranchCancelResult {
                view_id: params.view_id,
                cancel_requested: true,
            })?)
        }
        method::MIGRATION_BRANCH_RESUME => {
            let params: MigrationBranchResumeParams = decode(params)?;
            store.resume(&params.job_id, &params.view_id, params.expected_sequence)?;
            Ok(serde_json::to_value(processor.branches.observe(
                &store,
                &params.job_id,
                Some(&params.view_id),
            )?)?)
        }
        method::MIGRATION_BRANCH_PAGE => {
            let params: MigrationBranchPageParams = decode(params)?;
            Ok(serde_json::to_value(store.page(
                &params.job_id,
                &params.view_id,
                params.cursor.unwrap_or(0),
                |_| !processor.history.cancelled(),
            )?)?)
        }
        method::MIGRATION_BRANCH_BLOCKS => {
            let params: MigrationBranchBlocksParams = decode(params)?;
            Ok(serde_json::to_value(store.blocks(
                &params.job_id,
                &params.view_id,
                params.position,
                params.cursor.unwrap_or(0),
                |_| !processor.history.cancelled(),
            )?)?)
        }
        method::MIGRATION_BRANCH_TEXT => {
            let params: MigrationBranchTextParams = decode(params)?;
            let address = MigrationTranscriptTextParams {
                job_id: params.job_id.clone(),
                record: params.position,
                block_index: params.block_index,
                cursor: params.cursor.clone(),
            };
            if let Some(cursor) = &params.cursor {
                processor
                    .transcript_cursor
                    .validate_selector(cursor, &address)?;
            }
            let identity = store.text_identity(&params.job_id, &params.view_id, params.position)?;
            let (offset, part) = match &params.cursor {
                Some(cursor) => processor
                    .transcript_cursor
                    .open_body(cursor, &address, &identity)?,
                None => (0, None),
            };
            let chunk = if let Some(range) = part.clone() {
                store.text_part(
                    &params.job_id,
                    &params.view_id,
                    params.position,
                    kcoder_migration::history_search::SearchPartRead {
                        block: params.block_index,
                        range,
                        offset,
                    },
                    |_| !processor.history.cancelled(),
                )?
            } else {
                store.text(
                    &params.job_id,
                    &params.view_id,
                    params.position,
                    params.block_index,
                    offset,
                    |_| !processor.history.cancelled(),
                )?
            };
            let next_cursor = chunk
                .next_offset
                .map(|offset| {
                    processor
                        .transcript_cursor
                        .seal_part(&address, offset, part.clone(), &identity)
                })
                .transpose()?;
            Ok(serde_json::to_value(MigrationTranscriptTextResult {
                text: chunk.text,
                next_cursor,
                source_bytes: chunk.source_bytes,
                decoded_bytes: chunk.decoded_bytes,
                encoding: chunk.encoding,
            })?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}
