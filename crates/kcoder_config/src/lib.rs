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
pub use schema::{ensure_user_settings_schema, settings_schema_for_path};
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
mod model_sources;
pub use model_sources::{ModelConfigurationFieldSources, ModelConfigurationSources};
mod loader;
pub use loader::{
    CONFIG_DIR_ENV, ConfigPaths, ConfigScope, ConfigSource, CredentialStore, KCODER_HOME_ENV,
    LoadedSettings, ModelRuntimeOverrides, SettingsLoader, dotted_value, ensure_project_gitignore,
    merge_settings_documents, read_scope, read_settings_file, remove_dotted_value,
    set_dotted_value, update_scope, update_settings_and_credentials, update_settings_file,
    user_config_dir, validate_and_resolve_settings_document, write_scope, write_scope_if_missing,
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
mod request_body;
pub use request_body::{MAX_EXTRA_BODY_BYTES, validate_extra_body};
mod provider_credentials;
pub use provider_credentials::{
    ProviderApiKeySource, ProviderCredential, ResolvedProviderApiKey, builtin_credential_env,
    builtin_provider_credentials, validate_provider_id,
};

pub use kcoder_types::{McpServerConfig, ReasoningEffort, SandboxConfig};

mod provider_models;
pub use provider_models::ProviderModelConfig;
mod model_request_snapshot;
pub use model_request_snapshot::ModelRequestSnapshot;
mod model_endpoint_snapshot;
pub use model_endpoint_snapshot::ModelEndpointSnapshot;

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
    /// Explicit revocations loaded from the private credential document.
    #[serde(default, skip)]
    pub revoked_provider_credentials: std::collections::BTreeSet<String>,
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
    #[serde(default)]
    pub model_reasoning_policy: Option<kcoder_types::ModelReasoningPolicy>,
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
    #[serde(default)]
    pub provider_chat_protocol: kcoder_types::ChatProtocol,
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
    /// Opt-in personal Wiki settings, independent of Agent Memory.
    #[serde(default)]
    pub knowledge: KnowledgeSettings,
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

/// Maximum verifier-panel membership; excess entries are truncated when snapshotting.
pub const GOAL_PRO_VERIFIER_PANEL_MAX: usize = 5;

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
        self.model_reasoning_policy = provider.reasoning_policy;
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
        self.provider_chat_protocol = provider.chat_protocol;
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
            self.model_reasoning_policy = effective.reasoning_policy;
            self.provider_extra_body = effective.extra_body;
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
            // Older unbounded keys can exceed the filesystem's component limit.
            // Such a directory could never have been created on this platform;
            // probing it turns an absent compatibility path into ENAMETOOLONG
            // and incorrectly marks otherwise healthy session lists incomplete.
            #[cfg(windows)]
            let component_length = key.encode_utf16().count();
            #[cfg(not(windows))]
            let component_length = key.len();
            if component_length > 255 {
                continue;
            }
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
mod tests;

mod reasoning_policy;
pub use reasoning_policy::validate_reasoning_policy;

mod settings;
use settings::defaults::*;
pub use settings::*;
