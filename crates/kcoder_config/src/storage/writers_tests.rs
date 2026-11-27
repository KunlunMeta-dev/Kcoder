use super::*;
use crate::storage::{
    StorageCoordinator, StorageInstance, StorageLocationRecord, StorageResolveInput,
    resolve_storage_paths,
};
use kcoder_types::{StorageLaunchIntent, StorageMigrationPhase as Phase, StorageMigrationPlan};
use std::{collections::BTreeMap, fs};

fn plan(home: &Path, id: &str) -> StorageMigrationPlan {
    StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home.to_owned()),
            ..Default::default()
        })
        .unwrap(),
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: home.join("NewData"),
            cache_root: home.join("NewCache"),
            operation_id: Some(id.into()),
        },
        components: vec![],
        target_bindings: vec![],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    }
}

#[test]
fn active_nested_explicit_profile_blocks_migration_even_without_a_parent_fence() {
    let owned = tempfile::tempdir().unwrap();
    let plan = plan(owned.path(), "nested-writer");
    let nested = plan.from.data_root.join("nested/Profile");
    let input = || StorageResolveInput {
        home: Some(owned.path().to_owned()),
        env: BTreeMap::from([("KCODER_HOME".into(), nested.clone().into_os_string())]),
        ..Default::default()
    };
    let writer = StorageInstance::open(input()).unwrap();
    let business = nested.join("business.txt");
    fs::write(&business, b"preserve original business state").unwrap();
    assert!(!plan.from.data_root.join(WRITERS).exists());
    let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    coordinator
        .advance("nested-writer", Phase::Planned, Phase::Stopping)
        .unwrap();
    assert_eq!(
        coordinator
            .advance("nested-writer", Phase::Stopping, Phase::Stopped)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Stopping
    );
    assert!(!plan.target.data_root.exists() && !plan.target.cache_root.exists());
    assert_eq!(
        fs::read(&business).unwrap(),
        b"preserve original business state"
    );
    assert!(!nested.join("settings.json").exists());

    drop(writer);
    coordinator
        .advance("nested-writer", Phase::Stopping, Phase::Stopped)
        .unwrap();
    assert_eq!(
        StorageInstance::open(input()).err().unwrap().to_string(),
        "STORAGE_MIGRATION_BUSY"
    );
    assert_eq!(
        fs::read(&business).unwrap(),
        b"preserve original business state"
    );
    assert!(!nested.join("settings.json").exists());
}

#[test]
fn a_new_nested_registration_cannot_pass_a_migration_that_already_scanned() {
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("Data");
    fs::create_dir(&parent).unwrap();
    let nested = parent.join("new/Profile");
    let mut migration = Vec::new();
    RootLease::exclusive_tree_existing(&parent, &mut migration).unwrap();
    let starting = RootLease::shared(&nested, false).unwrap();
    assert_eq!(
        RootLease::with_shared_ancestors(starting)
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_BUSY"
    );
    assert!(!nested.join("settings.json").exists());

    // A later half-registered startup need not trigger another tree scan. Its
    // own registration is harmless while our parent exclusive fence is held.
    let starting = RootLease::shared(&nested, true).unwrap();
    RootLease::exclusive_tree_existing(&parent, &mut migration).unwrap();
    assert_eq!(
        RootLease::with_shared_ancestors(starting)
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_BUSY"
    );
    drop(migration);
    assert!(RootLease::shared_with_ancestors(&nested, true).is_ok());
}

#[test]
fn own_registration_precedes_the_ancestor_recheck_and_failed_scans_are_not_cached() {
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("Data");
    let nested = parent.join("nested/Profile");
    let starting = RootLease::shared(&nested, false).unwrap();
    assert!(!parent.join(WRITERS).exists());
    let parent_lease = RootLease::exclusive_existing(&parent, &[])
        .unwrap()
        .unwrap();
    assert_eq!(
        RootLease::with_shared_ancestors(starting)
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_MIGRATION_BUSY"
    );
    drop(parent_lease);

    // An active nested writer predates the migration's first parent fence.
    // Failing that scan must release its partial parent lease before retry.
    fs::remove_file(parent.join(WRITERS)).unwrap();
    let writer = RootLease::shared_with_ancestors(&nested, true).unwrap();
    let mut migration = Vec::new();
    assert_eq!(
        RootLease::exclusive_tree_existing(&parent, &mut migration)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    assert!(migration.is_empty());
    drop(writer);
    RootLease::exclusive_tree_existing(&parent, &mut migration).unwrap();
    assert!(migration.iter().any(|lease| lease.path == nested));
}

#[test]
fn ordinary_ancestors_remain_untouched_and_existing_ancestor_fences_are_held() {
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("ordinary/ancestor");
    let nested = parent.join("Profile");
    let writer = RootLease::shared_with_ancestors(&nested, false).unwrap();
    for ancestor in [owned.path(), &owned.path().join("ordinary"), &parent] {
        assert!(!ancestor.join(WRITERS).exists());
    }
    drop(writer);
    drop(RootLease::shared(&parent, true).unwrap());
    let writer = RootLease::shared_with_ancestors(&nested, true).unwrap();
    assert!(writer.iter().any(|lease| lease.path == parent));
    assert_eq!(
        RootLease::exclusive_existing(&parent, &[])
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
}

#[cfg(unix)]
#[test]
fn arbitrary_subtree_links_are_not_followed_but_writer_links_are_rejected() {
    use std::os::unix::fs::symlink;
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("Data");
    let outside = owned.path().join("Outside");
    fs::create_dir(&parent).unwrap();
    let outside_writer = RootLease::shared_with_ancestors(&outside, false).unwrap();
    symlink(&outside, parent.join("external-alias")).unwrap();
    let mut migration = Vec::new();
    RootLease::exclusive_tree_existing(&parent, &mut migration).unwrap();
    assert!(!migration.iter().any(|lease| lease.path == outside));
    drop(migration);
    drop(outside_writer);

    let nested = parent.join("nested");
    fs::create_dir(&nested).unwrap();
    symlink(outside.join(WRITERS), nested.join(WRITERS)).unwrap();
    let mut migration = Vec::new();
    assert!(RootLease::exclusive_tree_existing(&parent, &mut migration).is_err());
    assert!(migration.is_empty());
    assert!(RootLease::shared_with_ancestors(&nested.join("child"), false).is_err());
    assert_eq!(fs::read(outside.join(WRITERS)).unwrap(), b"");
}

#[test]
fn hard_linked_writer_fences_are_rejected() {
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("Data");
    let nested = parent.join("nested");
    drop(RootLease::shared(&nested, false).unwrap());
    fs::hard_link(nested.join(WRITERS), owned.path().join("fence-alias")).unwrap();
    assert!(RootLease::shared_with_ancestors(&nested.join("child"), false).is_err());
    let mut migration = Vec::new();
    assert!(RootLease::exclusive_tree_existing(&parent, &mut migration).is_err());
    assert!(migration.is_empty());
}

#[cfg(unix)]
#[test]
fn replacing_a_scanned_fence_or_a_registered_root_is_rejected() {
    let owned = tempfile::tempdir().unwrap();
    let nested = owned.path().join("Data/nested");
    drop(RootLease::shared(&nested, false).unwrap());
    let directory = PrivateDirectory::open_existing(&nested).unwrap();
    let entry = directory.open_entry_handle(OsStr::new(WRITERS)).unwrap();
    let expected = entry.identity().unwrap();
    directory.atomic_replace(OsStr::new(WRITERS), b"").unwrap();
    assert_eq!(
        RootLease::exclusive_fence(&nested, &directory, &expected)
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );

    let starting = RootLease::shared(&nested, true).unwrap();
    fs::rename(&nested, owned.path().join("moved-profile")).unwrap();
    fs::create_dir(&nested).unwrap();
    assert_eq!(
        RootLease::with_shared_ancestors(starting)
            .err()
            .unwrap()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
}

#[cfg(unix)]
#[test]
fn stopped_nested_fences_keep_the_original_file_identity_on_later_checks() {
    let owned = tempfile::tempdir().unwrap();
    let parent = owned.path().join("Data");
    let nested = parent.join("nested");
    drop(RootLease::shared(&nested, false).unwrap());
    let mut migration = Vec::new();
    RootLease::exclusive_tree_existing(&parent, &mut migration).unwrap();
    PrivateDirectory::open_existing(&nested)
        .unwrap()
        .atomic_replace(OsStr::new(WRITERS), b"")
        .unwrap();
    assert_eq!(
        RootLease::exclusive_tree_existing(&parent, &mut migration)
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
}
