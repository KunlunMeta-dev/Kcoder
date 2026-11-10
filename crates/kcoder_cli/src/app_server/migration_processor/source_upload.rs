//! A connection owns verification work; accepted bytes and receipts belong to its profile.
use super::*;
use base64::Engine;
use kcoder_migration::source_upload::{SOURCE_UPLOAD_PART_BYTES, SourceUploads};
use kcoder_types::migration_source_upload::{
    SourceUploadStage, SourceUploadState, SourceUploadWorkerState,
};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicUsize},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
mod product;

pub(super) fn handles(operation: &str) -> bool {
    product::handles(operation)
        || matches!(
            operation,
            method::MIGRATION_SOURCE_UPLOAD_PREPARE
                | method::MIGRATION_SOURCE_UPLOAD_PART
                | method::MIGRATION_SOURCE_UPLOAD_FINISH
                | method::MIGRATION_SOURCE_UPLOAD_READ
                | method::MIGRATION_SOURCE_UPLOAD_FILES
                | method::MIGRATION_SOURCE_UPLOAD_CANCEL
                | method::MIGRATION_SOURCE_UPLOAD_RESUME
        )
}

pub(super) struct UploadWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<JoinSet<()>>,
    running: Arc<AtomicUsize>,
}
struct Count(Arc<AtomicUsize>);
impl Drop for Count {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl UploadWorkers {
    pub(super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            tasks: Mutex::new(JoinSet::new()),
            running: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub(super) fn activity(&self) -> usize {
        self.running.load(Ordering::Acquire)
    }
    fn start(
        &self,
        store: &SourceUploads,
        params: MigrationSourceUploadRunParams,
    ) -> Result<SourceUploadState> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "source_upload_worker_stopping"
        );
        let before = store.read(&params.operation_id)?;
        if before.stage == SourceUploadStage::Ready
            || before.worker_state == SourceUploadWorkerState::Running
        {
            return Ok(before);
        }
        ensure!(
            before.worker_state == SourceUploadWorkerState::Stopped,
            "source_upload_execution_unknown"
        );
        ensure!(
            before.sequence == params.expected_sequence,
            "source_transfer_revision_conflict"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("source_upload_worker_unavailable"))?;
        while tasks.try_join_next().is_some() {}
        ensure!(self.activity() < 2, "source_upload_worker_capacity");
        let permit = store.prepare_verification(&params.operation_id, params.cancel_watermark)?;
        let accepted = store.read(&params.operation_id)?;
        ensure!(
            accepted.sequence == params.expected_sequence,
            "source_transfer_revision_conflict"
        );
        let cancellation = self.cancellation.clone();
        self.running.fetch_add(1, Ordering::AcqRel);
        let count = Count(self.running.clone());
        tasks.spawn_blocking(move || {
            let _count = count;
            if permit.run(|_, _| !cancellation.is_cancelled()).is_err() {
                // The private journal retains progress and a bounded failure code.
                tracing::debug!("Migration source upload verification stopped without completion");
            }
        });
        Ok(accepted)
    }
    pub(super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *tasks)
        };
        while tasks.join_next().await.is_some() {}
    }
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    ensure!(
        !processor.cancellation().is_cancelled(),
        "source_upload_worker_stopping"
    );
    if product::handles(operation) {
        return product::execute(processor, profile, operation, params);
    }
    if operation == method::MIGRATION_SOURCE_UPLOAD_PREPARE {
        let params: MigrationSourceUploadPrepareParams = decode(params)?;
        let upload =
            SourceUploads::open(profile)?.prepare(&params.operation_id, params.manifest)?;
        return Ok(serde_json::to_value(MigrationSourceUploadStateResult {
            upload,
        })?);
    }
    let store = SourceUploads::open_existing(profile)?;
    if operation == method::MIGRATION_SOURCE_UPLOAD_FILES {
        let params: MigrationSourceUploadFilesParams = decode(params)?;
        let page = store.files(&params.operation_id, params.cursor)?;
        return Ok(serde_json::to_value(MigrationSourceUploadFilesResult {
            page,
        })?);
    }
    let upload = match operation {
        method::MIGRATION_SOURCE_UPLOAD_PART => {
            let params: MigrationSourceUploadPartParams = decode(params)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&params.content_base64)
                .map_err(|_| anyhow::anyhow!("source_upload_invalid_part"))?;
            ensure!(
                bytes.len() <= SOURCE_UPLOAD_PART_BYTES,
                "source_upload_invalid_part"
            );
            store.part(
                &params.operation_id,
                params.cancel_watermark,
                params.file_index as usize,
                params.part_index,
                &bytes,
            )?
        }
        method::MIGRATION_SOURCE_UPLOAD_FINISH => processor
            .source_upload_workers
            .start(&store, decode(params)?)?,
        method::MIGRATION_SOURCE_UPLOAD_READ => {
            let params: MigrationSourceUploadReadParams = decode(params)?;
            store.read(&params.operation_id)?
        }
        method::MIGRATION_SOURCE_UPLOAD_CANCEL => {
            let params: MigrationSourceUploadCancelParams = decode(params)?;
            store.cancel(&params.operation_id, &params.command_id)?
        }
        method::MIGRATION_SOURCE_UPLOAD_RESUME => {
            let params: MigrationSourceUploadRunParams = decode(params)?;
            store.resume(
                &params.operation_id,
                params.expected_sequence,
                params.cancel_watermark,
            )?
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(MigrationSourceUploadStateResult {
        upload,
    })?)
}

#[cfg(test)]
mod tests;
