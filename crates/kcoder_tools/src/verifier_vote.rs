//! Structured final-verdict tool for Goal Pro verifiers.
//!
//! This changes only the verdict expression channel from free-form parsing to a
//! structured tool call. `infrastructure_error` remains runtime-only, while machine
//! gates, rejection accounting, and session isolation remain unchanged. A vote is
//! binding once accepted by the runtime, and each verifier session accepts only its first vote.

use std::collections::HashSet;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::context::ToolContext;
use crate::{Tool, ToolError, ToolOutput, clean_schema, parse_input};

/// Tool-name constant shared across crates for terminal-turn filtering and tool-surface assembly.
pub const VERIFIER_VOTE_TOOL_NAME: &str = "VerifierVote";

/// Final verdict that a Goal Pro verifier may declare.
///
/// `infrastructure_error` is deliberately not deserializable and can be determined
/// only by the runtime. A model can neither classify its own validation-environment
/// failure as infrastructure to avoid accounting nor override it with Pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerifierVoteOutcome {
    Pass,
    Fail,
    Flaky,
}

impl VerifierVoteOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Flaky => "flaky",
        }
    }

    pub fn into_goal_verdict(self) -> kcoder_state::GoalVerificationVerdict {
        match self {
            Self::Pass => kcoder_state::GoalVerificationVerdict::Pass,
            Self::Fail => kcoder_state::GoalVerificationVerdict::Fail,
            Self::Flaky => kcoder_state::GoalVerificationVerdict::Flaky,
        }
    }
}

/// Model-reported executed command. This is informational only and does not affect
/// runtime adjudication; the engine-authenticated trace independently establishes evidence validity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
pub struct VerifiedCommand {
    /// Exact command that was run.
    pub command: String,
    /// Original exit code.
    pub exit_code: i32,
    /// Output summary.
    pub output_summary: String,
    /// Whether the same command reproduced this failure on the pristine baseline.
    #[serde(default)]
    pub baseline_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, JsonSchema)]
pub struct VerifierVoteInput {
    /// Final verdict. `infrastructure_error` cannot be declared by the model;
    /// it is produced by the runtime only.
    pub verdict: VerifierVoteOutcome,
    /// Required one-sentence conclusion.
    pub summary: String,
    /// Required (non-empty) for fail/flaky: the concrete reason for rejection
    /// and the work the main agent must still do.
    #[serde(default)]
    pub rejection_reason: Option<String>,
    /// Advisory only: key commands that were run (verbatim command, raw exit
    /// code, output summary).
    #[serde(default)]
    pub commands: Option<Vec<VerifiedCommand>>,
    /// Advisory only: tool_use ids actually executed in this verifier session.
    /// Cross-checked against the engine-authenticated trace.
    #[serde(default)]
    pub verified_tool_use_ids: Option<Vec<String>>,
}

/// Runtime-validated vote. `tool_use_id` comes from the provider tool_use block that initiated the call.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifierVoteRecord {
    pub input: VerifierVoteInput,
    pub tool_use_id: String,
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|error| error.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|error| error.into_inner())
}

/// Vote channel shared by a Goal Pro verifier session: vote slot plus engine-authenticated tool-call IDs.
///
/// Injected only into verifier-session [`ToolContext`]; always None for other
/// sessions. Both fields are shared handles whose clones point to the same state.
/// The engine records authenticated IDs when `EngineEvent::ToolResult` arrives,
/// before transcript persistence, so the model cannot forge them.
#[derive(Debug, Clone, Default)]
pub struct VerifierVoteChannel {
    vote: Arc<RwLock<Option<VerifierVoteRecord>>>,
    authenticated_tool_use_ids: Arc<RwLock<HashSet<String>>>,
}

impl VerifierVoteChannel {
    /// Currently accepted vote, if any.
    pub fn recorded_vote(&self) -> Option<VerifierVoteRecord> {
        read_lock(&self.vote).clone()
    }

    /// Record an ID when each ToolResult event reaches the engine.
    pub fn record_authenticated_tool_use(&self, id: &str) {
        write_lock(&self.authenticated_tool_use_ids).insert(id.to_string());
    }

    /// Whether an ID belongs to a tool call authenticated by this session's engine.
    pub fn is_authenticated_tool_use(&self, id: &str) -> bool {
        read_lock(&self.authenticated_tool_use_ids).contains(id)
    }

    /// The first vote is binding; reject every later call.
    ///
    /// Production accepts votes only through the `VerifierVote` tool. This is public
    /// so engine consumption-validation tests can construct a channel containing a vote.
    pub fn record_vote(&self, record: VerifierVoteRecord) -> Result<(), ToolError> {
        let mut vote = write_lock(&self.vote);
        if vote.is_some() {
            return Err(ToolError::Execution(
                "a verdict vote was already recorded in this verifier session; subsequent votes are ignored"
                    .to_string(),
            ));
        }
        *vote = Some(record);
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct VerifierVoteTool;

#[async_trait]
impl Tool for VerifierVoteTool {
    fn name(&self) -> String {
        VERIFIER_VOTE_TOOL_NAME.to_string()
    }

    fn description(&self) -> String {
        "Submit the final Goal Pro verifier verdict exactly once, after independent verification \
         is complete. verdict is pass, fail, or flaky; `infrastructure_error` cannot be voted \
         because it is determined by the runtime only — if your own verification environment \
         broke down, do not vote and explain the failure in your final text instead. summary is \
         a required one-sentence conclusion. rejection_reason is required and must be non-empty \
         for fail and flaky: state the concrete reason for rejection and the work the main agent \
         must still do. commands and verified_tool_use_ids are advisory evidence only; reference \
         only tool call ids that were actually executed in this verifier session — the runtime \
         cross-checks them against the engine-authenticated trace, and unknown ids reject the \
         vote. The first valid vote is binding and ends the verifier session."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(VerifierVoteInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: VerifierVoteInput = parse_input(&input)?;
        let Some(channel) = ctx.verifier_vote_channel.as_ref() else {
            return Err(ToolError::Execution(
                "VerifierVote is only available inside a Goal Pro verifier session".to_string(),
            ));
        };
        if input.summary.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "summary must be a non-empty one-sentence conclusion".to_string(),
            ));
        }
        let mut input = input;
        if matches!(input.verdict, VerifierVoteOutcome::Pass) {
            input.rejection_reason = None;
        } else {
            let reason_missing = input
                .rejection_reason
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty);
            if reason_missing {
                return Err(ToolError::InvalidInput(format!(
                    "rejection_reason is required and must be non-empty when verdict is \"{}\": \
                     state the concrete reason for rejection and the work the main agent must still do",
                    input.verdict.as_str()
                )));
            }
        }
        if let Some(ids) = input.verified_tool_use_ids.as_ref() {
            let unknown = ids
                .iter()
                .filter(|id| !channel.is_authenticated_tool_use(id))
                .cloned()
                .collect::<Vec<_>>();
            if !unknown.is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "verified_tool_use_ids must reference tool calls actually executed in this \
                     verifier session; unknown id(s): {}",
                    unknown.join(", ")
                )));
            }
        }
        let Some(tool_use_id) = ctx.tool_call_id.clone() else {
            return Err(ToolError::Execution(
                "VerifierVote could not determine its own tool_use id in this session".to_string(),
            ));
        };
        let verdict = input.verdict;
        channel.record_vote(VerifierVoteRecord { input, tool_use_id })?;
        Ok(ToolOutput::text(format!(
            "Verdict vote recorded: {}. This vote is binding and the verifier session is now \
             complete; do not call any further tools.",
            verdict.as_str()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    fn vote_input(verdict: VerifierVoteOutcome) -> VerifierVoteInput {
        VerifierVoteInput {
            verdict,
            summary: "结论".to_string(),
            rejection_reason: None,
            commands: None,
            verified_tool_use_ids: None,
        }
    }

    fn vote_json(verdict: &str) -> Value {
        serde_json::json!({
            "verdict": verdict,
            "summary": "focused checks passed",
        })
    }

    fn vote_context(channel: Option<&VerifierVoteChannel>) -> ToolContext {
        let mut ctx = ToolContext::new(AppState::new("/")).with_tool_call_id("vote-1");
        ctx.verifier_vote_channel = channel.cloned();
        ctx
    }

    #[test]
    fn outcome_serde_excludes_infrastructure_error() {
        assert_eq!(
            serde_json::from_str::<VerifierVoteOutcome>("\"pass\"").unwrap(),
            VerifierVoteOutcome::Pass
        );
        assert_eq!(
            serde_json::from_str::<VerifierVoteOutcome>("\"fail\"").unwrap(),
            VerifierVoteOutcome::Fail
        );
        assert_eq!(
            serde_json::from_str::<VerifierVoteOutcome>("\"flaky\"").unwrap(),
            VerifierVoteOutcome::Flaky
        );
        assert!(serde_json::from_str::<VerifierVoteOutcome>("\"infrastructure_error\"").is_err());
    }

    #[test]
    fn channel_accepts_first_vote_and_rejects_second() {
        let channel = VerifierVoteChannel::default();
        let record = VerifierVoteRecord {
            input: vote_input(VerifierVoteOutcome::Pass),
            tool_use_id: "vote-1".to_string(),
        };
        channel.record_vote(record.clone()).unwrap();
        assert_eq!(channel.recorded_vote(), Some(record));
        let second = VerifierVoteRecord {
            input: vote_input(VerifierVoteOutcome::Fail),
            tool_use_id: "vote-2".to_string(),
        };
        assert!(channel.record_vote(second).is_err());
        assert_eq!(
            channel.recorded_vote().map(|vote| vote.tool_use_id),
            Some("vote-1".to_string())
        );
    }

    #[test]
    fn channel_tracks_authenticated_tool_use_ids() {
        let channel = VerifierVoteChannel::default();
        assert!(!channel.is_authenticated_tool_use("bash-1"));
        channel.record_authenticated_tool_use("bash-1");
        assert!(channel.is_authenticated_tool_use("bash-1"));
        assert!(!channel.is_authenticated_tool_use("bash-2"));
    }

    #[tokio::test]
    async fn call_without_channel_is_rejected() {
        let ctx = vote_context(None);
        let error = VerifierVoteTool
            .call(vote_json("pass"), &ctx)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Goal Pro verifier session"));
    }

    #[tokio::test]
    async fn call_requires_non_empty_summary() {
        let channel = VerifierVoteChannel::default();
        let ctx = vote_context(Some(&channel));
        let error = VerifierVoteTool
            .call(
                serde_json::json!({"verdict": "pass", "summary": "   "}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("summary"));
        assert!(channel.recorded_vote().is_none());
    }

    #[tokio::test]
    async fn call_requires_rejection_reason_for_fail_and_flaky() {
        for verdict in ["fail", "flaky"] {
            let channel = VerifierVoteChannel::default();
            let ctx = vote_context(Some(&channel));
            let error = VerifierVoteTool
                .call(vote_json(verdict), &ctx)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("rejection_reason"), "{verdict}");
            assert!(channel.recorded_vote().is_none(), "{verdict}");

            let channel = VerifierVoteChannel::default();
            let ctx = vote_context(Some(&channel));
            let error = VerifierVoteTool
                .call(
                    serde_json::json!({
                        "verdict": verdict,
                        "summary": "结论",
                        "rejection_reason": "  ",
                    }),
                    &ctx,
                )
                .await
                .unwrap_err();
            assert!(error.to_string().contains("rejection_reason"), "{verdict}");
        }
    }

    #[tokio::test]
    async fn pass_vote_drops_rejection_reason() {
        let channel = VerifierVoteChannel::default();
        let ctx = vote_context(Some(&channel));
        VerifierVoteTool
            .call(
                serde_json::json!({
                    "verdict": "pass",
                    "summary": "全部通过",
                    "rejection_reason": "不应保留",
                }),
                &ctx,
            )
            .await
            .unwrap();
        let vote = channel.recorded_vote().unwrap();
        assert_eq!(vote.input.verdict, VerifierVoteOutcome::Pass);
        assert_eq!(vote.input.rejection_reason, None);
        assert_eq!(vote.tool_use_id, "vote-1");
    }

    #[tokio::test]
    async fn call_cross_checks_verified_tool_use_ids() {
        let channel = VerifierVoteChannel::default();
        channel.record_authenticated_tool_use("bash-1");
        let ctx = vote_context(Some(&channel));
        let error = VerifierVoteTool
            .call(
                serde_json::json!({
                    "verdict": "pass",
                    "summary": "结论",
                    "verified_tool_use_ids": ["bash-1", "bash-9"],
                }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("bash-9"));
        assert!(channel.recorded_vote().is_none());

        VerifierVoteTool
            .call(
                serde_json::json!({
                    "verdict": "pass",
                    "summary": "结论",
                    "verified_tool_use_ids": ["bash-1"],
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(channel.recorded_vote().is_some());
    }

    #[tokio::test]
    async fn second_vote_call_is_a_tool_error() {
        let channel = VerifierVoteChannel::default();
        let ctx = vote_context(Some(&channel));
        VerifierVoteTool
            .call(vote_json("pass"), &ctx)
            .await
            .unwrap();
        let error = VerifierVoteTool
            .call(
                serde_json::json!({
                    "verdict": "fail",
                    "summary": "反悔",
                    "rejection_reason": "试图改判",
                }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already recorded"));
        assert_eq!(
            channel.recorded_vote().unwrap().input.verdict,
            VerifierVoteOutcome::Pass
        );
    }

    #[tokio::test]
    async fn call_requires_tool_call_id() {
        let channel = VerifierVoteChannel::default();
        let mut ctx = ToolContext::new(AppState::new("/"));
        ctx.verifier_vote_channel = Some(channel.clone());
        let error = VerifierVoteTool
            .call(vote_json("pass"), &ctx)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("tool_use id"));
        assert!(channel.recorded_vote().is_none());
    }
}
