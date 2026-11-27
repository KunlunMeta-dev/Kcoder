//! One immutable path snapshot and its cooperating-writer lease per business process.
use super::*;
use anyhow::{Context, Result, ensure};
use std::sync::OnceLock;

static RUNTIME: OnceLock<StorageInstance> = OnceLock::new();

/// An owned instance may also be used by isolated hosts without installing globals.
/// Paths are facts only; resource authorization is still checked by its Native owner.
pub struct StorageInstance {
    paths: StoragePaths,
    _startup_lease: Option<StorageStartupLease>,
    _root_leases: Vec<super::writers::RootLease>,
}

impl StorageInstance {
    pub fn open(input: StorageResolveInput) -> Result<Self> {
        Self::open_inner(input, false)
    }

    fn open_inner(input: StorageResolveInput, diagnostic: bool) -> Result<Self> {
        let consumer = input.consumer;
        let (input, inherited_paths) = super::context::apply(input)?;
        input.validate_environment(cfg!(windows))?;
        let external = input.ignores_personal_selection();
        let home = input.home.clone();
        let lease = if external && !diagnostic {
            None
        } else {
            let home = input.home.as_deref().context("STORAGE_HOME_UNAVAILABLE")?;
            Some(if diagnostic {
                StorageStartupLease::acquire(home)?
            } else {
                StorageStartupLease::acquire(home)?
            })
        };
        // The lease precedes the record read: a migration cannot commit between them.
        let paths = if let Some(paths) = inherited_paths {
            if !input.ignores_personal_selection() {
                let home = input.home.as_deref().context("STORAGE_HOME_UNAVAILABLE")?;
                anyhow::ensure!(
                    read_storage_location_record(&storage_location_file(home))? == input.record,
                    "STORAGE_SELECTION_CHANGED"
                );
            }
            paths
        } else {
            load_storage_paths(input)?
        };
        let mut roots = vec![&paths.data_root];
        if !diagnostic {
            roots.push(&paths.cache_root);
        }
        if matches!(
            consumer,
            StorageConsumer::Gateway | StorageConsumer::Desktop
        ) {
            roots.push(&paths.gateway_root);
        }
        if consumer == StorageConsumer::Desktop {
            roots.push(&paths.desktop_root);
        }
        let mut root_leases = Vec::new();
        for &root in &roots {
            root_leases.extend(super::writers::RootLease::shared_with_ancestors(
                root,
                paths.selection_revision.is_some() && root == &paths.data_root,
            )?);
        }
        for root in &root_leases {
            root.verify()?;
        }
        if !external && !diagnostic {
            if let Some(home) = home.as_deref() {
                verify_deferred_legacy_sources(home, &paths, &roots, &root_leases)?;
            }
        }
        let mut roles = vec![(super::StorageRootRole::Native, &paths.data_root)];
        if matches!(
            consumer,
            StorageConsumer::Gateway | StorageConsumer::Desktop
        ) {
            roles.push((super::StorageRootRole::Gateway, &paths.gateway_root));
        }
        if consumer == StorageConsumer::Desktop {
            roles.push((super::StorageRootRole::Desktop, &paths.desktop_root));
        }
        for (role, path) in roles {
            let root = crate::PrivateDirectory::open_existing(path)?;
            super::assert_storage_root_admitted(&root, role)?;
        }
        // Business roots already check retirement before pending publication.
        // Cache has no retirement role, but must respect the same pending gate.
        if !diagnostic {
            super::component_publication::assert_target_admitted(
                &crate::PrivateDirectory::open_existing(&paths.cache_root)?,
            )?;
        }
        if external {
            super::active_operation::assert_active_operation_outside_roots(
                home.as_deref().context("STORAGE_HOME_UNAVAILABLE")?,
                &roots.iter().map(|root| root.as_path()).collect::<Vec<_>>(),
                &root_leases,
            )?;
        }
        for root in &root_leases {
            root.verify()?;
        }
        Ok(Self {
            paths,
            _startup_lease: lease,
            _root_leases: root_leases,
        })
    }

    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
}

fn verify_deferred_legacy_sources(
    home: &std::path::Path,
    paths: &StoragePaths,
    roots: &[&std::path::PathBuf],
    root_leases: &[super::writers::RootLease],
) -> Result<()> {
    let Some(receipt) = super::read_storage_migration(home)? else {
        return Ok(());
    };
    if receipt.disposition != kcoder_types::StorageMigrationDisposition::Deferred
        || receipt.plan.from.layout != kcoder_types::StorageLayout::Legacy
    {
        return Ok(());
    }
    ensure!(
        receipt.plan.original == read_storage_location_record(&storage_location_file(home))?,
        "STORAGE_SELECTION_CHANGED"
    );
    ensure!(paths == &receipt.plan.from, "STORAGE_SELECTION_CHANGED");
    for component in &receipt.plan.components {
        ensure!(
            crate::PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        if roots
            .iter()
            .any(|root| root.as_path() == component.source.as_path())
        {
            ensure!(
                root_leases.iter().try_fold(false, |matched, lease| {
                    Ok::<_, anyhow::Error>(
                        matched
                            || lease.matches_path_identity(
                                &component.source,
                                &component.source_identity,
                            )?,
                    )
                })?,
                "STORAGE_SOURCE_CHANGED"
            );
        }
    }
    Ok(())
}

/// Diagnostics can write plugin coordination state. Protect the resolved data
/// root through their lifetime without migrating, repairing access, or opening cache.
pub fn initialize_storage_diagnostic_runtime() -> Result<&'static StoragePaths> {
    initialize_runtime(true)
}

pub fn initialize_storage_runtime() -> Result<&'static StoragePaths> {
    initialize_runtime(false)
}

fn initialize_runtime(diagnostic: bool) -> Result<&'static StoragePaths> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime.paths());
    }
    let instance = StorageInstance::open_inner(process_storage_input()?, diagnostic)?;
    RUNTIME
        .set(instance)
        .map_err(|_| anyhow::anyhow!("STORAGE_RUNTIME_ALREADY_INITIALIZED"))?;
    Ok(RUNTIME
        .get()
        .expect("storage runtime was initialized")
        .paths())
}

pub fn initialized_storage_paths() -> Option<&'static StoragePaths> {
    RUNTIME.get().map(StorageInstance::paths)
}

/// Both layouts put their private leaf hierarchy below a directory named tmp.
/// Explicit owner/root APIs remain independent of the process cache selection.
pub fn temporary_root_parent() -> Result<PathBuf> {
    current_storage_paths()?
        .temporary_root
        .parent()
        .map(PathBuf::from)
        .context("STORAGE_PATH_INVALID")
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent, StorageMigrationPlan};
    use std::fs;

    fn deferred_legacy_source() -> (tempfile::TempDir, PathBuf) {
        const ID: &str = "installer-legacy-source-1";
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let source = home.join("Registered-Native");
        fs::create_dir_all(source.join("tmp")).unwrap();
        fs::create_dir_all(home.join(".config")).unwrap();
        fs::write(source.join("settings.json"), b"original settings").unwrap();
        let mut from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.to_owned()),
            ..Default::default()
        })
        .unwrap();
        from.data_root = source.clone();
        from.cache_root = source.join("tmp");
        from.temporary_root = source.join("tmp");
        let target = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: home.join("Target-Native"),
            cache_root: home.join("Target-Cache"),
            operation_id: Some(ID.into()),
        };
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: ID.into(),
            original: None,
            components: vec![StorageMigrationComponent {
                domain: "persistent-root".into(),
                source: source.clone(),
                destination: target.data_root.clone(),
                source_identity: crate::PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            from,
            target,
            target_bindings: Vec::new(),
            launch_intent: StorageLaunchIntent::Cli,
        };
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        coordinator.begin(plan).unwrap();
        coordinator.cancel_operation(ID).unwrap();
        drop(coordinator);
        (owned, source)
    }

    #[test]
    fn selected_data_must_exist_but_cleared_cache_can_be_recreated() {
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir(owned.path().join(".config")).unwrap();
        let data = owned.path().join("Data");
        let cache = owned.path().join("Cache");
        std::fs::write(
            storage_location_file(owned.path()),
            serde_json::to_vec(&StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: data.clone(),
                cache_root: cache.clone(),
                operation_id: None,
            })
            .unwrap(),
        )
        .unwrap();
        let input = || StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        };
        assert_eq!(load_storage_paths(input()).unwrap().data_root, data);
        assert_eq!(
            StorageInstance::open(input()).err().unwrap().to_string(),
            "STORAGE_DATA_ROOT_UNAVAILABLE"
        );
        assert!(!data.exists() && !cache.exists());
        std::fs::create_dir(&data).unwrap();
        let instance = StorageInstance::open(input()).unwrap();
        assert_eq!(instance.paths().cache_root, cache);
        assert!(cache.is_dir());
    }

    #[test]
    fn deferred_legacy_receipt_projects_original_paths_and_runtime_checks_held_identity() {
        let (owned, source) = deferred_legacy_source();
        let input = || StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        };
        let paths = load_storage_paths(input()).unwrap();
        assert_eq!(paths.data_root, source);
        let instance = StorageInstance::open(input()).unwrap();
        assert_eq!(instance.paths().data_root, source);
        assert_eq!(
            fs::read(instance.paths().data_root.join("settings.json")).unwrap(),
            b"original settings"
        );
        drop(instance);
        let inherited = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            startup_context: Some(kcoder_types::StorageStartupContext {
                version: 1,
                home: Some(owned.path().to_owned()),
                platform_config: Some(owned.path().join(".config")),
                overrides: Default::default(),
                record: None,
                consumer: StorageConsumer::Cli,
                development: false,
            }),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(inherited.paths().data_root, source);
    }

    #[test]
    fn deferred_legacy_receipt_rejects_a_replaced_source_after_root_lock() {
        let (owned, source) = deferred_legacy_source();
        let moved = owned.path().join("Retained-Native");
        fs::rename(&source, &moved).unwrap();
        fs::create_dir_all(source.join("tmp")).unwrap();
        fs::write(source.join("settings.json"), b"replacement profile").unwrap();
        let error = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "STORAGE_SOURCE_CHANGED");
        assert_eq!(
            fs::read(moved.join("settings.json")).unwrap(),
            b"original settings"
        );
        assert_eq!(
            fs::read(source.join("settings.json")).unwrap(),
            b"replacement profile"
        );
    }

    #[test]
    fn instance_freezes_selection_and_its_lease_until_actual_drop() {
        let owned = tempfile::tempdir().unwrap();
        let instance = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            instance.paths().data_root,
            owned.path().join(".config/kcoder")
        );
        let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        assert!(
            StorageInstance::open(StorageResolveInput {
                home: Some(owned.path().to_owned()),
                ..Default::default()
            })
            .is_err()
        );
        drop(coordinator);
        assert!(!instance.paths().data_root.join("settings.json").exists());
        drop(instance);
        assert!(StorageCoordinator::acquire(owned.path()).is_ok());
    }

    #[test]
    fn explicit_profile_uses_its_cache_without_personal_control_initialization() {
        let owned = tempfile::tempdir().unwrap();
        let profile = owned.path().join("Profile");
        let cache = owned.path().join("Cache");
        let instance = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            env: BTreeMap::from([
                ("KCODER_HOME".into(), profile.clone().into_os_string()),
                ("KCODER_CACHE_DIR".into(), cache.clone().into_os_string()),
            ]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(instance.paths().data_root, profile);
        assert_eq!(instance.paths().temporary_root, cache.join("tmp"));
        assert!(!owned.path().join(".config").exists());
        assert!(!profile.join("settings.json").exists());
        assert!(cache.join(super::super::writers::WRITERS).is_file());
    }

    #[test]
    fn startup_refuses_a_pending_operation_before_opening_business_roots() {
        let owned = tempfile::tempdir().unwrap();
        let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        })
        .unwrap();
        let plan = kcoder_types::StorageMigrationPlan {
            version: 1,
            operation_id: "pending".into(),
            original: None,
            from,
            target: StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: owned.path().join("NewData"),
                cache_root: owned.path().join("NewCache"),
                operation_id: Some("pending".into()),
            },
            components: vec![],
            target_bindings: vec![],
            launch_intent: kcoder_types::StorageLaunchIntent::Cli,
        };
        coordinator.begin(plan).unwrap();
        drop(coordinator);
        let result = StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            ..Default::default()
        });
        assert_eq!(
            result.err().unwrap().to_string(),
            "STORAGE_MIGRATION_PENDING"
        );
        assert!(!owned.path().join("NewData").exists());
        assert!(!owned.path().join(".config/kcoder").exists());
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;
    use std::{fs, process::Command};

    #[test]
    fn runtime_keeps_paths_frozen_and_default_temporary_resources_use_the_cache() {
        const PROBE: &str = "KCODER_STORAGE_RUNTIME_TEST_ROOT";
        if let Some(root) = std::env::var_os(PROBE) {
            let root = PathBuf::from(root);
            let profile = root.join("Profile");
            let cache = root.join("Cache");
            initialize_storage_runtime().unwrap();
            // SAFETY: this owned child executes only this test, before any service starts.
            unsafe {
                std::env::set_var("KCODER_CONFIG_DIR", root.join("WrongProfile"));
                std::env::set_var("KCODER_CACHE_DIR", root.join("WrongCache"));
            }
            assert_eq!(crate::Settings::config_dir().unwrap(), profile);
            assert_eq!(current_storage_paths().unwrap().cache_root, cache);
            let temporary = crate::create_private_temp_dir("storage-runtime").unwrap();
            assert!(temporary.path().starts_with(cache.join("tmp")));
            assert!(!profile.join("settings.json").exists());
            let explicit =
                crate::create_private_temp_dir_in(&root.join("ExplicitOwner"), "owner").unwrap();
            assert!(explicit.path().starts_with(root.join("ExplicitOwner/tmp")));
            assert!(!root.join("WrongProfile").exists() && !root.join("WrongCache").exists());
            return;
        }
        let owned = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "storage::runtime::process_tests::runtime_keeps_paths_frozen_and_default_temporary_resources_use_the_cache", "--test-threads=1", "--nocapture"])
            .env_clear().env(PROBE, owned.path()).env("HOME", owned.path()).env("USERPROFILE", owned.path())
            .env("KCODER_CONFIG_DIR", owned.path().join("Profile"))
            .env("KCODER_CACHE_DIR", owned.path().join("Cache"))
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(fs::read_dir(owned.path()).unwrap().count() >= 1);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_profile_paths_keep_non_utf8_bytes() {
        use std::os::unix::ffi::OsStringExt;
        let owned = tempfile::tempdir().unwrap();
        let profile = owned.path().join(OsString::from_vec(vec![b'p', 0xff]));
        let paths = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().to_owned()),
            env: BTreeMap::from([("KCODER_HOME".into(), profile.clone().into_os_string())]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(paths.data_root, profile);
        assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
    }
}
