//! A connection owns computation; the profile owns durable uploaded bytes and receipts.
use super::*;
use base64::Engine;
use kcoder_migration::local_attachment::{
    HistoryLocalAttachments, upload::HistoryLocalAttachmentUploads,
};
use kcoder_types::{local_attachment::HistoricalLocalAttachmentStage, local_attachment_upload::*};
use sha2::{Digest, Sha256};

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_LOCAL_ATTACHMENT_PREPARE
            | method::MIGRATION_LOCAL_ATTACHMENT_BEGIN
            | method::MIGRATION_LOCAL_ATTACHMENT_PART
            | method::MIGRATION_LOCAL_ATTACHMENT_FINISH
            | method::MIGRATION_LOCAL_ATTACHMENT_READ
            | method::MIGRATION_LOCAL_ATTACHMENT_RESUME
            | method::MIGRATION_LOCAL_ATTACHMENT_RUN
            | method::MIGRATION_LOCAL_ATTACHMENT_CANCEL
            | method::MIGRATION_LOCAL_ATTACHMENT_LIST
            | method::MIGRATION_LOCAL_ATTACHMENT_CHUNK
    )
}

impl BranchWorkers {
    fn local_attachment_observe(
        &self,
        store: &HistoryLocalAttachmentUploads,
        operation: &str,
    ) -> Result<MigrationLocalAttachmentStateResult> {
        let upload = store.read(operation)?;
        let (running, error) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
            let worker = tasks.workers.get(&format!("local-attachment:{operation}"));
            (
                worker.is_some_and(|value| value.running.load(Ordering::Acquire)),
                worker.and_then(|value| {
                    value
                        .error
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone()
                }),
            )
        };
        let ready = upload
            .local_job
            .as_ref()
            .is_some_and(|job| job.state.stage == HistoricalLocalAttachmentStage::Ready);
        let native_copy = upload
            .local_job
            .as_ref()
            .is_some_and(|job| job.state.stage == HistoricalLocalAttachmentStage::Copying);
        Ok(MigrationLocalAttachmentStateResult {
            worker_running: !ready && (running || native_copy || store.running(operation)?),
            worker_error: if ready { None } else { error },
            upload,
        })
    }

    fn local_attachment_start(
        &self,
        profile: &Path,
        operation: String,
        sequence: u64,
        finish: bool,
    ) -> Result<MigrationLocalAttachmentStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        let store = HistoryLocalAttachmentUploads::open_existing(profile)?
            .ok_or_else(|| anyhow::anyhow!("local_attachment_upload_not_found"))?;
        let before = self.local_attachment_observe(&store, &operation)?;
        if before.worker_running {
            return Ok(before);
        }
        if finish {
            if before.upload.stage == HistoricalLocalAttachmentUploadStage::Authorized {
                return Ok(before);
            }
            ensure!(
                before.upload.sequence == sequence,
                "local_attachment_upload_revision_conflict"
            );
            ensure!(
                !before.upload.cancel_requested,
                "local_attachment_upload_resume_required"
            );
        } else {
            let local = before
                .upload
                .local_job
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("local_attachment_job_not_found"))?;
            if local.state.stage == HistoricalLocalAttachmentStage::Ready {
                return Ok(before);
            }
            ensure!(
                local.state.sequence == sequence,
                "local_attachment_revision_conflict"
            );
            ensure!(
                !before.upload.cancel_requested,
                "local_attachment_upload_resume_required"
            );
        }
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Historical local attachment worker exited unexpectedly");
            }
        }
        let key = format!("local-attachment:{operation}");
        if tasks
            .workers
            .get(&key)
            .is_some_and(|value| value.running.load(Ordering::Acquire))
        {
            drop(tasks);
            return self.local_attachment_observe(&store, &operation);
        }
        ensure!(
            tasks
                .workers
                .values()
                .filter(|value| value.running.load(Ordering::Acquire))
                .count()
                < kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY,
            "history_branch_worker_capacity_reached"
        );
        if tasks.workers.len() >= 32 {
            tasks
                .workers
                .retain(|_, value| value.running.load(Ordering::Acquire));
        }
        let worker = Arc::new(Worker::default());
        worker.running.store(true, Ordering::Release);
        tasks.workers.insert(key, worker.clone());
        let token = self.cancellation.clone();
        let profile = profile.to_path_buf();
        tasks.tasks.spawn_blocking(move || {
            let guard = Guard(worker);
            let result = if finish {
                store
                    .finish(&operation, sequence, |_| !token.is_cancelled())
                    .map(|_| ())
            } else {
                (|| -> Result<()> {
                    let local = HistoryLocalAttachments::open_existing(&profile)?
                        .ok_or_else(|| anyhow::anyhow!("local_attachment_job_not_found"))?;
                    local.run(&operation, sequence, |_| !token.is_cancelled())?;
                    Ok(())
                })()
            };
            *guard
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = result
                .err()
                .map(|error| super::super::super::safe_error(&error));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationLocalAttachmentStateResult {
            worker_running: true,
            worker_error: None,
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
    if operation == method::MIGRATION_LOCAL_ATTACHMENT_PREPARE {
        let params: MigrationLocalAttachmentPrepareParams = decode(params)?;
        let store = HistoryLocalAttachmentUploads::open(profile)?;
        store.prepare(&params.request_id, &params.selection, |_| {
            !processor.branches.cancellation.is_cancelled()
        })?;
        return Ok(serde_json::to_value(
            processor
                .branches
                .local_attachment_observe(&store, &params.request_id)?,
        )?);
    }
    if operation == method::MIGRATION_LOCAL_ATTACHMENT_LIST {
        let params: MigrationLocalAttachmentListParams = decode(params)?;
        let page = match HistoryLocalAttachmentUploads::open_existing(profile)? {
            Some(store) => store.list(&params.selection, params.cursor.as_deref())?,
            None => HistoricalLocalAttachmentUploadPage {
                items: Vec::new(),
                next_cursor: None,
            },
        };
        return Ok(serde_json::to_value(MigrationLocalAttachmentListResult {
            items: page.items,
            next_cursor: page.next_cursor,
        })?);
    }
    if matches!(
        operation,
        method::MIGRATION_LOCAL_ATTACHMENT_FINISH | method::MIGRATION_LOCAL_ATTACHMENT_RUN
    ) {
        let params: MigrationLocalAttachmentRunParams = decode(params)?;
        return Ok(serde_json::to_value(
            processor.branches.local_attachment_start(
                profile,
                params.operation_id,
                params.expected_sequence,
                operation == method::MIGRATION_LOCAL_ATTACHMENT_FINISH,
            )?,
        )?);
    }
    let store = HistoryLocalAttachmentUploads::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("local_attachment_upload_not_found"))?;
    let id = match operation {
        method::MIGRATION_LOCAL_ATTACHMENT_BEGIN => {
            let params: MigrationLocalAttachmentBeginParams = decode(params)?;
            store.begin(
                &params.operation_id,
                params.expected_sequence,
                &params.filename,
                params.bytes,
                &params.sha256,
            )?;
            params.operation_id
        }
        method::MIGRATION_LOCAL_ATTACHMENT_PART => {
            let params: MigrationLocalAttachmentPartParams = decode(params)?;
            ensure!(
                params.content_base64.len() <= HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize / 3 * 4,
                "local_attachment_upload_part_budget_exceeded"
            );
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&params.content_base64)
                .map_err(|_| anyhow::anyhow!("local_attachment_upload_invalid_part"))?;
            store.part(
                &params.operation_id,
                params.expected_sequence,
                params.index,
                &bytes,
            )?;
            params.operation_id
        }
        method::MIGRATION_LOCAL_ATTACHMENT_RESUME => {
            let params: MigrationLocalAttachmentRunParams = decode(params)?;
            store.resume(&params.operation_id, params.expected_sequence)?;
            params.operation_id
        }
        method::MIGRATION_LOCAL_ATTACHMENT_CANCEL => {
            let params: MigrationLocalAttachmentReadParams = decode(params)?;
            // The upload coordinator cancels both owned phases exactly once.
            store.cancel(&params.operation_id)?;
            params.operation_id
        }
        method::MIGRATION_LOCAL_ATTACHMENT_READ => {
            decode::<MigrationLocalAttachmentReadParams>(params)?.operation_id
        }
        method::MIGRATION_LOCAL_ATTACHMENT_CHUNK => {
            let params: MigrationLocalAttachmentChunkParams = decode(params)?;
            ensure!(
                params.limit > 0 && params.limit <= 256 * 1024,
                "local_attachment_invalid_chunk"
            );
            let local = HistoryLocalAttachments::open_existing(profile)?
                .ok_or_else(|| anyhow::anyhow!("local_attachment_job_not_found"))?;
            let bytes = local.chunk(
                &params.operation_id,
                &params.selection,
                &params.expected_receipt,
                params.offset,
                params.limit as usize,
            )?;
            let next = params
                .offset
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| anyhow::anyhow!("local_attachment_invalid_chunk"))?;
            return Ok(serde_json::to_value(
                MigrationHistoryAttachmentChunkResult {
                    receipt: params.expected_receipt.clone(),
                    offset: params.offset,
                    next_offset: (next < params.expected_receipt.bytes).then_some(next),
                    data_sha256: format!("{:x}", Sha256::digest(&bytes)),
                    data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                },
            )?);
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.branches.local_attachment_observe(&store, &id)?,
    )?)
}
