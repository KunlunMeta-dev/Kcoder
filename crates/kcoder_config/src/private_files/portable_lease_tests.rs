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
    let root = tempfile::tempdir().unwrap();
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
fn portable_lease_rejects_symlink_and_unsafe_mode_without_repair() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (root, directory, identity) = fixture();
    symlink("lease", root.path().join("link")).unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("link"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    std::fs::set_permissions(
        root.path().join("lease"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .is_err()
    );
    assert_eq!(
        std::fs::metadata(root.path().join("lease"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
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
fn observed_regular_identity_accepts_a_worktree_leaf_without_granting_a_private_lease() {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    std::fs::write(root.path().join("guide.md"), b"ordinary source").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            root.path().join("guide.md"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }
    let file = directory
        .open_single_link_regular_file(OsStr::new("guide.md"))
        .unwrap();
    let identity = PortableLeaseIdentity::from_regular_handle(&file).unwrap();
    assert_eq!(
        identity,
        PortableLeaseIdentity::from_regular_handle(&file).unwrap()
    );
    #[cfg(unix)]
    assert!(
        directory
            .try_existing_portable_lock(OsStr::new("guide.md"), &identity, PrivateLeaseMode::Shared)
            .is_err()
    );
}
#[test]
fn observed_regular_identity_rejects_a_directory_and_multiple_links() {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    assert!(PortableLeaseIdentity::from_regular_handle(&directory.directory).is_err());
    let leaf = root.path().join("guide.md");
    std::fs::write(&leaf, b"source").unwrap();
    std::fs::hard_link(&leaf, root.path().join("alias.md")).unwrap();
    assert!(
        PortableLeaseIdentity::from_regular_handle(&std::fs::File::open(leaf).unwrap()).is_err()
    );
}
