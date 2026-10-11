//! Tools configuration types and their defaults.

use crate::*;

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
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolsSettings {
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
