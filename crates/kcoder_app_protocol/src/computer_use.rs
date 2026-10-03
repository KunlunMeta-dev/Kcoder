//! Read-only desktop capability diagnostics; not an authorization to take control.
pub const CAPABILITY_COMPUTER_USE_TURN_V1: &str = "computerUseTurnV1";
use serde::{Deserialize, Serialize};
pub const CAPABILITY_COMPUTER_USE_STATUS_V1: &str = "computerUseStatusV1";
/// Host lifecycle notification, scoped by the standard server/thread/turn
/// envelope. Contains no bootstrap secret, lease credential or desktop content.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseStateChanged {
    pub state: kcoder_types::computer_use::DesktopSessionState,
    pub target: ComputerUseTarget,
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

/// Explicit per-turn desktop permission supplied by the interactive client.
/// Omitted by default and never inherited by automatic followups/retries.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerUseTurnAuthorization {
    pub approved: bool,
    pub target: ComputerUseTarget,
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
