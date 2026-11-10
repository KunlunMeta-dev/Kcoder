//! Source resolution is lazy and never replayed after a completed private capture.
use super::{
    BatchCreateIntent, BatchCreationObservation, BatchCreationStage as Stage, files::CreationFiles,
    validate_prepared,
};
use crate::{batch::BatchSource, source_transfer::ReceivedProjectTarget, store::MigrationStore};
use anyhow::{Result, ensure};
use kcoder_config::{FolderTrust, FolderTrustStore};
use kcoder_types::migration_resource::MigrationResourceLimits;

/// Supplied only after the caller's validated public selection is fixed in its
/// BatchCreateIntent. The callback supplies Native grants, not new public intent.
pub struct BatchCaptureInput {
    pub sources: Vec<BatchSource>,
    pub resource_limits: MigrationResourceLimits,
    pub project: Option<ReceivedProjectTarget>,
}

impl MigrationStore {
    pub fn create_batch_scan_idempotent(
        &self,
        intent: &BatchCreateIntent,
        resolve: impl FnOnce(&mut dyn FnMut(u64) -> bool) -> Result<BatchCaptureInput>,
        progress: &mut impl FnMut(Stage, u64) -> bool,
    ) -> Result<BatchCreationObservation> {
        let (files, worker) = {
            let _catalog = self.write_lock()?;
            if let Some(existing) =
                CreationFiles::lookup(&self.directory, &self.profile, intent.request_id())?
            {
                existing.require_intent(intent)?;
                drop(_catalog);
                return self.creation_observation(&existing);
            }
            CreationFiles::create(&self.directory, &self.profile, intent)?
        };
        let outcome = self.capture_batch_creation(&files, resolve, progress);
        drop(worker);
        outcome?;
        self.creation_observation(&files)
    }

    /// An explicit resume receipt is required even after a process disappeared.
    /// A complete prepared capture finishes without invoking the resolver.
    pub fn continue_batch_creation(
        &self,
        intent: &BatchCreateIntent,
        expected_revision: u64,
        resolve: impl FnOnce(&mut dyn FnMut(u64) -> bool) -> Result<BatchCaptureInput>,
        progress: &mut impl FnMut(Stage, u64) -> bool,
    ) -> Result<BatchCreationObservation> {
        let files = CreationFiles::lookup(&self.directory, &self.profile, intent.request_id())?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
        files.require_intent(intent)?;
        if files.publication_started()? {
            return self.creation_observation(&files);
        }
        let worker = files.claim()?;
        {
            let _control = files.control_lease()?;
            let control = files.control()?;
            ensure!(
                control.revision == expected_revision,
                "migration_revision_conflict"
            );
            ensure!(
                !control.cancel_requested
                    && control.receipts.last().is_some_and(
                        |receipt| receipt.action == super::model::ControlAction::Resume
                    ),
                "migration_batch_creation_resume_required"
            );
        }
        let outcome = self.capture_batch_creation(&files, resolve, progress);
        drop(worker);
        outcome?;
        self.creation_observation(&files)
    }

    fn capture_batch_creation(
        &self,
        files: &CreationFiles,
        resolve: impl FnOnce(&mut dyn FnMut(u64) -> bool) -> Result<BatchCaptureInput>,
        progress: &mut impl FnMut(Stage, u64) -> bool,
    ) -> Result<()> {
        let mut failure = None;
        let mut cancelled = false;
        let prepared = files.prepared::<crate::store::MigrationJob>()?;
        if let Some(job) = &prepared {
            validate_prepared(files, job)?;
        }
        if prepared.is_none() {
            let capture = {
                let mut check = |units| match files.control() {
                    Ok(control) if !control.cancel_requested => {
                        let keep = progress(Stage::Capturing, units);
                        cancelled |= !keep;
                        keep
                    }
                    Ok(_) => {
                        cancelled = true;
                        false
                    }
                    Err(error) => {
                        failure = Some(error);
                        false
                    }
                };
                (|| -> Result<()> {
                    ensure!(check(0), "migration_cancelled");
                    let input = resolve(&mut check)?;
                    if let Some(project) = &input.project {
                        project.verify(&self.profile)?;
                        ensure!(
                            FolderTrustStore::load(&self.profile).check(project.root())
                                == FolderTrust::Trusted,
                            "migration_project_target_untrusted"
                        );
                    }
                    let mut job = self.freeze_batch_scan_with_resource_limits(
                        &files.birth.job_id,
                        &format!("src-{}", uuid::Uuid::new_v4().simple()),
                        input.sources,
                        input.resource_limits,
                        &mut check,
                    )?;
                    let batch = job
                        .batch
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
                    batch.local_project = input.project;
                    batch.creation = Some(Box::new(files.binding()));
                    validate_prepared(files, &job)?;
                    files.prepare(&job, || check(job.inventory.items.len() as u64))
                })()
            };
            if let Some(error) = failure {
                return Err(error);
            }
            if cancelled {
                super::control::acknowledge_cancel(files)?;
                anyhow::bail!("migration_cancelled");
            }
            capture?;
        }
        if !progress(Stage::Prepared, 0) {
            super::control::acknowledge_cancel(files)?;
            anyhow::bail!("migration_cancelled");
        }
        {
            // The control lease stays held across first publication, so a
            // concurrent cancellation cannot be acknowledged then published over.
            let _control = files.control_lease()?;
            ensure!(!files.control()?.cancel_requested, "migration_cancelled");
            let _catalog = self.write_lock()?;
            files.verify(&self.directory, &self.profile, &files.birth.request_id)?;
            files.publish(&self.directory)?;
        }
        // An observer declining after publication cannot undo that durable fact.
        progress(Stage::Published, 0);
        Ok(())
    }
}
