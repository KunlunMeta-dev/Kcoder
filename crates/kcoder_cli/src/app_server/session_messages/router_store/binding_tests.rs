use super::*;

#[test]
fn cold_router_copy_keeps_original_signatures_unknown_dispatch_and_lock() {
    let (root, parent, store) = owned();
    let (source, intent) = request(&store);
    let identity = store.identity("workspace-a").unwrap();
    store
        .prepare("original-operation", source.clone(), &intent)
        .unwrap();
    let unknown = store.mark_dispatching("original-operation").unwrap();
    store
        .access_requiring_archive(|_, _| Ok(((), false)))
        .unwrap();
    let header = read(&store.directory, HEADER, 8192).unwrap();
    let key = read(&store.directory, KEY, 1024).unwrap();
    let data = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&data).unwrap();
    let archive_name = manifest["binding"]["child"].as_str().unwrap();
    let original_lock = store.header.lock_identity.clone();
    drop(store);

    for index in 0..2 {
        let old_path = root.path().join(format!("old-router-{index}"));
        std::fs::rename(root.path().join("profile/peer-router-v1"), &old_path).unwrap();
        let directory = parent
            .create_private_child(OsStr::new("peer-router-v1"))
            .unwrap();
        for (name, bytes) in [(HEADER, &header), (KEY, &key), (DATA, &data)] {
            directory.atomic_replace(OsStr::new(name), bytes).unwrap();
        }
        let archive = directory
            .create_private_child(OsStr::new(archive_name))
            .unwrap();
        for entry in std::fs::read_dir(old_path.join(archive_name)).unwrap() {
            let entry = entry.unwrap();
            archive
                .atomic_replace(&entry.file_name(), &std::fs::read(entry.path()).unwrap())
                .unwrap();
        }
        // A fresh lock must never substitute for the original mutex.
        drop(
            directory
                .open_read_write_file(OsStr::new(LOCK), true)
                .unwrap(),
        );
        assert!(
            NativePeerRouterStore::open_in(
                &parent,
                OsStr::new("peer-router-v1"),
                &RetentionPrincipalV1::LocalOs,
            )
            .is_err()
        );
        std::fs::remove_file(root.path().join("profile/peer-router-v1").join(LOCK)).unwrap();
        std::fs::rename(
            old_path.join(LOCK),
            root.path().join("profile/peer-router-v1").join(LOCK),
        )
        .unwrap();
        assert_eq!(
            directory
                .portable_regular_identity(OsStr::new(LOCK))
                .unwrap(),
            original_lock
        );
        assert!(
            NativePeerRouterStore::open_in(
                &parent,
                OsStr::new("peer-router-v1"),
                &RetentionPrincipalV1::LocalOs,
            )
            .is_err(),
            "a copied setup lock must not replace the original archive mutex"
        );
        let setup = root
            .path()
            .join("profile/peer-router-v1")
            .join(archive_name)
            .join("setup.lock");
        std::fs::remove_file(&setup).unwrap();
        std::fs::rename(old_path.join(archive_name).join("setup.lock"), setup).unwrap();
        let reopened = NativePeerRouterStore::open_in(
            &parent,
            OsStr::new("peer-router-v1"),
            &RetentionPrincipalV1::LocalOs,
        )
        .unwrap()
        .unwrap();
        assert_eq!(reopened.identity("workspace-a").unwrap(), identity);
        verify_peer_attestation(&unknown.attestation, &identity).unwrap();
        assert_eq!(
            reopened.read_operation("original-operation").unwrap(),
            Some(unknown.clone())
        );
        assert_eq!(
            reopened
                .prepare("original-operation", source.clone(), &intent)
                .unwrap(),
            unknown
        );
        assert_eq!(read(&directory, HEADER, 8192).unwrap(), header);
        assert_eq!(read(&directory, KEY, 1024).unwrap(), key);
        assert_eq!(read(&directory, DATA, MAX_DATA_BYTES).unwrap(), data);
    }
}

#[test]
fn current_router_anchors_reject_replacement_and_cold_open_verifies_original_key() {
    let (_root, parent, store) = owned();
    let identity = store.identity("workspace-a").unwrap();
    let key = read(&store.directory, KEY, 1024).unwrap();
    store
        .directory
        .atomic_replace(OsStr::new(KEY), &key)
        .unwrap();
    assert!(store.identity("workspace-a").is_err());
    drop(store);
    let store = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    assert_eq!(store.identity("workspace-a").unwrap(), identity);
    let different = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    store
        .directory
        .atomic_replace(OsStr::new(KEY), different.as_ref())
        .unwrap();
    assert!(store.identity("workspace-a").is_err());
    drop(store);
    assert!(
        NativePeerRouterStore::open_in(
            &parent,
            OsStr::new("peer-router-v1"),
            &RetentionPrincipalV1::LocalOs,
        )
        .is_err()
    );
}
