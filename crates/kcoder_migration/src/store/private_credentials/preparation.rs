//! Native intent, not a frontend cache, is the source for a lost prepare reply.
use super::*;
use crate::source_transfer::{
    TransferAuthority,
    private_credentials::{
        PreparationIntent, PrivateCredentialPreparationPhase as Phase,
        PrivateCredentialPreparationStatus as Status, existing_preparation_intent,
        legacy_private_publication_exists,
    },
};
impl MigrationStore {
    pub fn received_credential_preparation_status(
        &self,
        job_id: &str,
        request: &str,
        source: &TransferAuthority,
        target: &TransferAuthority,
    ) -> Result<Status> {
        self.received_credential_preparation_status_observed(
            job_id,
            request,
            source,
            target,
            || Ok(()),
        )
    }
    pub(crate) fn received_credential_preparation_status_observed(
        &self,
        job_id: &str,
        request: &str,
        source: &TransferAuthority,
        target: &TransferAuthority,
        observed: impl FnOnce() -> Result<()>,
    ) -> Result<Status> {
        // Prepare reserves the catalog intent and publishes its job checkpoint
        // under the exclusive journal lease. Hold its existing shared peer for
        // the whole observation; opening a missing lock must never repair it.
        let name = OsStr::new(".lock");
        let identity = self.directory.portable_regular_identity(name)?;
        let _lease = self
            .directory
            .try_existing_portable_lock(name, &identity, kcoder_config::PrivateLeaseMode::Shared)?
            .context("private_credentials_busy")?;
        let job = self.load(job_id)?;
        observed()?;
        let batch = job
            .batch
            .as_ref()
            .context("private_credentials_saved_plan_required")?;
        ensure!(batch.sources.iter().any(|binding|matches!(binding,BatchSource::TransferredConfiguration(binding) if binding.credential_request_matches(request,source,target))),"private_credentials_source_not_selected");
        let intent = match existing_preparation_intent(&self.profile, job_id) {
            Ok(intent) => intent,
            Err(_) => return Ok(unknown_status(&job)),
        };
        if let Some(intent) = &intent {
            ensure!(intent.request_id==request && intent.members.iter().all(|member|member.matches_authenticated_request(request,source,target)),"private_credentials_authority_changed");
        }
        self.preparation_status_from_intent(&job, intent)
    }
    pub(super) fn preparation_status_for_job(&self, job: &MigrationJob) -> Result<Status> {
        let intent = match existing_preparation_intent(&self.profile, &job.job_id) {
            Ok(value) => value,
            Err(_) => return Ok(unknown_status(job)),
        };
        self.preparation_status_from_intent(job, intent)
    }
    fn preparation_status_from_intent(
        &self,
        job: &MigrationJob,
        intent: Option<PreparationIntent>,
    ) -> Result<Status> {
        let mut status = unknown_status(job);
        let Some(intent) = intent else {
            // Existing private plans without this new full-intent receipt are
            // legacy; do not invent an old sequence or consent from current state.
            if !job.credential_plans.is_empty() || !job.mcp_credential_plans.is_empty() {
                return Ok(status);
            }
            if legacy_private_publication_exists(&self.profile, &job.job_id)? {
                return Ok(status);
            }
            status.phase = Phase::NotStarted;
            return Ok(status);
        };
        intent.validate()?;
        status.original_plan_id = Some(intent.original_plan_id.clone());
        status.plan_id = Some(intent.plan_id.clone());
        status.offer_ids = Some(intent.offer_ids());
        status.expected_sequence = Some(intent.expected_sequence);
        status.consent = Some(intent.consent);
        let Some(batch) = &job.batch else {
            return Ok(status);
        };
        if job.credential_plans.is_empty() && job.mcp_credential_plans.is_empty() {
            if batch.plan_id.as_deref() == Some(intent.original_plan_id.as_str())
                && job.sequence == intent.expected_sequence
            {
                status.phase = Phase::Pending;
            }
            return Ok(status);
        }
        let expected = intent.members.iter().collect::<Vec<_>>();
        if !bundle::exact_existing(job, &expected)?
            || batch.plan_id.as_deref() != Some(intent.plan_id.as_str())
            || job
                .credential_plans
                .iter()
                .any(|plan| plan.atomic_group_id.as_deref() != Some(intent.action_id.as_str()))
            || job
                .mcp_credential_plans
                .iter()
                .any(|plan| plan.atomic_group_id.as_deref() != Some(intent.action_id.as_str()))
        {
            return Ok(status);
        }
        for member in &intent.members {
            let claim = match member.observed_publication_claim(&self.profile) {
                Ok(Some(value)) => value,
                _ => return Ok(status),
            };
            if claim != intent.claim() {
                return Ok(status);
            }
        }
        status.phase = Phase::Prepared;
        Ok(status)
    }
    pub(in crate::store) fn ensure_no_pending_received_preparation(
        &self,
        job: &MigrationJob,
    ) -> Result<()> {
        if !job.batch.as_ref().is_some_and(|batch| {
            batch
                .sources
                .iter()
                .any(|source| matches!(source, BatchSource::TransferredConfiguration(_)))
        }) {
            return Ok(());
        }
        // Preserve old, fully saved credential-plan consumers. Their preparation
        // metadata is not upgraded or advertised as a complete new intent.
        let existing = existing_preparation_intent(&self.profile, &job.job_id)
            .map_err(|_| anyhow::anyhow!("private_credentials_publication_unknown"))?;
        if existing.is_none()
            && (!job.credential_plans.is_empty() || !job.mcp_credential_plans.is_empty())
        {
            return Ok(());
        }
        match self.preparation_status_for_job(job)?.phase {
            Phase::NotStarted | Phase::Prepared => Ok(()),
            Phase::Pending => anyhow::bail!("private_credentials_preparation_pending"),
            Phase::Unknown => anyhow::bail!("private_credentials_publication_unknown"),
        }
    }
}

fn unknown_status(job: &MigrationJob) -> Status {
    Status {
        job_id: job.job_id.clone(),
        sequence: job.sequence,
        phase: Phase::Unknown,
        original_plan_id: None,
        plan_id: None,
        offer_ids: None,
        expected_sequence: None,
        consent: None,
    }
}
