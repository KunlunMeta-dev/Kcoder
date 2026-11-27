//! Precommit cancellation stays on the original coordinator and receipt.
use super::*;
use crate::storage::component_publication::prepare_cancellation_components;
use std::ffi::OsString;

pub(in crate::storage) const CANCEL_PENDING: &str = "STORAGE_OPERATION_CANCEL_PENDING";

impl StorageCoordinator {
    /// Reconcile an original precommit operation, remove only its unchanged raw
    /// publications, then defer it with the original selection and source intact.
    pub fn cancel_operation(&mut self, id: &str) -> Result<StorageMigrationReceipt> {
        self.cancel_operation_with_hook(id, &mut |_| Ok(()))
    }

    fn cancel_operation_with_hook(
        &mut self,
        id: &str,
        before_remove: &mut impl FnMut(&Path) -> Result<()>,
    ) -> Result<StorageMigrationReceipt> {
        let receipt = self.require(id)?;
        if receipt.disposition == Disposition::Deferred
            && receipt.error_code.as_deref() == Some("STORAGE_OPERATION_CANCELLED")
        {
            ensure!(
                location(&self.directory)? == receipt.plan.original,
                "STORAGE_SELECTION_CHANGED"
            );
            return Ok(receipt);
        }
        if matches!(receipt.phase, Phase::Planned | Phase::Stopping) {
            return self.cancel_before_copy(id);
        }
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(
                    receipt.phase,
                    Phase::Stopped | Phase::Copying | Phase::Verifying | Phase::Prepared
                ),
            "STORAGE_CANCEL_RECONCILIATION_REQUIRED"
        );
        ensure!(
            location(&self.directory)? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        self.require_stopped(&receipt.plan)?;
        for component in &receipt.plan.components {
            ensure!(
                PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                    == component.source_identity,
                "STORAGE_SOURCE_CHANGED"
            );
        }
        let mut known = BTreeSet::new();
        let mut operation_names = BTreeSet::from([OsString::from(RECEIPT)]);
        for component in &receipt.plan.components {
            for prefix in ["publish", "copy", "pending"] {
                known.insert(format!("{prefix}-{}", component.domain));
            }
            if receipt
                .owner_receipts
                .contains_key(&format!("copy-{}", component.domain))
            {
                ensure!(
                    component.source != component.destination,
                    "STORAGE_CANCEL_OWNER_RECONCILIATION_REQUIRED"
                );
                operation_names.insert(OsString::from(format!(
                    "tree-copy-{}.json",
                    component.domain
                )));
            }
            if component.source == component.destination {
                ensure!(
                    !receipt
                        .owner_receipts
                        .contains_key(&format!("publish-{}", component.domain)),
                    "STORAGE_CANCEL_OWNER_RECONCILIATION_REQUIRED"
                );
            }
        }
        for role in ["native", "gateway", "desktop"] {
            known.insert(format!("source-retirement-{role}"));
        }
        ensure!(
            receipt.owner_receipts.keys().all(|key| known.contains(key)),
            "STORAGE_CANCEL_OWNER_RECONCILIATION_REQUIRED"
        );
        let (_, _, operation) = self.source_retirement_context(id)?;
        ensure!(
            operation
                .entry_names_bounded(operation_names.len() + 1)?
                .iter()
                .all(|name| operation_names.contains(name)),
            "STORAGE_CANCEL_CONTROL_UNKNOWN"
        );

        // Every target is inspected before any target or source control is removed.
        let components = prepare_cancellation_components(self, &receipt)?;
        let removed = components
            .iter()
            .flat_map(|component| component.held_directory_identities())
            .collect::<BTreeSet<_>>();
        let detach = self
            .roots
            .iter()
            .map(|lease| {
                let (identity, _) = lease.scope_identities()?;
                Ok::<_, anyhow::Error>(removed.contains(&identity))
            })
            .collect::<Result<Vec<_>>>()?;
        // Do not trap an unsupported owner or changed target in cancellation.
        // Once every preflight succeeds, persist intent before the first unlink.
        self.record_step_error(id, CANCEL_PENDING)?;
        let mut held_targets = Vec::new();
        let mut retained = Vec::new();
        for (lease, detach) in std::mem::take(&mut self.roots).into_iter().zip(detach) {
            if detach {
                held_targets.push(lease);
            } else {
                retained.push(lease);
            }
        }
        self.roots = retained;
        for component in &components {
            ensure!(
                location(&self.directory)? == receipt.plan.original,
                "STORAGE_SELECTION_CHANGED"
            );
            component.remove(self, id, before_remove)?;
        }
        self.cleanup_source_retirements(id)?;
        let mut settled = self.require(id)?;
        ensure!(
            location(&self.directory)? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        for component in &settled.plan.components {
            ensure!(
                PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                    == component.source_identity,
                "STORAGE_SOURCE_CHANGED"
            );
        }
        // The authenticated manifests are gone. Clearing their current facts is
        // necessary for an explicitly requested retry of this same original ID.
        // In-place pending facts stay until defer_after_cleanup authenticates them.
        for component in &settled.plan.components {
            settled
                .owner_receipts
                .remove(&format!("copy-{}", component.domain));
            settled
                .owner_receipts
                .remove(&format!("publish-{}", component.domain));
            if component.source != component.destination {
                settled
                    .owner_receipts
                    .remove(&format!("pending-{}", component.domain));
            }
        }
        for role in ["native", "gateway", "desktop"] {
            settled
                .owner_receipts
                .remove(&format!("source-retirement-{role}"));
        }
        self.write_receipt(&settled)?;
        let result = self.defer_after_cleanup(id, "STORAGE_OPERATION_CANCELLED")?;
        drop(held_targets);
        Ok(result)
    }
}

#[cfg(test)]
#[path = "cancel_cleanup_tests.rs"]
mod tests;
