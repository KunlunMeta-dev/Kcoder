//! Memory configuration types and their defaults.

use crate::*;

/// How automatic memory observer drafts are produced.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryObserverMode {
    Disabled,
    #[default]
    Deterministic,
    Model,
}

impl MemoryObserverMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "disabled" | "off" | "false" => Some(Self::Disabled),
            "deterministic" | "sync" | "default" => Some(Self::Deterministic),
            "model" | "llm" => Some(Self::Model),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Deterministic => "deterministic",
            Self::Model => "model",
        }
    }
}

/// Structured long-term memory settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemorySettings {
    /// Whether the structured SQLite memory layer is active.
    #[serde(default = "default_memory_structured_enabled")]
    pub structured_enabled: bool,
    /// Tool names skipped by automatic tool-event memory observation.
    #[serde(default)]
    pub skip_tools: Vec<String>,
    /// Whether legacy JSON/markdown memories are included in prompt fallback.
    #[serde(default = "default_memory_legacy_prompt_enabled")]
    pub legacy_prompt_enabled: bool,
    /// Whether automatic persistence uses minimized prompt/source metadata.
    #[serde(default)]
    pub private_by_default: bool,
    /// Whether automatic file-change observations omit file path details.
    #[serde(default)]
    pub private_file_paths: bool,
    /// Whether verification target recovery observations omit target details.
    #[serde(default)]
    pub private_verification_targets: bool,
    /// Whether private prompt rows store placeholder metadata instead of being skipped.
    #[serde(default = "default_memory_record_prompt_placeholders")]
    pub record_prompt_placeholders: bool,
    /// How automatic observer drafts are generated.
    #[serde(default)]
    pub observer_mode: MemoryObserverMode,
    /// Bounded observer queue capacity for future async/model observers.
    #[serde(default = "default_memory_observer_queue_size")]
    pub observer_queue_size: usize,
    /// Optional model name used when observer_mode is `model`.
    #[serde(default)]
    pub observer_model: Option<String>,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            structured_enabled: default_memory_structured_enabled(),
            skip_tools: Vec::new(),
            legacy_prompt_enabled: default_memory_legacy_prompt_enabled(),
            private_by_default: false,
            private_file_paths: false,
            private_verification_targets: false,
            record_prompt_placeholders: default_memory_record_prompt_placeholders(),
            observer_mode: MemoryObserverMode::default(),
            observer_queue_size: default_memory_observer_queue_size(),
            observer_model: None,
        }
    }
}

/// Per-session memory used as the preferred source for context
/// compaction. It is distinct from long-term memory: this is a compact,
/// continually refreshed summary of the current session only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionMemorySettings {
    /// Master switch for session-memory maintenance and compact.
    #[serde(default = "default_session_memory_enabled")]
    pub enabled: bool,
    /// Whether completed turns refresh the session-memory snapshot.
    #[serde(default = "default_session_memory_update_enabled")]
    pub update_enabled: bool,
    /// Whether full compaction should prefer the session-memory snapshot.
    #[serde(default = "default_session_memory_compact_enabled")]
    pub compact_enabled: bool,
    /// Refresh session memory every N completed model turns.
    #[serde(default = "default_session_memory_update_interval_turns")]
    pub update_interval_turns: usize,
    /// Initialize session memory only after the visible context reaches this size.
    #[serde(default = "default_session_memory_init_min_tokens")]
    pub init_min_tokens: usize,
    /// Refresh an existing session memory after this many additional tokens.
    #[serde(default = "default_session_memory_update_min_token_delta")]
    pub update_min_token_delta: usize,
    /// Refresh at the next eligible boundary after this many tool calls in a turn.
    #[serde(default = "default_session_memory_tool_call_threshold")]
    pub tool_call_threshold: usize,
    /// Number of most recent model messages included in the refresh prompt.
    #[serde(default = "default_session_memory_max_update_messages")]
    pub max_update_messages: usize,
    /// Max tokens emitted by the session-memory update model call.
    #[serde(default = "default_session_memory_update_max_tokens")]
    pub update_max_tokens: u32,
    /// Minimum usable session-memory size before it can replace old history.
    #[serde(default = "default_session_memory_compact_min_chars")]
    pub compact_min_chars: usize,
    /// Try to preserve at least this many recent tokens after session-memory compact.
    #[serde(default = "default_session_memory_compact_min_recent_tokens")]
    pub compact_min_recent_tokens: usize,
    /// Do not intentionally preserve more than this many recent tokens.
    #[serde(default = "default_session_memory_compact_max_recent_tokens")]
    pub compact_max_recent_tokens: usize,
    /// Preserve at least this many recent user/assistant text messages when possible.
    #[serde(default = "default_session_memory_compact_min_recent_messages")]
    pub compact_min_recent_messages: usize,
}

impl Default for SessionMemorySettings {
    fn default() -> Self {
        Self {
            enabled: default_session_memory_enabled(),
            update_enabled: default_session_memory_update_enabled(),
            compact_enabled: default_session_memory_compact_enabled(),
            update_interval_turns: default_session_memory_update_interval_turns(),
            init_min_tokens: default_session_memory_init_min_tokens(),
            update_min_token_delta: default_session_memory_update_min_token_delta(),
            tool_call_threshold: default_session_memory_tool_call_threshold(),
            max_update_messages: default_session_memory_max_update_messages(),
            update_max_tokens: default_session_memory_update_max_tokens(),
            compact_min_chars: default_session_memory_compact_min_chars(),
            compact_min_recent_tokens: default_session_memory_compact_min_recent_tokens(),
            compact_max_recent_tokens: default_session_memory_compact_max_recent_tokens(),
            compact_min_recent_messages: default_session_memory_compact_min_recent_messages(),
        }
    }
}
