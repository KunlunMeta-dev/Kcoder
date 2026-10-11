#[tokio::test]
async fn workspace_operation_receipt_replays_exact_result_and_rejects_parameter_reuse() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let target = workspace.path().join("new-project");
    let request_id = "review-workspace-operation-0001";
    let params = json!({
        "workspacePath": target.to_string_lossy(),
        "clientRequestId": request_id,
        "deviceId": "server-review",
        "action": "create",
        "label": "Project",
    });

    let first = workspace_request(&engine, "runtime.workspaces.prepare", &params)
        .await
        .unwrap();
    assert!(target.is_dir(), "create must perform its requested effect");
    let listed_before = workspace_request(&engine, "runtime.workspaces.list", &json!({}))
        .await
        .unwrap();

    let replay = workspace_request(&engine, "runtime.workspaces.prepare", &params)
        .await
        .unwrap();
    let listed_after = workspace_request(&engine, "runtime.workspaces.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(
        replay, first,
        "same ID must return the original receipt result"
    );
    assert_eq!(
        listed_after, listed_before,
        "replay must not mutate the registry again"
    );

    let reader = runtime_context_test_engine(workspace.path(), None);
    let receipt = workspace_request(
        &reader,
        "runtime.workspaces.operation/read",
        &json!({ "clientRequestId": request_id }),
    )
    .await
    .unwrap();
    assert_eq!(receipt["receipt"]["status"], "ready");
    assert_eq!(
        receipt["receipt"]["workspacePath"],
        target.to_string_lossy().as_ref()
    );

    let changed = json!({
        "workspacePath": target.to_string_lossy(),
        "clientRequestId": request_id,
        "deviceId": "server-review",
        "action": "create",
        "label": "Different label",
    });
    let error = workspace_request(&reader, "runtime.workspaces.prepare", &changed)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("different parameters"),
        "{error:#}"
    );
    assert_eq!(
        workspace_request(&reader, "runtime.workspaces.list", &json!({}))
            .await
            .unwrap(),
        listed_before,
        "a conflicting request must not change the registered workspace"
    );
}

#[tokio::test]
async fn unknown_reservation_never_dispatches_create_after_reconstruction() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let target = workspace.path().join("unknown-project");
    let request_id = "review-workspace-operation-0002";
    let params = json!({
        "workspacePath": target.to_string_lossy(),
        "clientRequestId": request_id,
        "deviceId": "server-review",
        "action": "create",
    });

    assert!(
        super::workspace_operation_receipts::reserve(
            &engine,
            request_id,
            "runtime.workspaces.prepare",
            &params,
        )
        .unwrap()
        .is_none()
    );
    assert!(
        !target.exists(),
        "reservation alone must not create the directory"
    );

    let reader = runtime_context_test_engine(workspace.path(), None);
    let receipt = workspace_request(
        &reader,
        "runtime.workspaces.operation/read",
        &json!({ "clientRequestId": request_id }),
    )
    .await
    .unwrap();
    assert_eq!(receipt["receipt"]["status"], "unknown");
    assert!(receipt["receipt"]["workspacePath"].is_null());

    let error = workspace_request(&reader, "runtime.workspaces.prepare", &params)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("completion is unknown"),
        "{error:#}"
    );
    assert!(
        !target.exists(),
        "a recovered unknown intent must not be replayed"
    );
}

#[tokio::test]
async fn invalid_workspace_path_is_rejected_before_receipt_reservation() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let request_id = "review-workspace-operation-0003";
    let params = json!({
        "workspacePath": "relative/path",
        "clientRequestId": request_id,
        "deviceId": "server-review",
        "action": "select",
    });

    assert!(
        workspace_request(&engine, "runtime.workspaces.prepare", &params)
            .await
            .is_err()
    );
    let receipt = workspace_request(
        &engine,
        "runtime.workspaces.operation/read",
        &json!({ "clientRequestId": request_id }),
    )
    .await
    .unwrap();
    assert!(
        receipt["receipt"].is_null(),
        "invalid input must not poison the ID"
    );
}

fn review_receipt_dir(engine: &QueryEngine) -> std::path::PathBuf {
    std::fs::read_dir(engine.client_storage_root().join("workspace-operations"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}

fn review_create_params(path: &std::path::Path, request_id: &str) -> Value {
    json!({
        "workspacePath": path.to_string_lossy(),
        "clientRequestId": request_id,
        "deviceId": "server-review",
        "action": "create",
    })
}

fn review_quota(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("quota")).unwrap()).unwrap()
}

#[tokio::test]
async fn missing_quota_migrates_existing_receipts_without_replaying_them() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let first = workspace.path().join("quota-legacy-first");
    let second = workspace.path().join("quota-legacy-second");
    let first_params = review_create_params(&first, "review-quota-legacy-0001");
    workspace_request(&engine, "runtime.workspaces.prepare", &first_params)
        .await
        .unwrap();
    let receipt_dir = review_receipt_dir(&engine);
    std::fs::remove_file(receipt_dir.join("quota")).unwrap();

    let second_params = review_create_params(&second, "review-quota-legacy-0002");
    workspace_request(&engine, "runtime.workspaces.prepare", &second_params)
        .await
        .unwrap();

    assert_eq!(review_quota(&receipt_dir)["reserved"], 2);
    assert!(first.is_dir() && second.is_dir());
}

#[tokio::test]
async fn corrupt_quota_fails_closed_without_resetting_or_mutating_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let first = workspace.path().join("quota-corrupt-first");
    workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &review_create_params(&first, "review-quota-corrupt-0001"),
    )
    .await
    .unwrap();
    let receipt_dir = review_receipt_dir(&engine);
    let corrupt = b"{ not a valid receipt quota";
    std::fs::write(receipt_dir.join("quota"), corrupt).unwrap();
    let target = workspace.path().join("must-not-be-created");

    let error = workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &review_create_params(&target, "review-quota-corrupt-0002"),
    )
    .await
    .unwrap_err();

    assert!(!target.exists(), "quota validation must precede mkdir");
    assert_eq!(std::fs::read(receipt_dir.join("quota")).unwrap(), corrupt);
    assert!(
        error.to_string().contains("workspace receipt quota")
            || error.to_string().contains("EOF")
            || error.to_string().contains("key must be a string"),
        "{error:#}"
    );
}

#[tokio::test]
async fn orphaned_counter_slot_is_not_reclaimed_and_existing_id_replays_before_quota() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let first = workspace.path().join("quota-orphan-first");
    workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &review_create_params(&first, "review-quota-orphan-0001"),
    )
    .await
    .unwrap();
    let receipt_dir = review_receipt_dir(&engine);
    // Model a crash after the durable counter increment and before its receipt write:
    // the reserved slot remains even when there is no corresponding JSON record.
    let first_record = std::fs::read_dir(&receipt_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .unwrap();
    std::fs::remove_file(first_record).unwrap();

    let second = workspace.path().join("quota-orphan-second");
    let second_params = review_create_params(&second, "review-quota-orphan-0002");
    let second_result = workspace_request(&engine, "runtime.workspaces.prepare", &second_params)
        .await
        .unwrap();
    assert_eq!(review_quota(&receipt_dir)["reserved"], 2);

    // Fill the ledger. A known completed ID must remain replayable at capacity,
    // while a new ID is rejected without creating a path.
    std::fs::write(
        receipt_dir.join("quota"),
        serde_json::to_vec(&json!({
            "version": 1,
            "workspace": std::fs::canonicalize(workspace.path()).unwrap().to_string_lossy(),
            "reserved": 4096,
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        workspace_request(&engine, "runtime.workspaces.prepare", &second_params)
            .await
            .unwrap(),
        second_result,
        "existing request ID is read/replayed before checking capacity"
    );
    assert_eq!(review_quota(&receipt_dir)["reserved"], 4096);

    let third = workspace.path().join("quota-over-capacity");
    let error = workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &review_create_params(&third, "review-quota-orphan-0003"),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("capacity reached"), "{error:#}");
    assert!(!third.exists());
    assert_eq!(review_quota(&receipt_dir)["reserved"], 4096);
}
