use super::*;

fn prepare_new(
    store: &NativePeerRouterStore,
    source: &SessionAddressV1,
    id: &str,
    policy: SourcePrepareRatePolicy,
    now: u64,
) -> Result<PeerRouterOperationV1> {
    let (_, mut intent) = request(store);
    intent.client_message_id = id.into();
    store.prepare_at(id, source.clone(), &intent, policy, now)
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
fn persisted_rate_survives_reopen_rollback_and_idempotent_reconciliation() {
    let (_root, parent, store) = owned();
    let (source, mut intent) = request(&store);
    intent.client_message_id = "original".into();
    let policy = SourcePrepareRatePolicy {
        max_messages_per_minute: 1,
        max_source_messages_per_minute: 1,
    };
    let original = store
        .prepare_at("original", source.clone(), &intent, policy, 120_000)
        .unwrap();
    let bytes = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert_eq!(
        store
            .prepare_at("original", source.clone(), &intent, policy, 9_000_000)
            .unwrap(),
        original
    );
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        bytes,
        "an idempotent retry neither charges nor advances the admission clock"
    );
    assert_eq!(
        store.read_operation("original").unwrap(),
        Some(original.clone())
    );
    assert!(prepare_new(&store, &source, "blocked", policy, 120_001).is_err());
    drop(store);
    let store = reopen(&parent);
    assert!(prepare_new(&store, &source, "rollback", policy, 0).is_err());
    assert!(prepare_new(&store, &source, "before-boundary", policy, 179_999).is_err());
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        bytes,
        "denied attempts and read-only recovery do not rewrite the ledger"
    );
    store.mark_dispatching("original").unwrap();
    store
        .record_receipt(
            "original",
            receipt(&original, AgentMessageStatus::Queued, 1),
        )
        .unwrap();
    assert!(prepare_new(&store, &source, "after-reconcile", policy, 120_002).is_err());
    prepare_new(&store, &source, "next-window", policy, 180_000).unwrap();
    drop(store);
    let store = reopen(&parent);
    assert!(prepare_new(&store, &source, "second-rollback", policy, 120_000).is_err());
    assert!(
        store.read_operation("original").unwrap().is_some(),
        "rate expiration never deletes an original ID"
    );
}

#[test]
fn full_source_addresses_share_one_profile_quota_and_account_utf8_bytes() {
    let (_root, _parent, store) = owned();
    let (source, _) = request(&store);
    let policy = SourcePrepareRatePolicy {
        max_messages_per_minute: 3,
        max_source_messages_per_minute: 1,
    };
    prepare_new(&store, &source, "workspace-a", policy, 1_000).unwrap();
    let error = prepare_new(&store, &source, "same-source", policy, 1_001).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("peer_router_source_rate_limited")
    );
    let mut other_workspace = source.clone();
    other_workspace.workspace_id = "workspace-b".into();
    let (_, mut intent) = request(&store);
    intent.client_message_id = "workspace-b".into();
    intent.text = "你好".into();
    store
        .prepare_at("workspace-b", other_workspace, &intent, policy, 1_001)
        .unwrap();
    let mut other_thread = source.clone();
    other_thread.thread_id = "another-thread".into();
    prepare_new(&store, &other_thread, "another-thread", policy, 1_002).unwrap();
    other_thread.thread_id = "fourth-source".into();
    let error = prepare_new(&store, &other_thread, "profile-full", policy, 1_003).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("peer_router_profile_rate_limited")
    );
    let ledger: serde_json::Value =
        serde_json::from_slice(&read(&store.directory, DATA, MAX_DATA_BYTES).unwrap()).unwrap();
    let charges = ledger["sourcePrepareRate"]["charges"].as_array().unwrap();
    assert_eq!(charges.len(), 3);
    assert_eq!(
        charges
            .iter()
            .find(|charge| charge["operationId"] == "workspace-b")
            .unwrap()["utf8Bytes"],
        6
    );
    let (_other_root, _other_parent, other_profile) = owned();
    let (other_source, _) = request(&other_profile);
    prepare_new(
        &other_profile,
        &other_source,
        "independent-profile",
        policy,
        1_003,
    )
    .unwrap();
}

#[test]
fn new_policy_limits_apply_to_existing_charges_without_rejecting_original_ids() {
    let (_root, _parent, store) = owned();
    let (source, _) = request(&store);
    let generous = SourcePrepareRatePolicy {
        max_messages_per_minute: 3,
        max_source_messages_per_minute: 3,
    };
    let original = prepare_new(&store, &source, "first", generous, 1_000).unwrap();
    prepare_new(&store, &source, "second", generous, 1_001).unwrap();
    let restrictive = SourcePrepareRatePolicy {
        max_messages_per_minute: 1,
        max_source_messages_per_minute: 1,
    };
    assert_eq!(
        prepare_new(&store, &source, "first", restrictive, 1_002).unwrap(),
        original
    );
    assert!(prepare_new(&store, &source, "third", restrictive, 1_002).is_err());
    let bytes = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    for invalid in [0, 257] {
        let policy = SourcePrepareRatePolicy {
            max_messages_per_minute: invalid,
            ..generous
        };
        assert!(prepare_new(&store, &source, "invalid-policy", policy, 1_003).is_err());
    }
    assert_eq!(read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(), bytes);
    assert_eq!(
        SourcePrepareRatePolicy::default().max_messages_per_minute,
        32
    );
    assert_eq!(
        SourcePrepareRatePolicy::default().max_source_messages_per_minute,
        8
    );
}

#[test]
fn legacy_rate_baseline_is_committed_once_even_when_new_admission_is_denied() {
    let (_root, parent, store) = owned();
    let (source, _) = request(&store);
    let policy = SourcePrepareRatePolicy {
        max_messages_per_minute: 1,
        max_source_messages_per_minute: 1,
    };
    prepare_new(&store, &source, "legacy-operation", policy, 1_000).unwrap();
    // Simulate the previous format, which had no admission timestamps. This
    // is a fixture-only format migration, not a product recovery shortcut.
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&read(&store.directory, DATA, MAX_DATA_BYTES).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("sourcePrepareRate");
    store
        .directory
        .atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&legacy).unwrap())
        .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert!(store.read_operation("legacy-operation").unwrap().is_some());
    prepare_new(&store, &source, "legacy-operation", policy, 200_000).unwrap();
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
    assert!(prepare_new(&store, &source, "new-operation", policy, 200_000).is_err());
    let baseline = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    assert_ne!(baseline, before);
    drop(store);
    let store = reopen(&parent);
    assert!(prepare_new(&store, &source, "new-operation", policy, 259_999).is_err());
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        baseline
    );
    prepare_new(&store, &source, "new-operation", policy, 260_000).unwrap();
    assert!(store.read_operation("legacy-operation").unwrap().is_some());
}

#[test]
fn two_store_handles_commit_only_one_new_operation_against_a_single_allowance() {
    let (_root, parent, first) = owned();
    let second = reopen(&parent);
    let (source, _) = request(&first);
    let policy = SourcePrepareRatePolicy {
        max_messages_per_minute: 1,
        max_source_messages_per_minute: 1,
    };
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            barrier.wait();
            prepare_new(&first, &source, "one", policy, 1_000)
        });
        let two = scope.spawn(|| {
            barrier.wait();
            prepare_new(&second, &source, "two", policy, 1_000)
        });
        [one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let loser = if results[0].is_err() { "one" } else { "two" };
    assert!(
        prepare_new(&first, &source, loser, policy, 1_000)
            .unwrap_err()
            .to_string()
            .contains("peer_router_profile_rate_limited")
    );
    let ledger: serde_json::Value =
        serde_json::from_slice(&read(&first.directory, DATA, MAX_DATA_BYTES).unwrap()).unwrap();
    assert_eq!(ledger["operations"].as_object().unwrap().len(), 1);
    assert_eq!(
        ledger["sourcePrepareRate"]["charges"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
