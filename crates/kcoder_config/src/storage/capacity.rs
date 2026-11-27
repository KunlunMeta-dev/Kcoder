//! Advisory preview sizes use metadata only. Copy-time checks use the already
//! verified inventory; neither path grants authorization or reserves free space.
use crate::PrivateDirectory;
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, path::Path};

const ENTRY_LIMIT: usize = 2_000_000;

/// A conservative estimate, including owner-excluded files until the stopped
/// owner identifies them. Links are observed without following their targets.
pub(super) fn estimate_bytes(path: &Path) -> Result<u64> {
    fn visit(
        directory: &PrivateDirectory,
        depth: usize,
        visited: &mut BTreeSet<String>,
        entries: &mut usize,
        bytes: &mut u64,
    ) -> Result<()> {
        ensure!(depth <= 128, "STORAGE_PREVIEW_ENTRY_LIMIT");
        ensure!(
            visited.insert(directory.directory_identity()?),
            "STORAGE_SOURCE_DIRECTORY_ALIAS"
        );
        directory.visit_entry_names_bounded(65_536, |name| {
            *entries += 1;
            ensure!(*entries <= ENTRY_LIMIT, "STORAGE_PREVIEW_ENTRY_LIMIT");
            let entry = directory.open_entry_handle(name)?;
            let metadata = entry.metadata();
            if metadata.file_type().is_symlink() {
                return Ok(());
            }
            if metadata.is_dir() {
                visit(
                    &entry.open_child_directory()?,
                    depth + 1,
                    visited,
                    entries,
                    bytes,
                )?;
            } else if metadata.is_file() {
                *bytes = bytes
                    .checked_add(metadata.len())
                    .context("STORAGE_SIZE_OVERFLOW")?;
            } else {
                anyhow::bail!("STORAGE_SOURCE_ENTRY_UNSUPPORTED");
            }
            Ok(())
        })
    }
    let root = PrivateDirectory::open_existing(path)?;
    let expected = root.directory_identity()?;
    let mut visited = BTreeSet::new();
    let mut entries = 0usize;
    let mut bytes = 0u64;
    visit(&root, 0, &mut visited, &mut entries, &mut bytes)?;
    ensure!(
        PrivateDirectory::open_existing(path)?.directory_identity()? == expected,
        "STORAGE_SOURCE_CHANGED"
    );
    Ok(bytes)
}

pub(super) fn check_space(directory: &PrivateDirectory, needed: u64) -> Result<()> {
    ensure!(
        directory.available_storage()?.bytes >= needed,
        "STORAGE_INSUFFICIENT_SPACE"
    );
    Ok(())
}

/// Shared physical legacy roots are walked once, even when two owner components
/// consume disjoint namespaces. Their conservative estimates may overlap.
pub(super) fn fill_estimates(
    components: &mut [kcoder_types::StorageMigrationComponent],
) -> Result<()> {
    let mut observed = std::collections::BTreeMap::<String, u64>::new();
    for component in components {
        if component.source == component.destination {
            continue;
        }
        let bytes = match observed.get(&component.source_identity) {
            Some(bytes) => *bytes,
            None => {
                ensure!(
                    PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                        == component.source_identity,
                    "STORAGE_SOURCE_CHANGED"
                );
                let bytes = estimate_bytes(&component.source)?;
                ensure!(
                    PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                        == component.source_identity,
                    "STORAGE_SOURCE_CHANGED"
                );
                observed.insert(component.source_identity.clone(), bytes);
                bytes
            }
        };
        component.estimated_bytes = bytes;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn estimate_uses_file_lengths_without_following_links() {
        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("payload"), b"owned payload").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let external = owned.path().join("external");
            fs::create_dir(&external).unwrap();
            fs::write(external.join("not-part-of-copy"), vec![0; 4096]).unwrap();
            symlink(external, source.join("link")).unwrap();
        }
        assert_eq!(estimate_bytes(&source).unwrap(), 13);
        assert_eq!(
            fs::read_dir(&source).unwrap().count(),
            if cfg!(unix) { 2 } else { 1 }
        );
    }

    #[test]
    fn space_check_rejects_an_impossible_copy_without_creating_entries() {
        let owned = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_existing(owned.path()).unwrap();
        assert!(
            check_space(&root, u64::MAX)
                .unwrap_err()
                .to_string()
                .contains("STORAGE_INSUFFICIENT_SPACE")
        );
        assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
    }
}
