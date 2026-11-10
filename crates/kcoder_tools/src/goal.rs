use crate::{
    AgentRunResult, AgentRunner, AgentRuntimeSelection, Tool, ToolContext, ToolError, ToolOutput,
    VerifierRunOptions,
};
use async_trait::async_trait;
use kcoder_config::GoalProTestScope;
use kcoder_config::PrivateDirectory;
use kcoder_state::{
    Goal, GoalStatus, GoalVerificationCommitOutcome, GoalVerificationKind, GoalVerificationVerdict,
    goal_report_relative_path, prepare_goal_objective,
};
pub use kcoder_tool_input::builtin::goal::{
    CreateGoalInput, GetGoalInput, GoalToolStatus, UpdateGoalInput,
};
use kcoder_types::{ContentBlock, Message};
use serde::Serialize;
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

#[derive(Debug, Default)]
pub struct CreateGoalTool;

#[derive(Debug, Default)]
pub struct UpdateGoalTool;

#[derive(Debug, Serialize)]
struct GoalToolResponse {
    success: bool,
    message: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_public_goal"
    )]
    goal: Option<Goal>,
}

fn serialize_public_goal<S: serde::Serializer>(
    goal: &Option<Goal>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    goal.as_ref()
        .map(Goal::public_native_budget_projection)
        .transpose()
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
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
        GetGoalInput::schema()
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _input: GetGoalInput = GetGoalInput::parse(&input)?;
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
        CreateGoalInput::schema()
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CreateGoalInput = CreateGoalInput::parse(&input)?;
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
         objective is genuinely achieved; `complete` is rejected while this session still has \
         running background work, a finished background result not yet received, or an \
         unanswered user question, so wait for and inspect those first. Set `blocked` only \
         after the same blocking condition has \
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
        UpdateGoalInput::schema()
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: UpdateGoalInput = UpdateGoalInput::parse(&input)?;
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
            && let Some(pending) = unsettled_completion_work(ctx)
        {
            return respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Goal completion rejected because work this goal depends on has not settled: {pending}. The goal remains active; wait for and inspect those results, or get the answer, before marking the goal complete."
                ),
                goal: Some(current_goal),
            });
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

/// Facts that make a completion verdict premature: background work still
/// running, a finished background result the conversation has not received
/// yet, or a user question nobody answered. Internal maintenance jobs and
/// foreground-delivered jobs never block. Returns a bounded description.
fn unsettled_completion_work(ctx: &ToolContext) -> Option<String> {
    let mut running = Vec::new();
    let mut undelivered = Vec::new();
    for task in ctx.state.tasks().into_values() {
        if !task.notify_parent_on_completion
            || task.delivery != kcoder_state::TaskDelivery::Background
            || task.description.starts_with("[internal:")
        {
            continue;
        }
        match task.status {
            kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running => {
                running.push(task.id);
            }
            // Only a run-keyed terminal result has an authoritative delivery
            // record; a suppressed run is settled even though nothing is shown.
            _ => {
                if let Some(key) = &task.background_run
                    && ctx.state.background_run_record(key).is_some_and(|record| {
                        record.terminal.is_some()
                            && record.delivered_message_id.is_none()
                            && !record.suppressed
                    })
                {
                    undelivered.push(task.id);
                }
            }
        }
    }
    let unanswered = ctx
        .state
        .try_inspection_lifecycle_identity()
        .and_then(|owner| ctx.state.list_async_questions(&owner, false).ok())
        .map(|questions| {
            questions
                .iter()
                .filter(|question| {
                    question.status
                        == kcoder_types::async_user_questions::AsyncQuestionStatus::Pending
                })
                .count()
        })
        .unwrap_or(0);
    let mut reasons = Vec::new();
    for (label, mut ids) in [
        ("background work still running", running),
        ("background results not yet received", undelivered),
    ] {
        if ids.is_empty() {
            continue;
        }
        ids.sort();
        let shown = ids.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        let more = ids.len().saturating_sub(5);
        reasons.push(if more == 0 {
            format!("{label} ({shown})")
        } else {
            format!("{label} ({shown} and {more} more)")
        });
    }
    if unanswered > 0 {
        reasons.push(format!("{unanswered} user question(s) still unanswered"));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
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
