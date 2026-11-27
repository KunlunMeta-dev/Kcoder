//! Stopped-only copying into an already-owned staging directory.
//!
//! The coordinator supplies the original operation directory and persists the
//! small binding before each manifest publication. Names and matching bytes do
//! not establish ownership of either a manifest or a staging entry.

use super::{
    StorageTreeEntryKind, StorageTreeInventory,
    inventory::{inventory_tree, inventory_tree_with_fences},
};
use crate::{PortableLeaseIdentity, PrivateDirectory};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs::{File, FileTimes, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

#[path = "tree_copy/cancel_cleanup.rs"]
mod cancel_cleanup;
pub(super) use cancel_cleanup::{
    CancellationCopy, inspect_cancellation_target, remove_cancellation_payload,
};

// These budgets concern metadata only. Payloads are streamed without a file-size cap.
const MANIFEST_LIMIT: usize = 64 * 1024 * 1024;
const ENTRY_LIMIT: usize = 262_144;
const PATH_UNIT_LIMIT: usize = 32_768;
const COPY_BUFFER_BYTES: usize = 128 * 1024;
const APPEND_MANIFEST_LIMIT: usize = 256 * 1024 * 1024;
const APPEND_FRAME_LIMIT: usize = 2048;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CopyScope {
    operation_id: String,
    domain: String,
    operation_directory_identity: String,
    source_root_identity: String,
    staging_root_identity: String,
    inventory_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ManifestVersion {
    identity: String,
    sha256: String,
    size_bytes: u64,
}

/// Constant-size facts kept in the original operation's owner receipt.
///
/// At most the current and next manifest prefixes are authorized. V1 records a
/// replacement identity before rename; v2 keeps one identity and records exact
/// pending append bytes before writing. Lost receipts never authorize strangers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageTreeCopyBinding {
    version: u8,
    scope: CopyScope,
    authorized_versions: Vec<ManifestVersion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_append: Option<PendingAppend>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingAppend {
    offset: u64,
    frame: String,
}

impl StorageTreeCopyBinding {
    pub(super) fn matches_component_scope(
        &self,
        operation_id: &str,
        domain: &str,
        operation_directory_identity: &str,
        source_root_identity: &str,
        target_root_identity: &str,
    ) -> bool {
        check_binding(self, &self.scope).is_ok()
            && self.scope.operation_id == operation_id
            && self.scope.domain == domain
            && self.scope.operation_directory_identity == operation_directory_identity
            && self.scope.source_root_identity == source_root_identity
            && self.scope.staging_root_identity == target_root_identity
    }
}

/// Counts describe the verified staging tree, including entries resumed by ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageTreeCopyReceipt {
    pub files_copied: u64,
    pub directories_copied: u64,
    pub bytes_copied: u64,
}

/// JSON strings cannot represent every native filename. Store exact components,
/// and reject a manifest from another platform instead of lossy conversion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "encoding", content = "components", rename_all = "camelCase")]
enum NativeRelativePath {
    UnixBytes(Vec<Vec<u8>>),
    WindowsWide(Vec<Vec<u16>>),
}

impl NativeRelativePath {
    fn encode(path: &Path) -> Result<Self> {
        let components = native_components(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            Ok(Self::UnixBytes(
                components
                    .iter()
                    .map(|part| part.as_bytes().to_vec())
                    .collect(),
            ))
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            Ok(Self::WindowsWide(
                components
                    .iter()
                    .map(|part| part.encode_wide().collect())
                    .collect(),
            ))
        }
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("STORAGE_TREE_NATIVE_PATH_UNSUPPORTED")
    }

    fn decode(&self) -> Result<PathBuf> {
        let mut path = PathBuf::new();
        match self {
            #[cfg(unix)]
            Self::UnixBytes(components) => {
                use std::os::unix::ffi::OsStringExt;
                for part in components {
                    path.push(OsString::from_vec(part.clone()));
                }
            }
            #[cfg(windows)]
            Self::WindowsWide(components) => {
                use std::os::windows::ffi::OsStringExt;
                for part in components {
                    path.push(OsString::from_wide(part));
                }
            }
            #[allow(unreachable_patterns)]
            _ => anyhow::bail!("STORAGE_TREE_NATIVE_PATH_UNSUPPORTED"),
        }
        // Re-encoding also rejects embedded separators, absolute components,
        // empty names, NULs, and noncanonical paths in a supplied manifest.
        ensure!(
            Self::encode(&path)? == *self,
            "STORAGE_TREE_MANIFEST_INVALID"
        );
        Ok(path)
    }
}

fn native_components(path: &Path) -> Result<Vec<OsString>> {
    let mut parts = Vec::new();
    let mut reconstructed = PathBuf::new();
    let mut units = 0usize;
    for component in path.components() {
        let Component::Normal(name) = component else {
            anyhow::bail!("STORAGE_TREE_MANIFEST_INVALID");
        };
        #[cfg(unix)]
        let count = {
            use std::os::unix::ffi::OsStrExt;
            let bytes = name.as_bytes();
            ensure!(!bytes.contains(&0), "STORAGE_TREE_MANIFEST_INVALID");
            bytes.len()
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::ffi::OsStrExt;
            let wide = name.encode_wide().collect::<Vec<_>>();
            ensure!(!wide.contains(&0), "STORAGE_TREE_MANIFEST_INVALID");
            wide.len()
        };
        #[cfg(not(any(unix, windows)))]
        let count = name.len();
        units = units
            .checked_add(count)
            .context("STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED")?;
        ensure!(
            units <= PATH_UNIT_LIMIT,
            "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
        );
        parts.push(name.to_os_string());
        reconstructed.push(name);
    }
    ensure!(
        !parts.is_empty() && reconstructed == path,
        "STORAGE_TREE_MANIFEST_INVALID"
    );
    Ok(parts)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum EntryKind {
    RegularFile,
    Directory,
    Symlink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceEntry {
    path: NativeRelativePath,
    kind: EntryKind,
    identity: String,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    excluded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceInventory {
    root_identity: String,
    entries: Vec<SourceEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum Publication {
    Pending,
    Excluded,
    FilePrepared { identity: String },
    Published { identity: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    version: u8,
    scope: CopyScope,
    inventory: SourceInventory,
    publications: Vec<Publication>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ManifestDelta {
    Entry {
        index: usize,
        publication: Publication,
    },
    Verified,
}

struct AppendProgress {
    file: File,
    hash: Sha256,
    stamp: MutationStamp,
    verified: bool,
}

fn manifest_limit(version: u8) -> usize {
    if version == 2 {
        APPEND_MANIFEST_LIMIT
    } else {
        MANIFEST_LIMIT
    }
}

struct BoundedMetadata(Vec<u8>);

impl Write for BoundedMetadata {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MANIFEST_LIMIT.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other(
                "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn metadata_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut bytes = BoundedMetadata(Vec::new());
    serde_json::to_writer(&mut bytes, value).context("STORAGE_TREE_MANIFEST_WRITE_FAILED")?;
    Ok(bytes.0)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identity(identity: &str) -> bool {
    !identity.is_empty() && identity.len() <= 256
}

pub(super) fn file_identity(file: &File) -> Result<String> {
    serde_json::to_string(&PortableLeaseIdentity::from_regular_handle(file)?)
        .context("STORAGE_TREE_IDENTITY_UNAVAILABLE")
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn optional_identity(directory: &PrivateDirectory, name: &OsStr) -> Result<Option<String>> {
    match directory.open_entry_handle(name) {
        Ok(entry) => Ok(Some(entry.identity()?)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn encode_inventory(inventory: &StorageTreeInventory) -> Result<SourceInventory> {
    ensure!(
        inventory.entries.len() <= ENTRY_LIMIT,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    ensure!(
        valid_identity(&inventory.root_identity),
        "STORAGE_TREE_MANIFEST_INVALID"
    );
    let mut entries = Vec::with_capacity(inventory.entries.len());
    let mut known = BTreeMap::<PathBuf, StorageTreeEntryKind>::new();
    let mut metadata_size = metadata_bytes(&SourceInventory {
        root_identity: inventory.root_identity.clone(),
        entries: Vec::new(),
    })?
    .len();
    for entry in &inventory.entries {
        let path = NativeRelativePath::encode(&entry.relative_path)?;
        ensure!(
            valid_identity(&entry.identity),
            "STORAGE_TREE_MANIFEST_INVALID"
        );
        if let Some((previous, _)) = known.last_key_value() {
            ensure!(
                *previous < entry.relative_path,
                "STORAGE_TREE_MANIFEST_INVALID"
            );
        }
        if let Some(parent) = entry
            .relative_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            ensure!(
                known.get(parent) == Some(&StorageTreeEntryKind::Directory),
                "STORAGE_TREE_MANIFEST_INVALID"
            );
        }
        let kind = match entry.kind {
            StorageTreeEntryKind::RegularFile => {
                ensure!(
                    entry.size_bytes.is_some()
                        && if entry.excluded {
                            entry.sha256.is_none()
                        } else {
                            entry.sha256.as_deref().is_some_and(valid_hash)
                        },
                    "STORAGE_TREE_MANIFEST_INVALID"
                );
                EntryKind::RegularFile
            }
            StorageTreeEntryKind::Directory => {
                ensure!(
                    entry.size_bytes.is_none() && entry.sha256.is_none(),
                    "STORAGE_TREE_MANIFEST_INVALID"
                );
                EntryKind::Directory
            }
            StorageTreeEntryKind::Symlink => {
                ensure!(entry.excluded, "STORAGE_TREE_LINK_UNSUPPORTED");
                ensure!(
                    entry.size_bytes.is_none() && entry.sha256.is_none(),
                    "STORAGE_TREE_MANIFEST_INVALID"
                );
                EntryKind::Symlink
            }
        };
        let fact = SourceEntry {
            path,
            kind,
            identity: entry.identity.clone(),
            size_bytes: entry.size_bytes,
            sha256: entry.sha256.clone(),
            excluded: entry.excluded,
        };
        metadata_size = metadata_size
            .checked_add(metadata_bytes(&fact)?.len())
            .and_then(|size| size.checked_add(usize::from(!entries.is_empty())))
            .context("STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED")?;
        ensure!(
            metadata_size <= MANIFEST_LIMIT,
            "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
        );
        known.insert(entry.relative_path.clone(), entry.kind);
        entries.push(fact);
    }
    Ok(SourceInventory {
        root_identity: inventory.root_identity.clone(),
        entries,
    })
}

struct CopyContext<'a> {
    source: &'a PrivateDirectory,
    staging: &'a PrivateDirectory,
    operation: &'a PrivateDirectory,
    target_fences: &'a BTreeSet<String>,
    append: RefCell<Option<AppendProgress>>,
    name: OsString,
    scope: CopyScope,
}

fn verify_roots(context: &CopyContext<'_>) -> Result<()> {
    ensure!(
        context.source.directory_identity()? == context.scope.source_root_identity
            && context.staging.directory_identity()? == context.scope.staging_root_identity
            && context.operation.directory_identity()?
                == context.scope.operation_directory_identity,
        "STORAGE_TREE_ROOT_CHANGED"
    );
    Ok(())
}

fn check_binding(binding: &StorageTreeCopyBinding, scope: &CopyScope) -> Result<()> {
    ensure!(
        (1..=2).contains(&binding.version),
        "STORAGE_TREE_MANIFEST_VERSION_UNSUPPORTED"
    );
    ensure!(
        binding.scope == *scope
            && valid_hash(&binding.scope.inventory_sha256)
            && (1..=2).contains(&binding.authorized_versions.len())
            && binding
                .authorized_versions
                .iter()
                .all(|version| valid_identity(&version.identity)
                    && valid_hash(&version.sha256)
                    && version.size_bytes <= manifest_limit(binding.version) as u64),
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    if let Some(pending) = &binding.pending_append {
        ensure!(
            binding.version == 2
                && binding.authorized_versions.len() == 2
                && pending.frame.len() <= APPEND_FRAME_LIMIT
                && pending.frame.ends_with('\n'),
            "STORAGE_TREE_MANIFEST_CONFLICT"
        );
        let before = &binding.authorized_versions[0];
        let after = &binding.authorized_versions[1];
        ensure!(
            before.identity == after.identity
                && before.size_bytes == pending.offset
                && before.size_bytes.checked_add(pending.frame.len() as u64)
                    == Some(after.size_bytes),
            "STORAGE_TREE_MANIFEST_CONFLICT"
        );
    } else {
        ensure!(
            binding.version == 1 || binding.authorized_versions.len() == 1,
            "STORAGE_TREE_MANIFEST_CONFLICT"
        );
    }
    Ok(())
}

fn read_manifest(
    context: &CopyContext<'_>,
    binding: Option<&StorageTreeCopyBinding>,
    read_only: bool,
) -> Result<Option<(Manifest, ManifestVersion)>> {
    if let Some(binding) = binding.filter(|binding| binding.version == 2) {
        return read_append_manifest(context, binding, read_only);
    }
    let mut file = match context.operation.open_regular_file_snapshot(&context.name) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.context("STORAGE_TREE_MANIFEST_UNKNOWN")),
    };
    let binding = binding.context("STORAGE_TREE_MANIFEST_UNKNOWN")?;
    let identity = file_identity(&file)?;
    let size_bytes = file.metadata()?.len();
    ensure!(
        size_bytes <= MANIFEST_LIMIT as u64,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    ensure!(
        binding
            .authorized_versions
            .iter()
            .any(|version| version.identity == identity && version.size_bytes == size_bytes),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == size_bytes && file_identity(&file)? == identity,
        "STORAGE_TREE_MANIFEST_CHANGED"
    );
    let actual = ManifestVersion {
        identity,
        sha256: digest(&bytes),
        size_bytes,
    };
    ensure!(
        binding.authorized_versions.contains(&actual),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    ensure!(
        optional_identity(context.operation, &context.name)?.as_ref() == Some(&actual.identity),
        "STORAGE_TREE_MANIFEST_CHANGED"
    );
    let manifest: Manifest =
        serde_json::from_slice(&bytes).context("STORAGE_TREE_MANIFEST_INVALID")?;
    ensure!(
        manifest.version == 1,
        "STORAGE_TREE_MANIFEST_VERSION_UNSUPPORTED"
    );
    ensure!(
        manifest.scope == context.scope,
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    Ok(Some((manifest, actual)))
}

fn verify_manifest_name(
    context: &CopyContext<'_>,
    expected: Option<&ManifestVersion>,
) -> Result<()> {
    ensure!(
        optional_identity(context.operation, &context.name)?
            == expected.map(|version| version.identity.clone()),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    if let Some(expected) = expected {
        let mut file = context
            .operation
            .open_single_link_regular_file(&context.name)?;
        ensure!(
            file_identity(&file)? == expected.identity
                && file.metadata()?.len() == expected.size_bytes
                && hash_file(&mut file, expected.size_bytes)? == expected.sha256,
            "STORAGE_TREE_MANIFEST_UNKNOWN"
        );
    }
    Ok(())
}

fn persist_manifest(
    context: &CopyContext<'_>,
    manifest: &Manifest,
    current: &mut Option<ManifestVersion>,
    entry: Option<usize>,
    record: &mut impl FnMut(&StorageTreeCopyBinding) -> Result<()>,
) -> Result<()> {
    if manifest.version == 2 {
        return persist_append_manifest(context, manifest, current, entry, record);
    }
    verify_roots(context)?;
    verify_manifest_name(context, current.as_ref())?;
    let bytes = metadata_bytes(manifest)?;
    let sha256 = digest(&bytes);
    let previous = current.clone();
    let mut prepared = None;
    context.operation.atomic_publish_observed_from_reader(
        &context.name,
        &mut bytes.as_slice(),
        previous.is_some(),
        || {
            verify_roots(context)?;
            verify_manifest_name(context, previous.as_ref())?;
            Ok(())
        },
        |file| {
            let next = ManifestVersion {
                identity: file_identity(file)?,
                sha256,
                size_bytes: bytes.len() as u64,
            };
            let mut authorized_versions = previous.clone().into_iter().collect::<Vec<_>>();
            authorized_versions.push(next.clone());
            record(&StorageTreeCopyBinding {
                version: 1,
                scope: context.scope.clone(),
                authorized_versions,
                pending_append: None,
            })?;
            verify_roots(context)?;
            verify_manifest_name(context, previous.as_ref())?;
            prepared = Some(next);
            Ok(())
        },
    )?;
    *current = prepared;
    Ok(())
}

fn apply_delta(manifest: &mut Manifest, delta: ManifestDelta, verified: &mut bool) -> Result<()> {
    match delta {
        ManifestDelta::Entry { index, publication } => {
            let source = manifest
                .inventory
                .entries
                .get(index)
                .context("STORAGE_TREE_MANIFEST_INVALID")?;
            ensure!(
                !source.excluded
                    && match &publication {
                        Publication::FilePrepared { identity } =>
                            source.kind == EntryKind::RegularFile && valid_identity(identity),
                        Publication::Published { identity } =>
                            source.kind == EntryKind::Directory && valid_identity(identity),
                        _ => false,
                    },
                "STORAGE_TREE_MANIFEST_INVALID"
            );
            let previous = manifest
                .publications
                .get_mut(index)
                .context("STORAGE_TREE_MANIFEST_INVALID")?;
            ensure!(
                !matches!(previous, Publication::Excluded)
                    && (!matches!(previous, Publication::Published { .. })
                        || *previous == publication),
                "STORAGE_TREE_MANIFEST_INVALID"
            );
            *previous = publication;
            *verified = false;
        }
        ManifestDelta::Verified => *verified = true,
    }
    Ok(())
}

fn decode_append_manifest(context: &CopyContext<'_>, bytes: &[u8]) -> Result<(Manifest, bool)> {
    let header_end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .context("STORAGE_TREE_MANIFEST_INVALID")?;
    ensure!(
        header_end < MANIFEST_LIMIT,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    let mut manifest: Manifest =
        serde_json::from_slice(&bytes[..header_end]).context("STORAGE_TREE_MANIFEST_INVALID")?;
    ensure!(
        manifest.version == 2,
        "STORAGE_TREE_MANIFEST_VERSION_UNSUPPORTED"
    );
    ensure!(
        manifest.scope == context.scope
            && manifest.inventory.entries.len() <= ENTRY_LIMIT
            && manifest.inventory.entries.len() == manifest.publications.len()
            && digest(&metadata_bytes(&manifest.inventory)?) == context.scope.inventory_sha256,
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    let mut verified = false;
    for frame in bytes[header_end + 1..].split_inclusive(|byte| *byte == b'\n') {
        ensure!(
            frame.len() <= APPEND_FRAME_LIMIT && frame.last() == Some(&b'\n'),
            "STORAGE_TREE_MANIFEST_INVALID"
        );
        let delta = serde_json::from_slice(&frame[..frame.len() - 1])
            .context("STORAGE_TREE_MANIFEST_INVALID")?;
        apply_delta(&mut manifest, delta, &mut verified)?;
    }
    Ok((manifest, verified))
}

fn read_append_manifest(
    context: &CopyContext<'_>,
    binding: &StorageTreeCopyBinding,
    read_only: bool,
) -> Result<Option<(Manifest, ManifestVersion)>> {
    let opened = if read_only {
        context.operation.open_regular_file_snapshot(&context.name)
    } else {
        context.operation.open_read_write_file(&context.name, false)
    };
    let mut file = match opened {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.context("STORAGE_TREE_MANIFEST_UNKNOWN")),
    };
    let identity = file_identity(&file)?;
    let before = file.metadata()?;
    ensure!(
        before.len() <= APPEND_MANIFEST_LIMIT as u64,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    ensure!(
        binding
            .authorized_versions
            .iter()
            .all(|version| version.identity == identity),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    let stamp = MutationStamp::read(&before);
    let mut bytes = Vec::new();
    (&mut file)
        .take(APPEND_MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == before.len()
            && file_identity(&file)? == identity
            && MutationStamp::read(&file.metadata()?) == stamp
            && optional_identity(context.operation, &context.name)?.as_ref() == Some(&identity),
        "STORAGE_TREE_MANIFEST_CHANGED"
    );

    if let Some(pending) = &binding.pending_append {
        let old = &binding.authorized_versions[0];
        let next = &binding.authorized_versions[1];
        if before.len() < next.size_bytes {
            // Successful v2 copies retain this authorized append intent. A
            // read-only observer may accept its complete next checkpoint, but
            // must never finish an absent or partial suffix on its behalf.
            ensure!(!read_only, "STORAGE_TREE_MANIFEST_UNKNOWN");
            ensure!(
                before.len() >= pending.offset,
                "STORAGE_TREE_MANIFEST_UNKNOWN"
            );
            let offset =
                usize::try_from(pending.offset).context("STORAGE_TREE_MANIFEST_INVALID")?;
            ensure!(
                digest(&bytes[..offset]) == old.sha256
                    && pending.frame.as_bytes().starts_with(&bytes[offset..]),
                "STORAGE_TREE_MANIFEST_UNKNOWN"
            );
            decode_append_manifest(context, &bytes[..offset])?;
            let mut after = Sha256::new();
            after.update(&bytes[..offset]);
            after.update(pending.frame.as_bytes());
            ensure!(
                format!("{:x}", after.finalize()) == next.sha256,
                "STORAGE_TREE_MANIFEST_UNKNOWN"
            );
            // This exact metadata append was durably authorized before writing.
            // Complete only its matching prefix; never truncate unknown tails.
            verify_roots(context)?;
            ensure!(
                MutationStamp::read(&file.metadata()?) == stamp
                    && optional_identity(context.operation, &context.name)?.as_ref()
                        == Some(&identity),
                "STORAGE_TREE_MANIFEST_CHANGED"
            );
            let written = bytes.len() - offset;
            file.seek(SeekFrom::End(0))?;
            file.write_all(&pending.frame.as_bytes()[written..])?;
            file.sync_all()?;
            bytes.extend_from_slice(&pending.frame.as_bytes()[written..]);
        }
    }
    let actual = ManifestVersion {
        identity,
        sha256: digest(&bytes),
        size_bytes: bytes.len() as u64,
    };
    ensure!(
        binding.authorized_versions.contains(&actual)
            && file.metadata()?.len() == actual.size_bytes
            && file_identity(&file)? == actual.identity
            && optional_identity(context.operation, &context.name)?.as_ref()
                == Some(&actual.identity),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    let (manifest, verified) = decode_append_manifest(context, &bytes)?;
    let mut hash = Sha256::new();
    hash.update(&bytes);
    *context.append.borrow_mut() = Some(AppendProgress {
        stamp: MutationStamp::read(&file.metadata()?),
        file,
        hash,
        verified,
    });
    Ok(Some((manifest, actual)))
}

fn verify_append_file(
    context: &CopyContext<'_>,
    progress: &AppendProgress,
    expected: &ManifestVersion,
) -> Result<()> {
    verify_roots(context)?;
    ensure!(
        file_identity(&progress.file)? == expected.identity
            && optional_identity(context.operation, &context.name)?.as_ref()
                == Some(&expected.identity)
            && progress.file.metadata()?.len() == expected.size_bytes
            && MutationStamp::read(&progress.file.metadata()?) == progress.stamp,
        "STORAGE_TREE_MANIFEST_CHANGED"
    );
    Ok(())
}

/// Read only the original, fully copied source facts authenticated by its owner
/// receipt. This does not reopen a movable target or repair a partial manifest.
pub(super) fn copied_source_inventory(
    operation: &PrivateDirectory,
    operation_id: &str,
    domain: &str,
    source_identity: &str,
    binding: &StorageTreeCopyBinding,
) -> Result<StorageTreeInventory> {
    check_binding(binding, &binding.scope)?;
    ensure!(
        binding.scope.operation_id == operation_id
            && binding.scope.domain == domain
            && binding.scope.source_root_identity == source_identity
            && binding.scope.operation_directory_identity == operation.directory_identity()?,
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    // Read-only manifest decoding uses only the operation handle and recorded
    // scope. The two unused copy handles cannot grant repair/publication rights.
    let context = CopyContext {
        source: operation,
        staging: operation,
        operation,
        target_fences: &BTreeSet::new(),
        append: RefCell::new(None),
        name: OsString::from(format!("tree-copy-{domain}.json")),
        scope: binding.scope.clone(),
    };
    let (manifest, _) =
        read_manifest(&context, Some(binding), true)?.context("STORAGE_TREE_MANIFEST_UNKNOWN")?;
    ensure!(
        manifest.inventory.entries.len() == manifest.publications.len()
            && digest(&metadata_bytes(&manifest.inventory)?) == binding.scope.inventory_sha256
            && (binding.version == 1
                || context
                    .append
                    .borrow()
                    .as_ref()
                    .is_some_and(|state| state.verified)),
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    let mut entries = Vec::with_capacity(manifest.inventory.entries.len());
    for (entry, publication) in manifest
        .inventory
        .entries
        .iter()
        .zip(&manifest.publications)
    {
        ensure!(
            match (entry.excluded, entry.kind, publication) {
                (true, _, Publication::Excluded) => true,
                (false, EntryKind::RegularFile, Publication::FilePrepared { identity })
                | (false, EntryKind::Directory, Publication::Published { identity }) =>
                    valid_identity(identity),
                _ => false,
            },
            "STORAGE_TREE_MANIFEST_CONFLICT"
        );
        entries.push(super::StorageTreeEntry {
            relative_path: entry.path.decode()?,
            kind: match entry.kind {
                EntryKind::RegularFile => StorageTreeEntryKind::RegularFile,
                EntryKind::Directory => StorageTreeEntryKind::Directory,
                EntryKind::Symlink => StorageTreeEntryKind::Symlink,
            },
            identity: entry.identity.clone(),
            size_bytes: entry.size_bytes,
            sha256: entry.sha256.clone(),
            excluded: entry.excluded,
        });
    }
    let inventory = StorageTreeInventory {
        root_identity: manifest.inventory.root_identity.clone(),
        entries,
    };
    ensure!(
        inventory.root_identity == source_identity
            && encode_inventory(&inventory)? == manifest.inventory,
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    Ok(inventory)
}

fn persist_append_manifest(
    context: &CopyContext<'_>,
    manifest: &Manifest,
    current: &mut Option<ManifestVersion>,
    entry: Option<usize>,
    record: &mut impl FnMut(&StorageTreeCopyBinding) -> Result<()>,
) -> Result<()> {
    let Some(previous) = current.clone() else {
        verify_roots(context)?;
        verify_manifest_name(context, None)?;
        let mut bytes = metadata_bytes(manifest)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= MANIFEST_LIMIT,
            "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
        );
        let sha256 = digest(&bytes);
        let mut prepared = None;
        context.operation.atomic_publish_observed_from_reader(
            &context.name,
            &mut bytes.as_slice(),
            false,
            || {
                verify_roots(context)?;
                verify_manifest_name(context, None)?;
                Ok(())
            },
            |file| {
                let version = ManifestVersion {
                    identity: file_identity(file)?,
                    sha256,
                    size_bytes: bytes.len() as u64,
                };
                record(&StorageTreeCopyBinding {
                    version: 2,
                    scope: context.scope.clone(),
                    authorized_versions: vec![version.clone()],
                    pending_append: None,
                })?;
                verify_roots(context)?;
                verify_manifest_name(context, None)?;
                prepared = Some((version, file.try_clone()?));
                Ok(())
            },
        )?;
        let (version, file) = prepared.context("STORAGE_TREE_MANIFEST_UNKNOWN")?;
        let mut hash = Sha256::new();
        hash.update(&bytes);
        *context.append.borrow_mut() = Some(AppendProgress {
            stamp: MutationStamp::read(&file.metadata()?),
            file,
            hash,
            verified: false,
        });
        *current = Some(version);
        return Ok(());
    };
    let mut held = context.append.borrow_mut();
    let progress = held.as_mut().context("STORAGE_TREE_MANIFEST_UNKNOWN")?;
    verify_append_file(context, progress, &previous)?;
    if entry.is_none() && progress.verified {
        return Ok(());
    }
    let delta = match entry {
        Some(index) => ManifestDelta::Entry {
            index,
            publication: manifest.publications[index].clone(),
        },
        None => ManifestDelta::Verified,
    };
    let mut bytes = serde_json::to_vec(&delta)?;
    bytes.push(b'\n');
    ensure!(
        bytes.len() <= APPEND_FRAME_LIMIT,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    let mut hash = progress.hash.clone();
    hash.update(&bytes);
    let next = ManifestVersion {
        identity: previous.identity.clone(),
        sha256: format!("{:x}", hash.clone().finalize()),
        size_bytes: previous
            .size_bytes
            .checked_add(bytes.len() as u64)
            .context("STORAGE_TREE_SIZE_OVERFLOW")?,
    };
    ensure!(
        next.size_bytes <= APPEND_MANIFEST_LIMIT as u64,
        "STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED"
    );
    let frame = String::from_utf8(bytes).context("STORAGE_TREE_MANIFEST_INVALID")?;
    record(&StorageTreeCopyBinding {
        version: 2,
        scope: context.scope.clone(),
        authorized_versions: vec![previous.clone(), next.clone()],
        pending_append: Some(PendingAppend {
            offset: previous.size_bytes,
            frame: frame.clone(),
        }),
    })?;
    verify_append_file(context, progress, &previous)?;
    progress.file.seek(SeekFrom::End(0))?;
    progress.file.write_all(frame.as_bytes())?;
    progress.file.sync_all()?;
    ensure!(
        progress.file.metadata()?.len() == next.size_bytes
            && file_identity(&progress.file)? == next.identity
            && optional_identity(context.operation, &context.name)?.as_ref()
                == Some(&next.identity),
        "STORAGE_TREE_MANIFEST_CHANGED"
    );
    progress.hash = hash;
    progress.stamp = MutationStamp::read(&progress.file.metadata()?);
    progress.verified = entry.is_none();
    *current = Some(next);
    Ok(())
}

fn open_parent(
    root: &PrivateDirectory,
    path: &Path,
    identities: &BTreeMap<PathBuf, String>,
) -> Result<PrivateDirectory> {
    let mut current = root.duplicate_handle()?;
    let mut relative = PathBuf::new();
    let parent = path.parent().context("STORAGE_TREE_MANIFEST_INVALID")?;
    for part in parent.components() {
        let Component::Normal(name) = part else {
            anyhow::bail!("STORAGE_TREE_MANIFEST_INVALID");
        };
        relative.push(name);
        let expected = identities
            .get(&relative)
            .context("STORAGE_TREE_DIRECTORY_UNKNOWN")?;
        let child = current.open_entry_handle(name)?;
        ensure!(
            child.identity()? == *expected,
            "STORAGE_TREE_DIRECTORY_CHANGED"
        );
        let next = child.open_child_directory()?;
        drop(child);
        current = next;
        ensure!(
            current.directory_identity()? == *expected,
            "STORAGE_TREE_DIRECTORY_CHANGED"
        );
    }
    Ok(current)
}

fn hash_file(file: &mut File, expected_bytes: u64) -> Result<String> {
    let mut hash = Sha256::new();
    if expected_bytes == 0 {
        return Ok(format!("{:x}", hash.finalize()));
    }
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    let mut count = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .context("STORAGE_TREE_SIZE_OVERFLOW")?;
        ensure!(count <= expected_bytes, "STORAGE_TREE_FILE_CHANGED");
        hash.update(&buffer[..read]);
    }
    ensure!(count == expected_bytes, "STORAGE_TREE_FILE_CHANGED");
    Ok(format!("{:x}", hash.finalize()))
}

/// Recheck one original source file under the caller's actual root leases.
/// The returned metadata version is preview evidence, never deletion authority.
pub(super) fn verify_source_file(
    file: &mut File,
    expected: &super::StorageTreeEntry,
) -> Result<String> {
    let stamp = MutationStamp::read(&file.metadata()?);
    ensure!(
        Some(stamp.length) == expected.size_bytes,
        "STORAGE_TREE_SOURCE_CHANGED"
    );
    file.seek(SeekFrom::Start(0))?;
    ensure!(
        Some(hash_file(file, stamp.length)?) == expected.sha256
            && file_identity(file)? == expected.identity
            && MutationStamp::read(&file.metadata()?) == stamp,
        "STORAGE_TREE_SOURCE_CHANGED"
    );
    Ok(digest(&metadata_bytes(&stamp)?))
}

/// Inspect actual target names before copying. Only recorded destination native
/// identities are eligible for recovery; even byte-identical strangers fail.
fn verify_staging(
    context: &CopyContext<'_>,
    manifest: &Manifest,
    paths: &[PathBuf],
    require_complete: bool,
) -> Result<()> {
    let by_path = paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let source_directories = paths
        .iter()
        .zip(&manifest.inventory.entries)
        .filter(|(_, entry)| entry.kind == EntryKind::Directory)
        .map(|(path, entry)| (path.clone(), entry.identity.clone()))
        .collect::<BTreeMap<_, _>>();
    let target_directories = paths
        .iter()
        .zip(&manifest.inventory.entries)
        .zip(&manifest.publications)
        .filter_map(|((path, entry), publication)| match publication {
            Publication::Published { identity } if entry.kind == EntryKind::Directory => {
                Some((path.clone(), identity.clone()))
            }
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    // Reuse the exact visitor, including stable directory membership and bounded
    // handles. Full I/O belongs only to this explicit offline copy boundary.
    let actual =
        inventory_tree_with_fences(context.staging, &BTreeSet::new(), context.target_fences)
            .context("STORAGE_TREE_TARGET_UNKNOWN")?;
    ensure!(
        actual.root_identity == context.scope.staging_root_identity,
        "STORAGE_TREE_ROOT_CHANGED"
    );
    let mut seen = BTreeSet::new();
    for entry in &actual.entries {
        // Only the coordinator's actual held descriptor identities identify
        // control fences. An equal basename is still ordinary unknown data.
        if entry.excluded {
            continue;
        }
        let index = *by_path
            .get(&entry.relative_path)
            .context("STORAGE_TREE_TARGET_UNKNOWN")?;
        let source = &manifest.inventory.entries[index];
        let identity = match &manifest.publications[index] {
            Publication::FilePrepared { identity } | Publication::Published { identity } => {
                identity
            }
            _ => anyhow::bail!("STORAGE_TREE_TARGET_UNKNOWN"),
        };
        ensure!(entry.identity == *identity, "STORAGE_TREE_TARGET_UNKNOWN");
        let expected_kind = match source.kind {
            EntryKind::RegularFile => StorageTreeEntryKind::RegularFile,
            EntryKind::Directory => StorageTreeEntryKind::Directory,
            EntryKind::Symlink => anyhow::bail!("STORAGE_TREE_LINK_UNSUPPORTED"),
        };
        ensure!(
            entry.kind == expected_kind
                && entry.size_bytes == source.size_bytes
                && entry.sha256 == source.sha256,
            "STORAGE_TREE_TARGET_CHANGED"
        );
        if require_complete || entry.kind == StorageTreeEntryKind::RegularFile {
            let name = entry
                .relative_path
                .file_name()
                .context("STORAGE_TREE_MANIFEST_INVALID")?;
            let source_parent =
                open_parent(context.source, &entry.relative_path, &source_directories)?;
            let target_parent =
                open_parent(context.staging, &entry.relative_path, &target_directories)?;
            let source_entry = source_parent.open_entry_handle(name)?;
            let target_entry = target_parent.open_entry_handle(name)?;
            ensure!(
                source_entry.identity()? == source.identity
                    && target_entry.identity()? == *identity,
                "STORAGE_TREE_TARGET_CHANGED"
            );
            verify_copied_metadata(source_entry.metadata(), target_entry.metadata())?;
        }
        seen.insert(index);
    }
    ensure!(
        manifest
            .publications
            .iter()
            .enumerate()
            .all(|(index, state)| {
                matches!(state, Publication::Excluded)
                    || (!require_complete && !matches!(state, Publication::Published { .. }))
                    || seen.contains(&index)
            }),
        "STORAGE_TREE_TARGET_CHANGED"
    );
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct MutationStamp {
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl MutationStamp {
    fn read(metadata: &Metadata) -> Self {
        Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            changed: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ctime(), metadata.ctime_nsec())
            },
        }
    }
}

fn verify_copied_metadata(source: &Metadata, target: &Metadata) -> Result<()> {
    ensure!(
        source.is_file() == target.is_file() && source.is_dir() == target.is_dir(),
        "STORAGE_TREE_TARGET_METADATA_CHANGED"
    );
    // Directory mtime is restored after all child publications on Unix. Windows
    // directory traversal handles do not grant WRITE_ATTRIBUTES.
    if source.is_file() || cfg!(unix) {
        ensure!(
            source
                .modified()
                .context("STORAGE_TREE_SOURCE_FILE_TIME_UNAVAILABLE")?
                == target
                    .modified()
                    .context("STORAGE_TREE_TARGET_FILE_TIME_UNAVAILABLE")?,
            "STORAGE_TREE_TARGET_FILE_TIME_PRECISION_UNSUPPORTED"
        );
    }
    Ok(())
}

fn preserve_copy_times(target: &File, source: &Metadata) -> Result<()> {
    let before = target.metadata()?;
    ensure!(
        source.is_file() && before.is_file() || source.is_dir() && before.is_dir(),
        "STORAGE_TREE_TARGET_METADATA_UNSUPPORTED"
    );
    let mut changed = false;
    if source.is_file() || cfg!(unix) {
        let modified = source
            .modified()
            .context("STORAGE_TREE_SOURCE_FILE_TIME_UNAVAILABLE")?;
        if target.metadata()?.modified()? != modified {
            let mut times = FileTimes::new().set_modified(modified);
            if let Ok(accessed) = source.accessed() {
                times = times.set_accessed(accessed);
            }
            target
                .set_times(times)
                .context("STORAGE_TREE_TARGET_FILE_TIME_UNSUPPORTED")?;
            changed = true;
        }
    }
    if changed {
        target
            .sync_all()
            .context("STORAGE_TREE_TARGET_METADATA_SYNC_FAILED")?;
    }
    verify_copied_metadata(source, &target.metadata()?)
        .context("STORAGE_TREE_TARGET_METADATA_UNSUPPORTED")
}

fn directory_metadata_handle(directory: &PrivateDirectory) -> Result<File> {
    #[cfg(unix)]
    {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        };
        // Existing traversal handles may be O_PATH. Reopen only the held object
        // itself, never its user pathname, with the access needed for metadata.
        let fd = unsafe {
            libc::openat(
                directory.directory_handle().as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        ensure!(
            fd >= 0,
            "STORAGE_TREE_TARGET_DIRECTORY_METADATA_UNSUPPORTED: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: openat returned one new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let actual = file.metadata()?;
        let held = directory.directory_metadata()?;
        ensure!(
            (actual.dev(), actual.ino()) == (held.dev(), held.ino()),
            "STORAGE_TREE_TARGET_CHANGED"
        );
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        directory.directory_handle().try_clone().map_err(Into::into)
    }
}

#[derive(Default)]
struct CopyDigest {
    hash: Sha256,
    bytes: u64,
}

struct DigestReader<'a> {
    file: &'a File,
    expected_bytes: u64,
    state: &'a RefCell<CopyDigest>,
}

impl Read for DigestReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        // Preserve the owner's Windows byte-range lock. The publication
        // observer still checks size, digest, mutation stamp and file identity.
        if self.expected_bytes == 0 {
            return Ok(0);
        }
        let count = self.file.read(bytes)?;
        let mut state = self.state.borrow_mut();
        state.bytes = state
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("STORAGE_TREE_SIZE_OVERFLOW"))?;
        if state.bytes > self.expected_bytes {
            return Err(std::io::Error::other("STORAGE_TREE_SOURCE_CHANGED"));
        }
        state.hash.update(&bytes[..count]);
        Ok(count)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyCheckpoint {
    ManifestCreated,
    BeforeEntry,
    DirectoryCreated,
    FilePrepared,
    FilePublished,
    BeforeSourceRecheck,
}

/// Copy only while the original coordinator holds the stopped instance leases.
/// `expected` must come from that operation's authenticated owner receipt;
/// `record` durably compare-and-sets the replacement binding before publication.
pub(super) fn copy_tree(
    source: &PrivateDirectory,
    staging: &PrivateDirectory,
    operation: &PrivateDirectory,
    operation_id: &str,
    domain: &str,
    inventory: &StorageTreeInventory,
    target_fences: &BTreeSet<String>,
    expected: Option<&StorageTreeCopyBinding>,
    mut record: impl FnMut(&StorageTreeCopyBinding) -> Result<()>,
) -> Result<StorageTreeCopyReceipt> {
    copy_tree_with_hook(
        source,
        staging,
        operation,
        operation_id,
        domain,
        inventory,
        target_fences,
        expected,
        &mut record,
        |_, _| Ok(()),
    )
}

fn copy_tree_with_hook(
    source: &PrivateDirectory,
    staging: &PrivateDirectory,
    operation: &PrivateDirectory,
    operation_id: &str,
    domain: &str,
    inventory: &StorageTreeInventory,
    target_fences: &BTreeSet<String>,
    expected: Option<&StorageTreeCopyBinding>,
    record: &mut impl FnMut(&StorageTreeCopyBinding) -> Result<()>,
    mut checkpoint: impl FnMut(CopyCheckpoint, &Path) -> Result<()>,
) -> Result<StorageTreeCopyReceipt> {
    ensure!(
        super::resolve::valid_operation_id(operation_id)
            && !domain.is_empty()
            && domain.len() <= 64
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "STORAGE_OPERATION_INVALID"
    );
    let original = encode_inventory(inventory)?;
    let context = CopyContext {
        source,
        staging,
        operation,
        target_fences,
        append: RefCell::new(None),
        name: OsString::from(format!("tree-copy-{domain}.json")),
        scope: CopyScope {
            operation_id: operation_id.to_owned(),
            domain: domain.to_owned(),
            operation_directory_identity: operation.directory_identity()?,
            source_root_identity: inventory.root_identity.clone(),
            staging_root_identity: staging.directory_identity()?,
            inventory_sha256: digest(&metadata_bytes(&original)?),
        },
    };
    ensure!(
        context.scope.source_root_identity != context.scope.staging_root_identity
            && context.scope.source_root_identity != context.scope.operation_directory_identity
            && context.scope.staging_root_identity != context.scope.operation_directory_identity,
        "STORAGE_TREE_ROOT_CONFLICT"
    );
    verify_roots(&context)?;
    if let Some(expected) = expected {
        check_binding(expected, &context.scope)?;
    } else {
        // Use the stopped inventory, not another scan. A resumed copy must not
        // require free space for bytes it has already published.
        let needed = inventory
            .entries
            .iter()
            .filter(|entry| !entry.excluded)
            .try_fold(0u64, |total, entry| {
                total
                    .checked_add(entry.size_bytes.unwrap_or(0))
                    .context("STORAGE_SIZE_OVERFLOW")
            })?;
        super::capacity::check_space(staging, needed)?;
    }
    let exclusions = inventory
        .entries
        .iter()
        .filter(|entry| entry.excluded)
        .map(|entry| entry.relative_path.clone())
        .collect::<BTreeSet<_>>();
    ensure!(
        inventory_tree(source, &exclusions)? == *inventory,
        "STORAGE_TREE_SOURCE_CHANGED"
    );
    let (mut manifest, mut current) = match read_manifest(&context, expected, false)? {
        Some((manifest, version)) => (manifest, Some(version)),
        None => (
            Manifest {
                version: expected.map_or(2, |binding| binding.version),
                scope: context.scope.clone(),
                inventory: original.clone(),
                publications: original
                    .entries
                    .iter()
                    .map(|entry| {
                        if entry.excluded {
                            Publication::Excluded
                        } else {
                            Publication::Pending
                        }
                    })
                    .collect(),
            },
            None,
        ),
    };
    ensure!(
        manifest.inventory == original && manifest.publications.len() == original.entries.len(),
        "STORAGE_TREE_MANIFEST_CONFLICT"
    );
    let paths = original
        .entries
        .iter()
        .map(|entry| entry.path.decode())
        .collect::<Result<Vec<_>>>()?;
    for (entry, publication) in original.entries.iter().zip(&manifest.publications) {
        ensure!(
            if entry.excluded {
                matches!(publication, Publication::Excluded)
            } else {
                match publication {
                    Publication::Pending => true,
                    Publication::FilePrepared { identity } => {
                        entry.kind == EntryKind::RegularFile && valid_identity(identity)
                    }
                    Publication::Published { identity } => {
                        entry.kind == EntryKind::Directory && valid_identity(identity)
                    }
                    Publication::Excluded => false,
                }
            },
            "STORAGE_TREE_MANIFEST_INVALID"
        );
    }
    verify_staging(&context, &manifest, &paths, false)?;
    if current.is_none() {
        persist_manifest(&context, &manifest, &mut current, None, record)?;
        checkpoint(CopyCheckpoint::ManifestCreated, Path::new(""))?;
    }
    let source_directories = inventory
        .entries
        .iter()
        .filter(|entry| entry.kind == StorageTreeEntryKind::Directory)
        .map(|entry| (entry.relative_path.clone(), entry.identity.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut target_directories = BTreeMap::new();
    let mut directory_metadata = BTreeMap::new();
    for (index, path) in paths.iter().enumerate() {
        let entry = &original.entries[index];
        if entry.excluded {
            continue;
        }
        checkpoint(CopyCheckpoint::BeforeEntry, path)?;
        verify_roots(&context)?;
        let name = path.file_name().context("STORAGE_TREE_MANIFEST_INVALID")?;
        let source_parent = open_parent(source, path, &source_directories)?;
        let target_parent = open_parent(staging, path, &target_directories)?;
        let source_entry = source_parent.open_entry_handle(name)?;
        ensure!(
            source_entry.identity()? == entry.identity,
            "STORAGE_TREE_SOURCE_CHANGED"
        );
        match entry.kind {
            EntryKind::Directory => {
                let source_child = source_entry.open_child_directory()?;
                let metadata = source_child.directory_metadata()?;
                ensure!(
                    source_child.directory_identity()? == entry.identity
                        && MutationStamp::read(&metadata)
                            == MutationStamp::read(source_entry.metadata()),
                    "STORAGE_TREE_SOURCE_CHANGED"
                );
                directory_metadata.insert(path.clone(), metadata);
                let identity = match &manifest.publications[index] {
                    Publication::Pending => {
                        ensure!(
                            optional_identity(&target_parent, name)?.is_none(),
                            "STORAGE_TREE_TARGET_UNKNOWN"
                        );
                        let child = target_parent.create_child(name).map_err(|error| {
                            super::writers::permission_context(
                                error,
                                format!(
                                    "storage stopped staging directory creation: {}",
                                    path.display()
                                ),
                            )
                        })?;
                        let identity = child.directory_identity()?;
                        checkpoint(CopyCheckpoint::DirectoryCreated, path)?;
                        manifest.publications[index] = Publication::Published {
                            identity: identity.clone(),
                        };
                        persist_manifest(&context, &manifest, &mut current, Some(index), record)?;
                        identity
                    }
                    Publication::Published { identity } => {
                        ensure!(
                            target_parent
                                .open_child(name, false)?
                                .directory_identity()?
                                == *identity,
                            "STORAGE_TREE_TARGET_CHANGED"
                        );
                        identity.clone()
                    }
                    _ => anyhow::bail!("STORAGE_TREE_MANIFEST_INVALID"),
                };
                target_directories.insert(path.clone(), identity);
            }
            EntryKind::RegularFile => {
                if let Some(actual) = optional_identity(&target_parent, name)? {
                    let identity = match &manifest.publications[index] {
                        Publication::FilePrepared { identity } => identity,
                        _ => anyhow::bail!("STORAGE_TREE_TARGET_UNKNOWN"),
                    };
                    ensure!(actual == *identity, "STORAGE_TREE_TARGET_UNKNOWN");
                    continue;
                }
                // A missing prepared copy can be rebuilt from the frozen source
                // digest. This only writes this operation's absent staging leaf;
                // it never replays business actions or replaces existing data.
                let file = source_parent.open_single_link_regular_file(name)?;
                let before = file.metadata()?;
                ensure!(
                    file_identity(&file)? == entry.identity
                        && Some(before.len()) == entry.size_bytes,
                    "STORAGE_TREE_SOURCE_CHANGED"
                );
                let stamp = MutationStamp::read(&before);
                let state = RefCell::new(CopyDigest::default());
                let mut reader = DigestReader {
                    file: &file,
                    expected_bytes: before.len(),
                    state: &state,
                };
                target_parent
                    .atomic_publish_observed_from_reader(
                        name,
                        &mut reader,
                        false,
                        || {
                            let state = state.borrow();
                            ensure!(
                                state.bytes == before.len()
                                    && Some(format!("{:x}", state.hash.clone().finalize()))
                                        == entry.sha256
                                    && file_identity(&file)? == entry.identity
                                    && MutationStamp::read(&file.metadata()?) == stamp
                                    && optional_identity(&source_parent, name)?.as_ref()
                                        == Some(&entry.identity),
                                "STORAGE_TREE_SOURCE_CHANGED"
                            );
                            verify_roots(&context)?;
                            Ok(())
                        },
                        |prepared| {
                            // Verify content and timestamps before recording this exact FD.
                            preserve_copy_times(prepared, &before)?;
                            let identity = file_identity(prepared)?;
                            manifest.publications[index] = Publication::FilePrepared { identity };
                            persist_manifest(
                                &context,
                                &manifest,
                                &mut current,
                                Some(index),
                                record,
                            )?;
                            checkpoint(CopyCheckpoint::FilePrepared, path)?;
                            ensure!(
                                file_identity(&file)? == entry.identity
                                    && MutationStamp::read(&file.metadata()?) == stamp
                                    && optional_identity(&source_parent, name)?.as_ref()
                                        == Some(&entry.identity),
                                "STORAGE_TREE_SOURCE_CHANGED"
                            );
                            Ok(())
                        },
                    )
                    .map_err(|error| {
                        super::writers::permission_context(
                            error,
                            format!(
                                "storage stopped staging file publication: {}",
                                path.display()
                            ),
                        )
                    })?;
                checkpoint(CopyCheckpoint::FilePublished, path)?;
                let Publication::FilePrepared { identity } = &manifest.publications[index] else {
                    unreachable!()
                };
                ensure!(
                    optional_identity(&target_parent, name)?.as_deref() == Some(identity),
                    "STORAGE_TREE_TARGET_CHANGED"
                );
            }
            EntryKind::Symlink => anyhow::bail!("STORAGE_TREE_LINK_UNSUPPORTED"),
        }
    }
    // Newly created directories stay writable/private during payload publication.
    // Restore their original metadata from leaves upward, after every child
    // create/rename, and only under identities recorded by this operation.
    for (path, entry) in paths.iter().zip(&original.entries).rev() {
        if entry.excluded || entry.kind != EntryKind::Directory {
            continue;
        }
        let name = path.file_name().context("STORAGE_TREE_MANIFEST_INVALID")?;
        let source_parent = open_parent(source, path, &source_directories)?;
        let source_child = source_parent
            .open_entry_handle(name)?
            .open_child_directory()?;
        let before = directory_metadata
            .get(path)
            .context("STORAGE_TREE_SOURCE_CHANGED")?;
        let stamp = MutationStamp::read(before);
        ensure!(
            source_child.directory_identity()? == entry.identity
                && MutationStamp::read(&source_child.directory_metadata()?) == stamp,
            "STORAGE_TREE_SOURCE_CHANGED"
        );
        let target_parent = open_parent(staging, path, &target_directories)?;
        let target_child = target_parent
            .open_entry_handle(name)?
            .open_child_directory()?;
        ensure!(
            target_child.directory_identity()? == target_directories[path],
            "STORAGE_TREE_TARGET_CHANGED"
        );
        preserve_copy_times(&directory_metadata_handle(&target_child)?, before)?;
        ensure!(
            MutationStamp::read(&source_child.directory_metadata()?) == stamp
                && optional_identity(&source_parent, name)?.as_deref() == Some(&entry.identity)
                && optional_identity(&target_parent, name)?.as_deref()
                    == Some(&target_directories[path]),
            "STORAGE_TREE_SOURCE_CHANGED"
        );
    }
    checkpoint(CopyCheckpoint::BeforeSourceRecheck, Path::new(""))?;
    ensure!(
        inventory_tree(source, &exclusions)? == *inventory,
        "STORAGE_TREE_SOURCE_CHANGED"
    );
    verify_roots(&context)?;
    verify_staging(&context, &manifest, &paths, true)?;
    if manifest.version == 2 {
        persist_manifest(&context, &manifest, &mut current, None, record)?;
    }
    let mut receipt = StorageTreeCopyReceipt {
        files_copied: 0,
        directories_copied: 0,
        bytes_copied: 0,
    };
    for entry in &original.entries {
        if entry.excluded {
            continue;
        }
        match entry.kind {
            EntryKind::RegularFile => {
                receipt.files_copied += 1;
                receipt.bytes_copied = receipt
                    .bytes_copied
                    .checked_add(entry.size_bytes.unwrap())
                    .context("STORAGE_TREE_SIZE_OVERFLOW")?;
            }
            EntryKind::Directory => receipt.directories_copied += 1,
            EntryKind::Symlink => unreachable!(),
        }
    }
    Ok(receipt)
}

#[cfg(test)]
#[path = "tree_copy_tests.rs"]
mod tests;
