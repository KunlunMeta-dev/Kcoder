use super::*;
use kcoder_types::integrations::core::{
    IntegrationContractVersion, IntegrationNullable, IntegrationRecovery,
};
use serde_json::json;
use tempfile::TempDir;

const SETTLED_AT: u64 = 2_000;
const AFTER_WINDOW: u64 = SETTLED_AT + INTEGRATION_OPERATION_RETIREMENT_WINDOW_MS;

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "account-1".into(),
        target_id: "target-1".into(),
        workspace_id: IntegrationNullable::Value("workspace-1".into()),
        identity_generation: "generation-1".into(),
        target_revision: "revision-1".into(),
        organization_id: None,
    }
}

fn request(operation: &str, input: &str) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: format!("request-{operation}"),
        scope: scope(),
        operation_id: Some(operation.into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: json!({"input": input}).as_object().unwrap().clone(),
    }
}

fn setup() -> (TempDir, PrivateDirectory, IntegrationOperationStore) {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(root.path()).unwrap();
    let store =
        IntegrationOperationStore::create_in(&parent, OsStr::new("operations"), &scope()).unwrap();
    (root, parent, store)
}

fn update(
    revision: u64,
    phase: IntegrationOperationPhase,
    recovery: Option<IntegrationRecovery>,
) -> IntegrationOperationUpdate {
    IntegrationOperationUpdate {
        expected_revision: revision,
        phase,
        entity_ref: None,
        error: recovery.map(|recovery| IntegrationError {
            code: "OPERATION_OUTCOME".into(),
            recovery,
            message_key: "operation.outcome".into(),
        }),
        runtime_acceptance: None,
        observed_at_ms: SETTLED_AT,
    }
}

fn completed(store: &IntegrationOperationStore, operation: &str) {
    store
        .begin(&request(operation, "original"), "P-MEMORY", "write", 1000)
        .unwrap();
    store
        .compare_and_swap(
            operation,
            update(1, IntegrationOperationPhase::Executing, None),
        )
        .unwrap();
    store
        .compare_and_swap(
            operation,
            update(2, IntegrationOperationPhase::Completed, None),
        )
        .unwrap();
}

fn binding_version(parent: &PrivateDirectory) -> u32 {
    let directory = parent
        .open_entry_handle(OsStr::new("operations"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    read_binding(&directory).unwrap().version
}

#[test]
fn retired_receipt_replays_the_original_and_never_accepts_another_intent() {
    let (root, parent, store) = setup();
    completed(&store, "settled");
    let inside = store.retire_settled(AFTER_WINDOW - 1, |_| false).unwrap();
    assert_eq!((inside.retired, inside.kept), (0, 1));
    assert_eq!(binding_version(&parent), 1, "no retirement, no upgrade");

    let swept = store.retire_settled(AFTER_WINDOW, |_| false).unwrap();
    assert_eq!(swept.retired, 1);
    assert_eq!(binding_version(&parent), 2);
    assert_eq!(store.live_count().unwrap(), 0);

    let original = store.read("settled").unwrap().unwrap();
    assert_eq!(original.phase, IntegrationOperationPhase::Completed);
    // A lost reply is replayed from the retired receipt; nothing is re-created.
    assert_eq!(
        store
            .begin(&request("settled", "original"), "P-MEMORY", "write", 9)
            .unwrap(),
        IntegrationOperationBegin::Existing(original.clone())
    );
    assert_eq!(store.live_count().unwrap(), 0);
    assert_eq!(
        store
            .begin(&request("settled", "different"), "P-MEMORY", "write", 9)
            .unwrap_err()
            .to_string(),
        "integration operation intent conflict"
    );
    assert_eq!(
        store
            .read_original(&request("settled", "original"), "P-MEMORY", "write")
            .unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        store
            .compare_and_swap(
                "settled",
                update(3, IntegrationOperationPhase::Completed, None)
            )
            .unwrap_err()
            .to_string(),
        "integration operation retired"
    );
    // Idempotent, and a reopened store reads the same history.
    assert_eq!(
        store
            .retire_settled(AFTER_WINDOW, |_| false)
            .unwrap()
            .retired,
        0
    );
    drop(store);
    let reopened =
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &scope())
            .unwrap();
    assert_eq!(reopened.read("settled").unwrap(), Some(original));
}

#[test]
fn unknown_unsettled_and_referenced_receipts_are_never_retired() {
    let (_root, parent, store) = setup();
    store
        .begin(&request("pending", "x"), "P-MEMORY", "write", 1000)
        .unwrap();
    store
        .begin(&request("unknown", "x"), "P-MEMORY", "write", 1000)
        .unwrap();
    store
        .compare_and_swap(
            "unknown",
            update(
                1,
                IntegrationOperationPhase::Unknown,
                Some(IntegrationRecovery::ReconcileOriginal),
            ),
        )
        .unwrap();
    store
        .begin(&request("retry-read", "x"), "P-MEMORY", "write", 1000)
        .unwrap();
    store
        .compare_and_swap(
            "retry-read",
            update(
                1,
                IntegrationOperationPhase::Rejected,
                Some(IntegrationRecovery::RetryRead),
            ),
        )
        .unwrap();
    completed(&store, "referenced");
    let swept = store
        .retire_settled(u64::MAX / 2, |receipt| receipt.operation_id == "referenced")
        .unwrap();
    assert_eq!(swept.retired, 0);
    assert_eq!(swept.kept, 1);
    assert_eq!(store.live_count().unwrap(), 4);
    assert_eq!(binding_version(&parent), 1);
}

#[test]
fn capacity_counts_live_receipts_and_recovers_after_retirement() {
    let (_root, _parent, store) = setup();
    for index in 0..MAX_INTEGRATION_OPERATION_RECORDS {
        completed(&store, &format!("settled-{index}"));
    }
    assert_eq!(
        store
            .begin(&request("blocked", "x"), "P-MEMORY", "write", 1000)
            .unwrap_err()
            .to_string(),
        "integration operation capacity reached"
    );
    assert!(store.read("blocked").unwrap().is_none());
    let swept = store.retire_settled(AFTER_WINDOW, |_| false).unwrap();
    assert_eq!(swept.retired, MAX_INTEGRATION_OPERATION_RECORDS);
    assert!(matches!(
        store
            .begin(&request("admitted", "x"), "P-MEMORY", "write", 1000)
            .unwrap(),
        IntegrationOperationBegin::Created(_)
    ));
}

#[test]
fn crash_after_upgrade_or_between_renames_leaves_a_readable_store() {
    let (root, parent, store) = setup();
    completed(&store, "first");
    completed(&store, "second");
    // Crash after the binding upgrade, before any rename.
    store.mark_retirement_capable().unwrap();
    assert_eq!(binding_version(&parent), 2);
    drop(store);
    let path = root.path().join("operations");
    let store = IntegrationOperationStore::open_existing(&path, &scope()).unwrap();
    assert_eq!(store.live_count().unwrap(), 2);
    // Crash between two renames: one receipt retired, the other still live.
    let mut seen = 0;
    let partial = store
        .retire_settled(AFTER_WINDOW, |receipt| {
            seen += 1;
            receipt.operation_id == "second"
        })
        .unwrap();
    assert_eq!((partial.retired, seen), (1, 2));
    drop(store);
    let store = IntegrationOperationStore::open_existing(&path, &scope()).unwrap();
    assert!(store.read("first").unwrap().is_some());
    assert!(store.read("second").unwrap().is_some());
    assert_eq!(
        store
            .retire_settled(AFTER_WINDOW, |_| false)
            .unwrap()
            .retired,
        1
    );
    assert_eq!(store.live_count().unwrap(), 0);
    // A live receipt beside a retired twin is corruption, not a fresh id.
    let directory = parent
        .open_entry_handle(OsStr::new("operations"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    let twin = directory
        .open_single_link_regular_file(OsStr::new(&retired_name("first").unwrap()))
        .unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut &twin, &mut bytes).unwrap();
    directory
        .atomic_replace(OsStr::new(&record_name("first").unwrap()), &bytes)
        .unwrap();
    assert!(store.retire_settled(AFTER_WINDOW, |_| false).is_err());
}

#[test]
fn a_concurrent_writer_makes_retirement_busy_without_changes() {
    let (_root, parent, store) = setup();
    completed(&store, "settled");
    let held = store.writer().unwrap();
    let busy = store.retire_settled(AFTER_WINDOW, |_| false).unwrap();
    assert!(busy.busy);
    assert_eq!(busy.retired, 0);
    drop(held);
    assert_eq!(binding_version(&parent), 1);
    // Two handles racing: exactly one retirement happens, both read it.
    let other =
        IntegrationOperationStore::open_in(&parent, OsStr::new("operations"), &scope()).unwrap();
    let first = store.retire_settled(AFTER_WINDOW, |_| false).unwrap();
    let second = other.retire_settled(AFTER_WINDOW, |_| false).unwrap();
    assert_eq!(first.retired + second.retired, 1);
    assert!(other.read("settled").unwrap().is_some());
}

#[test]
fn version_one_stores_still_open_and_future_versions_are_refused() {
    let (root, parent, store) = setup();
    completed(&store, "settled");
    drop(store);
    let path = root.path().join("operations");
    assert!(IntegrationOperationStore::open_existing(&path, &scope()).is_ok());
    let directory = parent
        .open_entry_handle(OsStr::new("operations"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    let mut binding = read_binding(&directory).unwrap();
    binding.version = 3;
    directory
        .atomic_replace(
            OsStr::new("owner.json"),
            &serde_json::to_vec(&binding).unwrap(),
        )
        .unwrap();
    assert!(IntegrationOperationStore::open_existing(&path, &scope()).is_err());
}
