//! Bound MCP Apps requests. Server names and arbitrary UI URIs are never routing input.
use kcoder_types::{
    mcp_apps::{McpAppCsp, McpAppPermissions},
    widgets::WidgetRef,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CAPABILITY_MCP_APPS_V1: &str = "mcpAppsV1";
pub mod mcp_apps_method {
    pub const READ: &str = "mcp/apps/read";
    pub const REVOKE: &str = "mcp/apps/revoke";
    pub const RESOURCE_READ: &str = "mcp/apps/resourceRead";
    pub const RESOURCE_CONTENT_READ: &str = "mcp/apps/resourceContentRead";
    pub const TOOL_CALL: &str = "mcp/apps/toolCall";
    pub const OPERATION_READ: &str = "mcp/apps/operationRead";
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppRevokeParams {
    pub thread_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppRevokeResult {
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppReadResult {
    pub widget: WidgetRef,
    /// Historical data stays readable; only the original live authority permits actions.
    pub live: bool,
    pub protocol_version: String,
    pub allowed_tools: Vec<String>,
    pub resources_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_info: Option<Value>,
    pub csp: McpAppCsp,
    pub requested_permissions: McpAppPermissions,
    pub tool_input: Option<Value>,
    pub tool_content: Vec<Value>,
    pub structured_content: Option<Value>,
    pub result_meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppToolCallParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    pub connection_id: String,
    pub operation_id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppOperationReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    pub connection_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpAppOperationStatus {
    Prepared,
    Executing,
    Completed,
    Denied,
    NotSent,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppToolCallResult {
    pub operation_id: String,
    pub status: McpAppOperationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppResourceReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    pub connection_id: String,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppResourceRef {
    pub resource_id: String,
    pub sha256: String,
    pub bytes: u64,
    pub uri: String,
    pub content_count: u64,
    pub mime_type: Option<String>,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppResourceReadResult {
    pub resource: McpAppResourceRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppResourceContentReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    pub connection_id: String,
    pub resource_id: String,
    pub sha256: String,
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppResourceContentReadResult {
    pub resource_id: String,
    pub sha256: String,
    pub bytes: u64,
    pub offset: u64,
    pub next_offset: u64,
    pub data_base64: String,
}
