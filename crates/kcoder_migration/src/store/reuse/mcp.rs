//! Reuse preserves an owned private binding without copying or replaying source values.
use super::*;
use crate::{credentials::CredentialPhase, mcp_credentials::McpCredentialPlan};
use kcoder_config::imported_credentials::{CredentialGroupOutcome, ImportState};

pub(in crate::store) struct McpOrigin {
    plan: Box<McpPlan>,
    private: Option<Box<McpCredentialPlan>>,
}
impl std::ops::Deref for McpOrigin {
    type Target = McpPlan;
    fn deref(&self) -> &Self::Target {
        &self.plan
    }
}
impl McpOrigin {
    pub(super) fn new(job: &MigrationJob, mut plan: Box<McpPlan>) -> Option<Self> {
        let candidates = job
            .mcp_credential_plans
            .iter()
            .filter(|private| private.item_id == plan.item().preview.id)
            .collect::<Vec<_>>();
        if candidates.iter().any(|private| {
            matches!(
                private.phase,
                CredentialPhase::Applying
                    | CredentialPhase::Unknown
                    | CredentialPhase::Undoing
                    | CredentialPhase::Conflict
            )
        }) {
            return None;
        }
        let private = candidates
            .into_iter()
            .rev()
            .find(|private| private.phase == CredentialPhase::Published);
        if let Some(private) = private {
            if private.original != *plan.config() && private.config != *plan.config() {
                return None;
            }
            plan.item.mcp.as_mut()?.config = private.config.clone();
        } else if plan.config().policy.credential_ref.is_some() {
            return None;
        }
        Some(Self {
            plan,
            private: private.cloned().map(Box::new),
        })
    }
    pub(super) fn fingerprint(&self) -> Result<String> {
        if let Some(origin) = &self.plan.reuse_origin {
            // Adding a credential reference preserves the original import semantics,
            // including activation preferences subsequently changed by the user.
            return Ok(origin.fingerprint.clone());
        }
        let mut config = self.config().clone();
        config.policy.credential_ref = None;
        digest(&(config, self.enabled()))
    }
    pub(super) fn observe(&self, targets: &BatchTargets<'_>) -> Result<Option<bool>> {
        let observed = targets.mcp.observe(&self.plan)?;
        if observed.is_none() {
            return Ok(None);
        }
        if let Some(private) = &self.private {
            let keys = targets
                .credentials
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
            let native = keys.target.native();
            let receipt = native
                .group_receipt(&private.group_id)
                .map_err(crate::mcp_credentials::safe_error)?
                .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_receipt_changed"))?;
            ensure!(
                receipt.outcome == CredentialGroupOutcome::Committed
                    && receipt.references.contains(&private.reference),
                "migration_mcp_private_receipt_changed"
            );
            ensure!(
                native
                    .state(&private.reference, keys.backend)
                    .map_err(crate::mcp_credentials::safe_error)?
                    == Some(ImportState::Published),
                "migration_mcp_private_destination_changed"
            );
            // Resolving validates the existing payload and effective storage policy; it does not publish or connect.
            drop(
                native
                    .resolve_mcp_with_mode(self.config(), keys.policy, keys.backend)
                    .map_err(crate::mcp_credentials::safe_error)?,
            );
        }
        Ok(observed)
    }

    fn resolved_item(
        &self,
        item: &crate::NormalizedItem,
        resolution: &crate::mcp::McpResolution,
    ) -> Result<crate::NormalizedItem> {
        let Some(private) = &self.private else {
            return crate::mcp::resolve(item, resolution);
        };
        let mut preflight = resolution.clone();
        preflight.enable_after_import = false;
        let mut item = crate::mcp::resolve(item, &preflight)?;
        if private.remaining_fields() == 0 {
            item.preview.issues.retain(|issue| {
                issue.code
                    != kcoder_types::migration::MigrationIssueCode::CredentialResolutionRequired
            });
        }
        if resolution.enable_after_import {
            private.validate_activation()?;
            item.preview.issues.retain(|issue| {
                !(issue.code == kcoder_types::migration::MigrationIssueCode::RequiresReview
                    && issue.field.as_deref() == Some("activation"))
            });
        }
        Ok(item)
    }
}

impl MigrationStore {
    pub(in crate::store) fn mcp_reuse_amendment(
        &self,
        item: &crate::NormalizedItem,
        proof: &ReuseProof,
    ) -> Result<McpPlan> {
        let previous = self.load(&proof.job_id)?;
        let Some(Origin::Mcp(origin)) = self.origin(&previous, &proof.action_id, &proof.item_id)?
        else {
            anyhow::bail!("migration_reuse_target_changed")
        };
        let mut plan = *origin.plan;
        let original = plan.config().clone();
        plan.plan_id = format!("plan-{}", uuid::Uuid::new_v4().simple());
        plan.item = item.clone();
        plan.item
            .mcp
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?
            .config = original.clone();
        plan.previous = Some(original);
        plan.reuse_origin = Some(proof.clone());
        plan.enable_after_import = proof.enabled;
        Ok(plan)
    }

    pub(in crate::store) fn resolved_mcp_reuse(
        &self,
        item: &crate::NormalizedItem,
        resolution: &crate::mcp::McpResolution,
        proof: &ReuseProof,
    ) -> Result<crate::NormalizedItem> {
        let previous = self.load(&proof.job_id)?;
        let Some(Origin::Mcp(origin)) = self.origin(&previous, &proof.action_id, &proof.item_id)?
        else {
            anyhow::bail!("migration_reuse_target_changed")
        };
        origin.resolved_item(item, resolution)
    }
}
