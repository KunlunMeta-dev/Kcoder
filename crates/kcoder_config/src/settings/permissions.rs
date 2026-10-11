//! Permissions configuration types and their defaults.

use crate::*;

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

/// Action half of a permission rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAction {
    Allow,
    Deny,
}
