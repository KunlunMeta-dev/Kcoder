//! Native quota intent uses CAS and its original receipt; it does not authorize payload access.
use super::*;
pub use model::{ResourcePolicyObservation, ResourcePolicyReceipt};

impl crate::external_history::ExternalHistoryStore {
    pub fn history_resource_policy(
        &self,
        reference: &ResourceBudgetReference,
    ) -> Result<ResourcePolicyObservation> {
        let catalog =
            Catalog::open_readonly(&self.directory)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        Ok(group.policy())
    }

    /// Invoke only for an explicit target-side increase. Reusing a request returns its original
    /// receipt even after subsequent increases; a stale new request never changes the ledger.
    /// Existing filesystem permissions, hard per-file bounds and disk headroom remain unchanged.
    pub fn raise_history_resource_budget(
        &self,
        reference: &ResourceBudgetReference,
        request_id: &str,
        expected_revision: u64,
        limits: MigrationResourceLimits,
    ) -> Result<ResourcePolicyReceipt> {
        let mut catalog =
            Catalog::open(&self.directory, false)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get_mut(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        let (receipt, changed) = group.raise_policy(request_id, expected_revision, limits)?;
        if changed {
            catalog.save()?;
        }
        Ok(receipt)
    }
}

/// These facts are captured under a single original catalog lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceBudgetSnapshot {
    pub usage: ResourceBudgetUsage,
    pub policy: ResourcePolicyObservation,
    pub requested_receipt: Option<ResourcePolicyReceipt>,
}
impl crate::external_history::ExternalHistoryStore {
    pub fn resource_budget_snapshot(
        &self,
        reference: &ResourceBudgetReference,
        request_id: Option<&str>,
    ) -> Result<ResourceBudgetSnapshot> {
        let catalog =
            Catalog::open_readonly(&self.directory)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        Ok(ResourceBudgetSnapshot {
            usage: group.usage()?,
            policy: group.policy(),
            requested_receipt: request_id
                .map(|request| group.policy_receipt(request))
                .transpose()?
                .flatten(),
        })
    }
    pub fn history_resource_policy_receipt(
        &self,
        reference: &ResourceBudgetReference,
        request_id: &str,
    ) -> Result<Option<ResourcePolicyReceipt>> {
        Ok(self
            .resource_budget_snapshot(reference, Some(request_id))?
            .requested_receipt)
    }
}
