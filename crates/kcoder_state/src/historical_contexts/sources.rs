//! Native preparation descendants retain source epochs independently of their copied bytes.
use super::*;
use crate::external_history::{
    ExternalHistoryStore,
    lifecycle::{
        ArchiveReadGuard, ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveReferenceReceipt,
    },
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceReference {
    version: u8,
    binding: String,
    receipt: ArchiveReferenceReceipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retired {
    version: u8,
    operation: String,
    binding: String,
}
impl HistoricalContextStore {
    fn source_archives(&self) -> Result<ExternalHistoryStore> {
        let root = self
            .path
            .parent()
            .context("history_context_store_owner_changed")?;
        ensure!(
            PrivateDirectory::open_existing(root)?.directory_identity()? == self.owner.profile,
            "history_context_store_owner_changed"
        );
        ExternalHistoryStore::open_existing(root)?
            .context("history_context_preparation_source_missing")
    }
    pub(super) fn source_binding(
        &self,
        id: &str,
        body: &str,
        binding: &str,
        guards: &[ArchiveReadGuard],
    ) -> Result<Option<String>> {
        ensure!(
            guards.len() <= 256,
            "history_context_preparation_source_budget_exceeded"
        );
        if guards.iter().all(|guard| !guard.is_managed()) {
            return Ok(None);
        }
        Ok(Some(self.fixed_source_binding(id, body, binding)?))
    }
    pub(super) fn fixed_source_binding(
        &self,
        id: &str,
        body: &str,
        binding: &str,
    ) -> Result<String> {
        Ok(hash(&encoded(
            &(
                "preparation-source-reference/1",
                &self.owner,
                id,
                body,
                binding,
            ),
            META,
        )?))
    }
    fn source_reference(
        &self,
        directory: &PrivateDirectory,
        intent: &Intent,
    ) -> Result<Option<SourceReference>> {
        ensure!(
            optional(directory, "source-retired.json", META)?.is_none(),
            "history_context_preparation_retired"
        );
        let Some(binding) = &intent.source_reference else {
            return Ok(None);
        };
        let value: SourceReference = read_json(directory, "source-reference.json", META)?;
        ensure!(
            value.version == 1
                && &value.binding == binding
                && value.receipt.matches_owner(
                    ArchiveReferenceKind::Preparation,
                    &intent.id,
                    binding
                ),
            "history_context_preparation_source_changed"
        );
        Ok(Some(value))
    }
    pub(super) fn pin_sources(
        &self,
        directory: &PrivateDirectory,
        intent: &Intent,
        guards: &[ArchiveReadGuard],
    ) -> Result<()> {
        ensure!(
            optional(directory, "source-retired.json", META)?.is_none(),
            "history_context_preparation_retired"
        );
        let Some(binding) = &intent.source_reference else {
            return Ok(());
        };
        let archives = self.source_archives()?;
        let owner =
            ArchiveReferenceOwner::new(ArchiveReferenceKind::Preparation, &intent.id, binding)?;
        if optional(directory, "source-reference.json", META)?.is_some() {
            let prior = self
                .source_reference(directory, intent)?
                .context("history_context_preparation_source_changed")?;
            return archives.verify_archive_reference(&prior.receipt);
        }
        let managed = guards
            .iter()
            .filter(|guard| guard.is_managed())
            .cloned()
            .collect::<Vec<_>>();
        ensure!(
            !managed.is_empty(),
            "history_context_preparation_source_recovery_required"
        );
        let receipt = match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &managed)?,
        };
        exact(
            directory,
            "source-reference.json",
            &encoded(
                &SourceReference {
                    version: 1,
                    binding: binding.clone(),
                    receipt,
                },
                META,
            )?,
        )
    }
    pub(super) fn source_guards(
        &self,
        directory: &PrivateDirectory,
        intent: &Intent,
    ) -> Result<Vec<ArchiveReadGuard>> {
        let Some(reference) = self.source_reference(directory, intent)? else {
            return Ok(Vec::new());
        };
        let archives = self.source_archives()?;
        reference
            .receipt
            .archive_ids()
            .iter()
            .map(|id| {
                archives
                    .reader_with_reference(id, &reference.receipt)
                    .map(|reader| reader.lifecycle_guard())
            })
            .collect()
    }
    /// Retain immutable copied payloads and their original receipt. Only this
    /// preparation's source reference is released after dependents and readers leave.
    pub fn retire(&self, id: &str, operation: &str) -> Result<()> {
        check_id(id)?;
        check_id(operation)?;
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("history_context_preparation_busy")?;
        let directory = self.directory(id)?;
        let intent = self.intent(&directory, id)?;
        let binding = intent
            .source_reference
            .as_ref()
            .context("history_context_preparation_retirement_legacy_retained")?;
        let reference: SourceReference = read_json(&directory, "source-reference.json", META)?;
        ensure!(
            reference.version == 1
                && &reference.binding == binding
                && reference
                    .receipt
                    .matches_owner(ArchiveReferenceKind::Preparation, id, binding),
            "history_context_preparation_source_changed"
        );
        let archives = self.source_archives()?;
        if let Some(bytes) = optional(&directory, "source-retired.json", META)? {
            let retired: Retired = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("history_context_preparation_invalid_metadata"))?;
            ensure!(
                retired.version == 1
                    && retired.operation == operation
                    && retired.binding == *binding,
                "history_context_preparation_retirement_conflict"
            );
            return archives.release_archive_reference(&reference.receipt);
        }
        archives
            .archive_reference_release_guard(&reference.receipt)?
            .commit(|| {
                exact(
                    &directory,
                    "source-retired.json",
                    &encoded(
                        &Retired {
                            version: 1,
                            operation: operation.into(),
                            binding: binding.clone(),
                        },
                        META,
                    )?,
                )
            })
    }
}
