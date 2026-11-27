use super::*;
use kcoder_types::{
    StorageLaunchIntent, StorageMigrationDisposition as Disposition,
    StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use std::{fs, process::Command};

fn plan(
    home: &std::path::Path,
    id: &str,
    original: Option<StorageLocationRecord>,
) -> StorageMigrationPlan {
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.to_owned()),
        record: original.clone(),
        ..Default::default()
    })
    .unwrap();
    StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        target: StorageLocationRecord {
            version: 1,
            revision: original.as_ref().map_or(1, |record| record.revision + 1),
            data_root: home.join(format!("Data-{id}")),
            cache_root: home.join(format!("Cache-{id}")),
            operation_id: Some(id.into()),
        },
        original,
        from,
        components: vec![],
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    }
}

fn prepare(coordinator: &mut StorageCoordinator, id: &str) {
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        coordinator.advance(id, from, to).unwrap();
    }
}

#[test]
fn planning_with_live_instances_never_claims_stop_or_starts_copying() {
    let owned = tempfile::tempdir().unwrap();
    assert_eq!(read_storage_migration(owned.path()).unwrap(), None);
    assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
    let business = StorageStartupLease::acquire(owned.path()).unwrap();
    let peer = StorageStartupLease::acquire(owned.path()).unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan(owned.path(), "live", None)).unwrap();
    coordinator
        .advance("live", Phase::Planned, Phase::Stopping)
        .unwrap();
    assert!(StorageStartupLease::acquire(owned.path()).is_err());
    assert!(StorageCoordinator::acquire(owned.path()).is_err());
    for business in [business, peer] {
        assert_eq!(
            coordinator
                .advance("live", Phase::Stopping, Phase::Stopped)
                .unwrap_err()
                .to_string(),
            "STORAGE_WRITERS_ACTIVE"
        );
        assert_eq!(
            coordinator.current().unwrap().unwrap().phase,
            Phase::Stopping
        );
        assert!(!owned.path().join("Data-live").exists());
        drop(business);
    }
    coordinator
        .advance("live", Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
        .advance("live", Phase::Stopped, Phase::Copying)
        .unwrap();
    assert!(StorageStartupLease::acquire(owned.path()).is_err());
    coordinator
        .defer_after_cleanup("live", "STORAGE_COPY_FAILED")
        .unwrap();
    drop(coordinator);
    assert!(StorageStartupLease::acquire(owned.path()).is_ok());
}

#[test]
fn cross_process_lease_excludes_copy_but_allows_stop_registration() {
    const PROBE: &str = "KCODER_STORAGE_TEST_PROBE_HOME";
    if let Some(home) = std::env::var_os(PROBE) {
        let home = std::path::Path::new(&home);
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        coordinator
            .begin(plan(home, "cross-process", None))
            .unwrap();
        coordinator
            .advance("cross-process", Phase::Planned, Phase::Stopping)
            .unwrap();
        assert_eq!(
            coordinator
                .advance("cross-process", Phase::Stopping, Phase::Stopped)
                .unwrap_err()
                .to_string(),
            "STORAGE_WRITERS_ACTIVE"
        );
        assert_eq!(
            coordinator.current().unwrap().unwrap().phase,
            Phase::Stopping
        );
        return;
    }
    let owned = tempfile::tempdir().unwrap();
    let business = StorageStartupLease::acquire(owned.path()).unwrap();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "storage::control_tests::cross_process_lease_excludes_copy_but_allows_stop_registration", "--nocapture"])
        .env(PROBE, owned.path()).output().unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    drop(business);
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator
        .advance("cross-process", Phase::Stopping, Phase::Stopped)
        .unwrap();
}

#[test]
fn an_explicit_same_root_writer_blocks_copy_without_reading_personal_selection() {
    const PROBE: &str = "KCODER_STORAGE_EXPLICIT_WRITER_TEST_HOME";
    if let Some(home) = std::env::var_os(PROBE) {
        let home = std::path::Path::new(&home);
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        coordinator
            .begin(plan(home, "explicit-writer", None))
            .unwrap();
        coordinator
            .advance("explicit-writer", Phase::Planned, Phase::Stopping)
            .unwrap();
        assert_eq!(
            coordinator
                .advance("explicit-writer", Phase::Stopping, Phase::Stopped)
                .unwrap_err()
                .to_string(),
            "STORAGE_WRITERS_ACTIVE"
        );
        assert_eq!(
            coordinator.current().unwrap().unwrap().phase,
            Phase::Stopping
        );
        return;
    }
    let owned = tempfile::tempdir().unwrap();
    let from = plan(owned.path(), "unused", None).from;
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(owned.path().to_owned()),
        env: BTreeMap::from([(
            "KCODER_HOME".into(),
            from.data_root.clone().into_os_string(),
        )]),
        ..Default::default()
    })
    .unwrap();
    assert!(!owned.path().join(".config/kcoder-storage.lock").exists());
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "storage::control_tests::an_explicit_same_root_writer_blocks_copy_without_reading_personal_selection", "--nocapture"])
        .env(PROBE, owned.path()).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    drop(writer);
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator
        .advance("explicit-writer", Phase::Stopping, Phase::Stopped)
        .unwrap();
    assert!(
        StorageInstance::open(StorageResolveInput {
            home: Some(owned.path().to_owned()),
            env: BTreeMap::from([("KCODER_HOME".into(), from.data_root.into_os_string())]),
            ..Default::default()
        })
        .is_err(),
        "explicit startup cannot reopen a stopped source"
    );
    assert!(!owned.path().join("Data-explicit-writer").exists());
}

#[test]
fn an_existing_target_writer_cannot_be_adopted_as_an_empty_migration_target() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "target-writer", None);
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(owned.path().to_owned()),
        env: BTreeMap::from([(
            "KCODER_HOME".into(),
            plan.target.data_root.clone().into_os_string(),
        )]),
        ..Default::default()
    })
    .unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan).unwrap();
    coordinator
        .advance("target-writer", Phase::Planned, Phase::Stopping)
        .unwrap();
    assert_eq!(
        coordinator
            .advance("target-writer", Phase::Stopping, Phase::Stopped)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    drop(writer);
    coordinator
        .advance("target-writer", Phase::Stopping, Phase::Stopped)
        .unwrap();
}

#[test]
fn owner_receipts_do_not_register_new_target_subdirectories_after_stop() {
    let owned = tempfile::tempdir().unwrap();
    let id = "frozen-target-fences";
    let plan = plan(owned.path(), id, None);
    fs::create_dir_all(&plan.from.data_root).unwrap();
    fs::create_dir(&plan.target.data_root).unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(id, from, to).unwrap();
    }
    let frozen_fences = coordinator.held_writer_fence_identities(id).unwrap();
    assert!(!plan.target.data_root.join("studio").exists());

    // These payload directories appear only after the copier froze its fences.
    let targets = [
        plan.target.data_root.join("studio/gateway"),
        plan.target.data_root.join("studio/desktop"),
    ];
    for target in &targets {
        fs::create_dir_all(target).unwrap();
        fs::write(target.join("persistent.json"), b"preserve copied payload").unwrap();
    }
    coordinator
        .record_owner_receipt(
            id,
            "copy-progress",
            None,
            serde_json::json!({ "phase": "copied" }),
        )
        .unwrap();
    for target in &targets {
        assert_eq!(fs::read_dir(target).unwrap().count(), 1);
        assert_eq!(
            fs::read(target.join("persistent.json")).unwrap(),
            b"preserve copied payload"
        );
    }
    assert_eq!(
        coordinator.held_writer_fence_identities(id).unwrap(),
        frozen_fences
    );
}

#[cfg(unix)]
#[test]
fn stopped_sources_keep_the_original_writer_lock_identity() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "root-replacement", None);
    fs::create_dir_all(&plan.from.data_root).unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance("root-replacement", Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance("root-replacement", Phase::Stopping, Phase::Stopped)
        .unwrap();
    let lock = plan.from.data_root.join(super::writers::WRITERS);
    fs::rename(&lock, plan.from.data_root.join("original-writers-lock")).unwrap();
    fs::write(lock, b"").unwrap();
    assert_eq!(
        coordinator
            .advance("root-replacement", Phase::Stopped, Phase::Copying)
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    assert_eq!(
        read_storage_migration(owned.path()).unwrap().unwrap().phase,
        Phase::Stopped
    );
    assert!(!plan.target.data_root.exists());
}

#[test]
fn operation_is_durable_idempotent_and_blocks_startup_until_verifier_completion() {
    let owned = tempfile::tempdir().unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    let plan = plan(owned.path(), "owned-1", None);
    let receipt = coordinator.begin(plan.clone()).unwrap();
    assert_eq!(coordinator.begin(plan.clone()).unwrap(), receipt);
    let mut changed = plan.clone();
    changed.target.data_root = owned.path().join("Other");
    assert_eq!(
        coordinator.begin(changed).unwrap_err().to_string(),
        "STORAGE_OPERATION_CONFLICT"
    );
    assert!(
        coordinator
            .advance("owned-1", Phase::Planned, Phase::Copying)
            .is_err()
    );
    assert!(coordinator.commit("owned-1").is_err());
    drop(coordinator);
    assert_eq!(
        StorageStartupLease::acquire(owned.path())
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    prepare(&mut coordinator, "owned-1");
    let committed = coordinator.commit("owned-1").unwrap();
    assert_eq!(coordinator.commit("owned-1").unwrap(), committed);
    drop(coordinator);
    assert!(StorageStartupLease::acquire(owned.path()).is_err());
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    assert_eq!(
        coordinator.complete("owned-1").unwrap().disposition,
        Disposition::Complete
    );
    drop(coordinator);
    let business = StorageStartupLease::acquire(owned.path()).unwrap();
    assert_eq!(
        read_storage_location_record(&storage_location_file(owned.path()))
            .unwrap()
            .as_ref(),
        Some(&plan.target)
    );
    drop(business);
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator
        .begin(self::plan(owned.path(), "owned-2", Some(plan.target)))
        .unwrap();
    let original = read_storage_operation(owned.path(), "owned-1")
        .unwrap()
        .unwrap();
    assert_eq!(original.plan.operation_id, "owned-1");
    assert_eq!(original.disposition, Disposition::Complete);
    assert_eq!(
        read_storage_migration(owned.path())
            .unwrap()
            .unwrap()
            .plan
            .operation_id,
        "owned-2"
    );
    assert!(
        read_storage_operation(owned.path(), "not-created")
            .unwrap()
            .is_none()
    );
    assert!(
        !owned
            .path()
            .join(".config/kcoder-storage-migrations/not-created")
            .exists()
    );
    assert!(
        owned
            .path()
            .join(".config/kcoder-storage-migrations/owned-1/receipt.json")
            .exists(),
        "old cleanup evidence is retained"
    );
}

#[test]
fn original_operation_query_never_creates_control_or_accepts_an_invalid_id() {
    let owned = tempfile::tempdir().unwrap();
    assert!(
        read_storage_operation(owned.path(), "missing")
            .unwrap()
            .is_none()
    );
    assert!(read_storage_operation(owned.path(), "../other").is_err());
    assert!(fs::read_dir(owned.path()).unwrap().next().is_none());
}

#[test]
fn deferred_operation_reopens_original_only_and_requires_explicit_retry() {
    let owned = tempfile::tempdir().unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    let plan = plan(owned.path(), "owned-deferred", None);
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance(&plan.operation_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    let deferred = coordinator
        .defer_after_cleanup(&plan.operation_id, "STORAGE_STOP_TIMEOUT")
        .unwrap();
    assert_eq!(coordinator.begin(plan.clone()).unwrap(), deferred);
    drop(coordinator);
    drop(StorageStartupLease::acquire(owned.path()).unwrap());
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    assert_eq!(
        coordinator
            .retry_deferred(&plan.operation_id)
            .unwrap()
            .phase,
        Phase::Planned
    );
    drop(coordinator);
    assert!(StorageStartupLease::acquire(owned.path()).is_err());
}

#[test]
fn a_lost_selection_commit_receipt_reconciles_without_replaying_or_overwriting() {
    let owned = tempfile::tempdir().unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    let plan = plan(owned.path(), "owned-commit", None);
    coordinator.begin(plan.clone()).unwrap();
    prepare(&mut coordinator, &plan.operation_id);
    let selected = storage_location_file(owned.path());
    fs::write(&selected, serde_json::to_vec(&plan.target).unwrap()).unwrap();
    coordinator.commit(&plan.operation_id).unwrap();
    assert!(
        coordinator
            .defer_after_cleanup(&plan.operation_id, "STORAGE_VERIFY_FAILED")
            .is_err()
    );
    let mut peer = plan.target.clone();
    peer.revision += 1;
    let original = serde_json::to_vec(&peer).unwrap();
    fs::write(&selected, &original).unwrap();
    assert!(coordinator.commit(&plan.operation_id).is_err());
    assert_eq!(fs::read(&selected).unwrap(), original);
    assert!(coordinator.complete(&plan.operation_id).is_err());
}

#[test]
fn operation_ids_cannot_escape_control() {
    let owned = tempfile::tempdir().unwrap();
    fs::create_dir(owned.path().join(".config")).unwrap();
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    for id in ["..", ".", "../escape", "bad/name"] {
        assert!(coordinator.begin(plan(owned.path(), id, None)).is_err());
    }
    assert_eq!(coordinator.current().unwrap(), None);
}

#[cfg(unix)]
#[test]
fn replacing_the_control_lock_or_directory_does_not_redirect_an_operation() {
    for replacement in [
        "kcoder-storage.lock",
        "kcoder-storage-instances.lock",
        "directory",
    ] {
        let owned = tempfile::tempdir().unwrap();
        let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        let control = owned.path().join(".config");
        if replacement == "directory" {
            fs::rename(&control, owned.path().join("retained-control")).unwrap();
            fs::create_dir(&control).unwrap();
        } else {
            fs::rename(control.join(replacement), control.join("retained-lock")).unwrap();
            fs::write(control.join(replacement), b"").unwrap();
        }
        assert_eq!(
            coordinator
                .begin(plan(owned.path(), "owned-replacement", None))
                .unwrap_err()
                .to_string(),
            "STORAGE_CONTROL_CHANGED"
        );
        assert!(!control.join("kcoder-storage.json").exists());
        assert!(!control.join("kcoder-storage-migrations").exists());
    }
}

#[test]
fn a_new_operation_cannot_hide_an_inconsistent_terminal_selection() {
    for completed in [false, true] {
        let owned = tempfile::tempdir().unwrap();
        let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        let previous = plan(owned.path(), "previous", None);
        coordinator.begin(previous.clone()).unwrap();
        if completed {
            prepare(&mut coordinator, "previous");
            coordinator.commit("previous").unwrap();
            coordinator.complete("previous").unwrap();
        } else {
            coordinator
                .defer_after_cleanup("previous", "STORAGE_COPY_FAILED")
                .unwrap();
        }
        let mut inconsistent = previous.target.clone();
        inconsistent.revision += 1;
        inconsistent.operation_id = Some("unsettled".into());
        let bytes = serde_json::to_vec(&inconsistent).unwrap();
        fs::write(storage_location_file(owned.path()), &bytes).unwrap();
        let result = coordinator.begin(plan(owned.path(), "next", Some(inconsistent)));
        assert_eq!(result.unwrap_err().to_string(), "STORAGE_SELECTION_CHANGED");
        assert_eq!(
            coordinator.current().unwrap().unwrap().plan.operation_id,
            "previous"
        );
        assert_eq!(
            fs::read(storage_location_file(owned.path())).unwrap(),
            bytes
        );
        assert!(
            !owned
                .path()
                .join(".config/kcoder-storage-migrations/next")
                .exists()
        );
    }
}

#[test]
fn a_normalized_query_can_plan_from_an_original_record_with_parent_components() {
    let owned = tempfile::tempdir().unwrap();
    let coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    fs::create_dir(owned.path().join("Existing")).unwrap();
    let original = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: owned.path().join("Existing/../Data"),
        cache_root: owned.path().join("Cache"),
        operation_id: None,
    };
    let bytes = serde_json::to_vec(&original).unwrap();
    fs::write(storage_location_file(owned.path()), &bytes).unwrap();
    let next = plan(owned.path(), "normalized", Some(original));
    assert_eq!(next.from.data_root, owned.path().join("Data"));
    coordinator.begin(next).unwrap();
    assert_eq!(
        fs::read(storage_location_file(owned.path())).unwrap(),
        bytes,
        "the original CAS snapshot is preserved"
    );
}

#[test]
fn owner_inventory_rejection_precedes_manifest_and_payload_publication() {
    let owned = tempfile::tempdir().unwrap();
    let id = "checked-copy";
    let mut plan = plan(owned.path(), id, None);
    fs::create_dir_all(&plan.from.data_root).unwrap();
    fs::write(plan.from.data_root.join("persistent.txt"), b"keep").unwrap();
    fs::write(plan.from.data_root.join("cache-leaf"), b"replaced owner").unwrap();
    let source = crate::PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    let source_path = plan.from.data_root.clone();
    plan.components
        .push(kcoder_types::StorageMigrationComponent {
            domain: "native".into(),
            source: plan.from.data_root.clone(),
            destination: plan.target.data_root.clone(),
            source_identity: source.directory_identity().unwrap(),
            estimated_bytes: 4,
        });
    let stage_path = owned.path().join("Stage");
    fs::create_dir(&stage_path).unwrap();
    let stage = crate::PrivateDirectory::open_existing(&stage_path).unwrap();
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan).unwrap();
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(id, from, to).unwrap();
    }
    let exclusions = std::collections::BTreeSet::from([PathBuf::from("cache-leaf")]);
    let error = coordinator
        .copy_component_checked(id, "native", &stage, &exclusions, |inventory| {
            let entry = inventory
                .entries
                .iter()
                .find(|entry| entry.relative_path == PathBuf::from("cache-leaf"))
                .unwrap();
            assert!(entry.excluded);
            assert!(!entry.identity.is_empty());
            anyhow::bail!("OWNER_FROZEN_IDENTITY_CHANGED")
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "OWNER_FROZEN_IDENTITY_CHANGED");
    assert!(
        coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .is_empty()
    );
    assert!(fs::read_dir(stage_path).unwrap().next().is_none());
    assert_eq!(
        fs::read(source_path.join("persistent.txt")).unwrap(),
        b"keep"
    );
    assert_eq!(
        fs::read(source_path.join("cache-leaf")).unwrap(),
        b"replaced owner"
    );
}
