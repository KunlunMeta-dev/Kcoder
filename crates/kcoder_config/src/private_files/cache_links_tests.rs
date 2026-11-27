use super::*;

fn fixture() -> (tempfile::TempDir, PrivateDirectory, PathBuf) {
    let owned = tempfile::tempdir().unwrap();
    let target = owned.path().join("target");
    std::fs::create_dir(&target).unwrap();
    let parent = PrivateDirectory::open_config_root(&owned.path().join("parent")).unwrap();
    (owned, parent, target)
}

#[test]
fn directory_links_are_explicit_and_never_change_ordinary_directory_opening() {
    let (_owned, parent, target) = fixture();
    let link = parent
        .create_directory_link(OsStr::new("link"), &target)
        .unwrap();
    assert!(link.metadata().file_type().is_symlink());
    assert!(!link.identity().unwrap().is_empty());
    assert!(link.directory_link_target().unwrap().ends_with("target"));
    assert!(parent.open_child(OsStr::new("link"), false).is_err());
    assert!(link.open_child_directory().is_err());
}

#[test]
fn creation_and_publication_never_replace_an_existing_name() {
    let (owned, parent, target) = fixture();
    parent.create_child(OsStr::new("occupied")).unwrap();
    std::fs::write(owned.path().join("parent/occupied/keep"), b"unknown").unwrap();
    assert!(
        parent
            .create_directory_link(OsStr::new("occupied"), &target)
            .is_err()
    );
    let link = parent
        .create_directory_link(OsStr::new("stage"), &target)
        .unwrap();
    assert!(
        link.rename_directory_entry_no_replace(OsStr::new("occupied"))
            .is_err()
    );
    assert_eq!(
        std::fs::read(owned.path().join("parent/occupied/keep")).unwrap(),
        b"unknown"
    );
    assert!(
        owned
            .path()
            .join("parent/stage")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn retaining_an_ordinary_directory_preserves_identity_and_contents() {
    let (owned, parent, _target) = fixture();
    let original = parent.create_child(OsStr::new("Cache")).unwrap();
    std::fs::write(owned.path().join("parent/Cache/keep"), b"original").unwrap();
    let entry = parent.open_entry_handle(OsStr::new("Cache")).unwrap();
    let identity = entry.identity().unwrap();
    entry
        .rename_directory_entry_no_replace(OsStr::new("retained"))
        .unwrap();
    assert_eq!(
        parent
            .open_entry_handle(OsStr::new("retained"))
            .unwrap()
            .identity()
            .unwrap(),
        identity
    );
    assert_eq!(original.directory_identity().unwrap(), identity);
    assert_eq!(
        std::fs::read(owned.path().join("parent/retained/keep")).unwrap(),
        b"original"
    );
}

#[test]
fn directory_rename_with_held_fences_respects_platform_rules() {
    let (_owned, parent, _target) = fixture();
    let original = parent.create_child(OsStr::new("stage")).unwrap();
    let name = OsStr::new("kcoder-storage-writers.lock");
    let lease = original.try_exclusive_lock(name).unwrap().unwrap();
    let secondary = original
        .open_read_write_file(OsStr::new("kcoder-storage-instances.lock"), true)
        .unwrap();
    let identity = private_file_identity(&lease).unwrap();
    let renamed = parent
        .open_entry_handle(OsStr::new("stage"))
        .unwrap()
        .rename_directory_entry_no_replace(OsStr::new("retained"));
    #[cfg(windows)]
    if let Err(error) = &renamed {
        assert!(error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
        }));
        assert_eq!(
            parent
                .open_child(OsStr::new("stage"), false)
                .unwrap()
                .directory_identity()
                .unwrap(),
            original.directory_identity().unwrap()
        );
        assert!(parent.open_entry_handle(OsStr::new("retained")).is_err());
        assert_eq!(
            private_file_identity(&original.open_single_link_regular_file(name).unwrap()).unwrap(),
            identity
        );
        assert!(original.try_existing_shared_lock(name).unwrap().is_none());
        return;
    }
    renamed.unwrap();
    let retained = parent.open_child(OsStr::new("retained"), false).unwrap();
    assert_eq!(
        private_file_identity(&retained.open_single_link_regular_file(name).unwrap()).unwrap(),
        identity
    );
    assert!(
        retained
            .try_existing_exclusive_lock(name)
            .unwrap()
            .is_none()
    );
    drop(lease);
    assert!(
        retained
            .try_existing_exclusive_lock(name)
            .unwrap()
            .is_some()
    );
    drop(secondary);
}

#[test]
fn a_replaced_source_entry_is_not_published_or_removed() {
    let (owned, parent, target) = fixture();
    let original = parent
        .create_directory_link(OsStr::new("stage"), &target)
        .unwrap();
    parent
        .rename_no_replace(OsStr::new("stage"), OsStr::new("original"))
        .unwrap();
    parent.create_child(OsStr::new("stage")).unwrap();
    std::fs::write(owned.path().join("parent/stage/keep"), b"replacement").unwrap();
    assert!(
        original
            .rename_directory_entry_no_replace(OsStr::new("Cache"))
            .is_err()
    );
    assert_eq!(
        std::fs::read(owned.path().join("parent/stage/keep")).unwrap(),
        b"replacement"
    );
    assert!(parent.open_entry_handle(OsStr::new("Cache")).is_err());
    assert_eq!(
        parent
            .open_entry_handle(OsStr::new("original"))
            .unwrap()
            .identity()
            .unwrap(),
        original.identity().unwrap()
    );
}

#[test]
fn creating_and_renaming_remain_bound_to_the_held_parent() {
    let (owned, parent, target) = fixture();
    std::fs::rename(
        owned.path().join("parent"),
        owned.path().join("held-original"),
    )
    .unwrap();
    std::fs::create_dir(owned.path().join("parent")).unwrap();
    std::fs::write(owned.path().join("parent/keep"), b"unrelated").unwrap();
    let link = parent
        .create_directory_link(OsStr::new("stage"), &target)
        .unwrap();
    link.rename_directory_entry_no_replace(OsStr::new("Cache"))
        .unwrap();
    assert!(
        owned
            .path()
            .join("held-original/Cache")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!owned.path().join("parent/Cache").exists());
    assert_eq!(
        std::fs::read(owned.path().join("parent/keep")).unwrap(),
        b"unrelated"
    );
}

#[cfg(unix)]
#[test]
fn a_hard_link_to_a_symlink_does_not_grant_link_authority() {
    let (owned, parent, target) = fixture();
    parent
        .create_directory_link(OsStr::new("stage"), &target)
        .unwrap();
    std::fs::hard_link(
        owned.path().join("parent/stage"),
        owned.path().join("parent/alias"),
    )
    .unwrap();
    assert!(
        parent
            .open_entry_handle(OsStr::new("stage"))
            .unwrap()
            .directory_link_target()
            .is_err()
    );
}
