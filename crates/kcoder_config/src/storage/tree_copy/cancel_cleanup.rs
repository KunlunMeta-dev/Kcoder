//! Cancellation consumes the original copy facts; it never resumes payload copying.
use super::*;

pub(in crate::storage) struct CancellationCopy {
    pub inventory: StorageTreeInventory,
    name: OsString,
    version: Option<ManifestVersion>,
}

impl CancellationCopy {
    pub(in crate::storage) fn read(
        operation: &PrivateDirectory,
        binding: &StorageTreeCopyBinding,
    ) -> Result<Self> {
        check_binding(binding, &binding.scope)?;
        ensure!(
            binding.scope.operation_directory_identity == operation.directory_identity()?,
            "STORAGE_TREE_MANIFEST_CONFLICT"
        );
        let context = CopyContext {
            source: operation,
            staging: operation,
            operation,
            target_fences: &BTreeSet::new(),
            append: RefCell::new(None),
            name: OsString::from(format!("tree-copy-{}.json", binding.scope.domain)),
            scope: binding.scope.clone(),
        };
        let mut inventory = StorageTreeInventory {
            root_identity: binding.scope.staging_root_identity.clone(),
            entries: Vec::new(),
        };
        let read = read_manifest(&context, Some(binding), true)?;
        if let Some((manifest, _)) = &read {
            ensure!(
                manifest.inventory.entries.len() == manifest.publications.len()
                    && digest(&metadata_bytes(&manifest.inventory)?)
                        == binding.scope.inventory_sha256,
                "STORAGE_TREE_MANIFEST_CONFLICT"
            );
            for (entry, publication) in manifest
                .inventory
                .entries
                .iter()
                .zip(&manifest.publications)
            {
                let (kind, identity) = match (entry.excluded, entry.kind, publication) {
                    (true, _, Publication::Excluded) | (false, _, Publication::Pending) => continue,
                    (false, EntryKind::RegularFile, Publication::FilePrepared { identity }) => {
                        (StorageTreeEntryKind::RegularFile, identity)
                    }
                    (false, EntryKind::Directory, Publication::Published { identity }) => {
                        (StorageTreeEntryKind::Directory, identity)
                    }
                    _ => anyhow::bail!("STORAGE_TREE_MANIFEST_CONFLICT"),
                };
                ensure!(valid_identity(identity), "STORAGE_TREE_MANIFEST_CONFLICT");
                inventory.entries.push(super::super::StorageTreeEntry {
                    relative_path: entry.path.decode()?,
                    kind,
                    identity: identity.clone(),
                    size_bytes: entry.size_bytes,
                    sha256: entry.sha256.clone(),
                    excluded: false,
                });
            }
        }
        Ok(Self {
            inventory,
            name: context.name,
            version: read.map(|(_, version)| version),
        })
    }

    pub(in crate::storage) fn remove_manifest(&self, operation: &PrivateDirectory) -> Result<()> {
        let Some(expected) = &self.version else {
            ensure!(
                optional_identity(operation, &self.name)?.is_none(),
                "STORAGE_TREE_MANIFEST_UNKNOWN"
            );
            return Ok(());
        };
        let mut file = match operation.open_single_link_regular_file(&self.name) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        ensure!(
            file_identity(&file)? == expected.identity
                && file.metadata()?.len() == expected.size_bytes
                && hash_file(&mut file, expected.size_bytes)? == expected.sha256
                && optional_identity(operation, &self.name)?.as_ref() == Some(&expected.identity),
            "STORAGE_TREE_MANIFEST_CHANGED"
        );
        remove_file(operation, &self.name, &file)
    }
}

pub(in crate::storage) fn inspect_cancellation_target(
    root: &PrivateDirectory,
    expected: &StorageTreeInventory,
    controls: &BTreeSet<String>,
) -> Result<StorageTreeInventory> {
    let actual = inventory_tree_with_fences(root, &BTreeSet::new(), controls)?;
    ensure!(
        actual.root_identity == expected.root_identity,
        "STORAGE_TREE_ROOT_CHANGED"
    );
    let expected = expected
        .entries
        .iter()
        .map(|entry| (&entry.relative_path, entry))
        .collect::<BTreeMap<_, _>>();
    for entry in actual.entries.iter().filter(|entry| !entry.excluded) {
        let original = expected
            .get(&entry.relative_path)
            .context("STORAGE_CANCEL_TARGET_UNKNOWN")?;
        ensure!(entry == *original, "STORAGE_CANCEL_TARGET_CHANGED");
    }
    Ok(actual)
}

fn remove_file(parent: &PrivateDirectory, name: &OsStr, file: &File) -> Result<()> {
    #[cfg(windows)]
    {
        parent.remove_regular_file_if_handle(name, file)
    }
    #[cfg(not(windows))]
    {
        ensure!(
            optional_identity(parent, name)?.as_ref() == Some(&file_identity(file)?),
            "STORAGE_CANCEL_TARGET_CHANGED"
        );
        parent.remove_regular_file(name)
    }
}

/// Missing original entries reconcile an interrupted cleanup. New identities,
/// changed bytes and nonempty original directories never become deletion authority.
pub(in crate::storage) fn remove_cancellation_payload(
    root: &PrivateDirectory,
    actual: &StorageTreeInventory,
    mut before_remove: impl FnMut(&Path) -> Result<()>,
    mut verify_scope: impl FnMut() -> Result<()>,
) -> Result<()> {
    let directories = actual
        .entries
        .iter()
        .filter(|entry| entry.kind == StorageTreeEntryKind::Directory)
        .map(|entry| (entry.relative_path.clone(), entry.identity.clone()))
        .collect::<BTreeMap<_, _>>();
    for original in actual.entries.iter().rev() {
        if original.excluded && original.relative_path.components().count() == 1 {
            continue;
        }
        verify_scope()?;
        before_remove(&original.relative_path)?;
        verify_scope()?;
        let parent = match open_parent(root, &original.relative_path, &directories) {
            Ok(parent) => parent,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let name = original
            .relative_path
            .file_name()
            .context("STORAGE_TREE_MANIFEST_INVALID")?;
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        ensure!(
            entry.identity()? == original.identity,
            "STORAGE_CANCEL_TARGET_CHANGED"
        );
        match original.kind {
            StorageTreeEntryKind::RegularFile => {
                let mut file = parent.open_single_link_regular_file(name)?;
                ensure!(
                    file_identity(&file)? == original.identity,
                    "STORAGE_CANCEL_TARGET_CHANGED"
                );
                if original.excluded {
                    ensure!(file.metadata()?.len() == 0, "STORAGE_CANCEL_TARGET_CHANGED");
                } else {
                    verify_source_file(&mut file, original)?;
                }
                verify_scope()?;
                remove_file(&parent, name, &file)?;
            }
            StorageTreeEntryKind::Directory => {
                let directory = entry.open_child_directory()?;
                ensure!(
                    directory.entry_names_bounded(1)?.is_empty(),
                    "STORAGE_CANCEL_TARGET_UNKNOWN"
                );
                verify_scope()?;
                #[cfg(windows)]
                parent.remove_owned_empty_child(name, &directory)?;
                #[cfg(not(windows))]
                {
                    ensure!(
                        parent.open_entry_handle(name)?.identity()? == original.identity,
                        "STORAGE_CANCEL_TARGET_CHANGED"
                    );
                    parent.remove_child_entry(name, false)?;
                }
            }
            StorageTreeEntryKind::Symlink => anyhow::bail!("STORAGE_CANCEL_TARGET_UNKNOWN"),
        }
    }
    Ok(())
}
