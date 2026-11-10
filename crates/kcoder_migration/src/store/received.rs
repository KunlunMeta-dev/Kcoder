//! A received intent publishes a preallocated scan once; ordinary batch confirmation is unchanged.
use super::*;
use crate::batch::{BatchSource, ReceivedBatchBinding};
use anyhow::Context;

impl MigrationStore {
    pub(crate) fn freeze_received_batch(
        &self,
        job_id: &str,
        inputs: Vec<BatchSource>,
        binding: ReceivedBatchBinding,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<MigrationJob> {
        let source_id = format!("src-adoption-{}-{}", binding.adoption_id, binding.group);
        let mut job = self.freeze_batch_scan(job_id, &source_id, inputs, check)?;
        if binding.project.is_some() {
            for item in &mut job.inventory.items {
                if item.template.is_some() {
                    item.preview.issues.push(crate::adapters::issue(
                        kcoder_types::migration::MigrationIssueCode::RequiresReview,
                        kcoder_types::migration::MigrationIssueSeverity::Blocking,
                        "project_template_unsupported",
                    ));
                    item.preview.status = ItemStatus::RequiresAction;
                    item.preview.selected_by_default = false;
                }
            }
        }
        job.batch
            .as_mut()
            .context("migration_not_a_batch")?
            .received = Some(Box::new(binding));
        Ok(job)
    }
    pub(crate) fn verify_received_batch(
        &self,
        job_id: &str,
        binding: &ReceivedBatchBinding,
    ) -> Result<MigrationJob> {
        let job = self.read(job_id)?;
        ensure!(
            job.batch
                .as_ref()
                .and_then(|batch| batch.received.as_deref())
                == Some(binding),
            "source_transfer_adoption_job_changed"
        );
        Ok(job)
    }
    pub(crate) fn publish_received_batch(
        &self,
        job: &MigrationJob,
        verify: impl FnOnce() -> Result<()>,
        observe: impl FnOnce(&std::fs::File) -> Result<()>,
    ) -> Result<()> {
        let _lock = self.write_lock()?;
        validate_inventory(&job.inventory)?;
        ensure!(
            job.sequence == 1
                && job.status == JobStatus::Ready
                && job
                    .batch
                    .as_ref()
                    .is_some_and(|batch| batch.received.is_some()),
            "source_transfer_adoption_job_changed"
        );
        let bytes = serde_json::to_vec(job)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOURNAL_BYTES,
            "migration_journal_budget_exceeded"
        );
        self.directory.atomic_publish_observed_from_reader(
            OsStr::new(&job_file(&job.job_id)?),
            &mut std::io::Cursor::new(bytes),
            false,
            || {
                verify()?;
                Ok(None)
            },
            observe,
        )?;
        Ok(())
    }
}
