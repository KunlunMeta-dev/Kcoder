//! Ordinary batches retain one original creation intent and recoverable capture.
mod checkpoint;
mod control;
mod files;
mod intent;
mod model;
mod observation;
#[cfg(test)]
mod tests;
mod worker;

pub use intent::BatchCreateIntent;
pub use model::BatchCreationBinding;
pub use observation::{BatchCreationObservation, BatchCreationStage, BatchCreationWorkerState};
pub use worker::BatchCaptureInput;

use super::super::{MigrationJob, MigrationStore};
use anyhow::{Result, ensure};
use files::CreationFiles;
use observation::{BatchCreationStage as Stage, BatchCreationWorkerState as Worker};

impl MigrationStore {
    /// This lookup must precede all live registry/source resolution by the Host.
    pub fn lookup_batch_creation(
        &self,
        intent: &BatchCreateIntent,
    ) -> Result<Option<BatchCreationObservation>> {
        let Some(files) =
            CreationFiles::lookup(&self.directory, &self.profile, intent.request_id())?
        else {
            return Ok(None);
        };
        files.require_intent(intent)?;
        self.creation_observation(&files).map(Some)
    }

    pub fn read_batch_creation(&self, request_id: &str) -> Result<BatchCreationObservation> {
        let files = CreationFiles::lookup(&self.directory, &self.profile, request_id)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
        self.creation_observation(&files)
    }

    /// Recover the original opaque intent only after verifying its durable owner and state.
    /// This does not grant new source access or replace the original parameters.
    pub fn batch_creation_intent(&self, request_id: &str) -> Result<BatchCreateIntent> {
        let files = CreationFiles::lookup(&self.directory, &self.profile, request_id)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
        let observation = self.creation_observation(&files)?;
        ensure!(
            matches!(observation.stage, Stage::Prepared | Stage::Published),
            "migration_batch_creation_original_source_required"
        );
        BatchCreateIntent::from_original(&files.birth.request_id, &files.birth.intent_sha256)
    }

    fn creation_observation(&self, files: &CreationFiles) -> Result<BatchCreationObservation> {
        let (stage, job) = if files.publication_started()? {
            let job = self.read(&files.birth.job_id)?;
            ensure!(
                job.batch
                    .as_ref()
                    .and_then(|batch| batch.creation.as_deref())
                    == Some(&files.binding()),
                "migration_batch_creation_unknown"
            );
            if job.sequence == 1 {
                files.verify_first_publication(&self.directory)?;
            }
            (Stage::Published, Some(job))
        } else {
            // An existing unsealed journal is never an original publication receipt.
            ensure!(
                files::read_bytes(
                    &self.directory,
                    &format!("{}.json", files.birth.job_id),
                    checkpoint::MAX_JOB_BYTES as u64
                )?
                .is_none(),
                "migration_batch_creation_unknown"
            );
            if let Some(job) = files.prepared::<MigrationJob>()? {
                validate_prepared(files, &job)?;
                (Stage::Prepared, None)
            } else {
                (Stage::Capturing, None)
            }
        };
        let control = files.control()?;
        Ok(BatchCreationObservation {
            request_id: files.birth.request_id.clone(),
            job_id: files.birth.job_id.clone(),
            stage,
            worker_state: if files.running()? {
                Worker::Running
            } else {
                Worker::Stopped
            },
            control_revision: Some(control.revision),
            cancel_requested: Some(control.cancel_requested),
            job,
        })
    }
}

fn validate_prepared(files: &CreationFiles, job: &MigrationJob) -> Result<()> {
    ensure!(
        job.schema_version == 1
            && job.job_id == files.birth.job_id
            && job.sequence == 1
            && job.status == kcoder_types::migration::MigrationJobStatus::Ready
            && job.selected_item_ids.is_empty()
            && job.receipts.is_empty()
            && job.provider_plans.is_empty()
            && job.mcp_plans.is_empty()
            && job.asset_plans.is_empty()
            && job.credential_plans.is_empty()
            && job.mcp_credential_plans.is_empty(),
        "migration_batch_creation_unknown"
    );
    super::super::validate_inventory(&job.inventory)?;
    let batch = job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
    batch.validate()?;
    ensure!(
        batch.creation.as_deref() == Some(&files.binding())
            && batch.received.is_none()
            && batch.actions.is_empty()
            && batch.plan_id.is_none()
            && batch.request_kinds.is_empty()
            && batch.credential_plan_ids.is_empty(),
        "migration_batch_creation_unknown"
    );
    Ok(())
}

/// Ordinary job-ID routes retain the same original birth authority as request-ID lookup.
pub(in crate::store) fn verify_created_job(
    store: &MigrationStore,
    job: &MigrationJob,
) -> Result<()> {
    let Some(binding) = job
        .batch
        .as_ref()
        .and_then(|batch| batch.creation.as_deref())
    else {
        return Ok(());
    };
    let files = CreationFiles::lookup(&store.directory, &store.profile, &binding.request_id)?
        .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
    ensure!(
        files.birth.job_id == job.job_id
            && files.binding() == *binding
            && files.publication_started()?
            && !files.control()?.cancel_requested,
        "migration_batch_creation_unknown"
    );
    if job.sequence == 1 {
        files.verify_first_publication(&store.directory)?;
    }
    Ok(())
}
