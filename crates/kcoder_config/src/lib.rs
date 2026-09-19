use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tracing::warn;

pub const MAX_CONCURRENT_SUBAGENTS: usize = 4;
pub const DEFAULT_SUBAGENT_MAX_TURNS: usize = 60;
pub const MIN_SUBAGENT_MAX_TURNS: usize = DEFAULT_SUBAGENT_MAX_TURNS;
pub const MAX_SUBAGENT_MAX_TURNS: usize = 180;
pub const CURRENT_CONFIG_VERSION: u64 = 1;
pub use kcoder_types::ProviderAuthentication;
pub const DEFAULT_AUTO_COMPACT_SMALL_WINDOW_PERCENT: usize = 95;
pub const DEFAULT_AUTO_COMPACT_MEDIUM_WINDOW_PERCENT: usize = 85;
pub const DEFAULT_AUTO_COMPACT_LARGE_WINDOW_PERCENT: usize = 75;

/// Default hard-input budget ratio derived from the model context window when no automatic compaction threshold is configured.
pub fn default_auto_compact_percentage(context_window_tokens: usize) -> usize {
    if context_window_tokens <= 256_000 {
        DEFAULT_AUTO_COMPACT_SMALL_WINDOW_PERCENT
    } else if context_window_tokens <= 512_000 {
        DEFAULT_AUTO_COMPACT_MEDIUM_WINDOW_PERCENT
    } else {
        DEFAULT_AUTO_COMPACT_LARGE_WINDOW_PERCENT
    }
}

mod compatibility;
mod credential_store;
pub(crate) use compatibility::normalize_legacy_profile_references;
pub use compatibility::normalize_legacy_settings_document;
pub use credential_store::{
    CredentialBackend, CredentialStoreMode, MigrationDirection, MigrationReport,
    OsCredentialBackend, marker_for_provider, migrate_stored_credentials, provider_from_marker,
    resolve_stored_credentials,
};
mod deployment;
pub mod provider_templates;
mod schema;
#[allow(deprecated)]
pub use deployment::{
    DEFAULT_ACTIVE_PROVIDER, DEFAULT_ANTHROPIC_ENDPOINT, DEFAULT_GEMINI_ENDPOINT,
    DEFAULT_GROK_ENDPOINT, DEFAULT_KUNLUNMETA_ENDPOINT, DEFAULT_LOCAL_ENDPOINT, DEFAULT_MODEL,
    DEFAULT_OPENAI_ENDPOINT, DEFAULT_REQUEST_TIMEOUT_SECS, apply_managed_deployment_settings,
    default_active_provider_config, default_active_provider_name, default_deployment_settings,
    default_endpoint_for_provider, default_goal_pro_completion_rejection_limit,
    default_goal_pro_model_escalation_threshold, default_goal_pro_verification_settings,
    default_goal_pro_verifier_max_turns, default_model_name, default_provider_endpoint,
    default_providers, default_settings_document, merge_default_deployment_settings,
    migrate_deployment_settings,
};
pub use schema::ensure_user_settings_schema;
mod dotenv;
mod endpoint_security;
mod turn_file_changes;
pub use endpoint_security::is_plaintext_remote_endpoint;
pub use turn_file_changes::{
    DEFAULT_TURN_FILE_CHANGES_MAX_FILE_BYTES, DEFAULT_TURN_FILE_CHANGES_MAX_TOTAL_BYTES,
    DEFAULT_TURN_FILE_CHANGES_RETENTION_DAYS, TurnFileChangesSettings,
};
mod file_permissions;
mod private_files;
mod private_temp_dir;
pub use dotenv::looks_like_credential_env_key;
pub use dotenv::{
    DEFAULT_USER_DOTENV, USER_DOTENV_FILENAME, ensure_default_user_dotenv, user_dotenv_path,
    write_user_dotenv_if_missing,
};
mod loader;
pub use loader::{
    CONFIG_DIR_ENV, ConfigPaths, ConfigScope, ConfigSource, CredentialStore, KCODER_HOME_ENV,
    LoadedSettings, SettingsLoader, dotted_value, ensure_project_gitignore,
    merge_settings_documents, read_scope, read_settings_file, remove_dotted_value,
    set_dotted_value, update_scope, update_settings_file, user_config_dir,
    validate_and_resolve_settings_document, write_scope, write_scope_if_missing,
};
mod project_instructions;
mod trusted_folders;
#[cfg(windows)]
pub use file_permissions::set_and_verify_windows_user_only_handle;
pub use file_permissions::{
    is_user_only_file, set_user_only_dir_permissions, set_user_only_file_permissions,
};
pub use private_files::PrivateDirectory;
pub use private_temp_dir::{PrivateTempDir, create_private_temp_dir};
pub use project_instructions::{
    build_project_md_system_prompt, discover_project_md, load_project_md_contents,
};
pub use trusted_folders::{FolderTrust, FolderTrustStore};
mod provider_credentials;
pub use provider_credentials::{
    ProviderCredential, builtin_credential_env, builtin_provider_credentials, validate_provider_id,
};

pub use kcoder_types::{McpServerConfig, ReasoningEffort, SandboxConfig};

/// User-facing permission mode.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    #[default]
    Ask,
    Auto,
    AcceptEdits,
    DontAsk,
    Bypass,
    /// Yolo mode: allow tools without prompting and suppress user elicitation.
    Yolo,
}

/// Settings-level TDD gate override. `auto` keeps the default resolution
/// (env var, then project/review.md Execution Mode); the other values force
/// the gate off entirely, warn-only, or hard-blocking, like Luna mode's
/// blanket exemption but configurable.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TddGateSetting {
    #[default]
    Auto,
    Off,
    Preferred,
    Required,
}

impl PermissionMode {
    /// Parse a permission mode from its snake-case or kebab-case name.
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "ask" => Some(PermissionMode::Ask),
            "auto" => Some(PermissionMode::Auto),
            "accept-edits" | "accept_edits" => Some(PermissionMode::AcceptEdits),
            "dont-ask" | "dont_ask" => Some(PermissionMode::DontAsk),
            "bypass" => Some(PermissionMode::Bypass),
            "yolo" => Some(PermissionMode::Yolo),
            _ => None,
        }
    }

    /// Whether this mode must avoid interactive approval prompts.
    ///
    /// Explicit deny rules still apply, but the engine should not ask the user
    /// to approve tools or sandbox escalation in these modes.
    pub fn bypasses_prompts(self) -> bool {
        matches!(self, PermissionMode::Bypass | PermissionMode::Yolo)
    }

    /// Whether this mode is intended to avoid user-facing elicitation entirely.
    ///
    /// Unlike `bypass`, `yolo` is used by wrappers for unattended automation,
    /// so model-visible tools that ask the user should be hidden or rejected.
    pub fn suppresses_user_elicitation(self) -> bool {
        matches!(self, PermissionMode::Yolo)
    }
}

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

/// Controls whether the interactive TUI uses the terminal's alternate screen
/// buffer or draws in the legacy inline terminal mode.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TuiAltScreenMode {
    /// Select alternate screen mode automatically.
    #[default]
    Auto,
    /// Always use alternate screen mode.
    Always,
    /// Never use alternate screen; use the legacy inline terminal mode.
    Never,
}

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

mod provider_models;
pub use provider_models::ProviderModelConfig;

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

fn default_model_discovery_timeout_secs() -> u64 {
    8
}

fn default_model_discovery_cache_ttl_secs() -> u64 {
    300
}

fn default_model_discovery_max_models() -> usize {
    200
}

/// Interactive terminal UI settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TuiSettings {
    /// Ephemeral path hints while tool arguments are streamed.
    #[serde(default)]
    pub path_preview: TuiPathPreviewSettings,
    /// Codex-compatible alternate screen setting.
    #[serde(default)]
    pub alternate_screen: TuiAltScreenMode,
    /// Session-only CLI override for `--no-alt-screen`.
    #[serde(skip)]
    pub no_alt_screen: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TuiPathPreviewSettings {
    #[serde(default)]
    pub enabled: bool,
}

/// A persisted permission rule with optional input pattern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionRule {
    /// Tool name or glob pattern (e.g. "bash" or "file:*").
    pub tool: String,
    /// Optional input condition. `field=value` limits matching to one JSON
    /// field; otherwise scalar JSON values are searched for the text. For an
    /// Allow rule targeting Bash or PowerShell, the condition must match the
    /// complete `command` string exactly, or cover every constituent command
    /// (tree-sitter split) as a glob; this prevents an allowed prefix from
    /// authorizing appended pipelines, redirects, or chained commands.
    #[serde(default)]
    pub input_pattern: Option<String>,
    /// Decision for this rule.
    pub action: PermissionAction,
}

/// Which file-edit tool is offered to the model. Exactly one edit surface is
/// exposed at a time; the hidden one stays registered so sessions restored
/// from history keep executing. The surface is chosen before the session
/// starts and pinned when the engine is created — it cannot be switched
/// mid-session; later changes to the live `Settings` do not affect a running
/// session.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileEditSurface {
    /// Exact-string replacement tool (`edit`).
    #[default]
    Edit,
    /// Codex-style multi-file patch tool (`apply_patch`).
    ApplyPatch,
}

impl FileEditSurface {
    /// Model-visible name of the active edit tool for this surface.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::ApplyPatch => "apply_patch",
        }
    }
}

/// Tool-system settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolsSettings {
    #[serde(default)]
    pub coerce: ToolCoercionConfig,
    /// Small tool surface activated by `/luna` for less capable models.
    #[serde(default)]
    pub luna: LunaToolProfileSettings,
    /// Tool name patterns removed from the registry entirely: matching tools
    /// are never offered to the model and cannot be invoked. Supports exact
    /// names and `prefix*` globs (for example "Spec*", "memory_*").
    #[serde(default)]
    pub disabled: Vec<String>,
    /// Which file-edit tool the model sees: `"edit"` (default) or
    /// `"apply_patch"`. Selected when the session starts and pinned for the
    /// session's lifetime; both tools stay registered, and the inactive one is
    /// hidden from tool definitions and rejected at execution.
    #[serde(default)]
    pub file_edit_tool: FileEditSurface,
}

/// Tool allowlist used while the current session is in Luna mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LunaToolProfileSettings {
    #[serde(default = "default_luna_allowed_tools")]
    pub allowed: Vec<String>,
}

impl Default for LunaToolProfileSettings {
    fn default() -> Self {
        Self {
            allowed: default_luna_allowed_tools(),
        }
    }
}

fn default_luna_allowed_tools() -> Vec<String> {
    let shell = if cfg!(windows) { "PowerShell" } else { "bash" };
    [
        "glob",
        "grep",
        "read",
        "edit",
        "write",
        shell,
        "TaskOutput",
        "TaskStop",
        "skill",
        "TodoWrite",
        "spawn_agent",
        "SendMessage",
        "wait",
        "close_agent",
        "WebSearch",
        "WebFetch",
        "DiscoverSkills",
        "explore_agent",
        "ocr",
        "Workflow",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Semantic tool-input coercion settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCoercionConfig {
    #[serde(default = "default_semantic_coercion_enabled")]
    pub semantic_boolean: bool,
    #[serde(default = "default_semantic_coercion_enabled")]
    pub semantic_number: bool,
    #[serde(default = "default_semantic_coercion_enabled")]
    pub semantic_integer: bool,
    #[serde(default = "default_stringify_mismatched_scalar")]
    pub stringify_mismatched_scalar: bool,
}

impl Default for ToolCoercionConfig {
    fn default() -> Self {
        Self {
            semantic_boolean: default_semantic_coercion_enabled(),
            semantic_number: default_semantic_coercion_enabled(),
            semantic_integer: default_semantic_coercion_enabled(),
            stringify_mismatched_scalar: default_stringify_mismatched_scalar(),
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

/// Token-pressure compaction settings. Explicit absolute token thresholds keep
/// precedence; these percentages only apply when no absolute threshold exists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContextCompactionSettings {
    #[serde(default)]
    pub auto_threshold: AutoCompactThresholdSettings,
}

/// Percentage of the hard input budget used by each context-window tier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoCompactThresholdSettings {
    #[serde(default = "default_auto_compact_small_window_percent")]
    pub small_window_percent: usize,
    #[serde(default = "default_auto_compact_medium_window_percent")]
    pub medium_window_percent: usize,
    #[serde(default = "default_auto_compact_large_window_percent")]
    pub large_window_percent: usize,
}

impl AutoCompactThresholdSettings {
    pub fn percentage_for(self, context_window_tokens: usize) -> usize {
        if context_window_tokens <= 256_000 {
            self.small_window_percent
        } else if context_window_tokens <= 512_000 {
            self.medium_window_percent
        } else {
            self.large_window_percent
        }
    }
}

impl Default for AutoCompactThresholdSettings {
    fn default() -> Self {
        Self {
            small_window_percent: default_auto_compact_small_window_percent(),
            medium_window_percent: default_auto_compact_medium_window_percent(),
            large_window_percent: default_auto_compact_large_window_percent(),
        }
    }
}

/// Cold-cache context reduction applied before the first request after a long
/// idle gap. This is separate from token-pressure auto-compaction: it only
/// replaces old compactable tool-result payloads and never calls a model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeBasedMicroCompactSettings {
    /// Master switch for idle-gap micro-compaction on the main conversation.
    #[serde(default = "default_time_based_micro_compact_enabled")]
    pub enabled: bool,
    /// Minimum time since the latest assistant message before the pass runs.
    #[serde(default = "default_time_based_micro_compact_gap_minutes")]
    pub gap_threshold_minutes: u64,
    /// Number of most recent compactable tool results preserved verbatim.
    #[serde(default = "default_time_based_micro_compact_keep_recent")]
    pub keep_recent: usize,
}

impl Default for TimeBasedMicroCompactSettings {
    fn default() -> Self {
        Self {
            enabled: default_time_based_micro_compact_enabled(),
            gap_threshold_minutes: default_time_based_micro_compact_gap_minutes(),
            keep_recent: default_time_based_micro_compact_keep_recent(),
        }
    }
}

/// Plugin runtime, compatible formats, installation boundaries, and user policy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginsSettings {
    #[serde(default)]
    pub runtime: PluginRuntimeSettings,
    #[serde(default)]
    pub compatibility: PluginCompatibilitySettings,
    #[serde(default)]
    pub installation: PluginInstallationSettings,
    #[serde(default)]
    pub marketplaces: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub installed: BTreeMap<String, PluginPolicySettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRuntimeSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub project_policy: PluginProjectPolicy,
}

impl Default for PluginRuntimeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            project_policy: PluginProjectPolicy::TrustedOnly,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginProjectPolicy {
    #[default]
    TrustedOnly,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginCompatibilitySettings {
    #[serde(default = "default_true")]
    pub agent_plugins_v1: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(default = "default_true")]
    pub cursor: bool,
}

impl Default for PluginCompatibilitySettings {
    fn default() -> Self {
        Self {
            agent_plugins_v1: true,
            codex: true,
            claude: true,
            cursor: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginInstallationSettings {
    #[serde(default = "default_true")]
    pub allow_local: bool,
    #[serde(default = "default_true")]
    pub allow_git: bool,
    #[serde(default = "default_true")]
    pub allow_npm: bool,
    #[serde(default)]
    pub require_git_sha: bool,
    #[serde(default = "default_true")]
    pub require_npm_integrity: bool,
    #[serde(default = "default_plugin_max_files")]
    pub max_files: usize,
    #[serde(default = "default_plugin_max_total_bytes")]
    pub max_total_bytes: u64,
    #[serde(default = "default_plugin_max_file_bytes")]
    pub max_file_bytes: u64,
    #[serde(default = "default_plugin_install_timeout_ms")]
    pub timeout_ms: u64,
}

impl Default for PluginInstallationSettings {
    fn default() -> Self {
        Self {
            allow_local: true,
            allow_git: true,
            allow_npm: true,
            require_git_sha: false,
            require_npm_integrity: true,
            max_files: default_plugin_max_files(),
            max_total_bytes: default_plugin_max_total_bytes(),
            max_file_bytes: default_plugin_max_file_bytes(),
            timeout_ms: default_plugin_install_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginPolicySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub skills: PluginCapabilityPolicy,
    #[serde(default)]
    pub hooks: PluginCapabilityPolicy,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, PluginMcpServerPolicy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginCapabilityPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginMcpServerPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
}

fn default_plugin_max_files() -> usize {
    10_000
}

fn default_plugin_max_total_bytes() -> u64 {
    256 * 1024 * 1024
}

fn default_plugin_max_file_bytes() -> u64 {
    32 * 1024 * 1024
}

fn default_plugin_install_timeout_ms() -> u64 {
    120_000
}

/// Skill lifecycle, external directory, and safety settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillsSettings {
    #[serde(default)]
    pub auto_skill_review_enabled: bool,
    #[serde(default = "default_auto_skill_review_interval")]
    pub auto_skill_review_interval: usize,
    #[serde(default = "default_auto_curator_enabled")]
    pub auto_curator_enabled: bool,
    #[serde(default = "default_auto_curator_interval_hours")]
    pub auto_curator_interval_hours: u64,
    #[serde(default = "default_auto_curator_min_idle_hours")]
    pub auto_curator_min_idle_hours: u64,
    #[serde(default = "default_stale_after_days")]
    pub stale_after_days: u64,
    #[serde(default = "default_archive_after_days")]
    pub archive_after_days: u64,
    #[serde(default)]
    pub prune_builtins: bool,
    #[serde(default)]
    pub trust_external: bool,
    #[serde(default)]
    pub auto_lessons_learned: bool,
    #[serde(default)]
    pub external_dirs: Vec<PathBuf>,
    #[serde(default)]
    pub guard: SkillGuardSettings,
}

impl Default for SkillsSettings {
    fn default() -> Self {
        Self {
            auto_skill_review_enabled: false,
            auto_skill_review_interval: default_auto_skill_review_interval(),
            auto_curator_enabled: default_auto_curator_enabled(),
            auto_curator_interval_hours: default_auto_curator_interval_hours(),
            auto_curator_min_idle_hours: default_auto_curator_min_idle_hours(),
            stale_after_days: default_stale_after_days(),
            archive_after_days: default_archive_after_days(),
            prune_builtins: false,
            trust_external: false,
            auto_lessons_learned: false,
            external_dirs: Vec::new(),
            guard: SkillGuardSettings::default(),
        }
    }
}

/// Static safety scanner settings for skills.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillGuardSettings {
    #[serde(default = "default_skill_guard_enabled")]
    pub enabled: bool,
    #[serde(default = "default_skill_guard_block_high_risk")]
    pub block_high_risk: bool,
    #[serde(default = "default_skill_guard_block_medium_risk_for_community")]
    pub block_medium_risk_for_community: bool,
}

impl Default for SkillGuardSettings {
    fn default() -> Self {
        Self {
            enabled: default_skill_guard_enabled(),
            block_high_risk: default_skill_guard_block_high_risk(),
            block_medium_risk_for_community: default_skill_guard_block_medium_risk_for_community(),
        }
    }
}

/// Action half of a permission rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaModelConfig {
    /// Optional provider; when set, provider/model may remain `current`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default = "default_moa_provider")]
    pub provider: String,
    #[serde(default = "default_moa_model")]
    pub model: String,
}

impl MoaModelConfig {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            profile: None,
            provider: provider.into(),
            model: model.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaPresetConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_reference_models")]
    pub reference_models: Vec<MoaModelConfig>,
    #[serde(default = "default_moa_aggregator")]
    pub aggregator: MoaModelConfig,
    #[serde(default = "default_moa_reference_max_tokens")]
    pub reference_max_tokens: Option<u32>,
    #[serde(default = "default_moa_aggregator_max_tokens")]
    pub aggregator_max_tokens: Option<u32>,
}

impl Default for MoaPresetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            reference_models: default_moa_reference_models(),
            aggregator: default_moa_aggregator(),
            reference_max_tokens: default_moa_reference_max_tokens(),
            aggregator_max_tokens: default_moa_aggregator_max_tokens(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_default_preset")]
    pub default_preset: String,
    #[serde(default = "default_moa_max_reference_workers")]
    pub max_reference_workers: usize,
    #[serde(default = "default_moa_presets")]
    pub presets: BTreeMap<String, MoaPresetConfig>,
}

impl Default for MoaSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            default_preset: default_moa_default_preset(),
            max_reference_workers: default_moa_max_reference_workers(),
            presets: default_moa_presets(),
        }
    }
}

/// Independent orchestration settings for `/moa-plan`.
///
/// Model slots continue to use `moa.presets`, while turn, timeout, and
/// concurrency budgets remain separate from regular `/moa` execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaPlanSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_plan_preset")]
    pub preset: String,
    #[serde(default = "default_moa_plan_draft_max_turns")]
    pub draft_max_turns: usize,
    /// Output-token limit for each independent planner draft request.
    #[serde(default = "default_moa_plan_draft_max_tokens")]
    pub draft_max_tokens: u32,
    /// Output-token limit for the final synthesis request.
    #[serde(default = "default_moa_plan_synthesis_max_tokens")]
    pub synthesis_max_tokens: u32,
    #[serde(default = "default_moa_plan_draft_timeout_secs")]
    pub draft_timeout_secs: u64,
    #[serde(default = "default_moa_plan_max_planner_workers")]
    pub max_planner_workers: usize,
}

impl Default for MoaPlanSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            preset: default_moa_plan_preset(),
            draft_max_turns: default_moa_plan_draft_max_turns(),
            draft_max_tokens: default_moa_plan_draft_max_tokens(),
            synthesis_max_tokens: default_moa_plan_synthesis_max_tokens(),
            draft_timeout_secs: default_moa_plan_draft_timeout_secs(),
            max_planner_workers: default_moa_plan_max_planner_workers(),
        }
    }
}

/// Runtime settings loaded from disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigMetadata {
    /// Persisted schema version for the configuration family.
    #[serde(default)]
    pub config_version: u64,
}

impl Default for ConfigMetadata {
    fn default() -> Self {
        Self {
            config_version: CURRENT_CONFIG_VERSION,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecoverySettings {
    #[serde(default)]
    pub provider: ProviderRecoverySettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderRecoverySettings {
    /// Absolute budget across one logical request's attempts and compaction; unset disables it.
    #[serde(default, deserialize_with = "deserialize_provider_total_timeout_ms")]
    pub total_timeout_ms: Option<u64>,
}

fn deserialize_provider_total_timeout_ms<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|value| !(1..=86_400_000).contains(&value)) {
        return Err(serde::de::Error::custom(
            "recovery.provider.total_timeout_ms must be between 1 and 86400000 milliseconds",
        ));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Configuration-file version metadata; missing metadata is treated as v1.
    #[serde(default)]
    pub meta: ConfigMetadata,
    /// Target-side shared context injected into model requests by KCoder Studio clients.
    ///
    /// These fields affect execution and are therefore persisted in target-side
    /// settings.json; browser-profile LocalStorage is not authoritative.
    #[serde(default, skip_serializing_if = "StudioContextSettings::is_default")]
    pub studio_context: StudioContextSettings,
    /// Provider ID selected before environment and CLI overrides are applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_provider: Option<String>,
    /// User-editable providers keyed by the same IDs used in credentials.json.
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
    /// Generic credentials loaded from credentials.json, keyed by provider ID.
    #[serde(default, skip)]
    pub stored_provider_credentials: BTreeMap<String, String>,
    /// Per-process credentials loaded from an explicit --credential-env-file.
    #[serde(default, skip)]
    pub credential_overrides: BTreeMap<String, String>,
    /// Provider model-list discovery and conservative defaults for models that
    /// do not have an explicit profile.
    #[serde(default)]
    pub model_discovery: ModelDiscoverySettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_model_selection: Option<ActiveModelSelection>,
    #[serde(default = "default_model")]
    pub model: String,
    /// Optional reasoning effort sent to compatible reasoning-model providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    /// Optional provider selector used at startup when `--provider` and
    /// provider environment flags are not set.
    ///
    /// Accepted values are parsed by the CLI: `kunlunmeta`, `anthropic`,
    /// `openai`, `local`, `vllm`, `sglang`, `gemini`, and `grok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Explicit wire protocol, usually populated by the active provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<ApiFormat>,
    /// Streaming connection-establishment timeout, usually populated by the active provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_timeout_secs: Option<u64>,
    /// Whether the active profile bypasses process proxy settings.
    #[serde(default)]
    pub provider_no_proxy: bool,
    /// Ephemeral client-selected proxy for the active provider. It is never loaded from or
    /// serialized into settings files because it may contain credentials.
    #[serde(default, skip_serializing, skip_deserializing)]
    pub provider_proxy_url: Option<String>,
    /// Provider-specific request fields populated by the active profile.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub provider_extra_body: serde_json::Map<String, serde_json::Value>,
    /// Effective capabilities of the active model.
    #[serde(default)]
    pub model_capabilities: ModelCapabilities,
    /// Generic API key fallback for the selected provider.
    ///
    /// Provider-specific keys below take precedence over this field.
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    /// Generic base URL fallback for the selected provider.
    ///
    /// Provider-specific base URLs below take precedence over this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub anthropic_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_base_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub kunlunmeta_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kunlunmeta_base_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub openai_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_user_agent: Option<String>,
    #[serde(default, skip_serializing)]
    pub local_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_base_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub gemini_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_base_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub grok_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_base_url: Option<String>,
    /// Where Provider secrets are kept: the operating-system credential store,
    /// plaintext `credentials.json`, or automatic preference for the OS store.
    #[serde(default)]
    pub credential_store: CredentialStoreMode,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    /// Settings-level TDD gate override: `auto` keeps env/project resolution,
    /// `off` exempts the gate entirely (like Luna mode), `preferred` warns
    /// without blocking, and `required` hard-blocks writes without tests.
    #[serde(default)]
    pub tdd_gate: TddGateSetting,
    /// Globally allowed tool patterns persisted to disk.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Globally denied tool patterns persisted to disk.
    #[serde(default)]
    pub denied_tools: Vec<String>,
    /// Structured permission rules persisted to disk.
    #[serde(default)]
    pub permission_rules: Vec<PermissionRule>,
    /// Process-level operating mode for the training harness. This value is set
    /// only by the CLI and is not persisted. It disables background provider
    /// requests unrelated to task execution while retaining explicit agent branches.
    #[serde(skip)]
    pub training_mode: bool,
    /// Whether automatic memory extraction runs after turns.
    #[serde(default = "default_auto_memory_enabled")]
    pub auto_memory_enabled: bool,
    /// Whether automatic tool-event observations are written to memory.
    #[serde(default = "default_auto_tool_memory_enabled")]
    pub auto_tool_memory_enabled: bool,
    /// Whether persistent `/goal` objectives and model goal tools are enabled.
    #[serde(default = "default_goal_enabled")]
    pub goal_enabled: bool,
    /// Maximum automatic continuations for one goal in each foreground, headless, or daemon process.
    #[serde(default = "default_goal_max_auto_continuations")]
    pub goal_max_auto_continuations: usize,
    /// Provider/model selection for an independent `/goal-pro` verifier.
    #[serde(default)]
    pub goal_pro: GoalProSettings,
    /// Session-level orchestration policy, persisted injection, and persona routing.
    #[serde(default)]
    pub orchestrate: OrchestrateSettings,
    /// Whether background skill review may update `.kcoder/skills` after
    /// completed turns. This is a session-only flag set by the CLI
    /// `--skill-review` startup mode; it is intentionally not persisted.
    #[serde(skip)]
    pub auto_skill_review_enabled: bool,
    /// Number of tool iterations between background skill-review passes.
    #[serde(default = "default_auto_skill_review_interval")]
    pub auto_skill_review_interval: usize,
    /// Skill lifecycle, external directory, and safety settings.
    #[serde(default)]
    pub skills: SkillsSettings,
    /// Plugin-format compatibility, installation limits, and user enablement policy.
    #[serde(default)]
    pub plugins: PluginsSettings,
    /// Optional override for the memory directory.
    #[serde(default)]
    pub memory_directory: Option<PathBuf>,
    /// Structured long-term memory settings.
    #[serde(default)]
    pub memory: MemorySettings,
    /// Per-session memory settings used for preferred compaction.
    #[serde(default)]
    pub session_memory: SessionMemorySettings,
    /// Token-pressure automatic compaction thresholds.
    #[serde(default)]
    pub context_compaction: ContextCompactionSettings,
    /// Time-aware cold-cache cleanup for stale tool results.
    #[serde(default)]
    pub time_based_micro_compact: TimeBasedMicroCompactSettings,
    /// Turn file-change snapshot policy (bounds what each turn stores).
    #[serde(default)]
    pub turn_file_changes: TurnFileChangesSettings,
    /// Whether conversation history is persisted and searchable.
    #[serde(default = "default_history_enabled")]
    pub history_enabled: bool,
    /// Maximum number of messages to keep in the in-memory history buffer.
    #[serde(default = "default_history_max_messages")]
    pub history_max_messages: usize,
    /// Optional override for the history directory.
    #[serde(default)]
    pub history_directory: Option<PathBuf>,
    /// Whether to render assistant output as Markdown in the TUI.
    #[serde(default = "default_render_markdown")]
    pub render_markdown: bool,
    /// Whether to render Markdown in headless/terminal output.
    #[serde(default)]
    pub rich_terminal: bool,
    /// Interactive terminal UI settings.
    #[serde(default)]
    pub tui: TuiSettings,
    /// Syntax highlighting theme for code blocks.
    #[serde(default = "default_code_theme")]
    pub code_theme: String,
    /// Optional override for the model's effective context window (in tokens).
    #[serde(default)]
    pub context_window_tokens: Option<usize>,
    /// Optional override for reserved system-prompt tokens.
    #[serde(default)]
    pub context_system_tokens: Option<usize>,
    /// Optional override for reserved tool-definition tokens.
    #[serde(default)]
    pub context_tools_tokens: Option<usize>,
    /// Optional override for output headroom tokens.
    #[serde(default)]
    pub context_output_headroom: Option<usize>,
    /// Optional hard limit for a complete model-input request.
    #[serde(default)]
    pub context_hard_input_tokens: Option<usize>,
    /// Optional model-visible message token count that starts automatic compaction.
    #[serde(default)]
    pub auto_compact_threshold_tokens: Option<usize>,
    /// Optional prefire threshold expressed in full-context tokens.
    #[serde(default)]
    pub prefire_threshold_tokens: Option<usize>,
    /// Conservative allowance for tool-result growth during the next model cycle.
    #[serde(default)]
    pub estimated_tool_growth_tokens: Option<usize>,
    /// Optional override for the model's max_tokens per response.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Optional provider used only for conversation compaction summaries.
    ///
    /// When unset, compaction reuses the main session provider.
    #[serde(default = "default_summary_provider")]
    pub summary_provider: Option<String>,
    /// Optional full provider configuration used for summaries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_profile: Option<String>,
    /// Optional model used only for conversation compaction summaries.
    ///
    /// When unset, compaction reuses the main session model.
    #[serde(default = "default_summary_model")]
    pub summary_model: Option<String>,
    /// Maximum tokens the summary model may emit during compaction.
    #[serde(default = "default_summary_max_tokens")]
    pub summary_max_tokens: u32,
    /// Mixture-of-Agents advisory model settings. `/moa` uses these models to
    /// build private context before the normal main-model turn starts.
    #[serde(default)]
    pub moa: MoaSettings,
    /// Settings for a foreground compound operation with independent multi-model planning and one synthesis.
    #[serde(default)]
    pub moa_plan: MoaPlanSettings,
    /// Maximum number of retries for transient provider/stream errors.
    #[serde(default = "default_max_retries")]
    pub max_retries: usize,
    /// Base delay in milliseconds for exponential backoff between retries.
    #[serde(default = "default_retry_base_delay_ms")]
    pub retry_base_delay_ms: u64,
    #[serde(default)]
    pub recovery: RecoverySettings,
    /// Optional wall-clock budget for a single turn, in seconds. When ~90%
    /// is consumed the model is nudged to wrap up with its current best
    /// result; at 100% the turn ends gracefully at the next tool boundary
    /// instead of being killed mid-flight by an external timeout.
    #[serde(default)]
    pub max_duration_secs: Option<u64>,
    /// External MCP servers to connect to on startup.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// Tool-system settings.
    #[serde(default)]
    pub tools: ToolsSettings,
    /// Default timeout in milliseconds for any single tool invocation.
    #[serde(default = "default_tool_timeout_ms")]
    pub tool_timeout_ms: u64,
    /// Source-compatibility shim for the removed global tool-timeout cap.
    ///
    /// This value is ignored and is never loaded from or saved to settings.
    #[deprecated(note = "global tool timeout caps are no longer applied")]
    #[serde(skip)]
    pub max_tool_timeout_ms: u64,
    /// Tool-specific runtime limits such as doom-loop repetition thresholds.
    #[serde(default)]
    pub tool_limits: ToolLimitsSettings,
    /// Maximum bytes of tool output that may be kept inline (per text block).
    /// Anything larger is head+tail truncated before being returned to the
    /// engine/TUI to keep memory bounded and the TUI responsive. 0 disables
    /// the limit (legacy behaviour, not recommended).
    #[serde(default = "default_max_tool_output_bytes")]
    pub max_tool_output_bytes: usize,
    /// Number of bytes from the start preserved when truncating tool output.
    #[serde(default = "default_tool_output_head_bytes")]
    pub tool_output_head_bytes: usize,
    /// Number of bytes from the end preserved when truncating tool output.
    #[serde(default = "default_tool_output_tail_bytes")]
    pub tool_output_tail_bytes: usize,
    /// Preview length (bytes) sent to the TUI when a background sub-agent
    /// completes, so the user can see a hint of the result without invoking
    /// the `wait` tool.
    #[serde(default = "default_background_completion_preview_bytes")]
    pub background_completion_preview_bytes: usize,
    /// Hard cap on the number of sub-agents that may run concurrently.
    /// Values outside 1..=MAX_CONCURRENT_SUBAGENTS are clamped at load time.
    /// The cap is enforced inside the engine so the model can be told to wait
    /// when it tries to fan out too aggressively.
    #[serde(default = "default_max_concurrent_subagents")]
    pub max_concurrent_subagents: usize,
    /// Default maximum internal turns when a sub-agent does not specify a limit.
    /// Values outside MIN_SUBAGENT_MAX_TURNS..=MAX_SUBAGENT_MAX_TURNS are clamped
    /// during loading; `subagent_max_turns` remains a supported settings alias.
    #[serde(default = "default_subagent_max_turns", alias = "subagent_max_turns")]
    pub default_subagent_max_turns: usize,
    /// Filesystem/command sandbox configuration.
    #[serde(default)]
    pub sandbox: SandboxConfig,

    // --- non-persisted session state ---
    /// Tools allowed for the current session only.
    #[serde(skip)]
    pub session_allowed_tools: Vec<String>,
    /// Tools denied for the current session only.
    #[serde(skip)]
    pub session_denied_tools: Vec<String>,
    /// Structured rules for the current session only.
    #[serde(skip)]
    pub session_permission_rules: Vec<PermissionRule>,
}

/// Configurable limits applied to named tools.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolLimitsSettings {
    #[serde(default)]
    pub doom_loop: DoomLoopSettings,
    /// Foreground blocking budgets indexed by tool name.
    #[serde(default)]
    pub foreground_budget_ms: NamedToolLimitSettings,
    /// Blocking timeout policy used by TaskOutput.
    #[serde(default)]
    pub task_output_timeout_ms: TaskOutputTimeoutSettings,
    /// Circuit-breaker policy for repeated denial of one capability in non-interactive permission modes.
    #[serde(default)]
    pub permission_denials: PermissionDenialLimitSettings,
}

/// Consecutive-denial limit for the same permission class.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionDenialLimitSettings {
    #[serde(default = "default_permission_denial_consecutive_limit")]
    pub consecutive_limit: usize,
}

impl Default for PermissionDenialLimitSettings {
    fn default() -> Self {
        Self {
            consecutive_limit: default_permission_denial_consecutive_limit(),
        }
    }
}

/// Numeric limit with a default and optional per-tool overrides.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NamedToolLimitSettings {
    #[serde(default = "default_tool_foreground_budget_ms")]
    pub default_ms: u64,
    #[serde(default)]
    pub tools: BTreeMap<String, u64>,
}

impl Default for NamedToolLimitSettings {
    fn default() -> Self {
        Self {
            default_ms: default_tool_foreground_budget_ms(),
            tools: BTreeMap::new(),
        }
    }
}

impl NamedToolLimitSettings {
    pub fn for_tool(&self, tool_name: &str) -> u64 {
        self.tools
            .get(tool_name)
            .copied()
            .unwrap_or(self.default_ms)
            .max(1)
    }
}

/// Configurable default and bounds for blocking TaskOutput calls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskOutputTimeoutSettings {
    #[serde(default = "default_task_output_timeout_ms")]
    pub default_ms: u64,
    #[serde(default = "default_task_output_min_timeout_ms")]
    pub min_ms: u64,
    #[serde(default = "default_task_output_max_timeout_ms")]
    pub max_ms: u64,
}

impl Default for TaskOutputTimeoutSettings {
    fn default() -> Self {
        Self {
            default_ms: default_task_output_timeout_ms(),
            min_ms: default_task_output_min_timeout_ms(),
            max_ms: default_task_output_max_timeout_ms(),
        }
    }
}

impl TaskOutputTimeoutSettings {
    pub fn normalize(&mut self) {
        self.min_ms = self.min_ms.max(1);
        self.max_ms = self.max_ms.max(self.min_ms);
        self.default_ms = self.default_ms.clamp(self.min_ms, self.max_ms);
    }
}

/// Repetition guard configuration for identical tool calls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoomLoopSettings {
    /// Default consecutive-call threshold for tools not listed in `tools`.
    #[serde(default = "default_doom_loop_repetitions")]
    pub default_repetitions: i64,
    /// Per-tool overrides. A negative value disables the guard for that tool.
    #[serde(default)]
    pub tools: BTreeMap<String, i64>,
}

impl Default for DoomLoopSettings {
    fn default() -> Self {
        Self {
            default_repetitions: default_doom_loop_repetitions(),
            tools: BTreeMap::from([("TaskOutput".to_string(), -1)]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioContextSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(default)]
    pub personality: StudioPersonality,
    /// Preserve a configured tombstone even when instructions are explicitly cleared, preventing older clients from migrating them again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub instructions_configured: bool,
    /// Record whether the user has made a choice independently of the personality default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub personality_configured: bool,
}

impl StudioContextSettings {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for StudioContextSettings {
    fn default() -> Self {
        Self {
            instructions: String::new(),
            personality: StudioPersonality::Pragmatic,
            instructions_configured: false,
            personality_configured: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudioPersonality {
    Friendly,
    #[default]
    Pragmatic,
}

/// Reusable structured model slot; omitted fields inherit from the primary runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelSlotConfig {
    /// Full provider profile name; takes precedence over provider/model when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Provider name; defaults to the primary session's active provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model name; defaults to the primary session's active model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Retain the former public Goal Pro name as a type alias for configuration and caller compatibility.
pub type GoalProModelSlotConfig = ModelSlotConfig;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratePolicyMode {
    #[default]
    Advisory,
    Enforce,
    Auto,
    Off,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrateContextMode {
    #[default]
    None,
    Fork,
    Full,
}

/// Optional tool configuration for the primary orchestration agent. The runtime
/// always retains core orchestration tools; settings only select non-core tools.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateMainSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional_tool_allowlist: Option<Vec<String>>,
}

/// Capabilities that the primary orchestration agent cannot disable. They define
/// the mode: reading context, delegating and controlling agents, maintaining the
/// PlanStore, recording acceptance, and integrating with the goal state machine.
pub fn orchestrate_main_core_tools() -> &'static [&'static str] {
    &[
        "read",
        "glob",
        "grep",
        "spawn_agent",
        "SendMessage",
        "AgentFleet",
        "ControlAgent",
        "wait",
        "close_agent",
        "AskUserQuestion",
        "CreateWorkPlan",
        "EditWorkPlan",
        "AppendWorkNotepad",
        "RecordTaskAcceptance",
        "RecordTaskAcceptances",
        "ReopenTask",
        "SelectActiveWork",
        "PlanProgress",
        "get_goal",
        "update_goal",
    ]
}

/// Non-core tools that configuration may remove from the primary orchestration
/// surface. Registered tools absent from this list are core capabilities and
/// cannot be disabled through `orchestrate.main`.
pub fn orchestrate_main_optional_tools() -> &'static [&'static str] {
    &[
        "memory_search",
        "memory_get",
        "PlanAgent",
        "explore_agent",
        "Workflow",
        "TodoWrite",
        "WriteReport",
        "EditReport",
        "WebFetch",
        "WebSearch",
        "CtxInspect",
        "skill",
        "DiscoverSkills",
        "cron_create",
        "cron_delete",
        "cron_list",
        "Sleep",
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateRosterOverride {
    pub tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub context_mode: OrchestrateContextMode,
}

/// Persona capability identity fixed at compile time. Settings may select the
/// tier, context, and restrictive allowlist, but cannot override security fields.
pub fn orchestrate_persona_base_role(name: &str) -> Option<&'static str> {
    match name {
        "junior" => Some("implementer"),
        "oracle" | "critic" => Some("review"),
        "librarian" => Some("explore"),
        _ => None,
    }
}

/// Maximum tool set aligned with the engine base-role policy, used to reject additive privilege expansion while loading configuration.
pub fn orchestrate_persona_max_tools(name: &str) -> Option<&'static [&'static str]> {
    const READ_ONLY: &[&str] = &[
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
        "skill",
        "DiscoverSkills",
        "PlanProgress",
    ];
    const IMPLEMENTER: &[&str] = &[
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
        "bash",
        "PowerShell",
        "edit",
        "write",
        "TodoWrite",
        "skill",
        "DiscoverSkills",
        "EnterWorktree",
        "ExitWorktree",
        "WorktreeCreate",
        "WorktreeRemove",
        "Sleep",
        "AppendWorkNotepad",
        "PlanProgress",
    ];
    match name {
        "junior" => Some(IMPLEMENTER),
        "oracle" | "librarian" | "critic" => Some(READ_ONLY),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestratePoliciesSettings {
    #[serde(default = "default_orchestrate_evidence_gate")]
    pub evidence_gate: OrchestratePolicyMode,
    #[serde(default)]
    pub delegation_contract: OrchestratePolicyMode,
}

impl Default for OrchestratePoliciesSettings {
    fn default() -> Self {
        Self {
            evidence_gate: default_orchestrate_evidence_gate(),
            delegation_contract: OrchestratePolicyMode::Advisory,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateNotepadSettings {
    #[serde(default = "default_true")]
    pub inject: bool,
    #[serde(default = "default_orchestrate_notepad_max_inject_bytes")]
    pub max_inject_bytes: usize,
}

impl Default for OrchestrateNotepadSettings {
    fn default() -> Self {
        Self {
            inject: true,
            max_inject_bytes: default_orchestrate_notepad_max_inject_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateContinuationSettings {
    #[serde(default = "default_orchestrate_cooldown_seconds")]
    pub cooldown_seconds: u64,
    #[serde(default = "default_orchestrate_max_stalled_rounds")]
    pub max_stalled_rounds: u32,
    #[serde(default = "default_orchestrate_max_consecutive_failures")]
    pub max_consecutive_failures: u32,
    #[serde(default = "default_orchestrate_max_auto_turns")]
    pub max_auto_turns: u32,
}

impl Default for OrchestrateContinuationSettings {
    fn default() -> Self {
        Self {
            cooldown_seconds: default_orchestrate_cooldown_seconds(),
            max_stalled_rounds: default_orchestrate_max_stalled_rounds(),
            max_consecutive_failures: default_orchestrate_max_consecutive_failures(),
            max_auto_turns: default_orchestrate_max_auto_turns(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateDeliverySettings {
    #[serde(default = "default_orchestrate_delivery_lease_timeout_seconds")]
    pub lease_timeout_seconds: u64,
    #[serde(default = "default_orchestrate_delivery_max_attempts")]
    pub max_attempts: u32,
}

impl Default for OrchestrateDeliverySettings {
    fn default() -> Self {
        Self {
            lease_timeout_seconds: default_orchestrate_delivery_lease_timeout_seconds(),
            max_attempts: default_orchestrate_delivery_max_attempts(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateFleetSettings {
    #[serde(default = "default_true")]
    pub inject: bool,
    #[serde(default = "default_orchestrate_fleet_max_members")]
    pub max_members: usize,
    #[serde(default = "default_orchestrate_fleet_max_inject_bytes")]
    pub max_inject_bytes: usize,
}

impl Default for OrchestrateFleetSettings {
    fn default() -> Self {
        Self {
            inject: true,
            max_members: default_orchestrate_fleet_max_members(),
            max_inject_bytes: default_orchestrate_fleet_max_inject_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateControlSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for OrchestrateControlSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateBreakerSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub hard_stop: bool,
    #[serde(default = "default_orchestrate_breaker_repeated_action_threshold")]
    pub repeated_action_threshold: u32,
    #[serde(default = "default_orchestrate_breaker_consecutive_error_threshold")]
    pub consecutive_error_threshold: u32,
    #[serde(default = "default_orchestrate_breaker_no_progress_rounds")]
    pub no_progress_rounds: u32,
}

impl Default for OrchestrateBreakerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hard_stop: false,
            repeated_action_threshold: default_orchestrate_breaker_repeated_action_threshold(),
            consecutive_error_threshold: default_orchestrate_breaker_consecutive_error_threshold(),
            no_progress_rounds: default_orchestrate_breaker_no_progress_rounds(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateAuditSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_orchestrate_audit_max_events")]
    pub max_events: usize,
    #[serde(default = "default_orchestrate_audit_max_event_bytes")]
    pub max_event_bytes: usize,
}

impl Default for OrchestrateAuditSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_events: default_orchestrate_audit_max_events(),
            max_event_bytes: default_orchestrate_audit_max_event_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateSettings {
    #[serde(default)]
    pub main: OrchestrateMainSettings,
    #[serde(default)]
    pub tiers: BTreeMap<String, ModelSlotConfig>,
    #[serde(default = "default_orchestrate_roster")]
    pub roster: BTreeMap<String, OrchestrateRosterOverride>,
    #[serde(default = "default_orchestrate_critic_max_cycles")]
    pub critic_max_cycles: usize,
    #[serde(default = "default_orchestrate_critic_max_infrastructure_retries")]
    pub critic_max_infrastructure_retries: usize,
    #[serde(default)]
    pub policies: OrchestratePoliciesSettings,
    #[serde(default)]
    pub notepad: OrchestrateNotepadSettings,
    #[serde(default)]
    pub continuation: OrchestrateContinuationSettings,
    #[serde(default)]
    pub delivery: OrchestrateDeliverySettings,
    #[serde(default)]
    pub fleet: OrchestrateFleetSettings,
    #[serde(default)]
    pub control: OrchestrateControlSettings,
    #[serde(default)]
    pub breaker: OrchestrateBreakerSettings,
    #[serde(default)]
    pub audit: OrchestrateAuditSettings,
}

impl Default for OrchestrateSettings {
    fn default() -> Self {
        Self {
            main: OrchestrateMainSettings::default(),
            tiers: BTreeMap::new(),
            roster: default_orchestrate_roster(),
            critic_max_cycles: default_orchestrate_critic_max_cycles(),
            critic_max_infrastructure_retries:
                default_orchestrate_critic_max_infrastructure_retries(),
            policies: OrchestratePoliciesSettings::default(),
            notepad: OrchestrateNotepadSettings::default(),
            continuation: OrchestrateContinuationSettings::default(),
            delivery: OrchestrateDeliverySettings::default(),
            fleet: OrchestrateFleetSettings::default(),
            control: OrchestrateControlSettings::default(),
            breaker: OrchestrateBreakerSettings::default(),
            audit: OrchestrateAuditSettings::default(),
        }
    }
}

fn default_orchestrate_roster() -> BTreeMap<String, OrchestrateRosterOverride> {
    [
        ("junior", "standard"),
        ("oracle", "max"),
        ("librarian", "fast"),
        ("critic", "max"),
    ]
    .into_iter()
    .map(|(name, tier)| {
        (
            name.to_string(),
            OrchestrateRosterOverride {
                tier: tier.to_string(),
                tool_allowlist: None,
                context_mode: OrchestrateContextMode::None,
            },
        )
    })
    .collect()
}

fn default_orchestrate_evidence_gate() -> OrchestratePolicyMode {
    OrchestratePolicyMode::Auto
}

fn default_orchestrate_notepad_max_inject_bytes() -> usize {
    8192
}

fn default_orchestrate_cooldown_seconds() -> u64 {
    30
}

fn default_orchestrate_max_stalled_rounds() -> u32 {
    5
}

fn default_orchestrate_max_consecutive_failures() -> u32 {
    3
}

fn default_orchestrate_max_auto_turns() -> u32 {
    8
}

fn default_orchestrate_critic_max_cycles() -> usize {
    3
}

fn default_orchestrate_critic_max_infrastructure_retries() -> usize {
    2
}

fn default_orchestrate_delivery_lease_timeout_seconds() -> u64 {
    120
}

fn default_orchestrate_delivery_max_attempts() -> u32 {
    8
}

fn default_orchestrate_fleet_max_members() -> usize {
    24
}

fn default_orchestrate_fleet_max_inject_bytes() -> usize {
    8192
}

fn default_orchestrate_breaker_repeated_action_threshold() -> u32 {
    8
}

fn default_orchestrate_breaker_consecutive_error_threshold() -> u32 {
    5
}

fn default_orchestrate_breaker_no_progress_rounds() -> u32 {
    4
}

fn default_orchestrate_audit_max_events() -> usize {
    4096
}

fn default_orchestrate_audit_max_event_bytes() -> usize {
    4096
}

/// Maximum verifier-panel membership; excess entries are truncated when snapshotting.
pub const GOAL_PRO_VERIFIER_PANEL_MAX: usize = 5;

/// Normalize verifier-panel configuration by trimming fields, treating empty strings as inheritance, and enforcing the size limit.
pub fn normalize_goal_pro_verifier_panel(
    models: Vec<GoalProModelSlotConfig>,
) -> Vec<GoalProModelSlotConfig> {
    models
        .into_iter()
        .take(GOAL_PRO_VERIFIER_PANEL_MAX)
        .map(|mut slot| {
            slot.profile = slot.profile.and_then(non_empty_setting_string);
            slot.provider = slot.provider.and_then(non_empty_setting_string);
            slot.model = slot.model.and_then(non_empty_setting_string);
            slot
        })
        .collect()
}

fn non_empty_setting_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Runtime selection for an independent `/goal-pro` verifier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalProSettings {
    /// Full provider profile name; takes precedence over provider/model when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_profile: Option<String>,
    /// Provider name or configured custom profile name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_provider: Option<String>,
    /// Model name used by the verifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_model: Option<String>,
    /// Multi-model verifier panel. Two or more entries enable majority voting; one
    /// entry acts as a single-verifier override; an empty list preserves the
    /// verifier_profile/provider/model behavior.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verifier_models: Vec<GoalProModelSlotConfig>,
    /// Maximum internal turns allowed for one verifier review.
    #[serde(default = "default_goal_pro_verifier_max_turns")]
    pub verifier_max_turns: usize,
    /// Block newly created Goal Pro runs after cumulative semantic completion rejections reach this value.
    #[serde(default = "default_goal_pro_completion_rejection_limit")]
    pub completion_rejection_limit: usize,
    /// Mandatory acceptance and environment-isolation policy for independent verifiers.
    #[serde(default)]
    pub verification: GoalProVerificationSettings,
    /// Automatic primary-agent model escalation after verifier rejections reach configured thresholds.
    #[serde(default)]
    pub model_escalation: GoalProModelEscalationSettings,
}

impl GoalProSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProSettings {
    fn default() -> Self {
        Self {
            verifier_profile: None,
            verifier_provider: None,
            verifier_model: None,
            verifier_models: Vec::new(),
            verifier_max_turns: default_goal_pro_verifier_max_turns(),
            completion_rejection_limit: default_goal_pro_completion_rejection_limit(),
            verification: GoalProVerificationSettings::default(),
            model_escalation: GoalProModelEscalationSettings::default(),
        }
    }
}

/// Automatic `/goal-pro` primary-agent model escalation. Once semantic verifier
/// rejections reach a threshold, switch provider/model by rung while preserving
/// the full message history, using the same mechanism as manual `/model` changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalProModelEscalationSettings {
    /// When enabled, advance one rung whenever the rejection count reaches another multiple of the threshold.
    #[serde(default)]
    pub enabled: bool,
    /// Cumulative semantic rejections required to trigger each rung change.
    #[serde(default = "default_goal_pro_model_escalation_threshold")]
    pub threshold: usize,
    /// Ordered model rungs. Each entry's api_format and context_window_tokens must
    /// exactly match the primary provider; configuration loading fails fast otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<GoalProModelSlotConfig>,
}

impl GoalProModelEscalationSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProModelEscalationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: default_goal_pro_model_escalation_threshold(),
            models: Vec::new(),
        }
    }
}

/// Machine acceptance policy for the `/goal-pro` artifact verifier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct GoalProVerificationSettings {
    /// Require a successful test actually executed by the verifier in this run before completion.
    pub require_tests: bool,
    /// Require the same read-only probe to prove that the candidate fixes the behavior that failed on the pristine baseline.
    pub require_behavior_delta: bool,
    /// Minimum acceptable test scope.
    pub minimum_test_scope: GoalProTestScope,
    /// Accept only the original test exit code without output filtering or failure suppression.
    pub require_raw_exit_code: bool,
    /// Allow the verifier to modify the candidate workspace.
    pub allow_workspace_changes: bool,
    /// Isolate the verifier's home, cache, temporary directory, and Python user site.
    pub isolate_environment: bool,
    /// Allow the verifier to install, remove, or update dependencies.
    pub allow_dependency_changes: bool,
    /// After target tests pass, allow peripheral failures caused solely by unavailable external networking.
    pub allow_network_only_failures: bool,
}

impl GoalProVerificationSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProVerificationSettings {
    fn default() -> Self {
        default_goal_pro_verification_settings()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalProTestScope {
    Focused,
    TargetSuite,
}

impl Default for Settings {
    fn default() -> Self {
        let mut settings: Self = serde_json::from_value(default_settings_document())
            .expect("embedded default settings must deserialize");
        settings
            .apply_provider(None)
            .expect("embedded active Provider must be valid");
        settings
    }
}

fn default_model() -> String {
    default_model_name()
}

fn default_summary_provider() -> Option<String> {
    None
}

fn default_summary_model() -> Option<String> {
    None
}

fn default_true() -> bool {
    true
}

fn default_moa_provider() -> String {
    "current".to_string()
}

fn default_moa_model() -> String {
    "current".to_string()
}

fn default_moa_default_preset() -> String {
    "default".to_string()
}

fn default_moa_max_reference_workers() -> usize {
    8
}

fn default_moa_reference_models() -> Vec<MoaModelConfig> {
    vec![MoaModelConfig::new("current", "current")]
}

fn default_moa_aggregator() -> MoaModelConfig {
    MoaModelConfig::new("current", "current")
}

fn default_moa_reference_max_tokens() -> Option<u32> {
    Some(16_384)
}

fn default_moa_aggregator_max_tokens() -> Option<u32> {
    Some(32_768)
}

fn default_moa_presets() -> BTreeMap<String, MoaPresetConfig> {
    BTreeMap::from([(default_moa_default_preset(), MoaPresetConfig::default())])
}

fn default_moa_plan_preset() -> String {
    "default".to_string()
}

fn default_moa_plan_draft_max_turns() -> usize {
    DEFAULT_SUBAGENT_MAX_TURNS
}

fn default_moa_plan_draft_max_tokens() -> u32 {
    16_384
}

fn default_moa_plan_synthesis_max_tokens() -> u32 {
    32_768
}

fn default_moa_plan_draft_timeout_secs() -> u64 {
    300
}

fn default_moa_plan_max_planner_workers() -> usize {
    4
}

fn default_auto_memory_enabled() -> bool {
    true
}

fn default_auto_tool_memory_enabled() -> bool {
    true
}

fn default_memory_structured_enabled() -> bool {
    true
}

fn default_memory_legacy_prompt_enabled() -> bool {
    true
}

fn default_memory_record_prompt_placeholders() -> bool {
    true
}

fn default_memory_observer_queue_size() -> usize {
    128
}

fn default_session_memory_enabled() -> bool {
    true
}

fn default_session_memory_update_enabled() -> bool {
    true
}

fn default_session_memory_compact_enabled() -> bool {
    true
}

fn default_session_memory_update_interval_turns() -> usize {
    1
}

fn default_session_memory_init_min_tokens() -> usize {
    10_000
}

fn default_session_memory_update_min_token_delta() -> usize {
    5_000
}

fn default_session_memory_tool_call_threshold() -> usize {
    3
}

fn default_session_memory_max_update_messages() -> usize {
    80
}

fn default_session_memory_update_max_tokens() -> u32 {
    12_000
}

fn default_session_memory_compact_min_chars() -> usize {
    80
}

fn default_session_memory_compact_min_recent_tokens() -> usize {
    10_000
}

fn default_session_memory_compact_max_recent_tokens() -> usize {
    40_000
}

fn default_session_memory_compact_min_recent_messages() -> usize {
    5
}

fn default_auto_compact_small_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_SMALL_WINDOW_PERCENT
}

fn default_auto_compact_medium_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_MEDIUM_WINDOW_PERCENT
}

fn default_auto_compact_large_window_percent() -> usize {
    DEFAULT_AUTO_COMPACT_LARGE_WINDOW_PERCENT
}

fn default_time_based_micro_compact_enabled() -> bool {
    true
}

fn default_time_based_micro_compact_gap_minutes() -> u64 {
    60
}

fn default_time_based_micro_compact_keep_recent() -> usize {
    5
}

fn default_goal_enabled() -> bool {
    true
}

fn default_goal_max_auto_continuations() -> usize {
    8
}

fn default_auto_skill_review_interval() -> usize {
    10
}

fn default_auto_curator_enabled() -> bool {
    true
}

fn default_auto_curator_interval_hours() -> u64 {
    168
}

fn default_auto_curator_min_idle_hours() -> u64 {
    2
}

fn default_stale_after_days() -> u64 {
    30
}

fn default_archive_after_days() -> u64 {
    90
}

fn default_skill_guard_enabled() -> bool {
    true
}

fn default_skill_guard_block_high_risk() -> bool {
    true
}

fn default_skill_guard_block_medium_risk_for_community() -> bool {
    true
}

fn default_history_enabled() -> bool {
    true
}

fn default_history_max_messages() -> usize {
    99_999
}

fn default_render_markdown() -> bool {
    true
}

fn default_code_theme() -> String {
    "auto".to_string()
}

fn default_max_retries() -> usize {
    // Headless/batch runs share upstream proxies with other sessions; five
    // attempts ride out short transport outages that three would not
    // (observed in parallel-run campaigns).
    5
}

fn default_summary_max_tokens() -> u32 {
    20_000
}

fn default_retry_base_delay_ms() -> u64 {
    1000
}

fn default_semantic_coercion_enabled() -> bool {
    true
}

fn default_stringify_mismatched_scalar() -> bool {
    true
}

fn default_tool_timeout_ms() -> u64 {
    300_000
}

fn default_tool_foreground_budget_ms() -> u64 {
    300_000
}

fn default_task_output_timeout_ms() -> u64 {
    5_000
}

fn default_task_output_min_timeout_ms() -> u64 {
    1_000
}

fn default_task_output_max_timeout_ms() -> u64 {
    15_000
}

/// Default per-tool output cap. 100 KiB keeps even very chatty tools
/// (rg, cargo test, big greps) inside a bounded, renderable result while
/// preserving enough output for the model to work with.
fn default_max_tool_output_bytes() -> usize {
    100 * 1024
}

fn default_doom_loop_repetitions() -> i64 {
    6
}

fn default_permission_denial_consecutive_limit() -> usize {
    2
}

fn default_tool_output_head_bytes() -> usize {
    60 * 1024
}

fn default_tool_output_tail_bytes() -> usize {
    40 * 1024
}

fn default_background_completion_preview_bytes() -> usize {
    512
}

/// Default concurrent sub-agent cap. The engine also treats this as the hard
/// maximum for live forked agents.
fn default_max_concurrent_subagents() -> usize {
    MAX_CONCURRENT_SUBAGENTS
}

fn default_subagent_max_turns() -> usize {
    DEFAULT_SUBAGENT_MAX_TURNS
}

impl Settings {
    /// Apply irreversible process-level training-harness overrides that disable background model requests not required by the task.
    pub fn enable_training_mode(&mut self) {
        self.training_mode = true;
        self.max_retries = 0;
    }

    pub fn apply_provider(&mut self, requested: Option<&str>) -> Result<()> {
        let selected = requested
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(self.active_provider.as_deref())
            .map(str::to_string);
        let Some(selected) = selected else {
            return Ok(());
        };
        let provider = self.providers.get(&selected).cloned().ok_or_else(|| {
            anyhow::anyhow!(
                "unknown provider '{selected}'; configured providers: {}",
                self.providers
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
        provider.validate_models()?;
        let endpoint = if selected == "kunlunmeta" {
            std::env::var("KUNLUNMETA_BASE_URL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| provider.endpoint.clone())
        } else {
            provider.endpoint.clone()
        };
        let default_model = if selected == "kunlunmeta" {
            std::env::var("KUNLUNMETA_BASE_MODEL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| provider.default_model.clone())
        } else {
            provider.default_model.clone()
        };
        let provider = if provider.models.is_empty() && default_model != provider.default_model {
            provider
        } else {
            provider.effective_for_model(&default_model)?
        };
        self.active_provider = Some(selected.clone());
        self.provider = Some(selected);
        self.api_format = Some(provider.api_format);
        self.base_url = Some(endpoint);
        self.model = default_model;
        self.model_capabilities = provider.capabilities;
        self.model_reasoning_effort = provider.reasoning_effort;
        self.context_window_tokens = Some(provider.context_window_tokens);
        self.context_output_headroom = Some(provider.output_headroom_tokens);
        self.auto_compact_threshold_tokens = provider.auto_compact_threshold_tokens;
        self.max_tokens = Some(provider.max_output_tokens);
        self.request_timeout_secs = provider.request_timeout_secs;
        self.openai_user_agent = provider.user_agent;
        if let Some(max_retries) = provider.max_retries {
            self.max_retries = max_retries;
        }
        if let Some(retry_base_delay_ms) = provider.retry_base_delay_ms {
            self.retry_base_delay_ms = retry_base_delay_ms;
        }
        if self.training_mode {
            self.max_retries = 0;
        }
        self.provider_no_proxy = provider.no_proxy;
        self.provider_extra_body = provider.extra_body;
        self.active_model_selection = None;
        Ok(())
    }

    /// Apply a model advertised by a deployment but not explicitly configured.
    /// Only transport settings are inherited from the source profile.
    pub fn apply_discovered_model(&mut self, source_profile: &str, model: &str) -> Result<()> {
        let source_profile = source_profile.trim();
        let model = model.trim();
        if model.is_empty() {
            anyhow::bail!("discovered model id cannot be empty");
        }
        self.apply_provider(Some(source_profile))?;
        if let Some(profile) = self.providers.get(source_profile)
            && profile.has_model(model)
        {
            let effective = profile.effective_for_model(model)?;
            self.model_capabilities = effective.capabilities;
            self.model_reasoning_effort = effective.reasoning_effort;
            self.context_window_tokens = Some(effective.context_window_tokens);
            self.context_output_headroom = Some(effective.output_headroom_tokens);
            self.max_tokens = Some(effective.max_output_tokens);
            self.auto_compact_threshold_tokens = effective.auto_compact_threshold_tokens;
        }
        self.model = model.to_string();
        self.active_model_selection = Some(ActiveModelSelection {
            source_profile: source_profile.to_string(),
            model: model.to_string(),
        });
        Ok(())
    }

    pub(crate) fn reapply_active_model_selection(&mut self) -> Result<()> {
        let Some(selection) = self.active_model_selection.clone() else {
            return Ok(());
        };
        self.apply_discovered_model(&selection.source_profile, &selection.model)
    }

    /// Load settings from the user's config directory.
    pub fn load() -> Result<Self> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Ok(SettingsLoader::new(cwd).load()?.settings)
    }

    /// Load effective settings for a working directory using the same layered
    /// precedence as the CLI: user, executable directory, project, then
    /// project-local settings.
    pub fn load_for_cwd(cwd: impl AsRef<Path>) -> Result<LoadedSettings> {
        SettingsLoader::new(cwd).load()
    }

    pub(crate) fn apply_env_overrides(&mut self) {
        if let Ok(raw) = std::env::var("KCODER_MODEL_REASONING_EFFORT") {
            let value = raw.trim();
            self.model_reasoning_effort = if value.is_empty()
                || value.eq_ignore_ascii_case("default")
                || value.eq_ignore_ascii_case("none")
            {
                None
            } else {
                match value.parse::<ReasoningEffort>() {
                    Ok(effort) => Some(effort),
                    Err(error) => {
                        warn!(
                            "ignoring invalid KCODER_MODEL_REASONING_EFFORT={:?}: {}",
                            raw, error
                        );
                        self.model_reasoning_effort.clone()
                    }
                }
            };
        }
    }

    /// Save settings to the user's config directory atomically.
    pub fn save(&self) -> Result<()> {
        let path = settings_path()?;
        self.save_to(&path)
    }

    /// Persist the settings to an explicit path (used by `save`; split out so
    /// tests can verify the persisted document without touching the real
    /// user settings file).
    pub fn save_to(&self, path: &std::path::Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create config dir {:?}", parent))?;
        }
        let lock_path = path.with_extension("json.lock");
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("failed to open settings lock {:?}", lock_path))?;
        FileExt::lock_exclusive(&lock)
            .with_context(|| format!("failed to lock settings {:?}", lock_path))?;
        let result = self.save_to_locked(path);
        FileExt::unlock(&lock)
            .with_context(|| format!("failed to unlock settings {:?}", lock_path))?;
        result
    }

    fn save_to_locked(&self, path: &std::path::Path) -> Result<()> {
        let mut persisted = self.without_plaintext_secrets();
        persisted.normalize_runtime_limits();
        // Persist user intent, not merged product defaults. A profile is kept
        // when it is declared in the current file (user-owned) or differs
        // from its embedded default (customized); profiles that merely came
        // from the defaults layer must not be written back, or every save
        // would resurrect entries the user deleted.
        let embedded_profiles = crate::deployment::default_providers();
        let current_names: std::collections::HashSet<String> = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|doc| {
                doc.get("providers")?
                    .as_object()
                    .map(|profiles| profiles.keys().cloned().collect())
            })
            .unwrap_or_default();
        persisted.providers.retain(|name, profile| {
            current_names.contains(name) || embedded_profiles.get(name) != Some(profile)
        });
        let current_studio_context = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|document| document.get("studio_context").cloned());
        let mut document =
            serde_json::to_value(&persisted).context("failed to serialize settings")?;
        // Only runtime.context.* may modify Studio execution context. Other Settings::save
        // calls must retain the latest on-disk value so unrelated updates such as MCP
        // changes cannot overwrite concurrent writes or clear the tombstone.
        if let Some(studio_context) = current_studio_context {
            document
                .as_object_mut()
                .context("serialized settings must be an object")?
                .insert("studio_context".to_string(), studio_context);
        }
        let content =
            serde_json::to_string_pretty(&document).context("failed to serialize settings")?;
        let tmp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&tmp_path, content)
            .with_context(|| format!("failed to write temporary settings to {:?}", tmp_path))?;
        set_user_only_file_permissions(&tmp_path)?;
        fs::rename(&tmp_path, path)
            .with_context(|| format!("failed to rename {:?} to {:?}", tmp_path, path))?;
        Ok(())
    }

    /// The user-level config directory for this application.
    pub fn config_dir() -> Result<PathBuf> {
        user_config_dir()
    }

    /// Resolved memory directory: explicit setting, env var, or default config subdir.
    pub fn memory_dir(&self) -> Result<PathBuf> {
        if let Some(dir) = &self.memory_directory {
            return Ok(dir.clone());
        }
        if let Ok(dir) = std::env::var("KCODER_MEMORY_DIR") {
            return Ok(PathBuf::from(dir));
        }
        Ok(Self::config_dir()?.join("memory"))
    }

    /// Resolved history directory.
    pub fn history_dir(&self) -> Result<PathBuf> {
        if let Some(dir) = &self.history_directory {
            return Ok(dir.clone());
        }
        if let Ok(dir) = std::env::var("KCODER_HISTORY_DIR") {
            return Ok(PathBuf::from(dir));
        }
        Ok(Self::config_dir()?.join("history"))
    }

    /// Root directory for project-scoped transcripts.
    pub fn projects_dir() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("projects"))
    }

    /// Project-scoped transcript directory for a working tree.
    ///
    /// The directory contains `<session>.jsonl` transcripts plus
    /// `<session>/...` session-scoped state such as session-memory summaries.
    pub fn project_data_dir(cwd: impl AsRef<Path>) -> Result<PathBuf> {
        Ok(Self::projects_dir()?.join(project_key_for_path(cwd)))
    }

    /// Project directories that readers should search, newest format first.
    ///
    /// Windows builds before the user-facing canonicalization fix persisted
    /// escaped keys derived from `\\?\` paths. Keep that directory as a
    /// compatibility candidate alongside the older underscore-based format.
    pub fn project_data_dirs_for_read(cwd: impl AsRef<Path>) -> Result<Vec<PathBuf>> {
        let cwd = cwd.as_ref();
        let projects = Self::projects_dir()?;
        let mut dirs = Vec::new();
        for key in [
            project_key_for_path(cwd),
            previous_project_key_for_path(cwd),
            legacy_project_key_for_path(cwd),
        ] {
            let dir = projects.join(key);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        Ok(dirs)
    }

    /// Legacy project directory used by older KCoder builds.
    ///
    /// New sessions must use `project_data_dir`; readers use this only as a
    /// compatibility fallback while old `_path_style` transcripts remain.
    pub fn legacy_project_data_dir(cwd: impl AsRef<Path>) -> Result<PathBuf> {
        Ok(Self::projects_dir()?.join(legacy_project_key_for_path(cwd)))
    }

    /// Copy used for persistence. Legacy plaintext key fields may still be
    /// read for compatibility, but they are not written back to settings.json.
    fn without_plaintext_secrets(&self) -> Self {
        let mut settings = self.clone();
        settings.api_key = None;
        settings.anthropic_api_key = None;
        settings.kunlunmeta_api_key = None;
        settings.openai_api_key = None;
        settings.local_api_key = None;
        settings.gemini_api_key = None;
        settings.grok_api_key = None;
        settings
    }

    pub(crate) fn normalize_paths(&mut self) {
        self.skills.external_dirs = self
            .skills
            .external_dirs
            .iter()
            .map(|path| expand_home_path(path))
            .collect();
    }

    pub(crate) fn normalize_runtime_limits(&mut self) {
        self.history_max_messages = self.history_max_messages.max(1);
        if self.max_concurrent_subagents == 0
            || self.max_concurrent_subagents > MAX_CONCURRENT_SUBAGENTS
        {
            self.max_concurrent_subagents = MAX_CONCURRENT_SUBAGENTS;
        }
        self.default_subagent_max_turns = self
            .default_subagent_max_turns
            .clamp(MIN_SUBAGENT_MAX_TURNS, MAX_SUBAGENT_MAX_TURNS);
        self.model_discovery.request_timeout_secs =
            self.model_discovery.request_timeout_secs.clamp(1, 60);
        self.model_discovery.cache_ttl_secs = self.model_discovery.cache_ttl_secs.clamp(1, 86_400);
        self.model_discovery.max_models_per_provider =
            self.model_discovery.max_models_per_provider.clamp(1, 1_000);
        self.tool_limits.foreground_budget_ms.default_ms =
            self.tool_limits.foreground_budget_ms.default_ms.max(1);
        for budget in self.tool_limits.foreground_budget_ms.tools.values_mut() {
            *budget = (*budget).max(1);
        }
        self.tool_limits.task_output_timeout_ms.normalize();
        self.tool_limits.permission_denials.consecutive_limit =
            self.tool_limits.permission_denials.consecutive_limit.max(1);
        self.goal_pro.completion_rejection_limit = self.goal_pro.completion_rejection_limit.max(1);
    }

    /// Names of persisted settings fields that currently contain plaintext
    /// API credentials. Values are deliberately not returned.
    pub fn plaintext_secret_setting_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        push_secret_field(&mut names, "api_key", &self.api_key);
        push_secret_field(&mut names, "anthropic_api_key", &self.anthropic_api_key);
        push_secret_field(&mut names, "kunlunmeta_api_key", &self.kunlunmeta_api_key);
        push_secret_field(&mut names, "openai_api_key", &self.openai_api_key);
        push_secret_field(&mut names, "local_api_key", &self.local_api_key);
        push_secret_field(&mut names, "gemini_api_key", &self.gemini_api_key);
        push_secret_field(&mut names, "grok_api_key", &self.grok_api_key);
        names
    }
}

fn project_key_for_path(cwd: impl AsRef<Path>) -> String {
    project_key_for_normalized_path(&normalized_project_path(cwd))
}

fn project_key_for_normalized_path(root: &Path) -> String {
    const MAX_SANITIZED_LENGTH: usize = 200;
    let raw = root.to_string_lossy();
    let sanitized: String = raw
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    if sanitized.len() <= MAX_SANITIZED_LENGTH {
        return sanitized;
    }
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    let hash = base36(hasher.finish());
    format!("{}-{}", &sanitized[..MAX_SANITIZED_LENGTH], hash)
}

fn legacy_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    previous_normalized_project_path(cwd)
        .to_string_lossy()
        .replace(['/', '\\', ':', ' '], "_")
}

fn normalized_project_path(cwd: impl AsRef<Path>) -> PathBuf {
    dunce::canonicalize(cwd.as_ref()).unwrap_or_else(|_| cwd.as_ref().to_path_buf())
}

fn previous_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = previous_normalized_project_path(cwd);
    project_key_for_normalized_path(&root)
}

fn previous_normalized_project_path(cwd: impl AsRef<Path>) -> PathBuf {
    cwd.as_ref()
        .canonicalize()
        .unwrap_or_else(|_| cwd.as_ref().to_path_buf())
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while value > 0 {
        let digit = (value % 36) as usize;
        buf.push(DIGITS[digit] as char);
        value /= 36;
    }
    buf.iter().rev().collect()
}

fn push_secret_field(names: &mut Vec<&'static str>, name: &'static str, value: &Option<String>) {
    if value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        names.push(name);
    }
}

fn settings_path() -> Result<PathBuf> {
    Ok(Settings::config_dir()?.join("settings.json"))
}

pub fn expand_home_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let Some(home) = dirs::home_dir() else {
        return path.to_path_buf();
    };
    if raw == "~" {
        return home;
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        return home.join(rest);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    #[test]
    fn permission_mode_parsing() {
        assert_eq!(PermissionMode::parse("auto"), Some(PermissionMode::Auto));
        assert_eq!(
            PermissionMode::parse("accept-edits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            PermissionMode::parse("accept_edits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(PermissionMode::parse("yolo"), Some(PermissionMode::Yolo));
        assert_eq!(PermissionMode::parse("BOGUS"), None);
    }

    #[test]
    fn default_permission_mode_is_ask() {
        assert_eq!(PermissionMode::default(), PermissionMode::Ask);
        assert_eq!(Settings::default().permission_mode, PermissionMode::Ask);
    }

    #[test]
    fn default_code_theme_uses_codex_adaptive_mode() {
        assert_eq!(Settings::default().code_theme, "auto");
    }

    #[test]
    fn settings_default_is_derived_from_the_default_provider_profile() {
        let settings = Settings::default();
        let profile = &settings.providers[DEFAULT_ACTIVE_PROVIDER];

        assert_eq!(
            settings.active_provider.as_deref(),
            Some(DEFAULT_ACTIVE_PROVIDER)
        );
        assert_eq!(settings.provider.as_deref(), Some(DEFAULT_ACTIVE_PROVIDER));
        assert_eq!(settings.api_format, Some(profile.api_format));
        assert_eq!(
            settings.base_url.as_deref(),
            Some(profile.endpoint.as_str())
        );
        assert_eq!(settings.model, profile.default_model);
        assert_eq!(settings.model_reasoning_effort, profile.reasoning_effort);
        assert_eq!(
            settings.context_window_tokens,
            Some(profile.context_window_tokens)
        );
        assert_eq!(
            settings.context_output_headroom,
            Some(profile.output_headroom_tokens)
        );
        assert_eq!(settings.max_tokens, Some(profile.max_output_tokens));
        assert!(settings.time_based_micro_compact.enabled);
        assert_eq!(settings.time_based_micro_compact.gap_threshold_minutes, 60);
        assert_eq!(settings.time_based_micro_compact.keep_recent, 5);
        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .small_window_percent,
            95
        );
        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .medium_window_percent,
            85
        );
        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .large_window_percent,
            75
        );
    }

    #[test]
    fn context_compaction_threshold_percentages_are_configurable() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "context_compaction": {
                    "auto_threshold": {
                        "small_window_percent": 90,
                        "medium_window_percent": 80,
                        "large_window_percent": 70
                    }
                }
            }"#,
        )
        .unwrap();

        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .percentage_for(128_000),
            90
        );
        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .percentage_for(512_000),
            80
        );
        assert_eq!(
            settings
                .context_compaction
                .auto_threshold
                .percentage_for(1_000_000),
            70
        );
    }

    #[test]
    fn model_discovery_defaults_control_only_provider_catalog_queries() {
        let settings = Settings::default();
        let discovery = settings.model_discovery;

        assert!(discovery.enabled);
        assert_eq!(discovery.request_timeout_secs, 8);
        assert_eq!(discovery.cache_ttl_secs, 300);
        assert_eq!(discovery.max_models_per_provider, 200);
    }

    #[test]
    fn discovered_model_inherits_complete_provider_configuration() {
        let mut settings = Settings::default();
        settings
            .apply_discovered_model("kunlunmeta", "Kimi-2.7")
            .unwrap();

        assert_eq!(settings.provider.as_deref(), Some("kunlunmeta"));
        assert_eq!(settings.model, "Kimi-2.7");
        assert_eq!(settings.api_format, Some(ApiFormat::AnthropicMessages));
        assert_eq!(settings.context_window_tokens, Some(1_048_576));
        assert_eq!(settings.auto_compact_threshold_tokens, None);
        assert_eq!(settings.context_output_headroom, Some(100_000));
        assert_eq!(settings.max_tokens, Some(100_000));
        assert_eq!(settings.model_reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(settings.model_capabilities, ModelCapabilities::default());
        assert_eq!(
            settings.active_model_selection,
            Some(ActiveModelSelection {
                source_profile: "kunlunmeta".to_string(),
                model: "Kimi-2.7".to_string(),
            })
        );
    }

    #[test]
    fn time_based_micro_compact_settings_are_independently_configurable() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "time_based_micro_compact": {
                    "enabled": false,
                    "gap_threshold_minutes": 90,
                    "keep_recent": 8
                }
            }"#,
        )
        .unwrap();

        assert!(!settings.time_based_micro_compact.enabled);
        assert_eq!(settings.time_based_micro_compact.gap_threshold_minutes, 90);
        assert_eq!(settings.time_based_micro_compact.keep_recent, 8);
    }

    #[test]
    fn provider_profile_applies_complete_runtime_configuration() {
        let mut settings = Settings::default();
        settings.providers.insert(
            "custom".to_string(),
            ProviderConfig {
                authentication: Default::default(),
                credential_env: Vec::new(),
                api_format: ApiFormat::OpenaiResponses,
                endpoint: "https://example.test/v1".to_string(),
                default_model: "example-model".to_string(),
                models: Default::default(),
                discover_models: None,
                capabilities: ModelCapabilities::default(),
                reasoning_effort: Some(ReasoningEffort::High),
                context_window_tokens: 200_000,
                auto_compact_threshold_tokens: Some(100_000),
                output_headroom_tokens: 20_000,
                max_output_tokens: 12_000,
                request_timeout_secs: Some(45),
                user_agent: Some("example-client/1.0".to_string()),
                max_retries: Some(2),
                retry_base_delay_ms: Some(250),
                no_proxy: true,
                extra_body: serde_json::Map::from_iter([(
                    "temperature".to_string(),
                    serde_json::json!(0.2),
                )]),
            },
        );

        settings.apply_provider(Some("custom")).unwrap();

        assert_eq!(settings.provider.as_deref(), Some("custom"));
        assert_eq!(settings.api_format, Some(ApiFormat::OpenaiResponses));
        assert_eq!(
            settings.base_url.as_deref(),
            Some("https://example.test/v1")
        );
        assert_eq!(settings.model, "example-model");
        assert_eq!(settings.context_window_tokens, Some(200_000));
        assert_eq!(settings.context_output_headroom, Some(20_000));
        assert_eq!(settings.auto_compact_threshold_tokens, Some(100_000));
        assert_eq!(settings.request_timeout_secs, Some(45));
        assert!(settings.provider_no_proxy);
        assert_eq!(settings.provider_extra_body["temperature"], 0.2);
        assert_eq!(settings.max_tokens, Some(12_000));
        assert_eq!(
            settings.openai_user_agent.as_deref(),
            Some("example-client/1.0")
        );
        assert_eq!(settings.max_retries, 2);
        assert_eq!(settings.retry_base_delay_ms, 250);
    }

    #[test]
    fn default_shell_timeout_and_foreground_budget_are_five_minutes() {
        let settings = Settings::default();

        assert_eq!(settings.tool_timeout_ms, 300_000);
        assert_eq!(
            settings.tool_limits.foreground_budget_ms.for_tool("bash"),
            300_000
        );
        assert_eq!(
            settings.tool_limits.task_output_timeout_ms.default_ms,
            5_000
        );
    }

    #[test]
    fn obsolete_tool_timeout_cap_is_not_serialized() {
        let value = serde_json::to_value(Settings::default()).unwrap();

        assert!(value.get("max_tool_timeout_ms").is_none());
    }

    #[test]
    fn default_tool_output_keeps_sixty_kib_head_and_forty_kib_tail() {
        let settings = Settings::default();

        assert_eq!(settings.max_tool_output_bytes, 100 * 1024);
        assert_eq!(settings.tool_limits.doom_loop.default_repetitions, 6);
        assert_eq!(settings.tool_limits.permission_denials.consecutive_limit, 2);
        assert_eq!(
            settings.tool_limits.doom_loop.tools.get("TaskOutput"),
            Some(&-1)
        );
        assert_eq!(settings.tool_output_head_bytes, 60 * 1024);
        assert_eq!(settings.tool_output_tail_bytes, 40 * 1024);
    }

    #[test]
    fn permission_denial_limit_parses_and_never_normalizes_below_one() {
        let mut settings: Settings = serde_json::from_str(
            r#"{"tool_limits":{"permission_denials":{"consecutive_limit":0}}}"#,
        )
        .unwrap();
        settings.normalize_runtime_limits();

        assert_eq!(settings.tool_limits.permission_denials.consecutive_limit, 1);
    }

    #[test]
    fn save_drops_default_identical_profiles_but_keeps_custom_ones() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        let mut settings = Settings::default();
        // A profile that differs from every embedded default must survive.
        let mut custom = crate::deployment::default_providers()["kunlunmeta"].clone();
        custom.default_model = "custom-x-model".to_string();
        custom.endpoint = "https://example.invalid".to_string();
        settings.providers.insert("custom-x".to_string(), custom);

        settings.save_to(&path).unwrap();

        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let profiles = persisted["providers"].as_object().unwrap();
        assert!(profiles.contains_key("custom-x"));
        for name in crate::deployment::default_providers().keys() {
            assert!(
                !profiles.contains_key(name),
                "default-identical profile {name} must not be persisted back"
            );
        }
    }

    #[test]
    fn save_keeps_embedded_profiles_that_are_declared_in_the_current_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        // The user explicitly declared kunlunmeta with the same value as the embedded default; saving must retain it.
        let declared = serde_json::json!({
            "active_provider": "kunlunmeta",
            "providers": {
                "kunlunmeta": crate::deployment::default_providers()["kunlunmeta"]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&declared).unwrap()).unwrap();

        let settings = Settings::default();
        settings.save_to(&path).unwrap();

        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let profiles = persisted["providers"].as_object().unwrap();
        assert_eq!(profiles.len(), 1);
        assert!(profiles.contains_key("kunlunmeta"));
    }

    #[test]
    fn bash_foreground_budget_can_be_overridden_from_config() {
        let settings: Settings = serde_json::from_str(
            r#"{"tool_timeout_ms":90000,"tool_limits":{"doom_loop":{"default_repetitions":8,"tools":{"TaskOutput":12,"Workflow":20}},"foreground_budget_ms":{"default_ms":2500,"tools":{"bash":1800,"PowerShell":2200}},"task_output_timeout_ms":{"default_ms":8000,"min_ms":2000,"max_ms":60000}}}"#,
        )
        .unwrap();

        assert_eq!(settings.tool_timeout_ms, 90_000);
        assert_eq!(
            settings.tool_limits.foreground_budget_ms.for_tool("bash"),
            1_800
        );
        assert_eq!(
            settings
                .tool_limits
                .foreground_budget_ms
                .for_tool("other-tool"),
            2_500
        );
        assert_eq!(
            settings.tool_limits.task_output_timeout_ms.default_ms,
            8_000
        );
        assert_eq!(settings.tool_limits.task_output_timeout_ms.min_ms, 2_000);
        assert_eq!(settings.tool_limits.task_output_timeout_ms.max_ms, 60_000);
        assert_eq!(settings.tool_limits.doom_loop.default_repetitions, 8);
        assert_eq!(
            settings.tool_limits.doom_loop.tools.get("TaskOutput"),
            Some(&12)
        );
        assert_eq!(
            settings.tool_limits.doom_loop.tools.get("Workflow"),
            Some(&20)
        );
    }

    #[test]
    fn tools_disabled_patterns_parse_from_settings_json() {
        let settings: Settings = serde_json::from_str(
            r#"{"tools":{"disabled":["Spec*","memory_*","LocalMemoryRecall"]}}"#,
        )
        .unwrap();

        assert_eq!(
            settings.tools.disabled,
            vec!["Spec*", "memory_*", "LocalMemoryRecall"]
        );
        assert!(Settings::default().tools.disabled.is_empty());
    }

    #[test]
    fn tdd_gate_setting_parses_and_defaults_to_auto() {
        assert_eq!(Settings::default().tdd_gate, TddGateSetting::Auto);
        let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"off"}"#).unwrap();
        assert_eq!(settings.tdd_gate, TddGateSetting::Off);
        let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"preferred"}"#).unwrap();
        assert_eq!(settings.tdd_gate, TddGateSetting::Preferred);
        let settings: Settings = serde_json::from_str(r#"{"tdd_gate":"required"}"#).unwrap();
        assert_eq!(settings.tdd_gate, TddGateSetting::Required);
    }

    #[test]
    fn luna_tool_profile_defaults_to_a_small_platform_specific_allowlist() {
        let allowed = Settings::default().tools.luna.allowed;

        assert_eq!(allowed.len(), 20);
        for required in [
            "glob",
            "grep",
            "read",
            "edit",
            "write",
            "TaskOutput",
            "TaskStop",
            "skill",
            "TodoWrite",
            "spawn_agent",
            "SendMessage",
            "wait",
            "close_agent",
            "WebSearch",
            "WebFetch",
            "DiscoverSkills",
            "explore_agent",
            "ocr",
            "Workflow",
        ] {
            assert!(allowed.iter().any(|name| name == required));
        }
        if cfg!(windows) {
            assert!(allowed.iter().any(|name| name == "PowerShell"));
            assert!(!allowed.iter().any(|name| name == "bash"));
        } else {
            assert!(allowed.iter().any(|name| name == "bash"));
            assert!(!allowed.iter().any(|name| name == "PowerShell"));
        }
    }

    #[test]
    fn luna_tool_profile_can_be_overridden_from_settings_json() {
        let settings: Settings =
            serde_json::from_str(r#"{"tools":{"luna":{"allowed":["read","grep"]}}}"#).unwrap();

        assert_eq!(settings.tools.luna.allowed, vec!["read", "grep"]);
    }

    #[test]
    fn tui_alternate_screen_settings_match_codex_mode_names() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "tui": {
                    "alternate_screen": "auto"
                }
            }"#,
        )
        .unwrap();

        assert_eq!(settings.tui.alternate_screen, TuiAltScreenMode::Auto);
        assert!(!settings.tui.no_alt_screen);
        assert_eq!(
            serde_json::to_value(settings.tui.alternate_screen).unwrap(),
            serde_json::Value::String("auto".to_string())
        );
    }

    #[test]
    fn tui_settings_default_to_fullscreen_and_skip_cli_override() {
        let settings: Settings = serde_json::from_str("{}").unwrap();

        assert_eq!(settings.tui.alternate_screen, TuiAltScreenMode::Auto);
        assert!(!settings.tui.no_alt_screen);

        let mut settings = Settings::default();
        settings.tui.no_alt_screen = true;
        let serialized = serde_json::to_value(&settings).unwrap();
        assert_eq!(serialized["tui"]["alternate_screen"], "auto");
        assert!(serialized["tui"].get("no_alt_screen").is_none());
    }

    #[test]
    fn tui_path_preview_defaults_schema_and_layer_override() {
        let defaults: Settings = serde_json::from_str("{}").unwrap();
        assert!(!defaults.tui.path_preview.enabled);
        let mut user = serde_json::json!({"tui":{"path_preview":{"enabled":true}}});
        schema::validate_settings_schema(&user).unwrap();
        let parsed: Settings = serde_json::from_value(user.clone()).unwrap();
        assert!(parsed.tui.path_preview.enabled);
        merge_settings_documents(
            &mut user,
            serde_json::json!({"tui":{"path_preview":{"enabled":false}}}),
        );
        let parsed: Settings = serde_json::from_value(user).unwrap();
        assert!(!parsed.tui.path_preview.enabled);
        let invalid = serde_json::json!({"tui":{"path_preview":{"enabled":"true"}}});
        assert!(schema::validate_settings_schema(&invalid).is_err());
        assert!(serde_json::from_value::<Settings>(invalid).is_err());
    }

    #[test]
    fn tui_path_preview_project_overrides_user_file() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        let executable = temp.path().join("bin");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&executable).unwrap();
        std::fs::create_dir_all(project.join(".kcoder")).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"tui":{"path_preview":{"enabled":true}}}"#,
        )
        .unwrap();
        let load = || {
            SettingsLoader::new(&project)
                .with_config_dir(&config)
                .with_executable_dir(&executable)
                .load()
                .unwrap()
        };
        assert!(load().settings.tui.path_preview.enabled);
        std::fs::write(
            project.join(".kcoder/settings.json"),
            r#"{"tui":{"path_preview":{"enabled":false}}}"#,
        )
        .unwrap();
        let loaded = load();
        assert!(!loaded.settings.tui.path_preview.enabled);
        assert_eq!(
            loaded.field_sources["tui.path_preview.enabled"],
            ConfigScope::Project
        );
        std::fs::write(
            project.join(".kcoder/settings.local.json"),
            r#"{"tui":{"path_preview":{"enabled":true}}}"#,
        )
        .unwrap();
        let loaded = load();
        assert!(loaded.settings.tui.path_preview.enabled);
        assert_eq!(
            loaded.field_sources["tui.path_preview.enabled"],
            ConfigScope::Local
        );
        let overlay = temp.path().join("setting_test.jsonc");
        std::fs::write(&overlay, r#"{"tui":{"path_preview":{"enabled":false}}}"#).unwrap();
        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable)
            .with_overlay_files([overlay])
            .load()
            .unwrap();
        assert!(!loaded.settings.tui.path_preview.enabled);
        assert!(loaded.overlay_fields.contains("tui.path_preview.enabled"));
    }

    #[test]
    fn training_mode_is_runtime_only_and_cannot_be_loaded_from_settings_json() {
        let mut settings = Settings::default();
        settings.enable_training_mode();

        let serialized = serde_json::to_value(&settings).unwrap();
        assert!(serialized.get("training_mode").is_none());

        let loaded: Settings = serde_json::from_str(r#"{"training_mode":true}"#).unwrap();
        assert!(!loaded.training_mode);
    }

    #[test]
    fn auto_tool_memory_defaults_to_enabled_for_old_configs() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.auto_memory_enabled);
        assert!(settings.auto_tool_memory_enabled);
        assert!(settings.memory.structured_enabled);
        assert!(settings.memory.skip_tools.is_empty());
        assert!(settings.memory.legacy_prompt_enabled);
        assert!(!settings.memory.private_by_default);
        assert!(!settings.memory.private_file_paths);
        assert!(!settings.memory.private_verification_targets);
        assert!(settings.memory.record_prompt_placeholders);
        assert_eq!(
            settings.memory.observer_mode,
            MemoryObserverMode::Deterministic
        );
        assert_eq!(settings.memory.observer_queue_size, 128);
        assert!(settings.memory.observer_model.is_none());
    }

    #[test]
    fn plugin_settings_additive_defaults_match_installation_contract() {
        let settings: Settings = serde_json::from_str("{}").unwrap();

        assert!(settings.plugins.runtime.enabled);
        assert_eq!(
            settings.plugins.runtime.project_policy,
            PluginProjectPolicy::TrustedOnly
        );
        assert!(settings.plugins.compatibility.agent_plugins_v1);
        assert!(settings.plugins.compatibility.codex);
        assert_eq!(settings.plugins.installation.max_files, 10_000);
        assert_eq!(
            settings.plugins.installation.max_total_bytes,
            256 * 1024 * 1024
        );
        assert_eq!(
            settings.plugins.installation.max_file_bytes,
            32 * 1024 * 1024
        );
        assert_eq!(settings.plugins.installation.timeout_ms, 120_000);
        assert!(settings.plugins.installed.is_empty());
    }

    #[test]
    fn plugin_user_policy_preserves_explicit_disable() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "plugins": {
                    "installed": {
                        "demo@local": {
                            "enabled": false,
                            "skills": { "enabled": true },
                            "hooks": { "enabled": false }
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        let policy = settings.plugins.installed.get("demo@local").unwrap();

        assert_eq!(policy.enabled, Some(false));
        assert_eq!(policy.skills.enabled, Some(true));
        assert_eq!(policy.hooks.enabled, Some(false));
    }

    #[test]
    fn moa_defaults_reuse_the_active_runtime() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        let preset = settings
            .moa
            .presets
            .get(settings.moa.default_preset.as_str())
            .unwrap();

        assert!(settings.moa.enabled);
        assert_eq!(settings.moa.default_preset, "default");
        assert_eq!(
            preset.reference_models,
            vec![MoaModelConfig::new("current", "current")]
        );
        assert_eq!(preset.aggregator, MoaModelConfig::new("current", "current"));
    }

    #[test]
    fn moa_token_limits_accept_null_for_defaulting_at_runtime() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "moa": {
                    "presets": {
                        "default": {
                            "reference_max_tokens": null,
                            "aggregator_max_tokens": null
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        let preset = settings.moa.presets.get("default").unwrap();

        assert_eq!(preset.reference_max_tokens, None);
        assert_eq!(preset.aggregator_max_tokens, None);
    }

    #[test]
    fn settings_save_is_atomic() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        let settings = Settings {
            model: "test-model".into(),
            ..Settings::default()
        };
        // Direct write to temp path then rename, mirroring save logic.
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, serde_json::to_string_pretty(&settings).unwrap()).unwrap();
        fs::rename(&tmp_path, &path).unwrap();
        assert!(path.exists());
        let loaded: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.model, "test-model");
    }

    #[test]
    fn skill_review_mode_is_not_persisted() {
        let settings = Settings {
            auto_skill_review_enabled: true,
            ..Settings::default()
        };
        let serialized = serde_json::to_value(&settings).unwrap();
        assert!(serialized.get("auto_skill_review_enabled").is_none());
        assert_eq!(
            serialized["skills"]["auto_skill_review_enabled"],
            serde_json::Value::Bool(false)
        );

        let loaded: Settings =
            serde_json::from_str(r#"{"auto_skill_review_enabled":true}"#).unwrap();
        assert!(!loaded.auto_skill_review_enabled);
    }

    #[test]
    fn skills_settings_default_to_governance_plan_values() {
        let loaded: Settings = serde_json::from_str("{}").unwrap();

        assert!(loaded.skills.auto_curator_enabled);
        assert_eq!(loaded.skills.auto_curator_interval_hours, 168);
        assert_eq!(loaded.skills.auto_curator_min_idle_hours, 2);
        assert_eq!(loaded.skills.stale_after_days, 30);
        assert_eq!(loaded.skills.archive_after_days, 90);
        assert!(!loaded.skills.prune_builtins);
        assert!(!loaded.skills.trust_external);
        assert!(!loaded.skills.auto_lessons_learned);
        assert!(loaded.skills.external_dirs.is_empty());
        assert!(loaded.skills.guard.enabled);
        assert!(loaded.skills.guard.block_high_risk);
        assert!(loaded.skills.guard.block_medium_risk_for_community);
    }

    #[test]
    fn default_subagent_concurrency_cap_is_four() {
        assert_eq!(
            Settings::default().max_concurrent_subagents,
            MAX_CONCURRENT_SUBAGENTS
        );
        assert_eq!(MAX_CONCURRENT_SUBAGENTS, 4);
    }

    #[test]
    fn default_subagent_max_turns_is_configurable_and_clamped() {
        assert_eq!(
            Settings::default().default_subagent_max_turns,
            DEFAULT_SUBAGENT_MAX_TURNS
        );

        let loaded: Settings =
            serde_json::from_str(r#"{"default_subagent_max_turns":120}"#).unwrap();
        assert_eq!(loaded.default_subagent_max_turns, 120);

        let legacy: Settings = serde_json::from_str(r#"{"subagent_max_turns":90}"#).unwrap();
        assert_eq!(legacy.default_subagent_max_turns, 90);

        let mut settings = Settings {
            default_subagent_max_turns: 0,
            ..Settings::default()
        };
        settings.normalize_runtime_limits();
        assert_eq!(settings.default_subagent_max_turns, MIN_SUBAGENT_MAX_TURNS);

        settings.default_subagent_max_turns = MAX_SUBAGENT_MAX_TURNS + 1;
        settings.normalize_runtime_limits();
        assert_eq!(settings.default_subagent_max_turns, MAX_SUBAGENT_MAX_TURNS);
    }

    #[test]
    fn summary_defaults_fall_back_to_main_runtime() {
        assert_eq!(Settings::default().summary_provider, None);
        assert_eq!(Settings::default().summary_profile, None);
        assert_eq!(Settings::default().summary_model, None);

        let loaded: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(loaded.summary_provider, None);
        assert_eq!(loaded.summary_profile, None);
        assert_eq!(loaded.summary_model, None);
    }

    #[test]
    fn summary_provider_and_model_null_fall_back_to_main_runtime() {
        let loaded: Settings =
            serde_json::from_str(r#"{"summary_provider":null,"summary_model":null}"#).unwrap();
        assert_eq!(loaded.summary_provider, None);
        assert_eq!(loaded.summary_model, None);
    }

    #[test]
    fn goal_pro_verifier_settings_default_and_override() {
        let defaults = Settings::default();
        assert!(defaults.goal_pro.is_default());
        assert_eq!(defaults.goal_pro.verifier_max_turns, 64);
        assert_eq!(defaults.goal_pro.completion_rejection_limit, 8);
        assert!(defaults.goal_pro.verification.require_tests);
        assert!(!defaults.goal_pro.verification.require_behavior_delta);
        assert_eq!(
            defaults.goal_pro.verification.minimum_test_scope,
            GoalProTestScope::TargetSuite
        );
        assert!(defaults.goal_pro.verification.require_raw_exit_code);
        assert!(!defaults.goal_pro.verification.allow_workspace_changes);
        assert!(defaults.goal_pro.verification.isolate_environment);
        assert!(!defaults.goal_pro.verification.allow_dependency_changes);
        assert!(defaults.goal_pro.verification.allow_network_only_failures);

        let missing_goal_pro: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(missing_goal_pro.goal_pro.verifier_max_turns, 64);
        assert_eq!(missing_goal_pro.goal_pro.completion_rejection_limit, 8);
        let missing_limit: Settings = serde_json::from_str(r#"{"goal_pro":{}}"#).unwrap();
        assert_eq!(missing_limit.goal_pro.verifier_max_turns, 64);
        assert_eq!(missing_limit.goal_pro.completion_rejection_limit, 8);

        let loaded: Settings = serde_json::from_str(
            r#"{
                "goal_pro": {
                    "verifier_profile": "mimo-review",
                    "verifier_provider": "kunlunmeta",
                    "verifier_model": "mimo-v2.5",
                    "verifier_max_turns": 9,
                    "completion_rejection_limit": 5,
                    "verification": {
                        "require_behavior_delta": true,
                        "minimum_test_scope": "focused",
                        "allow_network_only_failures": false
                    }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(
            loaded.goal_pro.verifier_profile.as_deref(),
            Some("mimo-review")
        );
        assert_eq!(
            loaded.goal_pro.verifier_provider.as_deref(),
            Some("kunlunmeta")
        );
        assert_eq!(loaded.goal_pro.verifier_model.as_deref(), Some("mimo-v2.5"));
        assert_eq!(loaded.goal_pro.verifier_max_turns, 9);
        assert_eq!(loaded.goal_pro.completion_rejection_limit, 5);
        assert_eq!(
            loaded.goal_pro.verification.minimum_test_scope,
            GoalProTestScope::Focused
        );
        assert!(loaded.goal_pro.verification.require_tests);
        assert!(loaded.goal_pro.verification.require_behavior_delta);
        assert!(!loaded.goal_pro.verification.allow_network_only_failures);
        assert_eq!(
            default_settings_document()["goal_pro"]["verifier_max_turns"],
            serde_json::json!(64)
        );
        assert_eq!(
            default_settings_document()["goal_pro"]["completion_rejection_limit"],
            serde_json::json!(8)
        );
    }

    #[test]
    fn orchestrate_defaults_are_materialized_and_safe() {
        let settings = Settings::default();
        assert!(settings.orchestrate.main.optional_tool_allowlist.is_none());
        assert_eq!(settings.orchestrate.continuation.max_auto_turns, 8);
        assert_eq!(settings.orchestrate.notepad.max_inject_bytes, 8192);
        assert_eq!(settings.orchestrate.delivery.lease_timeout_seconds, 120);
        assert_eq!(settings.orchestrate.delivery.max_attempts, 8);
        assert_eq!(settings.orchestrate.fleet.max_members, 24);
        assert_eq!(settings.orchestrate.fleet.max_inject_bytes, 8192);
        assert!(settings.orchestrate.control.enabled);
        assert!(settings.orchestrate.breaker.enabled);
        assert!(!settings.orchestrate.breaker.hard_stop);
        assert_eq!(settings.orchestrate.audit.max_events, 4096);
        assert_eq!(settings.orchestrate.critic_max_cycles, 3);
        assert_eq!(settings.orchestrate.roster["junior"].tier, "standard");
        assert_eq!(settings.orchestrate.roster["critic"].tier, "max");
        assert!(settings.orchestrate.tiers.contains_key("fast"));
    }

    #[test]
    fn orchestrate_main_optional_tool_allowlist_parses_as_a_shrinking_override() {
        let settings = validate_and_resolve_settings_document(&serde_json::json!({
            "orchestrate": {
                "main": {
                    "optional_tool_allowlist": ["memory_search", "WebSearch", "skill"]
                }
            }
        }))
        .unwrap();

        assert_eq!(
            settings.orchestrate.main.optional_tool_allowlist.as_deref(),
            Some(
                &[
                    "memory_search".to_string(),
                    "WebSearch".to_string(),
                    "skill".to_string()
                ][..]
            )
        );
    }

    #[test]
    fn orchestrate_main_optional_tool_allowlist_rejects_core_and_unknown_tools() {
        let protected = validate_and_resolve_settings_document(&serde_json::json!({
            "orchestrate": {
                "main": {"optional_tool_allowlist": ["spawn_agent"]}
            }
        }))
        .unwrap_err()
        .to_string();
        assert!(protected.contains("protected core capabilities"));

        let unknown = validate_and_resolve_settings_document(&serde_json::json!({
            "orchestrate": {
                "main": {"optional_tool_allowlist": ["bash"]}
            }
        }))
        .unwrap_err()
        .to_string();
        assert!(unknown.contains("unknown optional tools"));
    }

    #[test]
    fn orchestrate_roster_layers_merge_by_name_and_fields() {
        let mut document = default_settings_document();
        merge_settings_documents(
            &mut document,
            serde_json::json!({
                "orchestrate": {
                    "roster": {
                        "junior": {"tool_allowlist": ["read", "edit"]}
                    }
                }
            }),
        );
        merge_settings_documents(
            &mut document,
            serde_json::json!({
                "orchestrate": {
                    "roster": {
                        "junior": {"context_mode": "fork"}
                    }
                }
            }),
        );
        let settings = validate_and_resolve_settings_document(&document).unwrap();
        let junior = &settings.orchestrate.roster["junior"];
        assert_eq!(junior.tier, "standard");
        assert_eq!(
            junior.tool_allowlist.as_deref(),
            Some(&["read".to_string(), "edit".to_string()][..])
        );
        assert_eq!(junior.context_mode, OrchestrateContextMode::Fork);
    }

    #[test]
    fn orchestrate_rejects_unknown_persona_tier_provider_and_security_fields() {
        for value in [
            serde_json::json!({"orchestrate": {"roster": {"unknown": {"tier": "fast"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"junior": {"tier": "missing"}}}}),
            serde_json::json!({"orchestrate": {"tiers": {"fast": {"provider": "missing"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"junior": {"base_role": "general"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"junior": {"prompt": "expand"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"junior": {"profile": "other"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"critic": {"verdict": "text"}}}}),
            serde_json::json!({"orchestrate": {"roster": {"oracle": {"tool_allowlist": ["read", "bash"]}}}}),
        ] {
            assert!(
                validate_and_resolve_settings_document(&value).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn orchestrate_reliability_settings_reject_values_outside_schema_bounds() {
        for value in [
            serde_json::json!({"orchestrate": {"delivery": {"lease_timeout_seconds": 29}}}),
            serde_json::json!({"orchestrate": {"delivery": {"max_attempts": 0}}}),
            serde_json::json!({"orchestrate": {"fleet": {"max_members": 101}}}),
            serde_json::json!({"orchestrate": {"fleet": {"max_inject_bytes": 1023}}}),
            serde_json::json!({"orchestrate": {"breaker": {"repeated_action_threshold": 0}}}),
            serde_json::json!({"orchestrate": {"breaker": {"consecutive_error_threshold": 65}}}),
            serde_json::json!({"orchestrate": {"breaker": {"no_progress_rounds": 0}}}),
            serde_json::json!({"orchestrate": {"audit": {"max_events": 127}}}),
            serde_json::json!({"orchestrate": {"audit": {"max_event_bytes": 65_537}}}),
        ] {
            assert!(
                validate_and_resolve_settings_document(&value).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn orchestrate_full_context_rejects_an_incompatible_runtime() {
        let mut document = default_settings_document();
        document["providers"]["small"] = serde_json::json!({
            "credential_env": ["SMALL_KEY"],
            "api_format": "anthropic_messages",
            "endpoint": "https://example.test",
            "default_model": "small",
            "context_window_tokens": 4096,
            "output_headroom_tokens": 1024,
            "max_output_tokens": 1024
        });
        document["orchestrate"]["tiers"]["small"] = serde_json::json!({"profile": "small"});
        document["orchestrate"]["roster"]["junior"] =
            serde_json::json!({"tier": "small", "context_mode": "full"});

        let error = validate_and_resolve_settings_document(&document).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("context_mode=full is incompatible")
        );
    }

    #[test]
    fn goal_pro_verifier_models_default_empty_and_parse() {
        let defaults = Settings::default();
        assert!(defaults.goal_pro.verifier_models.is_empty());
        let missing: Settings = serde_json::from_str(r#"{"goal_pro":{}}"#).unwrap();
        assert!(missing.goal_pro.verifier_models.is_empty());
        assert_eq!(
            default_settings_document()["goal_pro"]["verifier_models"],
            serde_json::json!([])
        );

        let loaded: Settings = serde_json::from_str(
            r#"{
                "goal_pro": {
                    "verifier_models": [
                        { "profile": "mimo-review" },
                        { "provider": "kunlunmeta", "model": "mimo-v2.5" },
                        {}
                    ]
                }
            }"#,
        )
        .unwrap();
        assert_eq!(loaded.goal_pro.verifier_models.len(), 3);
        assert_eq!(
            loaded.goal_pro.verifier_models[0].profile.as_deref(),
            Some("mimo-review")
        );
        assert_eq!(
            loaded.goal_pro.verifier_models[1].provider.as_deref(),
            Some("kunlunmeta")
        );
        assert_eq!(
            loaded.goal_pro.verifier_models[1].model.as_deref(),
            Some("mimo-v2.5")
        );
        assert_eq!(loaded.goal_pro.verifier_models[2].profile, None);
        assert_eq!(loaded.goal_pro.verifier_models[2].provider, None);
        assert_eq!(loaded.goal_pro.verifier_models[2].model, None);
    }

    #[test]
    fn goal_pro_model_escalation_defaults_to_disabled_and_parses() {
        let defaults = Settings::default();
        assert!(!defaults.goal_pro.model_escalation.enabled);
        assert_eq!(defaults.goal_pro.model_escalation.threshold, 3);
        assert!(defaults.goal_pro.model_escalation.models.is_empty());
        assert!(defaults.goal_pro.is_default());
        assert_eq!(
            default_settings_document()["goal_pro"]["model_escalation"]["threshold"],
            serde_json::json!(3)
        );

        let loaded: Settings = serde_json::from_str(
            r#"{
                "goal_pro": {
                    "model_escalation": {
                        "enabled": true,
                        "threshold": 2,
                        "models": [{ "provider": "kunlunmeta", "model": "mimo-v2.5" }]
                    }
                }
            }"#,
        )
        .unwrap();
        assert!(loaded.goal_pro.model_escalation.enabled);
        assert_eq!(loaded.goal_pro.model_escalation.threshold, 2);
        assert_eq!(loaded.goal_pro.model_escalation.models.len(), 1);
        assert_eq!(
            loaded.goal_pro.model_escalation.models[0].model.as_deref(),
            Some("mimo-v2.5")
        );
        assert!(!loaded.goal_pro.is_default());
    }

    #[test]
    fn goal_auto_continuation_limit_defaults_to_eight_and_allows_override() {
        assert_eq!(Settings::default().goal_max_auto_continuations, 8);

        let missing: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.goal_max_auto_continuations, 8);

        let explicit: Settings =
            serde_json::from_str(r#"{"goal_max_auto_continuations":7}"#).unwrap();
        assert_eq!(explicit.goal_max_auto_continuations, 7);
        assert_eq!(
            default_settings_document()["goal_max_auto_continuations"],
            serde_json::json!(8)
        );
    }

    #[test]
    fn default_goal_pro_is_visible_to_dotted_config_queries() {
        let serialized = serde_json::to_value(Settings::default()).unwrap();

        assert_eq!(
            dotted_value(&serialized, "goal_pro.verifier_max_turns").unwrap(),
            Some(&serde_json::json!(64))
        );
        assert_eq!(
            dotted_value(&serialized, "goal_pro.completion_rejection_limit").unwrap(),
            Some(&serde_json::json!(8))
        );
        assert_eq!(
            dotted_value(&serialized, "goal_pro.verification.minimum_test_scope").unwrap(),
            Some(&serde_json::json!("target_suite"))
        );
        assert_eq!(
            dotted_value(&serialized, "goal_pro.verification.require_behavior_delta").unwrap(),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn settings_normalize_clamps_subagent_concurrency_cap() {
        let mut settings = Settings {
            max_concurrent_subagents: 0,
            ..Settings::default()
        };
        settings.normalize_runtime_limits();
        assert_eq!(settings.max_concurrent_subagents, MAX_CONCURRENT_SUBAGENTS);

        settings.max_concurrent_subagents = MAX_CONCURRENT_SUBAGENTS + 10;
        settings.normalize_runtime_limits();
        assert_eq!(settings.max_concurrent_subagents, MAX_CONCURRENT_SUBAGENTS);

        settings.max_concurrent_subagents = 2;
        settings.normalize_runtime_limits();
        assert_eq!(settings.max_concurrent_subagents, 2);
    }

    #[test]
    fn settings_normalize_rejects_a_zero_history_limit() {
        let mut settings = Settings {
            history_max_messages: 0,
            ..Settings::default()
        };

        settings.normalize_runtime_limits();

        assert_eq!(settings.history_max_messages, 1);
    }

    #[test]
    fn settings_normalize_expands_external_dir_home_paths() {
        let mut settings = Settings {
            skills: SkillsSettings {
                external_dirs: vec![PathBuf::from("~/team-skills")],
                ..SkillsSettings::default()
            },
            ..Settings::default()
        };

        settings.normalize_paths();

        let expected = dirs::home_dir()
            .map(|home| home.join("team-skills"))
            .unwrap_or_else(|| PathBuf::from("~/team-skills"));
        assert_eq!(settings.skills.external_dirs, vec![expected]);
    }

    #[test]
    fn project_key_uses_sanitized_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project with spaces");
        fs::create_dir_all(&root).unwrap();

        let project_dir = Settings::project_data_dir(&root).unwrap();
        let legacy_dir = Settings::legacy_project_data_dir(&root).unwrap();
        let project_key = project_dir.file_name().unwrap().to_string_lossy();
        let legacy_key = legacy_dir.file_name().unwrap().to_string_lossy();

        assert!(project_key.contains("project-with-spaces"));
        assert!(!project_key.contains("project_with_spaces"));
        assert!(legacy_key.contains("project_with_spaces"));
        assert_ne!(project_key, legacy_key);

        let read_dirs = Settings::project_data_dirs_for_read(&root).unwrap();
        assert_eq!(read_dirs.first(), Some(&project_dir));
        assert!(read_dirs.contains(&legacy_dir));
        assert_eq!(
            read_dirs.iter().collect::<HashSet<_>>().len(),
            read_dirs.len()
        );
    }

    #[cfg(windows)]
    #[test]
    fn project_data_read_dirs_preserve_verbatim_windows_compatibility() {
        let tmp = TempDir::new().unwrap();
        let current = Settings::project_data_dir(tmp.path()).unwrap();
        let read_dirs = Settings::project_data_dirs_for_read(tmp.path()).unwrap();
        let previous = Settings::projects_dir()
            .unwrap()
            .join(previous_project_key_for_path(tmp.path()));

        assert!(read_dirs.first().is_some_and(|dir| dir == &current));
        assert!(read_dirs.contains(&previous));
        assert!(
            !normalized_project_path(tmp.path())
                .to_string_lossy()
                .starts_with(r"\\?\")
        );
        assert!(
            previous_normalized_project_path(tmp.path())
                .to_string_lossy()
                .starts_with(r"\\?\")
        );
    }

    #[test]
    fn skills_settings_accept_persistent_skill_review_config() {
        let loaded: Settings = serde_json::from_str(
            r#"{
                "skills": {
                    "auto_skill_review_enabled": true,
                    "auto_skill_review_interval": 7
                }
            }"#,
        )
        .unwrap();

        assert!(loaded.skills.auto_skill_review_enabled);
        assert_eq!(loaded.skills.auto_skill_review_interval, 7);
    }

    #[test]
    fn settings_accept_provider_endpoint_and_key_fields() {
        let loaded: Settings = serde_json::from_str(
            r#"{
                "provider": "openai",
                "model": "kimi-for-coding/k2p6",
                "base_url": "https://models.example/v1",
                "api_key": "generic-key",
                "openai_base_url": "https://openai.example/v1",
                "openai_api_key": "openai-key",
                "kunlunmeta_base_url": "https://kunlunmeta.example",
                "kunlunmeta_api_key": "kunlunmeta-key",
                "gemini_base_url": "https://gemini.example"
            }"#,
        )
        .unwrap();

        assert_eq!(loaded.provider.as_deref(), Some("openai"));
        assert_eq!(loaded.model, "kimi-for-coding/k2p6");
        assert_eq!(
            loaded.base_url.as_deref(),
            Some("https://models.example/v1")
        );
        assert_eq!(loaded.api_key.as_deref(), Some("generic-key"));
        assert_eq!(
            loaded.openai_base_url.as_deref(),
            Some("https://openai.example/v1")
        );
        assert_eq!(loaded.openai_api_key.as_deref(), Some("openai-key"));
        assert_eq!(
            loaded.kunlunmeta_base_url.as_deref(),
            Some("https://kunlunmeta.example")
        );
        assert_eq!(loaded.kunlunmeta_api_key.as_deref(), Some("kunlunmeta-key"));
        assert_eq!(
            loaded.gemini_base_url.as_deref(),
            Some("https://gemini.example")
        );
    }

    #[test]
    fn moa_plan_settings_have_safe_defaults_and_accept_overrides() {
        let defaults = Settings::default();
        assert!(defaults.moa_plan.enabled);
        assert_eq!(defaults.moa_plan.preset, "default");
        assert_eq!(
            defaults.moa_plan.draft_max_turns,
            DEFAULT_SUBAGENT_MAX_TURNS
        );
        assert_eq!(defaults.moa_plan.draft_max_tokens, 16_384);
        assert_eq!(defaults.moa_plan.synthesis_max_tokens, 32_768);
        assert_eq!(defaults.moa_plan.draft_timeout_secs, 300);
        assert_eq!(defaults.moa_plan.max_planner_workers, 4);

        let loaded: Settings = serde_json::from_str(
            r#"{
                "moa_plan": {
                    "enabled": false,
                    "preset": "careful",
                    "draft_max_turns": 6,
                    "draft_max_tokens": 8192,
                    "synthesis_max_tokens": 16384,
                    "draft_timeout_secs": 90,
                    "max_planner_workers": 2
                }
            }"#,
        )
        .unwrap();

        assert!(!loaded.moa_plan.enabled);
        assert_eq!(loaded.moa_plan.preset, "careful");
        assert_eq!(loaded.moa_plan.draft_max_turns, 6);
        assert_eq!(loaded.moa_plan.draft_max_tokens, 8192);
        assert_eq!(loaded.moa_plan.synthesis_max_tokens, 16384);
        assert_eq!(loaded.moa_plan.draft_timeout_secs, 90);
        assert_eq!(loaded.moa_plan.max_planner_workers, 2);
    }

    #[test]
    fn plaintext_secret_setting_names_returns_only_populated_field_names() {
        let settings = Settings {
            api_key: Some("generic-secret".to_string()),
            kunlunmeta_api_key: Some("kunlunmeta-secret".to_string()),
            openai_api_key: Some("openai-secret".to_string()),
            ..Settings::default()
        };

        assert_eq!(
            settings.plaintext_secret_setting_names(),
            vec!["api_key", "kunlunmeta_api_key", "openai_api_key"]
        );
    }

    #[test]
    fn persisted_settings_omit_plaintext_secret_fields() {
        let settings = Settings {
            api_key: Some("generic-secret".to_string()),
            anthropic_api_key: Some("anthropic-secret".to_string()),
            kunlunmeta_api_key: Some("kunlunmeta-secret".to_string()),
            openai_api_key: Some("openai-secret".to_string()),
            local_api_key: Some("local-secret".to_string()),
            gemini_api_key: Some("gemini-secret".to_string()),
            grok_api_key: Some("grok-secret".to_string()),
            model: "kept-model".to_string(),
            base_url: Some("https://models.example/v1".to_string()),
            ..Settings::default()
        };

        let persisted = settings.without_plaintext_secrets();
        let serialized = serde_json::to_string_pretty(&persisted).unwrap();
        let direct_serialized = serde_json::to_string_pretty(&settings).unwrap();

        assert_eq!(persisted.model, "kept-model");
        assert_eq!(
            persisted.base_url.as_deref(),
            Some("https://models.example/v1")
        );
        for forbidden in [
            "api_key",
            "anthropic_api_key",
            "kunlunmeta_api_key",
            "openai_api_key",
            "local_api_key",
            "gemini_api_key",
            "grok_api_key",
            "generic-secret",
            "openai-secret",
            "kunlunmeta-secret",
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
            assert!(!direct_serialized.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn tools_file_edit_tool_defaults_to_edit_and_parses_apply_patch() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "tools": { "file_edit_tool": "apply_patch" }
        }))
        .expect("apply_patch should parse");
        assert_eq!(settings.tools.file_edit_tool, FileEditSurface::ApplyPatch);
        assert_eq!(FileEditSurface::default(), FileEditSurface::Edit);
        assert_eq!(FileEditSurface::ApplyPatch.as_str(), "apply_patch");
        assert_eq!(FileEditSurface::Edit.as_str(), "edit");
        assert!(
            serde_json::from_value::<Settings>(serde_json::json!({
                "tools": { "file_edit_tool": "patch" }
            }))
            .is_err(),
            "unknown surface values must be rejected"
        );
    }

    #[test]
    fn turn_file_changes_policy_defaults_and_schema_are_wired() {
        let settings = Settings::default();
        assert_eq!(
            settings.turn_file_changes,
            TurnFileChangesSettings::default()
        );

        let document = serde_json::json!({
            "turn_file_changes": {
                "max_file_bytes": 1048576,
                "ignore_globs": ["**/*.gguf"]
            }
        });
        crate::schema::validate_settings_schema(&document)
            .expect("embedded schema must accept turn_file_changes");

        let parsed: Settings = serde_json::from_value(serde_json::json!({
            "turn_file_changes": { "max_file_bytes": 1048576, "ignore_globs": ["**/*.gguf"] }
        }))
        .unwrap();
        assert_eq!(parsed.turn_file_changes.max_file_bytes, 1_048_576);
        assert_eq!(parsed.turn_file_changes.ignore_globs, vec!["**/*.gguf"]);
        assert_eq!(
            parsed.turn_file_changes.retention_days, 14,
            "defaults fill the rest"
        );
    }

    #[test]
    fn embedded_settings_schema_accepts_the_file_edit_tool_field() {
        // settings.schema.jsonc is the runtime validator (schema.rs:41) and its
        // tools object denies unknown properties, so the new field must be
        // declared there before settings with file_edit_tool can load at all.
        let document = serde_json::json!({ "tools": { "file_edit_tool": "apply_patch" } });
        crate::schema::validate_settings_schema(&document)
            .expect("embedded schema must accept tools.file_edit_tool");
    }
}
