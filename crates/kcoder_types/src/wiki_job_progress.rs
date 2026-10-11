use serde::{Deserialize, Serialize};

/// Safe facts authored by the host. No source text, model response or credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiJobProgress {
    pub phase: String,
    pub started_at_ms: i64,
    pub phase_started_at_ms: i64,
    pub heartbeat_at_ms: i64,
    pub model_progress_at_ms: Option<i64>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_configuration: Option<crate::ModelConfigurationSummary>,
    pub text_bytes: usize,
    pub reasoning_bytes: usize,
    pub through_chunk: Option<usize>,
    pub total_chunks: Option<usize>,
    pub first_page: Option<u32>,
    pub last_page: Option<u32>,
    pub call_limit: Option<u32>,
    pub requested_output_tokens: Option<u32>,
    pub estimated_input_tokens: Option<usize>,
    pub reserved_calls: u32,
    pub repair_calls: u32,
    pub usage_reported_calls: u32,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
