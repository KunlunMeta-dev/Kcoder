//! Read-only desktop capability diagnostics; not an authorization to take control.
pub const CAPABILITY_COMPUTER_USE_TURN_V1: &str = "computerUseTurnV1";
use serde::{Deserialize, Serialize};
pub const CAPABILITY_COMPUTER_USE_STATUS_V1: &str = "computerUseStatusV1";
pub const CAPABILITY_COMPUTER_USE_RECOVERY_V1: &str = "computerUseRecoveryV1";
pub const CAPABILITY_COMPUTER_USE_SESSION_AUTHORIZATION_V1: &str =
    "computerUseSessionAuthorizationV1";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseRecoverParams {
    pub thread_id: String,
    pub previous_turn_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseRevokeParams {
    pub thread_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseRecoverResult {
    pub thread_id: String,
    pub previous_turn_id: String,
    pub turn_id: String,
    pub status: ComputerUseRecoveryStatus,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseRecoveryStatus {
    Running,
    Completed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseAuthorizationState {
    Valid,
    Revoked,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseChannelState {
    Available,
    Unavailable,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseCleanupState {
    Pending,
    Confirmed,
    Failed,
    Unknown,
}
/// Sanitized operation metadata. Never contains screenshots or window text.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseDiagnostic {
    pub authorization: ComputerUseAuthorizationState,
    pub channel: ComputerUseChannelState,
    pub cleanup: ComputerUseCleanupState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_pid: Option<u32>,
}
/// Host lifecycle notification, scoped by the standard server/thread/turn
/// envelope. Contains no bootstrap secret, lease credential or desktop content.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseStateChanged {
    pub state: kcoder_types::computer_use::DesktopSessionState,
    pub target: ComputerUseTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<ComputerUseDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_available: Option<bool>,
}
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComputerUseStatusParams {}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseAvailability {
    Ready,
    UnsupportedPlatform,
    PluginDisabled,
    ComponentMissing,
    ComponentInvalid,
    DesktopUnavailable,
    IntegrationUnavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatusResult {
    pub availability: ComputerUseAvailability,
    pub can_control: bool,
    pub platform: String,
    pub windows_session_id: Option<u32>,
    pub reason: String,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_continuation_is_explicit_and_legacy_approval_stays_per_turn() {
        let value = serde_json::json!({"approved":true,"target":"local_windows_desktop"});
        let legacy: ComputerUseTurnAuthorization = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.use_session_authorization, None);
        assert_eq!(serde_json::to_value(legacy).unwrap(), value);
        let session: ComputerUseTurnAuthorization = serde_json::from_value(serde_json::json!({"approved":true,"target":"local_windows_desktop","useSessionAuthorization":true})).unwrap();
        assert_eq!(session.use_session_authorization, Some(true));
        let fresh: ComputerUseTurnAuthorization = serde_json::from_value(serde_json::json!({"approved":true,"target":"local_windows_desktop","useSessionAuthorization":false})).unwrap();
        assert_eq!(fresh.use_session_authorization, Some(false));
        assert_eq!(
            serde_json::to_value(fresh).unwrap()["useSessionAuthorization"],
            false
        );
    }
    #[test]
    fn recovery_cannot_supply_new_approval_input_or_worker() {
        let input = serde_json::json!({"threadId":"t", "previousTurnId":"old"});
        assert!(serde_json::from_value::<ComputerUseRecoverParams>(input.clone()).is_ok());
        for field in ["approved", "input", "lease", "runtimePath", "command"] {
            let mut invalid = input.clone();
            invalid[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<ComputerUseRecoverParams>(invalid).is_err());
        }
    }
    #[test]
    fn status_query_cannot_carry_authorization_or_execution_parameters() {
        assert!(serde_json::from_value::<ComputerUseStatusParams>(serde_json::json!({})).is_ok());
        for key in ["enabled", "owner", "command", "runtimePath", "confirm"] {
            assert!(
                serde_json::from_value::<ComputerUseStatusParams>(serde_json::json!({key:true}))
                    .is_err()
            );
        }
    }
}

/// Desktop permission supplied by the interactive client. Legacy omission of
/// useSessionAuthorization means an explicit per-turn grant. Negotiated session
/// continuation only reuses an existing owner/thread grant and cannot renew it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseTurnAuthorization {
    pub approved: bool,
    pub target: ComputerUseTarget,
    /// Reuse the original owner/thread grant; never creates a new grant.
    /// Omission retains legacy explicit per-turn approval semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_session_authorization: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseTarget {
    LocalWindowsDesktop,
}

#[cfg(test)]
mod turn_authorization_tests {
    #[test]
    fn desktop_control_is_explicit_and_cannot_choose_arbitrary_target() {
        let plain = serde_json::json!({"threadId":"thread","input":[]});
        let params: crate::TurnStartParams = serde_json::from_value(plain.clone()).unwrap();
        assert!(params.computer_use.is_none());
        let mut enabled = plain;
        enabled["computerUse"] =
            serde_json::json!({"approved":true,"target":"local_windows_desktop"});
        let params: crate::TurnStartParams = serde_json::from_value(enabled.clone()).unwrap();
        assert!(params.computer_use.unwrap().approved);
        enabled["computerUse"]["target"] = serde_json::json!("remote-server");
        assert!(serde_json::from_value::<crate::TurnStartParams>(enabled).is_err());
    }
}
