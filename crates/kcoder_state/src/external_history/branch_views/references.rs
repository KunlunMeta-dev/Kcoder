//! Private source pins precede branch publication and survive idle readers and process exits.
use super::*;
use crate::external_history::lifecycle::{
    ArchiveReadGuard, ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveReferenceReceipt,
};
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode};
use std::sync::Arc;
const FILE: &str = "source-reference.json";
const RETIRED: &str = "retired.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceReference {
    version: u8,
    binding: String,
    writer: PortableLeaseIdentity,
    lifecycle: PortableLeaseIdentity,
    receipt: ArchiveReferenceReceipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retired {
    version: u8,
    operation: String,
    binding: String,
    sequence: u64,
}
impl ExternalHistoryStore {
    pub(super) fn branch_source_guards(
        &self,
        recipe: &HistoricalBranchRecipe,
    ) -> Result<Vec<ArchiveReadGuard>> {
        recipe
            .sources
            .iter()
            .map(|source| {
                self.reader(&source.archive_id)
                    .map(|reader| reader.lifecycle_guard())
            })
            .collect()
    }
    pub(super) fn pin_branch(
        &self,
        directory: &PrivateDirectory,
        binding: &Binding,
        guards: &[ArchiveReadGuard],
        born: bool,
    ) -> Result<()> {
        ensure!(
            read_optional(directory, RETIRED, HEADER_BYTES as u64)?.is_none(),
            "history_branch_retired"
        );
        let managed = guards
            .iter()
            .filter(|guard| guard.is_managed())
            .cloned()
            .collect::<Vec<_>>();
        if managed.is_empty() {
            return Ok(());
        }
        let digest = hash(&encode(binding, HEADER_BYTES)?);
        let owner = ArchiveReferenceOwner::new(
            ArchiveReferenceKind::BranchView,
            &binding.view_id,
            &digest,
        )?;
        ensure!(
            born || self.archive_reference_for_owner(&owner)?.is_some(),
            "history_branch_ownership_unknown"
        );
        let receipt = self.retain_archive_reference(owner, &managed)?;
        let lifecycle = if let Some(bytes) = read_optional(directory, FILE, HEADER_BYTES as u64)? {
            let prior: SourceReference = decode(&bytes)?;
            ensure!(
                directory.portable_regular_identity(OsStr::new("lifecycle.lock"))?
                    == prior.lifecycle,
                "history_branch_source_reference_changed"
            );
            prior.lifecycle
        } else {
            drop(
                directory
                    .try_exclusive_lock(OsStr::new("lifecycle.lock"))?
                    .context("history_branch_busy")?,
            );
            directory.portable_regular_identity(OsStr::new("lifecycle.lock"))?
        };
        let value = SourceReference {
            version: 1,
            binding: digest,
            writer: directory.portable_regular_identity(OsStr::new("build.lock"))?,
            receipt,
            lifecycle,
        };
        publish_exact(
            directory,
            FILE,
            &encode(&value, HEADER_BYTES)?,
            HEADER_BYTES as u64,
        )
    }
    fn source_reference(
        &self,
        directory: &PrivateDirectory,
        binding: &Binding,
    ) -> Result<Option<SourceReference>> {
        ensure!(
            read_optional(directory, RETIRED, HEADER_BYTES as u64)?.is_none(),
            "history_branch_retired"
        );
        let Some(bytes) = read_optional(directory, FILE, HEADER_BYTES as u64)? else {
            return Ok(None);
        };
        let value: SourceReference = decode(&bytes)?;
        ensure!(
            value.version == 1
                && value.binding == hash(&encode(binding, HEADER_BYTES)?)
                && value.receipt.matches_owner(
                    ArchiveReferenceKind::BranchView,
                    &binding.view_id,
                    &value.binding
                )
                && directory.portable_regular_identity(OsStr::new("build.lock"))? == value.writer
                && directory.portable_regular_identity(OsStr::new("lifecycle.lock"))?
                    == value.lifecycle,
            "history_branch_source_reference_changed"
        );
        self.verify_archive_reference(&value.receipt)?;
        Ok(Some(value))
    }
    pub fn branch_source_reference(
        &self,
        view_id: &str,
    ) -> Result<Option<ArchiveReferenceReceipt>> {
        let directory = self.branch_directory(view_id, false)?;
        let binding = self.branch_binding(&directory, view_id)?;
        Ok(self
            .source_reference(&directory, &binding)?
            .map(|value| value.receipt))
    }
    pub(super) fn branch_read_fences(
        &self,
        directory: &PrivateDirectory,
        binding: &Binding,
    ) -> Result<(
        Vec<ArchiveReadGuard>,
        Option<Arc<kcoder_config::VerifiedPrivateLease>>,
    )> {
        let reference = self.source_reference(directory, binding)?;
        let lifecycle = reference
            .map(|reference| {
                directory
                    .try_existing_portable_lock(
                        OsStr::new("lifecycle.lock"),
                        &reference.lifecycle,
                        PrivateLeaseMode::Shared,
                    )?
                    .context("history_branch_busy")
                    .map(Arc::new)
            })
            .transpose()?;
        Ok((self.branch_source_guards(&binding.recipe)?, lifecycle))
    }
    /// Retire only this immutable view. Its audit/index files remain retained; raw
    /// collection can proceed only after every independent producer and reader releases.
    pub fn retire_branch(
        &self,
        view_id: &str,
        operation: &str,
        expected_sequence: u64,
    ) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(operation).is_ok_and(|id| id.to_string() == operation),
            "history_branch_invalid_retirement_operation"
        );
        let directory = self.branch_directory(view_id, false)?;
        let binding = self.branch_binding(&directory, view_id)?;
        let digest = hash(&encode(&binding, HEADER_BYTES)?);
        if let Some(bytes) = read_optional(&directory, RETIRED, HEADER_BYTES as u64)? {
            let receipt: Retired = decode(&bytes)?;
            ensure!(
                receipt.version == 1
                    && receipt.binding == digest
                    && receipt.operation == operation
                    && receipt.sequence == expected_sequence,
                "history_branch_retirement_operation_conflict"
            );
            // A lost source-pin release acknowledgement is reconciled from this
            // original tombstone; matching directory bytes do not create a new owner.
            let source: SourceReference = decode(
                &read_optional(&directory, FILE, HEADER_BYTES as u64)?
                    .context("history_branch_source_reference_changed")?,
            )?;
            ensure!(
                source.version == 1
                    && source.binding == digest
                    && source.receipt.matches_owner(
                        ArchiveReferenceKind::BranchView,
                        &binding.view_id,
                        &digest
                    ),
                "history_branch_source_reference_changed"
            );
            return self.release_archive_reference(&source.receipt);
        }
        let source = self
            .source_reference(&directory, &binding)?
            .context("history_branch_retirement_legacy_retained")?;
        let _lifecycle = directory
            .try_existing_portable_lock(
                OsStr::new("lifecycle.lock"),
                &source.lifecycle,
                PrivateLeaseMode::Exclusive,
            )?
            .context("history_branch_busy")?;
        let _writer = directory
            .try_existing_portable_lock(
                OsStr::new("build.lock"),
                &source.writer,
                PrivateLeaseMode::Exclusive,
            )?
            .context("history_branch_busy")?;
        ensure!(
            self.branch_reference_dependents(&source.receipt)? == 0,
            "history_branch_retirement_referenced"
        );
        let scope = format!("historical-branch/v1:{digest}");
        let opened =
            files::open_database_in(directory.duplicate_handle()?, &scope, false, DATABASE_BYTES)?
                .context("history_branch_not_ready")?;
        let progress = header(&opened.connection, &digest)?.progress;
        ensure!(
            progress.sequence == expected_sequence,
            "history_branch_revision_conflict"
        );
        let retired = Retired {
            version: 1,
            operation: operation.into(),
            binding: digest,
            sequence: expected_sequence,
        };
        publish_exact(
            &directory,
            RETIRED,
            &encode(&retired, HEADER_BYTES)?,
            HEADER_BYTES as u64,
        )?;
        self.release_archive_reference(&source.receipt)
    }
}
