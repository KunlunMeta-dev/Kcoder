//! MCP Apps presentation data. Host authority and live connection handles stay outside the wire.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MCP_APPS_PROTOCOL_VERSION: &str = "2026-01-26";
pub const MCP_APP_MIME_TYPE: &str = "text/html;profile=mcp-app";
pub const MCP_APP_HTML_MAX_BYTES: usize = 512 * 1024;
pub const MCP_APP_DATA_MAX_BYTES: usize = 128 * 1024;
pub const MCP_APP_META_MAX_BYTES: usize = 32 * 1024;
pub const MCP_APP_VIEW_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppCsp {
    #[serde(default)]
    pub connect_domains: Vec<String>,
    #[serde(default)]
    pub resource_domains: Vec<String>,
    #[serde(default)]
    pub frame_domains: Vec<String>,
    #[serde(default)]
    pub base_uri_domains: Vec<String>,
}

/// These are server requests, never permissions automatically granted by the host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppPermissions {
    #[serde(default)]
    pub camera: bool,
    #[serde(default)]
    pub microphone: bool,
    #[serde(default)]
    pub geolocation: bool,
    #[serde(default)]
    pub clipboard_write: bool,
}

/// A bounded observation obtained from the same server connection as the tool call.
/// UI-only result metadata is never copied into a model-facing text block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppView {
    pub server_name: String,
    /// Identity of the original live connection; never resolve historical UI by name alone.
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub tool_name: String,
    pub resource_uri: String,
    pub mime_type: String,
    pub html: String,
    pub csp: McpAppCsp,
    pub requested_permissions: McpAppPermissions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefers_border: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_meta: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_content: Vec<Value>,
}
