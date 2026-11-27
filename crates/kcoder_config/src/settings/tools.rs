//! Tools configuration types and their defaults.

pub use kcoder_types::StudioToolSelections;

use crate::*;

pub const REVIEW_TOOL_NAME: &str = "review";
pub const LEGACY_REVIEW_TOOL_NAME: &str = "ocr";

/// Match existing exact or prefix rules against the current built-in review name.
pub fn configured_tool_name_matches(name: &str, pattern: &str) -> bool {
    let matches = |candidate: &str| {
        if let Some(prefix) = pattern.strip_suffix('*') {
            candidate.starts_with(prefix)
        } else {
            candidate == pattern
        }
    };
    matches(name) || name == REVIEW_TOOL_NAME && matches(LEGACY_REVIEW_TOOL_NAME)
}

/// Project legacy explicit selections onto the name presented in new catalogs.
pub fn normalize_review_tool_selection(names: &mut Vec<String>) {
    if !names.iter().any(|name| name == LEGACY_REVIEW_TOOL_NAME) {
        return;
    }
    let mut review_seen = false;
    names.retain_mut(|name| {
        if name == LEGACY_REVIEW_TOOL_NAME {
            *name = REVIEW_TOOL_NAME.into();
        }
        name != REVIEW_TOOL_NAME || !std::mem::replace(&mut review_seen, true)
    });
}

/// Product defaults only. An explicit tools.disabled list remains authoritative.
pub const DEFAULT_DISABLED_BUILTIN_TOOLS: &[&str] = &[
    "EnterWorktree",
    "ExitWorktree",
    "WorktreeCreate",
    "WorktreeRemove",
    "cron_create",
    "cron_delete",
    "cron_list",
    "SpecInit",
    "SpecNewChange",
    "SpecArchive",
    "SpecStatus",
    "SpecUpdate",
    "SpecCheck",
    "SpecSync",
    "SpecRecordVerification",
    "SpecReview",
    "SpecParallelDraft",
    "SpecConfig",
    "AskUserQuestionAsync",
    "EnterPlanMode",
    "ExitPlanMode",
    "VerifyPlanExecution",
    REVIEW_TOOL_NAME,
    "skill_manage",
    "skill_curator",
    "skill_hub",
    "CtxInspect",
    "LocalMemoryRecall",
];

pub fn default_disabled_builtin_tools() -> Vec<String> {
    DEFAULT_DISABLED_BUILTIN_TOOLS
        .iter()
        .map(|name| (*name).to_owned())
        .collect()
}

#[cfg(test)]
#[path = "default_tool_tests.rs"]
mod default_tool_tests;

/// Additional agent tools in the default KWorker surface.
pub const KWORKER_DEFAULT_AGENT_TOOLS: &[&str] = &[
    "spawn_agent",
    "explore_agent",
    "SendMessage",
    "wait",
    "close_agent",
];
/// Independent-session tools supplied by the running host.
pub const KWORKER_DEFAULT_SESSION_TOOLS: &[&str] = &[
    "ListSessions",
    "ReadSession",
    "SendSessionMessage",
    "GetSessionMessageReceipt",
    "ListSessionMessageReceipts",
];
/// Ordinary KWorker tasks can manage work and retain structured project memory.
pub const KWORKER_DEFAULT_TASK_TOOLS: &[&str] = &[
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskOutput",
    "TaskStop",
    "Config",
    "Sleep",
    "remember",
    "memory_search",
    "memory_get",
];
/// Workflow tools in the default KWorker surface.
pub const KWORKER_DEFAULT_WORKFLOW_TOOLS: &[&str] = &["Workflow", "WorkflowDraft"];
/// Personal Wiki tools; the host registers them only when the user enabled each switch.
pub const KWORKER_DEFAULT_KNOWLEDGE_TOOLS: &[&str] = &["Wiki", "WikiManage"];
/// Shell tools in the default KWorker surface, filtered by host availability later.
pub const KWORKER_DEFAULT_SHELL_TOOLS: &[&str] = &["bash", "PowerShell"];

/// Resolve legacy KWorker defaults from the configured Luna surface.
pub fn kworker_default_tool_names(luna: &[String]) -> Vec<String> {
    let mut names = luna.to_vec();
    names.extend(
        KWORKER_DEFAULT_AGENT_TOOLS
            .iter()
            .chain(KWORKER_DEFAULT_SESSION_TOOLS)
            .chain(KWORKER_DEFAULT_TASK_TOOLS)
            .chain(KWORKER_DEFAULT_WORKFLOW_TOOLS)
            .chain(KWORKER_DEFAULT_SHELL_TOOLS)
            .chain(KWORKER_DEFAULT_KNOWLEDGE_TOOLS)
            .chain(["show_widget", "tool_search", "tool_execute"].iter())
            .map(|name| (*name).to_owned()),
    );
    names.sort();
    names.dedup();
    names
}

/// Validate exact tool names without interpreting wildcard characters.
/// This validates configuration shape, not availability in a target's registry.
pub fn validate_studio_tool_selections(selections: &StudioToolSelections) -> anyhow::Result<()> {
    for (mode, names) in [
        ("kcoder", &selections.kcoder),
        ("kworker", &selections.kworker),
    ] {
        let Some(names) = names else { continue };
        anyhow::ensure!(
            names.len() <= 1024,
            "tools.studio.{mode}: at most 1024 tool names are allowed"
        );
        let mut seen = std::collections::HashSet::new();
        for name in names {
            anyhow::ensure!(
                !name.is_empty()
                    && name.len() <= 256
                    && name.trim() == name
                    && !name.chars().any(char::is_control),
                "tools.studio.{mode}: tool names must have 1..256 bytes, no surrounding whitespace or control characters"
            );
            anyhow::ensure!(
                seen.insert(name),
                "tools.studio.{mode}: duplicate tool name"
            );
        }
    }
    Ok(())
}

fn deserialize_studio_tool_selections<'de, D>(
    deserializer: D,
) -> Result<StudioToolSelections, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let selections = StudioToolSelections::deserialize(deserializer)?;
    validate_studio_tool_selections(&selections).map_err(serde::de::Error::custom)?;
    Ok(selections)
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

/// Explicit built-in tool registry profile, fixed when a runtime starts.
/// Provider IDs, model names and endpoint addresses never select this value.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolProfile {
    #[default]
    Full,
    Core,
    Nano,
    None,
}

impl ToolProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Core => "core",
            Self::Nano => "nano",
            Self::None => "none",
        }
    }
}

/// Tool-system settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolsSettings {
    /// Studio mode selections; sessions retain their creation-time snapshot.
    #[serde(default, deserialize_with = "deserialize_studio_tool_selections")]
    pub studio: StudioToolSelections,
    /// Explicit startup registry. CLI --tool-profile overrides this setting;
    /// changing a settings file does not rebuild an already running registry.
    #[serde(default)]
    pub profile: ToolProfile,
    #[serde(default)]
    pub coerce: ToolCoercionConfig,
    /// Small tool surface activated by `/luna` for less capable models.
    #[serde(default)]
    pub luna: LunaToolProfileSettings,
    /// Tool name patterns removed from the registry entirely: matching tools
    /// are never offered to the model and cannot be invoked. Supports exact
    /// names and `prefix*` globs (for example "Spec*", "memory_*").
    #[serde(default = "default_disabled_builtin_tools")]
    pub disabled: Vec<String>,
    /// Which file-edit tool the model sees: `"edit"` (default) or
    /// `"apply_patch"`. Selected when the session starts and pinned for the
    /// session's lifetime; both tools stay registered, and the inactive one is
    /// hidden from tool definitions and rejected at execution.
    #[serde(default)]
    pub file_edit_tool: FileEditSurface,
    /// Keep extension tools (plugin, MCP and native host features) out of the
    /// attached tool list and reach them through `tool_search`/`tool_execute`.
    /// Explicitly selected tools stay attached. `false` attaches extensions
    /// directly in KCoder mode and the CLI/TUI; KWorker keeps its own default
    /// selection either way.
    #[serde(default = "default_defer_extensions")]
    pub defer_extensions: bool,
}

fn default_defer_extensions() -> bool {
    true
}

impl Default for ToolsSettings {
    fn default() -> Self {
        Self {
            studio: Default::default(),
            profile: Default::default(),
            coerce: Default::default(),
            luna: Default::default(),
            disabled: default_disabled_builtin_tools(),
            file_edit_tool: Default::default(),
            defer_extensions: default_defer_extensions(),
        }
    }
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

pub(crate) fn default_luna_allowed_tools() -> Vec<String> {
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
        "Workflow",
        "REPL",
        "AskUserQuestion",
        "WebBrowser",
        "ContextHistory",
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

/// Configurable limits applied to named tools.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolLimitsSettings {
    #[serde(default)]
    pub doom_loop: DoomLoopSettings,
    /// Foreground blocking budgets indexed by tool name.
    #[serde(default)]
    pub foreground_budget_ms: NamedToolLimitSettings,
    /// Per-tool total lifetime overrides; missing names use tool_timeout_ms.
    #[serde(default = "default_execution_timeout_ms")]
    pub execution_timeout_ms: BTreeMap<String, u64>,
    /// Blocking timeout policy used by TaskOutput.
    #[serde(default)]
    pub task_output_timeout_ms: TaskOutputTimeoutSettings,
    /// Circuit-breaker policy for repeated denial of one capability in non-interactive permission modes.
    #[serde(default)]
    pub permission_denials: PermissionDenialLimitSettings,
}

pub const DEFAULT_SHELL_TIMEOUT_MS: u64 = 30 * 60 * 1000;

fn default_execution_timeout_ms() -> BTreeMap<String, u64> {
    [
        ("bash".to_string(), DEFAULT_SHELL_TIMEOUT_MS),
        ("PowerShell".to_string(), DEFAULT_SHELL_TIMEOUT_MS),
    ]
    .into_iter()
    .collect()
}

impl Default for ToolLimitsSettings {
    fn default() -> Self {
        Self {
            doom_loop: DoomLoopSettings::default(),
            foreground_budget_ms: NamedToolLimitSettings::default(),
            execution_timeout_ms: default_execution_timeout_ms(),
            task_output_timeout_ms: TaskOutputTimeoutSettings::default(),
            permission_denials: PermissionDenialLimitSettings::default(),
        }
    }
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
