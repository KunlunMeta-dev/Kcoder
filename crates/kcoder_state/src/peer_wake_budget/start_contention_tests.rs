//! Contention retains the original object; hard denial never creates a retry.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn original_permit_survives_known_state_and_kernel_read_contention_without_a_new_claim() {
    let root = kcoder_config::create_private_temp_dir("peer-original-permit-busy").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = user(&state, "Original actual User").await;
    let store = queue(&root);
    let witness = peer(
        &store,
        &state,
        "original-busy",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&witness, store.revision().unwrap())
        .unwrap()
    else {
        panic!("one original permit is required")
    };
    let marker = permit.marker.clone();
    let pointer = (&*permit) as *const PeerAutoWakePermit;
    let owner = state.inspection_lifecycle_identity();
    {
        let _writer = state.inner.write().unwrap();
        let error = permit.try_begin().unwrap_err();
        assert!(permit.can_retry_begin_after_contention(&error));
        assert!(!permit.started.load(Ordering::Acquire));
        assert!(!permit.begin_succeeded.load(Ordering::Acquire));
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("wake-queue/messages.lock"))
        .unwrap();
    fs2::FileExt::lock_exclusive(&file).unwrap();
    let error = permit.try_begin().unwrap_err();
    assert!(permit.can_retry_begin_after_contention(&error));
    fs2::FileExt::unlock(&file).unwrap();
    assert_eq!(pointer, (&*permit) as *const PeerAutoWakePermit);
    assert_eq!(marker, permit.marker);
    assert!(permit.try_begin().unwrap());
    assert!(!permit.can_retry_begin_after_contention(&error));
    assert!(!permit.try_begin().unwrap());
    {
        let _writer = state.inner.write().unwrap();
        permit.verify_provider_binding(&state).unwrap();
        let busy = permit.verify_provider_start(&state, &owner).unwrap_err();
        assert!(PeerAutoWakePermit::is_temporary_start_contention(&busy));
        assert!(permit.provider_dispatch_pending());
    }
    permit.verify_provider_start(&state, &owner).unwrap();
    assert!(permit.try_mark_provider_dispatched(&state, &owner).unwrap());
    assert!(!permit.provider_dispatch_pending());
    let source = state.inner.read().unwrap().history_source.clone().unwrap();
    source.with_test_binding_lock(|| {
        let busy = permit.verify_provider_start(&state, &owner).unwrap_err();
        assert!(PeerAutoWakePermit::is_temporary_start_contention(&busy));
        assert_eq!(
            PeerAutoWakePermit::start_failure_reason(&busy),
            "peer_wake_start_busy"
        );
    });
    permit.verify_provider_start(&state, &owner).unwrap();
    assert!(matches!(
        store
            .claim_peer_auto_wake(&witness, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        source.with_test_binding_lock(|| panic!("owned history binding poison"));
    }));
    let poisoned = permit.verify_provider_start(&state, &owner).unwrap_err();
    assert!(!PeerAutoWakePermit::is_temporary_start_contention(
        &poisoned
    ));
    assert_eq!(
        PeerAutoWakePermit::start_failure_reason(&poisoned),
        "PEER_HISTORY_SOURCE_UNAVAILABLE"
    );
}

#[tokio::test]
async fn hard_rejection_after_contention_never_reopens_the_original_permit() {
    let root = kcoder_config::create_private_temp_dir("peer-original-permit-denied").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = user(&state, "Original actual User").await;
    let store = queue(&root);
    let witness = peer(
        &store,
        &state,
        "busy-then-denied",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&witness, store.revision().unwrap())
        .unwrap()
    else {
        panic!("one original permit is required")
    };
    let busy = {
        let _writer = state.inner.write().unwrap();
        permit.try_begin().unwrap_err()
    };
    assert!(permit.can_retry_begin_after_contention(&busy));
    let denied = permit.try_begin_at(permit.expires_at_ms + 1).unwrap_err();
    assert!(!PeerAutoWakePermit::is_temporary_start_contention(&denied));
    assert!(!permit.can_retry_begin_after_contention(&busy));
    assert!(permit.started.load(Ordering::Acquire));
    assert!(!permit.begin_succeeded.load(Ordering::Acquire));
    assert!(
        permit.try_begin().is_err(),
        "clock rollback cannot revive a denied object"
    );
    assert!(matches!(
        store
            .claim_peer_auto_wake(&witness, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));
}
