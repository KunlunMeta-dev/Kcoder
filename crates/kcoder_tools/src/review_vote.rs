//! Structured verdict channel for orchestration critics.
//!
//! The host binds the channel to one work revision. Models cannot declare
//! infrastructure errors or vote with a stale plan identity. Each critic session accepts only its first valid vote.

use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};

pub const REVIEW_VOTE_TOOL_NAME: &str = "ReviewVote";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVoteOutcome {
    Okay,
    Reject,
}

impl ReviewVoteOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Okay => "okay",
            Self::Reject => "reject",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
pub struct ReviewFinding {
    pub severity: String,
    pub summary: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
pub struct ReviewVoteInput {
    pub verdict: ReviewVoteOutcome,
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<ReviewFinding>,
    pub work_id: String,
    pub plan_revision: u64,
    pub plan_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewVoteRecord {
    pub input: ReviewVoteInput,
    pub tool_use_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewVoteExpectation {
    pub work_id: String,
    pub plan_revision: u64,
    pub plan_sha256: String,
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|error| error.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|error| error.into_inner())
}

#[derive(Debug, Clone)]
pub struct ReviewVoteChannel {
    expected: ReviewVoteExpectation,
    vote: Arc<RwLock<Option<ReviewVoteRecord>>>,
}

impl ReviewVoteChannel {
    pub fn new(expected: ReviewVoteExpectation) -> Self {
        Self {
            expected,
            vote: Arc::new(RwLock::new(None)),
        }
    }

    pub fn expectation(&self) -> &ReviewVoteExpectation {
        &self.expected
    }

    pub fn recorded_vote(&self) -> Option<ReviewVoteRecord> {
        read_lock(&self.vote).clone()
    }

    pub fn record_vote(&self, record: ReviewVoteRecord) -> Result<(), ToolError> {
        let input = &record.input;
        if input.work_id != self.expected.work_id
            || input.plan_revision != self.expected.plan_revision
            || input.plan_sha256 != self.expected.plan_sha256
        {
            return Err(ToolError::InvalidInput(
                "ReviewVote targets a stale or different work revision".to_string(),
            ));
        }
        let mut vote = write_lock(&self.vote);
        if vote.is_some() {
            return Err(ToolError::Execution(
                "a ReviewVote was already recorded in this critic session".to_string(),
            ));
        }
        *vote = Some(record);
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct ReviewVoteTool;

#[async_trait]
impl Tool for ReviewVoteTool {
    fn name(&self) -> String {
        REVIEW_VOTE_TOOL_NAME.to_string()
    }

    fn description(&self) -> String {
        "Submit exactly one binding Orchestrate critic verdict. The work_id, plan_revision, and plan_sha256 must match the runtime-bound active work. verdict is okay or reject; reject requires at least one concrete finding. Infrastructure errors cannot be voted by the model. The accepted vote ends this critic session at the current tool-batch boundary."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ReviewVoteInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReviewVoteInput = parse_input(&input)?;
        let Some(channel) = ctx.review_vote_channel.as_ref() else {
            return Err(ToolError::Execution(
                "ReviewVote is only available inside an authenticated Orchestrate critic session"
                    .to_string(),
            ));
        };
        if input.summary.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "summary must not be empty".to_string(),
            ));
        }
        if input.verdict == ReviewVoteOutcome::Reject && input.findings.is_empty() {
            return Err(ToolError::InvalidInput(
                "reject requires at least one concrete finding".to_string(),
            ));
        }
        if input
            .findings
            .iter()
            .any(|finding| finding.severity.trim().is_empty() || finding.summary.trim().is_empty())
        {
            return Err(ToolError::InvalidInput(
                "every finding requires non-empty severity and summary".to_string(),
            ));
        }
        let tool_use_id = ctx.tool_call_id.clone().ok_or_else(|| {
            ToolError::Execution("ReviewVote cannot authenticate its tool-use id".to_string())
        })?;
        let verdict = input.verdict;
        channel.record_vote(ReviewVoteRecord { input, tool_use_id })?;
        Ok(ToolOutput::text(format!(
            "ReviewVote recorded: {}. The vote is binding; do not call further tools.",
            verdict.as_str()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    fn channel() -> ReviewVoteChannel {
        ReviewVoteChannel::new(ReviewVoteExpectation {
            work_id: "work-1".to_string(),
            plan_revision: 2,
            plan_sha256: "abc".to_string(),
        })
    }

    fn input(revision: u64) -> Value {
        serde_json::json!({
            "verdict": "okay",
            "summary": "review passed",
            "findings": [],
            "work_id": "work-1",
            "plan_revision": revision,
            "plan_sha256": "abc"
        })
    }

    #[tokio::test]
    async fn first_matching_vote_is_binding() {
        let channel = channel();
        let mut ctx = ToolContext::new(AppState::new("/")).with_tool_call_id("vote-1");
        ctx.review_vote_channel = Some(channel.clone());
        ReviewVoteTool.call(input(2), &ctx).await.unwrap();
        assert_eq!(channel.recorded_vote().unwrap().tool_use_id, "vote-1");
        assert!(ReviewVoteTool.call(input(2), &ctx).await.is_err());
    }

    #[tokio::test]
    async fn stale_revision_and_unauthorized_session_are_rejected() {
        let channel = channel();
        let mut ctx = ToolContext::new(AppState::new("/")).with_tool_call_id("vote-1");
        ctx.review_vote_channel = Some(channel);
        assert!(ReviewVoteTool.call(input(1), &ctx).await.is_err());
        assert!(
            ReviewVoteTool
                .call(input(2), &ToolContext::new(AppState::new("/")))
                .await
                .is_err()
        );
    }

    #[test]
    fn model_cannot_deserialize_infrastructure_error() {
        let value = serde_json::json!({
            "verdict": "infrastructure_error",
            "summary": "unavailable",
            "work_id": "work-1",
            "plan_revision": 2,
            "plan_sha256": "abc"
        });
        assert!(serde_json::from_value::<ReviewVoteInput>(value).is_err());
    }
}
