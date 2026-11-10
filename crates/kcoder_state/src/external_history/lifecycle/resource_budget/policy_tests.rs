use super::*;

#[test]
fn explicit_raise_keeps_original_pending_charge_and_reconciles_lost_policy_reply() {
    let (root, store, reference) = fixture();
    let (reservation, _) = store
        .reserve_history_resource(&reference, spec("history-a", 'a', 8 * MIB))
        .unwrap();
    assert!(
        store
            .reserve_history_resource(&reference, spec("history-b", 'b', 4 * MIB))
            .is_err()
    );
    let mut next = limits();
    next.max_total_bytes = 20 * MIB;
    let original = store
        .raise_history_resource_budget(&reference, "raise-first", 0, next.clone())
        .unwrap();
    assert_eq!(original.revision, 1);
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        store.recorded_resource_budget("batch-a").unwrap().unwrap(),
        reference
    );
    assert_eq!(
        store.history_resource_outcome(&reservation).unwrap(),
        ResourceOutcome::Reserved
    );
    let recovered = store
        .raise_history_resource_budget(&reference, "raise-first", 0, next.clone())
        .unwrap();
    assert_eq!(recovered, original);
    assert_eq!(
        store
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        8 * MIB
    );
    store
        .reserve_history_resource(&reference, spec("history-b", 'b', 4 * MIB))
        .unwrap();
    store
        .settle_history_resource(&reservation, 7 * MIB, 1, &"c".repeat(64))
        .unwrap();
    assert_eq!(
        store.resource_budget_usage(&reference).unwrap().limits,
        next
    );
    assert_eq!(
        store.history_resource_policy(&reference).unwrap().revision,
        1
    );
    // Preparing the same baseline is idempotent and never resets the amended policy.
    assert_eq!(
        store
            .prepare_resource_budget(
                "batch-a",
                vec!["history-a".into(), "history-b".into()],
                limits()
            )
            .unwrap(),
        reference
    );
    assert_eq!(
        store.history_resource_policy(&reference).unwrap().revision,
        1
    );
}

#[test]
fn stale_or_repurposed_policy_requests_never_reset_or_hide_an_original_receipt() {
    let (_root, store, reference) = fixture();
    let mut first = limits();
    first.max_total_bytes = 20 * MIB;
    let original = store
        .raise_history_resource_budget(&reference, "first", 0, first.clone())
        .unwrap();
    let mut second = first.clone();
    second.max_payload_files = 8;
    store
        .raise_history_resource_budget(&reference, "second", 1, second.clone())
        .unwrap();
    assert_eq!(
        store
            .raise_history_resource_budget(&reference, "first", 0, first.clone())
            .unwrap(),
        original
    );
    assert_eq!(
        store
            .raise_history_resource_budget(&reference, "stale", 1, second.clone())
            .unwrap_err()
            .to_string(),
        "history_resource_policy_revision_changed"
    );
    assert_eq!(
        store
            .raise_history_resource_budget(&reference, "first", 0, second)
            .unwrap_err()
            .to_string(),
        "history_resource_policy_request_changed"
    );
    assert_eq!(
        store.history_resource_policy(&reference).unwrap().revision,
        2
    );
}

#[test]
fn policy_cannot_lower_limits_relax_disk_headroom_or_change_another_owner() {
    let (_root, store, reference) = fixture();
    let mut smaller = limits();
    smaller.max_total_bytes = 9 * MIB;
    let mut fewer = limits();
    fewer.max_payload_files = 3;
    for invalid in [limits(), smaller, fewer] {
        assert!(
            store
                .raise_history_resource_budget(&reference, "invalid", 0, invalid)
                .is_err()
        );
    }
    let mut margins = limits();
    margins.max_total_bytes *= 2;
    margins.min_free_bytes *= 2;
    assert_eq!(
        store
            .raise_history_resource_budget(&reference, "margin", 0, margins)
            .unwrap_err()
            .to_string(),
        "history_resource_policy_not_an_increase"
    );
    let mut wrong = reference.clone();
    wrong.owner = "another".into();
    let mut raised = limits();
    raised.max_payload_files = 8;
    assert_eq!(
        store
            .raise_history_resource_budget(&wrong, "wrong", 0, raised)
            .unwrap_err()
            .to_string(),
        "history_resource_wrong_scope"
    );
    assert_eq!(
        store.history_resource_policy(&reference).unwrap().revision,
        0
    );
}

#[test]
fn old_group_shape_is_unchanged_and_corrupt_policy_history_is_not_adopted() {
    let (_root, _store, reference) = fixture();
    let mut group = Group::new(
        &reference.scope,
        "batch-a",
        vec!["history-a".into(), "history-b".into()],
        limits(),
    )
    .unwrap();
    let old = serde_json::to_value(&group).unwrap();
    assert!(old.get("policy_changes").is_none());
    let restored: Group = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap(), old);
    let mut raised = limits();
    raised.max_payload_files = 8;
    group.raise_policy("increase", 0, raised).unwrap();
    let mut value = serde_json::to_value(group).unwrap();
    value["policy_changes"][0]["revision"] = 2.into();
    let corrupt: Group = serde_json::from_value(value).unwrap();
    assert_eq!(
        corrupt
            .validate(&reference.scope, &reference.group)
            .unwrap_err()
            .to_string(),
        "history_resource_policy_changed"
    );
}
