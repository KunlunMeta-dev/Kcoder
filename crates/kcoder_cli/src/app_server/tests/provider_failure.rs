// Terminal failure facts as a client receives them.
//
// R064: a "retryable" failure and a "resume-safe" failure are different answers,
// and neither of them is "this failed turn can be continued from its committed
// boundary" - that is a separate server capability. These assertions pin the wire
// shape so a client cannot collapse the three into one flag.

#[test]
fn a_response_that_had_started_is_retryable_but_not_resume_safe() {
    let details = kcoder_types::ProviderFailureDetails {
        category: kcoder_types::ProviderFailureCategory::NetworkError,
        recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
        http_status: None,
        retryable: true,
        // The attempt had already streamed output, so repeating it could duplicate
        // what the user has seen.
        resume_safe: false,
        retry_after_ms: Some(250),
    };
    let error = turn_completion_error(Some("connection reset".into()), Some(details)).unwrap();

    assert_eq!(error["code"], -32010);
    assert_eq!(error["message"], "connection reset");
    assert_eq!(error["details"]["retryable"], true);
    assert_eq!(error["details"]["resume_safe"], false);
    assert_eq!(error["details"]["retry_after_ms"], 250);
    assert_eq!(error["details"]["category"], "network_error");
    assert_eq!(error["details"]["recovery_action"], "needs_human");

    // The rule a client must follow: retryable alone never means resumable.
    let resumable =
        error["details"]["retryable"] == true && error["details"]["resume_safe"] == true;
    assert!(
        !resumable,
        "a started response must not be presented as resumable: {error}"
    );
}

#[test]
fn a_cancelled_turn_without_provider_facts_carries_no_invented_details() {
    // No facts is not the same as "safe": the field stays absent rather than
    // defaulting to retryable/resume_safe booleans nobody measured.
    let error = turn_completion_error(Some("cancelled by user".into()), None).unwrap();
    assert_eq!(error["code"], -32010);
    assert!(error["details"].is_null());
}

#[test]
fn continuing_a_failed_turn_is_not_encoded_in_the_failure_facts() {
    // The continuation capability is negotiated separately; the failure payload
    // must not claim a resumability the server has not been asked for.
    let details = kcoder_types::ProviderFailureDetails {
        category: kcoder_types::ProviderFailureCategory::TimeoutError,
        recovery_action: kcoder_types::ProviderFailureRecoveryAction::DiagnoseOnly,
        http_status: Some(504),
        retryable: true,
        resume_safe: true,
        retry_after_ms: None,
    };
    let error = turn_completion_error(Some("gateway timeout".into()), Some(details)).unwrap();
    let serialized = error.to_string();
    for absent in ["retryFromTurnId", "retryOperationId", "continuation"] {
        assert!(
            !serialized.contains(absent),
            "{absent} must not be smuggled through the failure facts: {serialized}"
        );
    }
}
