use super::*;
use std::time::{Duration, Instant};

thread_local! {
    static AFTER_ACQUISITION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static BEFORE_ACQUISITION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn before_acquisition() {
    BEFORE_ACQUISITION.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}
pub(super) fn after_acquisition() {
    AFTER_ACQUISITION.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}
fn fixture() -> (tempfile::TempDir, PrivateDirectory, PortableLeaseIdentity) {
    let root = crate::private_files::private_test_dir().unwrap();
    let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
    drop(
        directory
            .try_exclusive_lock(OsStr::new("lease"))
            .unwrap()
            .unwrap(),
    );
    let identity = directory
        .portable_regular_identity(OsStr::new("lease"))
        .unwrap();
    (root, directory, identity)
}
#[test]
fn portable_owner_drop_unlocks_even_while_a_duplicate_descriptor_remains() {
    let (_root, directory, identity) = fixture();
    let owner = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    let inherited = owner.file().try_clone().unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    drop(owner);
    let next = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap();
    assert!(
        next.is_some(),
        "ending the lease must not leave a duplicated/inherited descriptor holding its lock"
    );
    drop(inherited);
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none(),
        "closing an old duplicate cannot release the new owner's lease"
    );
}
#[test]
fn portable_existing_lease_contends_and_never_creates_a_missing_leaf() {
    let (root, directory, identity) = fixture();
    let first = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    let started = Instant::now();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        directory
            .try_existing_portable_lock(
                OsStr::new("missing"),
                &identity,
                PrivateLeaseMode::Exclusive
            )
            .is_err()
    );
    assert!(!root.path().join("missing").exists());
    assert_eq!(first.identity(), &identity);
    drop(first);
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_some()
    );
}
#[test]
fn portable_shared_leases_reject_exclusive_then_release() {
    let (_root, directory, identity) = fixture();
    let first = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Shared)
        .unwrap()
        .unwrap();
    let second = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Shared)
        .unwrap()
        .unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    drop((first, second));
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_some()
    );
}
#[test]
fn portable_lease_rejects_replacement_hardlinks_and_future_identity() {
    let (root, directory, identity) = fixture();
    std::fs::hard_link(root.path().join("lease"), root.path().join("alias")).unwrap();
    assert!(
        directory
            .portable_regular_identity(OsStr::new("lease"))
            .is_err()
    );
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    std::fs::remove_file(root.path().join("alias")).unwrap();
    let mut value = serde_json::to_value(&identity).unwrap();
    value["version"] = 2.into();
    assert!(serde_json::from_value::<PortableLeaseIdentity>(value).is_err());
    directory
        .atomic_replace(OsStr::new("lease"), b"replacement")
        .unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.path().join("lease")).unwrap(),
        b"replacement"
    );
}
#[test]
fn portable_lease_rechecks_the_original_name_after_locking() {
    let (root, directory, identity) = fixture();
    let path = root.path().to_owned();
    AFTER_ACQUISITION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let directory = PrivateDirectory::open_existing(&path).unwrap();
            directory
                .atomic_replace(OsStr::new("lease"), b"raced peer")
                .unwrap();
        }))
    });
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.path().join("lease")).unwrap(),
        b"raced peer"
    );
}

#[test]
fn portable_busy_lease_rejects_a_renamed_holder_and_replacement_name() {
    let (root, directory, identity) = fixture();
    let _held = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    let path = root.path().to_owned();
    BEFORE_ACQUISITION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let directory = PrivateDirectory::open_existing(&path).unwrap();
            directory
                .rename_no_replace(OsStr::new("lease"), OsStr::new("held-original"))
                .unwrap();
            directory
                .atomic_replace(OsStr::new("lease"), b"peer replacement")
                .unwrap();
        }))
    });
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.path().join("lease")).unwrap(),
        b"peer replacement"
    );
    assert!(root.path().join("held-original").exists());
}
#[cfg(unix)]
#[test]
fn a_fresh_lock_identity_does_not_preserve_an_existing_holders_exclusion() {
    let (_root, directory, original) = fixture();
    let _original_lease = directory
        .try_existing_portable_lock(OsStr::new("lease"), &original, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    directory
        .rename_no_replace(OsStr::new("lease"), OsStr::new("held-original"))
        .unwrap();
    directory.atomic_replace(OsStr::new("lease"), b"").unwrap();
    let replacement = directory
        .portable_regular_identity(OsStr::new("lease"))
        .unwrap();
    assert_ne!(original, replacement);
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &original, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    // Both leases are alive: a newly observed inode is not the old lock.
    // Owners needing lock continuity must retain an independent identity fence.
    let _replacement_lease = directory
        .try_existing_portable_lock(
            OsStr::new("lease"),
            &replacement,
            PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[test]
fn portable_lease_rejects_symlinks() {
    use std::os::unix::fs::symlink;
    let (root, directory, identity) = fixture();
    symlink("lease", root.path().join("link")).unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("link"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    let lease = directory
        .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap();
    assert!(lease.is_some());
}
#[cfg(target_os = "linux")]
#[test]
fn portable_lease_preserves_legacy_linux_identity_serialization_and_contention() {
    let (_root, directory, identity) = fixture();
    let legacy = directory
        .retention_regular_identity(OsStr::new("lease"))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&identity).unwrap(),
        serde_json::to_value(&legacy).unwrap()
    );
    let restored: PortableLeaseIdentity =
        serde_json::from_slice(&serde_json::to_vec(&legacy).unwrap()).unwrap();
    let held = directory
        .try_existing_verified_lock(OsStr::new("lease"), &legacy, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &restored, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    drop(held);
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &restored, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_some()
    );
}

#[test]
fn observed_regular_identity_is_stable_for_a_worktree_leaf() {
    let root = crate::private_files::private_test_dir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    std::fs::write(root.path().join("guide.md"), b"ordinary source").unwrap();
    let file = directory
        .open_single_link_regular_file(OsStr::new("guide.md"))
        .unwrap();
    let identity = PortableLeaseIdentity::from_regular_handle(&file).unwrap();
    assert_eq!(
        identity,
        PortableLeaseIdentity::from_regular_handle(&file).unwrap()
    );
}
#[test]
fn observed_regular_identity_rejects_a_directory_and_multiple_links() {
    let root = crate::private_files::private_test_dir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    assert!(PortableLeaseIdentity::from_regular_handle(&directory.directory).is_err());
    let leaf = root.path().join("guide.md");
    std::fs::write(&leaf, b"source").unwrap();
    let file = std::fs::File::open(&leaf).unwrap();
    let original = PortableLeaseIdentity::from_regular_handle(&file).unwrap();
    std::fs::hard_link(&leaf, root.path().join("alias.md")).unwrap();
    assert!(PortableLeaseIdentity::from_regular_handle(&file).is_err());
    assert!(PortableLeaseIdentity::from_private_regular_handle(&file).is_err());
    assert!(
        directory
            .open_single_link_regular_file(OsStr::new("guide.md"))
            .is_err()
    );
    assert!(
        directory
            .portable_retention_regular_identity(OsStr::new("guide.md"))
            .is_err()
    );
    assert_eq!(
        PortableLeaseIdentity::observe_regular_handle_metadata(&file).unwrap(),
        (original.clone(), 2)
    );
    let entry = directory.open_entry_handle(OsStr::new("guide.md")).unwrap();
    assert!(entry.identity().is_err());
    assert_eq!(entry.observe_regular_metadata().unwrap(), (original, 2));
    assert!(PortableLeaseIdentity::observe_regular_handle_metadata(&directory.directory).is_err());
}

#[test]
fn observed_directory_identity_retains_its_actual_handle_after_path_replacement() {
    let root = crate::private_files::private_test_dir().unwrap();
    let path = root.path().join("ordinary");
    std::fs::create_dir(&path).unwrap();
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let identity = directory.portable_directory_handle_identity().unwrap();
    assert_eq!(identity.kind(), PrivateFileKind::Directory);

    std::fs::rename(&path, root.path().join("original-held")).unwrap();
    std::fs::create_dir(&path).unwrap();
    let replacement = PrivateDirectory::open_existing(&path).unwrap();
    assert_eq!(
        directory.portable_directory_handle_identity().unwrap(),
        identity
    );
    assert_ne!(
        replacement.portable_directory_handle_identity().unwrap(),
        identity
    );
}

#[test]
fn observed_directory_identity_does_not_make_a_regular_handle_into_a_directory() {
    let root = crate::private_files::private_test_dir().unwrap();
    let path = root.path().join("ordinary-file");
    std::fs::write(&path, b"ordinary bytes").unwrap();
    let forged = PrivateDirectory {
        directory: std::fs::File::open(path).unwrap(),
    };
    assert!(forged.portable_directory_handle_identity().is_err());
}
