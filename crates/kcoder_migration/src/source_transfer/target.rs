mod admission;
mod adoption;
#[cfg(test)]
pub(super) use adoption::{AFTER_ADOPTION_CHECKPOINT_READ, FAIL_AFTER_PREVIEW_PUBLICATION};
mod attempts;
mod binding;
mod received;
mod recovery;
pub use adoption::{
    ReceivedAdoptionControl, ReceivedAdoptionJob, ReceivedAdoptionLease, ReceivedAdoptionPhase,
    ReceivedAdoptionScope, ReceivedAdoptionSelection, ReceivedAdoptionState,
    ReceivedAdoptionWorkerState, ReceivedInstructionAdoptionMapping, ReceivedProjectMapping,
};
pub use attempts::{
    TransferAttemptKind, TransferAttemptLease, TransferAttemptRecord, TransferAttemptView,
};
pub use binding::TransferredConfigurationBinding;
pub use received::{
    ReceivedAssetBinding, ReceivedProjectTarget, ReceivedSourceClass, ReceivedSourcePage,
    ReceivedSourceSummary,
};
pub(crate) use received::{
    ReceivedHistoryBinding, ReceivedInstructionGraphBinding, ReceivedPluginArchive,
    ReceivedProjectInventoryBinding,
};
pub use recovery::{RecoveredTargetTransfer, TransferTargetProgress, TransferTargetSummary};

use super::{
    model::*,
    source::{payload_name, verify_payload},
    storage::*,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DestinationGrant {
    destination: TransferDestination,
    source: TransferAuthority,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    admission_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admission: Option<Anchor>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    attempts_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempts: Option<attempts::AttemptBirth>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    adoptions: std::collections::BTreeMap<String, Option<Anchor>>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Parts {
    hashes: Vec<String>,
}

pub struct IncomingTransfers {
    store: Store,
}
impl IncomingTransfers {
    pub(super) fn open_existing_private_credentials(
        profile: &Path,
        identity: &str,
        authority: &TransferAuthority,
    ) -> Result<Self> {
        Ok(Self {
            store: Store::reopen_existing(profile, identity, authority, "incoming")?,
        })
    }
    pub(super) fn private_credential_existing_store(&self) -> Result<Store> {
        self.store.verify_authority()?;
        Ok(self.store.clone())
    }

    pub(super) fn private_credential_scope(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        receipt: &TransferReceipt,
        entry_id: &str,
    ) -> Result<(Store, TransferredConfigurationBinding, TransferManifest)> {
        let (_, manifest) = self.ready(request_id, authenticated_source, receipt)?;
        let binding =
            self.configuration_binding(request_id, authenticated_source, entry_id, receipt)?;
        Ok((self.store.clone(), binding, manifest))
    }
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open(profile, "incoming")?,
        })
    }
    pub fn authority(&self) -> &TransferAuthority {
        &self.store.authority
    }
    fn scope(&self) -> Result<String> {
        digest(&(
            "source-transfer.target/1",
            &self.store.identity,
            &self.store.authority,
        ))
    }

    /// The host obtains this source identity from its authenticated Native peer connection.
    /// A manifest's self-declared source identity must never supply authenticated_source.
    /// grant_id is the fixed transfer request UUID; authorization cannot fan out to new jobs.
    pub fn issue_destination(
        &self,
        grant_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<TransferDestination> {
        self.store.require_creation()?;
        valid_uuid(grant_id)?;
        authenticated_source.validate()?;
        let destination = TransferDestination {
            grant_id: grant_id.into(),
            authority: self.store.authority.clone(),
            scope: self.scope()?,
        };
        let root = self.store.root()?;
        let _lease = lease(&root, "grants.lock")?;
        let name = format!("grant-{grant_id}.json");
        if let Some(mut old) = load::<DestinationGrant>(&root, &name)? {
            ensure!(
                old.destination == destination && old.source == *authenticated_source,
                "source_transfer_binding_changed"
            );
            self.ensure_admission(&root, &name, &mut old)?;
            return Ok(destination);
        }
        let mut grant = DestinationGrant {
            destination: destination.clone(),
            source: authenticated_source.clone(),
            admission_required: false,
            admission: None,
            attempts_required: false,
            attempts: None,
            adoptions: Default::default(),
        };
        if load::<DestinationGrant>(&root, &name)?.is_none() {
            ensure!(
                root.count_regular_files_bounded(
                    |name| name
                        .to_str()
                        .is_some_and(|name| name.starts_with("grant-") && name.ends_with(".json")),
                    256
                )? < 256,
                "source_transfer_grant_limit"
            );
        }
        // Publish the pending birth before any controller can be exposed. A crash
        // leaves an explicit unknown admission, never an implicitly enabled grant.
        self.ensure_admission(&root, &name, &mut grant)?;
        Ok(destination)
    }
    fn authorize(
        &self,
        manifest: &TransferManifest,
        authenticated_source: &TransferAuthority,
    ) -> Result<()> {
        manifest.validate()?;
        authenticated_source.validate()?;
        let root = self.store.root()?;
        let grant: DestinationGrant = load(
            &root,
            &format!("grant-{}.json", manifest.destination.grant_id),
        )?
        .context("source_transfer_destination_unavailable")?;
        ensure!(
            manifest.source == *authenticated_source
                && grant.source == *authenticated_source
                && grant.destination == manifest.destination
                && manifest.destination.authority == self.store.authority
                && manifest.destination.scope == self.scope()?,
            "source_transfer_authority_changed"
        );
        Ok(())
    }
    fn existing(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<(PrivateDirectory, TransferManifest)> {
        let directory = self.store.existing(request_id)?;
        let manifest: TransferManifest =
            load(&directory, "manifest.json")?.context("source_transfer_recovery_required")?;
        self.authorize(&manifest, authenticated_source)?;
        ensure!(
            manifest.request_id == request_id,
            "source_transfer_request_changed"
        );
        let anchor: Anchor =
            load(&directory, "binding.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            anchor.binding == manifest.digest()?,
            "source_transfer_manifest_changed"
        );
        Ok((directory, manifest))
    }

    pub fn begin(
        &self,
        manifest: &TransferManifest,
        authenticated_source: &TransferAuthority,
    ) -> Result<TransferState> {
        let admission = self.admission(&manifest.request_id)?;
        let _admission_writer = admission
            .as_ref()
            .map(|directory| operation_lease(directory, "writer.lock"))
            .transpose()?;
        self.admission_active(&manifest.request_id)?;
        self.authorize(manifest, authenticated_source)?;
        let binding = manifest.digest()?;
        self.store
            .reserve(&manifest.request_id, &binding, manifest.total_bytes())?;
        let directory = self.store.operation(&manifest.request_id, &binding, true)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        exact(&directory, "manifest.json", manifest)?;
        active(&directory)?;
        for entry in &manifest.entries {
            active(&directory)?;
            self.admission_active(&manifest.request_id)?;
            if load::<Parts>(&directory, &parts_name(entry))?.is_some() {
                continue;
            }
            let name = payload_name(entry);
            match directory.open_single_link_regular_file(OsStr::new(&name)) {
                Ok(file) => ensure!(
                    file.metadata()?.len() == 0,
                    "source_transfer_outcome_unknown"
                ),
                Err(error) if missing(&error) => {
                    directory.atomic_publish_from_reader(
                        OsStr::new(&name),
                        &mut Cursor::new([]),
                        false,
                        || Ok(None),
                    )?;
                }
                Err(error) => return Err(error),
            }
            save(&directory, &parts_name(entry), &Parts::default())?;
        }
        self.state_at(&directory, manifest)
    }
    fn state_at(
        &self,
        directory: &PrivateDirectory,
        manifest: &TransferManifest,
    ) -> Result<TransferState> {
        let receipt = load::<TransferReceipt>(directory, "receipt.json")?;
        if let Some(receipt) = &receipt {
            ensure!(
                receipt == &expected_receipt(manifest)?,
                "source_transfer_receipt_changed"
            );
        }
        Ok(control(directory)?.state(receipt.is_some()))
    }
    pub fn state(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<TransferState> {
        let (directory, manifest) = self.existing(request_id, authenticated_source)?;
        self.state_at(&directory, &manifest)
    }
    pub fn state_if_exists(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<Option<TransferState>> {
        authenticated_source.validate()?;
        if !self.store.has_operation(request_id)? {
            return Ok(None);
        }
        self.state(request_id, authenticated_source).map(Some)
    }
    pub fn writer_busy(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<bool> {
        let (directory, _) = self.existing(request_id, authenticated_source)?;
        Ok(try_operation_lease(&directory, "writer.lock")?.is_none())
    }
    pub fn cancel(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        command_id: &str,
    ) -> Result<TransferState> {
        self.cancel_target(request_id, authenticated_source, command_id)?;
        self.state_if_exists(request_id, authenticated_source)?
            .or(self.admission_state(request_id)?)
            .context("source_transfer_recovery_required")
    }
    pub fn resume(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        sequence: u64,
        watermark: u64,
    ) -> Result<TransferState> {
        ensure!(
            self.admission_state(request_id)?.is_none(),
            "source_transfer_admission_control_required"
        );
        resume(
            &self.existing(request_id, authenticated_source)?.0,
            sequence,
            watermark,
        )
    }

    pub fn part_receipt(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
    ) -> Result<TransferPartReceipt> {
        let (directory, manifest) = self.existing(request_id, authenticated_source)?;
        let entry = find_entry(&manifest, entry_id)?;
        let parts = read_parts(&directory, entry)?;
        let bytes = accepted_bytes(&parts, entry);
        let length = directory
            .open_single_link_regular_file(OsStr::new(&payload_name(entry)))?
            .metadata()?
            .len();
        ensure!(
            length >= bytes && length <= entry.bytes,
            "source_transfer_payload_changed"
        );
        Ok(TransferPartReceipt {
            manifest_sha256: manifest.digest()?,
            entry_id: entry_id.into(),
            accepted_parts: parts.hashes.len() as u32,
            accepted_bytes: bytes,
        })
    }

    /// Repeated part requests reconcile exact persisted bytes. An unacknowledged prefix is
    /// appended only after comparing it to the same proposed chunk; no overwrite/truncate.
    pub fn write_part(
        &self,
        authenticated_source: &TransferAuthority,
        chunk: &TransferChunk,
    ) -> Result<TransferPartReceipt> {
        let admission = self.admission(&chunk.request_id)?;
        let _admission_writer = admission
            .as_ref()
            .map(|directory| operation_lease(directory, "writer.lock"))
            .transpose()?;
        self.admission_active(&chunk.request_id)?;
        let (directory, manifest) = self.existing(&chunk.request_id, authenticated_source)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        active(&directory)?;
        ensure!(
            manifest.digest()? == chunk.manifest_sha256,
            "source_transfer_manifest_changed"
        );
        let entry = find_entry(&manifest, &chunk.entry_id)?;
        let offset = u64::from(chunk.index) * TRANSFER_CHUNK_BYTES as u64;
        ensure!(offset < entry.bytes, "source_transfer_invalid_chunk");
        let length = (entry.bytes - offset).min(TRANSFER_CHUNK_BYTES as u64) as usize;
        ensure!(
            chunk.bytes().len() == length
                && format!("{:x}", Sha256::digest(chunk.bytes())) == chunk.sha256,
            "source_transfer_invalid_chunk"
        );
        let mut parts = read_parts(&directory, entry)?;
        let index = chunk.index as usize;
        ensure!(index <= parts.hashes.len(), "source_transfer_part_gap");
        let mut file = directory.open_read_write_file(OsStr::new(&payload_name(entry)), false)?;
        let current = file.metadata()?.len();
        if index < parts.hashes.len() {
            ensure!(
                parts.hashes[index] == chunk.sha256 && current >= accepted_bytes(&parts, entry),
                "source_transfer_payload_changed"
            );
            file.seek(SeekFrom::Start(offset))?;
            let mut saved = zeroize::Zeroizing::new(vec![0; length]);
            file.read_exact(&mut saved)?;
            ensure!(&saved[..] == chunk.bytes(), "source_transfer_part_changed");
        } else {
            ensure!(
                load::<TransferReceipt>(&directory, "receipt.json")?.is_none(),
                "source_transfer_already_ready"
            );
            ensure!(
                current >= offset && current <= offset + length as u64,
                "source_transfer_outcome_unknown"
            );
            let existing = (current - offset) as usize;
            file.seek(SeekFrom::Start(offset))?;
            let mut saved = zeroize::Zeroizing::new(vec![0; existing]);
            file.read_exact(&mut saved)?;
            ensure!(
                saved[..] == chunk.bytes()[..existing],
                "source_transfer_outcome_unknown"
            );
            file.seek(SeekFrom::End(0))?;
            file.write_all(&chunk.bytes()[existing..])?;
            file.sync_all()?;
            let _controller = operation_lease(&directory, "control.lock")?;
            let _admission_controller = admission
                .as_ref()
                .map(|directory| operation_lease(directory, "control.lock"))
                .transpose()?;
            active(&directory)?;
            self.admission_active(&chunk.request_id)?;
            parts.hashes.push(chunk.sha256.clone());
            save(&directory, &parts_name(entry), &parts)?;
        }
        Ok(TransferPartReceipt {
            manifest_sha256: chunk.manifest_sha256.clone(),
            entry_id: entry.id.clone(),
            accepted_parts: parts.hashes.len() as u32,
            accepted_bytes: accepted_bytes(&parts, entry),
        })
    }

    pub fn finish(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<TransferReceipt> {
        let admission = self.admission(request_id)?;
        let _admission_writer = admission
            .as_ref()
            .map(|directory| operation_lease(directory, "writer.lock"))
            .transpose()?;
        self.admission_active(request_id)?;
        let (directory, manifest) = self.existing(request_id, authenticated_source)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        active(&directory)?;
        for entry in &manifest.entries {
            let parts = read_parts(&directory, entry)?;
            ensure!(
                accepted_bytes(&parts, entry) == entry.bytes,
                "source_transfer_incomplete"
            );
            verify_payload(&directory, entry, &mut |bytes| {
                self.admission_active(request_id).is_ok() && check(bytes)
            })?;
        }
        let _controller = operation_lease(&directory, "control.lock")?;
        let _admission_controller = admission
            .as_ref()
            .map(|directory| operation_lease(directory, "control.lock"))
            .transpose()?;
        active(&directory)?;
        self.admission_active(request_id)?;
        let receipt = expected_receipt(&manifest)?;
        exact(&directory, "receipt.json", &receipt)?;
        Ok(receipt)
    }
    pub fn receipt(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
    ) -> Result<Option<TransferReceipt>> {
        let (directory, manifest) = self.existing(request_id, authenticated_source)?;
        self.state_at(&directory, &manifest)?;
        load(&directory, "receipt.json")
    }
    fn ready(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        receipt: &TransferReceipt,
    ) -> Result<(PrivateDirectory, TransferManifest)> {
        self.admission_active(request_id)?;
        let (directory, manifest) = self.existing(request_id, authenticated_source)?;
        active(&directory)?;
        ensure!(
            receipt == &expected_receipt(&manifest)?
                && load::<TransferReceipt>(&directory, "receipt.json")?.as_ref() == Some(receipt),
            "source_transfer_receipt_changed"
        );
        Ok((directory, manifest))
    }

    /// Returns uncommitted candidates only. Target policy, path mapping, credentials and
    /// installation remain independent Native migration validation/publication operations.
    pub fn configuration_inventory(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
    ) -> Result<crate::MigrationInventory> {
        self.configuration_inventory_checked(
            request_id,
            authenticated_source,
            entry_id,
            receipt,
            |_| true,
        )
    }
    pub(crate) fn configuration_inventory_checked(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<crate::MigrationInventory> {
        let (directory, manifest) = self.ready(request_id, authenticated_source, receipt)?;
        let entry = find_entry(&manifest, entry_id)?;
        let TransferContent::ConfigurationInventory {
            source,
            adapter_revision,
            ..
        } = &entry.content
        else {
            anyhow::bail!("source_transfer_not_configuration");
        };
        verify_payload(&directory, entry, &mut check)?;
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        ensure!(
            entry.bytes <= 8 * 1024 * 1024,
            "source_transfer_budget_exceeded"
        );
        let mut file = directory
            .open_single_link_regular_file(OsStr::new(&payload_name(entry)))?
            .take(entry.bytes + 1);
        let mut buffer = [0; TRANSFER_CHUNK_BYTES];
        loop {
            active(&directory)?;
            ensure!(check(bytes.len() as u64), "source_transfer_cancelled");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            ensure!(
                bytes.len() as u64 + count as u64 <= entry.bytes,
                "source_transfer_payload_changed"
            );
            bytes.extend_from_slice(&buffer[..count]);
        }
        ensure!(
            bytes.len() as u64 == entry.bytes
                && format!("{:x}", Sha256::digest(&*bytes)) == entry.sha256,
            "source_transfer_payload_changed"
        );
        let inventory: crate::MigrationInventory = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_inventory"))?;
        let current = match source {
            kcoder_types::migration::MigrationSourceKind::ClaudeCode => {
                crate::parse_claude_settings("{}")?
            }
            kcoder_types::migration::MigrationSourceKind::Codex => crate::parse_codex_config("")?,
        };
        let supported_revision = inventory.adapter_revision == current.adapter_revision
            || (*source == kcoder_types::migration::MigrationSourceKind::ClaudeCode
                && inventory.adapter_revision
                    == crate::configuration_layers::CLAUDE_LAYERS_REVISION)
            || (*source == kcoder_types::migration::MigrationSourceKind::Codex
                && inventory.adapter_revision
                    == crate::discovery::codex_layers::CODEX_LAYERS_REVISION)
            || (*source == kcoder_types::migration::MigrationSourceKind::Codex
                && matches!(
                    inventory.adapter_revision.as_str(),
                    "codex-profile-file/v1" | "codex-profile-table/v1"
                ));
        ensure!(
            inventory.source == *source
                && &inventory.adapter_revision == adapter_revision
                && supported_revision,
            "source_transfer_adapter_unsupported"
        );
        Ok(inventory)
    }

    pub fn work_asset(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
    ) -> Result<TransferredWorkAsset> {
        self.work_asset_checked(request_id, authenticated_source, entry_id, receipt, |_| {
            true
        })
    }

    pub(crate) fn work_asset_checked(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<TransferredWorkAsset> {
        let (directory, manifest) = self.ready(request_id, authenticated_source, receipt)?;
        let chosen = find_entry(&manifest, entry_id)?;
        let TransferContent::WorkAsset {
            source,
            source_identity,
            category,
            scope,
            asset,
            source_revision,
            memory_provenance,
            uploaded_source,
            ..
        } = &chosen.content
        else {
            anyhow::bail!("source_transfer_not_work_asset");
        };
        let prefix = &chosen.id[..6];
        let mut files = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        let mut executable = Vec::new();
        let mut total = 0u64;
        for entry in manifest
            .entries
            .iter()
            .filter(|entry| entry.id.starts_with(prefix))
        {
            let TransferContent::WorkAsset {
                source: from,
                category: class,
                scope: from_scope,
                asset: key,
                relative,
                source_revision: revision,
                source_executable,
                source_identity: identity,
                memory_provenance: origin,
                uploaded_source: uploaded_origin,
            } = &entry.content
            else {
                anyhow::bail!("source_transfer_asset_group_changed");
            };
            ensure!(
                from == source
                    && identity == source_identity
                    && origin == memory_provenance
                    && uploaded_origin == uploaded_source
                    && class == category
                    && from_scope == scope
                    && key == asset
                    && revision == source_revision
                    && names.insert(relative),
                "source_transfer_asset_group_changed"
            );
            total = total
                .checked_add(entry.bytes)
                .context("source_transfer_budget_exceeded")?;
            ensure!(
                total <= 32 * 1024 * 1024 && files.len() < TRANSFER_MAX_ENTRIES,
                "source_transfer_budget_exceeded"
            );
            verify_payload(&directory, entry, &mut check)?;
            let mut content = Vec::new();
            let mut file = directory
                .open_single_link_regular_file(OsStr::new(&payload_name(entry)))?
                .take(entry.bytes + 1);
            let mut buffer = [0; TRANSFER_CHUNK_BYTES];
            loop {
                active(&directory)?;
                ensure!(check(content.len() as u64), "source_transfer_cancelled");
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                ensure!(
                    content.len() as u64 + count as u64 <= entry.bytes,
                    "source_transfer_payload_changed"
                );
                content.extend_from_slice(&buffer[..count]);
            }
            ensure!(
                content.len() as u64 == entry.bytes
                    && format!("{:x}", Sha256::digest(&content)) == entry.sha256,
                "source_transfer_payload_changed"
            );
            if *source_executable {
                executable.push(relative.clone());
            }
            files.push(kcoder_skills::SkillPackageFile {
                relative_path: relative.into(),
                content,
                executable: false,
            });
        }
        ensure!(!files.is_empty(), "source_transfer_asset_group_changed");
        Ok(TransferredWorkAsset {
            source: *source,
            source_identity: source_identity.clone(),
            category: *category,
            source_scope: scope.clone(),
            source_revision: source_revision.clone(),
            source_executable_files: executable,
            asset: crate::asset_sources::SourceAsset {
                key: asset.clone(),
                name: if *category == kcoder_types::migration::MigrationCategory::Skill {
                    asset.clone()
                } else {
                    asset.trim_end_matches(".md").replace('/', "-")
                },
                files,
                native_reference: false,
            },
        })
    }

    /// Reuse raw-history binding, archive and parsers after receipt verification; no attachment
    /// supplement, tool replay or current permission is synthesized by relocation.
    pub fn history_binding(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<crate::history_sources::HistorySourceBinding> {
        let (directory, manifest) = self.ready(request_id, authenticated_source, receipt)?;
        let entry = find_entry(&manifest, entry_id)?;
        let TransferContent::History {
            snapshot,
            uploaded_source,
        } = &entry.content
        else {
            anyhow::bail!("source_transfer_not_history");
        };
        verify_payload(&directory, entry, &mut check)?;
        let path = self
            .store
            .profile
            .join("migrations/source-transfer/incoming")
            .join(request_id);
        ensure!(
            PrivateDirectory::open_existing(&path)?.directory_identity()?
                == directory.directory_identity()?,
            "source_transfer_owner_changed"
        );
        // Device/inode values can coincide on different hosts. Keep the original origin in
        // the private manifest and namespace the target lineage by the authenticated source.
        let mut received = snapshot.as_ref().clone();
        let scope = digest(&(
            "source-transfer.history-origin/1",
            &manifest.source,
            &snapshot.origin.source_instance,
        ))?;
        received.origin.source_instance = if uploaded_source.is_some() {
            format!("user-upload:received:{scope}")
        } else {
            scope
        };
        crate::history_sources::HistorySourceBinding::bind_transferred_snapshot(
            &path,
            Path::new(&payload_name(entry)),
            &received,
            &mut |bytes, _| active(&directory).is_ok() && check(bytes),
        )
        .map(|binding| binding.with_uploaded_source(uploaded_source.clone()))
    }
}

fn find_entry<'a>(manifest: &'a TransferManifest, id: &str) -> Result<&'a TransferEntry> {
    valid_id(id)?;
    manifest
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .context("source_transfer_unknown_entry")
}
fn parts_name(entry: &TransferEntry) -> String {
    format!("{}.parts.json", entry.id)
}
fn read_parts(directory: &PrivateDirectory, entry: &TransferEntry) -> Result<Parts> {
    let parts: Parts = load(directory, &parts_name(entry))?.context("source_transfer_preparing")?;
    ensure!(
        parts.hashes.len() as u64 <= entry.bytes.div_ceil(TRANSFER_CHUNK_BYTES as u64)
            && parts.hashes.iter().all(|hash| valid_sha(hash)),
        "source_transfer_invalid_metadata"
    );
    Ok(parts)
}
fn accepted_bytes(parts: &Parts, entry: &TransferEntry) -> u64 {
    (parts.hashes.len() as u64 * TRANSFER_CHUNK_BYTES as u64).min(entry.bytes)
}
fn expected_receipt(manifest: &TransferManifest) -> Result<TransferReceipt> {
    Ok(TransferReceipt {
        request_id: manifest.request_id.clone(),
        manifest_sha256: manifest.digest()?,
        entries: manifest.entries.len() as u32,
        bytes: manifest.total_bytes(),
    })
}
