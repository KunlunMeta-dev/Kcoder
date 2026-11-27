//! Separately confirmed removal of exact old copies from a completed operation.
//! Migration completion never calls this module. The original copy manifest and
//! existing coordinator/root leases remain the only provenance and writer fence.
use super::*;
use crate::storage::{
    StorageTreeCopyBinding, StorageTreeEntry, StorageTreeEntryKind, StorageTreeInventory,
    tree_copy::{file_identity as identity, verify_source_file as hash},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
};

const OWNER: &str = "source-cleanup";
const ENTRY_LIMIT: usize = 4096;
// The local helper's existing stdout budget includes its terminating newline.
const REPLY_LIMIT: usize = 1024 * 1024;

#[path = "source_cleanup/compact.rs"]
mod compact;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageSourceCleanupStatus {
    EligibleFile,
    EligibleDirectory,
    RetainedRoot,
    RetainedCurrent,
    RetainedInPlace,
    RetainedExcluded,
    RetainedUnknown,
    RetainedChanged,
    RetainedNotEmpty,
    RetainedUnconfirmed,
    Absent,
    Removed,
}
use StorageSourceCleanupStatus as Status;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageSourceCleanupEntry {
    pub domain: String,
    pub source_root: PathBuf,
    pub relative_path: PathBuf,
    pub status: Status,
    pub size_bytes: Option<u64>,
    // Preview lifetime facts supplement, but never replace, the original manifest.
    pub observed_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageSourceCleanupPreview {
    pub operation_id: String,
    pub selection: StorageLocationRecord,
    pub confirmation: String,
    /// A pending reply must reconcile the saved confirmation under this same ID.
    pub pending: bool,
    pub entries: Vec<StorageSourceCleanupEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageSourceCleanupResult {
    pub operation_id: String,
    pub confirmation: String,
    pub entries: Vec<StorageSourceCleanupEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupBinding {
    version: u8,
    preview: StorageSourceCleanupPreview,
    result: Option<StorageSourceCleanupResult>,
}

struct Source {
    path: PathBuf,
    root: Option<PrivateDirectory>,
    inventory: StorageTreeInventory,
}

struct Prepared {
    receipt: StorageMigrationReceipt,
    preview: StorageSourceCleanupPreview,
    sources: BTreeMap<String, Source>,
    // These exact old-root leases live through every recheck and deletion.
    leases: Vec<crate::storage::writers::RootLease>,
}

fn eligible(status: Status) -> bool {
    matches!(status, Status::EligibleFile | Status::EligibleDirectory)
}

fn fingerprint(preview: &StorageSourceCleanupPreview) -> Result<String> {
    let mut unsigned = preview.clone();
    unsigned.confirmation.clear();
    unsigned.pending = false;
    let bytes = serde_json::to_vec(&unsigned).context("STORAGE_SOURCE_CLEANUP_PREVIEW_INVALID")?;
    ensure!(
        bytes.len().saturating_add(64 + 1) <= REPLY_LIMIT,
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn preflight_source_cleanup(
    receipt: &mut StorageMigrationReceipt,
    value: &CleanupBinding,
) -> Result<()> {
    let mut reserve = value.clone();
    if reserve.result.is_none() {
        let mut entries = reserve.preview.entries.clone();
        for entry in &mut entries {
            entry.status = Status::RetainedUnconfirmed;
        }
        reserve.result = Some(StorageSourceCleanupResult {
            operation_id: reserve.preview.operation_id.clone(),
            confirmation: reserve.preview.confirmation.clone(),
            entries,
        });
    }
    // A lost stdout reply must remain recoverable within the same helper
    // budget. Reserve the longest status before authorizing any deletion.
    ensure!(
        serde_json::to_vec(reserve.result.as_ref().unwrap())?
            .len()
            .saturating_add(1)
            <= REPLY_LIMIT,
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    receipt
        .owner_receipts
        .insert(OWNER.into(), compact::encode(&reserve)?);
    ensure!(
        serde_json::to_vec_pretty(receipt)?.len() as u64 <= RECEIPT_LIMIT,
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    Ok(())
}

fn parent(source: &Source, path: &Path) -> Result<PrivateDirectory> {
    let mut directory = source
        .root
        .as_ref()
        .context("STORAGE_SOURCE_CLEANUP_CHANGED")?
        .try_clone()?;
    let mut relative = PathBuf::new();
    let components = path.components().collect::<Vec<_>>();
    ensure!(
        components.len() <= 128,
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let std::path::Component::Normal(name) = component else {
            anyhow::bail!("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID");
        };
        relative.push(name);
        let original = source
            .inventory
            .entries
            .binary_search_by(|entry| entry.relative_path.cmp(&relative))
            .ok()
            .map(|index| &source.inventory.entries[index])
            .context("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID")?;
        let next = directory.open_child(name, false)?;
        ensure!(
            next.directory_identity()? == original.identity,
            "STORAGE_SOURCE_CLEANUP_CHANGED"
        );
        directory = next;
    }
    Ok(directory)
}

fn protected(
    path: &Path,
    entry: &StorageTreeEntry,
    source: &Source,
    selection: &StorageLocationRecord,
    current_ids: &BTreeSet<String>,
    ancestor_ids: &BTreeSet<String>,
) -> bool {
    let absolute = source.path.join(path);
    if [&selection.data_root, &selection.cache_root]
        .iter()
        .any(|root| absolute.starts_with(root) || root.starts_with(&absolute))
    {
        return true;
    }
    if entry.kind == StorageTreeEntryKind::Directory && ancestor_ids.contains(&entry.identity) {
        return true;
    }
    // Identity checks protect case aliases and current subtrees even when their
    // canonical spelling differs from the original manifest's path spelling.
    current_ids.contains(&source.inventory.root_identity)
        || source.inventory.entries.iter().any(|ancestor| {
            ancestor.kind == StorageTreeEntryKind::Directory
                && current_ids.contains(&ancestor.identity)
                && path.starts_with(&ancestor.relative_path)
        })
}

fn inspect(source: &Source, original: &StorageTreeEntry) -> (Status, Option<String>) {
    let observed = (|| -> Result<(Status, Option<String>)> {
        let parent = parent(source, &original.relative_path)?;
        let name = original
            .relative_path
            .file_name()
            .context("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID")?;
        let entry = parent.open_entry_handle(name)?;
        ensure!(
            entry.identity()? == original.identity,
            "STORAGE_SOURCE_CLEANUP_CHANGED"
        );
        match original.kind {
            StorageTreeEntryKind::RegularFile => {
                let mut held = parent.open_single_link_regular_file(name)?;
                ensure!(
                    identity(&held)? == original.identity,
                    "STORAGE_SOURCE_CLEANUP_CHANGED"
                );
                let stamp = hash(&mut held, original)?;
                ensure!(
                    parent.open_entry_handle(name)?.identity()? == original.identity,
                    "STORAGE_SOURCE_CLEANUP_CHANGED"
                );
                Ok((Status::EligibleFile, Some(stamp)))
            }
            StorageTreeEntryKind::Directory => {
                entry.open_child_directory()?;
                Ok((Status::EligibleDirectory, None))
            }
            StorageTreeEntryKind::Symlink => Ok((Status::RetainedExcluded, None)),
        }
    })();
    match observed {
        Ok(observation) => observation,
        Err(error) if missing(&error) => (Status::Absent, None),
        Err(_) => (Status::RetainedChanged, None),
    }
}

fn push(preview: &mut StorageSourceCleanupPreview, entry: StorageSourceCleanupEntry) -> Result<()> {
    ensure!(
        preview.entries.len() < ENTRY_LIMIT,
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    preview.entries.push(entry);
    Ok(())
}

fn lock_source(
    path: &Path,
    root: &PrivateDirectory,
    inventory: &StorageTreeInventory,
    selection: &StorageLocationRecord,
    current_ids: &BTreeSet<String>,
    leases: &mut Vec<crate::storage::writers::RootLease>,
) -> Result<BTreeMap<PathBuf, (String, Vec<OsString>)>> {
    use crate::storage::writers::{RootLease, WRITERS};
    let original = inventory
        .entries
        .iter()
        .find(|entry| {
            entry.relative_path == Path::new(WRITERS)
                && entry.excluded
                && entry.kind == StorageTreeEntryKind::RegularFile
        })
        .context("STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN")?;
    let original_fence = root
        .open_single_link_regular_file(OsStr::new(WRITERS))
        .context("STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN")?;
    ensure!(
        identity(&original_fence)? == original.identity,
        "STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN"
    );
    if let Some(lease) = RootLease::exclusive_existing(path, leases)? {
        ensure!(
            lease.fence_identity()? == original.identity,
            "STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN"
        );
        leases.push(lease);
    }
    let mut pending = vec![(PathBuf::new(), root.try_clone()?)];
    let mut count = 0usize;
    let mut observed = BTreeMap::new();
    while let Some((relative, directory)) = pending.pop() {
        let current_path = path.join(&relative);
        ensure!(
            PrivateDirectory::open_existing(&current_path)?.directory_identity()?
                == directory.directory_identity()?,
            "STORAGE_SOURCE_CLEANUP_CHANGED"
        );
        let mut names = Vec::new();
        directory
            .visit_entry_names_bounded(ENTRY_LIMIT, |name| {
                count += 1;
                ensure!(count <= ENTRY_LIMIT, "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT");
                names.push(name.to_os_string());
                Ok(())
            })
            .map_err(|error| {
                if PrivateDirectory::is_entry_budget_exhausted(&error) {
                    anyhow::anyhow!("STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT")
                } else {
                    error
                }
            })?;
        names.sort();
        for name in &names {
            let entry = directory.open_entry_handle(name)?;
            if name == OsStr::new(WRITERS) {
                let original = inventory
                    .entries
                    .iter()
                    .find(|entry| entry.relative_path == relative.join(WRITERS));
                if let Some(original) = original {
                    ensure!(
                        original.excluded && entry.identity()? == original.identity,
                        "STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN"
                    );
                }
                if let Some(lease) = RootLease::exclusive_existing(&current_path, leases)? {
                    if let Some(original) = original {
                        ensure!(
                            lease.fence_identity()? == original.identity,
                            "STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN"
                        );
                    }
                    leases.push(lease);
                }
            } else if entry.metadata().is_dir() && !entry.metadata().file_type().is_symlink() {
                let child = relative.join(name);
                let original = inventory
                    .entries
                    .binary_search_by(|entry| entry.relative_path.cmp(&child))
                    .ok()
                    .map(|index| &inventory.entries[index]);
                // Nothing under an unknown, replaced or excluded subtree can
                // be deleted. Do not enumerate its unrelated files or leases.
                if let Some(original) = original
                    && original.kind == StorageTreeEntryKind::Directory
                    && !original.excluded
                    && entry.identity()? == original.identity
                    && !current_ids.contains(&original.identity)
                    && ![&selection.data_root, &selection.cache_root]
                        .iter()
                        .any(|current| path.join(&child).starts_with(current))
                {
                    // Ancestors of a current root are still visited: deletable
                    // siblings need their original writer fences as before.
                    pending.push((child, entry.open_child_directory()?));
                }
            }
        }
        observed.insert(relative, (directory.directory_identity()?, names));
    }
    Ok(observed)
}

fn binding(receipt: &StorageMigrationReceipt) -> Result<Option<CleanupBinding>> {
    let Some(value) = receipt.owner_receipts.get(OWNER) else {
        return Ok(None);
    };
    let saved = compact::decode(value).context("STORAGE_SOURCE_CLEANUP_UNKNOWN")?;
    ensure!(
        matches!(saved.version, 1 | 2)
            && saved.preview.operation_id == receipt.plan.operation_id
            && !saved.preview.pending
            && saved.preview.confirmation == fingerprint(&saved.preview)?
            && saved
                .result
                .as_ref()
                .is_none_or(|result| result.operation_id == saved.preview.operation_id
                    && result.confirmation == saved.preview.confirmation),
        "STORAGE_SOURCE_CLEANUP_UNKNOWN"
    );
    Ok(Some(saved))
}

impl StorageCoordinator {
    fn prepare_source_cleanup(&self, id: &str) -> Result<Prepared> {
        self.verify_control()?;
        let receipt = self.prior_operation_receipt(id)?;
        ensure!(
            receipt.disposition == Disposition::Complete && receipt.phase == Phase::Verified,
            "STORAGE_SOURCE_CLEANUP_NOT_COMPLETE"
        );
        let selected = location(&self.directory)?.context("STORAGE_SELECTION_CHANGED")?;
        let active = self.current()?.context("STORAGE_OPERATION_MISSING")?;
        require_settled_selection(&active, Some(&selected))?;
        let operation = observe_operation_directory(
            self.path.parent().context("STORAGE_CONTROL_INVALID")?,
            id,
        )?;
        let mut current_ids = BTreeSet::new();
        let mut ancestor_ids = BTreeSet::new();
        for root in [&selected.data_root, &selected.cache_root] {
            for (index, path) in root.ancestors().enumerate() {
                match PrivateDirectory::open_existing(path) {
                    Ok(directory) => {
                        let identity = directory.directory_identity()?;
                        if index == 0 {
                            current_ids.insert(identity.clone());
                        }
                        ancestor_ids.insert(identity);
                    }
                    Err(error) if missing(&error) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let mut prepared = Prepared {
            receipt,
            preview: StorageSourceCleanupPreview {
                operation_id: id.into(),
                selection: selected,
                confirmation: String::new(),
                pending: false,
                entries: Vec::new(),
            },
            sources: BTreeMap::new(),
            leases: Vec::new(),
        };
        for component in &prepared.receipt.plan.components {
            let root = match PrivateDirectory::open_existing(&component.source) {
                Ok(root) => Some(root),
                Err(error) if missing(&error) => None,
                Err(error) => return Err(error),
            };
            let root_identity = root
                .as_ref()
                .map(PrivateDirectory::directory_identity)
                .transpose()?;
            let status = if component.source == component.destination {
                Status::RetainedInPlace
            } else if root_identity
                .as_ref()
                .is_some_and(|identity| current_ids.contains(identity))
                || [
                    &prepared.preview.selection.data_root,
                    &prepared.preview.selection.cache_root,
                ]
                .iter()
                .any(|current| component.source.starts_with(current))
            {
                Status::RetainedCurrent
            } else if root_identity
                .as_ref()
                .is_some_and(|identity| *identity != component.source_identity)
            {
                Status::RetainedChanged
            } else {
                Status::RetainedRoot
            };
            push(
                &mut prepared.preview,
                StorageSourceCleanupEntry {
                    domain: component.domain.clone(),
                    source_root: component.source.clone(),
                    relative_path: PathBuf::new(),
                    status,
                    size_bytes: None,
                    observed_version: None,
                },
            )?;
            if status != Status::RetainedRoot {
                continue;
            }
            let value = prepared
                .receipt
                .owner_receipts
                .get(&format!("copy-{}", component.domain))
                .context("STORAGE_SOURCE_CLEANUP_MANIFEST_MISSING")?;
            let original: StorageTreeCopyBinding = serde_json::from_value(value.clone())
                .context("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID")?;
            let inventory = crate::storage::tree_copy::copied_source_inventory(
                &operation,
                id,
                &component.domain,
                &component.source_identity,
                &original,
            )?;
            ensure!(
                inventory.entries.len()
                    <= ENTRY_LIMIT.saturating_sub(prepared.preview.entries.len()),
                "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
            );
            let directories = if let Some(root) = &root {
                // Completed movable sources already have this fence. Do not let
                // a preview manufacture a missing lease or adopt an unknown root.
                lock_source(
                    &component.source,
                    root,
                    &inventory,
                    &prepared.preview.selection,
                    &current_ids,
                    &mut prepared.leases,
                )?
            } else {
                BTreeMap::new()
            };
            let source = Source {
                path: component.source.clone(),
                root,
                inventory,
            };
            for entry in &source.inventory.entries {
                let (status, observed_version) = if protected(
                    &entry.relative_path,
                    entry,
                    &source,
                    &prepared.preview.selection,
                    &current_ids,
                    &ancestor_ids,
                ) {
                    (Status::RetainedCurrent, None)
                } else if entry.excluded {
                    (Status::RetainedExcluded, None)
                } else if source.root.is_none() {
                    (Status::Absent, None)
                } else {
                    inspect(&source, entry)
                };
                push(
                    &mut prepared.preview,
                    StorageSourceCleanupEntry {
                        domain: component.domain.clone(),
                        source_root: source.path.clone(),
                        relative_path: entry.relative_path.clone(),
                        status,
                        size_bytes: entry.size_bytes,
                        observed_version,
                    },
                )?;
            }
            // Reuse the lease scan's names. Unknown subtrees are represented by
            // one preserved item; replaced/excluded/current subtrees stay opaque.
            let known = source
                .inventory
                .entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry))
                .collect::<BTreeMap<_, _>>();
            for (path, (identity, names)) in directories {
                if !path.as_os_str().is_empty()
                    && !known.get(&path).is_some_and(|entry| {
                        entry.identity == identity
                            && !entry.excluded
                            && !protected(
                                &path,
                                entry,
                                &source,
                                &prepared.preview.selection,
                                &current_ids,
                                &ancestor_ids,
                            )
                    })
                {
                    continue;
                }
                for name in names {
                    let relative_path = path.join(name);
                    if !known.contains_key(&relative_path) {
                        push(
                            &mut prepared.preview,
                            StorageSourceCleanupEntry {
                                domain: component.domain.clone(),
                                source_root: source.path.clone(),
                                relative_path,
                                status: Status::RetainedUnknown,
                                size_bytes: None,
                                observed_version: None,
                            },
                        )?;
                    }
                }
            }
            ensure!(
                prepared
                    .sources
                    .insert(component.domain.clone(), source)
                    .is_none(),
                "STORAGE_OPERATION_INVALID"
            );
        }
        self.verify_cleanup_scope(&prepared)?;
        prepared.preview.confirmation = fingerprint(&prepared.preview)?;
        Ok(prepared)
    }

    fn verify_cleanup_scope(&self, prepared: &Prepared) -> Result<()> {
        self.verify_control()?;
        ensure!(
            location(&self.directory)?.as_ref() == Some(&prepared.preview.selection),
            "STORAGE_SELECTION_CHANGED"
        );
        for lease in &prepared.leases {
            lease.verify()?;
        }
        for source in prepared.sources.values() {
            if let Some(root) = &source.root {
                ensure!(
                    PrivateDirectory::open_existing(&source.path)?.directory_identity()?
                        == root.directory_identity()?
                        && root.directory_identity()? == source.inventory.root_identity,
                    "STORAGE_SOURCE_CLEANUP_CHANGED"
                );
            }
        }
        Ok(())
    }

    /// A bounded, non-mutating preview of a completed operation's old copies.
    /// Full payload hashing is intentional at this explicit cleanup boundary.
    pub fn preview_source_cleanup(&self, id: &str) -> Result<StorageSourceCleanupPreview> {
        let mut prepared = self.prepare_source_cleanup(id)?;
        if let Some(saved) = binding(&prepared.receipt)?
            && saved.result.is_none()
        {
            ensure!(
                saved.preview.selection == prepared.preview.selection,
                "STORAGE_SELECTION_CHANGED"
            );
            for entry in &mut prepared.preview.entries {
                if eligible(entry.status)
                    && !saved.preview.entries.iter().any(|original| {
                        original.domain == entry.domain
                            && original.relative_path == entry.relative_path
                            && eligible(original.status)
                    })
                {
                    entry.status = Status::RetainedUnconfirmed;
                }
            }
            prepared.preview.confirmation = saved.preview.confirmation;
            prepared.preview.pending = true;
        }
        ensure!(
            serde_json::to_vec(&prepared.preview)?
                .len()
                .saturating_add(1)
                <= REPLY_LIMIT,
            "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
        );
        Ok(prepared.preview)
    }

    fn record_source_cleanup(
        &self,
        id: &str,
        expected: Option<&serde_json::Value>,
        value: &CleanupBinding,
    ) -> Result<()> {
        let mut receipt = self.prior_operation_receipt(id)?;
        ensure!(
            receipt.disposition == Disposition::Complete
                && receipt.phase == Phase::Verified
                && receipt.owner_receipts.get(OWNER) == expected,
            "STORAGE_SOURCE_CLEANUP_UNKNOWN"
        );
        preflight_source_cleanup(&mut receipt, value)?;
        receipt
            .owner_receipts
            .insert(OWNER.into(), compact::encode(value)?);
        self.write_receipt(&receipt)
    }

    /// Explicit confirmation uses the preview token and original operation ID.
    /// Lost replies reconcile the saved intent; they never create a new migration.
    pub fn confirm_source_cleanup(
        &self,
        id: &str,
        confirmation: &str,
    ) -> Result<StorageSourceCleanupResult> {
        self.confirm_source_cleanup_with_hook(id, confirmation, |_| Ok(()))
    }

    fn confirm_source_cleanup_with_hook(
        &self,
        id: &str,
        confirmation: &str,
        mut before_remove: impl FnMut(&Path) -> Result<()>,
    ) -> Result<StorageSourceCleanupResult> {
        let archived = self.prior_operation_receipt(id)?;
        ensure!(
            archived.disposition == Disposition::Complete && archived.phase == Phase::Verified,
            "STORAGE_SOURCE_CLEANUP_NOT_COMPLETE"
        );
        if let Some(saved) = binding(&archived)?
            && saved.preview.confirmation == confirmation
            && let Some(result) = saved.result
        {
            // An acknowledged result is an original receipt lookup, never a new
            // authorization decision or a reason to reopen the retained source.
            return Ok(result);
        }
        let prepared = self.prepare_source_cleanup(id)?;
        let previous = prepared.receipt.owner_receipts.get(OWNER);
        let saved = binding(&prepared.receipt)?;
        let mut intent = match saved.filter(|saved| saved.result.is_none()) {
            Some(saved) => {
                ensure!(
                    saved.preview.confirmation == confirmation
                        && saved.preview.selection == prepared.preview.selection,
                    "STORAGE_SOURCE_CLEANUP_UNKNOWN"
                );
                // A resumed confirmation rechecks current receipt capacity but
                // does not rewrite its already acknowledged pending intent.
                preflight_source_cleanup(&mut prepared.receipt.clone(), &saved)?;
                saved
            }
            None => {
                ensure!(
                    prepared.preview.confirmation == confirmation,
                    "STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED"
                );
                let intent = CleanupBinding {
                    version: 2,
                    preview: prepared.preview.clone(),
                    result: None,
                };
                self.record_source_cleanup(id, previous, &intent)?;
                intent
            }
        };
        let pending = compact::encode(&intent)?;
        let mut result = StorageSourceCleanupResult {
            operation_id: id.into(),
            confirmation: confirmation.into(),
            entries: intent.preview.entries.clone(),
        };
        // Reverse manifest order removes leaves before their own empty parents.
        for entry in result
            .entries
            .iter_mut()
            .rev()
            .filter(|entry| eligible(entry.status))
        {
            self.verify_cleanup_scope(&prepared)?;
            let Some(source) = prepared.sources.get(&entry.domain) else {
                entry.status = prepared
                    .preview
                    .entries
                    .iter()
                    .find(|fresh| {
                        fresh.domain == entry.domain && fresh.relative_path.as_os_str().is_empty()
                    })
                    .map_or(Status::RetainedChanged, |root| root.status);
                continue;
            };
            let fresh = prepared
                .preview
                .entries
                .iter()
                .find(|fresh| {
                    fresh.domain == entry.domain && fresh.relative_path == entry.relative_path
                })
                .context("STORAGE_SOURCE_CLEANUP_UNKNOWN")?;
            if !eligible(fresh.status) {
                entry.status = fresh.status;
                continue;
            }
            if fresh.observed_version != entry.observed_version {
                entry.status = Status::RetainedChanged;
                continue;
            }
            let original = source
                .inventory
                .entries
                .iter()
                .find(|original| original.relative_path == entry.relative_path)
                .context("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID")?;
            before_remove(&source.path.join(&entry.relative_path))?;
            let parent = match parent(source, &entry.relative_path) {
                Ok(parent) => parent,
                Err(_) => {
                    entry.status = Status::RetainedChanged;
                    continue;
                }
            };
            let name = entry
                .relative_path
                .file_name()
                .context("STORAGE_SOURCE_CLEANUP_MANIFEST_INVALID")?;
            match original.kind {
                StorageTreeEntryKind::RegularFile => {
                    let held = (|| -> Result<File> {
                        let mut held = parent.open_single_link_regular_file(name)?;
                        ensure!(
                            identity(&held)? == original.identity
                                && Some(hash(&mut held, original)?) == entry.observed_version
                                && parent.open_entry_handle(name)?.identity()? == original.identity,
                            "STORAGE_SOURCE_CLEANUP_CHANGED"
                        );
                        Ok(held)
                    })();
                    let Ok(held) = held else {
                        entry.status = Status::RetainedChanged;
                        continue;
                    };
                    self.verify_cleanup_scope(&prepared)?;
                    #[cfg(windows)]
                    parent.remove_regular_file_if_handle(name, &held)?;
                    #[cfg(not(windows))]
                    {
                        // Cooperating writers are excluded by the actual root
                        // leases. Keep the original FD alive through unlink and
                        // compare the named object again at the mutation boundary.
                        ensure!(
                            identity(&held)? == original.identity
                                && parent.open_entry_handle(name)?.identity()? == original.identity,
                            "STORAGE_SOURCE_CLEANUP_CHANGED"
                        );
                        parent.remove_regular_file(name)?;
                    }
                    entry.status = Status::Removed;
                }
                StorageTreeEntryKind::Directory => {
                    let child = (|| -> Result<PrivateDirectory> {
                        let held = parent.open_entry_handle(name)?;
                        ensure!(
                            held.identity()? == original.identity,
                            "STORAGE_SOURCE_CLEANUP_CHANGED"
                        );
                        held.open_child_directory()
                    })();
                    let Ok(child) = child else {
                        entry.status = Status::RetainedChanged;
                        continue;
                    };
                    if !child.entry_names_bounded(ENTRY_LIMIT)?.is_empty() {
                        entry.status = Status::RetainedNotEmpty;
                        continue;
                    }
                    #[cfg(windows)]
                    parent.remove_owned_empty_child(name, &child)?;
                    #[cfg(not(windows))]
                    {
                        ensure!(
                            parent.open_entry_handle(name)?.identity()? == original.identity,
                            "STORAGE_SOURCE_CLEANUP_CHANGED"
                        );
                        parent.remove_child_entry(name, false)?;
                    }
                    entry.status = Status::Removed;
                }
                StorageTreeEntryKind::Symlink => entry.status = Status::RetainedExcluded,
            }
        }
        intent.result = Some(result.clone());
        self.verify_cleanup_scope(&prepared)?;
        self.record_source_cleanup(id, Some(&pending), &intent)?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "source_cleanup/tests.rs"]
mod tests;
