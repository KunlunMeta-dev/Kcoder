use super::*;

#[path = "archive_tests.rs"]
mod archive_tests;
#[path = "rate_tests.rs"]
mod rate_tests;

#[test]
fn reply_reference_is_signed_frozen_and_cannot_be_removed_under_the_original_cid() {
    let (_root, _parent, store) = owned();
    let (source, mut intent) = request(&store);
    intent.reply_to_message_id = Some("received-original".into());
    let operation = store
        .prepare("reply-original", source.clone(), &intent)
        .unwrap();
    assert_eq!(
        operation.attestation.claims.reply_to_message_id,
        intent.reply_to_message_id
    );
    verify_peer_attestation(
        &operation.attestation,
        &store.identity("workspace-a").unwrap(),
    )
    .unwrap();
    let mut forged = operation.attestation.clone();
    forged.claims.reply_to_message_id = None;
    assert!(verify_peer_attestation(&forged, &store.identity("workspace-a").unwrap()).is_err());
    assert_eq!(
        store
            .prepare("reply-original", source.clone(), &intent)
            .unwrap(),
        operation
    );
    intent.reply_to_message_id = None;
    assert!(store.prepare("reply-original", source, &intent).is_err());
    let mut unlinked = receipt(&operation, AgentMessageStatus::Queued, 1);
    unlinked.reply_to_message_id = None;
    assert!(store.record_receipt("reply-original", unlinked).is_err());
}
#[path = "source_list_tests.rs"]
mod source_list_tests;

#[path = "binding_tests.rs"]
mod binding_tests;

#[test]
fn brief_native_lock_contention_runs_the_original_action_once() {
    let (_root, _parent, store) = owned();
    let held = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.header.lock_identity,
            PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    assert!(
        store
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &store.header.lock_identity,
                PrivateLeaseMode::Shared,
            )
            .unwrap()
            .is_none()
    );
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    let calls = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            drop(held);
        });
        store
            .access(false, |_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(((), false))
            })
            .unwrap();
    });
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
}

#[test]
fn sustained_native_lock_contention_fails_without_running_or_writing() {
    let (_root, _parent, store) = owned();
    let held = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.header.lock_identity,
            PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    let mut called = false;
    let started = Instant::now();
    let error = store
        .access(false, |_| {
            called = true;
            Ok(((), false))
        })
        .unwrap_err();
    assert!(error.to_string().contains("peer_router_busy"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!called);
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    drop(held);
    assert!(store.read_operation("not-prepared").unwrap().is_none());
}

#[test]
fn identical_receipt_uses_a_shared_lease_and_progress_still_requires_exclusive() {
    let (_root, _parent, store) = owned();
    let (source, intent) = request(&store);
    let operation = store.prepare("operation-a", source, &intent).unwrap();
    store.mark_dispatching("operation-a").unwrap();
    let queued = receipt(&operation, AgentMessageStatus::Queued, 1);
    let original = store.record_receipt("operation-a", queued.clone()).unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    let held = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.header.lock_identity,
            PrivateLeaseMode::Shared,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        store.record_receipt("operation-a", queued).unwrap(),
        original
    );
    assert!(
        store
            .record_receipt(
                "operation-a",
                receipt(&operation, AgentMessageStatus::Applied, 2),
            )
            .is_err()
    );
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    drop(held);
    assert_eq!(
        store
            .record_receipt(
                "operation-a",
                receipt(&operation, AgentMessageStatus::Applied, 2),
            )
            .unwrap()
            .receipt
            .unwrap()
            .status,
        AgentMessageStatus::Applied
    );
}

#[test]
fn enrollment_presence_signatures_are_challenge_scope_and_purpose_bound() {
    let (_root, _parent, store) = owned();
    let identity = store.identity("workspace-a").unwrap();
    let claims = PeerSourcePresenceClaimsV1 {
        version: 1,
        purpose: PEER_SOURCE_PRESENCE_PURPOSE.into(),
        nonce: "a".repeat(64),
        source: SessionAddressV1 {
            target_id: identity.target_id.clone(),
            workspace_id: identity.workspace_id.clone(),
            thread_id: "source".into(),
        },
        identity_epoch: identity.identity_epoch.clone(),
        lease_id: "lease-instance".into(),
    };
    let presence = store.sign_source_presence(&claims).unwrap();
    let bytes = |claims: &PeerSourcePresenceClaimsV1| {
        let mut bytes = PEER_SOURCE_PRESENCE_DOMAIN.to_vec();
        bytes.extend(serde_json::to_vec(claims).unwrap());
        bytes
    };
    let verifier = signature::UnparsedPublicKey::new(&signature::ED25519, &identity.public_key);
    verifier
        .verify(&bytes(&claims), &presence.signature)
        .unwrap();
    let mut changed = claims.clone();
    changed.nonce = "b".repeat(64);
    assert!(
        verifier
            .verify(&bytes(&changed), &presence.signature)
            .is_err()
    );
    changed = claims.clone();
    changed.identity_epoch = "other-epoch".into();
    assert!(store.sign_source_presence(&changed).is_err());
    changed = claims.clone();
    changed.source.target_id = "other-target".into();
    assert!(store.sign_source_presence(&changed).is_err());
    changed = claims;
    changed.purpose = AGENT_MESSAGE_ROUTE_PURPOSE.into();
    assert!(store.sign_source_presence(&changed).is_err());
    assert!(
        verifier
            .verify(
                &serde_json::to_vec(&presence.claims).unwrap(),
                &presence.signature
            )
            .is_err()
    );
}

#[tokio::test]
async fn opaque_source_history_binding_survives_reopen_and_cannot_rebind_another_thread() {
    let (root, parent, store) = owned();
    let state = kcoder_state::AppState::new(root.path());
    let history = root.path().join(format!("{}.jsonl", state.session_id()));
    state.with_history_path(&history);
    state.add_message(kcoder_types::Message::user_text(
        "Original source admission task",
    ));
    state.flush_history().await.unwrap();
    let witness = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    let (mut source, intent) = request(&store);
    source.thread_id = state.session_id();
    store.prepare("history-operation", source, &intent).unwrap();
    store
        .record_source_history("history-operation", &witness)
        .unwrap();
    let original = store
        .read_source_history("history-operation")
        .unwrap()
        .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    state.add_message(kcoder_types::Message::assistant_text(
        "An ordinary later append",
    ));
    state.flush_history().await.unwrap();
    let newer = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    store
        .record_source_history("history-operation", &newer)
        .unwrap();
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before,
        "an ordinary append does not replace the original admission boundary"
    );
    let (source, mut different) = request(&store);
    different.client_message_id = "other-client-id".into();
    store
        .prepare("another-thread-operation", source, &different)
        .unwrap();
    assert!(
        store
            .record_source_history("another-thread-operation", &witness)
            .is_err()
    );
    drop(store);
    let reopened = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        reopened.read_source_history("history-operation").unwrap(),
        Some(original.clone())
    );
    kcoder_state::verify_peer_source_history_reference(&history, &original).unwrap();
    let history_parent = PrivateDirectory::open_existing(history.parent().unwrap()).unwrap();
    let lease_name = history
        .file_name()
        .map(|name| {
            std::path::Path::new(name)
                .with_extension("lease")
                .into_os_string()
        })
        .unwrap();
    history_parent
        .open_read_write_file(&lease_name, true)
        .unwrap();
    let lease_added = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    assert!(
        lease_added
            .reference()
            .native_session_lease_identity()
            .is_some()
    );
    assert!(
        reopened
            .record_source_history("history-operation", &lease_added)
            .is_err(),
        "an old unsupported admission cannot be upgraded to a newly allocated kernel lock"
    );
}

#[test]
fn incoming_provenance_is_durable_exact_and_never_a_saved_allow() {
    let (_source_root, _source_parent, source_store) = owned();
    let (_target_root, target_parent, target_store) = owned();
    let (source, mut intent) = request(&source_store);
    let destination_identity = target_store.identity("workspace-b").unwrap();
    intent.target_address = Some(SessionAddressV1 {
        target_id: destination_identity.target_id.clone(),
        workspace_id: destination_identity.workspace_id.clone(),
        thread_id: intent.target_thread_id.clone(),
    });
    let operation = source_store
        .prepare("incoming-operation", source.clone(), &intent)
        .unwrap();
    let incoming = IncomingPeerOperation {
        source_identity: source_store.identity("workspace-a").unwrap(),
        destination_identity,
        attestation: operation.attestation,
    };
    target_store.remember_incoming(incoming.clone()).unwrap();
    let before = read(&target_store.directory, DATA, MAX_DATA_BYTES).unwrap();
    target_store.remember_incoming(incoming.clone()).unwrap();
    assert_eq!(
        read(&target_store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    assert!(
        !String::from_utf8(before.clone())
            .unwrap()
            .contains(&intent.text)
    );
    let mut changed = incoming.clone();
    changed.attestation.claims.body_sha256 = "a".repeat(64);
    changed.attestation.signature = source_store
        .key
        .sign(&signed_bytes(&changed.attestation.claims).unwrap())
        .as_ref()
        .to_vec();
    assert!(target_store.remember_incoming(changed).is_err());
    let mut changed = incoming.clone();
    changed.destination_identity.identity_epoch = "replaced-destination".into();
    assert!(target_store.remember_incoming(changed).is_err());
    drop(target_store);
    let reopened = NativePeerRouterStore::open_in(
        &target_parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    assert!(
        reopened
            .read_incoming(&source, "never-accepted")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        reopened
            .read_incoming(&source, &intent.client_message_id)
            .unwrap(),
        Some(incoming)
    );
    assert_eq!(
        read(&reopened.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
}

fn owned() -> (tempfile::TempDir, PrivateDirectory, NativePeerRouterStore) {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(&root.path().join("profile")).unwrap();
    let store = NativePeerRouterStore::create_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap();
    (root, parent, store)
}
fn request(store: &NativePeerRouterStore) -> (SessionAddressV1, AgentMessageIntent) {
    let identity = store.identity("workspace-a").unwrap();
    let source = SessionAddressV1 {
        target_id: identity.target_id,
        workspace_id: identity.workspace_id,
        thread_id: "same-thread".into(),
    };
    let destination = SessionAddressV1 {
        target_id: "another-native-target".into(),
        workspace_id: "workspace-b".into(),
        thread_id: "same-thread".into(),
    };
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: destination.thread_id.clone(),
        target_address: Some(destination),
        client_message_id: "request-a".into(),
        mode: kcoder_types::cross_session_messages::AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "private body: 你好".into(),
    };
    (source, intent)
}
fn receipt(
    operation: &PeerRouterOperationV1,
    status: AgentMessageStatus,
    revision: u64,
) -> AgentMessageReceipt {
    AgentMessageReceipt {
        reply_to_message_id: operation.attestation.claims.reply_to_message_id.clone(),
        message_id: "destination-message-id".into(),
        client_message_id: operation.attestation.claims.client_message_id.clone(),
        target_thread_id: operation.destination.thread_id.clone(),
        status,
        revision,
        reason_code: None,
        source_address: Some(operation.source_address.clone()),
        target_address: Some(operation.destination.clone()),
    }
}

#[test]
fn source_prepare_is_durable_idempotent_frozen_and_has_no_plaintext_body() {
    let (_root, parent, store) = owned();
    let (source, intent) = request(&store);
    let operation = store
        .prepare("operation-a", source.clone(), &intent)
        .unwrap();
    assert_eq!(
        store
            .prepare("operation-a", source.clone(), &intent)
            .unwrap(),
        operation
    );
    let mut conflict = intent.clone();
    conflict.text.push('!');
    assert!(
        store
            .prepare("operation-a", source.clone(), &conflict)
            .is_err()
    );
    assert!(
        store
            .prepare("operation-b", source.clone(), &intent)
            .is_err()
    );
    let mut conflict = intent.clone();
    conflict.target_address.as_mut().unwrap().workspace_id = "wrong-workspace".into();
    assert!(store.prepare("operation-a", source, &conflict).is_err());
    let bytes = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert!(
        !String::from_utf8(bytes.clone())
            .unwrap()
            .contains(&intent.text)
    );
    drop(store);
    let reopened = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        reopened.read_operation("operation-a").unwrap(),
        Some(operation)
    );
    assert_eq!(
        read(&reopened.directory, DATA, MAX_DATA_BYTES).unwrap(),
        bytes
    );
    assert!(reopened.read_operation("never-prepared").unwrap().is_none());
}

#[test]
fn signatures_bind_source_destination_body_and_native_epoch() {
    let (_root, _parent, store) = owned();
    let (source, intent) = request(&store);
    let operation = store.prepare("operation-a", source, &intent).unwrap();
    let identity = store.identity("workspace-a").unwrap();
    verify_peer_attestation(&operation.attestation, &identity).unwrap();
    let mut changed = operation.attestation.clone();
    changed.claims.destination.target_id = "foreign-target".into();
    assert!(verify_peer_attestation(&changed, &identity).is_err());
    let mut changed = operation.attestation.clone();
    changed.claims.body_sha256 = "a".repeat(64);
    assert!(verify_peer_attestation(&changed, &identity).is_err());
    let mut changed = identity.clone();
    changed.identity_epoch = "another-epoch".into();
    assert!(verify_peer_attestation(&operation.attestation, &changed).is_err());
    let mut changed = identity;
    changed.public_key[0] ^= 1;
    assert!(verify_peer_attestation(&operation.attestation, &changed).is_err());
}

#[test]
fn unknown_dispatch_survives_reopen_and_receipts_do_not_regress_or_change_address() {
    let (_root, parent, store) = owned();
    let (source, intent) = request(&store);
    let operation = store.prepare("operation-a", source, &intent).unwrap();
    assert!(
        store
            .record_receipt(
                "operation-a",
                receipt(&operation, AgentMessageStatus::Queued, 1)
            )
            .is_err()
    );
    store.mark_dispatching("operation-a").unwrap();
    drop(store);
    let store = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    let operation = store.read_operation("operation-a").unwrap().unwrap();
    assert_eq!(operation.stage, PeerRouterStageV1::Dispatching);
    assert!(operation.receipt.is_none());
    let mut forged = receipt(&operation, AgentMessageStatus::Queued, 1);
    forged.target_address.as_mut().unwrap().target_id = "foreign".into();
    assert!(store.record_receipt("operation-a", forged).is_err());
    store
        .record_receipt(
            "operation-a",
            receipt(&operation, AgentMessageStatus::Queued, 1),
        )
        .unwrap();
    let applied = receipt(&operation, AgentMessageStatus::Applied, 2);
    store
        .record_receipt("operation-a", applied.clone())
        .unwrap();
    assert!(
        store
            .record_receipt(
                "operation-a",
                receipt(&operation, AgentMessageStatus::Queued, 3)
            )
            .is_err()
    );
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    store.record_receipt("operation-a", applied).unwrap();
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
}

#[test]
fn same_thread_name_on_another_target_is_valid_but_complete_self_address_is_rejected() {
    let (_root, _parent, store) = owned();
    let (source, mut intent) = request(&store);
    assert!(
        store
            .prepare("operation-a", source.clone(), &intent)
            .is_ok()
    );
    intent.client_message_id = "request-self".into();
    intent.target_address = Some(source.clone());
    assert!(store.prepare("operation-self", source, &intent).is_err());
}

#[test]
fn wrong_owner_corruption_and_namespace_replacement_are_errors_without_repair() {
    let (root, parent, store) = owned();
    let foreign = RetentionPrincipalV1::VerifiedAccount {
        principal_id: "another-account".into(),
    };
    assert!(
        NativePeerRouterStore::open_in(&parent, OsStr::new("peer-router-v1"), &foreign).is_err()
    );
    let (source, intent) = request(&store);
    store.prepare("operation-a", source, &intent).unwrap();
    store
        .directory
        .atomic_replace(OsStr::new(DATA), b"{")
        .unwrap();
    assert!(store.read_operation("operation-a").is_err());
    assert_eq!(read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(), b"{");
    std::fs::rename(
        root.path().join("profile/peer-router-v1"),
        root.path().join("original-router"),
    )
    .unwrap();
    let replacement = parent
        .create_private_child(OsStr::new("peer-router-v1"))
        .unwrap();
    assert!(store.identity("workspace-a").is_err());
    assert!(
        NativePeerRouterStore::open_in(
            &parent,
            OsStr::new("peer-router-v1"),
            &RetentionPrincipalV1::LocalOs
        )
        .is_err()
    );
    assert!(replacement.open_entry_handle(OsStr::new(HEADER)).is_err());
}

#[test]
fn original_mailbox_survives_new_process_open_and_missing_receipts_never_create_an_empty_replacement()
 {
    let (root, parent, store) = owned();
    assert!(
        store
            .workspace_mailbox("workspace-a", false)
            .unwrap()
            .is_none()
    );
    let queue = store
        .workspace_mailbox("workspace-a", true)
        .unwrap()
        .unwrap();
    let namespace = queue.namespace_identity().unwrap();
    let source = kcoder_types::cross_session_messages::CrossSessionMessageSource {
        thread_id: "sender".into(),
        principal_id: "local-principal".into(),
        address: None,
    };
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: "receiver".into(),
        target_address: None,
        client_message_id: "request-a".into(),
        mode: kcoder_types::cross_session_messages::AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "queued body".into(),
    };
    let receipt = queue
        .enqueue(&source, intent, queue.revision().unwrap())
        .unwrap();
    drop(queue);
    drop(store);
    let store = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    let queue = store
        .workspace_mailbox("workspace-a", false)
        .unwrap()
        .unwrap();
    assert_eq!(queue.namespace_identity().unwrap(), namespace);
    assert_eq!(
        queue.get_by_client_id(&source, "request-a").unwrap(),
        Some(receipt)
    );
    drop(queue);
    drop(store);
    let path = root
        .path()
        .join("profile/peer-router-v1/mailbox-workspace-a");
    std::fs::rename(&path, root.path().join("original-mailbox")).unwrap();
    let store = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    assert!(store.workspace_mailbox("workspace-a", false).is_err());
    assert!(store.workspace_mailbox("workspace-a", true).is_err());
    assert!(!path.exists());
}
