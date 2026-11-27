use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::{collections::BTreeSet, ffi::OsStr, fs};

fn open_root(path: &Path) -> PrivateDirectory {
    PrivateDirectory::open_existing(path).unwrap()
}

#[test]
fn automatic_fence_exclusion_uses_held_identity_and_not_the_reserved_basename() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(root_path.join("unknown")).unwrap();
    fs::write(
        root_path.join("unknown/kcoder-storage-writers.lock"),
        b"persistent user data",
    )
    .unwrap();
    let lease = super::super::writers::RootLease::shared(&root_path, false).unwrap();
    let inventory = inventory_tree_with_fences(
        &open_root(&root_path),
        &BTreeSet::new(),
        &BTreeSet::from([lease.fence_identity().unwrap()]),
    )
    .unwrap();
    let held = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("kcoder-storage-writers.lock"))
        .unwrap();
    assert!(held.excluded && held.sha256.is_none());
    let unknown = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("unknown/kcoder-storage-writers.lock"))
        .unwrap();
    assert!(!unknown.excluded && unknown.sha256.is_some());
    // The copy verifier reconstructs exact exclusions from the recorded facts.
    assert_eq!(
        inventory_tree(
            &open_root(&root_path),
            &BTreeSet::from([held.relative_path.clone()])
        )
        .unwrap(),
        inventory
    );
}

fn paths(inventory: &StorageTreeInventory) -> Vec<String> {
    inventory
        .entries
        .iter()
        .map(|entry| entry.relative_path.to_string_lossy().replace('\\', "/"))
        .collect()
}

#[test]
fn only_exact_owner_exclusions_observe_linked_regular_files_without_reading_the_payload() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(root_path.join("epoch")).unwrap();
    fs::create_dir(root_path.join("projection.state")).unwrap();
    fs::write(root_path.join("projection"), b"owner linked projection").unwrap();
    let file = fs::File::open(root_path.join("projection")).unwrap();
    let identity = PortableLeaseIdentity::from_regular_handle(&file).unwrap();
    fs::hard_link(
        root_path.join("projection"),
        root_path.join("epoch/marker.json"),
    )
    .unwrap();
    let root = open_root(&root_path);
    let exclusions = BTreeSet::from([
        PathBuf::from("projection"),
        PathBuf::from("projection.state"),
        PathBuf::from("epoch"),
    ]);
    let mut payload_reads = 0;

    let inventory =
        inventory_tree_with_hook(&root, &exclusions, &BTreeSet::new(), |_| payload_reads += 1)
            .unwrap();

    assert_eq!(payload_reads, 0);
    assert_eq!(inventory.entries.len(), 3);
    let projection = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("projection"))
        .unwrap();
    assert_eq!(
        projection.identity,
        serde_json::to_string(&identity).unwrap()
    );
    assert!(projection.excluded && projection.sha256.is_none());
    assert_eq!(
        projection.size_bytes,
        Some(b"owner linked projection".len() as u64)
    );
    assert!(inventory_tree(&root, &BTreeSet::new()).is_err());
    fs::hard_link(
        root_path.join("projection"),
        root_path.join("unowned-same-bytes"),
    )
    .unwrap();
    assert!(inventory_tree(&root, &exclusions).is_err());
}

#[test]
fn excluded_linked_regular_metadata_and_link_count_are_rechecked_within_the_frame() {
    for change_links in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join("root");
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("projection"), b"owner bytes").unwrap();
        fs::write(root_path.join("z-record"), b"ordinary bytes").unwrap();
        let alias = temp.path().join("owner-marker");
        fs::hard_link(root_path.join("projection"), &alias).unwrap();
        let mut changed = false;
        let result = inventory_tree_with_hook(
            &open_root(&root_path),
            &BTreeSet::from([PathBuf::from("projection")]),
            &BTreeSet::new(),
            |relative| {
                if relative == Path::new("z-record") && !changed {
                    if change_links {
                        fs::remove_file(&alias).unwrap();
                    } else {
                        fs::write(
                            root_path.join("projection"),
                            b"changed owner payload length",
                        )
                        .unwrap();
                    }
                    changed = true;
                }
            },
        );
        assert!(changed);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("storage_inventory_source_changed")
        );
    }
}

#[test]
fn inventories_regular_files_empty_directories_and_only_exact_exclusions() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(root_path.join("empty")).unwrap();
    fs::create_dir(root_path.join("nested")).unwrap();
    let ordinary_path = root_path.join("nested/record.json");
    fs::write(&ordinary_path, b"{}\n").unwrap();
    fs::write(root_path.join("kcoder-storage-writers.lock"), b"lease").unwrap();
    fs::write(root_path.join("other.lock"), b"retain me").unwrap();

    let root = open_root(&root_path);
    let exclusions = BTreeSet::from([PathBuf::from("kcoder-storage-writers.lock")]);
    let inventory = inventory_tree(&root, &exclusions).unwrap();

    assert_eq!(
        paths(&inventory),
        [
            "empty",
            "kcoder-storage-writers.lock",
            "nested",
            "nested/record.json",
            "other.lock"
        ]
    );
    assert!(!inventory.entries[0].excluded);
    assert_eq!(inventory.entries[0].kind, StorageTreeEntryKind::Directory);
    assert_eq!(inventory.entries[0].sha256, None);

    let lease = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("kcoder-storage-writers.lock"))
        .unwrap();
    assert!(lease.excluded);
    assert_eq!(lease.size_bytes, Some(5));
    assert_eq!(lease.sha256, None);

    let ordinary = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("nested/record.json"))
        .unwrap();
    assert_eq!(ordinary.size_bytes, Some(3));
    assert_eq!(
        ordinary.sha256.as_deref(),
        Some("ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356")
    );
    let nested = root.open_entry_handle(OsStr::new("nested")).unwrap();
    let nested_directory = nested.open_child_directory().unwrap();
    assert_eq!(
        nested.identity().unwrap(),
        nested_directory.directory_identity().unwrap()
    );
    let record = nested_directory
        .open_entry_handle(OsStr::new("record.json"))
        .unwrap();
    assert_eq!(ordinary.identity, record.identity().unwrap());
    let record_file = nested_directory
        .open_regular_file_snapshot(OsStr::new("record.json"))
        .unwrap();
    assert_eq!(
        ordinary.identity,
        regular_handle_identity(&record_file).unwrap()
    );

    let unknown_lock = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("other.lock"))
        .unwrap();
    assert!(!unknown_lock.excluded);
    assert!(unknown_lock.sha256.is_some());
}

#[test]
#[cfg(unix)]
fn inventories_symlink_object_without_following_external_target() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    let outside = temp.path().join("outside.txt");
    fs::create_dir(&root_path).unwrap();
    fs::write(&outside, b"outside data").unwrap();
    symlink(&outside, root_path.join("external-link")).unwrap();

    let inventory = inventory_tree(&open_root(&root_path), &BTreeSet::new()).unwrap();
    let link = inventory
        .entries
        .iter()
        .find(|entry| entry.relative_path == Path::new("external-link"))
        .unwrap();

    assert_eq!(link.kind, StorageTreeEntryKind::Symlink);
    assert_eq!(
        link.identity,
        open_root(&root_path)
            .open_entry_handle(OsStr::new("external-link"))
            .unwrap()
            .identity()
            .unwrap()
    );
    assert!(link.identity.starts_with("unix:"));
    assert_eq!(link.size_bytes, None);
    assert_eq!(link.sha256, None);
    assert_eq!(inventory.entries.len(), 1);
    assert_eq!(fs::read(outside).unwrap(), b"outside data");
}

#[test]
fn rejects_a_regular_file_with_changed_length_before_its_hash() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("record"), b"before").unwrap();
    let root = open_root(&root_path);
    let mut changed = false;

    let result = inventory_tree_with_hook(&root, &BTreeSet::new(), &BTreeSet::new(), |relative| {
        if relative == Path::new("record") && !changed {
            // A length change is observable even on filesystems whose timestamps
            // do not advance between two same-size writes in the same clock tick.
            fs::write(root_path.join("record"), b"changed length").unwrap();
            changed = true;
        }
    });

    assert!(changed);
    assert!(result.is_err());
}

#[test]
fn a_same_length_write_before_hashing_never_returns_the_old_content_digest() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("record"), b"before").unwrap();
    let mut changed = false;
    let result = inventory_tree_with_hook(
        &open_root(&root_path),
        &BTreeSet::new(),
        &BTreeSet::new(),
        |relative| {
            if relative == Path::new("record") && !changed {
                fs::write(root_path.join("record"), b"after!").unwrap();
                changed = true;
            }
        },
    );
    assert!(changed);
    match result {
        Ok(inventory) => {
            // The hook runs before the first content read. Coarse identical
            // metadata can therefore describe a coherent new snapshot, never
            // proof that the previous bytes were read or remained unchanged.
            assert_eq!(inventory.entries.len(), 1);
            assert_eq!(
                inventory.entries[0].sha256.as_deref(),
                Some(format!("{:x}", Sha256::digest(b"after!")).as_str())
            );
        }
        Err(error) => assert!(
            error
                .to_string()
                .contains("storage_inventory_source_changed")
        ),
    }
}

#[test]
fn rejects_an_unregistered_entry_added_while_scanning() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("known"), b"known").unwrap();
    let root = open_root(&root_path);
    let mut added = false;

    let result = inventory_tree_with_hook(&root, &BTreeSet::new(), &BTreeSet::new(), |relative| {
        if relative == Path::new("known") && !added {
            fs::write(root_path.join("unregistered"), b"preserve").unwrap();
            added = true;
        }
    });

    assert!(added);
    let error = result.unwrap_err().to_string();
    assert!(error.contains("storage_inventory_source_changed"));
    assert_eq!(
        fs::read(root_path.join("unregistered")).unwrap(),
        b"preserve"
    );
}

#[test]
#[cfg(unix)]
fn explicit_owner_subtrees_and_links_are_recorded_without_following_them() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join("root");
    let outside = temp.path().join("outside");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(root_path.join("dir")).unwrap();
    fs::write(
        root_path.join("dir/cache-payload"),
        b"owned by cache adapter",
    )
    .unwrap();
    fs::write(&outside, b"outside").unwrap();
    symlink(&outside, root_path.join("link")).unwrap();
    let root = open_root(&root_path);

    let inventory = inventory_tree(
        &root,
        &BTreeSet::from([PathBuf::from("dir"), PathBuf::from("link")]),
    )
    .unwrap();
    assert_eq!(inventory.entries.len(), 2);
    assert!(
        inventory
            .entries
            .iter()
            .all(|entry| entry.excluded && entry.sha256.is_none())
    );
    assert_eq!(inventory.entries[0].kind, StorageTreeEntryKind::Directory);
    assert_eq!(inventory.entries[1].kind, StorageTreeEntryKind::Symlink);
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
}
