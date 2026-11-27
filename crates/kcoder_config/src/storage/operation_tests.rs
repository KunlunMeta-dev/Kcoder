use super::*;
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationDisposition as Disposition,
    StorageMigrationPhase as Phase,
};
use std::{fs, path::Path, time::Duration};

struct Fixture {
    data: std::path::PathBuf,
    old_cache: std::path::PathBuf,
    selected_cache: std::path::PathBuf,
    record_bytes: Vec<u8>,
    settings_bytes: Vec<u8>,
}

fn fixture(home: &Path) -> Fixture {
    let control = home.join(".config");
    let data = home.join("data-root");
    let old_cache = home.join("old-cache");
    let selected_cache = home.join("selected-cache");
    for path in [&control, &data, &old_cache, &selected_cache] {
        fs::create_dir_all(path).unwrap();
    }
    let settings_bytes = br#"{"dataId":"original-data-id","theme":"dark"}"#.to_vec();
    fs::write(data.join("settings.json"), &settings_bytes).unwrap();
    fs::write(data.join(".data-id"), b"original-data-id").unwrap();
    fs::write(old_cache.join("rebuildable.bin"), b"old-cache-only").unwrap();
    let record = StorageLocationRecord {
        version: 1,
        revision: 7,
        data_root: data.clone(),
        cache_root: old_cache.clone(),
        operation_id: None,
    };
    let record_bytes = serde_json::to_vec_pretty(&record).unwrap();
    fs::write(storage_location_file(home), &record_bytes).unwrap();
    Fixture {
        data,
        old_cache,
        selected_cache,
        record_bytes,
        settings_bytes,
    }
}

fn plan(home: &Path, cache: &Path, id: &str) -> kcoder_types::StorageMigrationPlan {
    let data = read_storage_location_record(&storage_location_file(home))
        .unwrap()
        .unwrap()
        .data_root;
    prepare_storage_plan(home, &data, cache, id, StorageLaunchIntent::Cli)
        .unwrap()
        .unwrap()
}

#[test]
fn planning_is_read_only_and_same_unified_roots_are_a_noop() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let location = storage_location_file(owned.path());

    let proposed = prepare_storage_plan(
        owned.path(),
        &fixture.data,
        &fixture.selected_cache,
        "cache-only-1",
        StorageLaunchIntent::Cli,
    )
    .unwrap()
    .unwrap();
    assert_eq!(fs::read(&location).unwrap(), fixture.record_bytes);
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert_eq!(
        fs::read(fixture.old_cache.join("rebuildable.bin")).unwrap(),
        b"old-cache-only"
    );
    assert!(
        fs::read_dir(&fixture.selected_cache)
            .unwrap()
            .next()
            .is_none()
    );
    assert_eq!(
        fs::read_dir(owned.path().join(".config")).unwrap().count(),
        1
    );
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
    assert_eq!(proposed.operation_id, "cache-only-1");
    assert_eq!(proposed.original.as_ref().unwrap().revision, 7);
    assert_eq!(proposed.target.revision, 8);
    assert_eq!(proposed.target.data_root, fixture.data);
    assert_eq!(proposed.target.cache_root, fixture.selected_cache);
    assert_eq!(proposed.components.len(), 1);
    assert_eq!(proposed.components[0].domain, "persistent-root");
    assert_eq!(
        proposed.components[0].source,
        proposed.components[0].destination
    );
    assert!(!proposed.components[0].source_identity.is_empty());

    assert!(
        prepare_storage_plan(
            owned.path(),
            &fixture.data,
            &fixture.old_cache,
            "same-roots",
            StorageLaunchIntent::Cli,
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(fs::read(&location).unwrap(), fixture.record_bytes);
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
    assert_eq!(
        fs::read_dir(owned.path().join(".config")).unwrap().count(),
        1
    );
}

#[test]
fn changed_persistent_root_and_legacy_layout_are_explicitly_unsupported() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let other_data = owned.path().join("other-data");
    fs::create_dir(&other_data).unwrap();
    assert_eq!(
        prepare_storage_plan(
            owned.path(),
            &other_data,
            &fixture.selected_cache,
            "data-root-change",
            StorageLaunchIntent::Cli,
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );

    fs::remove_file(storage_location_file(owned.path())).unwrap();
    let legacy_data = owned.path().join(".config/kcoder");
    assert_eq!(
        prepare_storage_plan(
            owned.path(),
            &legacy_data,
            &fixture.selected_cache,
            "legacy-cache-change",
            StorageLaunchIntent::Cli,
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );
    assert!(!storage_location_file(owned.path()).exists());
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
}

#[test]
fn nonempty_cache_target_is_rejected_without_touching_source_or_selection() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let marker = fixture.selected_cache.join("keep.bin");
    fs::write(&marker, b"user data").unwrap();

    assert_eq!(
        prepare_storage_plan(
            owned.path(),
            &fixture.data,
            &fixture.selected_cache,
            "nonempty-target",
            StorageLaunchIntent::Cli,
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_TARGET_NOT_EMPTY"
    );
    assert_eq!(fs::read(&marker).unwrap(), b"user data");
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
}

#[test]
fn active_writer_blocks_stopped_phase_without_committing_or_creating_cache_contents() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let operation = plan(owned.path(), &fixture.selected_cache, "writer-active");
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(owned.path().to_owned()),
        record: operation.original.clone(),
        ..Default::default()
    })
    .unwrap();
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();
    drop(coordinator);
    assert_eq!(
        execute_storage_operation(
            owned.path(),
            "writer-active",
            &std::env::current_exe().unwrap(),
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    let receipt = read_storage_migration(owned.path()).unwrap().unwrap();
    assert_eq!(receipt.phase, Phase::Stopping);
    assert_eq!(receipt.disposition, Disposition::Deferred);
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(
        fs::read_dir(&fixture.selected_cache)
            .unwrap()
            .next()
            .is_none()
    );
    drop(writer);
}

#[test]
fn cache_only_real_owner_validates_its_original_pending_control_through_completion() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let id = "cache-pending-owner";
    let operation = plan(owned.path(), &fixture.selected_cache, id);
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    let stopped = coordinator
        .advance(id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    assert!(
        stopped
            .owner_receipts
            .contains_key("pending-persistent-root")
    );
    let pending = fixture.data.join("kcoder-storage-pending.json");
    let pending_bytes = fs::read(&pending).unwrap();
    coordinator.prepare_offline_child_fences(id).unwrap();
    let mut owner = BrowserCacheOperation::new(owned.path());
    owner.validate(&stopped).unwrap();
    assert_eq!(coordinator.current().unwrap().unwrap(), stopped);
    assert_eq!(fs::read(&pending).unwrap(), pending_bytes);
    coordinator
        .advance(id, Phase::Stopped, Phase::Copying)
        .unwrap();
    owner.copy_and_relocate(&mut coordinator, id).unwrap();
    for (before, after) in [
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        let receipt = coordinator.advance(id, before, after).unwrap();
        owner.validate(&receipt).unwrap();
        assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
        assert_eq!(fs::read(&pending).unwrap(), pending_bytes);
        assert_eq!(
            fs::read(storage_location_file(owned.path())).unwrap(),
            fixture.record_bytes
        );
    }
    coordinator.commit(id).unwrap();
    let verified = verify_committed_storage_target(owned.path(), id).unwrap();
    assert_eq!(verified.data_root, fixture.data);
    let completed = coordinator.complete(id).unwrap();
    assert_eq!(completed.disposition, Disposition::Complete);
    assert!(!pending.exists());
    assert!(
        completed
            .owner_receipts
            .contains_key("pending-persistent-root")
    );
    owner.validate(&completed).unwrap();
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert_eq!(
        fs::read(fixture.old_cache.join("rebuildable.bin")).unwrap(),
        b"old-cache-only"
    );
}

#[test]
fn cache_only_real_owner_rejects_unknown_owners_and_replaced_pending_controls() {
    for damage in [
        "unknown-owner",
        "unknown-pending-domain",
        "proof",
        "replacement",
    ] {
        let owned = tempfile::tempdir().unwrap();
        let fixture = fixture(owned.path());
        let id = "cache-pending-rejected";
        let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        coordinator
            .begin(plan(owned.path(), &fixture.selected_cache, id))
            .unwrap();
        coordinator
            .advance(id, Phase::Planned, Phase::Stopping)
            .unwrap();
        let mut receipt = coordinator
            .advance(id, Phase::Stopping, Phase::Stopped)
            .unwrap();
        let original = receipt.clone();
        let root = crate::PrivateDirectory::open_existing(&fixture.data).unwrap();
        let leaf = std::ffi::OsStr::new("kcoder-storage-pending.json");
        let held = root.open_single_link_regular_file(leaf).unwrap();
        let bytes = fs::read(fixture.data.join(leaf)).unwrap();
        let expected = match damage {
            "unknown-owner" | "unknown-pending-domain" => {
                let key = if damage == "unknown-owner" {
                    "unowned-domain"
                } else {
                    "pending-unowned-domain"
                };
                receipt
                    .owner_receipts
                    .insert(key.into(), serde_json::json!({}));
                "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
            }
            "proof" => {
                receipt.owner_receipts.insert(
                    "pending-persistent-root".into(),
                    serde_json::json!({"identity":"unowned-file"}),
                );
                "STORAGE_MIGRATION_PENDING"
            }
            "replacement" => {
                root.atomic_replace(leaf, &bytes).unwrap();
                "STORAGE_MIGRATION_PENDING"
            }
            _ => unreachable!(),
        };
        assert_eq!(
            BrowserCacheOperation::new(owned.path())
                .validate(&receipt)
                .unwrap_err()
                .to_string(),
            expected,
            "{damage}"
        );
        assert_eq!(coordinator.current().unwrap().unwrap(), original);
        assert_eq!(fs::read(fixture.data.join(leaf)).unwrap(), bytes);
        assert!(held.metadata().unwrap().is_file());
        assert_eq!(
            fs::read(storage_location_file(owned.path())).unwrap(),
            fixture.record_bytes
        );
    }
}

#[test]
fn wait_for_stopped_requires_writer_exclusivity_and_reuses_the_operation_id() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let operation = plan(owned.path(), &fixture.selected_cache, "wait-for-stopped");
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(owned.path().to_owned()),
        record: operation.original.clone(),
        ..Default::default()
    })
    .unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();

    let error = coordinator
        .wait_for_stopped("wait-for-stopped", Duration::from_millis(50))
        .unwrap_err();
    assert_eq!(error.to_string(), "STORAGE_STOP_TIMEOUT");
    let waiting = read_storage_migration(owned.path()).unwrap().unwrap();
    assert_eq!(waiting.plan.operation_id, "wait-for-stopped");
    assert_eq!(waiting.phase, Phase::Stopping);
    assert_eq!(waiting.disposition, Disposition::Active);
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(
        fs::read_dir(&fixture.selected_cache)
            .unwrap()
            .next()
            .is_none()
    );

    drop(writer);
    let stopped = coordinator
        .wait_for_stopped("wait-for-stopped", Duration::from_millis(500))
        .unwrap();
    assert_eq!(stopped.plan.operation_id, "wait-for-stopped");
    assert_eq!(stopped.phase, Phase::Stopped);
    assert_eq!(stopped.disposition, Disposition::Active);
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert!(!fixture.selected_cache.join("rebuildable.bin").exists());
}

#[test]
fn replacing_frozen_target_ancestor_defers_the_same_operation_before_commit() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let parent = owned.path().join("new-cache-parent");
    fs::create_dir(&parent).unwrap();
    let cache = parent.join("cache");
    let operation = prepare_storage_plan(
        owned.path(),
        &fixture.data,
        &cache,
        "ancestor-replaced",
        StorageLaunchIntent::Cli,
    )
    .unwrap()
    .unwrap();
    assert!(
        operation
            .target_bindings
            .iter()
            .any(|binding| { binding.path == cache && binding.existing_ancestor == parent })
    );
    let original_identity = operation
        .target_bindings
        .iter()
        .find(|binding| binding.path == cache)
        .unwrap()
        .ancestor_identity
        .clone();
    let displaced = owned.path().join("displaced-cache-parent");
    fs::rename(&parent, &displaced).unwrap();
    fs::create_dir(&parent).unwrap();

    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();
    drop(coordinator);
    let failure = execute_storage_operation(
        owned.path(),
        "ancestor-replaced",
        &std::env::current_exe().unwrap(),
    )
    .unwrap_err();
    assert_eq!(failure.to_string(), "STORAGE_TARGET_CHANGED");
    let receipt = read_storage_migration(owned.path()).unwrap().unwrap();
    assert_eq!(receipt.plan.operation_id, "ancestor-replaced");
    assert_eq!(receipt.phase, Phase::Planned);
    assert_eq!(receipt.disposition, Disposition::Deferred);
    assert_eq!(
        receipt
            .plan
            .target_bindings
            .iter()
            .find(|binding| binding.path == cache)
            .unwrap()
            .ancestor_identity,
        original_identity
    );
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(!cache.exists());
}

#[test]
fn stale_location_revision_rejects_the_frozen_plan_without_creating_an_operation() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let operation = plan(owned.path(), &fixture.selected_cache, "stale-revision");
    let changed = StorageLocationRecord {
        revision: 8,
        ..operation.original.clone().unwrap()
    };
    let changed_bytes = serde_json::to_vec_pretty(&changed).unwrap();
    fs::write(storage_location_file(owned.path()), &changed_bytes).unwrap();

    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    assert_eq!(
        coordinator.begin(operation).unwrap_err().to_string(),
        "STORAGE_SELECTION_CHANGED"
    );
    drop(coordinator);
    assert_eq!(
        fs::read(&storage_location_file(owned.path())).unwrap(),
        changed_bytes
    );
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(
        fs::read_dir(&fixture.selected_cache)
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn composed_owner_validation_blocks_selection_without_replaying_completed_owner_effects() {
    struct Owner {
        effects: usize,
    }
    impl StorageOperationOwner for Owner {
        fn validate(&self, receipt: &kcoder_types::StorageMigrationReceipt) -> anyhow::Result<()> {
            anyhow::ensure!(receipt.phase != Phase::Prepared, "OWNED_TARGET_REJECTED");
            Ok(())
        }
        fn copy_and_relocate(
            &mut self,
            coordinator: &mut StorageCoordinator,
            id: &str,
        ) -> anyhow::Result<()> {
            let receipt = coordinator.current()?.unwrap();
            assert_eq!(receipt.phase, Phase::Copying);
            assert!(!receipt.owner_receipts.contains_key("owned-fixture"));
            coordinator.record_owner_receipt(
                id,
                "owned-fixture",
                None,
                serde_json::json!({"effect":"recorded"}),
            )?;
            self.effects += 1;
            Ok(())
        }
        fn reconcile_failure(
            &mut self,
            coordinator: &mut StorageCoordinator,
            _: &str,
        ) -> anyhow::Result<()> {
            // Target cleanup has not been confirmed. Keep the original active job.
            assert_eq!(
                coordinator.current()?.unwrap().disposition,
                Disposition::Active
            );
            Ok(())
        }
    }
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let id = "composed-owner";
    let operation = plan(owned.path(), &fixture.selected_cache, id);
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();
    drop(coordinator);
    let mut owner = Owner { effects: 0 };
    for _ in 0..2 {
        assert_eq!(
            execute_storage_operation_with_owner(
                owned.path(),
                id,
                &owned.path().join("must-not-spawn-verifier"),
                &mut owner
            )
            .unwrap_err()
            .to_string(),
            "OWNED_TARGET_REJECTED"
        );
        let receipt = read_storage_migration(owned.path()).unwrap().unwrap();
        assert_eq!(receipt.plan.operation_id, id);
        assert_eq!(receipt.phase, Phase::Prepared);
        assert_eq!(receipt.disposition, Disposition::Active);
        assert_eq!(owner.effects, 1);
        assert_eq!(
            fs::read(storage_location_file(owned.path())).unwrap(),
            fixture.record_bytes
        );
        assert_eq!(
            fs::read(fixture.data.join("settings.json")).unwrap(),
            fixture.settings_bytes
        );
        assert!(StorageStartupLease::acquire(owned.path()).is_err());
    }
}

#[test]
fn moving_data_requires_host_owner_admission_without_changing_the_selected_roots() {
    struct Admission(bool);
    impl StorageOperationOwner for Admission {
        fn validate(&self, receipt: &kcoder_types::StorageMigrationReceipt) -> anyhow::Result<()> {
            assert_eq!(receipt.phase, Phase::Planned);
            assert!(receipt.owner_receipts.is_empty());
            anyhow::ensure!(self.0, "OWNED_PROFILE_UNSUPPORTED");
            Ok(())
        }
        fn copy_and_relocate(&mut self, _: &mut StorageCoordinator, _: &str) -> anyhow::Result<()> {
            panic!("a preview must not enter an owner transaction")
        }
        fn reconcile_failure(&mut self, _: &mut StorageCoordinator, _: &str) -> anyhow::Result<()> {
            panic!("a rejected preview must not create or settle an operation")
        }
    }
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let target = owned.path().join("new-data-root");
    let proposed = |owner: &Admission| {
        prepare_storage_plan_with_owner(
            owned.path(),
            &target,
            &fixture.selected_cache,
            "owned-profile-plan",
            StorageLaunchIntent::VerifyOnly,
            owner,
        )
    };
    assert_eq!(
        proposed(&Admission(false)).unwrap_err().to_string(),
        "OWNED_PROFILE_UNSUPPORTED"
    );
    assert_eq!(
        prepare_storage_plan(
            owned.path(),
            &target,
            &fixture.selected_cache,
            "owned-profile-plan",
            StorageLaunchIntent::VerifyOnly,
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );
    let admitted = proposed(&Admission(true)).unwrap().unwrap();
    assert_eq!(admitted.target.revision, 8);
    assert_eq!(admitted.target.data_root, target);
    assert_eq!(admitted.components[0].source, fixture.data);
    assert_eq!(
        admitted.components[0].destination,
        admitted.target.data_root
    );
    assert_eq!(admitted.target_bindings.len(), 2);
    assert_eq!(
        fs::read(storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        fixture.settings_bytes
    );
    assert!(!target.exists());
    assert!(
        fs::read_dir(fixture.selected_cache)
            .unwrap()
            .next()
            .is_none()
    );
    assert!(
        !owned
            .path()
            .join(".config/kcoder-storage-migrations")
            .exists()
    );
    assert!(read_storage_migration(owned.path()).unwrap().is_none());
}

#[test]
fn offline_step_error_preserves_active_copying_and_redacts_sensitive_tail() {
    struct Owner {
        failure: &'static str,
        code: &'static str,
        reconciled: bool,
    }
    impl StorageOperationOwner for Owner {
        fn validate(&self, _: &kcoder_types::StorageMigrationReceipt) -> anyhow::Result<()> {
            Ok(())
        }
        fn copy_and_relocate(
            &mut self,
            coordinator: &mut StorageCoordinator,
            id: &str,
        ) -> anyhow::Result<()> {
            coordinator.record_owner_receipt(
                id,
                "owned-fixture",
                None,
                serde_json::json!({"effect":"recorded"}),
            )?;
            anyhow::bail!("{}", self.failure)
        }
        fn reconcile_failure(
            &mut self,
            coordinator: &mut StorageCoordinator,
            _: &str,
        ) -> anyhow::Result<()> {
            let receipt = coordinator.current()?.unwrap();
            assert_eq!(receipt.error_code.as_deref(), Some(self.code));
            self.reconciled = true;
            Ok(())
        }
    }
    for (failure, code) in [
        (
            "STORAGE_TARGET_CHANGED: token=fixture-secret path=/private/fixture",
            "STORAGE_TARGET_CHANGED",
        ),
        (
            "PRIVATE_FAILURE: token=fixture-secret path=/private/fixture",
            "STORAGE_OFFLINE_STEP_FAILED",
        ),
    ] {
        let owned = tempfile::tempdir().unwrap();
        let fixture = fixture(owned.path());
        let id = "copy-step-error";
        let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        coordinator
            .begin(plan(owned.path(), &fixture.selected_cache, id))
            .unwrap();
        drop(coordinator);
        let mut owner = Owner {
            failure,
            code,
            reconciled: false,
        };
        assert!(
            execute_storage_operation_with_owner(
                owned.path(),
                id,
                &owned.path().join("must-not-spawn-verifier"),
                &mut owner,
            )
            .is_err()
        );
        assert!(owner.reconciled);
        let receipt = read_storage_migration(owned.path()).unwrap().unwrap();
        assert_eq!(receipt.plan.operation_id, id);
        assert_eq!(receipt.phase, Phase::Copying);
        assert_eq!(receipt.disposition, Disposition::Active);
        assert_eq!(receipt.error_code.as_deref(), Some(code));
        assert_eq!(
            receipt.owner_receipts["owned-fixture"],
            serde_json::json!({"effect":"recorded"})
        );
        let archive = fs::read_to_string(
            owned
                .path()
                .join(".config/kcoder-storage-migrations")
                .join(id)
                .join("receipt.json"),
        )
        .unwrap();
        assert!(!archive.contains("fixture-secret"));
        assert!(!archive.contains("/private/fixture"));
        assert_eq!(
            fs::read(storage_location_file(owned.path())).unwrap(),
            fixture.record_bytes
        );
    }
}

#[test]
fn offline_step_error_is_idempotent_and_clears_on_success() {
    let owned = tempfile::tempdir().unwrap();
    let fixture = fixture(owned.path());
    let id = "step-error-recovery";
    let operation = plan(owned.path(), &fixture.selected_cache, id);
    let target = operation.target.clone();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(operation).unwrap();
    for (before, after) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(id, before, after).unwrap();
    }
    let recorded = coordinator
        .record_step_error(id, "STORAGE_TARGET_CHANGED")
        .unwrap();
    let archive = owned
        .path()
        .join(".config/kcoder-storage-migrations")
        .join(id);
    let directory = crate::PrivateDirectory::open_existing(&archive).unwrap();
    let original = directory
        .open_entry_handle(std::ffi::OsStr::new("receipt.json"))
        .unwrap();
    let identity = original.identity().unwrap();
    let bytes = fs::read(archive.join("receipt.json")).unwrap();
    assert_eq!(
        coordinator
            .record_step_error(id, "STORAGE_TARGET_CHANGED")
            .unwrap(),
        recorded
    );
    assert_eq!(
        coordinator
            .record_step_error("different-operation", "STORAGE_TARGET_CHANGED")
            .unwrap_err()
            .to_string(),
        "STORAGE_OPERATION_CONFLICT"
    );
    assert_eq!(
        directory
            .open_entry_handle(std::ffi::OsStr::new("receipt.json"))
            .unwrap()
            .identity()
            .unwrap(),
        identity
    );
    assert_eq!(fs::read(archive.join("receipt.json")).unwrap(), bytes);
    assert_eq!(coordinator.current().unwrap().unwrap(), recorded);
    assert!(
        !archive
            .parent()
            .unwrap()
            .join("different-operation")
            .exists()
    );
    assert_eq!(
        fs::read(storage_location_file(owned.path())).unwrap(),
        fixture.record_bytes
    );
    drop(original);

    assert!(
        coordinator
            .advance(id, Phase::Copying, Phase::Verifying)
            .unwrap()
            .error_code
            .is_none()
    );
    coordinator
        .advance(id, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator
        .record_step_error(id, "STORAGE_TARGET_CHANGED")
        .unwrap();
    let committed = coordinator.commit(id).unwrap();
    assert_eq!(committed.phase, Phase::Committed);
    assert!(committed.error_code.is_none());
    coordinator
        .record_step_error(id, "STORAGE_TARGET_CHANGED")
        .unwrap();
    let complete = coordinator.complete(id).unwrap();
    assert_eq!(complete.phase, Phase::Verified);
    assert_eq!(complete.disposition, Disposition::Complete);
    assert!(complete.error_code.is_none());
    assert_eq!(
        read_storage_location_record(&storage_location_file(owned.path())).unwrap(),
        Some(target)
    );
}
