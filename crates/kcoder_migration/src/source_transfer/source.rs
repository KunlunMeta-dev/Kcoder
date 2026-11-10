use super::{model::*, storage::*};
use crate::{
    asset_sources::AssetBundleBinding, discovery::ConfigurationBinding,
    history_discovery::HistoryPendingSelection, history_sources::HistorySourceBinding,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Cursor, Read, Seek, SeekFrom},
    path::Path,
};

mod instructions;
mod plugin;
mod projects;
pub use instructions::{InstructionExportBinding, InstructionExportSelection};
/// Native grants only. Do not accept these bindings as client/RPC input.
pub enum ExportSelection {
    Project(crate::project_migration::ProjectBatchSource),
    Instructions(InstructionExportSelection),
    Plugin(crate::plugin_migration::PluginExportSelection),
    Configuration(ConfigurationBinding),
    Asset {
        binding: AssetBundleBinding,
        key: String,
    },
    History(HistoryPendingSelection),
    CapturedHistory(HistorySourceBinding),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SavedSelection {
    Project {
        binding: crate::project_migration::ProjectBatchSource,
    },
    Instructions {
        descriptor: instructions::InstructionExportDescriptor,
    },
    Plugin {
        selection: crate::plugin_migration::PluginExportSelection,
    },
    Configuration {
        binding: ConfigurationBinding,
    },
    Asset {
        binding: AssetBundleBinding,
        key: String,
        revision: String,
        bytes: u64,
    },
    History {
        selection: HistoryPendingSelection,
    },
    CapturedHistory {
        binding: HistorySourceBinding,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    source: TransferAuthority,
    destination: TransferDestination,
    intent: String,
    selections: Vec<SavedSelection>,
}

pub struct SourceTransfers {
    store: Store,
}
impl SourceTransfers {
    pub(super) fn private_credential_existing_store(&self) -> Result<Store> {
        self.store.verify_authority()?;
        Ok(self.store.clone())
    }

    pub(super) fn private_credential_scope(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        entry_id: &str,
    ) -> Result<(
        Store,
        ConfigurationBinding,
        TransferManifest,
        PrivateDirectory,
    )> {
        let (directory, request) = self.request(request_id, destination)?;
        let manifest = self
            .manifest(request_id, destination)?
            .context("source_transfer_not_ready")?;
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .context("private_credentials_source_not_selected")?;
        let TransferContent::ConfigurationInventory {
            source_identity,
            source_binding_revision,
            ..
        } = &entry.content
        else {
            anyhow::bail!("private_credentials_source_not_selected");
        };
        let binding = request
            .selections
            .iter()
            .find_map(|selection| match selection {
                SavedSelection::Configuration { binding }
                    if binding.logical_identity() == *source_identity
                        && digest(binding).ok().as_ref() == Some(source_binding_revision) =>
                {
                    Some(binding.clone())
                }
                _ => None,
            })
            .context("private_credentials_source_not_selected")?;
        Ok((self.store.clone(), binding, manifest, directory))
    }
    /// Reopen a born export role without repairing missing authority or directories.
    pub fn open_existing(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open_existing(profile, "exports")?,
        })
    }
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open(profile, "exports")?,
        })
    }
    pub fn authority(&self) -> &TransferAuthority {
        &self.store.authority
    }
    /// Pure observation of the originally captured OS/profile authority; never repairs it.
    pub fn verify_authority(&self) -> Result<()> {
        self.store.verify_authority().map(drop)
    }
    pub fn prepared_destination(
        &self,
        request_id: &str,
        authenticated_target: &TransferAuthority,
    ) -> Result<Option<TransferDestination>> {
        authenticated_target.validate()?;
        if !self.store.has_operation(request_id)? {
            return Ok(None);
        }
        let directory = self.store.existing(request_id)?;
        let request: Request =
            load(&directory, "request.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            &request.destination.authority == authenticated_target,
            "source_transfer_authority_changed"
        );
        self.request(request_id, &request.destination)?;
        Ok(Some(request.destination))
    }
    pub fn capture_running(
        &self,
        request_id: &str,
        destination: &TransferDestination,
    ) -> Result<bool> {
        let (directory, _) = self.request(request_id, destination)?;
        Ok(try_operation_lease(&directory, "writer.lock")?.is_none())
    }
    pub fn cancellation_watermark(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        command_id: &str,
    ) -> Result<Option<u64>> {
        valid_uuid(command_id)?;
        let (directory, _) = self.request(request_id, destination)?;
        Ok(control(&directory)?
            .commands
            .iter()
            .position(|id| id == command_id)
            .map(|index| index as u64 + 1))
    }

    /// Persist the accepted grants before large history hashing/copying starts.
    pub fn prepare(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        selections: Vec<ExportSelection>,
    ) -> Result<TransferState> {
        valid_uuid(request_id)?;
        valid_uuid(&destination.grant_id)?;
        ensure!(
            destination.grant_id == request_id,
            "source_transfer_request_changed"
        );
        destination.authority.validate()?;
        ensure!(
            valid_sha(&destination.scope) && !selections.is_empty() && selections.len() <= 64,
            "source_transfer_budget_exceeded"
        );
        let intent = digest(
            &selections
                .iter()
                .map(|selection| match selection {
                    ExportSelection::Instructions(selection) => {
                        digest(&("instruction-graph", selection.descriptor()))
                    }
                    ExportSelection::Project(binding) => digest(&("project-inventory", binding)),
                    ExportSelection::Plugin(binding) => digest(&("plugin", binding)),
                    ExportSelection::Configuration(binding) => digest(&("configuration", binding)),
                    ExportSelection::Asset { binding, key } => {
                        ensure!(
                            !binding.is_scoped_instruction(),
                            "source_transfer_scoped_instructions_update_required"
                        );
                        digest(&("asset", binding, key))
                    }
                    ExportSelection::History(selection) => digest(&("history", selection)),
                    ExportSelection::CapturedHistory(binding) => {
                        digest(&("captured-history", binding))
                    }
                })
                .collect::<Result<Vec<_>>>()?,
        )?;
        let catalog = self.store.root()?;
        if load::<Anchor>(&catalog, &format!("{request_id}.json"))?.is_some() {
            let (directory, previous) = self.request(request_id, destination)?;
            ensure!(previous.intent == intent, "source_transfer_request_changed");
            if selections
                .iter()
                .any(|item| matches!(item, ExportSelection::Instructions(_)))
                && self.manifest(request_id, destination)?.is_none()
            {
                let _writer = operation_lease(&directory, "writer.lock")?;
                for (index, item) in selections.iter().enumerate() {
                    if let ExportSelection::Instructions(selection) = item
                        && load::<Vec<TransferEntry>>(
                            &directory,
                            &format!("selection-{index:04}.json"),
                        )?
                        .is_none()
                    {
                        selection.publish_origin(&directory, index)?;
                    }
                }
            }
            return self.state_at(&directory);
        }
        let mut saved = Vec::new();
        let mut instruction_origins = Vec::new();
        for selection in selections {
            saved.push(match selection {
                ExportSelection::Instructions(selection) => {
                    instruction_origins.push((saved.len(), selection.clone()));
                    SavedSelection::Instructions {
                        descriptor: selection.descriptor().clone(),
                    }
                }
                ExportSelection::Project(binding) => SavedSelection::Project { binding },
                ExportSelection::Plugin(selection) => SavedSelection::Plugin { selection },
                ExportSelection::Configuration(binding) => {
                    SavedSelection::Configuration { binding }
                }
                ExportSelection::History(selection) => SavedSelection::History { selection },
                ExportSelection::CapturedHistory(binding) => {
                    SavedSelection::CapturedHistory { binding }
                }
                ExportSelection::Asset { binding, key } => {
                    ensure!(
                        !binding.is_scoped_instruction(),
                        "source_transfer_scoped_instructions_update_required"
                    );
                    valid_relative(&key)?;
                    ensure!(
                        matches!(
                            binding.category,
                            kcoder_types::migration::MigrationCategory::Skill
                                | kcoder_types::migration::MigrationCategory::Command
                                | kcoder_types::migration::MigrationCategory::Instructions
                                | kcoder_types::migration::MigrationCategory::Memory
                                | kcoder_types::migration::MigrationCategory::Agent
                                | kcoder_types::migration::MigrationCategory::Hook
                        ),
                        "source_transfer_asset_kind_unsupported"
                    );
                    let asset = binding.read(&key)?;
                    let revision = asset.revision();
                    let bytes = asset
                        .files
                        .iter()
                        .map(|file| file.content.len() as u64)
                        .sum();
                    SavedSelection::Asset {
                        binding,
                        key,
                        revision,
                        bytes,
                    }
                }
            });
        }
        let request = Request {
            source: self.store.authority.clone(),
            destination: destination.clone(),
            intent,
            selections: saved,
        };
        let binding = digest(&request)?;
        let mut reserved = 0u64;
        for selection in &request.selections {
            let bytes = match selection {
                SavedSelection::Instructions { descriptor } => descriptor.reserved_bytes()?,
                SavedSelection::Project { .. } => {
                    crate::project_migration::transfer::PROJECT_TRANSFER_MAX_BYTES
                }
                SavedSelection::Plugin { selection } => selection.reserved_bytes()?,
                SavedSelection::Configuration { .. } => 8 * 1024 * 1024,
                SavedSelection::Asset { bytes, .. } => *bytes,
                SavedSelection::History { selection } => selection.bound_bytes(),
                SavedSelection::CapturedHistory { binding } => binding
                    .snapshot()
                    .original
                    .as_ref()
                    .map_or(binding.snapshot().source_bytes, |original| original.bytes),
            };
            reserved = reserved
                .checked_add(bytes)
                .context("source_transfer_budget_exceeded")?;
        }
        self.store.reserve(request_id, &binding, reserved)?;
        let directory = self.store.operation(request_id, &binding, true)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        // Stable requests cannot change selections, destination or source account after a lost reply.
        if let Some(previous) = load::<Request>(&directory, "request.json")? {
            ensure!(
                digest(&previous)? == binding,
                "source_transfer_request_changed"
            );
        } else {
            save(&directory, "request.json", &request)?;
        }
        for (index, selection) in instruction_origins {
            selection.publish_origin(&directory, index)?;
        }
        self.state_at(&directory)
    }

    fn request(
        &self,
        request_id: &str,
        destination: &TransferDestination,
    ) -> Result<(PrivateDirectory, Request)> {
        let directory = self.store.existing(request_id)?;
        let request: Request =
            load(&directory, "request.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            request.source == self.store.authority && &request.destination == destination,
            "source_transfer_authority_changed"
        );
        let anchor: Anchor =
            load(&directory, "binding.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            anchor.binding == digest(&request)?,
            "source_transfer_binding_changed"
        );
        Ok((directory, request))
    }
    fn state_at(&self, directory: &PrivateDirectory) -> Result<TransferState> {
        Ok(
            control(directory)?
                .state(load::<TransferReceipt>(directory, "receipt.json")?.is_some()),
        )
    }
    pub fn state(
        &self,
        request_id: &str,
        destination: &TransferDestination,
    ) -> Result<TransferState> {
        self.state_at(&self.request(request_id, destination)?.0)
    }
    pub fn cancel(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        command_id: &str,
    ) -> Result<TransferState> {
        cancel(&self.request(request_id, destination)?.0, command_id)
    }
    pub fn resume(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        sequence: u64,
        watermark: u64,
    ) -> Result<TransferState> {
        resume(
            &self.request(request_id, destination)?.0,
            sequence,
            watermark,
        )
    }

    pub fn capture(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<TransferManifest> {
        let (directory, request) = self.request(request_id, destination)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        active(&directory)?;
        if let Some(manifest) = load::<TransferManifest>(&directory, "manifest.json")? {
            self.verify_manifest(&directory, &manifest, &mut check)?;
            self.publish_receipt(&directory, &manifest)?;
            return Ok(manifest);
        }
        let mut entries = Vec::new();
        for (index, selection) in request.selections.iter().enumerate() {
            active(&directory)?;
            ensure!(
                check(
                    entries
                        .iter()
                        .map(|entry: &TransferEntry| entry.bytes)
                        .sum()
                ),
                "source_transfer_cancelled"
            );
            let selected_name = format!("selection-{index:04}.json");
            if let Some(existing) = load::<Vec<TransferEntry>>(&directory, &selected_name)? {
                for entry in &existing {
                    if matches!(entry.content, TransferContent::PluginPackage { .. }) {
                        plugin::verify_generated(&directory, entry)?;
                    }
                    verify_payload(&directory, entry, &mut check)?;
                }
                entries.extend(existing);
                continue;
            }
            let mut selected = Vec::new();
            match selection {
                SavedSelection::Instructions { descriptor } => selected.push(
                    instructions::capture(&directory, index, descriptor, &mut check)?,
                ),
                SavedSelection::Project { binding } => {
                    selected.push(projects::capture(&directory, index, binding, &mut check)?)
                }
                SavedSelection::Plugin { selection } => {
                    selected.push(plugin::capture(&directory, index, selection, &mut check)?)
                }
                SavedSelection::Configuration { binding } => {
                    let inventory = binding.inventory()?;
                    let content = TransferContent::ConfigurationInventory {
                        source: binding.kind,
                        source_identity: binding.logical_identity(),
                        source_revision: binding.revision.clone(),
                        source_binding_revision: digest(binding)?,
                        source_scope: binding.source_scope().into(),
                        adapter_revision: inventory.adapter_revision.clone(),
                        uploaded_source: binding.uploaded_source()?,
                    };
                    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&inventory)?);
                    ensure!(
                        bytes.len() <= 8 * 1024 * 1024,
                        "source_transfer_budget_exceeded"
                    );
                    let entry = entry(index, 0, content, &bytes);
                    snapshot(&directory, &entry, &mut Cursor::new(&bytes[..]), &mut check)?;
                    selected.push(entry);
                }
                SavedSelection::Asset {
                    binding,
                    key,
                    revision,
                    ..
                } => {
                    ensure!(
                        !binding.is_scoped_instruction(),
                        "source_transfer_scoped_instructions_update_required"
                    );
                    let asset = binding.read(key)?;
                    ensure!(&asset.revision() == revision, "migration_source_changed");
                    ensure!(
                        entries.len() + asset.files.len() <= TRANSFER_MAX_ENTRIES,
                        "source_transfer_budget_exceeded"
                    );
                    let memory_provenance = binding.memory_provenance(&asset)?.map(Box::new);
                    for (file_index, file) in asset.files.into_iter().enumerate() {
                        let relative = file
                            .relative_path
                            .to_str()
                            .context("source_transfer_unsafe_path")?
                            .replace('\\', "/");
                        valid_relative(&relative)?;
                        let content = TransferContent::WorkAsset {
                            source: binding.kind,
                            source_identity: binding.stable_source_identity(),
                            category: binding.category,
                            scope: binding.scope.clone(),
                            asset: key.clone(),
                            relative,
                            source_revision: revision.clone(),
                            source_executable: file.executable,
                            memory_provenance: memory_provenance.clone(),
                            uploaded_source: binding.uploaded_source()?,
                        };
                        let bytes = zeroize::Zeroizing::new(file.content);
                        let entry = entry(index, file_index, content, &bytes);
                        snapshot(&directory, &entry, &mut Cursor::new(&bytes[..]), &mut check)?;
                        selected.push(entry);
                    }
                }
                SavedSelection::History { selection } => {
                    let binding = selection
                        .capture(&mut |bytes, _| active(&directory).is_ok() && check(bytes))?;
                    selected.push(snapshot_history(&directory, index, &binding, &mut check)?);
                }
                SavedSelection::CapturedHistory { binding } => {
                    selected.push(snapshot_history(&directory, index, binding, &mut check)?)
                }
            }
            ensure!(
                !selected.is_empty() && entries.len() + selected.len() <= TRANSFER_MAX_ENTRIES,
                "source_transfer_budget_exceeded"
            );
            exact(&directory, &selected_name, &selected)?;
            entries.extend(selected);
            ensure!(
                entries.iter().map(|entry| entry.bytes).sum::<u64>() <= TRANSFER_MAX_BYTES,
                "source_transfer_budget_exceeded"
            );
        }
        let manifest = TransferManifest {
            version: TRANSFER_VERSION,
            request_id: request_id.into(),
            source: request.source,
            destination: request.destination,
            entries,
        };
        manifest.validate()?;
        self.verify_manifest(&directory, &manifest, &mut check)?;
        let _controller = operation_lease(&directory, "control.lock")?;
        active(&directory)?;
        exact(&directory, "manifest.json", &manifest)?;
        self.publish_receipt(&directory, &manifest)?;
        Ok(manifest)
    }

    fn publish_receipt(
        &self,
        directory: &PrivateDirectory,
        manifest: &TransferManifest,
    ) -> Result<()> {
        exact(
            directory,
            "receipt.json",
            &TransferReceipt {
                request_id: manifest.request_id.clone(),
                manifest_sha256: manifest.digest()?,
                entries: manifest.entries.len() as u32,
                bytes: manifest.total_bytes(),
            },
        )
    }
    fn verify_manifest(
        &self,
        directory: &PrivateDirectory,
        manifest: &TransferManifest,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        manifest.validate()?;
        ensure!(
            manifest.source == self.store.authority,
            "source_transfer_authority_changed"
        );
        for entry in &manifest.entries {
            active(directory)?;
            if matches!(entry.content, TransferContent::PluginPackage { .. }) {
                plugin::verify_generated(directory, entry)?;
            }
            verify_payload(directory, entry, check)?;
        }
        Ok(())
    }
    pub fn manifest(
        &self,
        request_id: &str,
        destination: &TransferDestination,
    ) -> Result<Option<TransferManifest>> {
        let (directory, _) = self.request(request_id, destination)?;
        let manifest = load::<TransferManifest>(&directory, "manifest.json")?;
        if let Some(manifest) = &manifest {
            manifest.validate()?;
            ensure!(
                manifest.request_id == request_id
                    && manifest.source == self.store.authority
                    && &manifest.destination == destination,
                "source_transfer_binding_changed"
            );
        }
        Ok(manifest)
    }
    pub fn chunk(
        &self,
        request_id: &str,
        destination: &TransferDestination,
        manifest_sha256: &str,
        entry_id: &str,
        index: u32,
    ) -> Result<TransferChunk> {
        let (directory, _) = self.request(request_id, destination)?;
        active(&directory)?;
        let manifest = self
            .manifest(request_id, destination)?
            .context("source_transfer_not_ready")?;
        ensure!(
            manifest.digest()? == manifest_sha256,
            "source_transfer_manifest_changed"
        );
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .context("source_transfer_unknown_entry")?;
        let offset = u64::from(index) * TRANSFER_CHUNK_BYTES as u64;
        ensure!(offset < entry.bytes, "source_transfer_invalid_chunk");
        if matches!(entry.content, TransferContent::PluginPackage { .. }) {
            plugin::verify_generated(&directory, entry)?;
        }
        let mut file = directory.open_single_link_regular_file(OsStr::new(&payload_name(entry)))?;
        ensure!(
            file.metadata()?.len() == entry.bytes,
            "source_transfer_payload_changed"
        );
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (entry.bytes - offset).min(TRANSFER_CHUNK_BYTES as u64) as usize];
        file.read_exact(&mut bytes)?;
        let sha = format!("{:x}", Sha256::digest(&bytes));
        TransferChunk::received(
            request_id.into(),
            manifest_sha256.into(),
            entry_id.into(),
            index,
            sha,
            bytes,
        )
    }
}

fn entry(index: usize, file: usize, content: TransferContent, bytes: &[u8]) -> TransferEntry {
    TransferEntry {
        id: format!("e{index:04}-{file:04}"),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        content,
    }
}
pub(super) fn payload_name(entry: &TransferEntry) -> String {
    match &entry.content {
        TransferContent::History { snapshot, .. } if snapshot.original.is_some() => {
            format!("{}.jsonl.zst", entry.id)
        }
        TransferContent::History { .. } => format!("{}.jsonl", entry.id),
        _ => format!("{}.blob", entry.id),
    }
}
fn snapshot_history(
    directory: &PrivateDirectory,
    index: usize,
    binding: &HistorySourceBinding,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<TransferEntry> {
    let snapshot = binding.snapshot();
    let (bytes, sha256) = snapshot.original.as_ref().map_or(
        (snapshot.source_bytes, snapshot.source_sha256.clone()),
        |value| (value.bytes, value.sha256.clone()),
    );
    let entry = TransferEntry {
        id: format!("e{index:04}-0000"),
        bytes,
        sha256,
        content: TransferContent::History {
            snapshot: Box::new(snapshot.clone()),
            uploaded_source: binding.uploaded_source().cloned(),
        },
    };
    snapshot_data(directory, &entry, &mut binding.transport_reader()?, check)?;
    Ok(entry)
}
fn snapshot(
    directory: &PrivateDirectory,
    entry: &TransferEntry,
    reader: &mut impl Read,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    snapshot_data(directory, entry, reader, check)
}
fn snapshot_data(
    directory: &PrivateDirectory,
    entry: &TransferEntry,
    reader: &mut impl Read,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    valid_id(&entry.id)?;
    ensure!(
        entry.bytes <= TRANSFER_MAX_BYTES && valid_sha(&entry.sha256),
        "source_transfer_budget_exceeded"
    );
    exact(directory, &format!("{}.json", entry.id), entry)?;
    let name = payload_name(entry);
    match directory.open_single_link_regular_file(OsStr::new(&name)) {
        Ok(mut file) => {
            return fingerprint(&mut file, entry.bytes, &entry.sha256, &mut |bytes| {
                active(directory).is_ok() && check(bytes)
            });
        }
        Err(error) if missing(&error) => {}
        Err(error) => return Err(error),
    }
    let mut controlled = Snapshot {
        reader,
        entry,
        consumed: 0,
        hash: Sha256::new(),
        check,
        directory,
        verified: false,
        failure: None,
    };
    let published =
        directory
            .atomic_publish_from_reader(OsStr::new(&name), &mut controlled, false, || Ok(None));
    if let Some(error) = controlled.failure.take() {
        return Err(error);
    }
    published?;
    ensure!(controlled.verified, "source_transfer_payload_changed");
    Ok(())
}
pub(super) fn verify_payload(
    directory: &PrivateDirectory,
    entry: &TransferEntry,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(&payload_name(entry)))?;
    fingerprint(&mut file, entry.bytes, &entry.sha256, &mut |bytes| {
        active(directory).is_ok() && check(bytes)
    })
}
struct Snapshot<'a, R, C> {
    reader: &'a mut R,
    entry: &'a TransferEntry,
    consumed: u64,
    hash: Sha256,
    check: &'a mut C,
    directory: &'a PrivateDirectory,
    verified: bool,
    failure: Option<anyhow::Error>,
}
impl<R: Read, C: FnMut(u64) -> bool> Read for Snapshot<'_, R, C> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let result = (|| -> Result<usize> {
            active(self.directory)?;
            ensure!((self.check)(self.consumed), "source_transfer_cancelled");
            if self.consumed == self.entry.bytes {
                let mut end = [0];
                ensure!(
                    self.reader.read(&mut end)? == 0
                        && format!("{:x}", self.hash.clone().finalize()) == self.entry.sha256,
                    "source_transfer_payload_changed"
                );
                self.verified = true;
                return Ok(0);
            }
            let limit = buffer
                .len()
                .min(64 * 1024)
                .min((self.entry.bytes - self.consumed) as usize);
            let count = self.reader.read(&mut buffer[..limit])?;
            ensure!(count > 0, "source_transfer_payload_changed");
            self.consumed += count as u64;
            self.hash.update(&buffer[..count]);
            Ok(count)
        })();
        result.map_err(|error| {
            self.failure = Some(error);
            std::io::Error::other("source_transfer_capture_interrupted")
        })
    }
}
