use super::*;
use serde_json::json;

fn request() -> Value {
    json!({
        "contractVersion": "parallel-v1",
        "requestId": "request-1",
        "scope": {
            "accountId": "account-1", "targetId": "target-1",
            "workspaceId": "workspace-1",
            "identityGeneration": "generation-1", "targetRevision": "revision-1"
        },
        "operationId": "operation-1", "timeoutMs": 10000, "payload": {}
    })
}

fn reply() -> Value {
    json!({
        "contractVersion": "parallel-v1", "requestId": "request-1",
        "status": "accepted", "operationId": "operation-1",
        "entityRevision": "revision-1", "observedAt": "2026-10-24T00:00:00Z",
        "result": {"taskState": "running"}, "error": null
    })
}

#[test]
fn valid_request_roundtrips_without_changing_scope() {
    let value = request();
    let decoded: IntegrationRequest = serde_json::from_value(value.clone()).unwrap();
    decoded.validate(true).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
}

#[test]
fn personal_owner_normalizes_optional_null_organization() {
    let mut decoded: IntegrationRequest = serde_json::from_value(request()).unwrap();
    let original = IntegrationOwner::from(&decoded.scope);
    decoded.scope.organization_id = Some(IntegrationNullable::Null);
    assert_eq!(IntegrationOwner::from(&decoded.scope), original);
}

#[test]
fn task_recovery_requires_original_task_or_thread_and_turn_identity() {
    let valid = [
        json!({"threadId":"thread","turnId":"turn"}),
        json!({"taskId":"native-task"}),
        json!({"threadId":"thread","taskId":"native-task"}),
    ];
    for value in valid {
        serde_json::from_value::<IntegrationRuntimeReadTaskParams>(value)
            .unwrap()
            .validate()
            .unwrap();
    }
    for value in [
        json!({}),
        json!({"threadId":"thread"}),
        json!({"turnId":"turn"}),
        json!({"taskId":""}),
    ] {
        assert!(
            serde_json::from_value::<IntegrationRuntimeReadTaskParams>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}

#[test]
fn operation_lookup_null_is_explicit_and_legacy_acceptance_stays_absent() {
    let lookup: IntegrationOperationReadResult =
        serde_json::from_value(json!({"receipt":null})).unwrap();
    assert!(lookup.receipt.as_ref().is_none());
    assert!(lookup.unsubmitted_input.is_none());
    assert_eq!(
        serde_json::to_value(&lookup).unwrap(),
        json!({"receipt":null})
    );
    assert!(serde_json::from_value::<IntegrationOperationReadResult>(json!({})).is_err());
    let value = json!({"operationId":"op","scope":request()["scope"],"port":"P-RUNTIME","method":"acceptTask",
        "revision":1,"phase":"accepted","createdAtMs":1,"updatedAtMs":2,"entityRef":null,"error":null});
    let receipt: IntegrationOperationReceipt = serde_json::from_value(value).unwrap();
    assert!(receipt.runtime_acceptance.is_none());
    assert!(
        !serde_json::to_value(receipt)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("runtimeAcceptance")
    );
}

#[test]
fn caller_cannot_add_authority_to_scope() {
    let mut value = request();
    value["scope"]["trusted"] = json!(true);
    assert!(serde_json::from_value::<IntegrationRequest>(value).is_err());
}

#[test]
fn envelope_rejects_credential_headers_and_unknown_versions() {
    let mut value = request();
    value["credential"] = json!("synthetic-test-value");
    assert!(serde_json::from_value::<IntegrationRequest>(value).is_err());
    let mut value = request();
    value["contractVersion"] = json!("other");
    assert!(serde_json::from_value::<IntegrationRequest>(value).is_err());
}

#[test]
fn workspace_null_is_explicit_and_not_an_omitted_field() {
    let mut value = request();
    value["scope"]["workspaceId"] = Value::Null;
    let decoded: IntegrationRequest = serde_json::from_value(value.clone()).unwrap();
    decoded.validate(false).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    value["scope"]
        .as_object_mut()
        .unwrap()
        .remove("workspaceId");
    assert!(serde_json::from_value::<IntegrationRequest>(value).is_err());
}

#[test]
fn write_requires_operation_identity_and_bounded_wait() {
    let mut value = request();
    value.as_object_mut().unwrap().remove("operationId");
    let mut decoded: IntegrationRequest = serde_json::from_value(value).unwrap();
    assert!(decoded.validate(true).is_err());
    decoded.validate(false).unwrap();
    decoded.timeout_ms = 60001;
    assert!(decoded.validate(false).is_err());
    decoded.timeout_ms = 0;
    assert!(decoded.validate(false).is_err());
}

#[test]
fn identifier_bounds_preserve_case_and_count_unicode_characters() {
    let mut decoded: IntegrationRequest = serde_json::from_value(request()).unwrap();
    decoded.scope.account_id = "界".repeat(256);
    decoded.validate(true).unwrap();
    decoded.scope.account_id.push('界');
    assert!(decoded.validate(true).is_err());
}

#[test]
fn accepted_needs_original_identity_and_cannot_contain_error() {
    let mut decoded: IntegrationReply = serde_json::from_value(reply()).unwrap();
    decoded.validate().unwrap();
    decoded.operation_id = IntegrationNullable::Null;
    assert!(decoded.validate().is_err());
    decoded.operation_id = IntegrationNullable::Value("operation-1".into());
    decoded.error = IntegrationNullable::Value(IntegrationError {
        code: "RESOURCE_DENIED".into(),
        recovery: IntegrationRecovery::None,
        message_key: "resource.denied".into(),
    });
    assert!(decoded.validate().is_err());
}

#[test]
fn completed_read_does_not_claim_task_completion() {
    let mut value = reply();
    value["status"] = json!("completed");
    let decoded: IntegrationReply = serde_json::from_value(value).unwrap();
    decoded.validate().unwrap();
    assert_eq!(decoded.result.as_ref().unwrap()["taskState"], "running");
}

#[test]
fn unknown_requires_error_and_never_carries_success_result() {
    let mut value = reply();
    value["status"] = json!("unknown");
    value["result"] = Value::Null;
    let mut decoded: IntegrationReply = serde_json::from_value(value).unwrap();
    assert!(decoded.validate().is_err());
    decoded.error = IntegrationNullable::Value(IntegrationError {
        code: "OPERATION_UNCONFIRMED".into(),
        recovery: IntegrationRecovery::ReconcileOriginal,
        message_key: "operation.unknown".into(),
    });
    decoded.validate().unwrap();
    decoded.result = IntegrationNullable::Value(Map::new());
    assert!(decoded.validate().is_err());
}

#[test]
fn reply_requires_explicit_nullable_fields() {
    for name in ["operationId", "entityRevision", "result", "error"] {
        let mut value = reply();
        value.as_object_mut().unwrap().remove(name);
        assert!(
            serde_json::from_value::<IntegrationReply>(value).is_err(),
            "{name}"
        );
    }
}

#[test]
fn invalid_error_never_echoes_the_input() {
    let error = IntegrationError {
        code: "secret-example-value".into(),
        recovery: IntegrationRecovery::None,
        message_key: "error".into(),
    }
    .validate()
    .unwrap_err();
    assert_eq!(error.field, "error.code");
    assert!(!error.to_string().contains("secret-example-value"));
}
