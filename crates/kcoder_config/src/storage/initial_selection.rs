//! A fresh installation selects empty roots once, without a migration or identity.
//! Existing data always takes the stopped migration path instead.
use super::*;
use kcoder_types::StorageLayout;

fn empty_root(directory: &PrivateDirectory, fences: &BTreeSet<String>) -> Result<()> {
    directory.visit_entry_names_bounded(3, |name| {
        let entry = directory.open_entry_handle(name)?;
        ensure!(
            entry.metadata().is_file()
                && entry.metadata().len() == 0
                && fences.contains(&entry.identity()?),
            "STORAGE_INITIAL_SELECTION_HAS_DATA"
        );
        Ok(())
    })
}

impl StorageCoordinator {
    /// The actual user's installing/first-launch entry calls this only after
    /// confirmation. No business configuration, credentials or identity opens.
    pub fn select_initial_roots(
        &mut self,
        from: &kcoder_types::StoragePaths,
        data: &Path,
        cache: &Path,
        additional_legacy_sources: &[PathBuf],
    ) -> Result<StorageLocationRecord> {
        self.verify_control()?;
        ensure!(
            !from.externally_configured,
            "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
        );
        ensure!(
            self.current()?.is_none(),
            "STORAGE_INITIAL_SELECTION_HAS_OPERATION"
        );
        // begin() can durably write its receipt before current.json. A missing
        // pointer is not proof that this is a new installation.
        if let Some(operations) = optional_child(&self.directory, OPERATIONS)? {
            ensure!(
                operations.entry_names_bounded(1)?.is_empty(),
                "STORAGE_INITIAL_SELECTION_HAS_OPERATION"
            );
        }
        super::super::browser_cache::validate_desktop_profile_path(
            &data.join("studio").join("desktop"),
        )?;
        if let Some(selected) = location(&self.directory)? {
            ensure!(
                selected.revision == 1
                    && selected.operation_id.is_none()
                    && selected.data_root == data
                    && selected.cache_root == cache,
                "STORAGE_SELECTION_CHANGED"
            );
            return Ok(selected);
        }
        ensure!(
            from.layout == StorageLayout::Legacy,
            "STORAGE_SELECTION_CHANGED"
        );
        let preview = super::super::targets::preview_storage_targets(
            from,
            data,
            cache,
            additional_legacy_sources,
            &[],
        )?;
        fs2::FileExt::try_lock_exclusive(&self.instances).context("STORAGE_WRITERS_ACTIVE")?;
        let roots = [
            from.data_root.clone(),
            from.cache_root.clone(),
            from.gateway_root.clone(),
            from.desktop_root.clone(),
        ];
        for path in roots.iter().chain(additional_legacy_sources) {
            match PrivateDirectory::open_existing(path) {
                Ok(directory) => {
                    ensure!(
                        super::super::writers::empty_except_fences(&directory)?,
                        "STORAGE_INITIAL_SELECTION_HAS_DATA"
                    );
                }
                Err(error) if missing(&error) => (),
                Err(error) => return Err(error),
            }
        }
        for path in roots.iter().chain(additional_legacy_sources) {
            super::super::writers::RootLease::exclusive_tree_existing(path, &mut self.roots)?;
        }
        // Include only the exact ordinary fences just held by this coordinator.
        let mut fences = BTreeSet::new();
        for root in &self.roots {
            fences.extend(root.fence_identities()?);
        }
        for path in roots.iter().chain(additional_legacy_sources) {
            match PrivateDirectory::open_existing(path) {
                Ok(directory) => empty_root(&directory, &fences)?,
                Err(error) if missing(&error) => (),
                Err(error) => return Err(error),
            }
        }
        for target in [&preview.data, &preview.cache] {
            ensure!(
                PrivateDirectory::open_existing(&target.existing_ancestor)?.directory_identity()?
                    == target.ancestor_identity,
                "STORAGE_TARGET_CHANGED"
            );
            let directory = PrivateDirectory::open_config_root(&target.path)?;
            self.fence_component_directory(&target.path, &directory)?;
        }
        for root in &self.roots {
            fences.extend(root.fence_identities()?);
        }
        for target in [&preview.data, &preview.cache] {
            empty_root(&PrivateDirectory::open_existing(&target.path)?, &fences)?;
        }
        self.verify_control()?;
        ensure!(
            location(&self.directory)?.is_none(),
            "STORAGE_SELECTION_CHANGED"
        );
        let selected = StorageLocationRecord {
            version: 1,
            revision: 1,
            operation_id: None,
            data_root: preview.data.path,
            cache_root: preview.cache.path,
        };
        self.directory
            .atomic_replace(OsStr::new(LOCATION), &serde_json::to_vec_pretty(&selected)?)?;
        ensure!(
            location(&self.directory)?.as_ref() == Some(&selected),
            "STORAGE_SELECTION_CHANGED"
        );
        self.verify_control()?;
        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        StorageResolveInput, read_storage_location_record, resolve_storage_paths,
        storage_location_file,
    };

    #[cfg(windows)]
    #[test]
    fn initial_deep_desktop_path_never_publishes_a_selection_or_creates_data() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let data = home.join("x".repeat(180));
        let cache = home.join("cache");
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        let error = coordinator
            .select_initial_roots(&from, &data, &cache, &[])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("STORAGE_BROWSER_PROFILE_PATH_TOO_LONG")
        );
        assert!(
            read_storage_location_record(&storage_location_file(home))
                .unwrap()
                .is_none()
        );
        assert!(coordinator.current().unwrap().is_none());
        assert!(!data.exists() && !cache.exists() && !from.data_root.exists());
    }

    #[test]
    fn an_unpublished_original_operation_is_not_an_empty_first_installation() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        let operations = coordinator
            .directory
            .create_child(OsStr::new(OPERATIONS))
            .unwrap();
        let original = operations
            .create_child(OsStr::new("original-operation"))
            .unwrap();
        original
            .atomic_replace(OsStr::new(RECEIPT), b"unconfirmed original receipt")
            .unwrap();
        assert!(coordinator.current().unwrap().is_none());
        let data = home.join("chosen-data");
        let error = coordinator
            .select_initial_roots(&from, &data, &home.join("chosen-cache"), &[])
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("STORAGE_INITIAL_SELECTION_HAS_OPERATION")
        );
        assert!(!data.exists());
        assert!(!from.data_root.exists());
        assert!(!storage_location_file(home).exists());
        assert_eq!(
            std::fs::read(
                home.join(".config")
                    .join(OPERATIONS)
                    .join("original-operation")
                    .join(RECEIPT)
            )
            .unwrap(),
            b"unconfirmed original receipt"
        );
    }

    #[test]
    fn retry_after_empty_target_preparation_still_requires_the_actual_writer_lock() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let data = home.join("selected-data");
        let cache = home.join("selected-cache");
        let target = PrivateDirectory::open_config_root(&data).unwrap();
        let writer = target
            .try_shared_lock(OsStr::new("kcoder-storage-writers.lock"))
            .unwrap()
            .unwrap();
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        assert!(
            coordinator
                .select_initial_roots(&from, &data, &cache, &[])
                .is_err()
        );
        assert!(!storage_location_file(home).exists());
        drop(coordinator);
        drop(writer);
        // A crash before the locator write can leave exactly these empty
        // coordination leaves. They must not make this same choice unusable.
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        let selected = coordinator
            .select_initial_roots(&from, &data, &cache, &[])
            .unwrap();
        assert_eq!(selected.data_root, data);
        assert!(selected.operation_id.is_none());
        assert!(coordinator.current().unwrap().is_none());
    }

    #[test]
    fn fresh_choice_writes_only_one_selection_without_default_profile_or_operation() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let data = home.join("selected-data");
        let cache = home.join("selected-cache");
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        let selected = coordinator
            .select_initial_roots(&from, &data, &cache, &[])
            .unwrap();
        assert_eq!(selected.operation_id, None);
        assert!(!from.data_root.exists());
        assert!(coordinator.current().unwrap().is_none());
        assert_eq!(
            coordinator
                .select_initial_roots(&from, &data, &cache, &[])
                .unwrap(),
            selected
        );
        assert!(
            coordinator
                .select_initial_roots(&from, &home.join("other"), &cache, &[])
                .is_err()
        );
        assert!(
            read_storage_location_record(&storage_location_file(home))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn legacy_business_data_refuses_initial_selection_without_a_locator() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let legacy = PrivateDirectory::open_config_root(&from.data_root).unwrap();
        legacy
            .atomic_replace(OsStr::new("settings.json"), b"old settings")
            .unwrap();
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        assert!(
            coordinator
                .select_initial_roots(&from, &home.join("data"), &home.join("cache"), &[])
                .is_err()
        );
        assert!(!home.join("data").exists());
        assert!(!storage_location_file(home).exists());
        assert_eq!(
            std::fs::read(from.data_root.join("settings.json")).unwrap(),
            b"old settings"
        );
    }
}
