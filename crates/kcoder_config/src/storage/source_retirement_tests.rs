use super::*;
use crate::storage::{
    StorageConsumer, StorageInstance, StorageLocationRecord, StorageResolveInput,
    resolve_storage_paths, storage_location_file,
};
use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent};
use std::{collections::BTreeMap, fs};

fn plan(home: &Path, id: &str, original: Option<StorageLocationRecord>) -> StorageMigrationPlan {
    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        record: original.clone(),
        ..Default::default()
    })
    .unwrap();
    // This fixture has three actual persistent roles inside its declared source.
    from.gateway_root = from.data_root.join("studio/gateway");
    from.desktop_root = from.data_root.join("studio/desktop");
    fs::create_dir_all(&from.gateway_root).unwrap();
    fs::create_dir_all(&from.desktop_root).unwrap();
    fs::create_dir_all(&from.cache_root).unwrap();
    let target = StorageLocationRecord {
        version: 1,
        revision: original.as_ref().map_or(1, |record| record.revision + 1),
        data_root: home.join(format!("Target-{id}")),
        cache_root: home.join(format!("Cache-{id}")),
        operation_id: Some(id.into()),
    };
    fs::create_dir(&target.data_root).unwrap();
    fs::create_dir(&target.cache_root).unwrap();
    let source = PrivateDirectory::open_existing(&from.data_root).unwrap();
    StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original,
        components: vec![StorageMigrationComponent {
            domain: "persistent-root".into(),
            source: from.data_root.clone(),
            destination: target.data_root.clone(),
            source_identity: source.directory_identity().unwrap(),
            estimated_bytes: 0,
        }],
        from,
        target,
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    }
}

fn stopped(home: &Path, plan: &StorageMigrationPlan) -> StorageCoordinator {
    let mut coordinator = StorageCoordinator::acquire(home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance(&plan.operation_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(&plan.operation_id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
}

fn prepared(coordinator: &mut StorageCoordinator, id: &str) {
    for (before, after) in [
        (Phase::Stopped, Phase::Copying),
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        coordinator.advance(id, before, after).unwrap();
    }
}

fn complete(coordinator: &mut StorageCoordinator, id: &str) {
    prepared(coordinator, id);
    coordinator.assert_source_retirements_ready(id).unwrap();
    coordinator.commit(id).unwrap();
    coordinator.complete(id).unwrap();
}

#[test]
fn prepared_commit_requires_source_facts_before_publishing_selection() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "missing-before-commit", None);
    let mut coordinator = stopped(owned.path(), &plan);
    prepared(&mut coordinator, &plan.operation_id);
    assert_eq!(
        coordinator
            .commit(&plan.operation_id)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_RETIREMENT_UNCONFIRMED"
    );
    assert_eq!(
        read_storage_location_record(&storage_location_file(owned.path())).unwrap(),
        None
    );
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt.phase, Phase::Prepared);
    assert_eq!(receipt.disposition, Disposition::Active);
    assert!(receipt.owner_receipts.is_empty());
    for role in StorageRootRole::ALL {
        let source = mapped_roots(&plan, role).unwrap().unwrap().0;
        assert!(!source.join(role.leaf()).exists());
    }
}

#[test]
fn committed_completion_rechecks_original_marker_and_keeps_normal_retries_idempotent() {
    for damage in ["unchanged", "removed", "replaced"] {
        let owned = tempfile::tempdir().unwrap();
        let plan = plan(owned.path(), "committed-marker", None);
        let mut coordinator = stopped(owned.path(), &plan);
        coordinator
            .prepare_source_retirements(&plan.operation_id)
            .unwrap();
        prepared(&mut coordinator, &plan.operation_id);
        let committed = coordinator.commit(&plan.operation_id).unwrap();
        assert_eq!(coordinator.commit(&plan.operation_id).unwrap(), committed);
        drop(coordinator);

        let root = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
        let name = OsStr::new(StorageRootRole::Native.leaf());
        let original = fs::read(plan.from.data_root.join(name)).unwrap();
        match damage {
            "removed" => root.remove_regular_file(name).unwrap(),
            "replaced" => root.atomic_replace(name, &original).unwrap(),
            _ => {}
        }
        let mut recovered = StorageCoordinator::acquire(owned.path()).unwrap();
        if damage == "unchanged" {
            assert_eq!(recovered.commit(&plan.operation_id).unwrap(), committed);
            let completed = recovered.complete(&plan.operation_id).unwrap();
            assert_eq!(completed.disposition, Disposition::Complete);
            assert_eq!(recovered.complete(&plan.operation_id).unwrap(), completed);
        } else {
            assert!(recovered.complete(&plan.operation_id).is_err());
            assert_eq!(recovered.current().unwrap().unwrap(), committed);
            if damage == "replaced" {
                assert_eq!(fs::read(plan.from.data_root.join(name)).unwrap(), original);
            } else {
                assert!(!plan.from.data_root.join(name).exists());
            }
        }
        assert_eq!(
            read_storage_location_record(&storage_location_file(owned.path())).unwrap(),
            Some(plan.target)
        );
    }
}

#[test]
fn missing_declared_source_is_changed_while_absent_optional_nested_role_is_not_created() {
    for role in [StorageRootRole::Native, StorageRootRole::Gateway] {
        let owned = tempfile::tempdir().unwrap();
        let mut plan = plan(owned.path(), "missing-declared", None);
        let source = mapped_roots(&plan, role).unwrap().unwrap().0;
        if role == StorageRootRole::Gateway {
            plan.components.push(StorageMigrationComponent {
                domain: "gateway".into(),
                source: source.clone(),
                destination: plan.target.data_root.join("studio/gateway"),
                source_identity: PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            });
        }
        fs::remove_dir_all(&source).unwrap();
        let mut coordinator = stopped(owned.path(), &plan);
        assert_eq!(
            coordinator
                .prepare_source_retirements(&plan.operation_id)
                .unwrap_err()
                .to_string(),
            "STORAGE_SOURCE_CHANGED"
        );
        assert_eq!(
            coordinator
                .assert_source_retirements_ready(&plan.operation_id)
                .unwrap_err()
                .to_string(),
            "STORAGE_SOURCE_CHANGED"
        );
        assert!(!source.exists());
        assert!(!storage_location_file(owned.path()).exists());
    }

    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "missing-optional", None);
    fs::remove_dir_all(&plan.from.gateway_root).unwrap();
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator
        .prepare_source_retirements(&plan.operation_id)
        .unwrap();
    coordinator
        .assert_source_retirements_ready(&plan.operation_id)
        .unwrap();
    assert!(!plan.from.gateway_root.exists());
    assert!(
        binding(
            &coordinator.current().unwrap().unwrap(),
            StorageRootRole::Gateway
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn normalized_declared_components_preserve_role_mapping_and_frozen_source_identity() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "normalized-components", None);
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator
        .prepare_source_retirements(&plan.operation_id)
        .unwrap();
    let mut receipt = coordinator.current().unwrap().unwrap();
    let component = &mut receipt.plan.components[0];
    for path in [&mut component.source, &mut component.destination] {
        *path = path.join("..").join(path.file_name().unwrap());
    }
    for role in StorageRootRole::ALL {
        assert_eq!(
            mapped_roots(&receipt.plan, role).unwrap(),
            mapped_roots(&plan, role).unwrap()
        );
        validate_binding(&receipt, &binding(&receipt, role).unwrap().unwrap()).unwrap();
    }
    receipt.plan.components[0].source_identity = "changed-source-identity".into();
    assert_eq!(
        validate_binding(
            &receipt,
            &binding(&receipt, StorageRootRole::Native).unwrap().unwrap()
        )
        .unwrap_err()
        .to_string(),
        "STORAGE_SOURCE_CHANGED"
    );
}

fn explicit(home: &Path, root: &Path, consumer: StorageConsumer) -> StorageResolveInput {
    StorageResolveInput {
        home: Some(home.into()),
        consumer,
        env: BTreeMap::from([
            ("KCODER_HOME".into(), root.as_os_str().to_owned()),
            (
                "KCODER_CACHE_DIR".into(),
                home.join("ExplicitCache").into_os_string(),
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

#[test]
fn completed_source_is_refused_by_explicit_native_gateway_and_desktop_without_changing_identity_bytes()
 {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "first", None);
    let business = plan.from.data_root.join("original-identity-and-task-bytes");
    fs::write(&business, b"original authorization and task state").unwrap();
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("first").unwrap();
    assert_eq!(
        coordinator
            .source_retirement_exclusion_identities("first")
            .unwrap()
            .len(),
        3
    );
    complete(&mut coordinator, "first");
    drop(coordinator);
    for consumer in [
        StorageConsumer::Cli,
        StorageConsumer::Gateway,
        StorageConsumer::Desktop,
    ] {
        assert_eq!(
            StorageInstance::open(explicit(owned.path(), &plan.from.data_root, consumer))
                .err()
                .unwrap()
                .to_string(),
            "STORAGE_SOURCE_RETIRED"
        );
    }
    assert_eq!(
        fs::read(&business).unwrap(),
        b"original authorization and task state"
    );
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &plan.target.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
}

#[test]
fn inplace_native_does_not_inherit_retired_gateway_or_desktop_roles() {
    let owned = tempfile::tempdir().unwrap();
    let mut plan = plan(owned.path(), "merge", None);
    plan.from.gateway_root = plan.from.data_root.clone();
    plan.from.desktop_root = plan.from.data_root.clone();
    plan.target.data_root = plan.from.data_root.clone();
    let identity = PrivateDirectory::open_existing(&plan.from.data_root)
        .unwrap()
        .directory_identity()
        .unwrap();
    plan.components = vec![
        StorageMigrationComponent {
            domain: "gateway".into(),
            source: plan.from.data_root.clone(),
            destination: plan.target.data_root.join("studio/gateway"),
            source_identity: identity.clone(),
            estimated_bytes: 0,
        },
        StorageMigrationComponent {
            domain: "desktop".into(),
            source: plan.from.data_root.clone(),
            destination: plan.target.data_root.join("studio/desktop"),
            source_identity: identity,
            estimated_bytes: 0,
        },
    ];
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("merge").unwrap();
    assert!(
        !plan
            .from
            .data_root
            .join(StorageRootRole::Native.leaf())
            .exists()
    );
    assert!(
        plan.from
            .data_root
            .join(StorageRootRole::Gateway.leaf())
            .exists()
    );
    complete(&mut coordinator, "merge");
    drop(coordinator);
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &plan.from.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
    let root = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    assert_eq!(
        assert_storage_root_admitted(&root, StorageRootRole::Gateway)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_RETIRED"
    );
    assert_eq!(
        assert_storage_root_admitted(&root, StorageRootRole::Desktop)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_RETIRED"
    );
    let gateway =
        PrivateDirectory::open_existing(&plan.from.data_root.join("studio/gateway")).unwrap();
    assert_storage_root_admitted(&gateway, StorageRootRole::Gateway).unwrap();
}

#[test]
fn cache_only_changes_create_no_persistent_retirement_fact() {
    let owned = tempfile::tempdir().unwrap();
    let mut plan = plan(owned.path(), "cache-only", None);
    plan.target.data_root = plan.from.data_root.clone();
    plan.components[0].destination = plan.from.data_root.clone();
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator
        .prepare_source_retirements("cache-only")
        .unwrap();
    assert!(
        coordinator
            .source_retirement_exclusion_identities("cache-only")
            .unwrap()
            .is_empty()
    );
    for role in StorageRootRole::ALL {
        assert!(!plan.from.data_root.join(role.leaf()).exists());
    }
    coordinator
        .cleanup_source_retirements("cache-only")
        .unwrap();
    coordinator
        .defer_after_cleanup("cache-only", "OWNED_CANCELLED")
        .unwrap();
    drop(coordinator);
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &plan.from.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
}

#[test]
fn deferred_cleanup_removes_only_owned_facts_and_the_original_id_can_prepare_again() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "cancelled", None);
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("cancelled").unwrap();
    for (before, after) in [
        (Phase::Stopped, Phase::Copying),
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        coordinator.advance("cancelled", before, after).unwrap();
    }
    coordinator.cleanup_source_retirements("cancelled").unwrap();
    coordinator
        .defer_after_cleanup("cancelled", "OWNED_CANCELLED")
        .unwrap();
    drop(coordinator);
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &plan.from.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
    let mut retry = StorageCoordinator::acquire(owned.path()).unwrap();
    retry.retry_deferred("cancelled").unwrap();
    retry
        .advance("cancelled", Phase::Planned, Phase::Stopping)
        .unwrap();
    retry
        .advance("cancelled", Phase::Stopping, Phase::Stopped)
        .unwrap();
    retry.prepare_source_retirements("cancelled").unwrap();
    retry.assert_source_retirements_ready("cancelled").unwrap();
}

#[test]
fn first_source_stays_retired_after_a_second_operation_without_scanning_other_archives() {
    let owned = tempfile::tempdir().unwrap();
    let first = plan(owned.path(), "first", None);
    let mut coordinator = stopped(owned.path(), &first);
    coordinator.prepare_source_retirements("first").unwrap();
    complete(&mut coordinator, "first");
    drop(coordinator);
    let second = plan(owned.path(), "second", Some(first.target.clone()));
    let mut coordinator = stopped(owned.path(), &second);
    coordinator.prepare_source_retirements("second").unwrap();
    complete(&mut coordinator, "second");
    drop(coordinator);
    let unrelated = owned
        .path()
        .join(".config/kcoder-storage-migrations/unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("receipt.json"), b"corrupt unrelated history").unwrap();
    for source in [&first.from.data_root, &second.from.data_root] {
        assert_eq!(
            StorageInstance::open(explicit(owned.path(), source, StorageConsumer::Cli))
                .err()
                .unwrap()
                .to_string(),
            "STORAGE_SOURCE_RETIRED"
        );
    }
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &second.target.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
}

#[test]
fn a_later_native_move_preserves_prior_role_markers_and_excludes_their_exact_files() {
    let owned = tempfile::tempdir().unwrap();
    let mut first = plan(owned.path(), "merge-first", None);
    first.from.gateway_root = first.from.data_root.clone();
    first.from.desktop_root = first.from.data_root.clone();
    first.target.data_root = first.from.data_root.clone();
    let identity = PrivateDirectory::open_existing(&first.from.data_root)
        .unwrap()
        .directory_identity()
        .unwrap();
    first.components = [StorageRootRole::Gateway, StorageRootRole::Desktop]
        .into_iter()
        .map(|role| StorageMigrationComponent {
            domain: role.as_str().into(),
            source: first.from.data_root.clone(),
            destination: first.target.data_root.join("studio").join(role.as_str()),
            source_identity: identity.clone(),
            estimated_bytes: 0,
        })
        .collect();
    let mut coordinator = stopped(owned.path(), &first);
    coordinator
        .prepare_source_retirements("merge-first")
        .unwrap();
    complete(&mut coordinator, "merge-first");
    drop(coordinator);
    let original = fs::read(first.from.data_root.join(StorageRootRole::Gateway.leaf())).unwrap();
    let second = plan(owned.path(), "native-later", Some(first.target.clone()));
    let mut coordinator = stopped(owned.path(), &second);
    coordinator
        .prepare_source_retirements("native-later")
        .unwrap();
    assert_eq!(
        coordinator
            .source_retirement_exclusion_identities("native-later")
            .unwrap()
            .len(),
        5
    );
    let inventory = coordinator
        .inventory_source("native-later", "persistent-root", &BTreeSet::new())
        .unwrap();
    assert!(
        inventory
            .entries
            .iter()
            .find(|entry| entry.relative_path == Path::new(StorageRootRole::Gateway.leaf()))
            .unwrap()
            .excluded
    );
    coordinator
        .cleanup_source_retirements("native-later")
        .unwrap();
    coordinator
        .defer_after_cleanup("native-later", "OWNED_CANCELLED")
        .unwrap();
    drop(coordinator);
    assert_eq!(
        fs::read(first.from.data_root.join(StorageRootRole::Gateway.leaf())).unwrap(),
        original
    );
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &first.from.data_root,
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
    let root = PrivateDirectory::open_existing(&first.from.data_root).unwrap();
    assert_eq!(
        assert_storage_root_admitted(&root, StorageRootRole::Gateway)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_RETIRED"
    );
}

#[test]
fn unknown_marker_or_unreceipted_preparation_is_preserved_instead_of_adopted() {
    for use_prepared in [false, true] {
        let owned = tempfile::tempdir().unwrap();
        let plan = plan(owned.path(), "unknown", None);
        let mut coordinator = stopped(owned.path(), &plan);
        let root = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
        let name = if use_prepared {
            prepared_name("unknown", StorageRootRole::Native)
        } else {
            StorageRootRole::Native.leaf().into()
        };
        root.atomic_replace(OsStr::new(&name), b"unknown persistent payload")
            .unwrap();
        assert_eq!(
            coordinator
                .prepare_source_retirements("unknown")
                .unwrap_err()
                .to_string(),
            "STORAGE_SOURCE_RETIREMENT_CONFLICT"
        );
        assert_eq!(
            fs::read(plan.from.data_root.join(name)).unwrap(),
            b"unknown persistent payload"
        );
        assert!(
            !coordinator
                .current()
                .unwrap()
                .unwrap()
                .owner_receipts
                .contains_key(&StorageRootRole::Native.owner_key())
        );
    }
}

#[test]
fn source_marker_crashes_before_fixed_publication_resume_or_cancel_the_original_id() {
    const ROOT: &str = "KCODER_STORAGE_RETIREMENT_CRASH_ROOT";
    const CHECKPOINT: &str = "KCODER_STORAGE_RETIREMENT_CRASH_CHECKPOINT";
    const ID: &str = "lost-preparation";
    if let Some(home) = std::env::var_os(ROOT) {
        let home = PathBuf::from(home);
        let mut plan = plan(&home, ID, None);
        plan.target_bindings
            .push(kcoder_types::StorageTargetBinding {
                path: plan.target.data_root.clone(),
                existing_ancestor: plan.target.data_root.clone(),
                ancestor_identity: PrivateDirectory::open_existing(&plan.target.data_root)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
            });
        fs::write(plan.from.data_root.join("business"), b"original state").unwrap();
        let mut coordinator = stopped(&home, &plan);
        let stop_at: usize = std::env::var(CHECKPOINT).unwrap().parse().unwrap();
        let mut checkpoint = 0;
        coordinator
            .prepare_source_retirements_with_checkpoint(ID, &mut || {
                checkpoint += 1;
                if checkpoint == stop_at {
                    // Exit without destructors to retain the real atomic-write temp.
                    std::process::exit(73);
                }
                Ok(())
            })
            .unwrap();
        panic!("owned crash checkpoint was not reached");
    }
    for stop_at in [1, 2] {
        let owned = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "storage::source_retirement::tests::source_marker_crashes_before_fixed_publication_resume_or_cancel_the_original_id", "--test-threads=1"])
            .env_clear()
            .env(ROOT, owned.path())
            .env(CHECKPOINT, stop_at.to_string());
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(73), "{output:?}");
        let mut resumed = StorageCoordinator::acquire(owned.path()).unwrap();
        let receipt = resumed.current().unwrap().unwrap();
        assert_eq!(receipt.plan.operation_id, ID);
        assert_eq!(receipt.phase, Phase::Stopped);
        assert_eq!(receipt.disposition, Disposition::Active);
        let source = &receipt.plan.from.data_root;
        assert!(!source.join(StorageRootRole::Native.leaf()).exists());
        assert!(
            !source
                .join(prepared_name(ID, StorageRootRole::Native))
                .exists()
        );
        let root = PrivateDirectory::open_existing(source).unwrap();
        let temporary = root
            .entry_names_bounded(16)
            .unwrap()
            .into_iter()
            .find(|name| name.to_string_lossy().starts_with(".kcoder."))
            .unwrap();
        let orphan = fs::read(source.join(&temporary)).unwrap();
        let orphan_identity =
            file_identity(&root.open_single_link_regular_file(&temporary).unwrap()).unwrap();
        assert_eq!(
            binding(&receipt, StorageRootRole::Native)
                .unwrap()
                .is_some(),
            stop_at == 2
        );
        if stop_at == 1 {
            resumed.prepare_source_retirements(ID).unwrap();
            let inventory = resumed
                .inventory_source(ID, "persistent-root", &BTreeSet::new())
                .unwrap();
            assert!(
                inventory
                    .entries
                    .iter()
                    .any(|entry| entry.relative_path == Path::new(&temporary)
                        && !entry.excluded
                        && entry.sha256.is_some())
            );
        }
        let cancelled = resumed.cancel_operation(ID).unwrap();
        assert_eq!(cancelled.disposition, Disposition::Deferred);
        assert_eq!(cancelled.plan, receipt.plan);
        assert!(cancelled.owner_receipts.is_empty());
        assert_eq!(
            fs::read(source.join("business")).unwrap(),
            b"original state"
        );
        assert_eq!(fs::read(source.join(&temporary)).unwrap(), orphan);
        assert_eq!(
            file_identity(&root.open_single_link_regular_file(&temporary).unwrap()).unwrap(),
            orphan_identity
        );
        drop(resumed);
        drop(StorageInstance::open(explicit(owned.path(), source, StorageConsumer::Cli)).unwrap());
        let mut retry = StorageCoordinator::acquire(owned.path()).unwrap();
        retry.retry_deferred(ID).unwrap();
        retry.advance(ID, Phase::Planned, Phase::Stopping).unwrap();
        retry.advance(ID, Phase::Stopping, Phase::Stopped).unwrap();
        retry.prepare_source_retirements(ID).unwrap();
        retry.assert_source_retirements_ready(ID).unwrap();
        assert_eq!(fs::read(source.join(&temporary)).unwrap(), orphan);
        retry.cleanup_source_retirements(ID).unwrap();
        let unknown = prepared_name(ID, StorageRootRole::Native);
        root.atomic_replace(OsStr::new(&unknown), &orphan).unwrap();
        assert_eq!(
            retry
                .prepare_source_retirements(ID)
                .unwrap_err()
                .to_string(),
            "STORAGE_SOURCE_RETIREMENT_CONFLICT"
        );
        assert_eq!(fs::read(source.join(unknown)).unwrap(), orphan);
    }
}

#[test]
fn receipted_preparation_recovers_the_original_physical_file_instead_of_recreating_it() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "recover-preparation", None);
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator
        .prepare_source_retirements("recover-preparation")
        .unwrap();
    let proof = binding(
        &coordinator.current().unwrap().unwrap(),
        StorageRootRole::Native,
    )
    .unwrap()
    .unwrap();
    let root = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    root.rename_no_replace(
        OsStr::new(StorageRootRole::Native.leaf()),
        OsStr::new(&prepared_name(
            "recover-preparation",
            StorageRootRole::Native,
        )),
    )
    .unwrap();
    drop(coordinator);
    let mut resumed = StorageCoordinator::acquire(owned.path()).unwrap();
    resumed
        .prepare_source_retirements("recover-preparation")
        .unwrap();
    let file = root
        .open_single_link_regular_file(OsStr::new(StorageRootRole::Native.leaf()))
        .unwrap();
    assert_eq!(file_identity(&file).unwrap(), proof.marker_identity);
    assert!(
        !plan
            .from
            .data_root
            .join(prepared_name(
                "recover-preparation",
                StorageRootRole::Native
            ))
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn cleanup_and_copy_exclusions_reject_a_replacement_with_identical_marker_bytes() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "replaced", None);
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("replaced").unwrap();
    let root = PrivateDirectory::open_existing(&plan.from.data_root).unwrap();
    let marker = fs::read(plan.from.data_root.join(StorageRootRole::Native.leaf())).unwrap();
    root.atomic_replace(OsStr::new(StorageRootRole::Native.leaf()), &marker)
        .unwrap();
    assert!(
        coordinator
            .source_retirement_exclusion_identities("replaced")
            .is_err()
    );
    assert!(coordinator.cleanup_source_retirements("replaced").is_err());
    assert_eq!(
        fs::read(plan.from.data_root.join(StorageRootRole::Native.leaf())).unwrap(),
        marker
    );
}

#[test]
fn missing_or_damaged_original_receipts_fail_closed_and_queries_remain_pure() {
    for damage in [false, true] {
        let owned = tempfile::tempdir().unwrap();
        let plan = plan(owned.path(), "archive", None);
        let mut coordinator = stopped(owned.path(), &plan);
        coordinator.prepare_source_retirements("archive").unwrap();
        complete(&mut coordinator, "archive");
        drop(coordinator);
        let receipt = owned
            .path()
            .join(".config/kcoder-storage-migrations/archive/receipt.json");
        if damage {
            fs::write(&receipt, b"damaged").unwrap();
        } else {
            fs::remove_file(&receipt).unwrap();
        }
        assert!(
            StorageInstance::open(explicit(
                owned.path(),
                &plan.from.data_root,
                StorageConsumer::Cli
            ))
            .is_err()
        );
        assert_eq!(
            resolve_storage_paths(&explicit(
                owned.path(),
                &plan.from.data_root,
                StorageConsumer::Cli
            ))
            .unwrap()
            .data_root,
            plan.from.data_root
        );
    }
    let owned = tempfile::tempdir().unwrap();
    fs::create_dir(owned.path().join(".config")).unwrap();
    fs::write(
        owned.path().join(".config/kcoder-storage.json"),
        b"broken personal locator",
    )
    .unwrap();
    drop(
        StorageInstance::open(explicit(
            owned.path(),
            &owned.path().join("Dev"),
            StorageConsumer::Cli,
        ))
        .unwrap(),
    );
}

#[test]
fn inventory_excludes_actual_owned_markers_and_keeps_unknown_same_named_files() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "inventory", None);
    let unknown = plan.from.data_root.join("Unknown");
    fs::create_dir(&unknown).unwrap();
    fs::write(
        unknown.join(StorageRootRole::Native.leaf()),
        b"unrelated persistent payload",
    )
    .unwrap();
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("inventory").unwrap();
    let inventory = coordinator
        .inventory_source("inventory", "persistent-root", &BTreeSet::new())
        .unwrap();
    for entry in &inventory.entries {
        if entry.relative_path == Path::new(StorageRootRole::Native.leaf()) {
            assert!(entry.excluded && entry.sha256.is_none());
        }
        if entry.relative_path == Path::new("Unknown").join(StorageRootRole::Native.leaf()) {
            assert!(!entry.excluded && entry.sha256.is_some());
        }
    }
}

#[cfg(unix)]
#[test]
fn actual_node_admission_reads_a_rust_prepared_original_operation() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "rust-node", None);
    let mut coordinator = stopped(owned.path(), &plan);
    coordinator.prepare_source_retirements("rust-node").unwrap();
    complete(&mut coordinator, "rust-node");
    drop(coordinator);
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/kcoder-studio/src/storage-source-retirement.test.mjs");
    let output = std::process::Command::new("node")
        .arg(fixture)
        .arg("--owned-rust-probe")
        .arg(owned.path())
        .arg(&plan.from.data_root)
        .arg(&plan.target.data_root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("source-retirement-rust-probe-ok"));
}
