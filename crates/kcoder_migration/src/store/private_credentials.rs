//! Attach received private inputs to the existing durable batch and native publication group.
use super::*;
use crate::{
    batch::{BatchActionKind, BatchSource, settings::SettingsStep},
    credentials::CredentialPhase,
    mcp_credentials::McpCredentialTarget,
    source_transfer::private_credentials::{
        PrivateCredentialConsent, PrivateCredentialSelection, ReceivedCredentialInput,
        ReceivedPrivateCredentialBinding,
    },
};
use anyhow::Context;

mod bundle;
mod preparation;

impl MigrationStore {
    pub fn prepare_received_batch_credentials(
        &self,
        job_id: &str,
        expected_sequence: u64,
        received: &ReceivedPrivateCredentialBinding,
        consent: PrivateCredentialConsent,
        targets: &BatchTargets<'_>,
    ) -> Result<MigrationJob> {
        self.prepare_received_batch_credentials_bundle(
            job_id,
            expected_sequence,
            std::slice::from_ref(received),
            consent,
            targets,
        )
    }
}

impl MigrationStore {
    /// Release the original transport key only after the normal native group Undo.
    /// This never needs the source host or the ordinary received inventory files.
    pub fn release_received_batch_key(
        &self,
        job_id: &str,
        received: &ReceivedPrivateCredentialBinding,
        target: &crate::credentials::CredentialTarget,
        backend: &dyn kcoder_config::CredentialBackend,
    ) -> Result<()> {
        job_file(job_id)?;
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.runner.lock")))?
            .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner))?;
        let job = self.read(job_id)?;
        ensure!(
            job.status == JobStatus::RolledBack,
            "private_credentials_publication_unsettled"
        );
        let claim = received.publication_claim(&self.profile)?;
        let batch = job
            .batch
            .as_ref()
            .context("private_credentials_publication_unsettled")?;
        ensure!(
            claim.job_id == job_id && batch.plan_id.as_deref() == Some(&claim.plan_id),
            "private_credentials_publication_binding_changed"
        );
        ensure!(
            target.directory_identity()?
                == kcoder_config::PrivateDirectory::open_existing(&self.profile)?
                    .directory_identity()?,
            "private_credentials_wrong_consumer"
        );
        let offers = bundle::original_bindings(&job)?;
        ensure!(
            offers.contains(&received),
            "private_credentials_publication_binding_changed"
        );
        let digest = crate::source_transfer::private_credentials::private_credential_bundle_digest(
            job_id,
            &claim.original_plan_id,
            &claim.action_id,
            &offers,
        )?;
        ensure!(
            claim.bundle_sha256.as_deref() == Some(digest.as_str())
                || offers.len() == 1 && claim.bundle_sha256.is_none(),
            "private_credentials_publication_binding_changed"
        );
        let mut references = Vec::new();
        let mut own_references = 0;
        for plan in &job.credential_plans {
            ensure!(
                plan.source.received_offer().is_some()
                    && plan.atomic_group_id.as_deref() == Some(&claim.action_id)
                    && plan.phase == CredentialPhase::Undone,
                "private_credentials_publication_unsettled"
            );
            own_references += usize::from(plan.source.received_offer() == Some(received));
            references.push(plan.reference.clone());
        }
        for plan in &job.mcp_credential_plans {
            ensure!(
                plan.source.received_offer().is_some()
                    && plan.atomic_group_id.as_deref() == Some(&claim.action_id)
                    && plan.phase == CredentialPhase::Undone,
                "private_credentials_publication_unsettled"
            );
            own_references += usize::from(plan.source.received_offer() == Some(received));
            references.push(plan.reference.clone());
        }
        ensure!(
            own_references == received.selections().len(),
            "private_credentials_publication_unsettled"
        );
        ensure!(
            references
                .iter()
                .enumerate()
                .all(|(index, reference)| !references[..index].contains(reference)),
            "private_credentials_publication_binding_changed"
        );
        let group = target.group_receipt(&claim.action_id)?;
        if let Some(group) = group {
            ensure!(
                group.outcome
                    == kcoder_config::imported_credentials::CredentialGroupOutcome::Undone
                    && group.references.len() == references.len()
                    && references
                        .iter()
                        .all(|reference| group.references.contains(reference)),
                "private_credentials_publication_unsettled"
            );
            for reference in &group.references {
                ensure!(
                    target.native().state(reference, backend)?
                        == Some(kcoder_config::imported_credentials::ImportState::Undone),
                    "private_credentials_publication_unsettled"
                );
            }
        } else {
            // No apply/resume was ever accepted by the durable batch journal.
            // Mere absence of native receipts after an execution attempt is unknown.
            batch.validate_execution_control()?;
            ensure!(
                batch.execution_request_count() > 0
                    && batch
                        .request_kinds
                        .iter()
                        .filter(
                            |(request, _)| request.as_str() != crate::batch::control::BIRTH_MARKER
                        )
                        .all(|(_, kind)| kind == "rollback")
                    && batch
                        .actions
                        .iter()
                        .any(|action| action.action_id == claim.action_id
                            && action.status == ItemStatus::RolledBack),
                "private_credentials_publication_unsettled"
            );
            for reference in &references {
                ensure!(
                    target.native().state(reference, backend)?.is_none(),
                    "private_credentials_publication_unsettled"
                );
            }
        }
        received.release_undone_key(&self.profile, &claim, backend)
    }
}
