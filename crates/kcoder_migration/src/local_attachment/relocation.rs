//! Owner-scoped relocation evidence for local attachment jobs and browser uploads.
//!
//! Original jobs, grants, receipts, payloads and cancellation state remain byte-for-byte
//! unchanged. This adapter records only the actual destination identities published by
//! the original persistent-root operation, then lets the owner resolve those recorded
//! identities to the currently opened target handles.

use super::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, storage::StoragePublishedComponent};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

const RECORD_PREFIX: &str = "local-attachment-storage-relocation-";
const RECORD_BYTES: u64 = 16 * 1024 * 1024;
const SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 65_536;
const MAX_DEPTH: usize = 16;
const MAX_ALIASES: usize = 64;
// The owner's 2 GiB staging reservation excludes retained metadata.
const MAX_TOTAL_BYTES: u64 =
    kcoder_types::local_attachment_upload::HISTORICAL_LOCAL_UPLOAD_MAX_STAGING_BYTES
        + MAX_ENTRIES as u64 * META;
const OWNER_PATHS: [&str; 2] = [
    "migrations/history-local-attachments",
    "migrations/local-attachment-uploads",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum EntryKind {
    Directory,
    RegularFile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntrySnapshot {
    path: String,
    kind: EntryKind,
    source_directory_identity: Option<String>,
    source_file_identity: Option<String>,
    source_staged_file_identity: Option<String>,
    source_portable_identity: Option<PortableLeaseIdentity>,
    recorded_directory_identities: Vec<String>,
    recorded_file_identities: Vec<String>,
    recorded_staged_file_identities: Vec<String>,
    recorded_portable_identities: Vec<PortableLeaseIdentity>,
    bytes: Option<u64>,
    sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerSnapshot {
    path: String,
    logical_owner: String,
    source_directory_identity: String,
}

/// Read-only source facts for the two local attachment owners.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAttachmentStorageRelocationSnapshot {
    version: u8,
    source_profile_identity: String,
    source_profile_path: PathBuf,
    logical_profile_identity: String,
    logical_profile_path: PathBuf,
    prior_record_operation: Option<String>,
    prior_record_identity: Option<PortableLeaseIdentity>,
    prior_record_sha256: Option<String>,
    owners: Vec<OwnerSnapshot>,
    entries: Vec<EntrySnapshot>,
}

/// A compact, side-effect-free summary suitable for the user's migration preview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalAttachmentStorageRelocationPreview {
    pub has_local_attachment_jobs: bool,
    pub has_browser_uploads: bool,
    pub entry_count: usize,
    pub bytes: u64,
    pub metadata_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerBinding {
    path: String,
    logical_owner: String,
    target_directory_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryBinding {
    path: String,
    kind: EntryKind,
    recorded_directory_identities: Vec<String>,
    recorded_file_identities: Vec<String>,
    recorded_staged_file_identities: Vec<String>,
    recorded_portable_identities: Vec<PortableLeaseIdentity>,
    target_directory_identity: Option<String>,
    target_file_identity: Option<String>,
    target_staged_file_identity: Option<String>,
    target_portable_identity: Option<PortableLeaseIdentity>,
    bytes: Option<u64>,
    sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelocationRecord {
    version: u8,
    operation_id: String,
    source_profile_identity: String,
    source_profile_path: PathBuf,
    target_profile_identity: String,
    target_profile_path: PathBuf,
    logical_profile_identity: String,
    logical_profile_path: PathBuf,
    source_snapshot_sha256: String,
    record_identity: Option<PortableLeaseIdentity>,
    owners: Vec<OwnerBinding>,
    entries: Vec<EntryBinding>,
}

struct HeldRelocationRecord {
    name: String,
    bytes: Vec<u8>,
    identity: PortableLeaseIdentity,
    value: RelocationRecord,
}

/// The current root's owner mapping. It is rechecked at each store operation;
/// its aliases never replace the actual identity returned by a live handle.
pub(super) struct LocalAttachmentRelocationBinding {
    profile_identity: String,
    logical_profile_identity: String,
    record: Option<HeldRelocationRecord>,
}

pub struct LocalAttachmentStorageRelocation;

impl LocalAttachmentStorageRelocation {
    pub fn preview(profile: &std::path::Path) -> Result<LocalAttachmentStorageRelocationPreview> {
        let snapshot = Self::capture(profile, false)?;
        let bytes = snapshot
            .entries
            .iter()
            .filter_map(|entry| entry.bytes)
            .try_fold(0u64, |total, value| total.checked_add(value))
            .context("local_attachment_relocation_budget")?;
        Ok(LocalAttachmentStorageRelocationPreview {
            has_local_attachment_jobs: snapshot
                .owners
                .iter()
                .any(|owner| owner.path == OWNER_PATHS[0]),
            has_browser_uploads: snapshot
                .owners
                .iter()
                .any(|owner| owner.path == OWNER_PATHS[1]),
            entry_count: snapshot.entries.len(),
            bytes,
            metadata_sha256: digest(&serde_json::to_vec(&snapshot)?),
        })
    }

    /// Captures only already-existing owner data; it does not initialize stores,
    /// create locks, repair permissions, or settle an unknown upload result.
    pub fn snapshot(profile: &std::path::Path) -> Result<LocalAttachmentStorageRelocationSnapshot> {
        Self::capture(profile, true)
    }

    fn capture(
        profile: &Path,
        verify_contents: bool,
    ) -> Result<LocalAttachmentStorageRelocationSnapshot> {
        let root = PrivateDirectory::open_existing(profile)?;
        root.verify_config_root_directory()?;
        let source_profile_path = std::fs::canonicalize(profile)?;
        let binding = LocalAttachmentRelocationBinding::observe(&root)?;
        binding.verify_profile_path(&source_profile_path)?;
        let mut entries = Vec::new();
        let mut owners = Vec::new();
        let mut total_bytes = 0u64;
        let mut remaining = MAX_ENTRIES;
        capture_profile_entry(
            &root,
            binding.record.as_ref().map(|record| &record.value),
            &mut entries,
        )?;
        if let Some(migrations) = open_relative_optional(&root, "migrations")? {
            capture_directory_entry(
                &migrations,
                "migrations",
                binding.record.as_ref().map(|record| &record.value),
                &mut entries,
            )?;
        }
        for path in OWNER_PATHS {
            let Some(directory) = open_relative_optional(&root, path)? else {
                continue;
            };
            directory.verify_private_directory()?;
            let identity = directory.directory_identity()?;
            owners.push(OwnerSnapshot {
                path: path.into(),
                logical_owner: binding.logical_owner(path, &identity)?,
                source_directory_identity: identity,
            });
            capture_directory(
                &directory,
                path,
                0,
                binding.record.as_ref().map(|record| &record.value),
                &mut entries,
                &mut remaining,
                &mut total_bytes,
                verify_contents,
            )?;
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        owners.sort_by(|left, right| left.path.cmp(&right.path));
        binding.verify(&root)?;
        ensure!(
            root.directory_identity()? == binding.profile_identity,
            "local_attachment_relocation_source_changed"
        );
        let snapshot = LocalAttachmentStorageRelocationSnapshot {
            version: 1,
            source_profile_identity: binding.profile_identity.clone(),
            source_profile_path: source_profile_path.clone(),
            logical_profile_identity: binding.logical_profile_identity.clone(),
            logical_profile_path: binding
                .record
                .as_ref()
                .map_or(source_profile_path, |record| {
                    record.value.logical_profile_path.clone()
                }),
            prior_record_operation: binding
                .record
                .as_ref()
                .map(|record| record.value.operation_id.clone()),
            prior_record_identity: binding
                .record
                .as_ref()
                .map(|record| record.identity.clone()),
            prior_record_sha256: binding.record.as_ref().map(|record| digest(&record.bytes)),
            owners,
            entries,
        };
        ensure!(
            serde_json::to_vec(&snapshot)?.len() as u64 <= SNAPSHOT_BYTES,
            "local_attachment_relocation_budget"
        );
        Ok(snapshot)
    }

    /// Convert only the copied owner identities after the application has exited.
    /// Jobs, grants, pending states and receipts remain their original bytes.
    pub fn relocate(
        source_profile: &Path,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &LocalAttachmentStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        Self::target(
            source_profile,
            final_target_profile,
            operation_id,
            expected,
            published,
            true,
        )
    }

    /// Read-only reconciliation. Missing or changed owner records remain unknown.
    pub fn verify_relocation(
        source_profile: &std::path::Path,
        final_target_profile: &std::path::Path,
        operation_id: &str,
        expected: &LocalAttachmentStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        Self::target(
            source_profile,
            final_target_profile,
            operation_id,
            expected,
            published,
            false,
        )
    }

    fn target(
        source_profile: &Path,
        target_profile: &std::path::Path,
        operation_id: &str,
        expected: &LocalAttachmentStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
        publish_record: bool,
    ) -> Result<()> {
        ensure!(
            valid_operation(operation_id) && expected.version == 1,
            "local_attachment_relocation_operation_invalid"
        );
        let source = PrivateDirectory::open_existing(source_profile)?;
        source.verify_config_root_directory()?;
        let current = Self::snapshot(source_profile)?;
        ensure!(
            current == *expected
                && source.directory_identity()? == expected.source_profile_identity,
            "local_attachment_relocation_source_changed"
        );
        published.verify()?;
        let target_profile_path = std::fs::canonicalize(target_profile)?;
        ensure!(
            published.operation_id() == operation_id
                && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
                && published.source_identity() == expected.source_profile_identity
                && std::fs::canonicalize(published.source_path())? == expected.source_profile_path
                && std::fs::canonicalize(source_profile)? == expected.source_profile_path
                && std::fs::canonicalize(published.destination_path())? == target_profile_path,
            "local_attachment_relocation_published_component_mismatch"
        );
        let target = PrivateDirectory::open_existing(target_profile)?;
        target.verify_config_root_directory()?;
        let target_identity = target.directory_identity()?;
        ensure!(
            target_identity != expected.source_profile_identity
                && published.directory().directory_identity()? == target_identity,
            "local_attachment_relocation_published_component_mismatch"
        );

        let target_entries = capture_target_entries(&target, expected)?;
        let owners = expected
            .owners
            .iter()
            .map(|owner| {
                let entry = target_entries
                    .iter()
                    .find(|entry| entry.path == owner.path)
                    .context("local_attachment_relocation_target_changed")?;
                Ok(OwnerBinding {
                    path: owner.path.clone(),
                    logical_owner: owner.logical_owner.clone(),
                    target_directory_identity: entry
                        .source_directory_identity
                        .clone()
                        .context("local_attachment_relocation_target_changed")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let entries = expected
            .entries
            .iter()
            .map(|source_entry| {
                let target_entry = target_entries
                    .iter()
                    .find(|entry| entry.path == source_entry.path)
                    .context("local_attachment_relocation_target_changed")?;
                ensure!(
                    target_entry.kind == source_entry.kind
                        && target_entry.bytes == source_entry.bytes
                        && target_entry.sha256 == source_entry.sha256,
                    "local_attachment_relocation_target_changed"
                );
                Ok(EntryBinding {
                    path: source_entry.path.clone(),
                    kind: source_entry.kind.clone(),
                    recorded_directory_identities: source_entry
                        .recorded_directory_identities
                        .clone(),
                    recorded_file_identities: source_entry.recorded_file_identities.clone(),
                    recorded_staged_file_identities: source_entry
                        .recorded_staged_file_identities
                        .clone(),
                    recorded_portable_identities: source_entry.recorded_portable_identities.clone(),
                    target_directory_identity: target_entry.source_directory_identity.clone(),
                    target_file_identity: target_entry.source_file_identity.clone(),
                    target_staged_file_identity: target_entry.source_staged_file_identity.clone(),
                    target_portable_identity: target_entry.source_portable_identity.clone(),
                    bytes: source_entry.bytes,
                    sha256: source_entry.sha256.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            target_entries.len() == expected.entries.len(),
            "local_attachment_relocation_target_changed"
        );
        ensure_aliases_are_unambiguous(&entries)?;
        let mut record = RelocationRecord {
            version: 1,
            operation_id: operation_id.into(),
            source_profile_identity: expected.source_profile_identity.clone(),
            source_profile_path: expected.source_profile_path.clone(),
            target_profile_identity: target_identity,
            target_profile_path,
            logical_profile_identity: expected.logical_profile_identity.clone(),
            logical_profile_path: expected.logical_profile_path.clone(),
            source_snapshot_sha256: digest(&serde_json::to_vec(expected)?),
            record_identity: None,
            owners,
            entries,
        };

        let has_owner_evidence =
            !expected.owners.is_empty() || expected.prior_record_operation.is_some();
        if !has_owner_evidence {
            published.verify()?;
            return Ok(());
        }
        let migration_directory = target
            .open_child(OsStr::new("migrations"), false)
            .context("local_attachment_relocation_target_changed")?;
        migration_directory.verify_private_directory()?;
        if let (Some(previous_operation), Some(previous_sha256)) = (
            &expected.prior_record_operation,
            &expected.prior_record_sha256,
        ) {
            let previous_file = read_named_record(
                &migration_directory,
                &record_name(previous_operation),
                false,
            )?
            .context("local_attachment_relocation_target_changed")?;
            ensure!(
                digest(&previous_file.bytes) == *previous_sha256,
                "local_attachment_relocation_target_changed"
            );
        }
        let final_name = record_name(operation_id);
        if let Some(existing) = read_named_record(&migration_directory, &final_name, true)? {
            ensure!(
                existing.value.operation_id == operation_id
                    && existing.value.source_profile_identity == expected.source_profile_identity
                    && existing.value.target_profile_identity == target.directory_identity()?
                    && existing.value.source_snapshot_sha256
                        == digest(&serde_json::to_vec(expected)?),
                "local_attachment_relocation_conflict"
            );
            ensure!(
                existing.value.owners == record.owners && existing.value.entries == record.entries,
                "local_attachment_relocation_conflict"
            );
            published.verify()?;
            return Ok(());
        }
        ensure!(publish_record, "local_attachment_relocation_unconfirmed");
        publish_record_file(&migration_directory, &final_name, operation_id, &mut record)?;
        let committed = read_named_record(&migration_directory, &final_name, true)?
            .context("local_attachment_relocation_unconfirmed")?;
        ensure!(
            committed.value.operation_id == operation_id
                && committed.value.source_profile_identity == expected.source_profile_identity
                && committed.value.target_profile_identity == target.directory_identity()?
                && committed.value.source_snapshot_sha256 == digest(&serde_json::to_vec(expected)?)
                && committed.value.owners == record.owners
                && committed.value.entries == record.entries,
            "local_attachment_relocation_unconfirmed"
        );
        published.verify()?;
        Ok(())
    }
}

impl LocalAttachmentRelocationBinding {
    pub(super) fn observe(profile: &PrivateDirectory) -> Result<Self> {
        profile.verify_config_root_directory()?;
        let profile_identity = profile.directory_identity()?;
        let record = match profile.open_child(OsStr::new("migrations"), false) {
            Ok(migrations) => {
                migrations.verify_private_directory()?;
                read_current_record(&migrations, &profile_identity)?
            }
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        let logical_profile_identity = record.as_ref().map_or_else(
            || profile_identity.clone(),
            |record| record.value.logical_profile_identity.clone(),
        );
        Ok(Self {
            profile_identity,
            logical_profile_identity,
            record,
        })
    }

    pub(super) fn verify_profile_path(&self, path: &Path) -> Result<()> {
        if let Some(record) = &self.record {
            ensure!(
                record.value.target_profile_path == path,
                "local_attachment_relocation_profile_changed"
            );
        }
        Ok(())
    }

    pub(super) fn logical_owner(&self, path: &str, physical_identity: &str) -> Result<String> {
        if let Some(record) = &self.record
            && let Some(owner) = record.value.owners.iter().find(|owner| owner.path == path)
        {
            ensure!(
                owner.target_directory_identity == physical_identity,
                "local_attachment_relocation_owner_changed"
            );
            return Ok(owner.logical_owner.clone());
        }
        hash(&(self.logical_profile_identity.as_str(), physical_identity))
    }

    pub(super) fn verify(&self, profile: &PrivateDirectory) -> Result<()> {
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "local_attachment_relocation_profile_changed"
        );
        let current = Self::observe(profile)?;
        ensure!(
            current.profile_identity == self.profile_identity
                && current.logical_profile_identity == self.logical_profile_identity,
            "local_attachment_relocation_record_changed"
        );
        match (&self.record, current.record) {
            (None, None) => Ok(()),
            (Some(original), Some(current)) => {
                ensure!(
                    original.name == current.name
                        && original.bytes == current.bytes
                        && original.identity == current.identity
                        && original.value == current.value,
                    "local_attachment_relocation_record_changed"
                );
                Ok(())
            }
            _ => anyhow::bail!("local_attachment_relocation_record_changed"),
        }
    }

    pub(super) fn resolve_directory_identity(
        &self,
        path: &str,
        recorded: &str,
        actual: &str,
    ) -> Result<String> {
        self.resolve_identity(path, recorded, actual, true)?;
        Ok(actual.into())
    }

    pub(super) fn resolve_file_identity(
        &self,
        path: &str,
        recorded: &str,
        actual: &str,
    ) -> Result<String> {
        self.resolve_identity(path, recorded, actual, false)?;
        Ok(actual.into())
    }

    pub(super) fn resolve_staged_file_identity(
        &self,
        path: &str,
        source: &StagedUploadSource,
        actual: &kcoder_state::external_history::local_attachment::StagedUploadFileIdentity,
    ) -> Result<()> {
        let recorded = source.original_file_identity();
        if recorded == actual.as_str() {
            return Ok(());
        }
        if let Some(record) = &self.record
            && let Some(entry) = record.value.entries.iter().find(|entry| entry.path == path)
        {
            ensure!(
                entry.target_staged_file_identity.as_deref() == Some(actual.as_str())
                    && entry
                        .recorded_staged_file_identities
                        .iter()
                        .any(|id| id == recorded),
                "local_attachment_relocation_identity_changed"
            );
        } else {
            ensure!(
                recorded == actual.as_str(),
                "local_attachment_source_changed"
            );
        }
        Ok(())
    }

    pub(super) fn resolve_portable_identity(
        &self,
        path: &str,
        recorded: &PortableLeaseIdentity,
        actual: &PortableLeaseIdentity,
    ) -> Result<PortableLeaseIdentity> {
        ensure!(
            self.maps_portable_identity(path, recorded, actual)?,
            "local_attachment_relocation_identity_changed"
        );
        Ok(actual.clone())
    }

    pub(super) fn maps_portable_identity(
        &self,
        path: &str,
        recorded: &PortableLeaseIdentity,
        actual: &PortableLeaseIdentity,
    ) -> Result<bool> {
        if recorded == actual {
            return Ok(true);
        }
        if let Some(record) = &self.record {
            if let Some(binding) = record.value.entries.iter().find(|entry| entry.path == path) {
                return Ok(binding.target_portable_identity.as_ref() == Some(actual)
                    && binding
                        .recorded_portable_identities
                        .iter()
                        .any(|value| value == recorded));
            }
        }
        Ok(false)
    }

    fn resolve_identity(
        &self,
        path: &str,
        recorded: &str,
        actual: &str,
        directory: bool,
    ) -> Result<()> {
        if recorded == actual {
            return Ok(());
        }
        if let Some(record) = &self.record {
            if let Some(binding) = record.value.entries.iter().find(|entry| entry.path == path) {
                let (target, aliases) = if directory {
                    (
                        &binding.target_directory_identity,
                        &binding.recorded_directory_identities,
                    )
                } else {
                    (
                        &binding.target_file_identity,
                        &binding.recorded_file_identities,
                    )
                };
                ensure!(
                    target.as_deref() == Some(actual)
                        && aliases.iter().any(|value| value == recorded),
                    "local_attachment_relocation_identity_changed"
                );
            } else {
                ensure!(
                    recorded == actual,
                    "local_attachment_relocation_identity_changed"
                );
            }
        } else {
            ensure!(
                recorded == actual,
                "local_attachment_relocation_identity_changed"
            );
        }
        Ok(())
    }
}

fn capture_target_entries(
    target: &PrivateDirectory,
    expected: &LocalAttachmentStorageRelocationSnapshot,
) -> Result<Vec<EntrySnapshot>> {
    let mut entries = Vec::new();
    let mut total_bytes = 0;
    let mut remaining = MAX_ENTRIES;
    capture_profile_entry(target, None, &mut entries)?;
    for path in OWNER_PATHS {
        let source_has = expected.owners.iter().any(|owner| owner.path == path);
        let target_directory = open_relative_optional(target, path)?;
        ensure!(
            source_has == target_directory.is_some(),
            "local_attachment_relocation_target_changed"
        );
    }
    let has_migrations = open_relative_optional(target, "migrations")?.is_some();
    ensure!(
        has_migrations
            == expected
                .entries
                .iter()
                .any(|entry| entry.path == "migrations"),
        "local_attachment_relocation_target_changed"
    );
    if has_migrations {
        let migrations = target.open_child(OsStr::new("migrations"), false)?;
        capture_directory_entry(&migrations, "migrations", None, &mut entries)?;
    }
    for owner in &expected.owners {
        let directory = open_relative_optional(target, &owner.path)?
            .context("local_attachment_relocation_target_changed")?;
        directory.verify_private_directory()?;
        capture_directory(
            &directory,
            &owner.path,
            0,
            None,
            &mut entries,
            &mut remaining,
            &mut total_bytes,
            true,
        )?;
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    ensure!(
        entries.len() == expected.entries.len()
            && entries
                .iter()
                .zip(&expected.entries)
                .all(|(actual, source)| {
                    actual.path == source.path
                        && actual.kind == source.kind
                        && actual.bytes == source.bytes
                        && actual.sha256 == source.sha256
                }),
        "local_attachment_relocation_target_changed"
    );
    Ok(entries)
}

fn capture_profile_entry(
    profile: &PrivateDirectory,
    previous: Option<&RelocationRecord>,
    entries: &mut Vec<EntrySnapshot>,
) -> Result<()> {
    let identity = profile.directory_identity()?;
    let prior =
        previous.and_then(|record| record.entries.iter().find(|entry| entry.path.is_empty()));
    let recorded = prior
        .filter(|entry| entry.target_directory_identity.as_deref() == Some(&identity))
        .map(|entry| {
            let mut values = entry.recorded_directory_identities.clone();
            push_unique(&mut values, identity.clone());
            values
        })
        .unwrap_or_else(|| vec![identity.clone()]);
    entries.push(EntrySnapshot {
        path: String::new(),
        kind: EntryKind::Directory,
        source_directory_identity: Some(identity),
        source_file_identity: None,
        source_staged_file_identity: None,
        source_portable_identity: None,
        recorded_directory_identities: recorded,
        recorded_file_identities: Vec::new(),
        recorded_staged_file_identities: Vec::new(),
        recorded_portable_identities: Vec::new(),
        bytes: None,
        sha256: None,
    });
    Ok(())
}

fn capture_directory_entry(
    directory: &PrivateDirectory,
    path: &str,
    previous: Option<&RelocationRecord>,
    entries: &mut Vec<EntrySnapshot>,
) -> Result<()> {
    let identity = directory.directory_identity()?;
    let portable_identity = directory.portable_retention_identity()?;
    let prior = previous.and_then(|record| record.entries.iter().find(|entry| entry.path == path));
    let recorded_directory_identities = prior
        .filter(|entry| entry.target_directory_identity.as_deref() == Some(&identity))
        .map(|entry| {
            let mut values = entry.recorded_directory_identities.clone();
            push_unique(&mut values, identity.clone());
            values
        })
        .unwrap_or_else(|| vec![identity.clone()]);
    let recorded_portable_identities = match (&portable_identity, prior) {
        (actual, Some(entry)) if entry.target_portable_identity.as_ref() == Some(actual) => {
            let mut values = entry.recorded_portable_identities.clone();
            push_unique(&mut values, actual.clone());
            values
        }
        (actual, _) => vec![actual.clone()],
    };
    entries.push(EntrySnapshot {
        path: path.into(),
        kind: EntryKind::Directory,
        source_directory_identity: Some(identity),
        source_file_identity: None,
        source_staged_file_identity: None,
        source_portable_identity: Some(portable_identity),
        recorded_directory_identities,
        recorded_file_identities: Vec::new(),
        recorded_staged_file_identities: Vec::new(),
        recorded_portable_identities,
        bytes: None,
        sha256: None,
    });
    Ok(())
}

fn capture_directory(
    directory: &PrivateDirectory,
    prefix: &str,
    depth: usize,
    previous: Option<&RelocationRecord>,
    entries: &mut Vec<EntrySnapshot>,
    remaining: &mut usize,
    total_bytes: &mut u64,
    verify_contents: bool,
) -> Result<()> {
    ensure!(
        depth <= MAX_DEPTH,
        "local_attachment_relocation_depth_limit"
    );
    ensure!(*remaining > 0, "local_attachment_relocation_entry_limit");
    *remaining -= 1;
    let path = prefix.to_owned();
    let source_directory_identity = directory.directory_identity()?;
    let source_portable_identity = if path.is_empty() {
        None
    } else {
        Some(directory.portable_retention_identity()?)
    };
    let prior = previous.and_then(|record| record.entries.iter().find(|entry| entry.path == path));
    let recorded_directory_identities = prior
        .filter(|entry| {
            entry.target_directory_identity.as_deref() == Some(&source_directory_identity)
        })
        .map(|entry| {
            let mut values = entry.recorded_directory_identities.clone();
            push_unique(&mut values, source_directory_identity.clone());
            values
        })
        .unwrap_or_else(|| vec![source_directory_identity.clone()]);
    let recorded_portable_identities = match (&source_portable_identity, prior) {
        (Some(actual), Some(entry)) if entry.target_portable_identity.as_ref() == Some(actual) => {
            let mut values = entry.recorded_portable_identities.clone();
            push_unique(&mut values, actual.clone());
            values
        }
        (Some(actual), _) => vec![actual.clone()],
        _ => Vec::new(),
    };
    entries.push(EntrySnapshot {
        path: path.clone(),
        kind: EntryKind::Directory,
        source_directory_identity: Some(source_directory_identity),
        source_file_identity: None,
        source_staged_file_identity: None,
        source_portable_identity,
        recorded_directory_identities,
        recorded_file_identities: Vec::new(),
        recorded_staged_file_identities: Vec::new(),
        recorded_portable_identities,
        bytes: None,
        sha256: None,
    });
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(MAX_ENTRIES, |name| {
        names.push(
            name.to_str()
                .context("local_attachment_relocation_path_invalid")?
                .to_owned(),
        );
        Ok(())
    })?;
    names.sort();
    for name in names {
        let entry = directory.open_entry_handle(OsStr::new(&name))?;
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        validate_relative_path(&child_path)?;
        if entry.metadata().is_dir() && !entry.metadata().file_type().is_symlink() {
            let child = entry.open_child_directory()?;
            child.verify_private_directory()?;
            capture_directory(
                &child,
                &child_path,
                depth + 1,
                previous,
                entries,
                remaining,
                total_bytes,
                verify_contents,
            )?;
        } else if entry.metadata().is_file() {
            let mut file = directory.open_regular_file_snapshot(OsStr::new(&name))?;
            let identity = upload::storage::file_identity(&file)?;
            let staged_identity =
                kcoder_state::external_history::local_attachment::StagedUploadFileIdentity::observe(
                    &file,
                )?;
            let portable_identity = PortableLeaseIdentity::from_private_regular_handle(&file)?;
            let bytes = file.metadata()?.len();
            *total_bytes = total_bytes
                .checked_add(bytes)
                .context("local_attachment_relocation_budget")?;
            ensure!(
                *total_bytes <= MAX_TOTAL_BYTES,
                "local_attachment_relocation_budget"
            );
            let mut digest = Sha256::new();
            let mut read = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            while verify_contents && read < bytes {
                let count = file.read(&mut buffer)?;
                ensure!(count > 0, "local_attachment_relocation_content_changed");
                read = read
                    .checked_add(count as u64)
                    .context("local_attachment_relocation_budget")?;
                ensure!(read <= bytes, "local_attachment_relocation_content_changed");
                digest.update(&buffer[..count]);
            }
            ensure!(
                file.metadata()?.len() == bytes
                    && upload::storage::file_identity(&file)? == identity
                    && directory.portable_regular_identity(OsStr::new(&name))? == portable_identity,
                "local_attachment_relocation_content_changed"
            );
            let sha256 = verify_contents.then(|| format!("{:x}", digest.finalize()));
            let prior = previous
                .and_then(|record| record.entries.iter().find(|entry| entry.path == child_path));
            let (recorded_file_identities, recorded_portable_identities) = match prior {
                Some(entry)
                    if entry.target_file_identity.as_deref() == Some(&identity)
                        && entry.target_portable_identity.as_ref() == Some(&portable_identity) =>
                {
                    let mut file_ids = entry.recorded_file_identities.clone();
                    push_unique(&mut file_ids, identity.clone());
                    let mut portable_ids = entry.recorded_portable_identities.clone();
                    push_unique(&mut portable_ids, portable_identity.clone());
                    (file_ids, portable_ids)
                }
                _ => (vec![identity.clone()], vec![portable_identity.clone()]),
            };
            let recorded_staged_file_identities = match prior {
                Some(entry)
                    if entry.target_staged_file_identity.as_deref()
                        == Some(staged_identity.as_str())
                        && entry.target_file_identity.as_deref() == Some(&identity) =>
                {
                    let mut values = entry.recorded_staged_file_identities.clone();
                    push_unique(&mut values, staged_identity.as_str().to_owned());
                    values
                }
                _ => vec![staged_identity.as_str().to_owned()],
            };
            ensure!(
                recorded_file_identities.len() <= MAX_ALIASES
                    && recorded_staged_file_identities.len() <= MAX_ALIASES
                    && recorded_portable_identities.len() <= MAX_ALIASES,
                "local_attachment_relocation_alias_limit"
            );
            *remaining = remaining
                .checked_sub(1)
                .context("local_attachment_relocation_entry_limit")?;
            entries.push(EntrySnapshot {
                path: child_path,
                kind: EntryKind::RegularFile,
                source_directory_identity: None,
                source_file_identity: Some(identity),
                source_staged_file_identity: Some(staged_identity.as_str().to_owned()),
                source_portable_identity: Some(portable_identity),
                recorded_directory_identities: Vec::new(),
                recorded_file_identities,
                recorded_staged_file_identities,
                recorded_portable_identities,
                bytes: Some(bytes),
                sha256,
            });
        } else {
            anyhow::bail!("local_attachment_relocation_entry_unsupported");
        }
    }
    Ok(())
}

fn open_relative_optional(
    profile: &PrivateDirectory,
    path: &str,
) -> Result<Option<PrivateDirectory>> {
    let mut current = profile.duplicate_handle()?;
    for (index, part) in path.split('/').enumerate() {
        match current.open_child(OsStr::new(part), false) {
            Ok(child) => current = child,
            Err(error) if missing(&error) && index == 0 => return Ok(None),
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(current))
}

fn read_current_record(
    migrations: &PrivateDirectory,
    profile_identity: &str,
) -> Result<Option<HeldRelocationRecord>> {
    let mut names = Vec::new();
    migrations.visit_entry_names_bounded(4096, |name| {
        let name = name
            .to_str()
            .context("local_attachment_relocation_record_invalid")?;
        if name.starts_with(RECORD_PREFIX) && name.ends_with(".json") {
            names.push(name.to_owned());
        }
        ensure!(
            !name.starts_with(".local-attachment-storage-relocation-")
                || !name.ends_with(".prepared"),
            "local_attachment_relocation_recovery_required"
        );
        Ok(())
    })?;
    names.sort();
    let mut current = None;
    for name in names {
        let record = read_named_record(migrations, &name, false)?
            .context("local_attachment_relocation_record_invalid")?;
        validate_record_shape(&record.value)?;
        if record.value.target_profile_identity == profile_identity {
            ensure!(
                record.value.record_identity.as_ref() == Some(&record.identity),
                "local_attachment_relocation_record_changed"
            );
            ensure!(
                current.is_none(),
                "local_attachment_relocation_record_conflict"
            );
            current = Some(record);
        }
    }
    Ok(current)
}

fn read_named_record(
    directory: &PrivateDirectory,
    name: &str,
    verify_record_identity: bool,
) -> Result<Option<HeldRelocationRecord>> {
    let file = match directory.open_regular_file_snapshot(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let identity = PortableLeaseIdentity::from_private_regular_handle(&file)?;
    ensure!(
        file.metadata()?.len() <= RECORD_BYTES,
        "local_attachment_relocation_record_limit"
    );
    let mut bytes = Vec::new();
    file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= RECORD_BYTES,
        "local_attachment_relocation_record_limit"
    );
    let value: RelocationRecord =
        serde_json::from_slice(&bytes).context("local_attachment_relocation_record_invalid")?;
    ensure!(
        record_name(&value.operation_id) == name,
        "local_attachment_relocation_record_changed"
    );
    if verify_record_identity {
        ensure!(
            value.record_identity.as_ref() == Some(&identity),
            "local_attachment_relocation_record_changed"
        );
    }
    Ok(Some(HeldRelocationRecord {
        name: name.into(),
        bytes,
        identity,
        value,
    }))
}

fn publish_record_file(
    directory: &PrivateDirectory,
    final_name: &str,
    operation_id: &str,
    record: &mut RelocationRecord,
) -> Result<()> {
    let temporary_name = format!(".local-attachment-storage-relocation-{operation_id}.prepared");
    let mut file = match directory.open_read_write_file(OsStr::new(&temporary_name), true) {
        Ok(file) => file,
        Err(error) if already_exists(&error) => {
            let file = directory.open_read_write_file(OsStr::new(&temporary_name), false)?;
            record.record_identity =
                Some(PortableLeaseIdentity::from_private_regular_handle(&file)?);
            ensure!(
                read_file_contents(&file, RECORD_BYTES)? == serde_json::to_vec(record)?,
                "local_attachment_relocation_unconfirmed"
            );
            file
        }
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() == 0 {
        record.record_identity = Some(PortableLeaseIdentity::from_private_regular_handle(&file)?);
        let bytes = serde_json::to_vec(record)?;
        ensure!(
            bytes.len() as u64 <= RECORD_BYTES,
            "local_attachment_relocation_record_limit"
        );
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    ensure!(
        Some(PortableLeaseIdentity::from_private_regular_handle(&file)?) == record.record_identity,
        "local_attachment_relocation_unconfirmed"
    );
    let bytes = serde_json::to_vec(record)?;
    ensure!(
        read_file_contents(&file, RECORD_BYTES)? == bytes,
        "local_attachment_relocation_unconfirmed"
    );
    directory.rename_no_replace(OsStr::new(&temporary_name), OsStr::new(final_name))?;
    Ok(())
}

fn read_file_contents(file: &File, limit: u64) -> Result<Vec<u8>> {
    let mut file = file.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    ensure!(
        file.metadata()?.len() <= limit,
        "local_attachment_relocation_record_limit"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "local_attachment_relocation_record_limit"
    );
    Ok(bytes)
}

fn validate_record_shape(record: &RelocationRecord) -> Result<()> {
    ensure!(
        record.version == 1
            && valid_operation(&record.operation_id)
            && !record.source_profile_identity.is_empty()
            && !record.target_profile_identity.is_empty()
            && !record.logical_profile_identity.is_empty()
            && record.source_profile_path.is_absolute()
            && record.target_profile_path.is_absolute()
            && record.logical_profile_path.is_absolute()
            && valid_hash(&record.source_snapshot_sha256)
            && record.record_identity.is_some()
            && record.owners.len() <= OWNER_PATHS.len()
            && record.entries.len() <= MAX_ENTRIES,
        "local_attachment_relocation_record_invalid"
    );
    let mut owner_paths = BTreeSet::new();
    for owner in &record.owners {
        ensure!(
            OWNER_PATHS.contains(&owner.path.as_str())
                && owner_paths.insert(owner.path.as_str())
                && !owner.logical_owner.is_empty()
                && !owner.target_directory_identity.is_empty(),
            "local_attachment_relocation_record_invalid"
        );
    }
    let mut paths = BTreeSet::new();
    for entry in &record.entries {
        validate_relative_path(&entry.path)?;
        ensure!(
            paths.insert(entry.path.as_str()),
            "local_attachment_relocation_record_invalid"
        );
        ensure!(
            entry.recorded_directory_identities.len() <= MAX_ALIASES
                && entry.recorded_file_identities.len() <= MAX_ALIASES
                && entry.recorded_staged_file_identities.len() <= MAX_ALIASES
                && entry.recorded_portable_identities.len() <= MAX_ALIASES,
            "local_attachment_relocation_alias_limit"
        );
        match &entry.kind {
            EntryKind::Directory => ensure!(
                entry.target_directory_identity.is_some()
                    && entry.target_file_identity.is_none()
                    && entry.target_staged_file_identity.is_none()
                    && entry.target_portable_identity.is_some() == !entry.path.is_empty()
                    && entry.bytes.is_none()
                    && entry.sha256.is_none(),
                "local_attachment_relocation_record_invalid"
            ),
            EntryKind::RegularFile => ensure!(
                entry.target_directory_identity.is_none()
                    && entry.target_file_identity.is_some()
                    && entry.target_staged_file_identity.is_some()
                    && entry.target_portable_identity.is_some()
                    && entry.bytes.is_some()
                    && entry.sha256.as_ref().is_some_and(|value| value.len() == 64),
                "local_attachment_relocation_record_invalid"
            ),
        }
    }
    Ok(())
}

fn ensure_aliases_are_unambiguous(entries: &[EntryBinding]) -> Result<()> {
    let mut directories = BTreeMap::<&str, (&str, &str)>::new();
    let mut files = BTreeMap::<&str, (&str, &str)>::new();
    let mut staged_files = BTreeMap::<&str, (&str, &str)>::new();
    let mut portable = BTreeMap::<String, (&str, String)>::new();
    for entry in entries {
        if let Some(target) = &entry.target_directory_identity {
            for recorded in &entry.recorded_directory_identities {
                if let Some(previous) = directories.insert(recorded, (&entry.path, target)) {
                    ensure!(
                        previous == (&entry.path, target),
                        "local_attachment_relocation_alias_conflict"
                    );
                }
            }
        }
        if let Some(target) = &entry.target_file_identity {
            for recorded in &entry.recorded_file_identities {
                if let Some(previous) = files.insert(recorded, (&entry.path, target)) {
                    ensure!(
                        previous == (&entry.path, target),
                        "local_attachment_relocation_alias_conflict"
                    );
                }
            }
        }
        if let Some(target) = &entry.target_staged_file_identity {
            for recorded in &entry.recorded_staged_file_identities {
                if let Some(previous) = staged_files.insert(recorded, (&entry.path, target)) {
                    ensure!(
                        previous == (&entry.path, target),
                        "local_attachment_relocation_alias_conflict"
                    );
                }
            }
        }
        if let Some(target) = &entry.target_portable_identity {
            for recorded in &entry.recorded_portable_identities {
                let key = serde_json::to_string(recorded)?;
                let value = (entry.path.as_str(), serde_json::to_string(target)?);
                if let Some(previous) = portable.insert(key, value.clone()) {
                    ensure!(
                        previous == value,
                        "local_attachment_relocation_alias_conflict"
                    );
                }
            }
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    ensure!(
        path.len() <= 4096
            && !path.starts_with('/')
            && !path.contains('\\')
            && !path.chars().any(char::is_control)
            && (path.is_empty()
                || path
                    .split('/')
                    .all(|part| !part.is_empty() && !matches!(part, "." | ".."))),
        "local_attachment_relocation_path_invalid"
    );
    Ok(())
}

fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn record_name(operation_id: &str) -> String {
    format!("{RECORD_PREFIX}{operation_id}.json")
}

fn valid_operation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn already_exists(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
    })
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
