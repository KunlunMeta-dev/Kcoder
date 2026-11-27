//! Owned startup regressions for the original active operation's refusal scope.
use super::*;
use crate::storage::{
    StorageComponentDirectory, StorageConsumer, StorageCoordinator, StorageInstance,
    StorageLocationRecord, StorageResolveInput, read_storage_location_record,
    resolve_storage_paths, storage_location_file,
};
use kcoder_types::{
    StorageLaunchIntent, StorageMigrationComponent, StorageMigrationPhase as Phase,
    StorageMigrationPlan, StorageTargetBinding,
};
use std::{collections::BTreeMap, fs, path::PathBuf};

struct Fixture {
    owned: tempfile::TempDir,
    plan: StorageMigrationPlan,
}

impl Fixture {
    fn new(create_target: bool) -> Self {
        let owned = tempfile::tempdir().unwrap();
        let mut from = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().into()),
            ..Default::default()
        })
        .unwrap();
        from.gateway_root = from.data_root.join("studio/gateway");
        from.desktop_root = from.data_root.join("studio/desktop");
        for path in [&from.gateway_root, &from.desktop_root, &from.cache_root] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            from.data_root.join("original-payload"),
            b"preserve original business bytes",
        )
        .unwrap();
        let target = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: owned.path().join("Target"),
            cache_root: owned.path().join("Cache"),
            operation_id: Some("active-startup".into()),
        };
        if create_target {
            fs::create_dir(&target.data_root).unwrap();
        }
        fs::create_dir(&target.cache_root).unwrap();
        let ancestor = if create_target {
            target.data_root.clone()
        } else {
            owned.path().into()
        };
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: "active-startup".into(),
            original: None,
            components: vec![StorageMigrationComponent {
                domain: "native".into(),
                source: from.data_root.clone(),
                destination: target.data_root.clone(),
                source_identity: PrivateDirectory::open_existing(&from.data_root)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            target_bindings: vec![StorageTargetBinding {
                path: target.data_root.clone(),
                existing_ancestor: ancestor.clone(),
                ancestor_identity: PrivateDirectory::open_existing(&ancestor)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
            }],
            from,
            target,
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        Self { owned, plan }
    }

    fn stopped(&self) -> StorageCoordinator {
        let mut coordinator = StorageCoordinator::acquire(self.owned.path()).unwrap();
        coordinator.begin(self.plan.clone()).unwrap();
        coordinator
            .advance(&self.plan.operation_id, Phase::Planned, Phase::Stopping)
            .unwrap();
        coordinator
            .advance(&self.plan.operation_id, Phase::Stopping, Phase::Stopped)
            .unwrap();
        coordinator
    }

    fn explicit(&self, root: &Path, consumer: StorageConsumer) -> StorageResolveInput {
        StorageResolveInput {
            home: Some(self.owned.path().into()),
            consumer,
            env: BTreeMap::from([
                ("KCODER_HOME".into(), root.as_os_str().to_owned()),
                (
                    "KCODER_CACHE_DIR".into(),
                    self.owned.path().join("ExplicitCache").into_os_string(),
                ),
                ("KCODER_STUDIO_DATA_DIR".into(), root.as_os_str().to_owned()),
                (
                    "KCODER_STUDIO_DESKTOP_USER_DATA_DIR".into(),
                    root.as_os_str().to_owned(),
                ),
            ]),
            ..Default::default()
        }
    }

    fn prepare(&self, coordinator: &mut StorageCoordinator) {
        coordinator
            .prepare_source_retirements(&self.plan.operation_id)
            .unwrap();
        for (before, after) in [
            (Phase::Stopped, Phase::Copying),
            (Phase::Copying, Phase::Verifying),
            (Phase::Verifying, Phase::Prepared),
        ] {
            coordinator
                .advance(&self.plan.operation_id, before, after)
                .unwrap();
        }
    }
}

#[test]
fn explicit_target_and_nested_roles_wait_after_the_executor_is_gone_until_same_id_completion() {
    for committed in [false, true] {
        let f = Fixture::new(true);
        let mut coordinator = f.stopped();
        f.prepare(&mut coordinator);
        if committed {
            coordinator.commit(&f.plan.operation_id).unwrap();
        }
        drop(coordinator);
        for root in [
            &f.plan.target.data_root,
            &f.plan.target.data_root.join("Nested"),
        ] {
            for consumer in [
                StorageConsumer::Cli,
                StorageConsumer::Gateway,
                StorageConsumer::Desktop,
            ] {
                assert_eq!(
                    StorageInstance::open(f.explicit(root, consumer))
                        .err()
                        .unwrap()
                        .to_string(),
                    "STORAGE_MIGRATION_PENDING"
                );
                assert!(!root.join("settings.json").exists());
            }
        }
        let mut coordinator = StorageCoordinator::acquire(f.owned.path()).unwrap();
        coordinator.commit(&f.plan.operation_id).unwrap();
        coordinator.complete(&f.plan.operation_id).unwrap();
        drop(coordinator);
        drop(
            StorageInstance::open(f.explicit(&f.plan.target.data_root, StorageConsumer::Desktop))
                .unwrap(),
        );
        assert_eq!(
            fs::read(f.plan.from.data_root.join("original-payload")).unwrap(),
            b"preserve original business bytes"
        );
    }
}

#[test]
fn valid_unrelated_operations_and_deferred_jobs_keep_explicit_dev_independent_of_locator() {
    let f = Fixture::new(true);
    let coordinator = f.stopped();
    drop(coordinator);
    let locator = storage_location_file(f.owned.path());
    fs::write(&locator, b"unknown personal selection remains untouched").unwrap();
    let root = f.owned.path().join("UnrelatedDev");
    let mut input = f.explicit(&root, StorageConsumer::Gateway);
    input.development = true;
    drop(StorageInstance::open(input).unwrap());
    assert_eq!(
        fs::read(&locator).unwrap(),
        b"unknown personal selection remains untouched"
    );
    fs::remove_file(locator).unwrap();
    let mut coordinator = StorageCoordinator::acquire(f.owned.path()).unwrap();
    coordinator
        .cleanup_source_retirements(&f.plan.operation_id)
        .unwrap();
    coordinator
        .defer_after_cleanup(&f.plan.operation_id, "OWNED_CANCELLED")
        .unwrap();
    drop(coordinator);
    drop(StorageInstance::open(f.explicit(&f.plan.from.data_root, StorageConsumer::Cli)).unwrap());
}

#[test]
fn unknown_global_operation_metadata_blocks_even_unrelated_explicit_startups_without_selection_reads()
 {
    for damage in [
        "current",
        "missing-current",
        "receipt",
        "missing-receipt",
        "future-publication",
    ] {
        let f = Fixture::new(true);
        let coordinator = f.stopped();
        let mut receipt = coordinator.current().unwrap().unwrap();
        drop(coordinator);
        let controls = f.owned.path().join(".config/kcoder-storage-migrations");
        let archive = controls.join(&f.plan.operation_id).join("receipt.json");
        match damage {
            "current" => fs::write(controls.join("current.json"), b"unknown").unwrap(),
            "missing-current" => fs::remove_file(controls.join("current.json")).unwrap(),
            "receipt" => fs::write(&archive, b"unknown").unwrap(),
            "missing-receipt" => fs::remove_file(&archive).unwrap(),
            _ => {
                receipt
                    .owner_receipts
                    .insert("publish-native".into(), serde_json::json!({"version":255}));
                fs::write(&archive, serde_json::to_vec(&receipt).unwrap()).unwrap();
            }
        }
        fs::write(
            storage_location_file(f.owned.path()),
            b"do not parse this personal locator",
        )
        .unwrap();
        let root = f.owned.path().join("UnrelatedService");
        let input = f.explicit(&root, StorageConsumer::Cli);
        assert!(
            resolve_storage_paths(&input).is_ok(),
            "query remains independent"
        );
        let error = StorageInstance::open(input).err().unwrap().to_string();
        assert!(
            error.starts_with("STORAGE_CONTROL_")
                || error == "STORAGE_OPERATION_MISSING"
                || error.starts_with("STORAGE_COMPONENT_"),
            "{error}"
        );
        assert!(!root.join("settings.json").exists());
        assert_eq!(
            fs::read(storage_location_file(f.owned.path())).unwrap(),
            b"do not parse this personal locator"
        );
    }
}

#[test]
fn a_new_operation_cannot_pass_stopped_after_startup_has_acquired_its_writer_shares() {
    let f = Fixture::new(true);
    let instance =
        StorageInstance::open(f.explicit(&f.plan.from.data_root, StorageConsumer::Cli)).unwrap();
    let mut coordinator = StorageCoordinator::acquire(f.owned.path()).unwrap();
    coordinator.begin(f.plan.clone()).unwrap();
    coordinator
        .advance(&f.plan.operation_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    assert_eq!(
        coordinator
            .advance(&f.plan.operation_id, Phase::Stopping, Phase::Stopped)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Stopping
    );
    assert!(
        coordinator
            .offline_operation_directory(&f.plan.operation_id)
            .is_err()
    );
    assert!(
        coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .is_empty()
    );
    assert!(!f.plan.target.data_root.join("original-payload").exists());
    drop(instance);
}

#[test]
fn staging_children_and_renamed_original_publication_identities_remain_closed() {
    for (published, rename) in [(false, false), (false, true), (true, false), (true, true)] {
        let f = Fixture::new(false);
        let mut coordinator = f.stopped();
        coordinator
            .prepare_source_retirements(&f.plan.operation_id)
            .unwrap();
        coordinator
            .advance(&f.plan.operation_id, Phase::Stopped, Phase::Copying)
            .unwrap();
        let staging = coordinator
            .prepare_component_staging(&f.plan.operation_id, "native")
            .unwrap();
        let StorageComponentDirectory::Staging(directory) = &staging else {
            panic!("expected owned stage")
        };
        let scopes = crate::storage::component_publication::active_component_directory_scopes(
            &coordinator.current().unwrap().unwrap(),
        )
        .unwrap();
        let stage = scopes
            .keys()
            .find(|path| **path != f.plan.target.data_root)
            .unwrap()
            .clone();
        if published {
            coordinator
                .copy_component(&f.plan.operation_id, "native", directory, &BTreeSet::new())
                .unwrap();
            coordinator
                .publish_component(&f.plan.operation_id, "native", &BTreeSet::new())
                .unwrap();
        }
        drop(staging);
        drop(coordinator);
        let original = if published {
            f.plan.target.data_root.clone()
        } else {
            stage
        };
        let actual = if rename {
            let renamed = f.owned.path().join("RenamedPublication");
            fs::rename(&original, &renamed).unwrap();
            renamed
        } else {
            original
        };
        for root in [&actual, &actual.join("Nested")] {
            assert_eq!(
                StorageInstance::open(f.explicit(root, StorageConsumer::Cli))
                    .err()
                    .unwrap()
                    .to_string(),
                "STORAGE_MIGRATION_PENDING"
            );
        }
    }
}

#[test]
fn cache_only_active_scope_closes_the_persistent_root_without_retiring_it() {
    let mut f = Fixture::new(true);
    f.plan.target.data_root = f.plan.from.data_root.clone();
    f.plan.components[0].destination = f.plan.from.data_root.clone();
    f.plan.target_bindings.clear();
    let mut coordinator = f.stopped();
    f.prepare(&mut coordinator);
    drop(coordinator);
    assert_eq!(
        StorageInstance::open(f.explicit(&f.plan.from.data_root, StorageConsumer::Cli))
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    let mut coordinator = StorageCoordinator::acquire(f.owned.path()).unwrap();
    coordinator.commit(&f.plan.operation_id).unwrap();
    coordinator.complete(&f.plan.operation_id).unwrap();
    drop(coordinator);
    drop(StorageInstance::open(f.explicit(&f.plan.from.data_root, StorageConsumer::Cli)).unwrap());
    assert!(
        !f.plan
            .from
            .data_root
            .join("kcoder-storage-retired-native.json")
            .exists()
    );
    assert!(
        read_storage_location_record(&storage_location_file(f.owned.path()))
            .unwrap()
            .is_some()
    );
}

#[cfg(unix)]
#[test]
fn node_admission_observes_a_real_rust_active_receipt_after_coordinator_exit() {
    let f = Fixture::new(true);
    let mut coordinator = f.stopped();
    f.prepare(&mut coordinator);
    coordinator.commit(&f.plan.operation_id).unwrap();
    drop(coordinator);
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/kcoder-studio/src/storage-active-operation.test.mjs");
    let output = std::process::Command::new("node")
        .arg(script)
        .arg("--owned-rust-active-probe")
        .arg(f.owned.path())
        .arg(&f.plan.target.data_root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("active-operation-rust-probe-ok"));
}
