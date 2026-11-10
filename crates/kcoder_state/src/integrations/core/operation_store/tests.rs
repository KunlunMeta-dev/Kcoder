use super::*;
use kcoder_types::integrations::core::{
    IntegrationContractVersion, IntegrationNullable, IntegrationRecovery, IntegrationTaskState,
};
use serde_json::json;
use tempfile::TempDir;

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

fn native_acceptance() -> IntegrationRuntimeAcceptance {
    IntegrationRuntimeAcceptance {
        thread_id: "native-thread".into(),
        turn_id: Some("original-turn".into()),
        task_id: Some("original-task".into()),
        state: IntegrationTaskState::Running,
    }
}

#[test]
fn original_native_acceptance_is_atomic_durable_and_immutable() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    store
        .compare_and_swap(
            "operation-1",
            update(1, IntegrationOperationPhase::Executing),
        )
        .unwrap();
    let receipt = store
        .compare_and_swap(
            "operation-1",
            IntegrationOperationUpdate {
                runtime_acceptance: Some(native_acceptance()),
                ..update(2, IntegrationOperationPhase::Accepted)
            },
        )
        .unwrap();
    assert_eq!(receipt.runtime_acceptance, Some(native_acceptance()));
    let mut wrong = native_acceptance();
    wrong.turn_id = Some("later-turn".into());
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                IntegrationOperationUpdate {
                    runtime_acceptance: Some(wrong),
                    ..unresolved(3)
                }
            )
            .is_err()
    );
    assert_eq!(
        store.read("operation-1").unwrap().unwrap().phase,
        IntegrationOperationPhase::Accepted
    );
    drop(store);
    let reopened =
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &scope())
            .unwrap();
    assert_eq!(
        reopened
            .read("operation-1")
            .unwrap()
            .unwrap()
            .runtime_acceptance,
        Some(native_acceptance())
    );
    let completed = reopened
        .compare_and_swap(
            "operation-1",
            update(3, IntegrationOperationPhase::Completed),
        )
        .unwrap();
    assert_eq!(completed.runtime_acceptance, Some(native_acceptance()));
}

#[test]
fn native_reference_cannot_be_published_before_acceptance_or_on_another_port() {
    let (_root, store) = setup();
    store
        .begin(&request(), "P-ASSET", "publishManifest", 1000)
        .unwrap();
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                IntegrationOperationUpdate {
                    runtime_acceptance: Some(native_acceptance()),
                    ..update(1, IntegrationOperationPhase::Executing)
                }
            )
            .is_err()
    );
    assert_eq!(store.read("operation-1").unwrap().unwrap().revision, 1);
    store
        .compare_and_swap(
            "operation-1",
            update(1, IntegrationOperationPhase::Executing),
        )
        .unwrap();
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                IntegrationOperationUpdate {
                    runtime_acceptance: Some(native_acceptance()),
                    ..update(2, IntegrationOperationPhase::Completed)
                }
            )
            .is_err()
    );
    assert!(
        store
            .read("operation-1")
            .unwrap()
            .unwrap()
            .runtime_acceptance
            .is_none()
    );
}

fn request() -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "request-1".into(),
        scope: scope(),
        operation_id: Some("operation-1".into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: json!({"input":{"second":2,"first":1},"assistantVersion":"1"})
            .as_object()
            .unwrap()
            .clone(),
    }
}

fn setup() -> (TempDir, IntegrationOperationStore) {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_or_create(root.path()).unwrap();
    let store =
        IntegrationOperationStore::create_in(&parent, OsStr::new("operations"), &scope()).unwrap();
    (root, store)
}

fn update(revision: u64, phase: IntegrationOperationPhase) -> IntegrationOperationUpdate {
    IntegrationOperationUpdate {
        expected_revision: revision,
        phase,
        entity_ref: None,
        error: None,
        runtime_acceptance: None,
        observed_at_ms: 2000,
    }
}

fn unresolved(revision: u64) -> IntegrationOperationUpdate {
    IntegrationOperationUpdate {
        error: Some(IntegrationError {
            code: "OPERATION_UNCONFIRMED".into(),
            recovery: IntegrationRecovery::ReconcileOriginal,
            message_key: "operation.unknown".into(),
        }),
        ..update(revision, IntegrationOperationPhase::Unknown)
    }
}

#[test]
fn begin_is_durable_and_reuses_the_original_operation() {
    let (root, store) = setup();
    assert!(matches!(
        store
            .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
            .unwrap(),
        IntegrationOperationBegin::Created(_)
    ));
    drop(store);
    let store = IntegrationOperationStore::open_existing(&root.path().join("operations"), &scope())
        .unwrap();
    let mut retry = request();
    retry.request_id = "new-request".into();
    retry.timeout_ms = 2000;
    let result = store
        .begin(&retry, "P-RUNTIME", "acceptTask", 1500)
        .unwrap();
    assert!(matches!(result, IntegrationOperationBegin::Existing(_)));
    assert_eq!(result.receipt().revision, 1);
    assert_eq!(result.receipt().created_at_ms, 1000);
}

#[test]
fn omitted_and_null_personal_organization_share_a_stable_owner_and_intent() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let mut with_null = request();
    with_null.scope.organization_id = Some(IntegrationNullable::Null);
    let reopened =
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &with_null.scope)
            .unwrap();
    assert!(matches!(
        reopened
            .begin(&with_null, "P-RUNTIME", "acceptTask", 1500)
            .unwrap(),
        IntegrationOperationBegin::Existing(_)
    ));
}

#[test]
fn changed_intent_method_scope_and_model_revision_do_not_replace_receipts() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let mut changed = request();
    changed
        .payload
        .insert("assistantVersion".into(), json!("2"));
    assert!(
        store
            .begin(&changed, "P-RUNTIME", "acceptTask", 1100)
            .is_err()
    );
    assert!(
        store
            .begin(&request(), "P-RUNTIME", "cancelTask", 1100)
            .is_err()
    );
    let mut wrong_scope = scope();
    wrong_scope.workspace_id = IntegrationNullable::Value("other-workspace".into());
    assert!(
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &wrong_scope)
            .is_err()
    );
    assert_eq!(store.read("operation-1").unwrap().unwrap().revision, 1);
}

#[test]
fn current_login_can_read_original_receipts_without_reauthorizing_the_old_operation() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let mut refreshed = scope();
    refreshed.identity_generation = "generation-2".into();
    let store =
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &refreshed)
            .unwrap();
    assert_eq!(
        store
            .read("operation-1")
            .unwrap()
            .unwrap()
            .scope
            .identity_generation,
        "generation-1"
    );
    let mut retry = request();
    retry.scope = refreshed;
    assert!(
        store
            .begin(&retry, "P-RUNTIME", "acceptTask", 1500)
            .is_err()
    );
}

#[test]
fn execution_claim_is_cas_and_unknown_effects_cannot_return_to_executing() {
    let (_root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let running = store
        .compare_and_swap(
            "operation-1",
            update(1, IntegrationOperationPhase::Executing),
        )
        .unwrap();
    assert_eq!(running.revision, 2);
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                update(1, IntegrationOperationPhase::Executing)
            )
            .is_err()
    );
    store
        .compare_and_swap("operation-1", unresolved(2))
        .unwrap();
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                update(3, IntegrationOperationPhase::Executing)
            )
            .is_err()
    );
    store
        .compare_and_swap(
            "operation-1",
            update(3, IntegrationOperationPhase::Completed),
        )
        .unwrap();
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                update(4, IntegrationOperationPhase::Executing)
            )
            .is_err()
    );
}

#[test]
fn corrected_clock_does_not_drop_an_authoritative_completion() {
    let (_root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    store
        .compare_and_swap(
            "operation-1",
            update(1, IntegrationOperationPhase::Executing),
        )
        .unwrap();
    let receipt = store
        .compare_and_swap(
            "operation-1",
            IntegrationOperationUpdate {
                observed_at_ms: 1500,
                ..update(2, IntegrationOperationPhase::Completed)
            },
        )
        .unwrap();
    assert_eq!(receipt.updated_at_ms, 2000);
}

#[test]
fn cancelled_operations_cannot_be_reopened_by_a_late_callback() {
    let (_root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    store
        .compare_and_swap(
            "operation-1",
            update(1, IntegrationOperationPhase::CancelRequested),
        )
        .unwrap();
    store
        .compare_and_swap(
            "operation-1",
            update(2, IntegrationOperationPhase::Cancelled),
        )
        .unwrap();
    assert!(
        store
            .compare_and_swap(
                "operation-1",
                update(3, IntegrationOperationPhase::Accepted)
            )
            .is_err()
    );
}

#[test]
fn read_does_not_create_a_missing_record_and_cannot_adopt_orphaned_storage() {
    let (root, store) = setup();
    assert!(store.read("missing").unwrap().is_none());
    assert_eq!(
        std::fs::read_dir(root.path().join("operations"))
            .unwrap()
            .count(),
        2
    );
    let orphan = root.path().join("orphan");
    PrivateDirectory::open_or_create(&orphan).unwrap();
    assert!(IntegrationOperationStore::open_existing(&orphan, &scope()).is_err());
    assert!(!orphan.join("owner.json").exists());
}

#[test]
fn stored_receipts_do_not_contain_raw_user_material() {
    let (root, store) = setup();
    let mut value = request();
    value
        .payload
        .insert("body".into(), json!("private-task-material-marker"));
    store
        .begin(&value, "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let bytes = std::fs::read(
        root.path()
            .join("operations")
            .join(record_name("operation-1").unwrap()),
    )
    .unwrap();
    assert!(
        !String::from_utf8(bytes)
            .unwrap()
            .contains("private-task-material-marker")
    );
}

#[test]
fn copying_a_binding_to_another_directory_cannot_claim_the_original_store() {
    let (root, _store) = setup();
    let copy = root.path().join("copy");
    PrivateDirectory::open_or_create(&copy).unwrap();
    std::fs::copy(
        root.path().join("operations/owner.json"),
        copy.join("owner.json"),
    )
    .unwrap();
    assert!(IntegrationOperationStore::open_existing(&copy, &scope()).is_err());
}

#[test]
fn writer_contention_fails_before_creating_a_second_operation() {
    let (_root, store) = setup();
    let held = store
        .directory
        .try_exclusive_lock(OsStr::new("operations.lock"))
        .unwrap()
        .unwrap();
    assert!(
        store
            .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
            .is_err()
    );
    drop(held);
    assert!(store.read("operation-1").unwrap().is_none());
    assert!(matches!(
        store
            .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
            .unwrap(),
        IntegrationOperationBegin::Created(_)
    ));
}

#[test]
fn corrupted_record_is_not_repaired_or_recreated() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let path = root
        .path()
        .join("operations")
        .join(record_name("operation-1").unwrap());
    std::fs::write(&path, b"not json").unwrap();
    assert!(store.read("operation-1").is_err());
    assert!(
        store
            .begin(&request(), "P-RUNTIME", "acceptTask", 2000)
            .is_err()
    );
    assert_eq!(std::fs::read(path).unwrap(), b"not json");
}

#[test]
fn a_deleted_or_replaced_lock_is_not_recreated_or_adopted() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let lock = root.path().join("operations/operations.lock");
    std::fs::remove_file(&lock).unwrap();
    assert!(
        store
            .begin(&request(), "P-RUNTIME", "acceptTask", 2000)
            .is_err()
    );
    assert!(!lock.exists());
    let directory = PrivateDirectory::open_existing(&root.path().join("operations")).unwrap();
    directory
        .append(OsStr::new("operations.lock"), b"")
        .unwrap();
    assert!(store.read("operation-1").is_err());
    assert!(
        IntegrationOperationStore::open_existing(&root.path().join("operations"), &scope())
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn hard_link_alias_is_rejected_on_read() {
    let (root, store) = setup();
    store
        .begin(&request(), "P-RUNTIME", "acceptTask", 1000)
        .unwrap();
    let record = root
        .path()
        .join("operations")
        .join(record_name("operation-1").unwrap());
    std::fs::hard_link(record, root.path().join("alias.json")).unwrap();
    assert!(store.read("operation-1").is_err());
}

#[test]
fn original_intent_reads_match_the_receipt_without_mutation_or_writer_ownership() {
    let (_root, store) = setup();
    let original = request();
    assert!(
        store
            .read_original(&original, "P-RUNTIME", "acceptTask")
            .unwrap()
            .is_none()
    );
    let before = store
        .begin(&original, "P-RUNTIME", "acceptTask", 1000)
        .unwrap()
        .receipt()
        .clone();
    let _writer = store.writer().unwrap();
    assert_eq!(
        store
            .read_original(&original, "P-RUNTIME", "acceptTask")
            .unwrap(),
        Some(before.clone())
    );
    assert_eq!(store.read("operation-1").unwrap(), Some(before));
    let mut changed = original.clone();
    changed
        .payload
        .insert("assistantVersion".into(), json!("changed"));
    assert!(
        store
            .read_original(&changed, "P-RUNTIME", "acceptTask")
            .is_err()
    );
    assert!(
        store
            .read_original(&original, "P-RUNTIME", "cancelTask")
            .is_err()
    );
    changed = original;
    changed.operation_id = Some("never-begun".into());
    assert!(
        store
            .read_original(&changed, "P-RUNTIME", "acceptTask")
            .unwrap()
            .is_none()
    );
    assert!(store.read("never-begun").unwrap().is_none());
}
