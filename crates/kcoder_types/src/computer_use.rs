//! Computer Use ownership contracts. Populate owners from authenticated runtime
//! context, never from a model's tool arguments.
use serde::{Deserialize, Serialize};

pub const DESKTOP_PROTOCOL_VERSION: u32 = 1;
pub const CAPABILITY_COMPUTER_USE_DESKTOP_V1: &str = "computerUseDesktopV1";
/// Inline image budget for the owned desktop worker, measured after base64 encoding.
pub const DESKTOP_SCREENSHOT_BASE64_BYTES: usize = 1536 * 1024;

pub fn is_desktop_screenshot_tool(name: &str) -> bool {
    matches!(
        name,
        "mcp__kcoder_computer_use__Screenshot" | "mcp__kcoder_computer_use__Snapshot"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopOwner {
    pub client_instance: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLease {
    pub id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopControlState {
    Unavailable,
    Ready,
    Active,
    Stopping,
    Failed,
}

/// Observable client lifecycle. Stopped requires a confirmed worker cleanup;
/// StopFailed must never be rendered as successful release of control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSessionState {
    Active,
    Stopping,
    Stopped,
    StopFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopControlError {
    DesktopUnavailable,
    DesktopBusy,
    LeaseRevoked,
    OperationBusy,
    StaleResponse,
}

/// Host-to-broker envelope. Owners are supplied by the authenticated proxy,
/// not accepted as part of a model tool input. The transport must authenticate
/// the peer before deserializing/dispatching this request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopRequest {
    pub protocol_version: u32,
    pub request_id: u64,
    pub operation: DesktopOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopOperation {
    Status,
    Acquire {
        owner: DesktopOwner,
    },
    Call {
        owner: DesktopOwner,
        lease: DesktopLease,
        tool: String,
        arguments: serde_json::Value,
    },
    Stop {
        owner: DesktopOwner,
        lease: DesktopLease,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopStatus {
    pub protocol_version: u32,
    pub state: DesktopControlState,
    pub windows_session_id: u32,
    pub owner: Option<DesktopOwner>,
}
