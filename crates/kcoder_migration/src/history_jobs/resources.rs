//! Target-owned resource births preserve their original group and initial policy.
use super::*;
use kcoder_types::migration_resource::MigrationResourceLimits;

impl HistoryJobStore {
    pub(crate) fn resource_budget_store(&self) -> &ExternalHistoryStore {
        &self.archives
    }
    pub(crate) fn prepare_batch_resource_budget(
        &self,
        parent: &str,
        members: Vec<String>,
        limits: MigrationResourceLimits,
        upgrade: bool,
    ) -> Result<()> {
        if upgrade {
            self.archives
                .adopt_existing_resource_budget(parent, members, limits)?;
        } else {
            self.archives
                .prepare_resource_budget(parent, members, limits)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod attachment_birth_tests;
mod attachment_parent;
mod attachment_read;
mod attachment_view;
pub use attachment_view::{
    ResourceAttachmentIntent, ResourceAttachmentObservation, ResourceAttachmentPhase,
};
mod birth;
mod legacy;
mod observation;
mod parent;
pub(super) use birth::{HistoryBudgetStorage, HistoryResourceBinding};

impl Job {
    pub(super) fn managed(&self) -> bool {
        self.version == 3
            || self.version == 4
                && self
                    .resource_budget
                    .as_ref()
                    .is_some_and(|binding| binding.storage == HistoryBudgetStorage::Managed)
    }
    fn resource_source_identity(&self) -> Result<String> {
        match &self.selection {
            Some(selection) => selection.selection_identity(),
            None => Ok(self.binding_sha256.clone()),
        }
    }
}
impl HistoryJobStore {
    pub(crate) fn verify_batch_budget_member(
        &self,
        child: &str,
        selection: &HistoryPendingSelection,
        revision: &str,
        parent: &str,
        reference: &kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetReference,
    ) -> Result<()> {
        self.verify_selected_snapshot(child, selection)?;
        let job = self.load(child)?;
        ensure!(
            job.normalization_revision == revision,
            "history_resource_binding_changed"
        );
        if let Some(binding) = &job.resource_budget {
            ensure!(
                binding.owner == parent
                    && binding.member == child
                    && binding.reference == *reference,
                "history_resource_binding_changed"
            );
            self.verify_standalone_resource_budget(
                child,
                &job.resource_source_identity()?,
                binding,
            )?;
        } else {
            ensure!(
                !self.has_resource_birth(child)?,
                "history_resource_preparation_unknown"
            );
        }
        Ok(())
    }

    pub(crate) fn recorded_batch_resource_budget(
        &self,
        owner: &str,
        mut members: Vec<String>,
    ) -> Result<
        Option<kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetRecipe>,
    > {
        let Some(reference) = self.archives.recorded_resource_budget(owner)? else {
            return Ok(None);
        };
        members.sort();
        let first = members
            .first()
            .context("history_resource_invalid_members")?;
        let recipe = self
            .archives
            .recorded_member_resource_budget(first)?
            .context("history_resource_binding_changed")?;
        ensure!(
            recipe.reference == reference && recipe.owner == owner && recipe.members == members,
            "history_resource_binding_changed"
        );
        Ok(Some(recipe))
    }

    pub(super) fn original_resource_parent(
        &self,
        job: &Job,
    ) -> Result<Option<crate::store::HistoryResourceParent>> {
        crate::store::MigrationStore::history_resource_parent(
            &self.profile,
            &self.migration_identity,
            &job.view.job_id,
            job.selection.as_ref(),
            &job.normalization_revision,
        )
    }

    pub(super) fn require_resource_budget_for_write(&self, job: &Job) -> Result<()> {
        ensure!(job.version == 4, "history_resource_upgrade_required");
        let binding = job
            .resource_budget
            .as_ref()
            .context("history_resource_birth_unknown")?;
        self.verify_standalone_resource_budget(
            &job.view.job_id,
            &job.resource_source_identity()?,
            binding,
        )?;
        if let Some(source) = &job.binding {
            let same_physical_budget = self
                .archives
                .recorded_archive_resource_budget(&job.view.job_id)?
                .is_some_and(|original| original.reference == binding.reference);
            if binding.storage == HistoryBudgetStorage::Legacy
                || (job.archive_stage_completed && same_physical_budget)
            {
                let reservation = self.archives.reserve_archive_snapshot_resource(
                    &binding.reference,
                    &binding.member,
                    source.snapshot(),
                )?;
                if job.archive_stage_completed {
                    let reader = self.reader_for_job(job)?;
                    let receipt = reader.receipt()?.context("history_job_archive_missing")?;
                    ensure!(
                        receipt.source_sha256 == source.snapshot().source_sha256
                            && receipt.source_bytes == source.snapshot().source_bytes,
                        "history_job_archive_changed"
                    );
                    self.archives
                        .settle_archive_snapshot_resource(&reservation, &receipt)?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn bind_reader_budget(
        &self,
        job: &Job,
        reader: kcoder_state::external_history::ExternalHistoryReader,
    ) -> Result<kcoder_state::external_history::ExternalHistoryReader> {
        let reader = reader.require_resource_budget();
        match &job.resource_budget {
            Some(binding) => self.archives.bind_reader_resource_budget(
                reader,
                &binding.reference,
                &binding.member,
            ),
            None => match self.known_legacy_resource_budget(job)? {
                Some(recipe) => self.archives.bind_reader_resource_budget(
                    reader,
                    &recipe.reference,
                    &recipe.member,
                ),
                None => Ok(reader),
            },
        }
    }

    pub(super) fn reader_for_job(
        &self,
        job: &Job,
    ) -> Result<kcoder_state::external_history::ExternalHistoryReader> {
        let reader = self.archives.reader(
            job.view
                .archive_id
                .as_deref()
                .context("history_job_binding_missing")?,
        )?;
        self.bind_reader_budget(job, reader)
    }

    pub(crate) fn bind_existing_resource_budget_owned(
        &self,
        execution: &HistoryExecutionGuard,
    ) -> Result<()> {
        self.validate_execution(execution)?;
        let _run = self.execution_run_lock(execution)?;
        let mut job = self.load(execution.job_id())?;
        self.upgrade_job_resource_budget(&mut job)?;
        self.require_resource_budget_for_write(&job)
    }
}
