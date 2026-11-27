use super::*;

#[test]
fn creation_is_explicit_and_same_profile_has_stable_target_across_workspaces() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    let a = root.path().join("workspace-a");
    let b = root.path().join("workspace-b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    assert!(
        NativePeerRouterAuthority::capture(
            &RetentionParentLaunchV1::LocalOs,
            &profile,
            &profile,
            &a,
            false
        )
        .unwrap()
        .is_none()
    );
    assert!(!profile.join(NAMESPACE).exists());
    let a = NativePeerRouterAuthority::capture(
        &RetentionParentLaunchV1::LocalOs,
        &profile,
        &profile,
        &a,
        true,
    )
    .unwrap()
    .unwrap();
    let b = NativePeerRouterAuthority::capture(
        &RetentionParentLaunchV1::LocalOs,
        &profile,
        &profile,
        &b,
        false,
    )
    .unwrap()
    .unwrap();
    let ai = a.identity().unwrap();
    let bi = b.identity().unwrap();
    assert_eq!(ai.target_id, bi.target_id);
    assert_eq!(ai.public_key, bi.public_key);
    assert_eq!(ai.identity_epoch, bi.identity_epoch);
    assert_ne!(ai.workspace_id, bi.workspace_id);
}

#[test]
fn private_route_is_endpoint_bound_and_closing_its_owner_revokes_held_capability() {
    let root = tempfile::tempdir().unwrap();
    let make = |name| {
        let profile = root.path().join(name);
        PrivateDirectory::open_or_create(&profile).unwrap();
        Arc::new(
            NativePeerRouterAuthority::capture(
                &RetentionParentLaunchV1::LocalOs,
                &profile,
                &profile,
                root.path(),
                true,
            )
            .unwrap()
            .unwrap(),
        )
    };
    let source = make("source");
    let destination = make("destination");
    let proof = PrivatePeerRouteProofV1 {
        version: 1,
        purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
        authorization_id: "actual-private-owner".into(),
        source: source.identity().unwrap(),
        destination: destination.identity().unwrap(),
    };
    let route = source
        .authorize_private_route(proof.clone(), PeerRouteEndpoint::Source)
        .unwrap();
    route.verify().unwrap();
    assert!(
        source
            .authorize_private_route(proof.clone(), PeerRouteEndpoint::Destination)
            .is_err()
    );
    let dest_route = destination
        .authorize_private_route(proof.clone(), PeerRouteEndpoint::Destination)
        .unwrap();
    let mut wrong = proof;
    wrong.destination.workspace_id = "another-workspace".into();
    assert!(
        destination
            .authorize_private_route(wrong, PeerRouteEndpoint::Destination)
            .is_err()
    );
    drop(source.close_guard());
    assert!(route.verify().is_err());
    dest_route.verify().unwrap();
}

#[test]
fn original_workspace_and_profile_handles_cannot_be_redirected() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let workspace = root.path().join("workspace");
    PrivateDirectory::open_or_create(&profile).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let authority = NativePeerRouterAuthority::capture(
        &RetentionParentLaunchV1::LocalOs,
        &profile,
        &profile,
        &workspace,
        true,
    )
    .unwrap()
    .unwrap();
    std::fs::rename(&workspace, root.path().join("original-workspace")).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    assert!(authority.identity().is_err());
    assert!(std::fs::read_dir(&workspace).unwrap().next().is_none());
    let other = root.path().join("other-profile");
    PrivateDirectory::open_or_create(&other).unwrap();
    assert!(
        NativePeerRouterAuthority::capture(
            &RetentionParentLaunchV1::LocalOs,
            &profile,
            &other,
            &workspace,
            true
        )
        .is_err()
    );
    assert!(!other.join(NAMESPACE).exists());
}
