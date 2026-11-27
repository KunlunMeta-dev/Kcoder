//! Inert migrated definitions are stored separately from runtime registries and imported context.
mod model;
mod storage;
use anyhow::{Result, ensure};
pub(crate) use model::{DefinitionRecord, StoreBinding};
use std::path::Path;

pub(crate) struct DefinitionStore {
    inner: storage::Storage,
}
impl DefinitionStore {
    /// Planning may initialize empty private metadata, but publishes no definition or runtime policy.
    pub(crate) fn for_plan(profile: &Path) -> Result<(Self, StoreBinding)> {
        let (inner, binding) = storage::Storage::initialize(profile)?;
        Ok((Self { inner }, binding))
    }
    pub(crate) fn existing(profile: &Path, binding: &StoreBinding) -> Result<Self> {
        Ok(Self {
            inner: storage::Storage::existing(profile, binding)?,
        })
    }
    pub(crate) fn check_name(
        &self,
        binding: &StoreBinding,
        record: &DefinitionRecord,
    ) -> Result<()> {
        self.inner.read(binding, |state| {
            ensure!(
                !state.records.values().any(|old| old.name == record.name
                    && old.scope == record.scope
                    && old.report.kind == record.report.kind),
                "migration_target_conflict"
            );
            Ok(())
        })
    }
    pub(crate) fn observe(
        &self,
        binding: &StoreBinding,
        record: &DefinitionRecord,
    ) -> Result<Option<bool>> {
        self.inner.read(binding, |state| {
            if let Some(receipt) = state.receipts.get(&record.operation_id) {
                receipt.check(record)?;
                if receipt.undone {
                    ensure!(
                        !state.records.contains_key(&record.id),
                        "migration_target_changed"
                    );
                    return Ok(None);
                }
                ensure!(
                    state.records.get(&record.id) == Some(record),
                    "migration_target_changed"
                );
                return Ok(Some(false));
            }
            ensure!(
                !state.records.contains_key(&record.id),
                "migration_target_conflict"
            );
            Ok(None)
        })
    }
    pub(crate) fn publish(
        &self,
        binding: &StoreBinding,
        record: &DefinitionRecord,
        cancelled: bool,
        source_blocked: bool,
    ) -> Result<()> {
        record.validate()?;
        self.inner.update(binding, |state| {
            if let Some(receipt) = state.receipts.get(&record.operation_id) {
                receipt.check(record)?;
                ensure!(
                    !receipt.undone && state.records.get(&record.id) == Some(record),
                    "migration_target_changed"
                );
                return Ok(false);
            }
            ensure!(!cancelled, "migration_cancelled_unsettled_publication");
            ensure!(!source_blocked, "migration_source_changed");
            ensure!(
                state.records.len() < 4096 && state.receipts.len() < 8192,
                "migration_definition_store_budget_exceeded"
            );
            ensure!(
                !state.records.contains_key(&record.id)
                    && !state.records.values().any(|old| old.name == record.name
                        && old.scope == record.scope
                        && old.report.kind == record.report.kind),
                "migration_target_conflict"
            );
            state.records.insert(record.id.clone(), record.clone());
            state
                .receipts
                .insert(record.operation_id.clone(), model::Receipt::new(record)?);
            Ok(true)
        })
    }
    pub(crate) fn rollback(&self, binding: &StoreBinding, record: &DefinitionRecord) -> Result<()> {
        self.inner.update(binding, |state| {
            let receipt = state
                .receipts
                .get_mut(&record.operation_id)
                .ok_or_else(|| anyhow::anyhow!("migration_target_changed"))?;
            receipt.check(record)?;
            if receipt.undone {
                ensure!(
                    !state.records.contains_key(&record.id),
                    "migration_target_changed"
                );
                return Ok(false);
            }
            ensure!(
                state.records.get(&record.id) == Some(record),
                "migration_target_changed"
            );
            state.records.remove(&record.id);
            receipt.undone = true;
            Ok(true)
        })
    }
}

#[cfg(test)]
mod tests;
