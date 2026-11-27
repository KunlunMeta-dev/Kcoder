use super::*;
use kcoder_types::{StorageLaunchIntent, StorageLocationRecord, StorageMigrationPhase as Phase};
use std::fs;

struct Fixture {
    plan: StorageMigrationPlan,
    coordinator: StorageCoordinator,
    paths: Paths,
    _owned: tempfile::TempDir,
}

impl Fixture {
    fn new(partition: bool) -> Self {
        Self::build(partition, false, false)
    }

    fn moved(partition: bool, same_cache: bool) -> Self {
        Self::build(partition, true, same_cache)
    }

    fn build(partition: bool, moved: bool, same_cache: bool) -> Self {
        let owned = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(owned.path()).unwrap();
        let data = home.join("持久 data");
        let cache = home.join("new cache");
        let old_cache = home.join("old cache");
        for path in [&data, &cache, &old_cache] {
            fs::create_dir(path).unwrap();
        }
        let record = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: data.clone(),
            cache_root: old_cache,
            operation_id: None,
        };
        let config = PrivateDirectory::open_or_create(&home.join(".config")).unwrap();
        config
            .atomic_replace(
                OsStr::new("kcoder-storage.json"),
                &serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
        let mut plan = super::super::operation::prepare_storage_plan(
            &home,
            &data,
            &cache,
            "owned-cache-move",
            StorageLaunchIntent::Cli,
        )
        .unwrap()
        .unwrap();
        if moved {
            plan.target.data_root = home.join("new persistent data");
            plan.components[0].destination = plan.target.data_root.clone();
            if same_cache {
                plan.target.cache_root = plan.from.cache_root.clone();
            }
            plan.target_bindings = [&plan.target.data_root, &plan.target.cache_root]
                .into_iter()
                .map(|path| {
                    let inspected = super::super::inspect_storage_target(path).unwrap();
                    kcoder_types::StorageTargetBinding {
                        path: inspected.path,
                        existing_ancestor: inspected.existing_ancestor,
                        ancestor_identity: inspected.ancestor_identity,
                    }
                })
                .collect();
        }
        let paths = paths(&plan).unwrap();
        if partition {
            fs::create_dir_all(paths.source_partition.join("Local Storage")).unwrap();
            fs::write(paths.source_partition.join("Cookies"), b"owned-cookie").unwrap();
            fs::write(
                paths.source_partition.join("Local Storage/draft"),
                b"unsent-draft",
            )
            .unwrap();
        }
        let coordinator = StorageCoordinator::acquire(&home).unwrap();
        coordinator.begin(plan.clone()).unwrap();
        Self {
            _owned: owned,
            plan,
            coordinator,
            paths,
        }
    }

    fn stopped(&mut self) {
        let id = &self.plan.operation_id;
        self.coordinator
            .advance(id, Phase::Planned, Phase::Stopping)
            .unwrap();
        self.coordinator
            .advance(id, Phase::Stopping, Phase::Stopped)
            .unwrap();
        // Match the executor: publication starts only after entering Copying.
        self.coordinator
            .advance(id, Phase::Stopped, Phase::Copying)
            .unwrap();
    }

    fn prepare(&mut self) -> StorageBrowserCacheReceipt {
        self.stopped();
        prepare_browser_cache(&mut self.coordinator, &self.plan.operation_id)
            .unwrap()
            .unwrap()
    }

    fn persist(&mut self, owner: &StorageBrowserCacheReceipt) {
        self.coordinator
            .record_owner_receipt(
                &self.plan.operation_id,
                BROWSER_CACHE_OWNER,
                None,
                serde_json::to_value(owner).unwrap(),
            )
            .unwrap();
    }

    fn ordinary_cache(&self) {
        fs::create_dir(self.paths.source_partition.join(CACHE)).unwrap();
        fs::write(
            self.paths.source_partition.join("Cache/keep"),
            b"old-http-cache",
        )
        .unwrap();
    }

    fn known_link(&self) {
        let partition = open_source_partition(&self.plan).unwrap().unwrap();
        partition
            .create_directory_link(OsStr::new(CACHE), &self.paths.previous_http)
            .unwrap();
    }

    fn assert_markers(&self) {
        assert_eq!(
            fs::read(self.paths.source_partition.join("Cookies")).unwrap(),
            b"owned-cookie"
        );
        assert_eq!(
            fs::read(self.paths.source_partition.join("Local Storage/draft")).unwrap(),
            b"unsent-draft"
        );
    }

    fn apply(&mut self, owner: &StorageBrowserCacheReceipt) -> StorageBrowserCacheReceipt {
        apply_browser_cache(&mut self.coordinator, &self.plan.operation_id, owner).unwrap()
    }

    fn replace_owner(
        &mut self,
        old: &StorageBrowserCacheReceipt,
        new: &StorageBrowserCacheReceipt,
    ) {
        self.coordinator
            .record_owner_receipt(
                &self.plan.operation_id,
                BROWSER_CACHE_OWNER,
                Some(&serde_json::to_value(old).unwrap()),
                serde_json::to_value(new).unwrap(),
            )
            .unwrap();
    }

    fn copy_and_publish(&mut self, owner: Option<&StorageBrowserCacheReceipt>) {
        self.coordinator
            .prepare_source_retirements(&self.plan.operation_id)
            .unwrap();
        let exclusions =
            browser_cache_copy_exclusions(&self.plan, owner, "persistent-root").unwrap();
        let stage = match self
            .coordinator
            .prepare_component_staging(&self.plan.operation_id, "persistent-root")
            .unwrap()
        {
            super::super::StorageComponentDirectory::Staging(directory) => directory,
            _ => panic!("expected owned staging"),
        };
        let plan = self.plan.clone();
        self.coordinator
            .copy_component_checked(
                &self.plan.operation_id,
                "persistent-root",
                &stage,
                &exclusions,
                |inventory| {
                    validate_browser_cache_source_inventory(
                        &plan,
                        owner,
                        "persistent-root",
                        inventory,
                    )
                },
            )
            .unwrap();
        assert!(matches!(
            self.coordinator
                .publish_component(&self.plan.operation_id, "persistent-root", &exclusions)
                .unwrap(),
            super::super::StorageComponentDirectory::Published(_)
        ));
    }

    fn bind(&mut self, frozen: &StorageBrowserCacheReceipt) -> StorageBrowserCacheReceipt {
        let bound =
            prepare_browser_cache_target(&mut self.coordinator, &self.plan.operation_id, frozen)
                .unwrap();
        self.replace_owner(frozen, &bound);
        bound
    }

    fn finish(
        &mut self,
        recorded: &StorageBrowserCacheReceipt,
        completed: &StorageBrowserCacheReceipt,
    ) {
        self.replace_owner(recorded, completed);
        for (from, to) in [
            (Phase::Copying, Phase::Verifying),
            (Phase::Verifying, Phase::Prepared),
        ] {
            self.coordinator
                .advance(&self.plan.operation_id, from, to)
                .unwrap();
        }
        self.coordinator.commit(&self.plan.operation_id).unwrap();
        self.coordinator.complete(&self.plan.operation_id).unwrap();
    }

    fn next_operation(mut self, moved: bool, same_cache: bool) -> Self {
        let home = self._owned.path();
        let original = self.plan.target.clone();
        let from = super::super::resolve_storage_paths(&super::super::StorageResolveInput {
            home: Some(home.to_owned()),
            record: Some(original.clone()),
            ..Default::default()
        })
        .unwrap();
        let id = format!("next-{}", self.plan.operation_id);
        let target = StorageLocationRecord {
            version: 1,
            revision: original.revision + 1,
            data_root: if moved {
                home.join(format!("data-{id}"))
            } else {
                from.data_root.clone()
            },
            cache_root: if same_cache {
                from.cache_root.clone()
            } else {
                home.join(format!("cache-{id}"))
            },
            operation_id: Some(id.clone()),
        };
        let source = PrivateDirectory::open_existing(&from.data_root).unwrap();
        let components = vec![kcoder_types::StorageMigrationComponent {
            domain: "persistent-root".into(),
            source: from.data_root.clone(),
            destination: target.data_root.clone(),
            source_identity: source.directory_identity().unwrap(),
            estimated_bytes: 0,
        }];
        let target_bindings = [&target.data_root, &target.cache_root]
            .into_iter()
            .map(|path| {
                let inspected = super::super::inspect_storage_target(path).unwrap();
                kcoder_types::StorageTargetBinding {
                    path: inspected.path,
                    existing_ancestor: inspected.existing_ancestor,
                    ancestor_identity: inspected.ancestor_identity,
                }
            })
            .collect();
        self.plan = StorageMigrationPlan {
            version: 1,
            operation_id: id,
            original: Some(original),
            from,
            target,
            components,
            target_bindings,
            launch_intent: StorageLaunchIntent::Cli,
        };
        self.paths = paths(&self.plan).unwrap();
        // Each production migration has a new one-shot coordinator. Release the
        // completed operation's Windows range locks before the next invocation.
        drop(self.coordinator);
        self.coordinator = StorageCoordinator::acquire(home).unwrap();
        self.coordinator.begin(self.plan.clone()).unwrap();
        self
    }
}

#[test]
fn node_and_native_share_the_registered_partition_paths_and_source_kinds() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/storage-browser-cache.json"
    ))
    .unwrap();
    let f = Fixture::new(true);
    assert_eq!(fixture["partition"], DESKTOP_BROWSER_PARTITION);
    assert_eq!(fixture["partitionName"], PARTITION_NAME);
    assert_eq!(
        fixture["windowsDesktopRootMaxUtf16"],
        WINDOWS_DESKTOP_ROOT_MAX_UTF16
    );
    assert_eq!(
        f.paths.partition.join(CACHE),
        f.plan
            .from
            .desktop_root
            .join(fixture["profileCacheRelative"].as_str().unwrap())
    );
    assert_eq!(
        f.paths.http,
        f.plan
            .target
            .cache_root
            .join(fixture["httpCacheRelative"].as_str().unwrap())
    );
    assert_eq!(
        f.paths.http.parent().unwrap().join("code"),
        f.plan
            .target
            .cache_root
            .join(fixture["codeCacheRelative"].as_str().unwrap())
    );
    assert_eq!(
        fixture["sourceKinds"],
        serde_json::to_value([Kind::Directory, Kind::DirectoryLink]).unwrap()
    );
}

#[test]
fn desktop_profile_path_budget_is_windows_only_and_counts_utf16() {
    let boundary = format!(r"C:\{}", "x".repeat(WINDOWS_DESKTOP_ROOT_MAX_UTF16 - 3));
    assert!(validate_desktop_profile_path(Path::new(&boundary)).is_ok());
    for path in [
        format!("{boundary}x"),
        format!(r"\\?\{boundary}x"),
        format!(r"C:\{}", "😀".repeat(90)),
    ] {
        let result = validate_desktop_profile_path(Path::new(&path));
        if cfg!(windows) {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("STORAGE_BROWSER_PROFILE_PATH_TOO_LONG")
            );
        } else {
            result.unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn deep_desktop_target_is_rejected_before_copy_but_native_only_paths_remain_usable() {
    let mut desktop = Fixture::new(true);
    desktop.plan.target.data_root = desktop._owned.path().join("x".repeat(180));
    assert!(
        preview_browser_cache(&desktop.plan)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_BROWSER_PROFILE_PATH_TOO_LONG")
    );
    assert!(!desktop.plan.target.data_root.exists());
    desktop.assert_markers();
    let mut native = Fixture::new(false);
    native.plan.target.data_root = native._owned.path().join("x".repeat(180));
    for intent in [
        StorageLaunchIntent::Cli,
        StorageLaunchIntent::Gateway,
        StorageLaunchIntent::VerifyOnly,
    ] {
        native.plan.launch_intent = intent;
        preview_browser_cache(&native.plan).unwrap();
    }
    native.plan.launch_intent = StorageLaunchIntent::Desktop;
    assert!(
        preview_browser_cache(&native.plan)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_BROWSER_PROFILE_PATH_TOO_LONG")
    );
    assert!(!native.plan.target.data_root.exists());
}

#[test]
fn no_existing_partition_does_not_initialize_an_electron_profile_or_cache_tree() {
    let mut f = Fixture::new(false);
    f.stopped();
    assert!(
        prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id)
            .unwrap()
            .is_none()
    );
    verify_no_browser_cache(&f.plan).unwrap();
    assert!(!f.plan.from.desktop_root.exists());
    assert!(!f.plan.target.cache_root.join("browser-cache").exists());
}

#[test]
fn preparation_before_stopped_is_rejected_without_touching_source_or_target() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    assert!(prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id).is_err());
    assert_eq!(
        fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
        b"old-http-cache"
    );
    assert!(!f.plan.target.cache_root.join("browser-cache").exists());
}

#[test]
fn preparation_requires_durable_recording_before_source_mutation_then_retains_original_bytes() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let owner = f.prepare();
    assert_eq!(owner.source.as_ref().unwrap().kind, Kind::Directory);
    assert!(owner.retained_entry_identity.is_none());
    assert!(owner.published_link_identity.is_none());
    assert_eq!(
        fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
        b"old-http-cache"
    );
    assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
    f.persist(&owner);
    let completed = f.apply(&owner);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert_eq!(
        completed.retained_entry_identity,
        owner.source.as_ref().map(|source| source.identity.clone())
    );
    assert_eq!(
        completed.published_link_identity.as_ref(),
        owner.prepared_link_identity.as_ref()
    );
    assert_eq!(
        fs::read(f.paths.partition.join(&f.paths.retained).join("keep")).unwrap(),
        b"old-http-cache"
    );
    assert!(fs::read_dir(&f.paths.http).unwrap().next().is_none());
    f.assert_markers();
}

#[test]
fn known_old_junction_or_symlink_is_retained_and_new_cache_does_not_copy_old_content() {
    let mut f = Fixture::new(true);
    fs::create_dir_all(&f.paths.previous_http).unwrap();
    fs::write(f.paths.previous_http.join("keep"), b"old-target").unwrap();
    f.known_link();
    let owner = f.prepare();
    assert_eq!(owner.source.as_ref().unwrap().kind, Kind::DirectoryLink);
    f.persist(&owner);
    let completed = f.apply(&owner);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert_eq!(
        fs::read(f.paths.previous_http.join("keep")).unwrap(),
        b"old-target"
    );
    assert!(fs::read_dir(&f.paths.http).unwrap().next().is_none());
    let partition = open_partition(&f.plan).unwrap().unwrap();
    assert_eq!(
        partition
            .open_entry_handle(OsStr::new(&f.paths.retained))
            .unwrap()
            .identity()
            .unwrap(),
        owner.source.as_ref().unwrap().identity
    );
    f.assert_markers();
}

#[test]
fn a_dangling_known_cache_link_is_rebound_without_following_or_recreating_its_old_target() {
    let mut f = Fixture::new(true);
    f.known_link();
    let owner = f.prepare();
    f.persist(&owner);
    let completed = f.apply(&owner);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert!(!f.paths.previous_http.exists());
    f.assert_markers();
}

#[test]
fn foreign_links_and_ordinary_files_fail_before_creating_a_new_target() {
    for link in [false, true] {
        let mut f = Fixture::new(true);
        if link {
            open_partition(&f.plan)
                .unwrap()
                .unwrap()
                .create_directory_link(OsStr::new(CACHE), &f.plan.target.data_root.join("foreign"))
                .unwrap();
        } else {
            fs::write(f.paths.partition.join(CACHE), b"unknown").unwrap();
        }
        f.stopped();
        assert!(prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id).is_err());
        assert!(!f.plan.target.cache_root.join("browser-cache").exists());
        f.assert_markers();
    }
}

#[test]
fn familiar_unrecorded_stage_retained_or_target_names_are_never_adopted() {
    for kind in ["stage", "retained", "target"] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let unknown = match kind {
            "stage" => f.paths.partition.join(&f.paths.prepared),
            "retained" => f.paths.partition.join(&f.paths.retained),
            _ => f.paths.http.clone(),
        };
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join("keep"), b"unknown-owner").unwrap();
        f.stopped();
        assert!(prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id).is_err());
        assert_eq!(fs::read(unknown.join("keep")).unwrap(), b"unknown-owner");
        assert_eq!(
            fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
            b"old-http-cache"
        );
    }
}

#[test]
fn a_lost_or_replaced_stage_identity_does_not_retain_source_or_replay_link_creation() {
    for replacement in [false, true] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let owner = f.prepare();
        f.persist(&owner);
        let partition = open_partition(&f.plan).unwrap().unwrap();
        partition
            .rename_no_replace(
                OsStr::new(&f.paths.prepared),
                OsStr::new("kept-original-stage"),
            )
            .unwrap();
        if replacement {
            partition
                .create_directory_link(OsStr::new(&f.paths.prepared), &f.paths.http)
                .unwrap();
        }
        assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
        assert_eq!(
            fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
            b"old-http-cache"
        );
        assert!(!f.paths.partition.join(&f.paths.retained).exists());
    }
}

#[test]
fn source_partition_and_target_directory_replacements_are_rejected_without_cleanup() {
    for partition_replaced in [false, true] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let owner = f.prepare();
        f.persist(&owner);
        let path = if partition_replaced {
            &f.paths.partition
        } else {
            &f.paths.http
        };
        let kept = path.with_file_name("kept-original-directory");
        fs::rename(path, &kept).unwrap();
        fs::create_dir(path).unwrap();
        fs::write(path.join("keep-unknown"), b"replacement").unwrap();
        assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
        assert_eq!(fs::read(path.join("keep-unknown")).unwrap(), b"replacement");
        assert!(kept.is_dir());
    }
}

#[test]
fn recovery_recognizes_only_recorded_retained_and_published_identities() {
    for already_published in [false, true] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let owner = f.prepare();
        f.persist(&owner);
        let partition = open_partition(&f.plan).unwrap().unwrap();
        partition
            .open_entry_handle(OsStr::new(CACHE))
            .unwrap()
            .rename_directory_entry_no_replace(OsStr::new(&f.paths.retained))
            .unwrap();
        if already_published {
            partition
                .open_entry_handle(OsStr::new(&f.paths.prepared))
                .unwrap()
                .rename_directory_entry_no_replace(OsStr::new(CACHE))
                .unwrap();
        }
        assert!(verify_browser_cache(&f.plan, &owner).is_err());
        let completed = f.apply(&owner);
        verify_browser_cache(&f.plan, &completed).unwrap();
        assert_eq!(
            fs::read(f.paths.partition.join(&f.paths.retained).join("keep")).unwrap(),
            b"old-http-cache"
        );
        assert_eq!(
            completed.published_link_identity.as_ref(),
            owner.prepared_link_identity.as_ref()
        );
        f.assert_markers();
    }
}

#[test]
fn retained_conflict_after_recording_is_preserved_with_the_original_source() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let owner = f.prepare();
    f.persist(&owner);
    fs::create_dir(f.paths.partition.join(&f.paths.retained)).unwrap();
    fs::write(
        f.paths.partition.join(&f.paths.retained).join("keep"),
        b"unknown",
    )
    .unwrap();
    assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
    assert_eq!(
        fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
        b"old-http-cache"
    );
    assert_eq!(
        fs::read(f.paths.partition.join(&f.paths.retained).join("keep")).unwrap(),
        b"unknown"
    );
}

#[test]
fn a_missing_original_cache_slot_publishes_only_the_recorded_stage() {
    let mut f = Fixture::new(true);
    let owner = f.prepare();
    assert!(owner.source.is_none());
    f.persist(&owner);
    let completed = f.apply(&owner);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert!(completed.retained_entry_identity.is_none());
    f.assert_markers();
}

#[test]
fn a_same_target_link_with_a_different_published_identity_is_not_a_success() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let owner = f.prepare();
    f.persist(&owner);
    let completed = f.apply(&owner);
    let partition = open_partition(&f.plan).unwrap().unwrap();
    partition
        .rename_no_replace(OsStr::new(CACHE), OsStr::new("kept-published-original"))
        .unwrap();
    partition
        .create_directory_link(OsStr::new(CACHE), &f.paths.http)
        .unwrap();
    assert!(verify_browser_cache(&f.plan, &completed).is_err());
    assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
    f.assert_markers();
}

#[test]
fn a_completed_record_reconciles_without_creating_or_moving_any_new_entry() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let owner = f.prepare();
    f.persist(&owner);
    let completed = f.apply(&owner);
    let prepared_value = serde_json::to_value(&owner).unwrap();
    f.coordinator
        .record_owner_receipt(
            &f.plan.operation_id,
            BROWSER_CACHE_OWNER,
            Some(&prepared_value),
            serde_json::to_value(&completed).unwrap(),
        )
        .unwrap();
    assert_eq!(
        prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id)
            .unwrap()
            .as_ref(),
        Some(&completed)
    );
    assert_eq!(f.apply(&completed), completed);
    verify_browser_cache(&f.plan, &completed).unwrap();
    f.assert_markers();
}

#[test]
fn malformed_or_other_operation_owner_facts_are_rejected() {
    let mut f = Fixture::new(true);
    let owner = f.prepare();
    let mut wrong = owner.clone();
    wrong.operation_id = "other-operation".into();
    assert!(validate_owner(&f.plan, &wrong).is_err());
    wrong = owner;
    wrong.version = 2;
    assert!(validate_owner(&f.plan, &wrong).is_err());
}

#[test]
fn preview_is_read_only_and_rejects_foreign_or_unrecorded_cache_slots() {
    let f = Fixture::new(true);
    f.ordinary_cache();
    let source_identity = open_partition(&f.plan)
        .unwrap()
        .unwrap()
        .open_entry_handle(OsStr::new(CACHE))
        .unwrap()
        .identity()
        .unwrap();
    let before = fs::read_dir(&f.plan.target.cache_root).unwrap().count();
    preview_browser_cache(&f.plan).unwrap();
    assert_eq!(
        fs::read_dir(&f.plan.target.cache_root).unwrap().count(),
        before
    );
    assert_eq!(
        open_partition(&f.plan)
            .unwrap()
            .unwrap()
            .open_entry_handle(OsStr::new(CACHE))
            .unwrap()
            .identity()
            .unwrap(),
        source_identity
    );
    assert!(!f.paths.partition.join(&f.paths.prepared).exists());
    assert!(!f.paths.http.exists());
    f.assert_markers();

    for name in ["foreign", "prepared", "retained"] {
        let f = Fixture::new(true);
        if name == "foreign" {
            open_partition(&f.plan)
                .unwrap()
                .unwrap()
                .create_directory_link(OsStr::new(CACHE), &f.plan.target.data_root.join("foreign"))
                .unwrap();
        } else {
            f.ordinary_cache();
            fs::create_dir(f.paths.partition.join(if name == "prepared" {
                &f.paths.prepared
            } else {
                &f.paths.retained
            }))
            .unwrap();
        }
        assert!(preview_browser_cache(&f.plan).is_err());
        assert!(!f.paths.http.exists());
        f.assert_markers();
    }
}

#[test]
fn target_verification_rejects_unknown_files_links_and_extra_branches_without_cleanup() {
    for relative in [
        "unknown-file",
        "browser-cache/extra",
        "browser-cache/desktop/extra",
        "browser-cache/desktop/kcoder-studio-desktop/code",
        "browser-cache/desktop/kcoder-studio-desktop/http/unrecorded-payload",
    ] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let owner = f.prepare();
        f.persist(&owner);
        let unknown = f.plan.target.cache_root.join(relative);
        if relative == "unknown-file" {
            fs::write(&unknown, b"unknown").unwrap();
        } else {
            fs::create_dir(&unknown).unwrap();
            fs::write(unknown.join("keep"), b"unknown").unwrap();
        }
        assert!(verify_browser_cache_target(&f.plan, &owner).is_err());
        assert!(apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &owner).is_err());
        assert!(unknown.symlink_metadata().is_ok());
        assert_eq!(
            fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
            b"old-http-cache"
        );
        f.assert_markers();
    }

    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let owner = f.prepare();
    f.persist(&owner);
    let cache = PrivateDirectory::open_existing(&f.plan.target.cache_root).unwrap();
    let kept = f.plan.target.data_root.join("kept-original-cache-subtree");
    fs::rename(f.plan.target.cache_root.join("browser-cache"), &kept).unwrap();
    cache
        .create_directory_link(OsStr::new("browser-cache"), &f.plan.target.data_root)
        .unwrap();
    assert!(verify_browser_cache_target(&f.plan, &owner).is_err());
    assert!(kept.is_dir());
    f.assert_markers();
}

#[test]
fn moved_preview_and_source_freeze_do_not_open_or_initialize_target_profile() {
    let mut f = Fixture::moved(true, false);
    f.ordinary_cache();
    preview_browser_cache(&f.plan).unwrap();
    assert!(!f.plan.target.data_root.exists());
    assert!(!f.paths.http.exists());
    let frozen = f.prepare();
    assert!(frozen.target_partition_identity.is_none());
    assert!(frozen.http_target_identity.is_none());
    assert!(frozen.prepared_link_identity.is_none());
    assert!(frozen.retained_entry_identity.is_none());
    assert!(!f.plan.target.data_root.exists());
    assert!(!f.paths.http.exists());
    f.persist(&frozen);
    verify_browser_cache_target(&f.plan, &frozen).unwrap();
    assert!(verify_browser_cache(&f.plan, &frozen).is_err());
    assert!(
        prepare_browser_cache_target(&mut f.coordinator, &f.plan.operation_id, &frozen).is_err()
    );
    assert!(!f.plan.target.data_root.exists());
    assert_eq!(
        fs::read(f.paths.source_partition.join("Cache/keep")).unwrap(),
        b"old-http-cache"
    );
    f.assert_markers();
}

#[test]
fn moved_profile_and_cache_accept_original_offline_child_fences() {
    let mut f = Fixture::moved(true, false);
    f.known_link();
    let frozen = f.prepare();
    f.persist(&frozen);
    // The real Gateway owner delegates a stopped child before copying. Its
    // secondary fence also exists at the still-empty destination cache root.
    let fences = f
        .coordinator
        .prepare_offline_child_fences(&f.plan.operation_id)
        .unwrap();
    assert!(
        fences
            .roots
            .iter()
            .any(|root| root.root == f.plan.target.cache_root)
    );
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    verify_browser_cache(&f.plan, &completed).unwrap();
    f.assert_markers();

    // A recognized control name must still be an empty, single-link file.
    let secondary = f
        .plan
        .target
        .cache_root
        .join("kcoder-storage-instances.lock");
    fs::write(&secondary, b"foreign payload").unwrap();
    assert!(verify_browser_cache(&f.plan, &completed).is_err());
    fs::write(&secondary, b"").unwrap();
    let alias = f.plan.target.data_root.join("foreign-fence-alias");
    fs::hard_link(&secondary, &alias).unwrap();
    assert!(verify_browser_cache(&f.plan, &completed).is_err());
    fs::remove_file(alias).unwrap();
    verify_browser_cache(&f.plan, &completed).unwrap();
}

#[test]
fn moved_root_preserves_profile_and_source_while_only_registered_cache_leaves_are_omitted() {
    for source in ["directory", "known-link", "absent"] {
        let mut f = Fixture::moved(true, false);
        match source {
            "directory" => f.ordinary_cache(),
            "known-link" => f.known_link(),
            _ => {}
        }
        let unknown = f
            .paths
            .source_partition
            .join("Cache.retained-unknown-operation");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("persistent"), b"unknown-retained-directory").unwrap();
        let frozen = f.prepare();
        f.persist(&frozen);
        f.copy_and_publish(Some(&frozen));
        assert!(!f.paths.partition.join(CACHE).exists());
        assert_eq!(
            fs::read(f.paths.partition.join("Cookies")).unwrap(),
            b"owned-cookie"
        );
        assert_eq!(
            fs::read(f.paths.partition.join("Local Storage/draft")).unwrap(),
            b"unsent-draft"
        );
        assert_eq!(
            fs::read(
                f.paths
                    .partition
                    .join("Cache.retained-unknown-operation/persistent")
            )
            .unwrap(),
            b"unknown-retained-directory"
        );
        let bound = f.bind(&frozen);
        assert_ne!(
            bound.target_partition_identity.as_ref(),
            Some(&bound.partition_identity)
        );
        let completed = f.apply(&bound);
        verify_browser_cache(&f.plan, &completed).unwrap();
        assert_eq!(completed.retained_entry_identity, None);
        assert!(!f.paths.partition.join(&f.paths.retained).exists());
        if source == "directory" {
            assert_eq!(
                fs::read(f.paths.source_partition.join("Cache/keep")).unwrap(),
                b"old-http-cache"
            );
        }
        assert_eq!(
            entry(&open_source_partition(&f.plan).unwrap().unwrap(), CACHE)
                .unwrap()
                .map(|entry| entry_fact(&entry, &f.paths.source_partition).unwrap()),
            frozen.source
        );
        assert!(fs::read_dir(&f.paths.http).unwrap().next().is_none());
        f.assert_markers();
    }
}

#[test]
fn moving_only_persistent_root_reuses_existing_http_payload_and_other_cache_branches() {
    let mut f = Fixture::moved(true, true);
    fs::create_dir_all(&f.paths.previous_http).unwrap();
    fs::write(f.paths.previous_http.join("keep"), b"existing-http-payload").unwrap();
    fs::create_dir_all(f.plan.from.cache_root.join("tmp/other-owned-resource")).unwrap();
    fs::write(
        f.plan.from.cache_root.join("tmp/other-owned-resource/keep"),
        b"other-cache-owner",
    )
    .unwrap();
    f.known_link();
    let original = PrivateDirectory::open_existing(&f.paths.http)
        .unwrap()
        .directory_identity()
        .unwrap();
    let frozen = f.prepare();
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    assert_eq!(
        bound.http_target_identity.as_deref(),
        Some(original.as_str())
    );
    let completed = f.apply(&bound);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert_eq!(
        fs::read(f.paths.http.join("keep")).unwrap(),
        b"existing-http-payload"
    );
    assert_eq!(
        fs::read(f.plan.from.cache_root.join("tmp/other-owned-resource/keep")).unwrap(),
        b"other-cache-owner"
    );
    f.assert_markers();
}

#[test]
fn absent_source_partition_has_no_exclusions_and_cannot_appear_before_copy() {
    let mut f = Fixture::moved(false, true);
    f.stopped();
    assert!(
        prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id)
            .unwrap()
            .is_none()
    );
    let exclusions = browser_cache_copy_exclusions(&f.plan, None, "persistent-root").unwrap();
    assert!(exclusions.is_empty());
    let inventory = f
        .coordinator
        .inventory_source(&f.plan.operation_id, "persistent-root", &exclusions)
        .unwrap();
    validate_browser_cache_source_inventory(&f.plan, None, "persistent-root", &inventory).unwrap();
    fs::create_dir_all(&f.paths.source_partition).unwrap();
    assert!(
        validate_browser_cache_source_inventory(&f.plan, None, "persistent-root", &inventory)
            .is_err()
    );
}

#[test]
fn frozen_cache_exclusions_require_the_copiers_exact_kind_identity_and_presence() {
    let mut f = Fixture::moved(true, false);
    f.ordinary_cache();
    let frozen = f.prepare();
    f.persist(&frozen);
    let exclusions =
        browser_cache_copy_exclusions(&f.plan, Some(&frozen), "persistent-root").unwrap();
    let inventory = f
        .coordinator
        .inventory_source(&f.plan.operation_id, "persistent-root", &exclusions)
        .unwrap();
    validate_browser_cache_source_inventory(&f.plan, Some(&frozen), "persistent-root", &inventory)
        .unwrap();
    let path = PathBuf::from("studio/desktop/Partitions/kcoder-studio-desktop/Cache");
    for mutation in ["identity", "kind", "excluded", "absent"] {
        let mut changed = inventory.clone();
        let index = changed
            .entries
            .iter()
            .position(|entry| entry.relative_path == path)
            .unwrap();
        match mutation {
            "identity" => changed.entries[index].identity.push_str("changed"),
            "kind" => changed.entries[index].kind = super::super::StorageTreeEntryKind::Symlink,
            "excluded" => changed.entries[index].excluded = false,
            _ => {
                changed.entries.remove(index);
            }
        }
        assert!(
            validate_browser_cache_source_inventory(
                &f.plan,
                Some(&frozen),
                "persistent-root",
                &changed
            )
            .is_err()
        );
    }
    for kind in [
        super::super::StorageTreeEntryKind::Directory,
        super::super::StorageTreeEntryKind::Symlink,
    ] {
        let mut changed = inventory.clone();
        changed.entries.push(super::super::StorageTreeEntry {
            relative_path: path.with_file_name("Cache.retained-unproved"),
            kind,
            identity: "unix:9:9".into(),
            size_bytes: None,
            sha256: None,
            excluded: true,
        });
        assert!(
            validate_browser_cache_source_inventory(
                &f.plan,
                Some(&frozen),
                "persistent-root",
                &changed
            )
            .is_err()
        );
    }
    let stage = match f
        .coordinator
        .prepare_component_staging(&f.plan.operation_id, "persistent-root")
        .unwrap()
    {
        super::super::StorageComponentDirectory::Staging(directory) => directory,
        _ => panic!("expected stage"),
    };
    fs::rename(
        f.paths.source_partition.join(CACHE),
        f.paths.source_partition.join("kept-original-cache"),
    )
    .unwrap();
    fs::create_dir(f.paths.source_partition.join(CACHE)).unwrap();
    let plan = f.plan.clone();
    assert!(
        f.coordinator
            .copy_component_checked(
                &f.plan.operation_id,
                "persistent-root",
                &stage,
                &exclusions,
                |actual| validate_browser_cache_source_inventory(
                    &plan,
                    Some(&frozen),
                    "persistent-root",
                    actual
                )
            )
            .is_err()
    );
    assert_eq!(
        stage
            .entry_names_bounded(3)
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            std::ffi::OsString::from("kcoder-storage-writers.lock"),
            std::ffi::OsString::from("kcoder-storage-pending.json"),
        ])
    );
    assert!(
        !f.coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key("copy-persistent-root")
    );
    assert_eq!(
        fs::read(f.paths.source_partition.join("kept-original-cache/keep")).unwrap(),
        b"old-http-cache"
    );
}

#[test]
fn unknown_retained_links_are_not_excluded_or_followed() {
    let mut f = Fixture::moved(true, false);
    f.ordinary_cache();
    open_source_partition(&f.plan)
        .unwrap()
        .unwrap()
        .create_directory_link(
            OsStr::new("Cache.retained-unknown-operation"),
            &f.paths.previous_http,
        )
        .unwrap();
    let frozen = f.prepare();
    assert!(frozen.retained_sources.is_empty());
    f.persist(&frozen);
    let exclusions =
        browser_cache_copy_exclusions(&f.plan, Some(&frozen), "persistent-root").unwrap();
    assert_eq!(exclusions.len(), 1);
    let stage = match f
        .coordinator
        .prepare_component_staging(&f.plan.operation_id, "persistent-root")
        .unwrap()
    {
        super::super::StorageComponentDirectory::Staging(directory) => directory,
        _ => panic!("expected stage"),
    };
    let plan = f.plan.clone();
    assert!(
        f.coordinator
            .copy_component_checked(
                &f.plan.operation_id,
                "persistent-root",
                &stage,
                &exclusions,
                |inventory| validate_browser_cache_source_inventory(
                    &plan,
                    Some(&frozen),
                    "persistent-root",
                    inventory
                )
            )
            .is_err()
    );
    assert!(!f.paths.previous_http.exists());
    assert!(
        f.paths
            .source_partition
            .join("Cache.retained-unknown-operation")
            .symlink_metadata()
            .is_ok()
    );
}

#[test]
fn final_cache_slot_and_prepared_link_are_not_adopted_after_missing_or_lost_receipts() {
    for interruption in [
        "unknown-slot",
        "unrecorded-stage",
        "missing-stage",
        "replaced-stage",
    ] {
        let mut f = Fixture::moved(true, false);
        f.ordinary_cache();
        let frozen = f.prepare();
        f.persist(&frozen);
        f.copy_and_publish(Some(&frozen));
        if interruption == "unknown-slot" {
            fs::create_dir(f.paths.partition.join(CACHE)).unwrap();
            fs::write(f.paths.partition.join("Cache/keep"), b"unknown-final-slot").unwrap();
            assert!(
                prepare_browser_cache_target(&mut f.coordinator, &f.plan.operation_id, &frozen)
                    .is_err()
            );
            assert!(!f.paths.http.exists());
            assert_eq!(
                fs::read(f.paths.partition.join("Cache/keep")).unwrap(),
                b"unknown-final-slot"
            );
        } else {
            let bound =
                prepare_browser_cache_target(&mut f.coordinator, &f.plan.operation_id, &frozen)
                    .unwrap();
            if interruption == "unrecorded-stage" {
                assert!(
                    prepare_browser_cache_target(&mut f.coordinator, &f.plan.operation_id, &frozen)
                        .is_err()
                );
            } else {
                f.replace_owner(&frozen, &bound);
                let partition = open_partition(&f.plan).unwrap().unwrap();
                partition
                    .rename_no_replace(
                        OsStr::new(&f.paths.prepared),
                        OsStr::new("kept-prepared-original"),
                    )
                    .unwrap();
                if interruption == "replaced-stage" {
                    partition
                        .create_directory_link(OsStr::new(&f.paths.prepared), &f.paths.http)
                        .unwrap();
                }
                assert!(
                    prepare_browser_cache_target(&mut f.coordinator, &f.plan.operation_id, &bound)
                        .is_err()
                );
                assert!(
                    apply_browser_cache(&mut f.coordinator, &f.plan.operation_id, &bound).is_err()
                );
                assert!(entry(&partition, CACHE).unwrap().is_none());
            }
        }
        assert_eq!(
            fs::read(f.paths.source_partition.join("Cache/keep")).unwrap(),
            b"old-http-cache"
        );
        f.assert_markers();
    }
}

#[test]
fn completed_cache_operations_prove_only_their_exact_retained_source_leaves() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let first = f.prepare();
    f.persist(&first);
    let completed = f.apply(&first);
    f.finish(&first, &completed);
    let first_retained = f.paths.retained.clone();
    f = f.next_operation(false, false);
    let second = f.prepare();
    f.persist(&second);
    let completed = f.apply(&second);
    f.finish(&second, &completed);
    let second_retained = f.paths.retained.clone();
    f = f.next_operation(true, true);
    let unknown = f.paths.source_partition.join("Cache.retained-unproved");
    fs::create_dir(&unknown).unwrap();
    fs::write(unknown.join("keep"), b"persistent-unknown").unwrap();
    let frozen = f.prepare();
    assert_eq!(frozen.retained_sources.len(), 2);
    f.persist(&frozen);
    let exclusions =
        browser_cache_copy_exclusions(&f.plan, Some(&frozen), "persistent-root").unwrap();
    assert_eq!(exclusions.len(), 3);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert!(!f.paths.partition.join(&first_retained).exists());
    assert!(!f.paths.partition.join(&second_retained).exists());
    assert_eq!(
        fs::read(f.paths.source_partition.join(&first_retained).join("keep")).unwrap(),
        b"old-http-cache"
    );
    assert_eq!(
        fs::read(f.paths.partition.join("Cache.retained-unproved/keep")).unwrap(),
        b"persistent-unknown"
    );
}

#[test]
fn retained_history_stops_at_previous_root_move_and_preserves_new_same_named_directories() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let first = f.prepare();
    f.persist(&first);
    let completed = f.apply(&first);
    f.finish(&first, &completed);
    let retained_name = f.paths.retained.clone();
    f = f.next_operation(true, true);
    let frozen = f.prepare();
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    f.finish(&bound, &completed);
    fs::create_dir(f.paths.partition.join(&retained_name)).unwrap();
    fs::write(
        f.paths.partition.join(&retained_name).join("keep"),
        b"new-directory-with-old-name",
    )
    .unwrap();
    f = f.next_operation(true, true);
    let frozen = f.prepare();
    assert!(frozen.retained_sources.is_empty());
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    assert_eq!(
        fs::read(f.paths.partition.join(&retained_name).join("keep")).unwrap(),
        b"new-directory-with-old-name"
    );
    let previous_id = f
        .plan
        .original
        .as_ref()
        .unwrap()
        .operation_id
        .as_ref()
        .unwrap();
    let mut previous = f.coordinator.prior_operation_receipt(previous_id).unwrap();
    previous
        .owner_receipts
        .get_mut(BROWSER_CACHE_OWNER)
        .unwrap()["version"] = serde_json::json!(2);
    let previous_directory = PrivateDirectory::open_existing(
        &f._owned
            .path()
            .join(".config/kcoder-storage-migrations")
            .join(previous_id),
    )
    .unwrap();
    previous_directory
        .atomic_replace(
            OsStr::new("receipt.json"),
            &serde_json::to_vec(&previous).unwrap(),
        )
        .unwrap();
    let error = relocation::retained_sources(
        &f.coordinator,
        &f.plan,
        &open_source_partition(&f.plan).unwrap().unwrap(),
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("STORAGE_BROWSER_CACHE_RECEIPT_INVALID"));
}

#[test]
fn replaced_historical_partition_or_retained_leaf_remains_unproved_persistent_data() {
    for replacement in ["partition", "retained-leaf"] {
        let mut f = Fixture::new(true);
        f.ordinary_cache();
        let owner = f.prepare();
        f.persist(&owner);
        let completed = f.apply(&owner);
        f.finish(&owner, &completed);
        let retained_name = f.paths.retained.clone();
        if replacement == "partition" {
            fs::rename(
                &f.paths.partition,
                f._owned.path().join("kept-original-partition"),
            )
            .unwrap();
            fs::create_dir_all(f.paths.partition.join("Local Storage")).unwrap();
            fs::write(f.paths.partition.join("Cookies"), b"owned-cookie").unwrap();
            fs::write(
                f.paths.partition.join("Local Storage/draft"),
                b"unsent-draft",
            )
            .unwrap();
        } else {
            fs::rename(
                f.paths.partition.join(&retained_name),
                f.paths.partition.join("kept-original-retained-leaf"),
            )
            .unwrap();
        }
        fs::create_dir(f.paths.partition.join(&retained_name)).unwrap();
        fs::write(
            f.paths.partition.join(&retained_name).join("keep"),
            b"unproved-replacement",
        )
        .unwrap();
        f = f.next_operation(true, true);
        let frozen = f.prepare();
        assert!(frozen.retained_sources.is_empty());
        f.persist(&frozen);
        f.copy_and_publish(Some(&frozen));
        assert_eq!(
            fs::read(f.paths.partition.join(&retained_name).join("keep")).unwrap(),
            b"unproved-replacement"
        );
    }
}

fn finish_cache_only_for_flat_test(fixture: &mut Fixture) -> StorageBrowserCacheReceipt {
    let owner = fixture.prepare();
    fixture.persist(&owner);
    let completed = fixture.apply(&owner);
    fixture.finish(&owner, &completed);
    completed
}

fn keep_older_receipt_outside_control(fixture: &Fixture, id: &str) {
    fs::rename(
        fixture
            ._owned
            .path()
            .join(".config/kcoder-storage-migrations")
            .join(id),
        fixture._owned.path().join(format!("kept-receipt-{id}")),
    )
    .unwrap();
}

#[test]
fn flat_sources_need_only_the_direct_previous_receipt_for_cache_and_root_moves() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    let first = finish_cache_only_for_flat_test(&mut f);
    f = f.next_operation(false, false);
    let second = finish_cache_only_for_flat_test(&mut f);
    assert_eq!(second.retained_sources.len(), 1);
    assert_eq!(second.retained_sources[0].operation_id, first.operation_id);

    f = f.next_operation(false, false);
    keep_older_receipt_outside_control(&f, &first.operation_id);
    let third = finish_cache_only_for_flat_test(&mut f);
    assert_eq!(third.retained_sources.len(), 2);
    assert!(
        third
            .retained_sources
            .iter()
            .any(|source| source.operation_id == first.operation_id)
    );

    f = f.next_operation(true, true);
    keep_older_receipt_outside_control(&f, &second.operation_id);
    let frozen = f.prepare();
    let expected = [&first, &second, &third]
        .into_iter()
        .map(|owner| owner.operation_id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        frozen
            .retained_sources
            .iter()
            .map(|source| source.operation_id.clone())
            .collect::<BTreeSet<_>>(),
        expected
    );
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    verify_browser_cache(&f.plan, &completed).unwrap();
    for id in expected {
        let name = format!("Cache.retained-{id}");
        assert!(
            f.paths
                .source_partition
                .join(&name)
                .symlink_metadata()
                .is_ok()
        );
        assert!(f.paths.partition.join(name).symlink_metadata().is_err());
    }
    f.assert_markers();
}

#[test]
fn cache_only_after_a_root_move_never_inherits_old_root_retained_names() {
    let mut f = Fixture::new(true);
    f.ordinary_cache();
    finish_cache_only_for_flat_test(&mut f);
    let old_name = f.paths.retained.clone();
    f = f.next_operation(true, true);
    let frozen = f.prepare();
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    f.finish(&bound, &completed);
    fs::create_dir(f.paths.partition.join(&old_name)).unwrap();
    fs::write(
        f.paths.partition.join(&old_name).join("keep"),
        b"new-root-business",
    )
    .unwrap();

    f = f.next_operation(false, false);
    let latest = finish_cache_only_for_flat_test(&mut f);
    assert!(latest.retained_sources.is_empty());
    f = f.next_operation(true, true);
    let frozen = f.prepare();
    assert_eq!(frozen.retained_sources.len(), 1);
    assert_eq!(frozen.retained_sources[0].operation_id, latest.operation_id);
    f.persist(&frozen);
    f.copy_and_publish(Some(&frozen));
    let bound = f.bind(&frozen);
    let completed = f.apply(&bound);
    verify_browser_cache(&f.plan, &completed).unwrap();
    assert_eq!(
        fs::read(f.paths.partition.join(&old_name).join("keep")).unwrap(),
        b"new-root-business"
    );
    f.assert_markers();
}

#[test]
fn an_inherited_flat_link_with_a_changed_target_is_not_omitted() {
    let mut f = Fixture::new(true);
    f.known_link();
    let first = finish_cache_only_for_flat_test(&mut f);
    let first_name = f.paths.retained.clone();
    f = f.next_operation(false, false);
    let second = finish_cache_only_for_flat_test(&mut f);
    assert_eq!(second.retained_sources.len(), 1);
    f = f.next_operation(true, true);
    fs::rename(
        f.paths.source_partition.join(&first_name),
        f._owned.path().join("kept-flat-original-link"),
    )
    .unwrap();
    let foreign = f._owned.path().join("foreign-flat-link-target");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("keep"), b"foreign-data").unwrap();
    open_source_partition(&f.plan)
        .unwrap()
        .unwrap()
        .create_directory_link(OsStr::new(&first_name), &foreign)
        .unwrap();
    let frozen = f.prepare();
    assert!(
        !frozen
            .retained_sources
            .iter()
            .any(|source| source.operation_id == first.operation_id)
    );
    f.persist(&frozen);
    let exclusions =
        browser_cache_copy_exclusions(&f.plan, Some(&frozen), "persistent-root").unwrap();
    let relative = PathBuf::from("studio/desktop/Partitions")
        .join(PARTITION_NAME)
        .join(&first_name);
    assert!(!exclusions.contains(&relative));
    f.coordinator
        .prepare_source_retirements(&f.plan.operation_id)
        .unwrap();
    let stage = match f
        .coordinator
        .prepare_component_staging(&f.plan.operation_id, "persistent-root")
        .unwrap()
    {
        super::super::StorageComponentDirectory::Staging(stage) => stage,
        _ => panic!("expected owned staging"),
    };
    let error = f
        .coordinator
        .copy_component_checked(
            &f.plan.operation_id,
            "persistent-root",
            &stage,
            &exclusions,
            |inventory| {
                validate_browser_cache_source_inventory(
                    &f.plan,
                    Some(&frozen),
                    "persistent-root",
                    inventory,
                )
            },
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("STORAGE_TREE_LINK_UNSUPPORTED"));
    assert_eq!(fs::read(foreign.join("keep")).unwrap(), b"foreign-data");
    assert!(
        f.paths
            .source_partition
            .join(first_name)
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    f.assert_markers();
}

fn legacy_desktop_in_place_fixture(desktop_present: bool) -> Fixture {
    let owned = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(owned.path()).unwrap();
    PrivateDirectory::open_or_create(&home.join(".config")).unwrap();
    let from = super::super::resolve_storage_paths(&super::super::StorageResolveInput {
        home: Some(home.clone()),
        platform_config: Some(home.join("legacy-desktop-platform")),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(from.layout, kcoder_types::StorageLayout::Legacy);
    let native = PrivateDirectory::open_config_root(&from.data_root).unwrap();
    native
        .atomic_replace(OsStr::new("settings.json"), b"{}")
        .unwrap();
    native.open_child(OsStr::new("studio"), true).unwrap();
    PrivateDirectory::open_config_root(&from.gateway_root)
        .unwrap()
        .atomic_replace(OsStr::new("servers.json"), b"legacy-gateway-data")
        .unwrap();
    if desktop_present {
        let desktop = PrivateDirectory::open_config_root(&from.desktop_root).unwrap();
        let partition = desktop
            .open_child(OsStr::new("Partitions"), true)
            .unwrap()
            .open_child(OsStr::new(PARTITION_NAME), true)
            .unwrap();
        partition
            .atomic_replace(OsStr::new("Cookies"), b"owned-cookie")
            .unwrap();
        partition
            .open_child(OsStr::new("Local Storage"), true)
            .unwrap()
            .atomic_replace(OsStr::new("draft"), b"unsent-draft")
            .unwrap();
    }
    let id = "legacy-desktop-native-in-place";
    let target = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: from.data_root.clone(),
        cache_root: home.join("selected-legacy-cache"),
        operation_id: Some(id.into()),
    };
    PrivateDirectory::open_config_root(&target.cache_root).unwrap();
    let mut roots = vec![
        (
            "persistent-root",
            from.data_root.clone(),
            target.data_root.clone(),
        ),
        (
            "gateway",
            from.gateway_root.clone(),
            target.data_root.join("studio/gateway"),
        ),
    ];
    if desktop_present {
        roots.push((
            "desktop",
            from.desktop_root.clone(),
            target.data_root.join("studio/desktop"),
        ));
    }
    let components = roots
        .into_iter()
        .map(
            |(domain, source, destination)| kcoder_types::StorageMigrationComponent {
                domain: domain.into(),
                source_identity: PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                source,
                destination,
                estimated_bytes: 0,
            },
        )
        .collect();
    let target_bindings = [&target.data_root, &target.cache_root]
        .into_iter()
        .map(|path| {
            let target = super::super::inspect_storage_target(path).unwrap();
            kcoder_types::StorageTargetBinding {
                path: target.path,
                existing_ancestor: target.existing_ancestor,
                ancestor_identity: target.ancestor_identity,
            }
        })
        .collect();
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        from,
        target,
        components,
        target_bindings,
        launch_intent: StorageLaunchIntent::Cli,
    };
    let paths = paths(&plan).unwrap();
    let coordinator = StorageCoordinator::acquire(&home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    Fixture {
        plan,
        coordinator,
        paths,
        _owned: owned,
    }
}

#[test]
fn legacy_desktop_component_moves_cache_while_native_root_and_files_stay_in_place() {
    for kind in [Kind::Directory, Kind::DirectoryLink] {
        let mut f = legacy_desktop_in_place_fixture(true);
        match kind {
            Kind::Directory => f.ordinary_cache(),
            Kind::DirectoryLink => f.known_link(),
        }
        let native = PrivateDirectory::open_existing(&f.plan.from.data_root).unwrap();
        let native_identity = native.directory_identity().unwrap();
        let settings_identity = native
            .open_entry_handle(OsStr::new("settings.json"))
            .unwrap()
            .identity()
            .unwrap();
        assert_eq!(f.plan.from.data_root, f.plan.target.data_root);
        assert!(relocated(&f.plan).unwrap());
        let business = f.paths.source_partition.join("persistent/Cache");
        fs::create_dir_all(&business).unwrap();
        fs::write(business.join("keep"), b"business-not-http-cache").unwrap();
        preview_browser_cache(&f.plan).unwrap();
        let frozen = f.prepare();
        assert_eq!(frozen.source.as_ref().unwrap().kind, kind);
        assert!(frozen.target_partition_identity.is_none());
        assert!(frozen.prepared_link_identity.is_none());
        assert!(!f.paths.partition.exists());
        f.persist(&frozen);
        let exclusions = browser_cache_copy_exclusions(&f.plan, Some(&frozen), "desktop").unwrap();
        assert_eq!(
            exclusions,
            BTreeSet::from([PathBuf::from("Partitions").join(PARTITION_NAME).join(CACHE)])
        );
        assert!(browser_cache_copy_exclusions(&f.plan, Some(&frozen), "persistent-root").is_err());
        f.coordinator
            .prepare_source_retirements(&f.plan.operation_id)
            .unwrap();
        let plan = f.plan.clone();
        assert!(matches!(
            f.coordinator
                .publish_component_checked(
                    &f.plan.operation_id,
                    "desktop",
                    &exclusions,
                    |inventory| validate_browser_cache_source_inventory(
                        &plan,
                        Some(&frozen),
                        "desktop",
                        inventory
                    )
                )
                .unwrap(),
            super::super::StorageComponentDirectory::Published(_)
        ));
        let bound = f.bind(&frozen);
        let completed = f.apply(&bound);
        verify_browser_cache(&f.plan, &completed).unwrap();
        assert!(completed.retained_entry_identity.is_none());
        let source = open_source_partition(&f.plan).unwrap().unwrap();
        assert_eq!(
            source_fact(
                &source.open_entry_handle(OsStr::new(CACHE)).unwrap(),
                &f.paths
            )
            .unwrap(),
            frozen.source.clone().unwrap()
        );
        assert_eq!(native.directory_identity().unwrap(), native_identity);
        assert_eq!(
            PrivateDirectory::open_existing(&f.plan.target.data_root)
                .unwrap()
                .directory_identity()
                .unwrap(),
            native_identity
        );
        assert_eq!(
            native
                .open_entry_handle(OsStr::new("settings.json"))
                .unwrap()
                .identity()
                .unwrap(),
            settings_identity
        );
        assert_eq!(
            fs::read(f.plan.target.data_root.join("settings.json")).unwrap(),
            b"{}"
        );
        assert_eq!(
            fs::read(f.paths.partition.join("Cookies")).unwrap(),
            b"owned-cookie"
        );
        assert_eq!(
            fs::read(f.paths.partition.join("Local Storage/draft")).unwrap(),
            b"unsent-draft"
        );
        assert_eq!(
            fs::read(f.paths.partition.join("persistent/Cache/keep")).unwrap(),
            b"business-not-http-cache"
        );
        assert!(fs::read_dir(&f.paths.http).unwrap().next().is_none());
        assert!(!f.paths.source_partition.join(&f.paths.retained).exists());
        f.assert_markers();
    }
}

#[test]
fn legacy_desktop_cache_rejects_missing_wrong_or_ambiguous_component_mappings() {
    let mut f = legacy_desktop_in_place_fixture(true);
    f.ordinary_cache();
    let frozen = f.prepare();
    assert!(browser_cache_copy_exclusions(&f.plan, Some(&frozen), "gateway").is_err());
    for invalid in ["missing", "wrong-destination", "duplicate"] {
        let mut plan = f.plan.clone();
        match invalid {
            "missing" => plan
                .components
                .retain(|component| component.domain != "desktop"),
            "wrong-destination" => {
                plan.components
                    .iter_mut()
                    .find(|component| component.domain == "desktop")
                    .unwrap()
                    .destination = plan.target.data_root.join("studio/unrelated")
            }
            _ => {
                let component = plan
                    .components
                    .iter()
                    .find(|component| component.domain == "desktop")
                    .unwrap()
                    .clone();
                plan.components.push(component);
            }
        }
        assert!(browser_cache_copy_exclusions(&plan, Some(&frozen), "desktop").is_err());
    }
    assert!(!f.paths.partition.exists());
    assert_eq!(
        fs::read(f.paths.source_partition.join("Cache/keep")).unwrap(),
        b"old-http-cache"
    );
    assert_eq!(
        fs::read(f.plan.target.data_root.join("settings.json")).unwrap(),
        b"{}"
    );
    f.assert_markers();
}

#[test]
fn legacy_gateway_only_keeps_missing_desktop_absent_without_publication_proof() {
    let mut f = legacy_desktop_in_place_fixture(false);
    let native = PrivateDirectory::open_existing(&f.plan.from.data_root).unwrap();
    let identity = native.directory_identity().unwrap();
    assert!(!f.plan.from.desktop_root.exists());
    assert!(
        f.plan
            .components
            .iter()
            .all(|component| component.domain != "desktop")
    );
    preview_browser_cache(&f.plan).unwrap();
    f.stopped();
    assert!(
        prepare_browser_cache(&mut f.coordinator, &f.plan.operation_id)
            .unwrap()
            .is_none()
    );
    verify_no_browser_cache(&f.plan).unwrap();
    f.coordinator
        .prepare_source_retirements(&f.plan.operation_id)
        .unwrap();
    assert!(matches!(
        f.coordinator
            .publish_component(&f.plan.operation_id, "gateway", &BTreeSet::new())
            .unwrap(),
        super::super::StorageComponentDirectory::Published(_)
    ));
    verify_no_browser_cache(&f.plan).unwrap();
    let receipt = f.coordinator.current().unwrap().unwrap();
    assert!(!receipt.owner_receipts.contains_key(BROWSER_CACHE_OWNER));
    assert!(!receipt.owner_receipts.contains_key("publish-desktop"));
    assert!(!f.plan.from.desktop_root.exists());
    assert!(!f.paths.partition.exists());
    assert!(!f.paths.http.exists());
    assert_eq!(
        fs::read(f.plan.target.data_root.join("studio/gateway/servers.json")).unwrap(),
        b"legacy-gateway-data"
    );
    assert_eq!(native.directory_identity().unwrap(), identity);
    assert_eq!(
        fs::read(f.plan.target.data_root.join("settings.json")).unwrap(),
        b"{}"
    );
}

#[test]
fn legacy_desktop_source_file_or_link_is_not_treated_as_a_missing_profile() {
    for kind in ["file", "link"] {
        let f = legacy_desktop_in_place_fixture(false);
        let parent =
            PrivateDirectory::open_config_root(f.plan.from.desktop_root.parent().unwrap()).unwrap();
        let name = f.plan.from.desktop_root.file_name().unwrap();
        if kind == "link" {
            parent
                .create_directory_link(name, &f.plan.from.gateway_root)
                .unwrap();
        } else {
            parent
                .atomic_replace(name, b"unknown-desktop-source")
                .unwrap();
        }
        assert!(open_source_partition(&f.plan).is_err());
        assert!(preview_browser_cache(&f.plan).is_err());
        assert!(!f.paths.partition.exists());
        assert!(!f.paths.http.exists());
        assert_eq!(
            fs::read(f.plan.from.gateway_root.join("servers.json")).unwrap(),
            b"legacy-gateway-data"
        );
    }
}
