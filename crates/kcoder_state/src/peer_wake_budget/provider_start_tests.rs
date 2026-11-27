//! Provider-start proof is retained only by the original one-shot permit.
use super::*;

#[tokio::test]
async fn original_begun_permit_seals_only_one_provider_dispatch_and_never_reissues() {
    let root = kcoder_config::create_private_temp_dir("peer-claimed-provider-once").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = user(&state, "Actual original User task").await;
    let store = queue(&root);
    let witness = peer(
        &store,
        &state,
        "original-claimed",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&witness, store.revision().unwrap())
        .unwrap()
    else {
        panic!("original claimed trigger requires its one permit")
    };
    let owner = state.inspection_lifecycle_identity();
    assert!(permit.verify_provider_start(&state, &owner).is_err());
    assert!(permit.try_begin().unwrap());
    assert!(!permit.native_wake_presence().newly_inserted_into_context());
    assert!(permit.provider_dispatch_pending());
    permit.verify_provider_start(&state, &owner).unwrap();
    assert!(permit.try_mark_provider_dispatched(&state, &owner).unwrap());
    assert!(!permit.try_mark_provider_dispatched(&state, &owner).unwrap());
    assert!(!permit.provider_dispatch_pending());
    drop(permit);
    assert!(matches!(
        store
            .claim_peer_auto_wake(&witness, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));
}

#[tokio::test]
async fn later_native_user_and_rejected_expiry_cannot_revive_claimed_provider_start() {
    let root = kcoder_config::create_private_temp_dir("peer-claimed-provider-revoked").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = user(&state, "Actual original User task").await;
    let store = queue(&root);
    let first = peer(&store, &state, "before-user", AgentMessageMode::WakeIfIdle).await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&first, store.revision().unwrap())
        .unwrap()
    else {
        panic!("original first trigger requires its one permit")
    };
    assert!(permit.try_begin().unwrap());
    let _ = user(&state, "A later actual User takes ownership").await;
    assert!(
        permit
            .verify_provider_start(&state, &state.inspection_lifecycle_identity())
            .is_err()
    );
    assert!(
        permit
            .try_mark_provider_dispatched(&state, &state.inspection_lifecycle_identity())
            .is_err()
    );
    assert!(matches!(
        store
            .claim_peer_auto_wake(&first, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));

    let second = peer(
        &store,
        &state,
        "before-expiry",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&second, store.revision().unwrap())
        .unwrap()
    else {
        panic!("original second trigger requires its one permit")
    };
    assert!(permit.try_begin().unwrap());
    assert!(
        permit
            .try_begin_at(crate::now_millis() + 15 * 60 * 1000 + 1)
            .is_err()
    );
    assert!(
        permit
            .verify_provider_start(&state, &state.inspection_lifecycle_identity())
            .is_err(),
        "a rejected original permit cannot revive after a clock rollback"
    );
    assert!(matches!(
        store
            .claim_peer_auto_wake(&second, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));
}
