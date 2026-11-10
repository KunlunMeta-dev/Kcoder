//! A separate accounting context does not turn a legacy reader into a managed GC lease.
use super::*;
use std::sync::Arc;

pub(in crate::external_history) struct BudgetReader {
    store: kcoder_config::PrivateDirectory,
    directory: kcoder_config::PrivateDirectory,
    directory_identity: String,
    pub(super) reference: ResourceBudgetReference,
    pub(super) member: String,
    identity: String,
    archive: String,
    snapshot: kcoder_types::external_history::ExternalHistorySnapshot,
    receipt: Option<kcoder_types::external_history::ExternalHistoryReceipt>,
    managed: bool,
}
impl BudgetReader {
    pub(super) fn store(&self) -> Result<crate::external_history::ExternalHistoryStore> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "history_resource_binding_changed"
        );
        Ok(crate::external_history::ExternalHistoryStore {
            directory: self.store.duplicate_handle()?,
        })
    }
    pub(super) fn account_baseline(
        &self,
        store: &crate::external_history::ExternalHistoryStore,
    ) -> Result<()> {
        let Some(receipt) = &self.receipt else {
            return Ok(());
        };
        if self.managed {
            let catalog = Catalog::open_readonly(&store.directory)?
                .context("history_resource_ledger_missing")?;
            let archive = catalog
                .document
                .archives
                .get(&self.archive)
                .context("external_history_lifecycle_changed")?;
            let original = catalog.resource_owner_for_archive(archive)?;
            if !original.is_some_and(|(group, member, _)| {
                group == self.reference.group && member == self.member
            }) {
                // A reuse operation pays only its new derived allocations, never another creator's raw bytes.
                return Ok(());
            }
        }
        let reservation = store.reserve_archive_snapshot_resource(
            &self.reference,
            &self.member,
            &self.snapshot,
        )?;
        store.settle_archive_snapshot_resource(&reservation, receipt)
    }

    pub(super) fn identity(&self, scope: &str) -> Result<&str> {
        ensure!(
            self.reference.scope == scope,
            "history_resource_wrong_scope"
        );
        Ok(&self.identity)
    }
}

impl crate::external_history::ExternalHistoryStore {
    /// Add only accounting to an existing pinned native reader. Reads do not require the ledger
    /// to be healthy; every writable descendant revalidates the exact original group instead.
    pub fn bind_reader_resource_budget(
        &self,
        mut reader: crate::external_history::ExternalHistoryReader,
        reference: &ResourceBudgetReference,
        member: &str,
    ) -> Result<crate::external_history::ExternalHistoryReader> {
        operation_id(member)?;
        let expected = self
            .directory
            .open_child(OsStr::new(&reader.binding.archive_id), false)?;
        let identity = reader.directory.directory_identity()?;
        ensure!(
            expected.directory_identity()? == identity,
            "history_resource_wrong_scope"
        );
        let budget = BudgetReader {
            store: self.directory.duplicate_handle()?,
            directory: reader.directory.duplicate_handle()?,
            directory_identity: identity.clone(),
            reference: reference.clone(),
            member: member.into(),
            archive: reader.binding.archive_id.clone(),
            snapshot: reader.binding.snapshot.clone(),
            receipt: reader.receipt()?,
            managed: reader.lifecycle.is_managed(),
            identity: hash(&(
                "history-accounted-reader/v1",
                &reference.scope,
                &reader.binding.archive_id,
                &identity,
            ))?,
        };
        reader.lifecycle.budget = Some(Arc::new(budget));
        Ok(reader)
    }
}

impl ArchiveReadGuard {
    pub(super) fn resource_binding(&self, scope: &str) -> Result<String> {
        match &self.budget {
            Some(budget) => Ok(budget.identity(scope)?.into()),
            None => hash(&self.binding(scope)?),
        }
    }
}

impl crate::external_history::ExternalHistoryReader {
    /// Preserve old evidence reads while requiring explicit budget authority for new writes.
    pub fn require_resource_budget(mut self) -> Self {
        self.lifecycle.require_budget = true;
        self
    }
}
