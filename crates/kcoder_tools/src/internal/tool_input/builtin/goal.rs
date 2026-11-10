use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetGoalInput {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateGoalInput {
    /// Concrete long-running objective the user explicitly asked to pursue.
    pub objective: String,
    /// Optional token budget for the goal. Omit unless the user specified one.
    pub token_budget: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateGoalInput {
    /// New status. The model may only set `complete` or `blocked`.
    pub status: GoalToolStatus,
    /// Required when status is `blocked`; describe the concrete blocking condition.
    #[serde(default)]
    pub reason: Option<String>,
    /// Stable ID for the same external blocker across turns; optional, 1–128 ASCII letters/digits or . _ : -. Without it, exact trimmed reason text identifies the blocker.
    #[serde(default)]
    pub blocker_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GoalToolStatus {
    Complete,
    Blocked,
}

builtin_input!(GetGoalInput, CreateGoalInput, UpdateGoalInput);
