//! A sealed receiving receipt is provenance, never a caller-supplied filesystem grant.
use super::super::*;
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceivedBinding {
    profile: PathBuf,
    profile_identity: String,
    target: TransferAuthority,
    source: TransferAuthority,
    receipt: TransferReceipt,
    entry: TransferEntry,
}
impl std::fmt::Debug for ReceivedBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceivedBinding")
            .field("request_id", &self.receipt.request_id)
            .field("entry_id", &self.entry.id)
            .finish_non_exhaustive()
    }
}
impl IncomingTransfers {
    /// Only a logical source anchor returned by the Native receipt catalog can
    /// become an adoption selection. Selecting one file cannot split a package.
    pub(crate) fn received_binding(
        &self,
        request: &str,
        expected_manifest: &str,
        entry_id: &str,
    ) -> Result<ReceivedBinding> {
        let grant = self.recover_target(request)?;
        let source = grant.source_authority();
        let receipt = self
            .receipt(request, source)?
            .context("source_transfer_not_ready")?;
        ensure!(
            receipt.manifest_sha256 == expected_manifest,
            "source_transfer_receipt_changed"
        );
        let (_, manifest) = self.ready(request, source, &receipt)?;
        let entry = find_entry(&manifest, entry_id)?;
        let group = &entry.id[..6];
        let grouped = manifest
            .entries
            .iter()
            .filter(|candidate| candidate.id.starts_with(group))
            .collect::<Vec<_>>();
        ensure!(
            grouped.first().is_some_and(|first| first.id == entry.id)
                && grouped
                    .iter()
                    .skip(1)
                    .all(|next| { super::same_asset_group(&entry.content, &next.content) }),
            "source_transfer_source_group_changed"
        );
        Ok(ReceivedBinding {
            profile: self.store.profile.clone(),
            profile_identity: self.store.identity.clone(),
            target: self.store.authority.clone(),
            source: source.clone(),
            receipt,
            entry: entry.clone(),
        })
    }
}
impl ReceivedBinding {
    pub(crate) fn profile(&self) -> &Path {
        &self.profile
    }
    pub(crate) fn receiver(&self) -> Result<IncomingTransfers> {
        Ok(IncomingTransfers {
            store: Store::reopen_existing(
                &self.profile,
                &self.profile_identity,
                &self.target,
                "incoming",
            )?,
        })
    }
    pub(crate) fn validate(&self) -> Result<IncomingTransfers> {
        let receiver = self.receiver()?;
        let restored = receiver.received_binding(
            &self.receipt.request_id,
            &self.receipt.manifest_sha256,
            &self.entry.id,
        )?;
        ensure!(&restored == self, "source_transfer_binding_changed");
        Ok(receiver)
    }
    pub(crate) fn entry(&self) -> &TransferEntry {
        &self.entry
    }
    pub(crate) fn source(&self) -> &TransferAuthority {
        &self.source
    }
    pub(crate) fn receipt(&self) -> &TransferReceipt {
        &self.receipt
    }
    pub(crate) fn verify_history_directory(&self, actual: &PrivateDirectory) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "source_transfer_wrong_consumer"
        );
        let expected = profile
            .open_child(OsStr::new("migrations"), false)?
            .open_child(OsStr::new("history"), false)?;
        actual.verify_private_directory()?;
        ensure!(
            actual.directory_identity()? == expected.directory_identity()?,
            "source_transfer_wrong_consumer"
        );
        Ok(())
    }
    /// Undo checks the original consumer without requiring the source bytes to
    /// remain available. Published domain receipts retain their own authority.
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "source_transfer_wrong_consumer"
        );
        let expected = profile.open_child(OsStr::new("migrations"), false)?;
        parent.verify_private_directory()?;
        ensure!(
            expected.directory_identity()? == parent.directory_identity()?,
            "source_transfer_wrong_consumer"
        );
        Ok(())
    }
}
