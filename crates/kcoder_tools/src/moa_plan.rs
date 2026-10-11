use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};

const MAX_MOA_PLAN_BYTES: usize = 512 * 1024;

#[derive(Debug, Default)]
struct SubmissionState {
    submitted: bool,
    content: Option<String>,
}

/// Single-submission slot owned by the engine. Reading its content does not reopen submission.
#[derive(Debug, Clone, Default)]
pub struct MoaPlanSubmission {
    state: Arc<Mutex<SubmissionState>>,
}

impl MoaPlanSubmission {
    pub fn take(&self) -> Option<String> {
        lock_submission(&self.state).content.take()
    }

    pub fn is_submitted(&self) -> bool {
        lock_submission(&self.state).submitted
    }
}

#[derive(Debug, Clone, Copy)]
enum SubmissionKind {
    Draft,
    Final,
}

/// Fixed-destination submission tool used by an MoA planner.
///
/// The tool accepts no path, so a model cannot use submission to write arbitrary
/// files. The engine publishes atomically after all concurrent planners finish.
#[derive(Debug, Clone)]
pub struct SubmitMoaPlanTool {
    kind: SubmissionKind,
    submission: MoaPlanSubmission,
}

impl SubmitMoaPlanTool {
    pub fn draft() -> (Self, MoaPlanSubmission) {
        Self::new(SubmissionKind::Draft)
    }

    pub fn final_plan() -> (Self, MoaPlanSubmission) {
        Self::new(SubmissionKind::Final)
    }

    fn new(kind: SubmissionKind) -> (Self, MoaPlanSubmission) {
        let submission = MoaPlanSubmission::default();
        (
            Self {
                kind,
                submission: submission.clone(),
            },
            submission,
        )
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SubmitMoaPlanInput {
    /// Complete Markdown planning document.
    content: String,
}

#[async_trait]
impl Tool for SubmitMoaPlanTool {
    fn name(&self) -> String {
        match self.kind {
            SubmissionKind::Draft => "SubmitMoaDraft",
            SubmissionKind::Final => "SubmitMoaFinal",
        }
        .to_string()
    }

    fn description(&self) -> String {
        match self.kind {
            SubmissionKind::Draft => {
                "Submit your complete Markdown plan draft. Submission succeeds only once and does not accept a file path."
            }
            SubmissionKind::Final => {
                "Submit the complete synthesized final Markdown plan. Submission succeeds only once and does not accept a file path."
            }
        }
        .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(SubmitMoaPlanInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SubmitMoaPlanInput = parse_input(&input)?;
        if input.content.trim().is_empty() {
            return Ok(ToolOutput::error("The plan document cannot be empty"));
        }
        if input.content.len() > MAX_MOA_PLAN_BYTES {
            return Ok(ToolOutput::error(format!(
                "The plan document exceeds the {}-byte limit",
                MAX_MOA_PLAN_BYTES
            )));
        }

        let mut state = lock_submission(&self.submission.state);
        if state.submitted {
            return Ok(ToolOutput::error(
                "The plan document has already been submitted and cannot be submitted again",
            ));
        }
        state.submitted = true;
        state.content = Some(input.content);
        Ok(ToolOutput::text("Plan document submitted"))
    }
}

fn lock_submission(state: &Mutex<SubmissionState>) -> MutexGuard<'_, SubmissionState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
