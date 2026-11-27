//! New plans use native configuration/key groups; old phase-based plans retain their semantics.
use super::*;
use super::{
    batch::{bump, safe_code},
    credentials::sync_credential_issue,
};
use crate::{
    batch::{
        BatchAction, BatchActionKind,
        settings::{AtomicCredential, AtomicSettings},
    },
    credentials::CredentialPhase as Phase,
};
use kcoder_config::imported_credentials::ImportState;

#[cfg(test)]
thread_local! { pub(super) static INTERRUPT_AFTER_STAGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

impl MigrationStore {
    pub(super) fn atomic_conflict(code: &str) -> bool {
        matches!(
            code,
            "migration_target_changed"
                | "migration_template_referenced"
                | "migration_template_references_unknown"
                | "migration_template_target_changed"
                | "migration_template_dependency_changed"
                | "migration_wrong_target"
                | "migration_credential_import_target_changed"
                | "migration_credential_import_account_changed"
                | "migration_credential_import_receipt_conflict"
                | "migration_credential_group_settings_changed"
                | "migration_credential_group_credentials_changed"
                | "migration_credential_group_receipt_conflict"
                | "migration_credential_group_settings_conflict"
                | "migration_mcp_credential_predecessor_changed"
                | "migration_mcp_credential_predecessor_missing"
                | "migration_mcp_credential_has_dependents"
                | "migration_mcp_credential_preserved_value_changed"
        )
    }
    pub(super) fn is_atomic_action(job: &MigrationJob, action: &BatchAction) -> bool {
        job.batch
            .as_ref()
            .is_some_and(|batch| batch.atomic_credentials)
            && (job
                .credential_plans
                .iter()
                .any(|key| key.atomic_group_id.as_deref() == Some(&action.action_id))
                || job
                    .mcp_credential_plans
                    .iter()
                    .any(|key| key.atomic_group_id.as_deref() == Some(&action.action_id)))
    }
    pub(super) fn atomic_keys(job: &MigrationJob, action: &BatchAction) -> Vec<AtomicCredential> {
        job.credential_plans
            .iter()
            .filter(|key| key.atomic_group_id.as_deref() == Some(&action.action_id))
            .map(|key| AtomicCredential::Provider(Box::new(key.clone())))
            .chain(
                job.mcp_credential_plans
                    .iter()
                    .filter(|key| key.atomic_group_id.as_deref() == Some(&action.action_id))
                    .map(|key| AtomicCredential::Mcp(Box::new(key.clone()))),
            )
            .collect()
    }
    fn atomic_key_phase(
        &self,
        job_id: &str,
        id: &str,
        phase: Phase,
        error: Option<String>,
        undo: bool,
    ) -> Result<()> {
        let _lock = self.write_lock()?;
        let mut job = self.load(job_id)?;
        if let Some(index) = job
            .credential_plans
            .iter()
            .position(|key| key.plan_id == id)
        {
            job.credential_plans[index].phase = phase;
            job.credential_plans[index].error_code = error;
            job.credential_plans[index].undo_requested = undo;
            sync_credential_issue(&mut job, index);
        } else {
            let index = job
                .mcp_credential_plans
                .iter()
                .position(|key| key.plan_id == id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_plan"))?;
            let key = &mut job.mcp_credential_plans[index];
            key.phase = phase;
            key.error_code = error;
            key.undo_requested = undo;
            super::mcp_credentials::sync_mcp_credential_issue(&mut job, index);
        }
        bump(&mut job)?;
        self.save(&job)
    }
    pub(super) fn publish_atomic_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
        blocked: bool,
    ) -> Result<crate::providers::ProviderPublication> {
        let _owner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{}.credential.lock", job.job_id)))?
            .ok_or_else(|| {
                crate::contention::busy(crate::contention::LeaseKind::CredentialOperation)
            })?;
        let BatchActionKind::Settings { plan } = &action.action else {
            anyhow::bail!("migration_invalid_journal")
        };
        let keys = targets
            .credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
        let plans = Self::atomic_keys(job, action);
        let context = AtomicSettings {
            id: &action.action_id,
            provider: targets.provider,
            mcp: targets.mcp,
            keys,
            plans: &plans,
        };
        let previous = keys.target.group_receipt(&action.action_id)?;
        if previous.is_none() {
            for step in &plan.steps {
                if let crate::batch::settings::SettingsStep::Mcp(mcp) = step
                    && let Some(proof) = &mcp.reuse_origin
                {
                    self.observe_reuse(proof, targets)?;
                }
            }
            if matches!(
                action.status,
                ItemStatus::Committing | ItemStatus::CommitUnknown
            ) {
                // Staged native receipts prove there is no active binding from this group.
                for key in &plans {
                    let state = key.state(keys.target, keys.backend)?;
                    ensure!(
                        state == Some(ImportState::Staged)
                            || state.is_none() && key.phase() == Phase::Ready,
                        "migration_credential_group_receipt_required"
                    );
                }
            }
            ensure!(!blocked, "migration_source_changed");
            for key in &plans {
                ensure!(
                    !matches!(
                        self.read(&job.job_id)?.status,
                        JobStatus::CancelRequested | JobStatus::Cancelled
                    ),
                    "migration_atomic_staging_cancelled"
                );
                self.atomic_key_phase(&job.job_id, key.id(), Phase::Applying, None, false)?;
                let source_name = &job
                    .inventory
                    .items
                    .iter()
                    .find(|item| item.preview.id == key.item_id())
                    .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?
                    .preview
                    .source_name;
                if let Err(error) = key.stage(keys.target, keys.backend, source_name) {
                    let code = safe_code(&error);
                    // These checks precede the native stage call and cannot have written a key.
                    let phase = if matches!(
                        code.as_str(),
                        "migration_credential_source_changed"
                            | "migration_mcp_private_source_changed"
                            | "migration_source_changed"
                            | "migration_source_unavailable"
                            | "migration_mcp_private_source_invalid"
                            | "migration_mcp_private_source_ambiguous"
                            | "migration_mcp_private_expansion_unsupported"
                            | "migration_invalid_source_format"
                            | "migration_credential_authentication_unsupported"
                            | "migration_credential_key_missing"
                            | "migration_credential_source_not_declared"
                            | "migration_credential_invalid_api_key"
                    ) {
                        Phase::Ready
                    } else {
                        Phase::Unknown
                    };
                    self.atomic_key_phase(&job.job_id, key.id(), phase, Some(code), false)?;
                    return Err(anyhow::anyhow!("migration_atomic_staging_pending"));
                }
                #[cfg(test)]
                if INTERRUPT_AFTER_STAGE.with(|interrupt| interrupt.replace(false)) {
                    anyhow::bail!("migration_injected_interrupted_credential_stage");
                }
            }
        }
        let current = self.read(&job.job_id)?;
        let cancelled = matches!(
            current.status,
            JobStatus::CancelRequested | JobStatus::Cancelled
        );
        match plan.publish_atomic(&context, cancelled, blocked) {
            Ok(receipt) => {
                for key in &plans {
                    self.atomic_key_phase(&job.job_id, key.id(), Phase::Published, None, false)?;
                }
                Ok(receipt)
            }
            Err(error) => {
                for key in &plans {
                    self.atomic_key_phase(
                        &job.job_id,
                        key.id(),
                        Phase::Unknown,
                        Some(safe_code(&error)),
                        false,
                    )?;
                }
                Err(error)
            }
        }
    }

    pub(super) fn undo_atomic_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let _owner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{}.credential.lock", job.job_id)))?
            .ok_or_else(|| {
                crate::contention::busy(crate::contention::LeaseKind::CredentialOperation)
            })?;
        {
            let _lock = self.write_lock()?;
            self.require_unreferenced(&job.job_id, &action.action_id)?;
        }
        let BatchActionKind::Settings { plan } = &action.action else {
            anyhow::bail!("migration_invalid_journal")
        };
        let keys = targets
            .credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
        let plans = Self::atomic_keys(job, action);
        let context = AtomicSettings {
            id: &action.action_id,
            provider: targets.provider,
            mcp: targets.mcp,
            keys,
            plans: &plans,
        };
        let previous = keys.target.group_receipt(&action.action_id)?;
        if previous.is_none() {
            for key in &plans {
                let state = key.state(keys.target, keys.backend)?;
                ensure!(
                    state == Some(ImportState::Staged)
                        || state == Some(ImportState::Undone)
                        || state.is_none() && key.phase() == Phase::Ready,
                    "migration_credential_group_receipt_required"
                );
            }
        }
        let removal = plan.undo_atomic(&context);
        if let Err(error) = removal {
            let code = safe_code(&error);
            let phase = if Self::atomic_conflict(&code) {
                Phase::Conflict
            } else {
                Phase::Undoing
            };
            for key in &plans {
                self.atomic_key_phase(&job.job_id, key.id(), phase, Some(code.clone()), true)?;
            }
            return Err(error);
        }
        for key in &plans {
            if key.phase() == Phase::Undone {
                continue;
            }
            if key.state(keys.target, keys.backend)?.is_none() && key.phase() == Phase::Ready {
                self.atomic_key_phase(&job.job_id, key.id(), Phase::Undone, None, true)?;
                continue;
            }
            self.atomic_key_phase(&job.job_id, key.id(), Phase::Undoing, None, true)?;
            match key.undo(keys.target, keys.backend) {
                Ok(_) => self.atomic_key_phase(&job.job_id, key.id(), Phase::Undone, None, true)?,
                Err(error) => {
                    let code = safe_code(&error);
                    let phase = if Self::atomic_conflict(&code) {
                        Phase::Conflict
                    } else {
                        Phase::Undoing
                    };
                    self.atomic_key_phase(&job.job_id, key.id(), phase, Some(code), true)?;
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}
