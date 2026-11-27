//! Read-only target checks. Permission repair belongs to the stopped executor.
use super::{resolve::absolute, validate_storage_location_record};
use crate::PrivateDirectory;
use anyhow::{Context, Result, ensure};
use kcoder_types::{StorageLayout, StorageLocationRecord, StoragePaths};
use serde::Serialize;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTargetPath {
    pub path: PathBuf,
    pub existing_ancestor: PathBuf,
    pub ancestor_identity: String,
    pub remaining: PathBuf,
    pub existing_empty: bool,
    pub available_bytes: u64,
    #[serde(skip)]
    ancestry: Vec<String>,
}

impl StorageTargetPath {
    /// Compare actual ancestry, including aliases and platform path comparison.
    pub fn contains(&self, other: &Self) -> bool {
        if self.ancestor_identity == other.ancestor_identity {
            return compared(&other.remaining).starts_with(compared(&self.remaining));
        }
        self.remaining.as_os_str().is_empty() && other.ancestry.contains(&self.ancestor_identity)
    }

    fn same(&self, other: &Self) -> bool {
        self.ancestor_identity == other.ancestor_identity
            && compared(&self.remaining) == compared(&other.remaining)
    }
}

fn compared(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}

/// Pin the nearest existing ordinary ancestor. Missing children are not created.
/// Existing links/reparse points are rejected by the same native handle API used for publication.
pub fn inspect_storage_target(path: &Path) -> Result<StorageTargetPath> {
    let path = absolute(path)?;
    let mut existing = path.clone();
    let mut suffix: Vec<OsString> = Vec::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_dir() && !metadata.is_symlink(),
                    "STORAGE_TARGET_NOT_DIRECTORY"
                );
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    existing
                        .file_name()
                        .context("STORAGE_PATH_INVALID")?
                        .to_owned(),
                );
                ensure!(suffix.len() <= 256, "STORAGE_PATH_INVALID");
                ensure!(existing.pop(), "STORAGE_PATH_INVALID");
            }
            Err(error) => return Err(error).context("STORAGE_TARGET_UNAVAILABLE"),
        }
    }
    let directory =
        PrivateDirectory::open_existing(&existing).context("STORAGE_TARGET_UNAVAILABLE")?;
    let identity = directory.directory_identity()?;
    let remaining: PathBuf = suffix.into_iter().rev().collect();
    let mut ancestry = Vec::new();
    let mut parent = existing.parent();
    while let Some(path) = parent {
        ensure!(ancestry.len() < 256, "STORAGE_PATH_INVALID");
        ancestry.push(PrivateDirectory::open_existing(path)?.directory_identity()?);
        parent = path.parent();
    }
    Ok(StorageTargetPath {
        path,
        existing_ancestor: existing.clone(),
        ancestor_identity: identity,
        existing_empty: !remaining.as_os_str().is_empty()
            || super::writers::empty_except_fences(&directory)?,
        available_bytes: directory
            .available_storage()
            .context("STORAGE_TARGET_UNAVAILABLE")?
            .bytes,
        remaining,
        ancestry,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTargetPreview {
    pub data: StorageTargetPath,
    pub cache: StorageTargetPath,
    pub data_unchanged: bool,
    pub cache_unchanged: bool,
    pub no_operation: bool,
}

/// Current roots and the fixed control parent are always protected.
/// Callers add registered legacy sources and the program/helper directories.
pub fn preview_storage_targets(
    current: &StoragePaths,
    data: &Path,
    cache: &Path,
    sources: &[PathBuf],
    protected: &[PathBuf],
) -> Result<StorageTargetPreview> {
    ensure!(
        !current.externally_configured,
        "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
    );
    let target = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: data.to_owned(),
        cache_root: cache.to_owned(),
        operation_id: None,
    };
    validate_storage_location_record(&target)?;
    let data = inspect_storage_target(data)?;
    let cache = inspect_storage_target(cache)?;
    ensure!(
        !data.contains(&cache) && !cache.contains(&data),
        "STORAGE_ROOTS_OVERLAP"
    );
    let old_data = inspect_storage_target(&current.data_root)?;
    let old_cache = inspect_storage_target(&current.cache_root)?;
    let data_unchanged = data.same(&old_data);
    let cache_unchanged = cache.same(&old_cache);
    for protected in current
        .location_file
        .as_deref()
        .and_then(Path::parent)
        .into_iter()
        .chain(protected.iter().map(PathBuf::as_path))
    {
        let protected = inspect_storage_target(protected)?;
        ensure!(
            !data.contains(&protected) && !cache.contains(&protected),
            "STORAGE_TARGET_CONTAINS_CONTROL"
        );
    }
    let known_sources = [
        &current.data_root,
        &current.cache_root,
        &current.gateway_root,
        &current.desktop_root,
    ];
    for source in known_sources.into_iter().chain(sources) {
        let source = inspect_storage_target(source)?;
        for (target, unchanged) in [(&data, data_unchanged), (&cache, cache_unchanged)] {
            if unchanged {
                continue;
            }
            ensure!(
                !target.contains(&source) && !source.contains(target),
                "STORAGE_SOURCE_TARGET_OVERLAP"
            );
        }
    }
    ensure!(
        data_unchanged || data.existing_empty,
        "STORAGE_TARGET_NOT_EMPTY"
    );
    ensure!(
        cache_unchanged || cache.existing_empty,
        "STORAGE_TARGET_NOT_EMPTY"
    );
    Ok(StorageTargetPreview {
        data,
        cache,
        data_unchanged,
        cache_unchanged,
        no_operation: data_unchanged && cache_unchanged && current.layout == StorageLayout::Unified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{StorageResolveInput, resolve_storage_paths};
    use std::fs;

    #[test]
    fn preview_neither_creates_roots_nor_changes_modes_and_respects_component_boundaries() {
        let owned = tempfile::tempdir().unwrap();
        let input = StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        };
        let current = resolve_storage_paths(&input).unwrap();
        let data = owned.path().join("Data");
        let cache = owned.path().join("Data-old");
        let result =
            preview_storage_targets(&current, &data, &cache, &[current.data_root.clone()], &[])
                .unwrap();
        assert!(!result.no_operation);
        assert!(result.data.existing_empty && result.data.available_bytes > 0);
        assert!(!data.exists() && !cache.exists());
        assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
    }

    #[test]
    fn changed_roots_cannot_overlap_any_legacy_source_or_control_or_nonempty_target() {
        let owned = tempfile::tempdir().unwrap();
        let current = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        let source = owned.path().join("OldGateway");
        fs::create_dir(&source).unwrap();
        let cache = owned.path().join("NewCache");
        for data in [source.clone(), source.join("nested")] {
            assert_eq!(
                preview_storage_targets(&current, &data, &cache, &[source.clone()], &[])
                    .unwrap_err()
                    .to_string(),
                "STORAGE_SOURCE_TARGET_OVERLAP"
            );
        }
        let data = owned.path().join("NewData");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("keep"), b"peer").unwrap();
        assert_eq!(
            preview_storage_targets(&current, &data, &cache, &[], &[])
                .unwrap_err()
                .to_string(),
            "STORAGE_TARGET_NOT_EMPTY"
        );
        assert_eq!(
            preview_storage_targets(
                &current,
                owned.path(),
                &owned.path().join("../ExternalCache"),
                &[],
                &[source]
            )
            .unwrap_err()
            .to_string(),
            "STORAGE_TARGET_CONTAINS_CONTROL"
        );
        assert_eq!(fs::read(data.join("keep")).unwrap(), b"peer");
    }

    #[test]
    fn same_unified_roots_are_noop_but_cache_only_move_preserves_native_in_place() {
        let owned = tempfile::tempdir().unwrap();
        let record = StorageLocationRecord {
            version: 1,
            revision: 2,
            data_root: owned.path().join("Data"),
            cache_root: owned.path().join("Cache"),
            operation_id: None,
        };
        fs::create_dir(&record.data_root).unwrap();
        fs::write(record.data_root.join("settings.json"), b"{}").unwrap();
        let current = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            record: Some(record.clone()),
            ..Default::default()
        })
        .unwrap();
        let sources = [record.data_root.clone(), record.cache_root.clone()];
        assert!(
            preview_storage_targets(
                &current,
                &record.data_root,
                &record.cache_root,
                &sources,
                &[]
            )
            .unwrap()
            .no_operation
        );
        let moved = preview_storage_targets(
            &current,
            &record.data_root,
            &owned.path().join("Cache2"),
            &sources,
            &[],
        )
        .unwrap();
        assert!(moved.data_unchanged && !moved.cache_unchanged && !moved.no_operation);
        assert!(
            preview_storage_targets(
                &current,
                &record.data_root,
                &record.data_root.join("cache"),
                &sources,
                &[]
            )
            .is_err()
        );
    }

    #[test]
    fn known_current_roots_cannot_be_omitted_by_a_preview_caller() {
        let owned = tempfile::tempdir().unwrap();
        let current = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        for source in [
            &current.data_root,
            &current.cache_root,
            &current.gateway_root,
            &current.desktop_root,
        ] {
            fs::create_dir_all(source).unwrap();
            fs::write(source.join("keep"), b"persistent").unwrap();
            let result = preview_storage_targets(
                &current,
                &owned.path().join("NewData"),
                &source.join("NewCache"),
                &[],
                &[],
            );
            assert_eq!(
                result.unwrap_err().to_string(),
                "STORAGE_SOURCE_TARGET_OVERLAP"
            );
            assert_eq!(fs::read(source.join("keep")).unwrap(), b"persistent");
            assert!(!source.join("NewCache").exists());
        }
        let result = preview_storage_targets(
            &current,
            &current.data_root.join("NestedData"),
            &owned.path().join("NewCache"),
            &[],
            &[],
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "STORAGE_SOURCE_TARGET_OVERLAP"
        );
    }

    #[test]
    fn the_fixed_control_parent_is_protected_without_caller_registration() {
        let owned = tempfile::tempdir().unwrap();
        let current = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        let result = preview_storage_targets(
            &current,
            &owned.path().join(".config"),
            &owned.path().join("Cache"),
            &[],
            &[],
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "STORAGE_TARGET_CONTAINS_CONTROL"
        );
        assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn linked_targets_do_not_redirect_preview_to_another_directory() {
        let owned = tempfile::tempdir().unwrap();
        let real = owned.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = owned.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(inspect_storage_target(&link).is_err());
        assert!(inspect_storage_target(&link.join("missing")).is_err());
        assert!(!real.join("missing").exists());
    }
}
