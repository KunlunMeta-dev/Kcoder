//! Preparation and selection retain separate controls from immutable uploaded bytes.
use super::*;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_SOURCE_PRODUCT_RUN
            | method::MIGRATION_SOURCE_PRODUCT_READ
            | method::MIGRATION_SOURCE_PRODUCT_CANCEL
            | method::MIGRATION_SOURCE_PRODUCT_RESUME
            | method::MIGRATION_SOURCE_UPLOADED_SELECT
    )
}

impl UploadWorkers {
    fn start_product(
        &self,
        store: &SourceUploads,
        params: MigrationSourceProductRunParams,
    ) -> Result<SourceUploadState> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "source_upload_worker_stopping"
        );
        if let Ok(before) =
            store.read_materialization(&params.operation_id, &params.manifest_sha256)
        {
            if before.stage == SourceUploadStage::Ready {
                return Ok(before);
            }
            ensure!(
                before.worker_state != SourceUploadWorkerState::Unknown,
                "source_upload_execution_unknown"
            );
            if before.worker_state == SourceUploadWorkerState::Running {
                ensure!(
                    before.sequence == params.expected_sequence
                        && before.cancel_watermark == params.cancel_watermark,
                    "source_transfer_revision_conflict"
                );
                return Ok(before);
            }
        }
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("source_upload_worker_unavailable"))?;
        while tasks.try_join_next().is_some() {}
        ensure!(self.activity() < 2, "source_upload_worker_capacity");
        let (accepted, permit) =
            store.prepare_materialization(&params.operation_id, &params.manifest_sha256)?;
        if let Some(permit) = permit {
            // Compare under the execution lease: an earlier read cannot authorize
            // a stale Run across another client's cancel/resume cycle.
            ensure!(
                accepted.sequence == params.expected_sequence
                    && accepted.cancel_watermark == params.cancel_watermark,
                "source_transfer_revision_conflict"
            );
            let cancellation = self.cancellation.clone();
            self.running.fetch_add(1, Ordering::AcqRel);
            let count = Count(self.running.clone());
            tasks.spawn_blocking(move || {
                let _count = count;
                if permit.run(|_, _| !cancellation.is_cancelled()).is_err() {
                    tracing::debug!(
                        "Migration uploaded product preparation stopped without completion"
                    );
                }
            });
        }
        Ok(accepted)
    }
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = SourceUploads::open_existing(profile)?;
    if operation == method::MIGRATION_SOURCE_UPLOADED_SELECT {
        return select(processor, &store, decode(params)?);
    }
    let materialization = match operation {
        method::MIGRATION_SOURCE_PRODUCT_RUN => processor
            .source_upload_workers
            .start_product(&store, decode(params)?)?,
        method::MIGRATION_SOURCE_PRODUCT_READ => {
            let params: MigrationSourceProductParams = decode(params)?;
            store.read_materialization(&params.operation_id, &params.manifest_sha256)?
        }
        method::MIGRATION_SOURCE_PRODUCT_CANCEL => {
            let params: MigrationSourceProductCancelParams = decode(params)?;
            store.cancel_materialization(
                &params.operation_id,
                &params.manifest_sha256,
                &params.command_id,
            )?
        }
        method::MIGRATION_SOURCE_PRODUCT_RESUME => {
            let params: MigrationSourceProductRunParams = decode(params)?;
            store.resume_materialization(
                &params.operation_id,
                &params.manifest_sha256,
                params.expected_sequence,
                params.cancel_watermark,
            )?
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    };
    Ok(serde_json::to_value(MigrationSourceProductStateResult {
        materialization,
    })?)
}

fn select(
    processor: &MigrationProcessor,
    store: &SourceUploads,
    params: MigrationSourceProductParams,
) -> Result<Value> {
    let mut registry = processor
        .registry
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    ensure!(
        processor
            .directory_choice
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?
            .is_none(),
        "source_upload_product_selection_conflict"
    );
    let mut choice = processor
        .uploaded_choice
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    if let Some(original) = choice.as_ref() {
        ensure!(
            original == &params,
            "source_upload_product_selection_conflict"
        );
    } else {
        ensure!(registry.is_none(), "source_upload_product_selection_in_use");
        // A failed explicit choice also blocks later discovery of unrelated homes.
        *choice = Some(params.clone());
    }
    if registry.is_none() {
        *registry = Some(store.product_registry(&params.operation_id, &params.manifest_sha256)?);
    }
    let registry = registry
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("source_upload_product_not_ready"))?;
    ensure!(
        registry.uploaded_operation_id() == Some(params.operation_id.as_str()),
        "source_upload_product_selection_conflict"
    );
    let remaining_ms = registry.selected_product_directory_remaining_ms()?;
    Ok(serde_json::to_value(MigrationSourceProductSelectResult {
        operation_id: params.operation_id.clone(),
        manifest_sha256: params.manifest_sha256,
        source: store.manifest(&params.operation_id)?.source,
        remaining_ms,
        origin: MigrationSourceProductOrigin::UserSupplied,
    })?)
}

#[cfg(test)]
mod tests;
