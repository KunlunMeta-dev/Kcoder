use super::*;

fn policy() -> SourcePrepareRatePolicy {
    SourcePrepareRatePolicy {
        max_messages_per_minute: 256,
        max_source_messages_per_minute: 256,
    }
}
fn prepared(store: &NativePeerRouterStore, id: &str, now: u64) -> PeerRouterOperationV1 {
    let (source, mut intent) = request(store);
    intent.client_message_id = id.into();
    store
        .prepare_at(id, source, &intent, policy(), now)
        .unwrap()
}
fn final_receipt(operation: &PeerRouterOperationV1, revision: u64) -> AgentMessageReceipt {
    let mut value = receipt(operation, AgentMessageStatus::Applied, revision);
    value.message_id = format!("destination-{}", operation.operation_id);
    value
}
fn reopen(parent: &PrivateDirectory) -> NativePeerRouterStore {
    NativePeerRouterStore::open_in(
        parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap()
}

#[test]
fn completed_source_operations_leave_pending_slots_but_keep_frozen_ids_receipt_versions_and_rate_floor()
 {
    let (_root, parent, store) = owned();
    let mut first = None;
    for n in 0..270 {
        let id = format!("operation-{n}");
        let operation = prepared(&store, &id, (n + 1) * 60_001);
        store.mark_dispatching(&id).unwrap();
        let terminal = store
            .record_receipt(&id, final_receipt(&operation, 2))
            .unwrap();
        if n == 0 {
            first = Some(terminal);
        }
    }
    let first = first.unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    for _ in 0..10 {
        assert_eq!(
            store.read_operation(&first.operation_id).unwrap(),
            Some(first.clone())
        );
    }
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before,
        "read-only original lookup does not write"
    );
    let (_, mut original_intent) = request(&store);
    original_intent.client_message_id = "operation-0".into();
    assert_eq!(
        store
            .prepare_at(
                "operation-0",
                first.source_address.clone(),
                &original_intent,
                policy(),
                u64::MAX / 2
            )
            .unwrap(),
        first,
        "retry does not advance rate floor or resurrect a pending operation"
    );
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    let mut changed = original_intent.clone();
    changed.text = "changed body".into();
    assert!(
        store
            .prepare_at(
                "operation-0",
                first.source_address.clone(),
                &changed,
                policy(),
                60_001
            )
            .is_err()
    );
    assert!(
        store
            .prepare_at(
                "new-operation-id",
                first.source_address.clone(),
                &original_intent,
                policy(),
                60_001
            )
            .is_err(),
        "an archived source CID remains globally bound"
    );
    let mut updated = first.receipt.clone().unwrap();
    updated.revision = 3;
    store
        .record_receipt(&first.operation_id, updated.clone())
        .unwrap();
    assert_eq!(
        store
            .read_operation(&first.operation_id)
            .unwrap()
            .unwrap()
            .receipt,
        Some(updated.clone())
    );
    assert!(
        store
            .record_receipt(&first.operation_id, first.receipt.clone().unwrap())
            .is_err()
    );
    updated.status = AgentMessageStatus::Queued;
    updated.revision = 4;
    assert!(store.record_receipt(&first.operation_id, updated).is_err());
    let query = kcoder_app_protocol::cross_session_messages::AgentMessageGetParams {
        client_message_id: Some("operation-0".into()),
        message_id: None,
    };
    assert_eq!(
        store
            .find_source_operation(&first.source_address, &query)
            .unwrap()
            .unwrap()
            .operation_id,
        first.operation_id
    );
    let query = kcoder_app_protocol::cross_session_messages::AgentMessageGetParams {
        client_message_id: None,
        message_id: Some(first.receipt.as_ref().unwrap().message_id.clone()),
    };
    assert_eq!(
        store
            .find_source_operation(&first.source_address, &query)
            .unwrap()
            .unwrap()
            .operation_id,
        first.operation_id
    );
    drop(store);
    let store = reopen(&parent);
    assert_eq!(
        store
            .read_operation(&first.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .revision,
        3
    );
    // The last original window survives retirement and process-style reopen.
    let (source, mut intent) = request(&store);
    intent.client_message_id = "quota-after-reopen".into();
    let strict = SourcePrepareRatePolicy {
        max_messages_per_minute: 1,
        max_source_messages_per_minute: 1,
    };
    assert!(
        store
            .prepare_at("quota-after-reopen", source, &intent, strict, 0)
            .is_err()
    );
}

#[test]
fn pending_cap_still_counts_unknown_work_and_shared_terminal_receipt_does_not_take_a_writer() {
    let (_root, _parent, store) = owned();
    let mut first = None;
    for n in 0..MAX_OPERATIONS {
        let operation = prepared(&store, &format!("pending-{n}"), (n as u64 + 1) * 60_001);
        if n == 0 {
            first = Some(operation);
        }
    }
    let (source, mut intent) = request(&store);
    intent.client_message_id = "overflow".into();
    assert!(
        store
            .prepare_at("overflow", source.clone(), &intent, policy(), 20_000_000)
            .is_err()
    );
    let first = first.unwrap();
    store.mark_dispatching(&first.operation_id).unwrap();
    let terminal = final_receipt(&first, 2);
    store
        .record_receipt(&first.operation_id, terminal.clone())
        .unwrap();
    store
        .prepare_at("overflow", source, &intent, policy(), 20_000_000)
        .unwrap();
    let held = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.header.lock_identity,
            PrivateLeaseMode::Shared,
        )
        .unwrap()
        .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert_eq!(
        store
            .record_receipt(&first.operation_id, terminal.clone())
            .unwrap()
            .receipt,
        Some(terminal.clone())
    );
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    let mut later = terminal.clone();
    later.revision += 1;
    assert!(
        store
            .record_receipt(&first.operation_id, later.clone())
            .is_err()
    );
    drop(held);
    store.record_receipt(&first.operation_id, later).unwrap();
}

#[tokio::test]
async fn positive_source_history_retires_with_its_signed_operation_and_cannot_rebind() {
    let (root, parent, store) = owned();
    let state = kcoder_state::AppState::new(root.path());
    let history = root.path().join(format!("{}.jsonl", state.session_id()));
    state.with_history_path(&history);
    state.add_message(kcoder_types::Message::user_text(
        "Original native source task",
    ));
    state.flush_history().await.unwrap();
    let original = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    let (mut source, intent) = request(&store);
    source.thread_id = state.session_id();
    let operation = store.prepare("history-operation", source, &intent).unwrap();
    store
        .record_source_history(&operation.operation_id, &original)
        .unwrap();
    let reference = store
        .read_source_history(&operation.operation_id)
        .unwrap()
        .unwrap();
    store.mark_dispatching(&operation.operation_id).unwrap();
    store
        .record_receipt(&operation.operation_id, final_receipt(&operation, 2))
        .unwrap();
    state.add_message(kcoder_types::Message::assistant_text(
        "Ordinary later append",
    ));
    state.flush_history().await.unwrap();
    let later = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    store
        .record_source_history(&operation.operation_id, &later)
        .unwrap();
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    let mut unsupported_intent = intent.clone();
    unsupported_intent.client_message_id = "history-unsupported".into();
    let unsupported = store
        .prepare(
            "history-unsupported",
            operation.source_address.clone(),
            &unsupported_intent,
        )
        .unwrap();
    store.mark_dispatching(&unsupported.operation_id).unwrap();
    store
        .record_receipt(&unsupported.operation_id, final_receipt(&unsupported, 2))
        .unwrap();
    assert!(
        store
            .record_source_history(&unsupported.operation_id, &later)
            .is_err(),
        "an archived unsupported admission cannot acquire a later native history witness"
    );
    drop(store);
    let store = reopen(&parent);
    assert_eq!(
        store.read_source_history(&operation.operation_id).unwrap(),
        Some(reference.clone())
    );
    assert_eq!(
        store
            .read_source_history(&unsupported.operation_id)
            .unwrap(),
        None,
        "reopening preserves the original unsupported history binding"
    );
    kcoder_state::verify_peer_source_history_reference(&history, &reference).unwrap();
    let directory = PrivateDirectory::open_existing(history.parent().unwrap()).unwrap();
    let lease_name = history
        .with_extension("lease")
        .file_name()
        .unwrap()
        .to_owned();
    directory.open_read_write_file(&lease_name, true).unwrap();
    let changed = state
        .peer_source_admission_history(&state.inspection_lifecycle_identity())
        .unwrap();
    assert!(
        store
            .record_source_history(&operation.operation_id, &changed)
            .is_err(),
        "an archived admission without the old kernel leaf never adopts a new lock"
    );
    assert_eq!(
        store.read_source_history(&operation.operation_id).unwrap(),
        Some(reference)
    );
}

#[test]
fn imported_provenance_has_no_accumulated_256_limit_and_conflict_never_becomes_local_absence() {
    let (_source_root, _source_parent, source_store) = owned();
    let (_root, parent, destination_store) = owned();
    let source_identity = source_store.identity("workspace-a").unwrap();
    let destination_identity = destination_store.identity("workspace-b").unwrap();
    let (source, mut intent) = request(&source_store);
    intent.target_address.as_mut().unwrap().target_id = destination_identity.target_id.clone();
    let mut original = None;
    for n in 0..270 {
        let id = format!("incoming-{n}");
        intent.client_message_id = id.clone();
        let operation = source_store
            .prepare_at(&id, source.clone(), &intent, policy(), (n + 1) * 60_001)
            .unwrap();
        source_store
            .mark_dispatching(&operation.operation_id)
            .unwrap();
        let incoming = IncomingPeerOperation {
            source_identity: source_identity.clone(),
            destination_identity: destination_identity.clone(),
            attestation: operation.attestation.clone(),
        };
        destination_store
            .remember_incoming(incoming.clone())
            .unwrap();
        // This storage fixture never admits a destination queue or model turn.
        // Settle its source slot after saving the immutable signed provenance.
        let mut rejected = final_receipt(&operation, 2);
        rejected.status = AgentMessageStatus::Rejected;
        source_store
            .record_receipt(&operation.operation_id, rejected)
            .unwrap();
        if n == 0 {
            original = Some(incoming);
        }
    }
    let original = original.unwrap();
    let before = read(&destination_store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert_eq!(
        destination_store
            .read_incoming(&source, "incoming-0")
            .unwrap(),
        Some(original.clone())
    );
    destination_store
        .remember_incoming(original.clone())
        .unwrap();
    assert_eq!(
        read(&destination_store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    let mut bad = original.clone();
    bad.destination_identity.public_key[0] ^= 1;
    assert!(destination_store.remember_incoming(bad).is_err());
    drop(destination_store);
    let reopened = reopen(&parent);
    assert_eq!(
        reopened.read_incoming(&source, "incoming-0").unwrap(),
        Some(original)
    );
}

fn legacy_final(store: &NativePeerRouterStore) -> (PeerRouterOperationV1, Vec<u8>) {
    let operation = prepared(store, "legacy-original", 60_001);
    store.mark_dispatching(&operation.operation_id).unwrap();
    let mut data: Data =
        serde_json::from_slice(&read(&store.directory, DATA, MAX_DATA_BYTES).unwrap()).unwrap();
    let current = data.operations.get_mut(&operation.operation_id).unwrap();
    current.stage = PeerRouterStageV1::Receipted;
    current.receipt = Some(final_receipt(&operation, 2));
    let original = current.clone();
    store.validate_data(&data).unwrap();
    let bytes = serde_json::to_vec(&data).unwrap();
    store
        .directory
        .atomic_replace(OsStr::new(DATA), &bytes)
        .unwrap();
    (original, bytes)
}

#[test]
fn source_bootstrap_failures_resume_exact_original_facts_and_final_fence_rejects_old_json() {
    for point in [
        "reserved",
        "bootstrap_published",
        "seed_committed",
        "manifest_published",
        "before_sql_commit",
    ] {
        let (_root, parent, store) = owned();
        let (original, legacy) = legacy_final(&store);
        archive::FAILURE_POINT.with(|failure| failure.set(Some(point)));
        let (source, mut intent) = request(&store);
        intent.client_message_id = "new-after-archive".into();
        assert!(
            store
                .prepare_at(
                    "new-after-archive",
                    source.clone(),
                    &intent,
                    policy(),
                    120_002
                )
                .is_err(),
            "injection did not reach {point}"
        );
        assert!(
            archive::FAILURE_POINT
                .with(|failure| failure.get())
                .is_none()
        );
        let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
        assert_eq!(
            store.read_operation(&original.operation_id).unwrap(),
            Some(original.clone())
        );
        assert_eq!(
            read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
            before
        );
        assert!(store.read_operation("new-after-archive").unwrap().is_none());
        store
            .prepare_at("new-after-archive", source, &intent, policy(), 120_002)
            .unwrap();
        let committed = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
        store
            .directory
            .atomic_replace(OsStr::new(DATA), &legacy)
            .unwrap();
        assert!(store.read_operation(&original.operation_id).is_err());
        assert!(reopen_result(&parent).is_err());
        store
            .directory
            .atomic_replace(OsStr::new(DATA), &committed)
            .unwrap();
        assert_eq!(
            store.read_operation(&original.operation_id).unwrap(),
            Some(original)
        );
    }
}
fn reopen_result(parent: &PrivateDirectory) -> Result<Option<NativePeerRouterStore>> {
    NativePeerRouterStore::open_in(
        parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
}

#[test]
fn source_archive_cold_open_preserves_logical_facts_and_rejects_lock_loss_or_corruption() {
    for leaf in ["catalog.sqlite3", "owner.json", "setup.lock"] {
        let (_root, parent, store) = owned();
        let operation = prepared(&store, "original-archive", 60_001);
        store.mark_dispatching(&operation.operation_id).unwrap();
        let terminal = store
            .record_receipt(&operation.operation_id, final_receipt(&operation, 2))
            .unwrap();
        let manifest = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        let child = json["binding"]["child"].as_str().unwrap();
        let directory = store
            .directory
            .open_entry_handle(OsStr::new(child))
            .unwrap()
            .open_child_directory()
            .unwrap();
        let held = directory
            .open_single_link_regular_file(OsStr::new(leaf))
            .unwrap();
        let mut identical = Vec::new();
        held.try_clone()
            .unwrap()
            .read_to_end(&mut identical)
            .unwrap();
        directory
            .atomic_replace(OsStr::new(leaf), &identical)
            .unwrap();
        if leaf != "setup.lock" {
            // Each request opens a new archive observer. Same logical bytes
            // may move; a held archive's replacement guard is tested in State.
            assert_eq!(
                store.read_operation(&operation.operation_id).unwrap(),
                Some(terminal.clone())
            );
            assert_eq!(
                reopen_result(&parent)
                    .unwrap()
                    .unwrap()
                    .read_operation(&operation.operation_id)
                    .unwrap(),
                Some(terminal)
            );
            directory
                .atomic_replace(OsStr::new(leaf), b"corrupt archive authority")
                .unwrap();
        }
        assert!(store.read_operation(&operation.operation_id).is_err());
        assert!(store.read_source_history(&operation.operation_id).is_err());
        assert!(
            store
                .read_incoming(&operation.source_address, "unobserved-incoming")
                .is_err(),
            "an unavailable provenance archive must not be interpreted as local absence"
        );
        assert!(store.mark_dispatching(&operation.operation_id).is_err());
        assert_eq!(
            read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
            manifest
        );
        assert!(reopen_result(&parent).is_err());
        drop(held);
    }

    let (root, parent, store) = owned();
    let operation = prepared(&store, "missing-archive", 60_001);
    store.mark_dispatching(&operation.operation_id).unwrap();
    store
        .record_receipt(&operation.operation_id, final_receipt(&operation, 2))
        .unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&read(&store.directory, DATA, MAX_DATA_BYTES).unwrap()).unwrap();
    let child = json["binding"]["child"].as_str().unwrap();
    let database = root
        .path()
        .join("profile")
        .join("peer-router-v1")
        .join(child)
        .join("catalog.sqlite3");
    std::fs::remove_file(&database).unwrap();
    assert!(store.read_operation(&operation.operation_id).is_err());
    assert!(store.mark_dispatching(&operation.operation_id).is_err());
    assert!(reopen_result(&parent).is_err());
    assert!(
        !database.exists(),
        "missing archive authority never bootstraps an empty replacement"
    );
}
