#[cfg(any(test, feature = "test-oracle"))]
use crate::safe_error;
#[cfg(any(test, feature = "test-oracle"))]
use kcoder_types::integrations::core::{IntegrationError, IntegrationRecovery};

pub fn configuration_rejection_code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        let code = match cause.to_string().as_str() {
            "MODEL_NATIVE_INHERITED_CONFIGURATION_CHANGED" => {
                "MODEL_NATIVE_INHERITED_CONFIGURATION_CHANGED"
            }
            "MODEL_NATIVE_CONFIGURATION_CHANGED" => "MODEL_NATIVE_CONFIGURATION_CHANGED",
            "MODEL_NATIVE_PROVIDER_REQUIRED" => "MODEL_NATIVE_PROVIDER_REQUIRED",
            "RUNTIME_MODEL_REVISION_MISMATCH" => "RUNTIME_MODEL_REVISION_MISMATCH",
            "RUNTIME_NATIVE_POLICY_UNAVAILABLE" => "RUNTIME_NATIVE_POLICY_UNAVAILABLE",
            "RUNTIME_THREAD_NOT_RESIDENT" => "RUNTIME_THREAD_NOT_RESIDENT",
            "RUNTIME_THREAD_BUSY" => "RUNTIME_THREAD_BUSY",
            "RUNTIME_CANDIDATE_OWNER_MISMATCH" => "RUNTIME_CANDIDATE_OWNER_MISMATCH",
            "RUNTIME_TOOL_CEILING_UNCONFIRMED" => "RUNTIME_TOOL_CEILING_UNCONFIRMED",
            "RUNTIME_WORKFLOW_TOOL_UNAVAILABLE" => "RUNTIME_WORKFLOW_TOOL_UNAVAILABLE",
            "RUNTIME_WORKFLOW_SOURCE_CHANGED" => "RUNTIME_WORKFLOW_SOURCE_CHANGED",
            "CHANNEL_ORIGINAL_CONTINUATION_CHANGED" => "CHANNEL_ORIGINAL_CONTINUATION_CHANGED",
            "CHANNEL_ORIGINAL_SOURCE_CHANGED" => "CHANNEL_ORIGINAL_SOURCE_CHANGED",
            "CHANNEL_CONTINUATION_GUARD_UNSUPPORTED" => "CHANNEL_CONTINUATION_GUARD_UNSUPPORTED",
            "CHANNEL_ORIGINAL_TURN_NOT_FINISHED" => "CHANNEL_ORIGINAL_TURN_NOT_FINISHED",
            "CHANNEL_NATIVE_STATE_CHANGED" => "CHANNEL_NATIVE_STATE_CHANGED",
            "NATIVE_INPUT_ORIGINAL_CONTEXT_REQUIRED" => "NATIVE_INPUT_ORIGINAL_CONTEXT_REQUIRED",
            "NATIVE_INPUT_EMPTY_TOOL_BOUNDARY_REQUIRED" => {
                "NATIVE_INPUT_EMPTY_TOOL_BOUNDARY_REQUIRED"
            }
            "NATIVE_INPUT_LIFETIME_CONSTRAINT_UNSUPPORTED" => {
                "NATIVE_INPUT_LIFETIME_CONSTRAINT_UNSUPPORTED"
            }
            "NATIVE_INPUT_GUARD_LIMIT" => "NATIVE_INPUT_GUARD_LIMIT",
            "NATIVE_INPUT_CONTINUATION_OWNER_REQUIRED" => {
                "NATIVE_INPUT_CONTINUATION_OWNER_REQUIRED"
            }
            "NATIVE_INPUT_ORIGINAL_GUARDS_CHANGED" => "NATIVE_INPUT_ORIGINAL_GUARDS_CHANGED",
            "NATIVE_INPUT_ORIGINAL_ACCEPTED_REQUIRED" => "NATIVE_INPUT_ORIGINAL_ACCEPTED_REQUIRED",
            "NATIVE_INPUT_ORIGINAL_TURN_NOT_FINISHED" => "NATIVE_INPUT_ORIGINAL_TURN_NOT_FINISHED",
            "TASK_CAPABILITY_SCOPE_ORIGINAL_CHANNEL_REQUIRED" => {
                "TASK_CAPABILITY_SCOPE_ORIGINAL_CHANNEL_REQUIRED"
            }
            "TASK_CAPABILITY_SCOPE_CHANNEL_INHERITANCE_UNSUPPORTED" => {
                "TASK_CAPABILITY_SCOPE_CHANNEL_INHERITANCE_UNSUPPORTED"
            }
            "CHANNEL_CONTINUATION_TOOL_BOUNDARY_UNAVAILABLE" => {
                "CHANNEL_CONTINUATION_TOOL_BOUNDARY_UNAVAILABLE"
            }
            "TASK_CAPABILITY_SCOPE_BINDING_BUSY" => "TASK_CAPABILITY_SCOPE_BINDING_BUSY",
            "CHANNEL_CONTINUATION_RESIDENT_CHANGED" => "CHANNEL_CONTINUATION_RESIDENT_CHANGED",
            "CHANNEL_CONTINUATION_PREVIOUS_INTENT_CHANGED" => {
                "CHANNEL_CONTINUATION_PREVIOUS_INTENT_CHANGED"
            }
            "CHANNEL_CONTINUATION_PREVIOUS_SOURCE_KIND_CHANGED" => {
                "CHANNEL_CONTINUATION_PREVIOUS_SOURCE_KIND_CHANGED"
            }
            "CHANNEL_CONTINUATION_GUARD_SET_CHANGED" => "CHANNEL_CONTINUATION_GUARD_SET_CHANGED",
            "TASK_CAPABILITY_SCOPE_CONTINUATION_OWNER_UNAVAILABLE" => {
                "TASK_CAPABILITY_SCOPE_CONTINUATION_OWNER_UNAVAILABLE"
            }
            "TASK_CAPABILITY_SCOPE_ORIGINAL_ACCEPTED_CHANGED" => {
                "TASK_CAPABILITY_SCOPE_ORIGINAL_ACCEPTED_CHANGED"
            }
            "TASK_CAPABILITY_SCOPE_CONTINUATION_PENDING_CHANGE" => {
                "TASK_CAPABILITY_SCOPE_CONTINUATION_PENDING_CHANGE"
            }
            _ => continue,
        };
        return code;
    }
    "UNAVAILABLE"
}

#[test]
fn configuration_diagnostics_never_copy_private_error_text() {
    assert_eq!(
        configuration_rejection_code(&anyhow::anyhow!(
            "MODEL_NATIVE_INHERITED_CONFIGURATION_CHANGED"
        )),
        "MODEL_NATIVE_INHERITED_CONFIGURATION_CHANGED"
    );
    for text in [
        "/private/profile/credentials.json",
        "MODEL_PRIVATE_CANARY_123",
        "provider token=private-canary",
    ] {
        assert_eq!(
            configuration_rejection_code(&anyhow::anyhow!("{text}")),
            "UNAVAILABLE"
        );
    }
}

/// Public replies use exact predefined codes. Never expose arbitrary IO paths,
/// provider diagnostics, credentials, or uppercase strings from unknown errors.
#[cfg(any(test, feature = "test-oracle"))]
pub fn public_error(error: &anyhow::Error) -> IntegrationError {
    for cause in error.chain() {
        let text = cause.to_string();
        let known = match text.as_str() {
            "RUNTIME_QUEUE_CAPACITY" => {
                Some(("RUNTIME_QUEUE_CAPACITY", IntegrationRecovery::RetryRead))
            }
            "RUNTIME_INTENT_CONFLICT" | "RUNTIME_CANCEL_CONFLICT" => Some((
                "RUNTIME_INTENT_CONFLICT",
                IntegrationRecovery::ExplicitUserDecision,
            )),
            "INTEGRATION_SCOPE_MISMATCH"
            | "RUNTIME_OWNER_MISMATCH"
            | "RUNTIME_ADMISSION_EXPIRED" => Some((
                "RUNTIME_AUTHORIZATION_CHANGED",
                IntegrationRecovery::RequestAuthorization,
            )),
            "RUNTIME_NATIVE_POLICY_UNAVAILABLE" => Some((
                "RUNTIME_NATIVE_POLICY_UNAVAILABLE",
                IntegrationRecovery::RequestAuthorization,
            )),
            "RUNTIME_WORKFLOW_NATIVE_REJECTED" => Some((
                "RUNTIME_AUTHORIZATION_CHANGED",
                IntegrationRecovery::RequestAuthorization,
            )),
            "RUNTIME_WORKFLOW_PIN_REQUIRED"
            | "RUNTIME_WORKFLOW_SOURCE_CHANGED"
            | "RUNTIME_WORKFLOW_INPUT_CHANGED" => Some((
                "RUNTIME_WORKFLOW_SOURCE_CHANGED",
                IntegrationRecovery::ExplicitUserDecision,
            )),
            "RUNTIME_MODEL_REVISION_MISMATCH"
            | "RUNTIME_TOOL_CEILING_UNCONFIRMED"
            | "RUNTIME_WORKFLOW_TOOL_UNAVAILABLE"
            | "RUNTIME_WORKFLOW_PROFILE_MISMATCH"
            | "RUNTIME_CONFIGURATION_REJECTED" => Some((
                "RUNTIME_CONFIGURATION_REJECTED",
                IntegrationRecovery::RepairConfiguration,
            )),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED" | "RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED" => Some((
                "RUNTIME_ACCEPTANCE_UNCONFIRMED",
                IntegrationRecovery::ReconcileOriginal,
            )),
            "RUNTIME_CANCEL_IDENTITY_MISMATCH"
            | "RUNTIME_NATIVE_IDENTITY_MISMATCH"
            | "RUNTIME_TICKET_MISMATCH" => Some((
                "RUNTIME_REFERENCE_MISMATCH",
                IntegrationRecovery::ExplicitUserDecision,
            )),
            _ => None,
        };
        if let Some((code, recovery)) = known {
            return safe_error(code, recovery);
        }
    }
    safe_error(
        "RUNTIME_RESULT_UNCONFIRMED",
        IntegrationRecovery::ReconcileOriginal,
    )
}
