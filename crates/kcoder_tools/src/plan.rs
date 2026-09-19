use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

/// Enter read-only plan mode to design an approach before coding.
#[derive(Debug, Default)]
pub struct EnterPlanModeTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EnterPlanModeInput {}

#[async_trait]
impl Tool for EnterPlanModeTool {
    fn name(&self) -> String {
        "EnterPlanMode".to_string()
    }

    fn description(&self) -> String {
        "Requests entry into plan mode for non-trivial work that needs exploration, architecture choices, or user sign-off before implementation. In plan mode, use only the read-only inspection and user-elicitation capabilities actually attached to the current request; never assume a tool is available from examples or another mode. Do not modify implementation files, except for an explicit plan artifact when the active workflow provides an authorized way to write one. Skip plan mode for tiny fixes or pure research tasks.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(EnterPlanModeInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, _input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let instructions = "You are in plan mode.\n\
            1. Thoroughly explore the codebase to understand existing patterns.\n\
            2. Identify similar features and architectural approaches.\n\
            3. Consider multiple approaches and their trade-offs.\n\
            4. Resolve concrete uncertainties using only capabilities attached to the current request; if user elicitation is unavailable, state reasonable assumptions and blockers.\n\
            5. Design a concrete implementation strategy with verification steps.\n\
            6. When ready, use an attached plan-exit capability if one is available; otherwise present the completed plan directly.\n\n\
            Remember: DO NOT write or edit any files except an explicit plan file.";
        ctx.state.enter_plan_mode(instructions);
        Ok(ToolOutput::text(
            "Entered plan mode. Focus on exploration and design; do not write or edit files yet.",
        ))
    }
}

/// Exit plan mode and present the plan for approval.
#[derive(Debug, Default)]
pub struct ExitPlanModeTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AllowedPrompt {
    /// Exact attached tool name this semantic permission applies to.
    pub tool: String,
    /// Semantic action category, such as running tests or installing dependencies.
    pub prompt: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExitPlanModeInput {
    /// Optional plan text to save before exiting.
    pub plan: Option<String>,
    /// Optional file path to save the plan to.
    #[serde(alias = "plan_file_path")]
    pub plan_file_path: Option<String>,
    /// Optional spec change name. If omitted and exactly one active spec change
    /// exists, the plan is saved to its tasks.md.
    pub change: Option<String>,
    /// Optional semantic permissions needed to implement the plan.
    #[serde(default, alias = "allowed_prompts")]
    pub allowed_prompts: Vec<AllowedPrompt>,
}

#[async_trait]
impl Tool for ExitPlanModeTool {
    fn name(&self) -> String {
        "ExitPlanMode".to_string()
    }

    fn description(&self) -> String {
        "Exit plan mode after the implementation plan is complete and request approval to start coding. Prefer writing the plan to the provided plan file and pass planFilePath; this tool can also accept a plan string for compatibility. This call itself is the plan approval request, so do not request duplicate approval through another capability. Optional allowedPrompts must be an array of objects whose tool field exactly matches a tool attached to the current request and whose prompt describes the semantic permission needed by the plan.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(ExitPlanModeInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ExitPlanModeInput = parse_input(&input)?;
        ctx.state.exit_plan_mode();

        let mut text = String::from("Exited plan mode. You can now start implementation.");
        let plan_from_file = match (&input.plan, &input.plan_file_path) {
            (None, Some(path)) => match std::fs::read_to_string(Path::new(path)) {
                Ok(plan) if !plan.trim().is_empty() => Some(plan),
                Ok(_) => {
                    text.push_str(&format!(
                        "\n\nWarning: plan file {} is empty. Add the plan before requesting approval when plan-file workflow is active.",
                        path
                    ));
                    None
                }
                Err(e) => {
                    text.push_str(&format!(
                        "\n\nWarning: could not read plan file {}: {}. If a plan file was provided by plan mode, write the plan there before calling ExitPlanMode.",
                        path, e
                    ));
                    None
                }
            },
            _ => None,
        };
        if let Some(plan) = input.plan.or(plan_from_file) {
            text.push_str("\n\nApproved Plan:\n");
            text.push_str(&plan);

            // Persist the plan to a user-specified file if requested.
            if let Some(path) = &input.plan_file_path {
                let plan_path = Path::new(path);
                let write_result = (|| -> std::io::Result<()> {
                    if let Some(parent) = plan_path
                        .parent()
                        .filter(|parent| !parent.as_os_str().is_empty())
                    {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(plan_path, &plan)
                })();
                if let Err(e) = write_result {
                    text.push_str(&format!(
                        "\n\nWarning: failed to write plan file {}: {}",
                        path, e
                    ));
                } else {
                    text.push_str(&format!("\n\nPlan file path: {}", path));
                }
            }

            // Sync the plan with the active spec change when appropriate.
            match kcoder_specs::apply_plan(&ctx.state.cwd(), input.change.as_deref(), &plan) {
                Ok(tasks_path) => {
                    text.push_str(&format!(
                        "\n\nSynced plan to spec change artifact: {}",
                        tasks_path.display()
                    ));
                }
                Err(e) => {
                    let msg = format!("{}", e);
                    if !msg.contains("no active spec changes") {
                        text.push_str(&format!("\n\nSpec plan sync skipped: {}", msg));
                    }
                }
            }
        } else if let Some(path) = input.plan_file_path {
            text.push_str(&format!("\n\nPlan file path: {}", path));
        }
        if !input.allowed_prompts.is_empty() {
            text.push_str("\n\nRequested semantic permissions:");
            for prompt in input.allowed_prompts {
                text.push_str(&format!("\n- {}: {}", prompt.tool, prompt.prompt));
            }
        }
        Ok(ToolOutput::text(text))
    }
}

/// Verify that a plan was executed correctly before exiting plan mode.
#[derive(Debug, Default)]
pub struct VerifyPlanExecutionTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VerifyPlanExecutionInput {
    /// A summary of the plan that was executed.
    pub plan_summary: String,
    /// Whether all planned steps were completed successfully.
    pub all_steps_completed: bool,
    /// Notes on what was verified and any issues found.
    pub verification_notes: Option<String>,
}

#[async_trait]
impl Tool for VerifyPlanExecutionTool {
    fn name(&self) -> String {
        "VerifyPlanExecution".to_string()
    }

    fn description(&self) -> String {
        "Verify that an approved plan was executed correctly before claiming completion. Input must include plan_summary, all_steps_completed, and optional verification_notes with commands run, files checked, skipped steps, or residual risks.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(VerifyPlanExecutionInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: VerifyPlanExecutionInput = parse_input(&input)?;
        let status = if input.all_steps_completed {
            "verified"
        } else {
            "verification failed"
        };
        let mut text = format!("Plan {}.\n\nSummary: {}", status, input.plan_summary);
        if let Some(notes) = input.verification_notes {
            text.push_str(&format!("\n\nNotes: {}", notes));
        }
        Ok(ToolOutput::text(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::ContentBlock;

    #[tokio::test]
    async fn exit_plan_mode_reads_plan_file_and_allowed_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let plan_path = temp.path().join("plan.md");
        std::fs::write(&plan_path, "1. Inspect code\n2. Run tests\n").unwrap();

        let state = kcoder_state::AppState::new(temp.path());
        state.enter_plan_mode("planning");
        let ctx = ToolContext::new(state.clone());
        let tool = ExitPlanModeTool;

        let output = tool
            .call(
                serde_json::json!({
                    "planFilePath": plan_path,
                    "allowedPrompts": [
                        {"tool": "Bash", "prompt": "run tests"}
                    ]
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = match &output.content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text"),
        };
        assert!(text.contains("Approved Plan"));
        assert!(text.contains("Inspect code"));
        assert!(text.contains("Requested semantic permissions"));
        assert!(text.contains("Bash: run tests"));
        assert!(state.plan_mode().is_none());
    }

    #[tokio::test]
    async fn exit_plan_mode_accepts_legacy_snake_case_fields() {
        let temp = tempfile::tempdir().unwrap();
        let plan_path = temp.path().join("plan.md");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let tool = ExitPlanModeTool;

        let output = tool
            .call(
                serde_json::json!({
                    "plan": "1. Keep compatibility",
                    "plan_file_path": plan_path,
                    "allowed_prompts": [
                        {"tool": "Bash", "prompt": "run fmt"}
                    ]
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = match &output.content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text"),
        };
        assert!(text.contains("Keep compatibility"));
        assert!(text.contains("Bash: run fmt"));
        assert_eq!(
            std::fs::read_to_string(&plan_path).unwrap(),
            "1. Keep compatibility"
        );
    }

    #[tokio::test]
    async fn exit_plan_mode_creates_missing_plan_file_parent_directories() {
        let temp = tempfile::tempdir().unwrap();
        let plan_path = temp.path().join("nested plans").join("windows plan.md");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let tool = ExitPlanModeTool;

        let output = tool
            .call(
                serde_json::json!({
                    "plan": "1. Persist a plan in a new directory",
                    "planFilePath": plan_path,
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = match &output.content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text"),
        };
        assert!(!text.contains("Warning: failed to write plan file"));
        assert_eq!(
            std::fs::read_to_string(&plan_path).unwrap(),
            "1. Persist a plan in a new directory"
        );
    }
}
