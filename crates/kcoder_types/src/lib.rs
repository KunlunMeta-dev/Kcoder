mod cron_schedule;
pub use cron_schedule::CronSchedule;
mod model_configuration;
pub use model_configuration::{ModelConfigurationBoundary, ModelConfigurationSummary};
mod turn_attempt;
pub use turn_attempt::{TurnAttemptIdentity, TurnAttemptStatus};
mod model_selection_intent;
pub use model_selection_intent::{ModelSelectionMode, RetryModelConfiguration};
mod background_identity;
pub use background_identity::{BackgroundEventIdentity, BackgroundRunKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

mod provider_error_summary;
mod provider_failure;
mod shared_messages;
mod user_message_semantics;
pub use provider_error_summary::{
    PROVIDER_ERROR_SUMMARY_MAX_BYTES, ProviderErrorSummary, provider_error_summary,
    safe_provider_error_type,
};
pub use provider_failure::{
    ProviderFailureCategory, ProviderFailureDetails, ProviderFailureRecoveryAction,
};
pub use shared_messages::SharedMessages;
#[allow(deprecated)]
pub use user_message_semantics::{
    REAL_USER_MESSAGE_SEMANTICS_VERSION, is_hidden_runtime_user_text, is_real_user_message,
    is_synthetic_parent_text,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ResponseJsonSchema {
    pub name: String,
    pub description: Option<String>,
    pub schema: serde_json::Value,
    pub strict: bool,
}

impl ResponseJsonSchema {
    pub fn new(name: impl Into<String>, schema: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            description: None,
            schema,
            strict: true,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }
}

/// Configuration for a single MCP server.
///
/// The type lives in `kcoder_types` so config loading, CLI setup, and MCP
/// connection code can share the same contract without depending on each
/// other's implementation crates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Display name for this server.
    pub name: String,
    /// Transport type: `"stdio"`, `"sse"` for legacy dual-endpoint HTTP+SSE,
    /// or `"http"` for single-endpoint Streamable HTTP.
    #[serde(default = "default_mcp_transport")]
    pub transport: String,
    /// Command to execute for stdio transport.
    #[serde(default)]
    pub command: String,
    /// Arguments for the command.
    #[serde(default)]
    pub args: Vec<String>,
    /// Endpoint URL for `sse` or `http` transport, such as
    /// `http://localhost:3001/sse` or `https://example.com/mcp`.
    #[serde(default)]
    pub url: String,
    /// Additional environment variables.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Additional request headers for `http` transport, such as `Authorization`.
    /// Values are literal plaintext from settings without environment expansion;
    /// protect configuration-file permissions when they contain secrets.
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

fn default_mcp_transport() -> String {
    "stdio".to_string()
}

/// Provenance is local history metadata, never provider protocol or text inference.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageOrigin {
    #[default]
    Unknown,
    User,
    Runtime,
    Compaction,
}

impl MessageOrigin {
    pub fn is_unknown(&self) -> bool {
        *self == Self::Unknown
    }
}

/// A single conversation message in Anthropic-compatible format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "role")]
pub enum Message {
    User {
        content: Vec<ContentBlock>,
        #[serde(default, skip_serializing_if = "MessageOrigin::is_unknown")]
        origin: MessageOrigin,
    },
    Assistant {
        content: Vec<ContentBlock>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
}

impl Message {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self::User {
            content: vec![ContentBlock::Text { text: text.into() }],
            origin: MessageOrigin::User,
        }
    }

    pub fn user_content(content: Vec<ContentBlock>) -> Self {
        Self::User {
            content,
            origin: MessageOrigin::User,
        }
    }

    pub fn with_origin(mut self, origin: MessageOrigin) -> Self {
        if let Self::User { origin: stored, .. } = &mut self {
            *stored = origin;
        }
        self
    }

    pub fn origin(&self) -> MessageOrigin {
        match self {
            Self::User { origin, .. } => *origin,
            _ => MessageOrigin::Unknown,
        }
    }

    pub fn runtime_text(text: impl Into<String>) -> Self {
        Self::user_text(text).with_origin(MessageOrigin::Runtime)
    }

    pub fn compaction_text(text: impl Into<String>) -> Self {
        Self::user_text(text).with_origin(MessageOrigin::Compaction)
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self::Assistant {
            content: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
        }
    }

    pub fn role(&self) -> MessageRole {
        match self {
            Message::User { .. } => MessageRole::User,
            Message::Assistant { .. } => MessageRole::Assistant,
        }
    }

    /// Extract a plain-text preview from the message content.
    pub fn preview(&self, max_len: usize) -> String {
        let text = self.all_text();
        if text.chars().count() <= max_len {
            text
        } else {
            text.chars().take(max_len).collect::<String>() + "…"
        }
    }

    fn all_text(&self) -> String {
        let blocks = match self {
            Message::User { content, .. } => content,
            Message::Assistant { content, .. } => content,
        };
        let mut out = String::new();
        for block in blocks {
            match block {
                ContentBlock::Text { text } => out.push_str(text),
                ContentBlock::ToolUse { name, input, .. } => {
                    out.push_str(&format!("[tool: {} {}]", name, input));
                }
                ContentBlock::ToolResult { content, .. } => {
                    out.push_str(
                        &content
                            .iter()
                            .filter_map(|b| match b {
                                ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<String>(),
                    );
                }
                ContentBlock::Image { source } => {
                    out.push_str(&format!("[image: {}]", source.media_type));
                }
                ContentBlock::Thinking { thinking, .. } => out.push_str(thinking),
                ContentBlock::RedactedThinking { .. } => out.push_str("[redacted thinking]"),
            }
        }
        out
    }
}

/// Content block types supported in messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Vec<ContentBlock>,
        is_error: Option<bool>,
    },
    Image {
        source: ImageSource,
    },
    /// Provider-supplied thinking summary/content block. The provider adapter
    /// must not infer this value from ordinary text or Markdown.
    Thinking {
        thinking: String,
        #[serde(default)]
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub media_type: String,
    pub data: String,
}

impl ImageSource {
    pub fn base64(media_type: impl Into<String>, data: impl Into<String>) -> Self {
        Self {
            source_type: "base64".to_string(),
            media_type: media_type.into(),
            data: data.into(),
        }
    }
}

/// Tool definition for the Anthropic Messages API.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Model reasoning effort used by OpenAI-compatible reasoning models.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Custom(String),
}

impl ReasoningEffort {
    pub fn as_str(&self) -> &str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Custom(value) => value.as_str(),
        }
    }
}

impl fmt::Display for ReasoningEffort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningEffortParseError;

impl fmt::Display for ReasoningEffortParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("reasoning effort cannot be empty")
    }
}

impl std::error::Error for ReasoningEffortParseError {}

impl FromStr for ReasoningEffort {
    type Err = ReasoningEffortParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(ReasoningEffortParseError);
        }
        Ok(match trimmed.to_ascii_lowercase().as_str() {
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::XHigh,
            _ => Self::Custom(trimmed.to_string()),
        })
    }
}

impl Serialize for ReasoningEffort {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReasoningEffort {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

/// Anthropic API request body for the messages endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct MessagesRequest {
    /// Local-only transport ordering hint; never part of the provider payload.
    #[serde(skip)]
    pub path_first_tools: bool,
    pub model: String,
    pub max_tokens: u32,
    pub messages: SharedMessages,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    /// Provider-specific reasoning effort. This is intentionally skipped for
    /// the Anthropic-shaped base request and added only by compatible providers.
    #[serde(skip)]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// Suppress optional reasoning for this logical request only, after native overrides.
    #[serde(skip)]
    pub recovery_disable_reasoning: bool,
    /// Optional JSON schema for providers that support native structured
    /// outputs. Skipped in the Anthropic-shaped base request and mapped by
    /// compatible provider adapters.
    #[serde(skip)]
    pub response_json_schema: Option<ResponseJsonSchema>,
    /// Local-only session id used for developer debug logs. This must never be
    /// serialized into provider requests.
    #[serde(skip)]
    pub debug_session_id: Option<String>,
    /// Agent depth for a Slime training request. Providers map it only to a transport
    /// header; it must not enter the model request body or context.
    #[serde(skip)]
    pub trajectory_agent_depth: Option<u32>,
}

impl MessagesRequest {
    pub fn new(model: impl Into<String>, messages: Vec<Message>) -> Self {
        Self::new_shared(model, messages.into())
    }

    pub fn new_shared(model: impl Into<String>, messages: SharedMessages) -> Self {
        Self {
            model: model.into(),
            path_first_tools: false,
            max_tokens: 4096,
            messages,
            stream: true,
            system: None,
            tools: Vec::new(),
            reasoning_effort: None,
            recovery_disable_reasoning: false,
            response_json_schema: None,
            debug_session_id: None,
            trajectory_agent_depth: None,
        }
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn with_path_first_tools(mut self, enabled: bool) -> Self {
        self.path_first_tools = enabled;
        self
    }

    pub fn with_tools(mut self, tools: Vec<ToolDefinition>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    pub fn with_reasoning_effort(mut self, effort: Option<ReasoningEffort>) -> Self {
        self.reasoning_effort = effort;
        self
    }

    pub fn with_response_json_schema(mut self, schema: ResponseJsonSchema) -> Self {
        self.response_json_schema = Some(schema);
        self
    }

    pub fn with_debug_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.debug_session_id = Some(session_id.into());
        self
    }

    pub fn with_trajectory_agent_depth(mut self, depth: u32) -> Self {
        self.trajectory_agent_depth = Some(depth);
        self
    }
}

/// Streaming event kinds emitted by the Anthropic Messages API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum StreamEvent {
    MessageStart {
        message: StreamingMessage,
    },
    ContentBlockStart {
        index: usize,
        content_block: ContentBlock,
    },
    ContentBlockDelta {
        index: usize,
        delta: ContentDelta,
    },
    ContentBlockStop {
        index: usize,
    },
    MessageDelta {
        delta: MessageDeltaFields,
    },
    MessageStop,
    Ping,
    Error {
        error: ApiError,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamingMessage {
    pub id: String,
    pub role: String,
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ContentDelta {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        thinking: String,
    },
    SignatureDelta {
        signature: String,
    },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta {
        partial_json: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDeltaFields {
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    pub usage: Option<Usage>,
}

mod provider_authentication;
pub mod tool_ui;
pub mod usage_history;
pub use provider_authentication::ProviderAuthentication;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Complete context-token total reported by the provider. Cached input for
    /// OpenAI/Gemini is already included in input/total; callers should prefer this
    /// field to avoid double counting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<Vec<UsageIteration>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageIteration {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

impl Usage {
    /// Merge cumulative streaming updates from one provider attempt, never separate requests.
    pub fn merge_stream_update(&mut self, update: &Self) {
        self.input_tokens = self.input_tokens.max(update.input_tokens);
        self.output_tokens = self.output_tokens.max(update.output_tokens);
        self.total_tokens = self.total_tokens.max(update.total_tokens);
        self.cache_creation_input_tokens = self
            .cache_creation_input_tokens
            .max(update.cache_creation_input_tokens);
        self.cache_read_input_tokens = self
            .cache_read_input_tokens
            .max(update.cache_read_input_tokens);
        if update.iterations.is_some() {
            self.iterations = update.iterations.clone();
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ApiError {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}

/// A rendered message for display in the UI.
#[derive(Debug, Clone)]
pub struct DisplayMessage {
    pub role: MessageRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

/// Sandbox configuration controlling filesystem and command restrictions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    /// When true, sandbox restrictions are enforced. On Windows, shell
    /// processes use an unelevated restricted-token backend. It blocks ordinary
    /// writes outside capability roots, but is not a strict boundary for
    /// pre-existing objects whose ACL grants write access to Everyone.
    #[serde(default)]
    pub enabled: bool,
    /// When true, all write operations are denied regardless of path.
    #[serde(default)]
    pub readonly: bool,
    /// Paths outside the working directory that are allowed to be accessed.
    /// Paths may be absolute or relative to the working directory.
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    /// Paths that are always denied. Takes precedence over allowed_paths.
    #[serde(default)]
    pub denied_paths: Vec<String>,
    /// Allow shell tools to retry once without the sandbox after a sandbox
    /// policy denial and a second permission approval.
    #[serde(default)]
    pub allow_shell_escalation: bool,
    /// Require a second permission approval before running an escalated shell
    /// command. This is enabled by default when escalation is enabled.
    #[serde(default = "default_require_shell_escalation_approval")]
    pub require_shell_escalation_approval: bool,
    /// Maximum number of escalated shell attempts after the initial sandboxed
    /// attempt. 0 means the escalation chain is exhausted.
    #[serde(default = "default_shell_escalation_max_attempts")]
    pub shell_escalation_max_attempts: usize,
    /// Allow shell writes to the system temporary directory. When disabled, only the
    /// workspace and `allowed_paths` are writable; test frameworks should use an isolated TMPDIR.
    #[serde(default = "default_allow_system_temp_writes")]
    pub allow_system_temp_writes: bool,
    /// Allow shell writes to user development caches such as `.cache`, `.cargo`, and
    /// `.npm`. Benchmarks and independent verifiers should disable this to prevent concurrent tasks from contaminating shared state.
    #[serde(default = "default_allow_shared_dev_cache_writes")]
    pub allow_shared_dev_cache_writes: bool,
    /// Linux Landlock filesystem confinement for spawned shell processes:
    /// `true` forces it on (spawn fails if the kernel lacks Landlock), `false`
    /// disables it, and `None` (default) enables it when the kernel supports it.
    /// This option is Linux-only; Windows uses its native restricted-token
    /// backend whenever the sandbox is enabled.
    /// Reads stay unrestricted; writes are confined to the working directory,
    /// allowed paths, /tmp, /dev pseudo-files and common dev caches.
    #[serde(default)]
    pub landlock: Option<bool>,
}

fn default_require_shell_escalation_approval() -> bool {
    true
}

fn default_shell_escalation_max_attempts() -> usize {
    1
}

fn default_allow_system_temp_writes() -> bool {
    true
}

fn default_allow_shared_dev_cache_writes() -> bool {
    true
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            readonly: false,
            allowed_paths: Vec::new(),
            denied_paths: Vec::new(),
            allow_shell_escalation: false,
            require_shell_escalation_approval: default_require_shell_escalation_approval(),
            shell_escalation_max_attempts: default_shell_escalation_max_attempts(),
            allow_system_temp_writes: default_allow_system_temp_writes(),
            allow_shared_dev_cache_writes: default_allow_shared_dev_cache_writes(),
            landlock: None,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn path_first_tools_is_default_off_and_local_only() {
        let request = super::MessagesRequest::new("model", vec![]);
        assert!(!request.path_first_tools);
        let original = serde_json::to_string(&request).unwrap();
        let enabled = request.with_path_first_tools(true);
        assert!(enabled.path_first_tools);
        assert_eq!(original, serde_json::to_string(&enabled).unwrap());
        assert!(enabled.clone().path_first_tools);
    }
    use super::*;

    #[test]
    fn reasoning_effort_parses_known_and_custom_values() {
        assert_eq!(
            "high".parse::<ReasoningEffort>().unwrap(),
            ReasoningEffort::High
        );
        assert_eq!(
            "XHIGH".parse::<ReasoningEffort>().unwrap(),
            ReasoningEffort::XHigh
        );
        assert_eq!(
            "custom-max".parse::<ReasoningEffort>().unwrap(),
            ReasoningEffort::Custom("custom-max".to_string())
        );
        assert!(" ".parse::<ReasoningEffort>().is_err());
    }

    #[test]
    fn reasoning_effort_serializes_as_string() {
        let json = serde_json::to_value(ReasoningEffort::XHigh).unwrap();
        assert_eq!(json, serde_json::json!("xhigh"));
        let parsed: ReasoningEffort = serde_json::from_value(serde_json::json!("minimal")).unwrap();
        assert_eq!(parsed, ReasoningEffort::Minimal);
    }

    #[test]
    fn messages_request_skips_reasoning_effort_in_base_serialization() {
        let request = MessagesRequest::new("test-model", vec![])
            .with_reasoning_effort(Some(ReasoningEffort::High));
        let json = serde_json::to_value(request).unwrap();
        assert!(json.get("reasoning_effort").is_none());
    }

    #[test]
    fn messages_request_keeps_training_agent_depth_out_of_body() {
        let request = MessagesRequest::new("test-model", vec![]).with_trajectory_agent_depth(1);
        let json = serde_json::to_value(&request).unwrap();

        assert_eq!(request.trajectory_agent_depth, Some(1));
        assert!(json.get("trajectory_agent_depth").is_none());
    }
}

/// Explicit Chat Completions dialect. Auto only recognizes official endpoints.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatProtocol {
    #[default]
    Auto,
    Standard,
    Minimax,
}

mod reasoning_policy;
pub use reasoning_policy::{ModelReasoningPolicy, ReasoningControlMode};
