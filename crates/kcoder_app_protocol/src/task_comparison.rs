//! Explicit alternatives backed by existing managed worktrees and Engine threads.
use crate::ReviewArtifact;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TASK_COMPARISON_V1: &str = "taskComparisonV1";
pub const TASK_COMPARISON_BIND: &str = "runtime.worktrees.comparison.bind";
pub const TASK_COMPARISON_READ: &str = "runtime.worktrees.comparison.read";
pub const TASK_COMPARISON_SELECT: &str = "runtime.worktrees.comparison.select";
pub const MAX_TASK_COMPARISON_CANDIDATES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonSelection {
    pub head_commit: String,
    pub content_token: String,
    pub selected_at_ms: u64,
}

/// Stored inside the existing managed-worktree registry, never a separate task store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonBinding {
    pub comparison_id: String,
    pub owner_thread_id: String,
    pub device_id: String,
    pub requirement: String,
    pub label: String,
    pub task_id: String,
    pub thread_id: String,
    pub branch: String,
    pub base_commit: String,
    pub selection: Option<TaskComparisonSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonReadParams {
    pub source_path: String,
    pub device_id: String,
    pub comparison_id: String,
    pub owner_thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonBindParams {
    pub source_path: String,
    pub device_id: String,
    pub comparison_id: String,
    pub owner_thread_id: String,
    pub requirement: String,
    pub label: String,
    pub path: String,
    pub expected_revision: u64,
    pub task_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonSelectParams {
    pub source_path: String,
    pub device_id: String,
    pub comparison_id: String,
    pub owner_thread_id: String,
    pub thread_id: String,
    pub expected_revision: u64,
    pub expected_head_commit: String,
    pub expected_content_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonGit {
    pub head_commit: String,
    pub branch: Option<String>,
    pub content_token: String,
    pub dirty: bool,
    pub diff_preview: String,
    pub status_preview: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TaskComparisonCheckOutcome {
    Passed,
    Failed,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonCheck {
    pub evidence_id: String,
    pub turn_id: String,
    pub attempt_id: String,
    pub ordinal: u32,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub outcome: TaskComparisonCheckOutcome,
    pub exit_code: Option<i32>,
    pub output_preview: Option<String>,
    pub details_truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonUsage {
    /// Counts cover the bounded visible transcript, not the entire provider bill.
    pub assistant_messages: u32,
    pub usage_samples: u32,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_microusd: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonCandidate {
    pub worktree_id: String,
    pub path: String,
    pub source_path: String,
    pub revision: u64,
    pub state: String,
    pub binding: TaskComparisonBinding,
    pub git: Option<TaskComparisonGit>,
    pub result_preview: Option<String>,
    pub checks: Vec<TaskComparisonCheck>,
    pub artifacts: Vec<ReviewArtifact>,
    pub evidence_partial: bool,
    pub usage: TaskComparisonUsage,
    pub unavailable: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComparisonReadResult {
    pub source_path: String,
    pub device_id: String,
    pub comparison_id: String,
    pub owner_thread_id: String,
    pub requirement: Option<String>,
    pub candidates: Vec<TaskComparisonCandidate>,
    pub selected_thread_id: Option<String>,
}
