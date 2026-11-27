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
    /// Final verdict.
    pub status: GoalToolStatus,
    /// Concrete blocking condition; required for `blocked`.
    #[serde(default)]
    pub reason: Option<String>,
    /// Stable ID (1–128 ASCII letters/digits or . _ : -) for the same blocker across turns; otherwise the exact trimmed reason identifies it.
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
