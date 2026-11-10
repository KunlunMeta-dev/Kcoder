//! Attachment workers share the branch worker budget and connection cancellation authority.
use super::*;
use anyhow::Context;
use base64::Engine;
use kcoder_migration::history_attachment_jobs::HistoryAttachmentJobs;
use kcoder_types::historical_attachment::{
    HistoricalAttachmentJobStage, HistoricalAttachmentSelection,
};
use sha2::{Digest, Sha256};
impl BranchWorkers {
    fn attachment_observe(
        &self,
        store: &HistoryAttachmentJobs,
        selection: &HistoricalAttachmentSelection,
    ) -> Result<MigrationHistoryAttachmentStateResult> {
        let current_job = store.read(selection)?;
        let local = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
            let local = current_job
                .as_ref()
                .and_then(|v| tasks.workers.get(&format!("attachment:{}", v.id)));
            (
                local.is_some_and(|v| v.running.load(Ordering::Acquire)),
                local.and_then(|v| v.error.lock().unwrap_or_else(|e| e.into_inner()).clone()),
            )
        };
        let job = store.read(selection)?;
        let running = local.0
            || (job.as_ref().is_some_and(|v| {
                !matches!(
                    v.stage,
                    HistoricalAttachmentJobStage::Ready
                        | HistoricalAttachmentJobStage::Unavailable
                        | HistoricalAttachmentJobStage::Catalogued
                )
            }) && store.running(selection)?);
        let terminal = job.as_ref().is_some_and(|v| {
            matches!(
                v.stage,
                HistoricalAttachmentJobStage::Ready
                    | HistoricalAttachmentJobStage::Unavailable
                    | HistoricalAttachmentJobStage::Catalogued
            )
        });
        Ok(MigrationHistoryAttachmentStateResult {
            job,
            worker_running: running,
            worker_error: if terminal { None } else { local.1 },
        })
    }
    fn attachment_start(
        &self,
        store: HistoryAttachmentJobs,
        selection: HistoricalAttachmentSelection,
        resume: Option<u64>,
    ) -> Result<MigrationHistoryAttachmentStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        store.prepare(&selection)?;
        let before = self.attachment_observe(&store, &selection)?;
        let job = before
            .job
            .as_ref()
            .context("history_attachment_job_missing")?;
        if before.worker_running
            || matches!(
                job.stage,
                HistoricalAttachmentJobStage::Ready
                    | HistoricalAttachmentJobStage::Unavailable
                    | HistoricalAttachmentJobStage::Catalogued
            )
        {
            return Ok(before);
        }
        if matches!(
            job.stage,
            HistoricalAttachmentJobStage::Cancelled | HistoricalAttachmentJobStage::Failed
        ) {
            ensure!(
                resume == Some(job.sequence),
                "history_attachment_resume_required"
            );
        }
        if !matches!(
            job.stage,
            HistoricalAttachmentJobStage::Cancelled | HistoricalAttachmentJobStage::Failed
        ) {
            ensure!(resume.is_none(), "history_attachment_revision_conflict");
        }
        let key = format!("attachment:{}", job.id);
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Historical attachment worker exited unexpectedly");
            }
        }
        if tasks
            .workers
            .get(&key)
            .is_some_and(|v| v.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.attachment_observe(&store, &selection);
        }
        ensure!(
            tasks
                .workers
                .values()
                .filter(|v| v.running.load(Ordering::Acquire))
                .count()
                < kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY,
            "history_branch_worker_capacity_reached"
        );
        if tasks.workers.len() >= 32 {
            tasks
                .workers
                .retain(|_, v| v.running.load(Ordering::Acquire));
        }
        let worker = Arc::new(Worker::default());
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key, worker.clone());
        let token = self.cancellation.clone();
        tasks.tasks.spawn_blocking(move || {
            let guard = Guard(worker);
            let result = store.run(&selection, resume, || !token.is_cancelled());
            *guard.0.error.lock().unwrap_or_else(|e| e.into_inner()) =
                result.err().map(|e| super::super::super::safe_error(&e));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationHistoryAttachmentStateResult {
            worker_running: true,
            worker_error: None,
            ..before
        })
    }
}
fn canonical(operation: &str) -> Option<&str> {
    Some(match operation {
        method::MIGRATION_TOOL_ATTACHMENTS_READ => method::MIGRATION_HISTORY_ATTACHMENT_READ,
        method::MIGRATION_TOOL_ATTACHMENTS_RUN => method::MIGRATION_HISTORY_ATTACHMENT_RUN,
        method::MIGRATION_TOOL_ATTACHMENTS_RESUME => method::MIGRATION_HISTORY_ATTACHMENT_RESUME,
        method::MIGRATION_TOOL_ATTACHMENTS_CANCEL => method::MIGRATION_HISTORY_ATTACHMENT_CANCEL,
        method::MIGRATION_TOOL_ATTACHMENTS_CHUNK => method::MIGRATION_HISTORY_ATTACHMENT_CHUNK,
        method::MIGRATION_TOOL_ATTACHMENTS_ITEMS => method::MIGRATION_TOOL_ATTACHMENTS_ITEMS,
        method::MIGRATION_HISTORY_ATTACHMENT_READ
        | method::MIGRATION_HISTORY_ATTACHMENT_RUN
        | method::MIGRATION_HISTORY_ATTACHMENT_RESUME
        | method::MIGRATION_HISTORY_ATTACHMENT_CANCEL
        | method::MIGRATION_HISTORY_ATTACHMENT_CHUNK => operation,
        _ => return None,
    })
}
pub(super) fn handles(operation: &str) -> bool {
    canonical(operation).is_some()
}
fn open_for(
    profile: &Path,
    selection: &HistoricalAttachmentSelection,
    create: bool,
    tool: bool,
) -> Result<Option<HistoryAttachmentJobs>> {
    let store = if create {
        Some(HistoryAttachmentJobs::open(profile)?)
    } else {
        HistoryAttachmentJobs::open_existing(profile)?
    };
    if tool && let Some(store) = &store {
        store.require_tool_result(selection)?;
    }
    Ok(store)
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let tool = operation.starts_with("migration/history/tool-attachments/");
    let operation = canonical(operation).context("migration_unknown_operation")?;
    match operation {
        method::MIGRATION_TOOL_ATTACHMENTS_ITEMS => {
            let params: MigrationHistoryToolAttachmentItemsParams = decode(params)?;
            let store = open_for(profile, &params.selection, false, tool)?
                .context("history_attachment_jobs_missing")?;
            Ok(serde_json::to_value(store.tool_items(
                &params.selection,
                params.cursor.unwrap_or(0),
            )?)?)
        }
        method::MIGRATION_HISTORY_ATTACHMENT_READ => {
            let params: MigrationHistoryAttachmentParams = decode(params)?;
            let value = match open_for(profile, &params.selection, false, tool)? {
                Some(store) => processor
                    .branches
                    .attachment_observe(&store, &params.selection)?,
                None => MigrationHistoryAttachmentStateResult {
                    job: None,
                    worker_running: false,
                    worker_error: None,
                },
            };
            Ok(serde_json::to_value(value)?)
        }
        method::MIGRATION_HISTORY_ATTACHMENT_RUN => {
            let params: MigrationHistoryAttachmentParams = decode(params)?;
            Ok(serde_json::to_value(
                processor.branches.attachment_start(
                    open_for(profile, &params.selection, true, tool)?
                        .context("history_attachment_jobs_missing")?,
                    params.selection,
                    None,
                )?,
            )?)
        }
        method::MIGRATION_HISTORY_ATTACHMENT_RESUME => {
            let params: MigrationHistoryAttachmentResumeParams = decode(params)?;
            Ok(serde_json::to_value(
                processor.branches.attachment_start(
                    open_for(profile, &params.selection, true, tool)?
                        .context("history_attachment_jobs_missing")?,
                    params.selection,
                    Some(params.expected_sequence),
                )?,
            )?)
        }
        method::MIGRATION_HISTORY_ATTACHMENT_CANCEL => {
            let params: MigrationHistoryAttachmentParams = decode(params)?;
            let store = open_for(profile, &params.selection, true, tool)?
                .context("history_attachment_jobs_missing")?;
            store.cancel(&params.selection)?;
            Ok(serde_json::to_value(
                processor
                    .branches
                    .attachment_observe(&store, &params.selection)?,
            )?)
        }
        method::MIGRATION_HISTORY_ATTACHMENT_CHUNK => {
            let params: MigrationHistoryAttachmentChunkParams = decode(params)?;
            let store = open_for(profile, &params.selection, false, tool)?
                .context("history_attachment_jobs_missing")?;
            let (receipt, bytes) = store.chunk(
                &params.selection,
                params.offset,
                params.limit.unwrap_or(256 * 1024) as usize,
            )?;
            let end = params.offset + bytes.len() as u64;
            Ok(serde_json::to_value(
                MigrationHistoryAttachmentChunkResult {
                    next_offset: (end < receipt.bytes).then_some(end),
                    receipt,
                    offset: params.offset,
                    data_sha256: format!("{:x}", Sha256::digest(&bytes)),
                    data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                },
            )?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}
