//! One target-owned ledger coordinates combined archive, index and attachment charges.
//! It reuses the born lifecycle coordinator; observations never grant write or deletion authority.
use super::*;
use kcoder_config::AvailableStorage;
use kcoder_types::migration_resource::{
    MAX_MIGRATION_RESOURCE_BYTES, MAX_MIGRATION_RESOURCE_FILES, MigrationResourceLimits,
};
use serde::{Deserialize, Serialize};
mod adoption;
mod archive;
pub use adoption::ResourceBudgetRecipe;
mod reader;
pub(in crate::external_history) use reader::BudgetReader;
mod model;
mod policy;
mod snapshot;
pub use policy::{ResourceBudgetSnapshot, ResourcePolicyObservation, ResourcePolicyReceipt};
mod streaming;
pub(crate) use model::Group;
pub use model::{
    ResourceBudgetReference, ResourceBudgetUsage, ResourceCharge, ResourceKind, ResourceOutcome,
    ResourceReservation,
};
pub(crate) use streaming::ResourceStream;

impl crate::external_history::ExternalHistoryStore {
    /// The native producer binds only immutable child operations, never source filenames or paths.
    pub fn prepare_resource_budget(
        &self,
        owner: &str,
        members: Vec<String>,
        limits: MigrationResourceLimits,
    ) -> Result<ResourceBudgetReference> {
        let mut catalog =
            Catalog::open(&self.directory, true)?.context("history_resource_ledger_missing")?;
        let group = Group::new(&catalog.scope(), owner, members, limits)?;
        let reference = group.reference().clone();
        if let Some(existing) = catalog.document.resource_groups.get(&reference.group) {
            existing.require(&reference)?;
            return Ok(reference);
        }
        ensure!(
            !catalog
                .document
                .requests
                .values()
                .any(|request| { group.contains_member(&request.operation) }),
            "history_resource_member_already_started"
        );
        ensure!(
            !catalog
                .document
                .resource_groups
                .values()
                .any(|existing| existing.overlaps_members(&group)),
            "history_resource_member_already_bound"
        );
        ensure!(
            catalog.document.resource_groups.len() < MAX_ARCHIVES,
            "history_resource_metadata_budget_exceeded"
        );
        catalog
            .document
            .resource_groups
            .insert(reference.group.clone(), group);
        catalog.save()?;
        Ok(reference)
    }
    /// Observe an original native owner without creating a ledger or probing fresh capacity.
    pub fn recorded_resource_budget(&self, owner: &str) -> Result<Option<ResourceBudgetReference>> {
        operation_id(owner)?;
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        let key = hash(&("history-resource-group/v1", catalog.scope(), owner))?;
        Ok(catalog
            .document
            .resource_groups
            .get(&key)
            .map(|group| group.reference().clone()))
    }
    /// Validate the immutable parent recipe without allocating or adopting a different group.
    pub fn recorded_resource_budget_for_plan(
        &self,
        owner: &str,
        members: Vec<String>,
        baseline: MigrationResourceLimits,
    ) -> Result<Option<ResourceBudgetReference>> {
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        let expected = Group::new(&catalog.scope(), owner, members, baseline)?;
        let reference = expected.reference();
        let Some(original) = catalog.document.resource_groups.get(&reference.group) else {
            return Ok(None);
        };
        original.require(reference)?;
        Ok(Some(reference.clone()))
    }
    /// Read the original charge before retrying any mutation after a lost acknowledgement.
    pub fn find_history_resource_reservation(
        &self,
        reference: &ResourceBudgetReference,
        charge: &ResourceCharge,
    ) -> Result<Option<(ResourceReservation, ResourceOutcome)>> {
        let catalog =
            Catalog::open_readonly(&self.directory)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        group.existing(charge)
    }
    pub fn resource_budget_usage(
        &self,
        reference: &ResourceBudgetReference,
    ) -> Result<ResourceBudgetUsage> {
        let catalog =
            Catalog::open_readonly(&self.directory)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        group.usage()
    }
    /// A lost reply retains its original charge. The caller must reconcile the returned outcome.
    pub fn reserve_history_resource(
        &self,
        reference: &ResourceBudgetReference,
        charge: ResourceCharge,
    ) -> Result<(ResourceReservation, ResourceOutcome)> {
        let mut catalog =
            Catalog::open(&self.directory, false)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get_mut(&reference.group)
            .context("history_resource_ledger_missing")?;
        group.require(reference)?;
        group.fixed_mode(&charge)?;
        if let Some(existing) = group.existing(&charge)? {
            ensure!(
                existing.1 != ResourceOutcome::Abandoned,
                "history_resource_reservation_abandoned"
            );
            return Ok(existing);
        }
        let space = self
            .directory
            .available_storage()
            .map_err(|_| anyhow::anyhow!("history_resource_disk_space_unavailable"))?;
        let (reservation, outcome, changed) = group.reserve(charge, space)?;
        if changed {
            catalog.save()?;
        }
        Ok((reservation, outcome))
    }
    /// Observe the original reservation without creating resources or probing fresh capacity.
    pub fn history_resource_outcome(
        &self,
        reservation: &ResourceReservation,
    ) -> Result<ResourceOutcome> {
        let catalog =
            Catalog::open_readonly(&self.directory)?.context("history_resource_ledger_missing")?;
        catalog
            .document
            .resource_groups
            .get(&reservation.budget.group)
            .context("history_resource_ledger_missing")?
            .outcome(reservation)
    }
    /// Only the native resource owner may supply its verified byte/file count and receipt digest.
    pub fn settle_history_resource(
        &self,
        reservation: &ResourceReservation,
        bytes: u64,
        files: u32,
        receipt_sha256: &str,
    ) -> Result<()> {
        let mut catalog =
            Catalog::open(&self.directory, false)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get_mut(&reservation.budget.group)
            .context("history_resource_ledger_missing")?;
        if group.settle(reservation, bytes, files, receipt_sha256)? {
            catalog.save()?;
        }
        Ok(())
    }
    /// The caller must retain the resource writer lease while proving it has no owned payload.
    /// Cancellation, missing acknowledgement and Drop alone are not proof of absence.
    pub fn abandon_unwritten_history_resource(
        &self,
        reservation: &ResourceReservation,
        confirm_unwritten: impl FnOnce() -> Result<bool>,
    ) -> Result<()> {
        match self.history_resource_outcome(reservation)? {
            ResourceOutcome::Abandoned => return Ok(()),
            ResourceOutcome::Reserved | ResourceOutcome::Streaming { .. } => {}
            ResourceOutcome::Committed { .. } => {
                anyhow::bail!("history_resource_already_committed")
            }
        }
        ensure!(
            confirm_unwritten()?,
            "history_resource_unwritten_not_confirmed"
        );
        let mut catalog =
            Catalog::open(&self.directory, false)?.context("history_resource_ledger_missing")?;
        let group = catalog
            .document
            .resource_groups
            .get_mut(&reservation.budget.group)
            .context("history_resource_ledger_missing")?;
        if group.abandon(reservation)? {
            catalog.save()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod fd_pressure_tests;

#[cfg(all(test, target_os = "linux", feature = "resource-pressure-tests"))]
mod disk_pressure_tests;
