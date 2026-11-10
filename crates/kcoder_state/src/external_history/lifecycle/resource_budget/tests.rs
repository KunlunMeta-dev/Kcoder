use super::*;
use crate::external_history::ExternalHistoryStore;

const MIB: u64 = 1024 * 1024;
fn limits() -> MigrationResourceLimits {
    MigrationResourceLimits {
        max_total_bytes: 10 * MIB,
        max_payload_files: 4,
        min_free_bytes: MIB,
        min_free_file_nodes: 0,
    }
}
fn spec(member: &str, id: char, bytes: u64) -> ResourceCharge {
    ResourceCharge {
        member: member.into(),
        kind: ResourceKind::Archive,
        identity: id.to_string().repeat(64),
        maximum_bytes: bytes,
        maximum_files: 1,
    }
}
fn fixture() -> (
    tempfile::TempDir,
    ExternalHistoryStore,
    ResourceBudgetReference,
) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let reference = store
        .prepare_resource_budget(
            "batch-a",
            vec!["history-a".into(), "history-b".into()],
            limits(),
        )
        .unwrap();
    (root, store, reference)
}

#[test]
fn independent_members_share_one_byte_and_file_limit_and_original_receipts() {
    let (_root, store, reference) = fixture();
    let a = spec("history-a", 'a', 6 * MIB);
    let (reservation, phase) = store
        .reserve_history_resource(&reference, a.clone())
        .unwrap();
    assert_eq!(phase, ResourceOutcome::Reserved);
    assert_eq!(
        store
            .reserve_history_resource(&reference, a.clone())
            .unwrap()
            .0,
        reservation
    );
    assert_eq!(
        store
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        6 * MIB
    );
    assert_eq!(
        store
            .reserve_history_resource(&reference, spec("history-b", 'b', 5 * MIB))
            .unwrap_err()
            .to_string(),
        "history_resource_budget_exceeded"
    );
    store
        .settle_history_resource(&reservation, 4 * MIB, 1, &"c".repeat(64))
        .unwrap();
    store
        .settle_history_resource(&reservation, 4 * MIB, 1, &"c".repeat(64))
        .unwrap();
    assert!(
        store
            .settle_history_resource(&reservation, 5 * MIB, 1, &"c".repeat(64))
            .is_err()
    );
    let (_, phase) = store.reserve_history_resource(&reference, a).unwrap();
    assert!(matches!(phase, ResourceOutcome::Committed { bytes, .. } if bytes == 4 * MIB));
    store
        .reserve_history_resource(&reference, spec("history-b", 'b', 5 * MIB))
        .unwrap();
    let usage = store.resource_budget_usage(&reference).unwrap();
    assert_eq!(
        (usage.committed_bytes, usage.reserved_bytes),
        (4 * MIB, 5 * MIB)
    );
    assert!(
        store
            .reserve_history_resource(&reference, spec("history-a", 'a', 4 * MIB))
            .is_err()
    );
}

#[test]
fn reopen_keeps_unknown_reservations_and_only_explicit_unwritten_proof_refunds_them() {
    let (root, store, reference) = fixture();
    let (reservation, _) = store
        .reserve_history_resource(&reference, spec("history-a", 'a', 8 * MIB))
        .unwrap();
    drop(store);
    let reopened = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        8 * MIB
    );
    assert!(
        reopened
            .abandon_unwritten_history_resource(&reservation, || Ok(false))
            .is_err()
    );
    assert_eq!(
        reopened
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        8 * MIB
    );
    reopened
        .abandon_unwritten_history_resource(&reservation, || {
            Ok(!root.path().join("never-created-payload").exists())
        })
        .unwrap();
    assert_eq!(
        reopened
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        0
    );
    assert_eq!(
        reopened
            .reserve_history_resource(&reference, spec("history-a", 'a', 8 * MIB))
            .unwrap_err()
            .to_string(),
        "history_resource_reservation_abandoned"
    );
    assert!(
        reopened
            .settle_history_resource(&reservation, 1, 1, &"b".repeat(64))
            .is_err()
    );
}

#[test]
fn a_lost_reservation_reply_is_reconciled_without_mutation_or_a_new_budget() {
    let (_root, store, reference) = fixture();
    let charge = spec("history-a", 'a', 2 * MIB);
    assert!(
        store
            .find_history_resource_reservation(&reference, &charge)
            .unwrap()
            .is_none()
    );
    // Discarding this receipt simulates the producer losing the accepted reservation reply.
    store
        .reserve_history_resource(&reference, charge.clone())
        .unwrap();
    let sequence = || {
        Catalog::open_readonly(&store.directory)
            .unwrap()
            .unwrap()
            .document
            .sequence
    };
    let before = sequence();
    let (original, outcome) = store
        .find_history_resource_reservation(&reference, &charge)
        .unwrap()
        .unwrap();
    assert_eq!(outcome, ResourceOutcome::Reserved);
    assert_eq!(
        store.history_resource_outcome(&original).unwrap(),
        ResourceOutcome::Reserved
    );
    assert_eq!(sequence(), before);
    assert!(
        store
            .prepare_resource_budget("another-batch", vec!["history-a".into()], limits())
            .is_err()
    );
    assert_eq!(sequence(), before);
    store
        .abandon_unwritten_history_resource(&original, || Ok(true))
        .unwrap();
    let after = sequence();
    assert_eq!(
        store
            .find_history_resource_reservation(&reference, &charge)
            .unwrap()
            .unwrap()
            .1,
        ResourceOutcome::Abandoned
    );
    assert_eq!(sequence(), after);
}

#[test]
fn wrong_profile_member_or_mutated_limits_cannot_reuse_the_original_budget() {
    let (_root, store, reference) = fixture();
    let same = store
        .prepare_resource_budget(
            "batch-a",
            vec!["history-b".into(), "history-a".into()],
            limits(),
        )
        .unwrap();
    assert_eq!(same, reference);
    let mut changed = limits();
    changed.max_total_bytes += MIB;
    assert!(
        store
            .prepare_resource_budget(
                "batch-a",
                vec!["history-a".into(), "history-b".into()],
                changed
            )
            .is_err()
    );
    assert!(
        store
            .reserve_history_resource(&reference, spec("history-foreign", 'a', 1))
            .is_err()
    );
    let peer_root = tempfile::tempdir().unwrap();
    let peer = ExternalHistoryStore::open(peer_root.path()).unwrap();
    peer.prepare_resource_budget(
        "batch-a",
        vec!["history-a".into(), "history-b".into()],
        limits(),
    )
    .unwrap();
    assert!(peer.resource_budget_usage(&reference).is_err());
    assert!(
        peer.reserve_history_resource(&reference, spec("history-a", 'a', 1))
            .is_err()
    );
    assert_eq!(
        store
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        0
    );
    let (reservation, _) = store
        .reserve_history_resource(&reference, spec("history-a", 'a', 1))
        .unwrap();
    let mut called = false;
    assert!(
        peer.abandon_unwritten_history_resource(&reservation, || {
            called = true;
            Ok(true)
        })
        .is_err()
    );
    assert!(
        !called,
        "foreign references must fail before payload inspection"
    );
}

#[test]
fn low_space_and_low_nodes_fail_before_charging_and_empty_files_still_count() {
    let mut group =
        Group::new(&"a".repeat(64), "batch", vec!["history-a".into()], limits()).unwrap();
    let charge = spec("history-a", 'a', 2 * MIB);
    assert_eq!(
        group
            .reserve(
                charge.clone(),
                AvailableStorage {
                    bytes: MIB,
                    file_nodes: None
                }
            )
            .unwrap_err()
            .to_string(),
        "history_resource_disk_space_insufficient"
    );
    assert_eq!(
        group
            .reserve(
                charge,
                AvailableStorage {
                    bytes: 100 * MIB,
                    file_nodes: Some(0)
                }
            )
            .unwrap_err()
            .to_string(),
        "history_resource_disk_nodes_insufficient"
    );
    assert_eq!(group.usage().unwrap().reserved_files, 0);
    for id in ['a', 'b', 'c', 'd'] {
        group
            .reserve(
                spec("history-a", id, 0),
                AvailableStorage {
                    bytes: 100 * MIB,
                    file_nodes: None,
                },
            )
            .unwrap();
    }
    assert_eq!(
        group
            .reserve(
                spec("history-a", 'e', 0),
                AvailableStorage {
                    bytes: 100 * MIB,
                    file_nodes: None
                }
            )
            .unwrap_err()
            .to_string(),
        "history_resource_file_budget_exceeded"
    );
}

#[test]
fn legacy_documents_omit_empty_resource_accounting() {
    let (_root, store, _) = fixture();
    let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
    catalog.document.resource_groups.clear();
    let value = serde_json::to_value(&catalog.document).unwrap();
    assert!(value.get("resource_groups").is_none());
    let decoded: Document = serde_json::from_value(value).unwrap();
    assert!(decoded.resource_groups.is_empty());
    decoded.validate().unwrap();
}

#[test]
fn a_separate_process_observes_the_same_durable_reservation() {
    const CHILD: &str = "KCODER_TEST_BUDGET_CHILD_ROOT";
    const REFERENCE: &str = "KCODER_TEST_BUDGET_CHILD_REFERENCE";
    if let Some(root) = std::env::var_os(CHILD) {
        let reference: ResourceBudgetReference =
            serde_json::from_str(&std::env::var(REFERENCE).unwrap()).unwrap();
        let store = ExternalHistoryStore::open_existing(std::path::Path::new(&root))
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .resource_budget_usage(&reference)
                .unwrap()
                .reserved_bytes,
            6 * MIB
        );
        assert_eq!(
            store
                .reserve_history_resource(&reference, spec("history-b", 'b', 6 * MIB))
                .unwrap_err()
                .to_string(),
            "history_resource_budget_exceeded"
        );
        let directory = PrivateDirectory::open_existing(std::path::Path::new(&root)).unwrap();
        let mut receipt = directory
            .open_read_write_file(OsStr::new("child-observation"), true)
            .unwrap();
        std::io::Write::write_all(&mut receipt, b"original-shared-quota-observed").unwrap();
        receipt.sync_all().unwrap();
        return;
    }
    let (root, store, reference) = fixture();
    store
        .reserve_history_resource(&reference, spec("history-a", 'a', 6 * MIB))
        .unwrap();
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    let full_name = concat!(
        module_path!(),
        "::a_separate_process_observes_the_same_durable_reservation"
    );
    let test_name = full_name.split_once("::").unwrap().1;
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD, root.path())
            .env(REFERENCE, serde_json::to_string(&reference).unwrap())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned resource-budget child timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        store
            .resource_budget_usage(&reference)
            .unwrap()
            .reserved_bytes,
        6 * MIB
    );
    assert_eq!(
        std::fs::read(root.path().join("child-observation")).unwrap(),
        b"original-shared-quota-observed"
    );
}

#[test]
fn reordered_persisted_members_cannot_hide_a_creator_from_archive_accounting() {
    let (root, store, _) = fixture();
    let journal = root
        .path()
        .join("external-history")
        .join(super::super::DIRECTORY)
        .join(super::super::DOCUMENT);
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    value["resource_groups"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["members"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let bytes = serde_json::to_vec(&value).unwrap();
    std::fs::write(&journal, &bytes).unwrap();
    assert_eq!(
        store
            .recorded_resource_budget("batch-a")
            .unwrap_err()
            .to_string(),
        "history_resource_binding_changed"
    );
    assert_eq!(
        std::fs::read(&journal).unwrap(),
        bytes,
        "a read must not repair or reorder a changed accounting journal"
    );
}

#[path = "policy_tests.rs"]
mod policy_tests;

#[test]
fn streaming_node_admission_keeps_headroom_for_other_unwritten_reservations() {
    let mut policy = limits();
    policy.min_free_file_nodes = 2;
    let mut group =
        Group::new(&"f".repeat(64), "batch-a", vec!["history-a".into()], policy).unwrap();
    let mut first = spec("history-a", 'a', MIB);
    first.kind = ResourceKind::EmbeddedAttachment;
    let space = AvailableStorage {
        bytes: 100 * MIB,
        file_nodes: Some(3),
    };
    group.start_stream(first, space).unwrap();
    let mut second = spec("history-a", 'b', MIB);
    second.kind = ResourceKind::EmbeddedAttachment;
    assert_eq!(
        group.start_stream(second, space).err().unwrap().to_string(),
        "history_resource_disk_nodes_insufficient"
    );
    assert_eq!(group.usage().unwrap().reserved_files, 1);
}
