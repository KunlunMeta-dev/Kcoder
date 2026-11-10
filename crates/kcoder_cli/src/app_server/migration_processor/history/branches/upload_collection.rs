//! Connection-owned bounded workers for explicitly confirmed upload staging collection.
use super::*;
use kcoder_migration::local_attachment::upload::{
    HistoryLocalAttachmentUploads,
    collection::{UploadCollectionStage, UploadCollectionView},
};
use kcoder_types::historical_attachment::HistoricalAttachmentSelection;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_UPLOAD_COLLECTION_PREPARE
            | method::MIGRATION_UPLOAD_COLLECTION_READ
            | method::MIGRATION_UPLOAD_COLLECTION_ATTACHMENT
            | method::MIGRATION_UPLOAD_COLLECTION_LIST
            | method::MIGRATION_UPLOAD_COLLECTION_RUN
            | method::MIGRATION_UPLOAD_COLLECTION_CANCEL
            | method::MIGRATION_UPLOAD_COLLECTION_RESUME
    )
}

fn project(value: UploadCollectionView) -> MigrationUploadCollection {
    MigrationUploadCollection {
        operation_id: value.operation_id,
        selection: value.selection,
        collection_id: value.collection_id,
        sequence: value.sequence,
        upload_sequence: value.upload_sequence,
        stage: match value.stage {
            UploadCollectionStage::Prepared => MigrationUploadCollectionStage::Prepared,
            UploadCollectionStage::Blocked => MigrationUploadCollectionStage::Blocked,
            UploadCollectionStage::Collecting => MigrationUploadCollectionStage::Collecting,
            UploadCollectionStage::Collected => MigrationUploadCollectionStage::Collected,
            UploadCollectionStage::Cancelled => MigrationUploadCollectionStage::Cancelled,
            UploadCollectionStage::OutcomeUnknown => MigrationUploadCollectionStage::OutcomeUnknown,
        },
        cancel_requested: value.cancel_requested,
        cancel_revision: value.cancel_revision,
        storage_retired: value.storage_retired,
        deleted_bytes: value.deleted_bytes,
        released_reservation_bytes: value.released_reservation_bytes,
        failure_code: value.failure_code,
    }
}

fn source(
    store: &HistoryLocalAttachmentUploads,
    id: &str,
    selection: &HistoricalAttachmentSelection,
) -> Result<()> {
    let original = match store.read_collection(id)? {
        Some(value) => value.selection,
        None => store.read(id)?.selection,
    };
    ensure!(
        original == *selection,
        "local_upload_collection_selection_changed"
    );
    Ok(())
}

impl BranchWorkers {
    fn collection_observe(
        &self,
        store: &HistoryLocalAttachmentUploads,
        id: &str,
    ) -> Result<MigrationUploadCollectionStateResult> {
        // Native missing/replaced/busy-control errors remain errors. A local map
        // cannot turn an unknown cross-process lock observation into idle=false.
        let value = store.read_collection(id)?;
        let worker_running = value.as_ref().is_some_and(|value| value.worker_running);
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        let worker = tasks.workers.get(&format!("upload-collection:{id}"));
        let worker_scheduled = worker.is_some_and(|value| value.running.load(Ordering::Acquire));
        let collected = value
            .as_ref()
            .is_some_and(|value| value.stage == UploadCollectionStage::Collected);
        Ok(MigrationUploadCollectionStateResult {
            collection: value.map(project),
            worker_running,
            worker_scheduled,
            worker_error: if collected {
                None
            } else {
                worker.and_then(|value| {
                    value
                        .error
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone()
                })
            },
        })
    }

    fn collection_start(
        &self,
        store: HistoryLocalAttachmentUploads,
        params: MigrationUploadCollectionRunParams,
    ) -> Result<MigrationUploadCollectionStateResult> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "history_branch_worker_stopping"
        );
        source(&store, &params.operation_id, &params.selection)?;
        let before = self.collection_observe(&store, &params.operation_id)?;
        if before.worker_running || before.worker_scheduled {
            return Ok(before);
        }
        let value = before
            .collection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("local_upload_collection_not_prepared"))?;
        ensure!(
            value.collection_id == params.collection_id
                && value.sequence == params.expected_sequence,
            "local_upload_collection_stale_sequence"
        );
        if value.stage == MigrationUploadCollectionStage::Collected {
            return Ok(before);
        }
        ensure!(
            !value.cancel_requested
                && matches!(
                    value.stage,
                    MigrationUploadCollectionStage::Prepared
                        | MigrationUploadCollectionStage::Collecting
                ),
            "local_upload_collection_resume_required"
        );
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("history_branch_worker_unavailable"))?;
        while let Some(result) = tasks.tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Upload collection worker exited unexpectedly");
            }
        }
        let key = format!("upload-collection:{}", params.operation_id);
        if tasks
            .workers
            .get(&key)
            .is_some_and(|worker| worker.running.load(Ordering::Acquire))
        {
            return Ok(MigrationUploadCollectionStateResult {
                worker_scheduled: true,
                ..before
            });
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
        tasks.tasks.spawn_blocking(move || {
            let guard = Guard(worker);
            let result = store.run_collection(
                &params.operation_id,
                &params.collection_id,
                params.expected_sequence,
                |_| !token.is_cancelled(),
            );
            *guard
                .0
                .error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = result
                .err()
                .map(|error| super::super::super::safe_error(&error));
            guard.0.running.store(false, Ordering::Release);
        });
        Ok(MigrationUploadCollectionStateResult {
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
    if operation == method::MIGRATION_UPLOAD_COLLECTION_LIST {
        let params: MigrationUploadCollectionListParams = decode(params)?;
        let Some(store) = HistoryLocalAttachmentUploads::open_existing(profile)? else {
            return Ok(serde_json::to_value(MigrationUploadCollectionListResult {
                items: Vec::new(),
                next_cursor: None,
            })?);
        };
        let page = store.list_collections(&params.selection, params.cursor.as_deref())?;
        let items = page
            .items
            .into_iter()
            .map(|item| {
                processor
                    .branches
                    .collection_observe(&store, &item.operation_id)
            })
            .collect::<Result<Vec<_>>>()?;
        return Ok(serde_json::to_value(MigrationUploadCollectionListResult {
            items,
            next_cursor: page.next_cursor,
        })?);
    }
    let store = HistoryLocalAttachmentUploads::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("local_attachment_upload_not_found"))?;
    let id = match operation {
        method::MIGRATION_UPLOAD_COLLECTION_PREPARE => {
            let params: MigrationUploadCollectionPrepareParams = decode(params)?;
            source(&store, &params.operation_id, &params.selection)?;
            store.prepare_collection(&params.operation_id, params.expected_upload_sequence)?;
            params.operation_id
        }
        method::MIGRATION_UPLOAD_COLLECTION_ATTACHMENT => {
            let params: MigrationUploadCollectionReadParams = decode(params)?;
            source(&store, &params.operation_id, &params.selection)?;
            let collection = store
                .read_collection(&params.operation_id)?
                .ok_or_else(|| anyhow::anyhow!("local_upload_collection_not_prepared"))?;
            ensure!(
                collection.stage == UploadCollectionStage::Collected,
                "local_upload_collection_not_collected"
            );
            let local = kcoder_migration::local_attachment::HistoryLocalAttachments::open_existing(
                profile,
            )?
            .ok_or_else(|| anyhow::anyhow!("local_attachment_job_not_found"))?;
            let job = local.read_with_cancel(&params.operation_id, |_| {
                !processor.branches.cancellation.is_cancelled()
            })?;
            ensure!(
                job.selection == params.selection
                    && job.state.operation_id == params.operation_id
                    && !job.historical_content_verified,
                "local_upload_collection_selection_changed"
            );
            ensure!(
                job.state.stage
                    == kcoder_types::local_attachment::HistoricalLocalAttachmentStage::Ready
                    && job.state.receipt.is_some(),
                "local_attachment_not_ready"
            );
            return Ok(serde_json::to_value(
                MigrationUploadCollectionAttachmentResult { job },
            )?);
        }
        method::MIGRATION_UPLOAD_COLLECTION_READ => {
            let params: MigrationUploadCollectionReadParams = decode(params)?;
            source(&store, &params.operation_id, &params.selection)?;
            params.operation_id
        }
        method::MIGRATION_UPLOAD_COLLECTION_RUN => {
            let params: MigrationUploadCollectionRunParams = decode(params)?;
            return Ok(serde_json::to_value(
                processor.branches.collection_start(store, params)?,
            )?);
        }
        method::MIGRATION_UPLOAD_COLLECTION_CANCEL => {
            let params: MigrationUploadCollectionCancelParams = decode(params)?;
            source(&store, &params.operation_id, &params.selection)?;
            store.cancel_collection(&params.operation_id, &params.collection_id)?;
            params.operation_id
        }
        method::MIGRATION_UPLOAD_COLLECTION_RESUME => {
            let params: MigrationUploadCollectionResumeParams = decode(params)?;
            source(&store, &params.operation_id, &params.selection)?;
            store.resume_collection(
                &params.operation_id,
                &params.collection_id,
                params.expected_sequence,
                params.expected_upload_sequence,
            )?;
            params.operation_id
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(
        processor.branches.collection_observe(&store, &id)?,
    )?)
}
