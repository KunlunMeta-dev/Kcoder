//! Linux native inode publication and exact-leaf removal primitives. Ordinary
//! temporary fixtures are sufficient here; service tests enforce durable FS.
use super::*;
use std::io::Read;
use std::os::unix::fs::MetadataExt;

#[test]
fn retention_anonymous_identity_precedes_noreplace_link_and_drop_leaves_no_temp() {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let mut anonymous = parent.create_anonymous_private_entry().unwrap();
    let original = anonymous.identity().clone();
    assert_eq!(anonymous.file().metadata().unwrap().nlink(), 0);
    anonymous.seal(b"sealed manifest bytes").unwrap();
    assert_eq!(parent.count_regular_files_bounded(|_| true, 1).unwrap(), 0);
    let published = parent
        .publish_anonymous_private_entry(&anonymous, OsStr::new("manifest"))
        .unwrap();
    parent.sync().unwrap();
    assert_eq!(*published.identity(), original);
    assert_eq!(published.file().metadata().unwrap().nlink(), 1);
    assert!(published.try_exclusive_lease().unwrap());
    drop(anonymous);
    parent
        .open_verified_regular(OsStr::new("manifest"), &original)
        .unwrap();
    let mut unlinked = parent.create_anonymous_private_entry().unwrap();
    unlinked.seal(b"not published").unwrap();
    drop(unlinked);
    assert_eq!(parent.count_regular_files_bounded(|_| true, 2).unwrap(), 1);
}

#[test]
fn retention_anonymous_foreign_eexist_and_cross_parent_leave_original_inodes_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
    parent
        .atomic_replace(OsStr::new("foreign"), b"foreign bytes")
        .unwrap();
    let foreign = parent
        .retention_regular_identity(OsStr::new("foreign"))
        .unwrap();
    let mut anonymous = parent.create_anonymous_private_entry().unwrap();
    anonymous.seal(b"owner bytes").unwrap();
    let error = parent
        .publish_anonymous_private_entry(&anonymous, OsStr::new("foreign"))
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::EEXIST))
    );
    assert_eq!(anonymous.file().metadata().unwrap().nlink(), 0);
    assert_eq!(
        parent
            .retention_regular_identity(OsStr::new("foreign"))
            .unwrap(),
        foreign
    );
    let other = parent.open_child(OsStr::new("other"), true).unwrap();
    assert!(
        other
            .publish_anonymous_private_entry(&anonymous, OsStr::new("manifest"))
            .is_err()
    );
    let mut bytes = Vec::new();
    parent
        .open_regular_file(OsStr::new("foreign"))
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"foreign bytes");
}

#[test]
fn retention_exact_leaf_unlink_preserves_more_than_manifest_bound_siblings() {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
    let root_identity = parent.retention_identity().unwrap();
    let mut siblings = Vec::new();
    for index in 0..64 {
        let name = format!("sibling-{index}");
        parent
            .atomic_replace(OsStr::new(&name), name.as_bytes())
            .unwrap();
        siblings.push((
            name.clone(),
            parent
                .retention_regular_identity(OsStr::new(&name))
                .unwrap(),
        ));
    }
    parent
        .atomic_replace(OsStr::new("owned"), b"owner")
        .unwrap();
    let own = parent
        .retention_regular_identity(OsStr::new("owned"))
        .unwrap();
    parent
        .quarantine_verified_entry_unflushed(OsStr::new("owned"), &own, OsStr::new("q-owned"))
        .unwrap();
    parent.sync().unwrap();
    parent
        .unlink_verified_regular_leaf_unflushed(OsStr::new("q-owned"), &own)
        .unwrap();
    parent.sync().unwrap();
    for (name, identity) in siblings {
        parent
            .open_verified_regular(OsStr::new(&name), &identity)
            .unwrap();
    }
    assert_eq!(parent.retention_identity().unwrap(), root_identity);
    assert_eq!(
        parent.count_regular_files_bounded(|_| true, 65).unwrap(),
        64
    );
}

#[test]
fn retention_exact_leaf_replacement_is_not_deleted() {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
    parent
        .atomic_replace(OsStr::new("q-owned"), b"owner")
        .unwrap();
    let original = parent
        .retention_regular_identity(OsStr::new("q-owned"))
        .unwrap();
    parent
        .atomic_replace(OsStr::new("q-owned"), b"foreign")
        .unwrap();
    let foreign = parent
        .retention_regular_identity(OsStr::new("q-owned"))
        .unwrap();
    assert!(
        parent
            .unlink_verified_regular_leaf_unflushed(OsStr::new("q-owned"), &original)
            .is_err()
    );
    assert_eq!(
        parent
            .retention_regular_identity(OsStr::new("q-owned"))
            .unwrap(),
        foreign
    );
}
