//! Passive source definitions retain data; no field grants execution or native Agent authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationDefinitionKind {
    Agent,
    Hook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationDefinitionFormat {
    ClaudeAgentMarkdown,
    CodexAgentToml,
    ClaudeHooksJson,
    CodexHooksJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationDefinitionParseStatus {
    Parsed,
    Malformed,
    Opaque,
    BudgetExceeded,
}

/// Only reviewed schema labels are public; arbitrary source keys remain anonymous ordinals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationDefinitionField {
    Name,
    Description,
    Instructions,
    Model,
    ReasoningEffort,
    ReasoningSummary,
    Verbosity,
    Tools,
    DisallowedTools,
    PermissionMode,
    Skills,
    McpServers,
    Hooks,
    Memory,
    Background,
    Isolation,
    Effort,
    Color,
    MaxTurns,
    Features,
    HookEvent,
    HookMatcher,
    HookType,
    HookCommand,
    HookPrompt,
    HookTimeout,
    HookAsync,
    HookStatusMessage,
    HookOnce,
    HookModel,
    HookArgs,
    HookDescription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum MigrationDefinitionHookEvent {
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PostToolUseFailure,
    Notification,
    UserPromptSubmit,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    SessionStart,
    SessionEnd,
    Interrupt,
    TeammateIdle,
    TaskCompleted,
    InstructionsLoaded,
    ConfigChange,
    WorktreeCreate,
    WorktreeRemove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionFieldReport {
    pub ordinal: u32,
    pub element: u32,
    pub field: Option<MigrationDefinitionField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<MigrationDefinitionHookEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDefinitionReport {
    pub kind: MigrationDefinitionKind,
    pub format: MigrationDefinitionFormat,
    pub parse_status: MigrationDefinitionParseStatus,
    /// Unknown totals stay unknown when the bounded parser could not inspect the input.
    pub elements: Option<u32>,
    pub fields: Vec<MigrationDefinitionFieldReport>,
    pub unknown_fields: Option<u32>,
    /// Storage is a pending asset; these fields never claim runtime compatibility.
    pub execution_allowed: bool,
    pub requires_review: bool,
}
