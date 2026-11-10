//! Trusted inline visualization identities. HTML is stored separately from transcripts.
use serde::{Deserialize, Serialize};

pub const WIDGET_SOURCE_BYTES: usize = 1024 * 1024;
pub const WIDGET_CHUNK_BYTES: usize = 32 * 1024;
pub const WIDGET_PREVIEW_BYTES: usize = 16 * 1024;
pub const WIDGET_SESSION_BYTES: u64 = 64 * 1024 * 1024;
pub const WIDGET_REVISION_LIMIT: usize = 512;
pub const WIDGET_TURN_LIMIT: usize = 12;
pub const WIDGET_TITLE_BYTES: usize = 256;
pub const WIDGET_SUMMARY_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WidgetFormat {
    #[default]
    Html,
    Svg,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WidgetExecutionMode {
    #[default]
    Managed,
    IsolatedHtml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WidgetLibrary {
    ChartJs,
    D3,
    Topojson,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetIdentity {
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetRef {
    pub widget_id: String,
    #[serde(flatten)]
    pub identity: WidgetIdentity,
    pub revision: u64,
    pub title: String,
    pub summary: String,
    pub format: WidgetFormat,
    pub execution_mode: WidgetExecutionMode,
    pub libraries: Vec<WidgetLibrary>,
    pub sha256: String,
    pub bytes: u64,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_app: Option<WidgetMcpSource>,
}

/// Routing identity only. UI datasets and HTML never inflate widget directories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetMcpSource {
    pub server_name: String,
    pub connection_id: String,
    pub plugin_id: Option<String>,
    pub tool_name: String,
    pub resource_uri: String,
    pub mime_type: String,
}

/// The owning host supplies these values; they are never tool input fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WidgetTurnBinding {
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
}

/// Uncommitted, bounded source preview. It never grants executable artifact authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetInputPreview {
    pub source: String,
    pub title: Option<String>,
    pub format: WidgetFormat,
    pub bytes: usize,
    pub truncated: bool,
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WidgetRenderStatus {
    Rendered,
    Failed,
}

/// A client rendering observation, not verification of calculations or external actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetRenderObservation {
    pub status: WidgetRenderStatus,
    pub error_code: Option<String>,
    pub observed_at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_and_mode_names_are_closed_and_stable() {
        assert_eq!(
            serde_json::to_string(&WidgetLibrary::ChartJs).unwrap(),
            "\"chart_js\""
        );
        assert!(serde_json::from_str::<WidgetLibrary>("\"https://example.test/code.js\"").is_err());
        assert!(serde_json::from_str::<WidgetExecutionMode>("\"arbitrary\"").is_err());
    }
}
