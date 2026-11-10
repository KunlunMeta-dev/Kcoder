use super::*;

fn evidence() -> BackgroundTerminalEvidence {
    BackgroundTerminalEvidence {
        schema_version: BACKGROUND_TERMINAL_EVIDENCE_V1,
        event: BackgroundEventIdentity::terminal(BackgroundRunKey {
            parent_session_id: "session-1".into(),
            agent_id: "job-1".into(),
            run_id: "run-1".into(),
        }),
        status: TaskStatus::Completed,
        payload_state: BackgroundPayloadState::Captured,
        payload: Some(BackgroundPayloadRef {
            kind: BackgroundPayloadKind::ToolOutput,
            object_id: "object_1".into(),
            sha256: "a".repeat(64),
            bytes: 37,
        }),
        completeness: BackgroundContentCompleteness::Unobserved,
        output_is_error: Some(false),
        process: BackgroundProcessFacts {
            state: BackgroundProcessState::Observed,
            exit_code: Some(141),
            signal: None,
        },
    }
}

#[test]
fn result_contract_roundtrips_exact_identity_and_raw_process_exit() {
    let value = evidence();
    value.validate_for_storage().unwrap();
    let encoded = serde_json::to_value(&value).unwrap();
    let decoded: BackgroundTerminalEvidence = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded, value);
    assert_eq!(decoded.process.exit_code, Some(141));
    assert_eq!(
        decoded.completeness,
        BackgroundContentCompleteness::Unobserved
    );
}

#[test]
fn unknown_same_schema_labels_remain_readable_but_do_not_authorize_storage() {
    let mut encoded = serde_json::to_value(evidence()).unwrap();
    encoded["completeness"] = serde_json::json!("future_capture_kind");
    let decoded: BackgroundTerminalEvidence = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(&decoded).unwrap(), encoded);
    assert!(decoded.validate_shape().is_ok());
    assert!(decoded.validate_for_storage().is_err());
    encoded["event"]["futureIdentityField"] = serde_json::json!(true);
    assert!(serde_json::from_value::<BackgroundTerminalEvidence>(encoded).is_err());
}

#[test]
fn diagnostic_cannot_claim_complete_output_and_missing_object_cannot_claim_capture() {
    let mut value = evidence();
    value.payload.as_mut().unwrap().kind = BackgroundPayloadKind::TerminalDiagnostic;
    value.completeness = BackgroundContentCompleteness::Complete;
    assert!(value.validate_for_storage().is_err());
    value.completeness = BackgroundContentCompleteness::Unobserved;
    assert!(value.validate_for_storage().is_ok());
    value.payload = None;
    assert!(value.validate_for_storage().is_err());
    value.payload_state = BackgroundPayloadState::TooLarge;
    assert!(value.validate_for_storage().is_ok());
}

#[test]
fn process_status_and_terminal_state_are_not_guessed() {
    let mut value = evidence();
    value.process.exit_code = None;
    assert!(value.validate_for_storage().is_err());
    value.process.state = BackgroundProcessState::Indeterminate;
    assert!(value.validate_for_storage().is_ok());
    value.process.signal = Some(9);
    assert!(value.validate_for_storage().is_err());
    value.process.state = BackgroundProcessState::Observed;
    assert!(value.validate_for_storage().is_ok());
    // The terminal record and producer flag are separate observed facts.
    // Reconciliation decides what their disagreement means.
    value.output_is_error = Some(true);
    assert!(value.validate_for_storage().is_ok());
    value.status = TaskStatus::Failed;
    assert!(value.validate_for_storage().is_ok());
}

#[test]
fn unsafe_or_oversize_private_object_references_are_rejected() {
    let mut value = evidence();
    value.payload.as_mut().unwrap().object_id = "../another".into();
    assert!(value.validate_for_storage().is_err());
    value.payload.as_mut().unwrap().object_id = "valid".into();
    value.payload.as_mut().unwrap().sha256 = "A".repeat(64);
    assert!(value.validate_for_storage().is_err());
    value.payload.as_mut().unwrap().sha256 = "a".repeat(64);
    value.payload.as_mut().unwrap().bytes = MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES + 1;
    assert!(value.validate_for_storage().is_err());
}

#[test]
fn unsupported_multimodal_payload_is_distinct_from_not_provided() {
    let mut value = evidence();
    value.payload_state = BackgroundPayloadState::Unsupported;
    value.payload = None;
    value.validate_for_storage().unwrap();
    let encoded = serde_json::to_value(&value).unwrap();
    assert_eq!(encoded["payloadState"], "unsupported");
    let decoded: BackgroundTerminalEvidence = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded.payload_state, BackgroundPayloadState::Unsupported);
    assert_ne!(decoded.payload_state, BackgroundPayloadState::NotProvided);
    value.payload = evidence().payload;
    assert!(value.validate_for_storage().is_err());
}
