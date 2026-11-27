use super::*;

#[test]
fn recovery_is_a_separate_restricted_role_and_uses_the_stored_authenticated_grant() {
    let (root, authority) = super::tests::owned();
    let profile = root.path().join("profile");
    let target = IncomingTransfers::open(&profile).unwrap();
    let source = SourceTransfers::open(&root.path().join("offline-source")).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    target
        .issue_destination(&request, source.authority())
        .unwrap();
    std::fs::remove_dir_all(root.path().join("offline-source")).unwrap();
    let (reference, actual_target) = authority.recover_target(&request).unwrap();
    assert!(actual_target == *target.authority());
    let peer = authority.peer(&request, &reference).unwrap();
    assert!(peer.source_authority() == source.authority());
    for operation in [
        "target/state",
        "target/summary",
        "target/receipt",
        "target/cancel",
        "target/resume",
        "target/finish",
    ] {
        assert!(peer.permits(operation));
    }
    for operation in [
        "source/state",
        "source/cancel",
        "target/grant",
        "target/begin",
        "target/part/write",
        "target/part/read",
    ] {
        assert!(!peer.permits(operation));
    }
    assert_eq!(authority.recover_target(&request).unwrap().0, reference);
    assert!(
        authority
            .peer(&uuid::Uuid::new_v4().to_string(), &reference)
            .is_err()
    );
    authority.close();
    assert!(peer.validate().is_err());
}

#[test]
fn recovery_never_bootstraps_missing_native_identity_or_incoming_role() {
    let (root, authority) = super::tests::owned();
    let profile = root.path().join("profile");
    let request = uuid::Uuid::new_v4().to_string();
    assert!(authority.recover_target(&request).is_err());
    assert!(!profile.join("migrations").exists());
    authority.identity().unwrap();
    assert!(authority.recover_target(&request).is_err());
    assert!(!profile.join("migrations/source-transfer/incoming").exists());
    let target = IncomingTransfers::open(&profile).unwrap();
    let source = SourceTransfers::open(&root.path().join("source")).unwrap();
    target
        .issue_destination(&request, source.authority())
        .unwrap();
    let (reference, _) = authority.recover_target(&request).unwrap();
    let peer = authority.peer(&request, &reference).unwrap();
    let identity = profile.join("migrations/source-transfer/native.json");
    std::fs::remove_file(&identity).unwrap();
    assert!(authority.recover_target(&request).is_err());
    assert!(peer.validate().is_err());
    assert!(!identity.exists());
}

#[test]
fn recovered_and_full_target_peers_coexist_without_expanding_the_restricted_reference() {
    let (root, authority) = super::tests::owned();
    let mut proof = super::tests::proof(&authority);
    let target = IncomingTransfers::open(&root.path().join("profile")).unwrap();
    let source = SourceTransfers::open(&root.path().join("source")).unwrap();
    proof.source.authority.instance_id = source.authority().instance_id.clone();
    proof.source.authority.account_id = source.authority().account_id.clone();
    target
        .issue_destination(&proof.request_id, source.authority())
        .unwrap();
    let paired = authority
        .accept(MigrationSourceRoleV1::Target, proof.clone())
        .unwrap();
    let recovered = authority.recover_target(&proof.request_id).unwrap().0;
    assert_ne!(paired, recovered);
    assert!(
        authority
            .peer(&proof.request_id, &paired)
            .unwrap()
            .permits("target/begin")
    );
    assert!(
        !authority
            .peer(&proof.request_id, &recovered)
            .unwrap()
            .permits("target/begin")
    );
    let profile = root.path().join("profile");
    std::fs::rename(&profile, root.path().join("old-profile")).unwrap();
    PrivateDirectory::open_or_create(&profile).unwrap();
    assert!(authority.recover_target(&proof.request_id).is_err());
    assert!(!profile.join("migrations").exists());
}
