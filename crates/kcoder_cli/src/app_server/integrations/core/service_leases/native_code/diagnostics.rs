//! Bounded metadata from the original private worker/manager path. Never authority.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    RpcCapture,
    RpcControl,
    Approval,
    ManagerCall,
    ManagerPeer,
    ManagerStart,
    OwnerOpen,
    OwnerStore,
    OwnerRecord,
    OwnerSettings,
    OwnerScope,
    OwnerSource,
    OwnerIssuer,
    OwnerApprovalReceipt,
    OwnerProcess,
    OwnerRunning,
    WorkerSpawn,
    WorkerReadyRead,
    WorkerEntry,
    RuntimeFactory,
    RuntimeOriginalRead,
    RuntimeClaim,
    RuntimePrepare,
    RuntimeAdmission,
    RuntimeDispatch,
    RuntimeReply,
    RuntimePrivateReply,
    RuntimeWorker,
    OwnerStopped,
}

// Only these literal source codes may cross a private diagnostic pipe or enter
// RPC error.data. OS errors reduce to fixed kinds; no body/path/parameter enters.
const CODES: &[&str] = &[
    "NATIVE_CODE_PRESENTATION_DECLARATION_REQUIRED",
    "INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED",
    "INTEGRATION_IDENTITY_REVOKED",
    "INTEGRATION_SCOPE_MISMATCH",
    "NATIVE_CODE_CAPABILITY_REQUIRED",
    "NATIVE_CODE_CONFIGURATION_CHANGED",
    "NATIVE_CODE_CONFIGURATION_UNAVAILABLE",
    "NATIVE_CODE_CONTROL_BUSY",
    "NATIVE_CODE_CURRENT_SOURCE_CHANGED",
    "NATIVE_CODE_DIAGNOSTIC_UNCLASSIFIED",
    "NATIVE_CODE_DURABLE_HISTORY_REQUIRED",
    "NATIVE_CODE_EXPECTED_REVISION_REQUIRED",
    "NATIVE_CODE_EXPLICIT_CONSENT_REQUIRED",
    "NATIVE_CODE_GENERATED_METHOD_NOT_ALLOWED",
    "NATIVE_CODE_IO_NOT_FOUND",
    "NATIVE_CODE_IO_OTHER",
    "NATIVE_CODE_IO_PERMISSION_DENIED",
    "NATIVE_CODE_MANAGEMENT_OWNER_ENDED",
    "NATIVE_CODE_MANAGER_ENTRY_INVALID",
    "NATIVE_CODE_MANAGER_PEER_DENIED",
    "NATIVE_CODE_MANAGER_REQUEST_INVALID",
    "NATIVE_CODE_METHOD_UNAVAILABLE",
    "NATIVE_CODE_MODEL_NOT_ALLOWED",
    "NATIVE_CODE_OPERATION_REQUIRED",
    "NATIVE_CODE_OPERATION_STORE_UNAVAILABLE",
    "NATIVE_CODE_ORGANIZATION_UNSUPPORTED",
    "NATIVE_CODE_ORIGINAL_APPROVAL_UNCONFIRMED",
    "NATIVE_CODE_ORIGINAL_ISSUER_REQUIRED",
    "NATIVE_CODE_ORIGINAL_ISSUE_REQUIRES_READ",
    "NATIVE_CODE_ORIGINAL_LEASE_CHANGED",
    "NATIVE_CODE_ORIGINAL_MANAGEMENT_REQUIRED",
    "NATIVE_CODE_ORIGINAL_OPERATION_INVALID",
    "NATIVE_CODE_ORIGINAL_OPERATION_MISSING",
    "NATIVE_CODE_ORIGINAL_OPERATION_REQUIRED",
    "NATIVE_CODE_ORIGINAL_OPERATION_STORE_REQUIRED",
    "NATIVE_CODE_ORIGINAL_OWNER_BUSY",
    "NATIVE_CODE_ORIGINAL_READY_UNCONFIRMED",
    "NATIVE_CODE_ORIGINAL_RECORD_MISSING",
    "NATIVE_CODE_ORIGINAL_SOURCE_CHANGED",
    "NATIVE_CODE_ORIGINAL_STORE_REQUIRED",
    "NATIVE_CODE_PERSISTENT_CONFIGURATION_REQUIRED",
    "NATIVE_CODE_PROOF_TOO_LARGE",
    "NATIVE_CODE_READY_PIPE_INVALID",
    "NATIVE_CODE_READY_PIPE_UNAVAILABLE",
    "NATIVE_CODE_READY_RECEIPT_INVALID",
    "NATIVE_CODE_READY_RECEIPT_TOO_LARGE",
    "NATIVE_CODE_RUNTIME_ACCEPTANCE_UNCONFIRMED",
    "NATIVE_CODE_RUNTIME_SUBMISSION_UNCONFIRMED",
    "NATIVE_CODE_SCOPE_CHANGED",
    "NATIVE_CODE_SCOPE_UNAVAILABLE",
    "NATIVE_CODE_SERVICE_CLAIMS_INVALID",
    "NATIVE_CODE_SERVICE_DEADLINE_INVALID",
    "NATIVE_CODE_SERVICE_ENTRY_INVALID",
    "NATIVE_CODE_SERVICE_INITIALIZATION_UNCONFIRMED",
    "NATIVE_CODE_SERVICE_INITIAL_RECORD_INVALID",
    "NATIVE_CODE_SERVICE_INTENT_CONFLICT",
    "NATIVE_CODE_SERVICE_MANAGER_UNAVAILABLE",
    "NATIVE_CODE_SERVICE_NOT_ENABLED",
    "NATIVE_CODE_SERVICE_NOT_FOUND",
    "NATIVE_CODE_SERVICE_ORIGINAL_INTENT_CONFLICT",
    "NATIVE_CODE_SERVICE_OWNER_MISMATCH",
    "NATIVE_CODE_SERVICE_PREPARATION_CHANGED",
    "NATIVE_CODE_SERVICE_PREPARATION_REQUIRED",
    "NATIVE_CODE_SERVICE_RECORD_CHANGED",
    "NATIVE_CODE_SERVICE_REQUEST_INVALID",
    "NATIVE_CODE_SERVICE_REVISION_CONFLICT",
    "NATIVE_CODE_SERVICE_REVISION_LIMIT",
    "NATIVE_CODE_SERVICE_REVOCATION_IMMUTABLE",
    "NATIVE_CODE_SERVICE_REVOKED",
    "NATIVE_CODE_SERVICE_START_UNCONFIRMED",
    "NATIVE_CODE_SERVICE_STOPPED",
    "NATIVE_CODE_SERVICE_UNAVAILABLE",
    "NATIVE_CODE_SERVICE_UNCONFIRMED",
    "NATIVE_CODE_SETTINGS_PATH_REQUIRED",
    "NATIVE_CODE_SIGNATURE_INVALID",
    "NATIVE_CODE_SOURCE_INVALID",
    "NATIVE_CODE_START_REQUIRES_ORIGINAL_READ",
    "NATIVE_CODE_TARGET_LOCATOR_INVALID",
    "RUNTIME_ACCEPTANCE_CONFLICT",
    "RUNTIME_ACCEPTANCE_UNAVAILABLE",
    "RUNTIME_ACCEPTANCE_UNCONFIRMED",
    "RUNTIME_ADMISSION_EXPIRED",
    "RUNTIME_ARTIFACT_REFERENCE_INVALID",
    "RUNTIME_AUTHORIZATION_CHANGED",
    "RUNTIME_BINDING_ACCEPTANCE_IMMUTABLE",
    "RUNTIME_BINDING_BUSY",
    "RUNTIME_BINDING_CAPACITY",
    "RUNTIME_BINDING_CONFLICT",
    "RUNTIME_BINDING_CORRUPT",
    "RUNTIME_BINDING_HEADER_MISSING",
    "RUNTIME_BINDING_IMMUTABLE",
    "RUNTIME_BINDING_INITIALIZATION_CHANGED",
    "RUNTIME_BINDING_INITIALIZATION_MISSING",
    "RUNTIME_BINDING_INTENT_CHANGED",
    "RUNTIME_BINDING_MISSING",
    "RUNTIME_BINDING_OWNER_CHANGED",
    "RUNTIME_BINDING_THREAD_IMMUTABLE",
    "RUNTIME_BINDING_TOO_LARGE",
    "RUNTIME_CANCEL_CONFLICT",
    "RUNTIME_CANCEL_IDENTITY_MISMATCH",
    "RUNTIME_CANCEL_IMMUTABLE",
    "RUNTIME_CANCEL_UNCONFIRMED",
    "RUNTIME_CANDIDATE_OWNER_MISMATCH",
    "RUNTIME_CLOCK_UNAVAILABLE",
    "RUNTIME_COMMAND_PHASE_INVALID",
    "RUNTIME_COMMAND_STILL_PENDING",
    "RUNTIME_CONFIGURATION_REJECTED",
    "RUNTIME_EVENT_IDENTITY_MISMATCH",
    "RUNTIME_INTENT_CONFLICT",
    "RUNTIME_INTERACTION_INVALID",
    "RUNTIME_INVALID_INPUT",
    "RUNTIME_LEDGER_CHANGED",
    "RUNTIME_MODEL_REVISION_MISMATCH",
    "RUNTIME_MODEL_UNCONFIRMED",
    "RUNTIME_NATIVE_IDENTITY_MISMATCH",
    "RUNTIME_NATIVE_POLICY_UNAVAILABLE",
    "RUNTIME_NATIVE_REFERENCE_CONFLICT",
    "RUNTIME_NATIVE_REFERENCE_INVALID",
    "RUNTIME_NATIVE_REFERENCE_NOT_OBSERVED",
    "RUNTIME_NATIVE_RESPONSE_LOST",
    "RUNTIME_NATIVE_RESPONSE_UNCONFIRMED",
    "RUNTIME_NATIVE_TASK_FAILED",
    "RUNTIME_NATIVE_THREAD_UNCONFIRMED",
    "RUNTIME_NATIVE_TURN_UNCONFIRMED",
    "RUNTIME_OPERATION_INVALID",
    "RUNTIME_OPERATION_MISSING",
    "RUNTIME_OUTPUT_TOO_LARGE",
    "RUNTIME_OWNER_MISMATCH",
    "RUNTIME_PHASE_CONFLICT",
    "RUNTIME_PRESENTATION_MISMATCH",
    "RUNTIME_QUEUE_CAPACITY",
    "RUNTIME_REFERENCE_MISMATCH",
    "RUNTIME_RESPONSE_KIND_MISMATCH",
    "RUNTIME_RESULT_UNCONFIRMED",
    "RUNTIME_REVISION_OVERFLOW",
    "RUNTIME_SESSION_MODE_UNSUPPORTED",
    "RUNTIME_TERMINAL_INTERACTION_REJECTED",
    "RUNTIME_TERMINAL_OUTCOME_IMMUTABLE",
    "RUNTIME_THREAD_BUSY",
    "RUNTIME_THREAD_INVALID",
    "RUNTIME_THREAD_NOT_RESIDENT",
    "RUNTIME_THREAD_RECEIPT_NOT_OBSERVED",
    "RUNTIME_THREAD_STARTUP_UNCONFIRMED",
    "RUNTIME_TICKET_MISMATCH",
    "RUNTIME_TOOL_CEILING_UNCONFIRMED",
    "RUNTIME_TOOL_RESTRICTION_INVALID",
    "RUNTIME_TURN_RECEIPT_NOT_OBSERVED",
    "RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED",
    "RUNTIME_WORKFLOW_BINDING_NOT_COMMITTED",
    "RUNTIME_WORKFLOW_FAILED",
    "RUNTIME_WORKFLOW_FIXED_INPUT_MISMATCH",
    "RUNTIME_WORKFLOW_INVALID",
    "RUNTIME_WORKFLOW_MISSING",
    "RUNTIME_WORKFLOW_NATIVE_START_FAILED",
    "RUNTIME_WORKFLOW_OBSERVATION_MISMATCH",
    "RUNTIME_WORKFLOW_OBSERVATION_UNAVAILABLE",
    "RUNTIME_WORKFLOW_OUTPUT_MISMATCH",
    "RUNTIME_WORKFLOW_OUTPUT_UNAVAILABLE",
    "RUNTIME_WORKFLOW_PHASE_MISMATCH",
    "RUNTIME_WORKFLOW_PROFILE_MISMATCH",
    "RUNTIME_WORKFLOW_PROFILE_UNAVAILABLE",
    "RUNTIME_WORKFLOW_SESSION_UNAVAILABLE",
    "RUNTIME_WORKFLOW_START_RECEIPT_INVALID",
    "RUNTIME_WORKFLOW_START_RECEIPT_MISMATCH",
    "RUNTIME_WORKFLOW_TOOL_UNAVAILABLE",
    "SERVICE_ACCOUNT_RESTRICTION_UNAVAILABLE",
    "SERVICE_CODE_ONLY_SAVED_WORKFLOW_REQUIRED",
    "SERVICE_CONFIGURATION_CHANGED",
    "SERVICE_CONFIGURATION_UNAVAILABLE",
    "SERVICE_CURRENT_SOURCE_CHANGED",
    "SERVICE_EXPLICIT_BOUNDED_CONSENT_REQUIRED",
    "SERVICE_FEATURE_DISABLED",
    "SERVICE_FIXED_CODE_DEFINITION_REQUIRED",
    "SERVICE_FIXED_TEMPLATE_CHANGED",
    "SERVICE_ISSUE_REQUIRES_ORIGINAL_READ",
    "SERVICE_LEASE_CAPACITY",
    "SERVICE_LEASE_CLOCK_UNAVAILABLE",
    "SERVICE_LEASE_DEADLINE_INVALID",
    "SERVICE_LEASE_NOT_FOUND",
    "SERVICE_LEASE_ORIGINAL_OPERATION_MISSING",
    "SERVICE_LEASE_RECORD_TOO_LARGE",
    "SERVICE_LEASE_REVOKED",
    "SERVICE_LEASE_STORE_CHANGED",
    "SERVICE_MANAGEMENT_OWNER_CHANGED",
    "SERVICE_MANAGEMENT_OWNER_ENDED",
    "SERVICE_NATIVE_IMAGE_CANCELLED",
    "SERVICE_NATIVE_IMAGE_CHANGED",
    "SERVICE_NATIVE_IMAGE_UNAVAILABLE",
    "SERVICE_NATIVE_PLATFORM_UNSUPPORTED",
    "SERVICE_NATIVE_SCOPE_UNAVAILABLE",
    "SERVICE_ORGANIZATION_IDENTITY_UNSUPPORTED",
    "SERVICE_ORIGINAL_APPROVAL_UNCONFIRMED",
    "SERVICE_ORIGINAL_CODE_DEFINITION_CHANGED",
    "SERVICE_ORIGINAL_ENGINE_CHANGED",
    "SERVICE_ORIGINAL_ISSUER_REQUIRED",
    "SERVICE_ORIGINAL_LAUNCH_CHANGED",
    "SERVICE_ORIGINAL_LAUNCH_REQUIRED",
    "SERVICE_ORIGINAL_LAUNCH_REQUIRES_READ",
    "SERVICE_ORIGINAL_LEASE_CHANGED",
    "SERVICE_ORIGINAL_LEASE_NOT_ACTIVE",
    "SERVICE_ORIGINAL_NATIVE_MANAGEMENT_REQUIRED",
    "SERVICE_ORIGINAL_NATIVE_TARGET_CHANGED",
    "SERVICE_ORIGINAL_OPERATION_REQUIRED",
    "SERVICE_ORIGINAL_OPERATION_STORE_REQUIRED",
    "SERVICE_ORIGINAL_OWNER_BUSY",
    "SERVICE_ORIGINAL_PREPARATION_CHANGED",
    "SERVICE_ORIGINAL_RECORD_MISSING",
    "SERVICE_ORIGINAL_RUNTIME_INTENT_CHANGED",
    "SERVICE_ORIGINAL_STORE_REQUIRED",
    "SERVICE_OWNER_STOPPED",
    "SERVICE_PROCESS_ACCOUNT_MISMATCH",
    "SERVICE_PROCESS_IDENTITY_UNAVAILABLE",
    "SERVICE_PROCESS_OWNER_CHANGED",
    "SERVICE_PROCESS_PARENT_CHANGED",
    "SERVICE_PROCESS_PARENT_ENDED",
    "SERVICE_RESOURCE_COPY_UNCONFIRMED",
    "SERVICE_RESOURCE_TARGET_CHANGED",
    "SERVICE_RUNTIME_ACTION_NOT_APPROVED",
    "SERVICE_RUNTIME_CANCELLED",
    "SERVICE_SETTINGS_PATH_REQUIRED",
];
#[derive(Clone, Copy, Debug)]
struct Reason(&'static str);
impl Serialize for Reason {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}
impl<'de> Deserialize<'de> for Reason {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        CODES
            .iter()
            .copied()
            .find(|code| *code == value)
            .map(Self)
            .ok_or_else(|| serde::de::Error::custom("NATIVE_CODE_DIAGNOSTIC_INVALID"))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    stages: Vec<Stage>,
    reason: Reason,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NATIVE_CODE_SERVICE_UNCONFIRMED")
    }
}
impl std::error::Error for Failure {}
impl Failure {
    pub fn from_private(value: serde_json::Value) -> Result<Self> {
        let failure: Self = serde_json::from_value(value)?;
        ensure!(
            !failure.stages.is_empty() && failure.stages.len() <= 12,
            "NATIVE_CODE_DIAGNOSTIC_INVALID"
        );
        Ok(failure)
    }
}
pub fn describe(error: &anyhow::Error) -> Failure {
    if let Some(failure) = error.downcast_ref::<Failure>() {
        return failure.clone();
    }
    let mut reason = Reason("NATIVE_CODE_DIAGNOSTIC_UNCLASSIFIED");
    for cause in error.chain() {
        let text = cause.to_string();
        if let Some(code) = CODES.iter().copied().find(|code| *code == text) {
            reason = Reason(code);
            break;
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            reason = Reason(match io.kind() {
                std::io::ErrorKind::PermissionDenied => "NATIVE_CODE_IO_PERMISSION_DENIED",
                std::io::ErrorKind::NotFound => "NATIVE_CODE_IO_NOT_FOUND",
                _ => "NATIVE_CODE_IO_OTHER",
            });
        }
    }
    Failure {
        stages: vec![],
        reason,
    }
}
pub fn mark<T>(stage: Stage, result: Result<T>) -> Result<T> {
    result.map_err(|error| {
        let mut failure = describe(&error);
        if failure.stages.len() < 12 {
            failure.stages.push(stage);
        }
        anyhow::Error::new(failure)
    })
}
pub fn at<T>(stage: Stage, work: impl FnOnce() -> Result<T>) -> Result<T> {
    mark(stage, work())
}

pub fn rejected_reply(stage: Stage, code: Option<&str>) -> anyhow::Error {
    let reason = CODES
        .iter()
        .copied()
        .find(|known| Some(*known) == code)
        .unwrap_or("NATIVE_CODE_DIAGNOSTIC_UNCLASSIFIED");
    anyhow::Error::new(Failure {
        stages: vec![stage],
        reason: Reason(reason),
    })
}

pub fn private_rpc_error(message: Option<&str>) -> anyhow::Error {
    let code = match message {
        Some("studioWorkModesV1 negotiation is required") => {
            Some("NATIVE_CODE_PRESENTATION_DECLARATION_REQUIRED")
        }
        value => value,
    };
    rejected_reply(Stage::RuntimePrivateReply, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_only_preserves_closed_codes_and_never_raw_text() {
        let error = mark::<()>(
            Stage::OwnerSource,
            Err(anyhow::anyhow!(
                "path-secret-fixture /private/password=fixture"
            )),
        )
        .unwrap_err();
        let wire = serde_json::to_string(&describe(&error)).unwrap();
        assert!(!wire.contains("path-secret") && !wire.contains("password"));
        assert!(wire.contains("NATIVE_CODE_DIAGNOSTIC_UNCLASSIFIED"));
        let known = mark::<()>(
            Stage::OwnerProcess,
            Err(anyhow::anyhow!("SERVICE_ORIGINAL_OWNER_BUSY")),
        )
        .unwrap_err();
        let wire = serde_json::to_value(describe(&known)).unwrap();
        assert_eq!(wire["reason"], "SERVICE_ORIGINAL_OWNER_BUSY");
        assert!(Failure::from_private(wire).is_ok());
        assert!(
            Failure::from_private(
                serde_json::json!({"stages":["owner_process"],"reason":"unapproved raw text"})
            )
            .is_err()
        );
        assert!(
            Failure::from_private(
                serde_json::json!({"stages":[],"reason":"SERVICE_ORIGINAL_OWNER_BUSY"})
            )
            .is_err()
        );
        let reply = rejected_reply(Stage::RuntimeReply, Some("unapproved private reply body"));
        let reply = at::<()>(Stage::RuntimeWorker, || Err(reply)).unwrap_err();
        let wire = serde_json::to_string(&describe(&reply)).unwrap();
        assert!(!wire.contains("unapproved private reply body"));
        assert!(wire.contains("runtime_reply") && wire.contains("runtime_worker"));
        let mode = serde_json::to_value(describe(&private_rpc_error(Some(
            "studioWorkModesV1 negotiation is required",
        ))))
        .unwrap();
        assert_eq!(
            mode["reason"],
            "NATIVE_CODE_PRESENTATION_DECLARATION_REQUIRED"
        );
        let unknown = serde_json::to_string(&describe(&private_rpc_error(Some(
            "private path/secret fixture",
        ))))
        .unwrap();
        assert!(!unknown.contains("private path") && !unknown.contains("secret fixture"));
    }
}
