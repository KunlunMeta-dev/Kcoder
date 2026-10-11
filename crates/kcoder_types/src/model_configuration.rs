use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Default model output allowance; explicit provider limits and available
/// context remain authoritative when admitting a request.
pub const DEFAULT_MODEL_OUTPUT_TOKENS: u32 = 262_144;

/// Public effective model metadata. Deliberately excludes URLs, credentials,
/// arbitrary extra-body keys/values and filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfigurationSummary {
    pub provider_id: Option<String>,
    pub model_id: String,
    pub api_format: Option<String>,
    pub chat_protocol: String,
    pub context_window_tokens: Option<usize>,
    pub max_output_tokens: Option<u32>,
    pub request_output_limits: BTreeMap<String, Option<u32>>,
    pub output_headroom_tokens: Option<usize>,
    pub text: bool,
    pub tools: bool,
    /// Actual host composition; missing in older records, never inferred from capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_set: Option<ModelToolSetSummary>,
    pub vision: bool,
    pub reasoning: bool,
    pub structured_output: bool,
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_policy: Option<crate::ModelReasoningPolicy>,
    pub extra_body_configured: bool,
    pub request_override_fields: Vec<String>,
    /// Opaque revision of the private semantics; never an encoding of their value.
    pub revision: String,
    /// Whether this describes newly resolved settings or a pinned running snapshot.
    pub boundary: ModelConfigurationBoundary,
    /// Predefined field names and authority labels only.
    // The decode contract accepts repeated labels; serde normalizes its BTreeSet.
    #[cfg_attr(
        feature = "json-schema",
        schemars(with = "BTreeMap<String, Vec<String>>")
    )]
    pub sources: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ModelConfigurationBoundary {
    NextTurn,
    SessionSnapshot,
}

/// The count describes registered tools at this scope, before request permissions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelToolSetSummary {
    pub profile: Option<String>,
    pub registry_scope: ModelToolRegistryScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_tool_count: Option<usize>,
    /// Only populated when the actual provider request definitions are captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposed_tool_count: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ModelToolRegistryScope {
    ProfileConfiguration,
    SessionRegistry,
    SessionRole,
    WikiWorker,
}

/// Runtime facts owned by one workflow verification attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAgentConfigurationSummary {
    pub agent_id: String,
    pub run_id: String,
    pub artifact_attempt: u32,
    pub selection_source: AgentModelSelectionSource,
    pub configuration: ModelConfigurationSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentModelSelectionSource {
    InheritedSession,
    ExplicitRuntime,
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_unknown_secret_fields() {
        let value = serde_json::json!({"modelId":"model", "apiKey":"do-not-accept"});
        assert!(serde_json::from_value::<super::ModelConfigurationSummary>(value).is_err());
    }
}
