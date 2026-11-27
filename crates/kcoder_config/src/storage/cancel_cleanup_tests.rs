use super::*;
use crate::storage::{StorageResolveInput, resolve_storage_paths, storage_location_file};
use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent, StorageTargetBinding};
use std::fs;

const ID: &str = "cancel-raw-copy";
const DOMAIN: &str = "native";

struct Fixture {
    _owned: tempfile::TempDir,
    home: PathBuf,
    source: PathBuf,
    target: PathBuf,
    parent: PathBuf,
    plan: StorageMigrationPlan,
}

impl Fixture {
    fn new() -> Self {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let source = home.join(".config/kcoder");
        let parent = owned.path().join("target");
        let target = parent.join("data");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(source.join("a.txt"), b"source a").unwrap();
        fs::write(source.join("z.txt"), b"source z").unwrap();
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: ID.into(),
            original: None,
            from: resolve_storage_paths(&StorageResolveInput {
                home: Some(home.clone()),
                ..Default::default()
            })
            .unwrap(),
            target: StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: target.clone(),
                cache_root: owned.path().join("cache"),
                operation_id: Some(ID.into()),
            },
            components: vec![StorageMigrationComponent {
                domain: DOMAIN.into(),
                source: source.clone(),
                destination: target.clone(),
                source_identity: PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 16,
            }],
            target_bindings: vec![StorageTargetBinding {
                path: target.clone(),
                existing_ancestor: parent.clone(),
                ancestor_identity: PrivateDirectory::open_existing(&parent)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        Self {
            _owned: owned,
            home,
            source,
            target,
            parent,
            plan,
        }
    }

    fn copying(&self) -> StorageCoordinator {
        let mut coordinator = StorageCoordinator::acquire(&self.home).unwrap();
        coordinator.begin(self.plan.clone()).unwrap();
        for (from, to) in [
            (Phase::Planned, Phase::Stopping),
            (Phase::Stopping, Phase::Stopped),
            (Phase::Stopped, Phase::Copying),
        ] {
            coordinator.advance(ID, from, to).unwrap();
        }
        coordinator
    }

    fn stage(&self) -> PathBuf {
        self.parent.join(format!(".kcoder-storage-{ID}-{DOMAIN}"))
    }

    fn copied(&self, coordinator: &mut StorageCoordinator, published: bool) {
        if published {
            coordinator
                .publish_component(ID, DOMAIN, &BTreeSet::new())
                .unwrap();
        } else {
            let directory = coordinator.prepare_component_staging(ID, DOMAIN).unwrap();
            let crate::storage::StorageComponentDirectory::Staging(directory) = directory else {
                panic!("not staging")
            };
            coordinator
                .copy_component(ID, DOMAIN, &directory, &BTreeSet::new())
                .unwrap();
        }
    }

    fn source_unchanged(&self) {
        assert_eq!(fs::read(self.source.join("a.txt")).unwrap(), b"source a");
        assert_eq!(fs::read(self.source.join("z.txt")).unwrap(), b"source z");
        assert!(!storage_location_file(&self.home).exists());
    }

    fn active(&self, coordinator: &StorageCoordinator, pending: bool) {
        let receipt = coordinator.current().unwrap().unwrap();
        assert_eq!(receipt.plan.operation_id, ID);
        assert_eq!(receipt.disposition, Disposition::Active);
        assert_eq!(
            receipt.error_code.as_deref() == Some(CANCEL_PENDING),
            pending
        );
        assert!(crate::storage::StorageStartupLease::acquire(&self.home).is_err());
        self.source_unchanged();
    }
}

#[test]
fn raw_staging_and_published_copies_cancel_after_restart_then_retry_the_original_id() {
    for published in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.copying();
        fixture.copied(&mut coordinator, published);
        drop(coordinator);
        let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
        let cancelled = coordinator.cancel_operation(ID).unwrap();
        assert_eq!(cancelled.disposition, Disposition::Deferred);
        assert_eq!(
            cancelled.error_code.as_deref(),
            Some("STORAGE_OPERATION_CANCELLED")
        );
        assert!(cancelled.owner_receipts.is_empty());
        assert_eq!(coordinator.cancel_operation(ID).unwrap(), cancelled);
        assert!(!fixture.target.exists());
        assert!(!fixture.stage().exists());
        fixture.source_unchanged();
        drop(coordinator);
        drop(crate::storage::StorageStartupLease::acquire(&fixture.home).unwrap());
        let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
        coordinator.retry_deferred(ID).unwrap();
        for (from, to) in [
            (Phase::Planned, Phase::Stopping),
            (Phase::Stopping, Phase::Stopped),
            (Phase::Stopped, Phase::Copying),
        ] {
            coordinator.advance(ID, from, to).unwrap();
        }
        fixture.copied(&mut coordinator, true);
        assert_eq!(fs::read(fixture.target.join("a.txt")).unwrap(), b"source a");
    }
}

#[test]
fn an_empty_owned_stage_and_stopped_no_copy_cancel_without_creating_a_target() {
    for staged in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.copying();
        if staged {
            coordinator.prepare_component_staging(ID, DOMAIN).unwrap();
        }
        coordinator.cancel_operation(ID).unwrap();
        assert!(!fixture.stage().exists());
        assert!(!fixture.target.exists());
        fixture.source_unchanged();
    }
}

#[test]
fn unknown_replaced_and_converted_payloads_preserve_every_target_and_remain_active() {
    for mode in ["new", "replaced", "converted"] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.copying();
        fixture.copied(&mut coordinator, true);
        match mode {
            "new" => fs::write(fixture.target.join("unknown.txt"), b"new business data").unwrap(),
            "replaced" => {
                fs::rename(
                    fixture.target.join("z.txt"),
                    fixture.target.join("original-z"),
                )
                .unwrap();
                fs::write(fixture.target.join("z.txt"), b"source z").unwrap();
            }
            _ => fs::write(fixture.target.join("z.txt"), b"converted business bytes").unwrap(),
        }
        assert!(coordinator.cancel_operation(ID).is_err());
        assert_eq!(fs::read(fixture.target.join("a.txt")).unwrap(), b"source a");
        assert!(fixture.target.join("z.txt").exists());
        fixture.active(&coordinator, false);
        if mode == "converted" {
            coordinator.open_published_component(ID, DOMAIN).unwrap();
            coordinator
                .advance(ID, Phase::Copying, Phase::Verifying)
                .unwrap();
        }
    }
}

#[test]
fn cleanup_interruption_resumes_deletion_by_original_id_without_recopying() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.copying();
    fixture.copied(&mut coordinator, false);
    let mut removed_one = false;
    let error = coordinator.cancel_operation_with_hook(ID, &mut |path| {
        if path.file_name() == Some(OsStr::new("a.txt")) {
            removed_one = !fixture.stage().join("z.txt").exists();
            anyhow::bail!("owned cancellation interrupted");
        }
        Ok(())
    });
    assert!(error.is_err());
    assert!(removed_one);
    fixture.active(&coordinator, true);
    drop(coordinator);
    let mut coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
    let result = coordinator.cancel_operation(ID).unwrap();
    assert_eq!(result.disposition, Disposition::Deferred);
    assert_eq!(result.plan.operation_id, ID);
    assert!(!fixture.stage().exists());
    fixture.source_unchanged();
}

#[test]
fn a_new_file_during_cleanup_is_preserved_and_blocks_deferral() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.copying();
    fixture.copied(&mut coordinator, true);
    let mut injected = false;
    let result = coordinator.cancel_operation_with_hook(ID, &mut |path| {
        if !injected && path.file_name() == Some(OsStr::new("kcoder-storage-pending.json")) {
            fs::write(fixture.target.join("new-write.txt"), b"retain new write")?;
            injected = true;
        }
        Ok(())
    });
    assert!(injected);
    assert!(result.is_err());
    assert_eq!(
        fs::read(fixture.target.join("new-write.txt")).unwrap(),
        b"retain new write"
    );
    fixture.active(&coordinator, true);
    assert!(coordinator.cancel_operation(ID).is_err());
    fixture.active(&coordinator, true);
}

#[test]
fn a_selected_empty_container_keeps_its_original_directory_and_fences() {
    let mut fixture = Fixture::new();
    fs::create_dir(&fixture.target).unwrap();
    let original = PrivateDirectory::open_existing(&fixture.target)
        .unwrap()
        .directory_identity()
        .unwrap();
    fixture.plan.target_bindings[0].existing_ancestor = fixture.target.clone();
    fixture.plan.target_bindings[0].ancestor_identity = original.clone();
    let mut coordinator = fixture.copying();
    fixture.copied(&mut coordinator, true);
    coordinator.cancel_operation(ID).unwrap();
    let retained = PrivateDirectory::open_existing(&fixture.target).unwrap();
    assert_eq!(retained.directory_identity().unwrap(), original);
    assert_eq!(
        retained.entry_names_bounded(2).unwrap(),
        vec![OsString::from("kcoder-storage-writers.lock")]
    );
    fixture.source_unchanged();
}

#[test]
fn unknown_control_or_owner_facts_are_not_deleted_or_settled() {
    for owner in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.copying();
        fixture.copied(&mut coordinator, false);
        if owner {
            coordinator
                .record_owner_receipt(
                    ID,
                    "domain-adapter",
                    None,
                    serde_json::json!({"pending":true}),
                )
                .unwrap();
        } else {
            let operation = coordinator.offline_operation_directory(ID).unwrap();
            operation
                .atomic_replace(OsStr::new("unknown-control.json"), b"unknown")
                .unwrap();
        }
        assert!(coordinator.cancel_operation(ID).is_err());
        assert_eq!(
            fs::read(fixture.stage().join("a.txt")).unwrap(),
            b"source a"
        );
        fixture.active(&coordinator, false);
    }
}

#[test]
fn committed_selection_cannot_be_cancelled_or_rewritten() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.copying();
    coordinator.prepare_source_retirements(ID).unwrap();
    fixture.copied(&mut coordinator, true);
    coordinator
        .advance(ID, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(ID, Phase::Verifying, Phase::Prepared)
        .unwrap();
    let receipt = coordinator.commit(ID).unwrap();
    let bytes = fs::read(storage_location_file(&fixture.home)).unwrap();
    assert!(coordinator.cancel_operation(ID).is_err());
    assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
    assert_eq!(
        fs::read(storage_location_file(&fixture.home)).unwrap(),
        bytes
    );
    assert_eq!(fs::read(fixture.target.join("a.txt")).unwrap(), b"source a");
}
