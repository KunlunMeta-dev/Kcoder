use crate::{
    AgentRunResult, AgentRunner, AgentRuntimeSelection, Tool, ToolContext, ToolError, ToolOutput,
    VerifierRunOptions, clean_schema, parse_input,
};
use async_trait::async_trait;
use kcoder_config::GoalProTestScope;
use kcoder_config::PrivateDirectory;
use kcoder_state::{
    Goal, GoalStatus, GoalVerificationCommitOutcome, GoalVerificationKind, GoalVerificationVerdict,
    goal_report_relative_path, prepare_goal_objective,
};
use kcoder_types::{ContentBlock, Message};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const RECENT_COMPLETION_GATE_TOOL_RESULTS: usize = 8;
const GOAL_REPORT_MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone)]
struct GoalReportSnapshot {
    relative_path: PathBuf,
    text: String,
    sha256: String,
}

#[derive(Debug, Clone)]
struct GoalObjectiveSnapshot {
    text: String,
    sha256: Option<String>,
}

#[derive(Debug, Default)]
pub struct GetGoalTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetGoalInput {}

#[derive(Debug, Default)]
pub struct CreateGoalTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateGoalInput {
    /// Concrete long-running objective the user explicitly asked to pursue.
    pub objective: String,
    /// Optional token budget for the goal. Omit unless the user specified one.
    pub token_budget: Option<u64>,
}

#[derive(Debug, Default)]
pub struct UpdateGoalTool;

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

#[derive(Debug, Serialize)]
struct GoalToolResponse {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    goal: Option<Goal>,
}

#[async_trait]
impl Tool for GetGoalTool {
    fn name(&self) -> String {
        "get_goal".to_string()
    }

    fn description(&self) -> String {
        "Get the current `/goal` objective, status, token budget, tokens used, and elapsed time. \
         Use this before deciding whether a persistent goal objective is complete or blocked."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(GetGoalInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _input: GetGoalInput = parse_input(&input)?;
        let goal = ctx.state.goal();
        respond(GoalToolResponse {
            success: true,
            message: goal
                .as_ref()
                .map(|g| format!("Current goal status: {}", g.status.as_str()))
                .unwrap_or_else(|| "No goal is currently defined.".to_string()),
            goal,
        })
    }
}

#[async_trait]
impl Tool for CreateGoalTool {
    fn name(&self) -> String {
        "create_goal".to_string()
    }

    fn description(&self) -> String {
        "Create a persistent `/goal` objective only when the user explicitly asks for one. \
         Fails if an unfinished goal already exists. The user controls pause, resume, and clear \
         through slash commands; the model should not use this to replace an existing objective."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CreateGoalInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CreateGoalInput = parse_input(&input)?;
        let objective = input.objective.trim();
        if objective.is_empty() {
            return Err(ToolError::InvalidInput(
                "objective cannot be empty".to_string(),
            ));
        }
        if input.token_budget == Some(0) {
            return Err(ToolError::InvalidInput(
                "token_budget must be greater than 0".to_string(),
            ));
        }
        if let Some(existing) = ctx.state.goal()
            && existing.status.is_unfinished()
        {
            return respond(GoalToolResponse {
                success: false,
                message: format!(
                    "An unfinished goal already exists with status `{}`. Ask the user to start the new `/goal` themselves and confirm replacement, or run `/goal clear` first.",
                    existing.status.as_str()
                ),
                goal: Some(existing),
            });
        }

        let prepared = prepare_goal_objective(ctx.state.cwd(), objective).map_err(|e| {
            ToolError::Execution(format!("failed to prepare goal objective: {e:#}"))
        })?;
        let materialized = prepared.materialized;
        let goal = ctx
            .state
            .set_goal_prepared_with_mode_and_verification(
                prepared.objective,
                prepared.objective_file,
                input.token_budget,
                kcoder_state::GoalMode::Standard,
                GoalVerificationKind::Artifact,
            )
            .map_err(|_| {
                ToolError::Execution(
                    "Goal persistence failed; reload the session before retrying".into(),
                )
            })?;
        respond(GoalToolResponse {
            success: true,
            message: if materialized {
                "Goal created and activated. Long objective was saved to an attachment file."
                    .to_string()
            } else {
                "Goal created and activated.".to_string()
            },
            goal: Some(goal),
        })
    }
}

#[async_trait]
impl Tool for UpdateGoalTool {
    fn name(&self) -> String {
        "update_goal".to_string()
    }

    fn description(&self) -> String {
        "Update the persistent `/goal` status. The model may only set `complete` when the \
         objective is genuinely achieved, or `blocked` after the same blocking condition has \
         repeated for at least three consecutive goal turns and no meaningful progress can be \
         made without user input or an external state change. Supply `reason` for blocked so the \
         runtime audits consecutive outer Engine executions (not API retries or tool rounds). \
         Use the same blocker_id for an unchanged blocker; otherwise exact trimmed reason text identifies it. A budget-limited goal may still \
         receive this final verdict when the wrap-up shows the objective was reached or is \
         genuinely blocked. Verifier/provider/protocol infrastructure failures never count as \
         the blocking condition and cannot accumulate the blocked audit. Do not use this to \
         pause, resume, cancel, clear, or budget-limit a goal; \
         those are controlled by the user or runtime."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(UpdateGoalInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: UpdateGoalInput = parse_input(&input)?;
        let status = match input.status {
            GoalToolStatus::Complete => GoalStatus::Complete,
            GoalToolStatus::Blocked => GoalStatus::Blocked,
        };
        let Some(current_goal) = ctx.state.goal() else {
            return respond(GoalToolResponse {
                success: false,
                message: "No goal exists to update.".to_string(),
                goal: None,
            });
        };
        // The final verdict is accepted from an active goal, and also from a
        // budget-limited one: when the token budget trips mid-turn the model
        // still wraps up the in-flight response, and its complete/blocked
        // verdict in that wrap-up is more truthful than the budget_limited
        // fallback the runtime already recorded.
        let verdict_allowed =
            current_goal.status.is_active() || current_goal.status == GoalStatus::BudgetLimited;
        if !verdict_allowed {
            return respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Goal update rejected because the current goal is {}. The model may only mark an active or budget-limited goal complete or blocked.",
                    current_goal.status.as_str()
                ),
                goal: Some(current_goal),
            });
        }
        let mut verdict_revision = current_goal.revision;
        if status == GoalStatus::Blocked {
            let reason = input
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .ok_or_else(|| {
                    ToolError::InvalidInput("reason is required when status is blocked".to_string())
                })?;
            if blocked_reason_is_verifier_infrastructure(reason) {
                return respond_error(GoalToolResponse {
                    success: false,
                    message: "Goal blocked update rejected without recording a blocked candidate: a verifier/provider/protocol infrastructure failure is not an external blocker and never counts toward the three-turn blocked audit. The goal remains active; continue useful work or retry completion after correcting the verification evidence."
                        .to_string(),
                    goal: Some(current_goal),
                });
            }
            let blocker_id = input.blocker_id.as_deref();
            if blocker_id.is_some_and(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            }) {
                return Err(ToolError::InvalidInput(
                    "blocker_id must be 1–128 ASCII letters/digits or . _ : -".into(),
                ));
            }
            let fingerprint = blocked_reason_fingerprint(&match blocker_id {
                Some(id) => format!("id:{id}"),
                None => format!("reason:{}", reason.trim()),
            });
            let Some(candidate) = ctx.state.record_goal_blocked_candidate_details(
                &fingerprint,
                blocker_id,
                Some(reason),
                Some((&current_goal.goal_id, current_goal.revision)),
            ) else {
                return respond_error(GoalToolResponse {
                    success: false,
                    message: "Goal blocked candidate could not be recorded because the goal state changed."
                        .to_string(),
                    goal: ctx.state.goal(),
                });
            };
            verdict_revision = candidate.revision;
            if candidate.blocked_candidate_count < 3 {
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Blocked candidate recorded for goal turn {} ({}/3 consecutive turns). Keep working when meaningful progress is possible; the same blocking condition must recur on three consecutive goal turns before the goal can be marked blocked.",
                        candidate.turn_count, candidate.blocked_candidate_count
                    ),
                    goal: Some(candidate),
                });
            }
        }
        if status == GoalStatus::Complete
            && let Some(evidence) = recent_completion_failure_evidence(ctx)
        {
            let outcome = ctx.state.record_goal_completion_rejected_if_matches(
                &current_goal.goal_id,
                current_goal.revision,
                &evidence,
                true,
            );
            let goal_status = verification_commit_status_message(&outcome);
            return respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Goal completion rejected because recent tool output still contains failure evidence: {evidence}. {goal_status} Rerun an unmasked verification command that proves the failure is resolved before marking the goal complete."
                ),
                goal: outcome_goal(outcome),
            });
        }
        if status == GoalStatus::Complete && current_goal.mode.is_strict() {
            return verify_strict_completion(ctx, &current_goal).await;
        }
        let Some(goal) =
            ctx.state
                .commit_goal_model_status(&current_goal.goal_id, verdict_revision, status)
        else {
            return respond_error(GoalToolResponse {
                success: false,
                message: "Goal update rejected because the goal changed or was cancelled."
                    .to_string(),
                goal: ctx.state.goal(),
            });
        };
        let message = if status == GoalStatus::Complete {
            format!(
                "Goal marked complete. Final usage: {} tokens, {} seconds.",
                goal.tokens_used, goal.time_used_seconds
            )
        } else {
            "Goal marked blocked. The user must resume or clear it.".to_string()
        };
        respond(GoalToolResponse {
            success: true,
            message,
            goal: Some(goal),
        })
    }
}

fn blocked_reason_fingerprint(reason: &str) -> String {
    format!("{:x}", Sha256::digest(reason.trim().as_bytes()))
}
fn respond(response: GoalToolResponse) -> Result<ToolOutput, ToolError> {
    serde_json::to_string(&response)
        .map(ToolOutput::text)
        .map_err(|e| ToolError::Execution(format!("failed to serialize response: {e}")))
}

fn respond_error(response: GoalToolResponse) -> Result<ToolOutput, ToolError> {
    serde_json::to_string(&response)
        .map(ToolOutput::error)
        .map_err(|e| ToolError::Execution(format!("failed to serialize response: {e}")))
}

mod verifier_panel;
use verifier_panel::*;

mod completion;
use completion::*;

mod evidence;
pub use evidence::parse_verifier_verdict;
use evidence::*;

mod verdict;
use verdict::*;

mod report;
use report::*;

mod tool_evidence;
use tool_evidence::*;

#[cfg(test)]
mod tests;
