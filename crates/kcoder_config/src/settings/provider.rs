//! Provider configuration types and their defaults.

use crate::*;

/// Wire protocol used to encode requests and decode streaming responses.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    #[default]
    AnthropicMessages,
    OpenaiChatCompletions,
    OpenaiResponses,
    GeminiGenerateContent,
}

impl ApiFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic_messages",
            Self::OpenaiChatCompletions => "openai_chat_completions",
            Self::OpenaiResponses => "openai_responses",
            Self::GeminiGenerateContent => "gemini_generate_content",
        }
    }
}

/// A provider deployment definition. The outer map key serves as both the
/// provider ID and the credential namespace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderConfig {
    #[serde(default)]
    pub chat_protocol: kcoder_types::ChatProtocol,
    #[serde(default, skip_serializing_if = "ProviderAuthentication::is_api_key")]
    pub authentication: ProviderAuthentication,
    /// Environment variables accepted by this provider, in priority order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credential_env: Vec<String>,
    pub api_format: ApiFormat,
    pub endpoint: String,
    /// Default model selected when no model is requested explicitly.
    #[serde(alias = "model")]
    pub default_model: String,
    /// Explicit model catalog; empty preserves the legacy single-model profile.
    #[serde(default)]
    pub models: BTreeMap<String, ProviderModelConfig>,
    /// Override automatic model discovery for this deployment. When omitted,
    /// the global `model_discovery.enabled` setting applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discover_models: Option<bool>,
    /// Capabilities known for this explicitly configured model. Existing
    /// profiles default to the historical full-capability behavior.
    #[serde(default)]
    pub capabilities: ModelCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_policy: Option<kcoder_types::ModelReasoningPolicy>,
    #[serde(default)]
    pub context_window_tokens: usize,
    /// Optional model-visible message token count that starts automatic compaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_threshold_tokens: Option<usize>,
    #[serde(default)]
    pub output_headroom_tokens: usize,
    #[serde(default)]
    pub max_output_tokens: u32,
    /// Connection-establishment timeout for streaming model requests.
    ///
    /// Streaming response bodies have no wall-clock total timeout; they are
    /// guarded separately by a per-event idle watchdog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_timeout_secs: Option<u64>,
    /// Optional HTTP user agent for OpenAI-compatible providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// Optional request retry count for this deployment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<usize>,
    /// Optional initial retry backoff for this deployment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_base_delay_ms: Option<u64>,
    /// Ignore process proxy variables for this endpoint (useful for local/private services).
    #[serde(default)]
    pub no_proxy: bool,
    /// Provider-specific request fields such as temperature, top_p, or thinking options.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra_body: serde_json::Map<String, serde_json::Value>,
}

/// Model features that are safe for the runtime to use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelCapabilities {
    #[serde(default = "default_true")]
    pub text: bool,
    #[serde(default = "default_true")]
    pub tools: bool,
    #[serde(default = "default_true")]
    pub vision: bool,
    #[serde(default = "default_true")]
    pub reasoning: bool,
    #[serde(default = "default_true")]
    pub structured_output: bool,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            text: true,
            tools: true,
            vision: true,
            reasoning: true,
            structured_output: true,
        }
    }
}

impl ModelCapabilities {
    pub fn text_only() -> Self {
        Self {
            text: true,
            tools: false,
            vision: false,
            reasoning: false,
            structured_output: false,
        }
    }
}

/// Lazy provider model-list discovery used by `/model`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelDiscoverySettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_model_discovery_timeout_secs")]
    pub request_timeout_secs: u64,
    #[serde(default = "default_model_discovery_cache_ttl_secs")]
    pub cache_ttl_secs: u64,
    #[serde(default = "default_model_discovery_max_models")]
    pub max_models_per_provider: usize,
}

/// Persisted selection for an automatically discovered model. The source
/// provider supplies transport, authentication, and full model capabilities.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveModelSelection {
    pub source_profile: String,
    pub model: String,
}

impl Default for ModelDiscoverySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            request_timeout_secs: default_model_discovery_timeout_secs(),
            cache_ttl_secs: default_model_discovery_cache_ttl_secs(),
            max_models_per_provider: default_model_discovery_max_models(),
        }
    }
}

pub(crate) fn default_model_discovery_timeout_secs() -> u64 {
    8
}

pub(crate) fn default_model_discovery_cache_ttl_secs() -> u64 {
    300
}

pub(crate) fn default_model_discovery_max_models() -> usize {
    200
}
