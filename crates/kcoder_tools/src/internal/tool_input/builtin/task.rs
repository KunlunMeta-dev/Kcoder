use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskCreateInput {
    /// Brief user-visible task title.
    pub subject: String,
    /// What needs to be done and why it matters.
    pub description: String,
    /// Present-continuous form shown in the spinner when in progress, e.g.
    /// `Running tests`.
    #[serde(rename = "activeForm")]
    pub active_form: Option<String>,
    /// Optional arbitrary metadata object. Values must be valid JSON.
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskUpdateInput {
    /// ID of the task to update.
    #[serde(rename = "taskId")]
    pub task_id: String,
    /// Optional replacement subject.
    pub subject: Option<String>,
    /// Optional replacement description.
    pub description: Option<String>,
    /// Optional replacement present-continuous form shown while in progress.
    #[serde(rename = "activeForm")]
    pub active_form: Option<String>,
    /// Optional new status enum: `pending`, `in_progress`, `completed`, or
    /// `deleted`.
    pub status: Option<TaskUpdateStatus>,
    /// Task IDs that this task blocks. Must be a JSON array of strings.
    #[serde(rename = "addBlocks")]
    pub add_blocks: Option<Vec<String>>,
    /// Task IDs that block this task. Must be a JSON array of strings.
    #[serde(rename = "addBlockedBy")]
    pub add_blocked_by: Option<Vec<String>>,
    /// Optional owner name or agent identifier.
    pub owner: Option<String>,
    /// Metadata keys to merge into the task. Set a key to null to delete it.
    /// Values must be valid JSON.
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskUpdateStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskListInput {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskGetInput {
    /// The ID of the task to retrieve.
    #[serde(rename = "taskId")]
    pub task_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskOutputInput {
    /// Exact run to inspect; defaults to the run active when this call starts.
    #[serde(default)]
    pub run_id: Option<String>,
    /// ID of the background task to inspect.
    pub task_id: String,
    /// JSON boolean. Set true only when the result is on the current critical
    /// path; false performs a non-blocking status/output check.
    #[serde(default = "default_block")]
    pub block: bool,
    /// Maximum wait time in milliseconds when `block=true`. Use a JSON integer.
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskStopInput {
    /// ID of the background task to stop. Omit only when using the deprecated
    /// `shell_id` alias.
    pub task_id: Option<String>,
    /// Deprecated alias for task_id. Prefer `task_id`.
    pub shell_id: Option<String>,
}

fn default_block() -> bool {
    false
}

builtin_input!(
    TaskCreateInput,
    TaskUpdateInput,
    TaskListInput,
    TaskGetInput,
    TaskOutputInput,
    TaskStopInput
);
