//! Wire types for the KCoder app-server protocol.
//!
//! The protocol is JSON-RPC 2.0 transported as one compact JSON value per
//! line. This crate contains no I/O or runtime state so desktop, web gateway,
//! and server implementations can share the exact same contract.

mod model_catalog;
pub use model_catalog::RuntimeModelCatalogEntry;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod hooks;
pub use hooks::*;
mod skills;
pub use skills::*;
mod mcp;
pub use mcp::*;
mod settings_templates;
pub use settings_templates::*;
mod storage_diagnostics;
pub use storage_diagnostics::*;
mod thread_creations;
pub use thread_creations::*;
mod turn_receipts;
pub use turn_receipts::*;
mod turn_file_changes;
pub use turn_file_changes::*;
mod agent;
mod cron;
mod history_refresh;
mod plugin;
mod providers;
mod resources;
mod tools_catalog;
mod usage;
pub use agent::*;
pub use cron::*;
pub use history_refresh::*;
pub use plugin::*;
pub use providers::*;
pub use resources::*;
pub use tools_catalog::*;
pub use usage::*;

pub const JSONRPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: &str = "2026-07-27";
pub const THREAD_METADATA_SCHEMA: &str = "kcoder.thread-metadata";

mod recent_error;
pub use recent_error::{
    ThreadRecentError, ThreadRecentErrorCategory, ThreadRecentErrorKind, ThreadRecentErrorSource,
};
pub mod method {
    pub const HOOK_CONFIGURATION_READ: &str = "hooks/config/read";
    pub const HOOK_CONFIGURATION_UPDATE: &str = "hooks/config/update";
    pub const SKILL_IMPORT: &str = "skills/import";
    pub const SKILL_REMOVE: &str = "skills/remove";
    pub const MCP_LIST: &str = "mcp/list";
    pub const MCP_INSTALL: &str = "mcp/install";
    pub const MCP_REMOVE: &str = "mcp/remove";
    pub const MCP_LOGOUT: &str = "mcp/logout";
    pub const MCP_LOGIN: &str = "mcp/login";
    pub const MCP_CALLBACK: &str = "mcp/callback";
    pub const MCP_CANCEL: &str = "mcp/cancel";
    pub const TOOLS_CATALOG: &str = "tools/catalog";
    pub const AUTOMATION_STATE_CHANGED: &str = "automation/stateChanged";
    pub const USAGE_STATS: &str = "usage/stats";
    pub const CRON_PREVIEW: &str = "cron/preview";
    pub const PROVIDERS_LIST: &str = "runtime.providers.list";
    pub const PROVIDERS_TEMPLATES: &str = "runtime.providers.templates";
    pub const PROVIDERS_UPSERT: &str = "runtime.providers.upsert";
    pub const PROVIDERS_DELETE: &str = "runtime.providers.delete";
    pub const PROVIDERS_VALIDATE: &str = "runtime.providers.validate";
    pub const INITIALIZE: &str = "initialize";
    pub const SERVER_RESOURCES_READ: &str = "server/resources/read";
    pub const SERVER_IDLE_SHUTDOWN: &str = "server/shutdown/idle";
    pub const THREAD_START: &str = "thread/start";
    pub const THREAD_LIST: &str = "thread/list";
    pub const THREAD_HISTORY_REFRESH: &str = "thread/history/refresh";
    pub const THREAD_READ: &str = "thread/read";
    pub const THREAD_READ_INDEXED: &str = "thread/read/indexed";
    pub const THREAD_RESUME: &str = "thread/resume";
    pub const THREAD_FORK: &str = "thread/fork";
    pub const THREAD_COMPACT: &str = "thread/compact";
    pub const THREAD_ROLLBACK: &str = "thread/rollback";
    pub const THREAD_GOAL_GET: &str = "thread/goal/get";
    pub const THREAD_GOAL_HISTORY: &str = "thread/goal/history";
    pub const THREAD_GOAL_SET: &str = "thread/goal/set";
    pub const THREAD_GOAL_CLEAR: &str = "thread/goal/clear";
    /// Notification payload: ThreadGoalGetResult. The goal is server-authoritative.
    pub const THREAD_GOAL_UPDATED: &str = "thread/goal/updated";
    pub const THREAD_GOAL_CONTINUATION: &str = "thread/goal/continuation";
    pub const THREAD_AUTOMATION_SUSPEND: &str = "thread/automation/suspend";
    pub const SESSION_MODES: &str = "session/modes";
    pub const THREAD_SESSION_MODE_SET: &str = "thread/sessionMode/set";
    pub const THREAD_METADATA_UPDATE: &str = "thread/metadata/update";
    pub const THREAD_DELETE: &str = "thread/delete";
    pub const THREAD_DISPOSE: &str = "thread/dispose";
    pub const TURN_START: &str = "turn/start";
    pub const THREAD_CREATION_READ: &str = "thread/creation/read";
    pub const TURN_RECEIPT_READ: &str = "turn/receipt/read";
    pub const TURN_INTERRUPT: &str = "turn/interrupt";
    pub const TURN_SHORTEN_WAIT: &str = "turn/shorten_wait";
    pub const AGENT_LIST: &str = "agent/list";
    pub const AGENT_STEER: &str = "agent/steer";
    pub const AGENT_STEER_APPLIED: &str = "agent/steer/applied";
    /// Reads one whitelisted sub-agent artifact (output.md / transcript.json) of
    /// the calling thread. See AgentArtifactReadParams.
    pub const AGENT_ARTIFACT_READ: &str = "agent/artifact/read";
    pub const DEVICE_EXECUTE: &str = "device/execute";
    pub const ATTACHMENT_SAVE: &str = "attachment/save";
    pub const ATTACHMENT_UPLOAD_START: &str = "attachment/upload/start";
    pub const ATTACHMENT_UPLOAD_CHUNK: &str = "attachment/upload/chunk";
    pub const ATTACHMENT_UPLOAD_FINISH: &str = "attachment/upload/finish";
    pub const ATTACHMENT_UPLOAD_CANCEL: &str = "attachment/upload/cancel";
    pub const ATTACHMENT_DELETE: &str = "attachment/delete";
    pub const ATTACHMENT_READ: &str = "attachment/read";
    pub const ATTACHMENT_READ_CHUNK: &str = "attachment/read/chunk";
    pub const TERMINAL_START: &str = "terminal/start";
    pub const TERMINAL_LIST: &str = "terminal/list";
    pub const TERMINAL_ATTACH: &str = "terminal/attach";
    pub const TERMINAL_WRITE: &str = "terminal/write";
    pub const TERMINAL_RESIZE: &str = "terminal/resize";
    pub const TERMINAL_CLOSE: &str = "terminal/close";
    pub const BROWSER_START: &str = "browser/start";
    pub const BROWSER_PREFLIGHT: &str = "browser/preflight";
    pub const BROWSER_SCREENSHOT: &str = "browser/screenshot";
    pub const BROWSER_ACTION: &str = "browser/action";
    pub const BROWSER_EVALUATE: &str = "browser/evaluate";
    pub const BROWSER_CLOSE: &str = "browser/close";
    pub const PLUGIN_LIST: &str = "plugin/list";
    pub const PLUGIN_READ: &str = "plugin/read";
    pub const PLUGIN_ICON: &str = "plugin/icon";
    pub const PLUGIN_TRUST_LIST: &str = "plugin/trust/list";
    pub const PLUGIN_TRUST_SET: &str = "plugin/trust/set";
    pub const PLUGIN_INSTALL: &str = "plugin/install";
    pub const PLUGIN_CANCEL_INSTALL: &str = "plugin/install/cancel";
    pub const PLUGIN_UNINSTALL: &str = "plugin/uninstall";
    pub const PLUGIN_ENABLE: &str = "plugin/enable";
    pub const PLUGIN_DISABLE: &str = "plugin/disable";
    pub const MARKETPLACE_LIST: &str = "marketplace/list";
    pub const MARKETPLACE_ADD: &str = "marketplace/add";
    pub const MARKETPLACE_REMOVE: &str = "marketplace/remove";
    pub const MARKETPLACE_REFRESH: &str = "marketplace/refresh";
    /// Session-level settings templates: list/read/save/delete/default.
    pub const SETTINGS_TEMPLATES_LIST: &str = "settings/templates/list";
    pub const SETTINGS_TEMPLATES_READ: &str = "settings/templates/read";
    pub const SETTINGS_TEMPLATES_SAVE: &str = "settings/templates/save";
    pub const SETTINGS_TEMPLATES_DELETE: &str = "settings/templates/delete";
    pub const SETTINGS_TEMPLATES_DEFAULT: &str = "settings/templates/default";
    /// Storage and diagnostics surfaces used by KCoder Studio.
    pub const DIAGNOSTICS_STORAGE_READ: &str = "diagnostics/storage/read";
    pub const DIAGNOSTICS_STORAGE_CANCEL: &str = "diagnostics/storage/cancel";
    pub const DIAGNOSTICS_STORAGE_CLEAN: &str = "diagnostics/storage/clean";
    pub const DIAGNOSTICS_DEBUG_LOG_DISABLE: &str = "diagnostics/debug-log/disable";
    /// Turn-file-change snapshot policy edited from KCoder Studio.
    pub const SETTINGS_TURN_FILE_CHANGES_READ: &str = "settings/turn-file-changes/read";
    pub const SETTINGS_TURN_FILE_CHANGES_SAVE: &str = "settings/turn-file-changes/save";

    pub const THREAD_STARTED: &str = "thread/started";
    pub const TURN_STARTED: &str = "turn/started";
    pub const TURN_COMPLETED: &str = "turn/completed";
    pub const ITEM_STARTED: &str = "item/started";
    pub const ITEM_DELTA: &str = "item/delta";
    pub const ITEM_COMPLETED: &str = "item/completed";
    pub const TERMINAL_OUTPUT: &str = "terminal/output";
    pub const TERMINAL_EXIT: &str = "terminal/exit";

    pub const APPROVAL_REQUEST: &str = "approval/request";
    pub const APPROVAL_RESOLVED: &str = "approval/resolved";
    pub const QUESTION_REQUEST: &str = "question/request";
    pub const QUESTION_RESOLVED: &str = "question/resolved";
}

/// JSON-RPC request ids may be numbers or strings. `null` is intentionally
/// excluded: a message without an id is a notification.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl From<u64> for RequestId {
    fn from(value: u64) -> Self {
        Self::Number(value)
    }
}

impl From<String> for RequestId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for RequestId {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

fn jsonrpc_version() -> String {
    JSONRPC_VERSION.to_owned()
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A client-to-server or server-to-client request envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request<P = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: P,
}

impl<P> Request<P> {
    pub fn new(id: impl Into<RequestId>, method: impl Into<String>, params: P) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// A notification envelope. Notifications never carry an id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification<P = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub method: String,
    pub params: P,
}

impl<P> Notification<P> {
    pub fn new(method: impl Into<String>, params: P) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            method: method.into(),
            params,
        }
    }
}

/// A JSON-RPC response envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response<R = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(flatten)]
    pub payload: ResponsePayload<R>,
}

impl<R> Response<R> {
    pub fn success(id: impl Into<RequestId>, result: R) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            payload: ResponsePayload::Success { result },
        }
    }

    pub fn error(id: impl Into<RequestId>, error: RpcError) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            payload: ResponsePayload::Error { error },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsePayload<R = Value> {
    Success { result: R },
    Error { error: RpcError },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Shape-based representation useful at transport boundaries before method
/// dispatch converts params/results into their method-specific types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request(Request<Value>),
    Response(Response<Value>),
    Notification(Notification<Value>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub experimental: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub approvals: bool,
    pub questions: bool,
    pub thread_resume: bool,
    #[serde(default)]
    pub experimental: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client_info: ImplementationInfo,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_info: ImplementationInfo,
    pub capabilities: ServerCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Experimental workspace command forwarded by the Studio gateway.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceExecuteParams {
    pub command_key: String,
    #[serde(
        default,
        rename = "threadId",
        alias = "thread_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceExecuteResult {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: Value,
    pub stderr: String,
}

/// Experimental browser attachment staging request. Base64 keeps the request safely bounded;
/// JSON arrays of individual bytes have more than four times the wire overhead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSaveParams {
    pub filename: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSaveResult {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadStartParams {
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadStartResult {
    pub upload_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadChunkParams {
    pub upload_id: String,
    pub index: u32,
    pub content_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadFinishParams {
    pub upload_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadCancelParams {
    pub upload_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentDeleteParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadParams {
    pub thread_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadResult {
    pub content_base64: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadChunkParams {
    pub thread_id: String,
    pub path: String,
    pub offset: u64,
    pub length: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadChunkResult {
    pub content_base64: String,
    pub offset: u64,
    pub size: u64,
    pub total_size: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserPreflightResult {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserStartParams {
    pub url: String,
    #[serde(default = "default_browser_width")]
    pub width: u32,
    #[serde(default = "default_browser_height")]
    pub height: u32,
}

fn default_browser_width() -> u32 {
    1024
}

fn default_browser_height() -> u32 {
    720
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserStartResult {
    pub session_id: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sandbox_disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSessionParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserActionParams {
    pub session_id: String,
    #[serde(flatten)]
    pub action: BrowserAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BrowserAction {
    Navigate {
        url: String,
    },
    Reload,
    Back,
    Forward,
    Resize {
        width: u32,
        height: u32,
    },
    Click {
        x: f64,
        y: f64,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerDown {
        x: f64,
        y: f64,
    },
    PointerUp {
        x: f64,
        y: f64,
    },
    Text {
        text: String,
    },
    Key {
        key: String,
    },
    Shortcut {
        key: String,
        modifiers: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserActionResult {
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<BrowserPageState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserEvaluateParams {
    pub session_id: String,
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserEvaluateResult {
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageState {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_go_back: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_go_forward: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserScreenshotResult {
    pub session_id: String,
    pub data_base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub page: BrowserPageState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default = "default_terminal_rows")]
    pub rows: u16,
    #[serde(default = "default_terminal_cols")]
    pub cols: u16,
}

fn default_terminal_rows() -> u16 {
    24
}

fn default_terminal_cols() -> u16 {
    80
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalStartResult {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TerminalListParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub through_sequence: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalListResult {
    pub sessions: Vec<TerminalSessionInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAttachParams {
    pub session_id: String,
    #[serde(default = "default_terminal_rows")]
    pub rows: u16,
    #[serde(default = "default_terminal_cols")]
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAttachResult {
    pub session_id: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub transcript: String,
    pub through_sequence: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalWriteParams {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResizeParams {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOutputParams {
    pub session_id: String,
    pub data: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalExitParams {
    pub session_id: String,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    /// Stable creation operation identity; requires threadCreationReceiptsV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<ThreadSessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Session-level settings template id; absent keeps the profile baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_template: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResult {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResult {
    pub threads: Vec<Thread>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completeness: Option<ThreadListCompleteness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadListCompleteness {
    Complete,
    Partial,
}

/// Three-state field patch: absent retains the value, a string sets it, and JSON null clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum MetadataUpdate<T> {
    #[default]
    Unchanged,
    Set(T),
    Clear,
}

impl<T> MetadataUpdate<T> {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

impl<T: Serialize> Serialize for MetadataUpdate<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Set(value) => value.serialize(serializer),
            Self::Clear | Self::Unchanged => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for MetadataUpdate<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Clear,
        })
    }
}

/// Persistable parent-chain location between a Studio task and an app-server thread.
///
/// Early Studio versions sent this object as a JSON-encoded string. Deserialization
/// still accepts that form, while the server and all new clients always emit a structured object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParent {
    pub task_id: String,
    pub thread_id: String,
    pub last_turn_id: String,
}

impl<'de> Deserialize<'de> for ThreadParent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct WireThreadParent {
            task_id: String,
            thread_id: String,
            last_turn_id: String,
        }

        let value = Value::deserialize(deserializer)?;
        let value = match value {
            Value::String(encoded) => serde_json::from_str(&encoded).map_err(|error| {
                serde::de::Error::custom(format!("invalid parent JSON: {error}"))
            })?,
            value => value,
        };
        let wire: WireThreadParent = serde_json::from_value(value)
            .map_err(|error| serde::de::Error::custom(format!("invalid thread parent: {error}")))?;
        Ok(Self {
            task_id: wire.task_id,
            thread_id: wire.thread_id,
            last_turn_id: wire.last_turn_id,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdateParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub title: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub model: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub archived_at: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub parent: MetadataUpdate<ThreadParent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdateResult {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_by_attempt_id: Option<String>,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<Value>,
    pub timestamp_ms: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub content_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_original_chars: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadResult {
    pub thread: Thread,
    pub messages: Vec<ThreadMessage>,
    pub range_start: usize,
    pub range_end: usize,
    pub has_more_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResult {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkParams {
    pub thread_id: String,
    #[serde(default)]
    pub last_turn_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub exclude_turns: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkResult {
    pub thread: Thread,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactResult {
    pub thread_id: String,
    pub compacted: bool,
    pub pre_tokens: usize,
    pub post_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackResult {
    pub thread_id: String,
    pub turn: u64,
    pub removed_messages: usize,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub failed_files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub edit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_no_goal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub clear_token_budget: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoal {
    pub thread_id: String,
    #[serde(default)]
    pub goal_id: String,
    pub objective: String,
    pub mode: String,
    #[serde(default = "default_goal_verification_kind")]
    pub verification_kind: String,
    pub status: String,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    #[serde(default)]
    pub turn_count: u64,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<ThreadGoalEvent>,
}

fn default_goal_verification_kind() -> String {
    "artifact".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalEvent {
    pub kind: String,
    pub timestamp: u64,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalGetResult {
    pub thread_id: String,
    pub goal: Option<ThreadGoal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalContinuationParams {
    pub thread_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalHistoryResult {
    pub thread_id: String,
    pub goals: Vec<ThreadGoal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetResult {
    pub thread_id: String,
    pub goal: ThreadGoal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalClearResult {
    pub thread_id: String,
    pub cleared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeleteParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeleteResult {
    pub thread_id: String,
    pub deleted: bool,
    pub deleted_files: usize,
}

/// Server-authoritative snapshot of client thread metadata.
///
/// Optional domain fields deliberately retain None, allowing clients to distinguish
/// a value cleared by the server from an older server without authoritative metadata support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub schema: String,
    pub version: u32,
    pub revision: u64,
    pub title: Option<String>,
    pub model: Option<String>,
    pub archived_at: Option<String>,
    pub parent: Option<ThreadParent>,
}

impl Default for ThreadMetadata {
    fn default() -> Self {
        Self {
            schema: THREAD_METADATA_SCHEMA.into(),
            version: 1,
            revision: 0,
            title: None,
            model: None,
            archived_at: None,
            parent: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Running,
    WaitingForApproval,
    WaitingForAnswer,
    Failed,
    /// The main turn is finished but a background run is still working.
    Background,
    /// Only delivery/aggregation of finished background work is outstanding.
    Aggregating,
    /// Authoritative run facts could not be read; never report this as idle.
    Unknown,
}

/// Client capability that opts a connection into the richer run projection.
pub const CAPABILITY_RETRY_MODEL_CONFIGURATION_V1: &str = "retryModelConfigurationV1";
pub const CAPABILITY_THREAD_RUN_SUMMARY_V1: &str = "threadRunSummaryV1";

/// Client capability that makes an interaction reply name the interaction it
/// answers. Without it the transport id is the only correlation, and an id
/// issued by an earlier connection generation can collide with a new one.
pub const CAPABILITY_INTERACTION_BINDING_V1: &str = "interactionBindingV1";

/// Client capability that lets a client declare a deliberate re-submission of an
/// already committed message identity. Without it, submitting a committed
/// `clientMessageId` again is refused, so a retry after an unknown outcome can
/// never duplicate the turn.
pub const CAPABILITY_TURN_SUBMISSION_V1: &str = "turnSubmissionV1";

/// Client capability that lets a client name the recovery it is asking for, so a
/// repeated or cross-client retry of the same failed turn is recognised as the
/// same operation instead of being mistaken for a new one.
pub const CAPABILITY_TURN_RETRY_OPERATION_V1: &str = "turnRetryOperationV1";

/// Recovery names an exact failed attempt and preserves earlier terminal receipts.
pub const CAPABILITY_TURN_ATTEMPT_RETRY_V1: &str = "turnAttemptRetryV1";

/// Server capability that a failed turn can be continued at all, with the input
/// context verified against the boundary that was committed. A client that does
/// not see this must say so and offer an upgrade instead of quietly re-sending
/// the turn as new work.
pub const CAPABILITY_FAILED_TURN_CONTINUATION_V1: &str = "failedTurnContinuationV1";

/// Main-turn component of [`ThreadRunFacts`]; `Unknown` means "unreadable", not "idle".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMainTurn {
    Idle,
    Running,
    Unknown,
}

/// Authoritative per-thread run facts.
///
/// Every field is `None` when the owning runtime could not read it without
/// blocking (for example while the projection lock is held). Consumers must
/// treat `None` as "unknown" and must not substitute a heuristic default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadRunFacts {
    pub main_turn_running: Option<bool>,
    pub pending_approvals: Option<u32>,
    pub pending_questions: Option<u32>,
    /// Live background jobs registered by the owning engine.
    pub active_jobs: Option<u32>,
    /// Persisted task records that have not started yet.
    pub tasks_pending: Option<u32>,
    /// Persisted task records currently running.
    pub tasks_running: Option<u32>,
    /// Finished background runs whose result is still pending delivery/aggregation.
    pub pending_followups: Option<u32>,
    /// Scheduled goal continuations that are due.
    pub pending_goals: Option<u32>,
}

/// Wire projection of [`ThreadRunFacts`] for capabilities-negotiated consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRunSummary {
    pub main_turn: ThreadMainTurn,
    /// Absent = unknown (old or unreadable evidence); null = confirmed no failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "recent_error::deserialize_present"
    )]
    pub recent_error: Option<Option<ThreadRecentError>>,
    /// Explicit `null` means unknown; `0` means known-idle.
    pub pending_approvals: Option<u32>,
    pub pending_questions: Option<u32>,
    pub active_jobs: Option<u32>,
    pub tasks_pending: Option<u32>,
    pub tasks_running: Option<u32>,
    pub pending_followups: Option<u32>,
    pub pending_goals: Option<u32>,
}

impl ThreadRunFacts {
    /// The single authoritative run-state rule shared by every consumer.
    ///
    /// Order follows the status projection table: a pending user interaction is
    /// more actionable than a running turn, background work outlives the main
    /// turn, and delivery is the last thing outstanding.
    pub fn state(&self) -> ThreadStatus {
        let any_unknown = self.main_turn_running.is_none()
            || self.pending_approvals.is_none()
            || self.pending_questions.is_none()
            || self.active_jobs.is_none()
            || self.tasks_pending.is_none()
            || self.tasks_running.is_none()
            || self.pending_followups.is_none()
            || self.pending_goals.is_none();

        if self.pending_approvals.is_some_and(|count| count > 0) {
            return ThreadStatus::WaitingForApproval;
        }
        if self.pending_questions.is_some_and(|count| count > 0) {
            return ThreadStatus::WaitingForAnswer;
        }
        if self.main_turn_running == Some(true) {
            return ThreadStatus::Running;
        }
        if self.active_jobs.is_some_and(|count| count > 0)
            || self.tasks_running.is_some_and(|count| count > 0)
            || self.tasks_pending.is_some_and(|count| count > 0)
            || self.pending_goals.is_some_and(|count| count > 0)
        {
            return ThreadStatus::Background;
        }
        if self.pending_followups.is_some_and(|count| count > 0) {
            return ThreadStatus::Aggregating;
        }
        if any_unknown {
            return ThreadStatus::Unknown;
        }
        ThreadStatus::Idle
    }

    pub fn summary(&self) -> ThreadRunSummary {
        ThreadRunSummary {
            main_turn: match self.main_turn_running {
                Some(true) => ThreadMainTurn::Running,
                Some(false) => ThreadMainTurn::Idle,
                None => ThreadMainTurn::Unknown,
            },
            recent_error: None,
            pending_approvals: self.pending_approvals,
            pending_questions: self.pending_questions,
            active_jobs: self.active_jobs,
            tasks_pending: self.tasks_pending,
            tasks_running: self.tasks_running,
            pending_followups: self.pending_followups,
            pending_goals: self.pending_goals,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<ThreadSessionMode>,
    pub id: String,
    pub status: ThreadStatus,
    /// Authoritative run facts; present only for consumers that negotiated
    /// [`CAPABILITY_THREAD_RUN_SUMMARY_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_summary: Option<ThreadRunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Authoritative selection intent; absent on older servers or unavailable history projections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection_mode: Option<kcoder_types::ModelSelectionMode>,
    /// Last committed provider-qualified model; distinct from client display metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<ThreadParent>,
    #[serde(default)]
    pub metadata: ThreadMetadata,
    /// Frozen session-level settings template binding (id + content revision).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_template: Option<SettingsTemplateBinding>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserInput {
    Text { text: String },
    Image { url: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    /// Current requires retryModelConfigurationV1 and an exact failed attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_model_configuration: Option<kcoder_types::RetryModelConfiguration>,
    /// Continue the latest failed provider step without appending another user message.
    /// Requires failedTurnContinuationV1; input must be empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_from_turn_id: Option<String>,
    /// Exact failed attempt to continue; requires turnAttemptRetryV1 and retryOperationId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_from_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_mode: Option<TurnExecutionMode>,
    pub thread_id: String,
    pub input: Vec<UserInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    /// Declares a deliberate new attempt for a `client_message_id` that was
    /// already committed (regenerate or the legacy re-send path). Requires
    /// [`CAPABILITY_TURN_SUBMISSION_V1`]; omitting it makes a duplicate
    /// submission fail instead of appending a second user message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resubmit: Option<bool>,
    /// Names one recovery of one failed turn. Repeating it, from this connection
    /// or another, must be answered with the attempt that already accepted it;
    /// reusing it for a different failed turn is refused. Only meaningful
    /// together with `retryFromTurnId`. Requires
    /// [`CAPABILITY_TURN_RETRY_OPERATION_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Omitted preserves legacy selection semantics. Requires explicit capability
    /// negotiation before a client may request target-default following.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection_mode: Option<kcoder_types::ModelSelectionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

impl TurnStartParams {
    pub fn validate_model_selection(&self) -> Result<(), &'static str> {
        if self.retry_model_configuration.is_some() && self.retry_from_turn_id.is_none() {
            return Err("retryModelConfiguration requires retryFromTurnId");
        }
        if self.retry_model_configuration == Some(kcoder_types::RetryModelConfiguration::Current)
            && [self.model.as_deref(), self.retry_from_attempt_id.as_deref(), self.retry_operation_id.as_deref()]
                .into_iter().any(|value| value.is_none_or(|value| value.trim().is_empty())) {
            return Err("current retryModelConfiguration requires an explicit model, retryFromAttemptId and retryOperationId");
        }
        match self.model_selection_mode {
            Some(kcoder_types::ModelSelectionMode::FollowTargetDefault) => {
                if self.model.is_some() { return Err("follow_target_default cannot include model"); }
                if self.retry_from_turn_id.is_some() { return Err("A failed-turn continuation cannot change to target-default following"); }
            }
            Some(kcoder_types::ModelSelectionMode::Explicit) => {
                if self.model.as_deref().is_none_or(|model| model.trim().is_empty()) {
                    return Err("explicit model selection requires a nonempty model");
                }
            }
            None => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub turn: Turn,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSessionMode {
    #[default]
    Default,
    Orchestrate,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnExecutionMode {
    #[default]
    Standard,
    Moa,
    MoaPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSessionModeSetParams {
    pub thread_id: String,
    pub mode: ThreadSessionMode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModesParams {
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModesResult {
    pub session_mode: ThreadSessionMode,
    pub moa_summary: String,
    pub moa_plan_planners: Vec<String>,
    pub moa_plan_error: Option<String>,
    /// Recorded settings-template binding of this session; `None` when it uses the store default.
    #[serde(default)]
    pub settings_template: Option<SettingsTemplateBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptResult {
    pub interrupted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    pub thread_id: String,
    pub status: TurnStatus,
}

/// Routing and ordering metadata repeated on every streaming notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventContext {
    pub server_id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub sequence: u64,
}

/// A background event retains its logical identity across transport reconnects.
/// Legacy producers omit `identity`; run-aware producers advertise
/// `backgroundRunIdentityV1` and include it on every background notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundEventContext {
    #[serde(flatten)]
    pub context: EventContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<kcoder_types::BackgroundEventIdentity>,
}

/// The existing `item/event` payload with optional run-scoped background metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundItemEventParams {
    #[serde(flatten)]
    pub context: BackgroundEventContext,
    pub event: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    UserMessage,
    AgentMessage,
    Reasoning,
    ToolCall,
    ToolResult,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    #[serde(default)]
    pub content: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
    /// Distinguishes a continuation's display stream from earlier failed output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(flatten)]
    pub context: EventContext,
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub turn: Turn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStartedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeltaParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item_id: String,
    pub delta: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCompletedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestParams {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub approval_id: String,
    pub action: ApprovalAction,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApprovalAction {
    Command { command: String },
    FileChange { path: String },
    Tool { name: String, input: Value },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
    /// Interaction this reply answers. Required once the connection negotiated
    /// [`CAPABILITY_INTERACTION_BINDING_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

impl ApprovalResponse {
    /// Every identity field the reply must echo to be attributable.
    pub fn binding(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.approval_id.as_deref(),
            self.thread_id.as_deref(),
            self.turn_id.as_deref(),
        )
    }
}

/// Server notification after an approval request reaches a terminal state, allowing clients to close its pending card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolvedParams {
    pub request_id: u64,
    pub approval_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub decision: ApprovalDecision,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestParams {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub question_id: String,
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub allows_freeform: bool,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub value: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    #[serde(default)]
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub answers: BTreeMap<String, QuestionAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    /// Interaction this reply answers. Required once the connection negotiated
    /// [`CAPABILITY_INTERACTION_BINDING_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

impl QuestionResponse {
    /// Every identity field the reply must echo to be attributable.
    pub fn binding(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.question_id.as_deref(),
            self.thread_id.as_deref(),
            self.turn_id.as_deref(),
        )
    }
}

/// Server notification after a question request reaches a terminal state; clients cannot infer server receipt from socket send alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResolvedParams {
    pub request_id: u64,
    pub question_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("JSONL line is empty")]
    EmptyLine,
    #[error("JSONL record contains an embedded newline")]
    EmbeddedNewline,
    #[error("invalid JSONL record: {0}")]
    Json(#[from] serde_json::Error),
}

/// Serialize one message as a compact JSONL record, including its trailing LF.
pub fn encode_line<T: Serialize>(message: &T) -> Result<String, CodecError> {
    let mut encoded = serde_json::to_string(message)?;
    encoded.push('\n');
    Ok(encoded)
}

/// Deserialize one JSONL record. A single trailing LF or CRLF is accepted;
/// blank lines and multiple physical records are rejected.
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, CodecError> {
    let record = line
        .strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line);

    if record.trim().is_empty() {
        return Err(CodecError::EmptyLine);
    }
    if record.contains(['\r', '\n']) {
        return Err(CodecError::EmbeddedNewline);
    }
    Ok(serde_json::from_str(record)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_as_one_jsonl_record() {
        let request = Request::new(
            7,
            method::INITIALIZE,
            InitializeParams {
                protocol_version: PROTOCOL_VERSION.into(),
                client_info: ImplementationInfo {
                    name: "kcoder-studio".into(),
                    version: "0.1.0".into(),
                },
                capabilities: ClientCapabilities::default(),
            },
        );

        let line = encode_line(&request).unwrap();
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains("\"protocolVersion\""));
        assert_eq!(
            decode_line::<Request<InitializeParams>>(&line).unwrap(),
            request
        );
    }

    #[test]
    fn success_and_error_responses_have_exclusive_payloads() {
        let success = Response::success("req-1", json!({ "ok": true }));
        assert_eq!(
            serde_json::to_value(success).unwrap(),
            json!({"jsonrpc":"2.0","id":"req-1","result":{"ok":true}})
        );

        let failure: Response<Value> = Response::error(
            2,
            RpcError {
                code: -32602,
                message: "invalid params".into(),
                data: None,
            },
        );
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid params"}})
        );
    }

    #[test]
    fn experimental_workspace_and_attachment_contracts_are_stable() {
        let workspace = Request::new(
            8,
            method::DEVICE_EXECUTE,
            DeviceExecuteParams {
                command_key: "workspace_read_text_file".into(),
                thread_id: None,
                path: Some("/workspace".into()),
                args: vec!["README.md".into()],
                max_output_bytes: Some(262_144),
                timeout_seconds: None,
                stdin: None,
            },
        );
        assert_eq!(
            serde_json::to_value(workspace).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 8,
                "method": "device/execute",
                "params": {
                    "command_key": "workspace_read_text_file",
                    "path": "/workspace",
                    "args": ["README.md"],
                    "max_output_bytes": 262144
                }
            })
        );
        let thread_scoped: DeviceExecuteParams = serde_json::from_value(json!({
            "command_key": "turn_file_changes_review",
            "thread_id": "thread-a",
            "args": ["artifact-a"]
        }))
        .unwrap();
        assert_eq!(thread_scoped.thread_id.as_deref(), Some("thread-a"));
        assert_eq!(
            serde_json::to_value(thread_scoped).unwrap()["threadId"],
            "thread-a"
        );
        let attachment = AttachmentSaveParams {
            filename: "notes.txt".into(),
            content_base64: "aGk=".into(),
        };
        assert_eq!(
            serde_json::to_value(attachment).unwrap(),
            json!({"filename":"notes.txt","content_base64":"aGk="})
        );
        assert_eq!(
            serde_json::to_value(Request::new(
                10,
                method::ATTACHMENT_DELETE,
                AttachmentDeleteParams {
                    path: "/tmp/staged/notes.txt".into(),
                },
            ))
            .unwrap(),
            json!({"jsonrpc":"2.0","id":10,"method":"attachment/delete","params":{"path":"/tmp/staged/notes.txt"}})
        );
        let read = Request::new(
            9,
            method::ATTACHMENT_READ,
            AttachmentReadParams {
                thread_id: "thread-1".into(),
                path: "/tmp/evidence.png".into(),
            },
        );
        assert_eq!(
            serde_json::to_value(read).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 9,
                "method": "attachment/read",
                "params": {"threadId":"thread-1","path":"/tmp/evidence.png"}
            })
        );
        assert_eq!(
            serde_json::to_value(AttachmentReadResult {
                content_base64: "aGk=".into(),
                size: 2,
            })
            .unwrap(),
            json!({"contentBase64":"aGk=","size":2})
        );
        let chunk = Request::new(
            11,
            method::ATTACHMENT_READ_CHUNK,
            AttachmentReadChunkParams {
                thread_id: "thread-1".into(),
                path: "/tmp/evidence.bin".into(),
                offset: 524_288,
                length: 524_288,
            },
        );
        assert_eq!(
            serde_json::to_value(chunk).unwrap(),
            json!({
                "jsonrpc":"2.0","id":11,"method":"attachment/read/chunk",
                "params":{"threadId":"thread-1","path":"/tmp/evidence.bin","offset":524288,"length":524288}
            })
        );
        assert_eq!(
            serde_json::to_value(AttachmentReadChunkResult {
                content_base64: "aGk=".into(),
                offset: 0,
                size: 2,
                total_size: 2,
                eof: true,
            })
            .unwrap(),
            json!({"contentBase64":"aGk=","offset":0,"size":2,"totalSize":2,"eof":true})
        );
    }

    #[test]
    fn terminal_contract_uses_the_upstream_socket_payload_shape() {
        let request = Request::new(
            9,
            method::TERMINAL_RESIZE,
            TerminalResizeParams {
                session_id: "terminal-1".into(),
                rows: 40,
                cols: 120,
            },
        );
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "jsonrpc":"2.0",
                "id":9,
                "method":"terminal/resize",
                "params":{"session_id":"terminal-1","rows":40,"cols":120}
            })
        );
        assert_eq!(
            serde_json::to_value(Notification::new(
                method::TERMINAL_OUTPUT,
                TerminalOutputParams {
                    session_id: "terminal-1".into(),
                    data: "hello\r\n".into(),
                    sequence: 1,
                }
            ))
            .unwrap()["params"]["session_id"],
            "terminal-1"
        );
        assert_eq!(
            serde_json::to_value(Request::new(
                10,
                method::TERMINAL_LIST,
                TerminalListParams::default(),
            ))
            .unwrap(),
            json!({"jsonrpc":"2.0","id":10,"method":"terminal/list","params":{}})
        );
        assert_eq!(
            serde_json::to_value(Request::new(
                11,
                method::TERMINAL_ATTACH,
                TerminalAttachParams {
                    session_id: "terminal-1".into(),
                    rows: 30,
                    cols: 100,
                },
            ))
            .unwrap(),
            json!({
                "jsonrpc":"2.0",
                "id":11,
                "method":"terminal/attach",
                "params":{"session_id":"terminal-1","rows":30,"cols":100}
            })
        );
    }

    #[test]
    fn browser_contract_has_typed_methods_actions_and_frames() {
        let start = Request::new(
            10,
            method::BROWSER_START,
            BrowserStartParams {
                url: "http://127.0.0.1:4173/".into(),
                width: 1280,
                height: 720,
            },
        );
        assert_eq!(
            serde_json::to_value(start).unwrap(),
            json!({
                "jsonrpc":"2.0",
                "id":10,
                "method":"browser/start",
                "params":{"url":"http://127.0.0.1:4173/","width":1280,"height":720}
            })
        );

        let pointer = BrowserActionParams {
            session_id: "browser-1".into(),
            action: BrowserAction::PointerDown { x: 12.5, y: 24.0 },
        };
        let value = serde_json::to_value(&pointer).unwrap();
        assert_eq!(
            value,
            json!({"session_id":"browser-1","action":"pointer_down","x":12.5,"y":24.0})
        );
        assert_eq!(
            serde_json::from_value::<BrowserActionParams>(value).unwrap(),
            pointer
        );
        assert_eq!(
            serde_json::to_value(BrowserActionParams {
                session_id: "browser-1".into(),
                action: BrowserAction::Shortcut {
                    key: "a".into(),
                    modifiers: vec!["Control".into()],
                },
            })
            .unwrap(),
            json!({"session_id":"browser-1","action":"shortcut","key":"a","modifiers":["Control"]})
        );

        let frame = BrowserScreenshotResult {
            session_id: "browser-1".into(),
            data_base64: "/9j/".into(),
            mime_type: "image/jpeg".into(),
            width: 800,
            height: 600,
            page: BrowserPageState {
                url: "https://example.com/".into(),
                title: Some("Example".into()),
                favicon_url: Some("https://example.com/favicon.ico".into()),
                can_go_back: Some(true),
                can_go_forward: Some(false),
            },
        };
        let value = serde_json::to_value(frame).unwrap();
        assert_eq!(
            value["page"]["faviconUrl"],
            "https://example.com/favicon.ico"
        );
        assert_eq!(value["page"]["canGoBack"], true);
        assert_eq!(value["page"]["canGoForward"], false);
        assert_eq!(value["data_base64"], "/9j/");
    }

    #[test]
    fn message_distinguishes_requests_notifications_and_responses() {
        let request = decode_line::<Message>(
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/list","params":{}}"#,
        )
        .unwrap();
        assert!(matches!(request, Message::Request(_)));

        let notification =
            decode_line::<Message>(r#"{"jsonrpc":"2.0","method":"turn/started","params":{}}"#)
                .unwrap();
        assert!(matches!(notification, Message::Notification(_)));

        let response =
            decode_line::<Message>(r#"{"jsonrpc":"2.0","id":1,"result":{"threads":[]}}"#).unwrap();
        assert!(matches!(response, Message::Response(_)));
    }

    #[test]
    fn item_delta_carries_server_routing_and_sequence() {
        let notification = Notification::new(
            method::ITEM_DELTA,
            ItemDeltaParams {
                context: EventContext {
                    server_id: "server-a".into(),
                    thread_id: "thread-1".into(),
                    turn_id: Some("turn-1".into()),
                    sequence: 9,
                },
                item_id: "item-2".into(),
                delta: json!({"text":"hello"}),
            },
        );

        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["params"]["serverId"], "server-a");
        assert_eq!(value["params"]["sequence"], 9);
        assert_eq!(value["params"]["itemId"], "item-2");
    }

    #[test]
    fn approval_and_question_are_server_requests() {
        let approval = Request::new(
            "approval-rpc-1",
            method::APPROVAL_REQUEST,
            ApprovalRequestParams {
                server_id: "server-a".into(),
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                approval_id: "approval-1".into(),
                action: ApprovalAction::Command {
                    command: "cargo test".into(),
                },
                reason: "run tests".into(),
            },
        );
        assert_eq!(
            serde_json::to_value(approval).unwrap()["params"]["action"]["type"],
            "command"
        );

        let question = QuestionRequestParams {
            server_id: "server-a".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            question_id: "question-1".into(),
            questions: vec![Question {
                id: "database".into(),
                header: "Database".into(),
                prompt: "Which database?".into(),
                options: vec![QuestionOption {
                    label: "SQLite".into(),
                    value: "sqlite".into(),
                    description: "Keep state local.".into(),
                    preview: None,
                }],
                allows_freeform: true,
                multi_select: false,
            }],
            annotations: None,
        };
        let line = encode_line(&Request::new(12, method::QUESTION_REQUEST, question)).unwrap();
        assert!(line.contains("\"allowsFreeform\":true"));

        assert_eq!(
            serde_json::to_value(Notification::new(
                method::QUESTION_RESOLVED,
                QuestionResolvedParams {
                    request_id: 12,
                    question_id: "question-12".into(),
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    reason: "client_response".into(),
                },
            ))
            .unwrap()["method"],
            "question/resolved"
        );

        assert_eq!(
            serde_json::to_value(Notification::new(
                method::APPROVAL_RESOLVED,
                ApprovalResolvedParams {
                    request_id: 11,
                    approval_id: "approval-11".into(),
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    decision: ApprovalDecision::Decline,
                    reason: "timeout".into(),
                },
            ))
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "method": "approval/resolved",
                "params": {
                    "requestId": 11,
                    "approvalId": "approval-11",
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "decision": "decline",
                    "reason": "timeout"
                }
            })
        );
    }

    #[test]
    fn codec_rejects_empty_and_multiple_records() {
        assert!(matches!(
            decode_line::<Value>("\r\n"),
            Err(CodecError::EmptyLine)
        ));
        assert!(matches!(
            decode_line::<Value>("{}\n{}\n"),
            Err(CodecError::EmbeddedNewline)
        ));
    }

    #[test]
    fn all_mvp_method_types_serialize() {
        let thread = Thread {
            model_selection_mode: None,
            selected_model: None,
            session_mode: None,
            id: "thread-1".into(),
            status: ThreadStatus::Idle,
            run_summary: None,
            title: None,
            cwd: Some("/workspace".into()),
            model: Some("model-a".into()),
            archived_at: None,
            parent: None,
            metadata: ThreadMetadata {
                schema: "kcoder.thread-metadata".into(),
                version: 1,
                revision: 0,
                title: None,
                model: None,
                archived_at: None,
                parent: None,
            },
            settings_template: None,
            created_at: "2026-07-27T00:00:00Z".into(),
            updated_at: "2026-07-27T00:00:00Z".into(),
        };
        serde_json::to_value(ThreadStartResult {
            thread: thread.clone(),
        })
        .unwrap();
        serde_json::to_value(ThreadListParams {
            allow_partial: None,
            cursor: None,
            limit: Some(20),
            archived: Some(false),
            query: Some("workspace".into()),
        })
        .map(|value| {
            assert_eq!(value["archived"], false);
            assert_eq!(value["query"], "workspace");
        })
        .unwrap();
        serde_json::to_value(ThreadListResult {
            threads: vec![thread.clone()],
            next_cursor: None,
            completeness: None,
            issue_count: None,
        })
        .unwrap();
        let update: ThreadMetadataUpdateParams = serde_json::from_value(serde_json::json!({
            "threadId": "thread-1",
            "title": "新的标题",
            "archivedAt": null
        }))
        .unwrap();
        assert_eq!(update.title, MetadataUpdate::Set("新的标题".into()));
        assert_eq!(update.model, MetadataUpdate::Unchanged);
        assert_eq!(update.archived_at, MetadataUpdate::Clear);
        let wire = serde_json::to_value(update).unwrap();
        assert_eq!(wire["title"], "新的标题");
        assert!(wire["archivedAt"].is_null());
        assert!(wire.get("model").is_none());
        serde_json::to_value(ThreadResumeParams {
            thread_id: thread.id.clone(),
        })
        .unwrap();
        serde_json::to_value(ThreadResumeResult { thread }).unwrap();
        let turn_start = serde_json::to_value(TurnStartParams {
            retry_model_configuration: None,
            model_selection_mode: None,
            retry_from_turn_id: None,
            retry_from_attempt_id: None,
            turn_mode: None,
            thread_id: "thread-1".into(),
            permission_mode: None,
            input: vec![UserInput::Text {
                text: "hello".into(),
            }],
            client_message_id: Some("client-message-1".into()),
            resubmit: Some(true),
            retry_operation_id: Some("retry:thread-1:turn-1".into()),
            model: None,
            reasoning_effort: Some("high".into()),
            proxy_url: Some("http://127.0.0.1:7890".into()),
            service_tier: Some("priority".into()),
        })
        .unwrap();
        // The recovery identity has to survive the wire as a named operation, not
        // as a bare transport id.
        assert_eq!(turn_start["retryOperationId"], "retry:thread-1:turn-1");
        serde_json::to_value(TurnInterruptParams {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
        })
        .unwrap();
    }

    #[test]
    fn thread_operation_contracts_use_stable_camel_case_shapes() {
        assert_eq!(
            serde_json::to_value(Request::new(
                19,
                method::THREAD_FORK,
                ThreadForkParams {
                    thread_id: "thread-1".into(),
                    last_turn_id: "turn-2".into(),
                    ephemeral: false,
                    cwd: Some("/workspace".into()),
                    exclude_turns: true,
                },
            ))
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 19,
                "method": "thread/fork",
                "params": {
                    "threadId": "thread-1",
                    "lastTurnId": "turn-2",
                    "cwd": "/workspace",
                    "excludeTurns": true
                }
            })
        );
        assert_eq!(
            serde_json::to_value(Request::new(
                20,
                method::THREAD_ROLLBACK,
                ThreadRollbackParams {
                    thread_id: "thread-1".into(),
                    turn: Some(2),
                },
            ))
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 20,
                "method": "thread/rollback",
                "params": {"threadId": "thread-1", "turn": 2}
            })
        );
        assert_eq!(
            serde_json::to_value(ThreadCompactResult {
                thread_id: "thread-1".into(),
                compacted: true,
                pre_tokens: 120,
                post_tokens: 45,
            })
            .unwrap(),
            json!({
                "threadId": "thread-1",
                "compacted": true,
                "preTokens": 120,
                "postTokens": 45
            })
        );

        let set = ThreadGoalSetParams {
            thread_id: "thread-1".into(),
            objective: Some("finish parity".into()),
            edit: false,
            expected_goal_id: None,
            expected_revision: None,
            require_no_goal: false,
            mode: Some("strict".into()),
            verification_kind: Some("answer".into()),
            status: Some("paused".into()),
            token_budget: None,
            clear_token_budget: true,
        };
        let value = serde_json::to_value(&set).unwrap();
        assert_eq!(
            value,
            json!({
                "threadId": "thread-1",
                "objective": "finish parity",
                "mode": "strict",
                "verificationKind": "answer",
                "status": "paused",
                "clearTokenBudget": true
            })
        );
        assert_eq!(
            serde_json::from_value::<ThreadGoalSetParams>(value).unwrap(),
            set
        );
        let legacy_goal = serde_json::from_value::<ThreadGoal>(json!({
            "threadId": "thread-1",
            "objective": "legacy",
            "mode": "strict",
            "status": "active",
            "tokenBudget": null,
            "tokensUsed": 0,
            "timeUsedSeconds": 0,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap();
        assert_eq!(legacy_goal.verification_kind, "artifact");
        assert_eq!(
            serde_json::to_value(Request::new(
                21,
                method::THREAD_DELETE,
                ThreadDeleteParams {
                    thread_id: "thread-1".into(),
                },
            ))
            .unwrap()["params"],
            json!({"threadId": "thread-1"})
        );
    }

    #[test]
    fn failed_turn_continuation_contract_is_opt_in_and_has_no_user_input() {
        let params: TurnStartParams = serde_json::from_value(serde_json::json!({
            "threadId": "thread-1", "retryFromTurnId": "turn-1", "input": []
        }))
        .unwrap();
        assert_eq!(params.retry_from_turn_id.as_deref(), Some("turn-1"));
        assert!(params.input.is_empty());
        let old: TurnStartParams = serde_json::from_value(serde_json::json!({
            "threadId": "thread-1", "input": [{"type":"text", "text":"hello"}]
        }))
        .unwrap();
        assert!(old.retry_from_turn_id.is_none());
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("retryFromTurnId")
                .is_none()
        );
    }

    #[test]
    fn thread_parent_is_structured_and_accepts_studio_legacy_json_string() {
        let structured: ThreadMetadataUpdateParams = serde_json::from_value(json!({
            "threadId": "thread-child",
            "parent": {
                "taskId": "kcoder:local:thread-parent",
                "threadId": "thread-parent",
                "lastTurnId": "turn-3"
            }
        }))
        .unwrap();
        let legacy: ThreadMetadataUpdateParams = serde_json::from_value(json!({
            "threadId": "thread-child",
            "parent": "{\"taskId\":\"kcoder:local:thread-parent\",\"threadId\":\"thread-parent\",\"lastTurnId\":\"turn-3\"}"
        }))
        .unwrap();
        let expected = MetadataUpdate::Set(ThreadParent {
            task_id: "kcoder:local:thread-parent".into(),
            thread_id: "thread-parent".into(),
            last_turn_id: "turn-3".into(),
        });
        assert_eq!(structured.parent, expected);
        assert_eq!(legacy.parent, expected);
        assert_eq!(
            serde_json::to_value(structured).unwrap()["parent"],
            json!({
                "taskId": "kcoder:local:thread-parent",
                "threadId": "thread-parent",
                "lastTurnId": "turn-3"
            })
        );
    }

    #[test]
    fn partial_thread_list_wire_round_trip_retains_opt_in_and_snapshot_status() {
        let params: ThreadListParams =
            serde_json::from_value(serde_json::json!({"allowPartial":true})).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap()["allowPartial"], true);
        let result: ThreadListResult = serde_json::from_value(serde_json::json!({
            "threads":[], "completeness":"partial", "issueCount":2
        }))
        .unwrap();
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded["completeness"], "partial");
        assert_eq!(encoded["issueCount"], 2);
    }

    #[test]
    fn partial_thread_list_old_wire_remains_unchanged() {
        let params: ThreadListParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), serde_json::json!({}));
        let result: ThreadListResult =
            serde_json::from_value(serde_json::json!({"threads":[]})).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"threads":[]})
        );
    }

    #[test]
    fn settings_template_wire_fields_round_trip_on_thread_types() {
        let params: ThreadStartParams = serde_json::from_value(serde_json::json!({
            "settingsTemplate": "fast-local"
        }))
        .unwrap();
        assert_eq!(params.settings_template.as_deref(), Some("fast-local"));
        assert_eq!(
            serde_json::to_value(&params).unwrap()["settingsTemplate"],
            "fast-local"
        );
        let baseline: ThreadStartParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(baseline.settings_template.is_none());
        assert_eq!(
            serde_json::to_value(&baseline).unwrap(),
            serde_json::json!({ "metadata": {} })
        );

        let bound: Thread = serde_json::from_value(serde_json::json!({
            "id": "thread-1",
            "status": "idle",
            "createdAt": "1",
            "updatedAt": "1",
            "settingsTemplate": { "id": "fast-local", "revisionSha256": "abc" }
        }))
        .unwrap();
        let binding = bound.settings_template.clone().expect("binding");
        assert_eq!(binding.id, "fast-local");
        assert_eq!(binding.revision_sha256, "abc");
        assert_eq!(
            serde_json::to_value(&bound).unwrap()["settingsTemplate"]["revisionSha256"],
            "abc"
        );

        let unbound: Thread = serde_json::from_value(serde_json::json!({
            "id": "thread-1",
            "status": "idle",
            "createdAt": "1",
            "updatedAt": "1"
        }))
        .unwrap();
        assert!(unbound.settings_template.is_none());
        assert!(
            serde_json::to_value(&unbound)
                .unwrap()
                .get("settingsTemplate")
                .is_none()
        );
    }

    fn run_facts() -> ThreadRunFacts {
        ThreadRunFacts {
            main_turn_running: Some(false),
            pending_approvals: Some(0),
            pending_questions: Some(0),
            active_jobs: Some(0),
            tasks_pending: Some(0),
            tasks_running: Some(0),
            pending_followups: Some(0),
            pending_goals: Some(0),
        }
    }

    #[test]
    fn thread_run_state_prefers_pending_interaction_over_running_turn() {
        let facts = ThreadRunFacts {
            main_turn_running: Some(true),
            pending_approvals: Some(1),
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::WaitingForApproval);

        let facts = ThreadRunFacts {
            main_turn_running: Some(true),
            pending_questions: Some(2),
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::WaitingForAnswer);
    }

    #[test]
    fn thread_run_state_runs_only_while_the_main_turn_is_working() {
        let facts = ThreadRunFacts {
            main_turn_running: Some(true),
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::Running);
    }

    #[test]
    fn thread_run_state_marks_background_work_after_the_main_turn_ends() {
        for facts in [
            ThreadRunFacts {
                active_jobs: Some(1),
                ..run_facts()
            },
            ThreadRunFacts {
                tasks_running: Some(2),
                ..run_facts()
            },
            ThreadRunFacts {
                tasks_pending: Some(1),
                ..run_facts()
            },
            ThreadRunFacts {
                pending_goals: Some(1),
                ..run_facts()
            },
        ] {
            assert_eq!(facts.state(), ThreadStatus::Background);
        }
    }

    #[test]
    fn thread_run_state_marks_aggregation_when_only_delivery_is_pending() {
        let facts = ThreadRunFacts {
            pending_followups: Some(3),
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::Aggregating);
    }

    #[test]
    fn thread_run_state_is_idle_only_when_every_fact_is_readable_and_clear() {
        assert_eq!(run_facts().state(), ThreadStatus::Idle);

        // A known pending fact still wins when other facts are unreadable.
        let facts = ThreadRunFacts {
            pending_questions: None,
            pending_approvals: None,
            tasks_running: Some(1),
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::Background);

        // Unknowns never collapse into a confident idle.
        let facts = ThreadRunFacts {
            main_turn_running: None,
            ..run_facts()
        };
        assert_eq!(facts.state(), ThreadStatus::Unknown);

        assert_eq!(ThreadRunFacts::default().state(), ThreadStatus::Unknown);
    }

    #[test]
    fn thread_run_summary_serializes_unknown_facts_as_explicit_nulls() {
        let facts = ThreadRunFacts {
            main_turn_running: None,
            pending_approvals: Some(0),
            pending_questions: None,
            active_jobs: Some(2),
            tasks_pending: None,
            tasks_running: Some(0),
            pending_followups: None,
            pending_goals: Some(0),
        };
        assert_eq!(
            serde_json::to_value(facts.summary()).unwrap(),
            json!({
                "mainTurn": "unknown",
                "pendingApprovals": 0,
                "pendingQuestions": null,
                "activeJobs": 2,
                "tasksPending": null,
                "tasksRunning": 0,
                "pendingFollowups": null,
                "pendingGoals": 0
            })
        );
        assert_eq!(facts.summary().main_turn, ThreadMainTurn::Unknown);
    }

    #[test]
    fn turn_submission_declares_a_deliberate_resubmission() {
        let declared: TurnStartParams = serde_json::from_value(json!({
            "threadId": "thread-1",
            "input": [{"type": "text", "text": "hello"}],
            "clientMessageId": "client-1",
            "resubmit": true
        }))
        .unwrap();
        assert_eq!(declared.resubmit, Some(true));
        assert_eq!(
            serde_json::to_value(&declared).unwrap()["resubmit"],
            json!(true)
        );

        // A first submission omits the field entirely instead of sending false.
        let first: TurnStartParams = serde_json::from_value(json!({
            "threadId": "thread-1",
            "input": [{"type": "text", "text": "hello"}],
            "clientMessageId": "client-1"
        }))
        .unwrap();
        assert_eq!(first.resubmit, None);
        assert!(
            serde_json::to_value(&first)
                .unwrap()
                .get("resubmit")
                .is_none()
        );
    }

    #[test]
    fn thread_status_wire_values_keep_snake_case_for_every_projection() {
        for (status, wire) in [
            (ThreadStatus::Idle, "idle"),
            (ThreadStatus::Running, "running"),
            (ThreadStatus::WaitingForApproval, "waiting_for_approval"),
            (ThreadStatus::WaitingForAnswer, "waiting_for_answer"),
            (ThreadStatus::Background, "background"),
            (ThreadStatus::Aggregating, "aggregating"),
            (ThreadStatus::Unknown, "unknown"),
            (ThreadStatus::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(wire));
        }
    }

    #[test]
    fn thread_omits_run_summary_unless_the_consumer_negotiated_it() {
        let legacy: Thread = serde_json::from_value(json!({
            "id": "thread-1",
            "status": "idle",
            "createdAt": "1",
            "updatedAt": "1"
        }))
        .unwrap();
        assert!(legacy.run_summary.is_none());
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("runSummary")
                .is_none()
        );

        let negotiated = Thread {
            run_summary: Some(run_facts().summary()),
            ..legacy
        };
        assert_eq!(
            serde_json::to_value(negotiated)
                .unwrap()
                .get("runSummary")
                .unwrap()
                .get("mainTurn")
                .unwrap(),
            &json!("idle")
        );
    }

    #[test]
    fn thread_metadata_serializes_cleared_fields_as_explicit_nulls() {
        let metadata = ThreadMetadata {
            schema: "kcoder.thread-metadata".into(),
            version: 1,
            revision: 7,
            title: None,
            model: None,
            archived_at: None,
            parent: None,
        };
        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            json!({
                "schema": "kcoder.thread-metadata",
                "version": 1,
                "revision": 7,
                "title": null,
                "model": null,
                "archivedAt": null,
                "parent": null
            })
        );
    }
}

#[cfg(test)]
mod model_selection_contract_tests {
    use super::*;
    #[test]
    fn current_retry_requires_complete_failed_attempt_identity_and_explicit_model() {
        let value = serde_json::json!({"threadId":"thread","input":[],"retryFromTurnId":"turn","retryFromAttemptId":"attempt","retryOperationId":"operation","model":"provider::model","retryModelConfiguration":"current"});
        let parse = |value| serde_json::from_value::<TurnStartParams>(value).unwrap();
        assert!(parse(value.clone()).validate_model_selection().is_ok());
        for field in ["retryFromTurnId", "retryFromAttemptId", "retryOperationId", "model"] {
            let mut missing = value.clone(); missing.as_object_mut().unwrap().remove(field);
            assert!(parse(missing).validate_model_selection().is_err(), "{field}");
        }
    }
    #[test]
    fn turn_selection_intent_is_explicit_and_validated() {
        let parse = |extra: serde_json::Value| {
            let mut value = serde_json::json!({"threadId":"fixture","input":[]});
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            serde_json::from_value::<TurnStartParams>(value).unwrap()
        };
        let legacy = parse(serde_json::json!({}));
        assert!(legacy.validate_model_selection().is_ok());
        assert!(serde_json::to_value(&legacy).unwrap().get("modelSelectionMode").is_none());
        assert!(parse(serde_json::json!({"modelSelectionMode":"follow_target_default"})).validate_model_selection().is_ok());
        for invalid in [
            serde_json::json!({"modelSelectionMode":"explicit"}),
            serde_json::json!({"modelSelectionMode":"explicit","model":" "}),
            serde_json::json!({"modelSelectionMode":"follow_target_default","model":"vendor::model"}),
            serde_json::json!({"modelSelectionMode":"follow_target_default","retryFromTurnId":"turn-1"}),
        ] { assert!(parse(invalid).validate_model_selection().is_err()); }
    }
}
