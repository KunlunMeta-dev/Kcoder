//! Reading or increasing an original quota never starts, resumes or cancels its worker.
use super::super::*;
use kcoder_state::external_history::lifecycle::resource_budget::ResourcePolicyReceipt;
use kcoder_types::migration_resource::{
    MigrationResourceBudgetView, MigrationResourceIncreaseReceipt, MigrationResourceLimits,
    MigrationResourceUsage,
};

fn receipt(job_id: &str, value: ResourcePolicyReceipt) -> MigrationResourceIncreaseReceipt {
    MigrationResourceIncreaseReceipt {
        job_id: job_id.into(),
        request_id: value.request_id,
        previous_revision: value.previous_revision,
        revision: value.revision,
        limits: value.limits.into(),
    }
}

impl HistoryJobStore {
    /// This is a pure observation of the original job and its born accounting group.
    pub fn resource_budget(
        &self,
        job_id: &str,
        request_id: Option<&str>,
    ) -> Result<MigrationResourceBudgetView> {
        if let Some(request) = request_id {
            valid_id(request)?;
        }
        let job = self.load(job_id)?;
        self.resource_budget_for_job(&job, request_id)
    }

    fn resource_budget_for_job(
        &self,
        job: &Job,
        request_id: Option<&str>,
    ) -> Result<MigrationResourceBudgetView> {
        let job_id = &job.view.job_id;
        let recipe = self.budget_recipe_for_job(job)?;
        let Some(recipe) = recipe else {
            return Ok(MigrationResourceBudgetView::LegacyUntracked {
                job_id: job_id.into(),
            });
        };
        ensure!(
            request_id.is_none() || recipe.owner == job_id.as_str(),
            "history_resource_parent_required"
        );
        let snapshot = self
            .archives
            .resource_budget_snapshot(&recipe.reference, request_id)?;
        Ok(MigrationResourceBudgetView::Active {
            job_id: job_id.into(),
            limits: snapshot.policy.limits.into(),
            policy_revision: snapshot.policy.revision,
            usage: MigrationResourceUsage {
                reserved_bytes: snapshot.usage.reserved_bytes,
                committed_bytes: snapshot.usage.committed_bytes,
                reserved_files: snapshot.usage.reserved_files,
                committed_files: snapshot.usage.committed_files,
            },
            requested_receipt: snapshot
                .requested_receipt
                .map(|value| receipt(job_id, value)),
        })
    }

    fn budget_recipe_for_job(
        &self,
        job: &Job,
    ) -> Result<
        Option<kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetRecipe>,
    > {
        let Some(binding) = &job.resource_budget else {
            return self.known_legacy_resource_budget(job);
        };
        self.verify_standalone_resource_budget(
            &job.view.job_id,
            &job.resource_source_identity()?,
            binding,
        )?;
        Ok(Some(
            kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetRecipe {
                reference: binding.reference.clone(),
                owner: binding.owner.clone(),
                members: binding.members.clone(),
                member: binding.member.clone(),
                initial_limits: binding.initial_limits.clone(),
            },
        ))
    }

    fn resource_owner_for_job(&self, job: &Job) -> Result<Option<String>> {
        match &job.resource_budget {
            Some(binding) => Ok(Some(binding.owner.clone())),
            None => Ok(self
                .original_resource_parent(job)?
                .map(|parent| parent.owner)),
        }
    }

    pub fn resource_budget_owner(&self, job_id: &str) -> Result<Option<String>> {
        self.resource_owner_for_job(&self.load(job_id)?)
    }

    pub fn observe_resource_budget(
        &self,
        job_id: &str,
        request_id: Option<&str>,
    ) -> Result<(
        Option<String>,
        Option<MigrationResourceLimits>,
        MigrationResourceBudgetView,
    )> {
        if let Some(request) = request_id {
            valid_id(request)?;
        }
        let job = self.load(job_id)?;
        let recipe = self.budget_recipe_for_job(&job)?;
        let owner = match &recipe {
            Some(recipe) => Some(recipe.owner.clone()),
            None => self.resource_owner_for_job(&job)?,
        };
        Ok((
            owner,
            recipe.map(|recipe| recipe.initial_limits),
            self.resource_budget_for_job(&job, request_id)?,
        ))
    }

    /// Explicit legacy attachment only changes accounting metadata. It never runs a parser,
    /// clears cancellation, changes the original interpretation or promotes legacy GC authority.
    pub fn attach_resource_budget(
        &self,
        job_id: &str,
        expected_sequence: u64,
        limits: MigrationResourceLimits,
        confirm: bool,
    ) -> Result<MigrationResourceBudgetView> {
        ensure!(confirm, "migration_resource_consent_required");
        ensure!(limits.is_supported(), "history_resource_invalid_limits");
        let initial = self.load(job_id)?;
        if let Some(binding) = &initial.resource_budget {
            ensure!(
                binding.upgrade_sequence == Some(expected_sequence)
                    && binding.initial_limits == limits,
                "history_resource_initial_limits_changed"
            );
            return self.resource_budget(job_id, None);
        }
        let execution = self.claim_execution(job_id, expected_sequence)?;
        let _run = self.execution_run_lock(&execution)?;
        let mut job = self.load(job_id)?;
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        self.upgrade_job_resource_budget_with_limits(&mut job, Some(limits))?;
        self.require_resource_budget_for_write(&job)?;
        self.resource_budget(job_id, None)
    }

    /// The independent policy CAS never acknowledges a cancellation or advances the job sequence.
    pub fn raise_resource_budget(
        &self,
        job_id: &str,
        request_id: &str,
        expected_policy_revision: u64,
        limits: MigrationResourceLimits,
        confirm: bool,
    ) -> Result<MigrationResourceIncreaseReceipt> {
        ensure!(confirm, "migration_resource_consent_required");
        valid_id(request_id)?;
        let _control = self.lock("control.lock")?;
        let job = self.load(job_id)?;
        let binding = job
            .resource_budget
            .as_ref()
            .context("migration_resource_legacy_untracked")?;
        self.verify_standalone_resource_budget(job_id, &job.resource_source_identity()?, binding)?;
        ensure!(binding.owner == job_id, "history_resource_parent_required");
        if let Some(known) = self
            .archives
            .history_resource_policy_receipt(&binding.reference, request_id)?
        {
            ensure!(
                known.previous_revision == expected_policy_revision && known.limits == limits,
                "history_resource_policy_request_changed"
            );
            return Ok(receipt(job_id, known));
        }
        self.ensure_live(&job)?;
        Ok(receipt(
            job_id,
            self.archives.raise_history_resource_budget(
                &binding.reference,
                request_id,
                expected_policy_revision,
                limits,
            )?,
        ))
    }
}
