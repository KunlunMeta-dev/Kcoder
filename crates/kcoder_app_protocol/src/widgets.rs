//! Capability-gated inline widget reads and client rendering observations.
pub use kcoder_types::widgets::{WidgetRef, WidgetRenderObservation, WidgetRenderStatus};
use serde::{Deserialize, Serialize};

pub mod widget_method {
    pub const LIST: &str = "widget/list";
    pub const READ: &str = "widget/read";
    pub const CONTENT_READ: &str = "widget/content/read";
    pub const RENDER_RECEIPT: &str = "widget/render/receipt";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetReadResult {
    pub widget: WidgetRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_observation: Option<WidgetRenderObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetListParams {
    pub thread_id: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetListResult {
    pub widgets: Vec<WidgetRef>,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetContentReadParams {
    pub thread_id: String,
    pub widget_id: String,
    pub revision: u64,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetContentReadResult {
    pub widget_id: String,
    pub revision: u64,
    pub sha256: String,
    pub bytes: u64,
    pub offset: usize,
    pub next_offset: usize,
    /// Base64 encodes one bounded raw-byte chunk, not a temporary file URL.
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetRenderReceiptParams {
    pub widget: WidgetReadParams,
    pub turn_id: String,
    pub attempt_id: String,
    pub tool_call_id: String,
    pub status: WidgetRenderStatus,
    #[serde(default)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WidgetRenderReceiptResult {
    pub accepted: bool,
}
