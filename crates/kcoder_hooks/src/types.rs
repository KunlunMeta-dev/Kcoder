use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Lifecycle events that can trigger hooks.
///
/// Complete hook-event list shared with the TypeScript client. Not all events are
/// implemented yet; unimplemented variants are accepted in configuration but
/// may be ignored by consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    SessionStart,
    SessionEnd,
    Setup,
    UserPromptSubmit,
    Stop,
    StopFailure,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    PermissionDenied,
    SandboxEscalationAttempt,
    SandboxEscalated,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    TeammateIdle,
    TaskCreated,
    TaskCompleted,
    Elicitation,
    ElicitationResult,
    Notification,
    ConfigChange,
    CwdChanged,
    FileChanged,
    InstructionsLoaded,
    WorktreeCreate,
    WorktreeRemove,
}

impl HookEvent {
    pub const ALL: &'static [HookEvent] = &[
        HookEvent::PreToolUse,
        HookEvent::PostToolUse,
        HookEvent::PostToolUseFailure,
        HookEvent::Notification,
        HookEvent::UserPromptSubmit,
        HookEvent::SessionStart,
        HookEvent::SessionEnd,
        HookEvent::Stop,
        HookEvent::StopFailure,
        HookEvent::SubagentStart,
        HookEvent::SubagentStop,
        HookEvent::PreCompact,
        HookEvent::PostCompact,
        HookEvent::PermissionRequest,
        HookEvent::PermissionDenied,
        HookEvent::SandboxEscalationAttempt,
        HookEvent::SandboxEscalated,
        HookEvent::Setup,
        HookEvent::TeammateIdle,
        HookEvent::TaskCreated,
        HookEvent::TaskCompleted,
        HookEvent::Elicitation,
        HookEvent::ElicitationResult,
        HookEvent::ConfigChange,
        HookEvent::WorktreeCreate,
        HookEvent::WorktreeRemove,
        HookEvent::InstructionsLoaded,
        HookEvent::CwdChanged,
        HookEvent::FileChanged,
    ];

    pub fn parse(name: &str) -> Option<Self> {
        // Support both PascalCase names from the TS source and snake_case
        // aliases used by serde/default Rust configs.
        let canonical = name
            .chars()
            .filter(|c| *c != '_' && *c != '-' && !c.is_whitespace())
            .collect::<String>()
            .to_ascii_lowercase();
        match canonical.as_str() {
            "sessionstart" => Some(HookEvent::SessionStart),
            "sessionend" => Some(HookEvent::SessionEnd),
            "setup" => Some(HookEvent::Setup),
            "userpromptsubmit" => Some(HookEvent::UserPromptSubmit),
            "stop" => Some(HookEvent::Stop),
            "stopfailure" => Some(HookEvent::StopFailure),
            "pretooluse" => Some(HookEvent::PreToolUse),
            "posttooluse" => Some(HookEvent::PostToolUse),
            "posttoolusefailure" => Some(HookEvent::PostToolUseFailure),
            "permissionrequest" => Some(HookEvent::PermissionRequest),
            "permissiondenied" => Some(HookEvent::PermissionDenied),
            "sandboxescalationattempt" => Some(HookEvent::SandboxEscalationAttempt),
            "sandboxescalated" => Some(HookEvent::SandboxEscalated),
            "subagentstart" => Some(HookEvent::SubagentStart),
            "subagentstop" => Some(HookEvent::SubagentStop),
            "precompact" => Some(HookEvent::PreCompact),
            "postcompact" => Some(HookEvent::PostCompact),
            "teammateidle" => Some(HookEvent::TeammateIdle),
            "taskcreated" => Some(HookEvent::TaskCreated),
            "taskcompleted" => Some(HookEvent::TaskCompleted),
            "elicitation" => Some(HookEvent::Elicitation),
            "elicitationresult" => Some(HookEvent::ElicitationResult),
            "notification" => Some(HookEvent::Notification),
            "configchange" => Some(HookEvent::ConfigChange),
            "cwdchanged" => Some(HookEvent::CwdChanged),
            "filechanged" => Some(HookEvent::FileChanged),
            "instructionsloaded" => Some(HookEvent::InstructionsLoaded),
            "worktreecreate" => Some(HookEvent::WorktreeCreate),
            "worktreeremove" => Some(HookEvent::WorktreeRemove),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            HookEvent::SessionStart => "SessionStart",
            HookEvent::SessionEnd => "SessionEnd",
            HookEvent::Setup => "Setup",
            HookEvent::UserPromptSubmit => "UserPromptSubmit",
            HookEvent::Stop => "Stop",
            HookEvent::StopFailure => "StopFailure",
            HookEvent::PreToolUse => "PreToolUse",
            HookEvent::PostToolUse => "PostToolUse",
            HookEvent::PostToolUseFailure => "PostToolUseFailure",
            HookEvent::PermissionRequest => "PermissionRequest",
            HookEvent::PermissionDenied => "PermissionDenied",
            HookEvent::SandboxEscalationAttempt => "SandboxEscalationAttempt",
            HookEvent::SandboxEscalated => "SandboxEscalated",
            HookEvent::SubagentStart => "SubagentStart",
            HookEvent::SubagentStop => "SubagentStop",
            HookEvent::PreCompact => "PreCompact",
            HookEvent::PostCompact => "PostCompact",
            HookEvent::TeammateIdle => "TeammateIdle",
            HookEvent::TaskCreated => "TaskCreated",
            HookEvent::TaskCompleted => "TaskCompleted",
            HookEvent::Elicitation => "Elicitation",
            HookEvent::ElicitationResult => "ElicitationResult",
            HookEvent::Notification => "Notification",
            HookEvent::ConfigChange => "ConfigChange",
            HookEvent::CwdChanged => "CwdChanged",
            HookEvent::FileChanged => "FileChanged",
            HookEvent::InstructionsLoaded => "InstructionsLoaded",
            HookEvent::WorktreeCreate => "WorktreeCreate",
            HookEvent::WorktreeRemove => "WorktreeRemove",
        }
    }
}

/// Origin metadata for a hook matcher. This is intentionally runtime-only:
/// User settings keep the simple JSON shape, while plugin
/// loaders attach source data after parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookSource {
    pub kind: HookSourceKind,
    pub id: String,
    pub name: String,
    pub root: std::path::PathBuf,
    /// Runtime provenance set by discovery, never accepted from settings JSON.
    #[serde(skip)]
    pub required_trust: Option<HookTrustRequirement>,
    /// Opaque resource ownership, not authorization. Never accepted from JSON.
    #[serde(skip)]
    pub runtime_guard: Option<std::sync::Arc<dyn std::fmt::Debug + Send + Sync>>,
}

impl PartialEq for HookSource {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.id == other.id
            && self.name == other.name
            && self.root == other.root
            && self.required_trust == other.required_trust
    }
}
impl Eq for HookSource {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookTrustRequirement {
    pub directory: std::path::PathBuf,
    pub config_dir: Option<std::path::PathBuf>,
}

impl HookSource {
    pub fn requiring_folder_trust(mut self, directory: impl Into<std::path::PathBuf>) -> Self {
        self.required_trust = Some(HookTrustRequirement {
            directory: directory.into(),
            config_dir: kcoder_config::user_config_dir().ok(),
        });
        self
    }

    pub fn project_settings(path: &std::path::Path, cwd: &std::path::Path) -> Self {
        Self {
            kind: HookSourceKind::Settings,
            id: path.display().to_string(),
            name: "project settings".to_owned(),
            root: cwd.to_path_buf(),
            required_trust: None,
            runtime_guard: None,
        }
        .requiring_folder_trust(cwd)
    }

    pub fn plugin(
        id: impl Into<String>,
        name: impl Into<String>,
        root: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self {
            kind: HookSourceKind::Plugin,
            id: id.into(),
            name: name.into(),
            root: root.into(),
            required_trust: None,
            runtime_guard: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookSourceKind {
    Settings,
    Plugin,
    Skill,
    Session,
}

impl HookSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookSourceKind::Settings => "settings",
            HookSourceKind::Plugin => "plugin",
            HookSourceKind::Skill => "skill",
            HookSourceKind::Session => "session",
        }
    }
}

/// A matcher grouping hooks under an event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMatcher {
    /// Optional pattern matched against the event's query field (e.g. tool name
    /// for tool events). Empty or missing means match all.
    #[serde(default)]
    pub matcher: Option<String>,
    /// Hooks to run when this matcher applies.
    pub hooks: Vec<HookCommand>,
    /// Runtime source metadata attached by plugin/session/skill loaders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<HookSource>,
}

/// A concrete hook action.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum HookCommand {
    /// Run a shell command.
    Command {
        /// Shell to use. Defaults to "bash".
        #[serde(default = "default_shell")]
        shell: String,
        /// Command line or script to execute.
        command: String,
        /// Optional permission-rule style filter (tool events only).
        #[serde(rename = "if", default)]
        if_rule: Option<String>,
        /// Timeout in seconds. Defaults to 600 (10 minutes).
        #[serde(default = "default_timeout_seconds")]
        timeout: u64,
        /// Whether to detach and run asynchronously.
        #[serde(default)]
        async_hook: bool,
    },
    /// Evaluate an LLM prompt.
    Prompt {
        prompt: String,
        #[serde(default = "default_prompt_timeout")]
        timeout: u64,
        #[serde(default)]
        model: Option<String>,
    },
    /// Spawn a sub-agent.
    Agent {
        instructions: String,
        #[serde(default = "default_agent_timeout")]
        timeout: u64,
        #[serde(default = "default_agent_max_turns")]
        max_turns: usize,
        #[serde(default)]
        model: Option<String>,
    },
    /// POST input JSON to a URL.
    Http {
        url: String,
        #[serde(default = "default_http_method")]
        method: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default = "default_timeout_seconds")]
        timeout: u64,
    },
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        "bash".to_string()
    }
}

fn default_timeout_seconds() -> u64 {
    600
}

fn default_http_method() -> String {
    "POST".to_string()
}

fn default_prompt_timeout() -> u64 {
    30
}

fn default_agent_timeout() -> u64 {
    60
}

fn default_agent_max_turns() -> usize {
    50
}

/// Input passed to every hook execution.
#[derive(Debug, Clone, Serialize)]
pub struct HookInput {
    pub event: HookEvent,
    #[serde(rename = "hook_event_name")]
    pub hook_event_name: String,
    /// Event-specific query, e.g. the tool name for tool events.
    pub query: String,
    /// The tool input for tool events, or the user message for submit events.
    pub data: Value,
    /// Additional context fields supplied by consumers.
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl HookInput {
    pub fn new(event: HookEvent, query: impl Into<String>, data: Value) -> Self {
        let mut extra = HashMap::new();
        // External UserPromptSubmit hooks expect a top-level prompt field.
        // Preserve data for existing KCoder hooks while providing the alias.
        if event == HookEvent::UserPromptSubmit {
            if let Some(prompt) = data.as_str() {
                extra.insert("prompt".to_string(), Value::String(prompt.to_string()));
            }
        }
        Self {
            event,
            hook_event_name: event.as_str().to_string(),
            query: query.into(),
            data,
            extra,
        }
    }

    pub fn with_extra(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra.insert(key.into(), value);
        self
    }
}

/// JSON output expected from a hook.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct HookJSONOutput {
    pub r#async: Option<bool>,
    pub r#continue: Option<bool>,
    #[serde(rename = "suppressOutput")]
    pub suppress_output: Option<bool>,
    #[serde(rename = "stopReason")]
    pub stop_reason: Option<String>,
    pub decision: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "systemMessage")]
    pub system_message: Option<String>,
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: Option<Value>,
}

/// A single hook result yielded during execution.
#[derive(Debug, Clone)]
pub struct HookResult {
    /// Human-readable description of the hook for progress messages.
    pub hook_description: String,
    /// Outcome of running this hook.
    pub outcome: HookOutcome,
}

#[derive(Debug, Clone)]
pub enum HookOutcome {
    /// Hook produced parsed effects.
    Effects(Vec<HookEffect>),
    /// Hook returned a non-JSON line or otherwise invalid output.
    InvalidOutput(String),
    /// Hook failed (non-zero exit, timeout, etc.).
    Error(String),
    /// Hook was skipped by policy.
    Skipped,
}

/// An effect produced by a hook that consumers can act on.
#[derive(Debug, Clone)]
pub enum HookEffect {
    /// Show a message to the user.
    Message { text: String, is_error: bool },
    /// Block continuation with an error message.
    BlockingError { message: String },
    /// Stop the assistant from continuing this turn.
    PreventContinuation { reason: Option<String> },
    /// Permission decision (tool events only).
    PermissionDecision {
        behavior: HookPermissionBehavior,
        updated_input: Option<Value>,
        reason: Option<String>,
    },
    /// Replace the tool input with a modified value.
    UpdatedInput(Value),
    /// Inject additional context into the conversation.
    AdditionalContext(String),
    /// Register file paths to watch.
    WatchPaths(Vec<std::path::PathBuf>),
    /// Provide a worktree path.
    WorktreePath(std::path::PathBuf),
}

/// Permission behavior returned by a hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookPermissionBehavior {
    Allow,
    Deny,
    Ask,
}

impl HookPermissionBehavior {
    /// Aggregate multiple behaviors with precedence: deny > ask > allow.
    pub fn aggregate(behaviors: &[Self]) -> Option<Self> {
        let mut result = None;
        for b in behaviors {
            match b {
                Self::Deny => return Some(Self::Deny),
                Self::Ask => result = Some(Self::Ask),
                Self::Allow if result.is_none() => result = Some(Self::Allow),
                _ => {}
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_hook_exposes_prompt_without_replacing_legacy_data() {
        let input = HookInput::new(
            HookEvent::UserPromptSubmit,
            "",
            serde_json::json!("find Endor findings"),
        );
        let payload = serde_json::to_value(input).unwrap();
        assert_eq!(payload["prompt"], "find Endor findings");
        assert_eq!(payload["data"], payload["prompt"]);
        assert_eq!(payload["hook_event_name"], "UserPromptSubmit");
        let tool = HookInput::new(
            HookEvent::PreToolUse,
            "Bash",
            serde_json::json!({"command":"echo hello"}),
        );
        assert!(serde_json::to_value(tool).unwrap().get("prompt").is_none());
    }
}
