//! Spec verification tools adapter behavior; domain operations remain in kcoder_specs.

use super::*;

#[async_trait]
impl Tool for SpecPreflightOperation {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Run apply-time preflight checks for a spec-driven change: the gate that decides whether a change may be applied/archived. \
         For spec-driven-superpowers changes, checks review.md readiness, active modes, \
         plan.md task coverage, validation mapping, and retained-verification requirements. \
         This is the go/no-go gate before apply; action=validate checks structure and \
         action=verify checks test coverage — neither is a substitute for this gate."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecPreflightOperationInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecPreflightOperationInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::apply_preflight(&ctx.state.cwd(), &input.name) {
            Ok(report) => serde_json::to_string_pretty(&report)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize apply preflight: {e}"))
                }),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to run apply preflight: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecCheckTool {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Run read-only spec checks by action: validate structural and configured rules, verify scenario-to-test coverage, or preflight one change before apply/archive. Non-enforcing state inspection is a separate capability."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecCheckInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecCheckInput = parse_input(&input)?;
        match input.action {
            SpecCheckAction::Validate => {
                CheckValidateStage
                    .call(serde_json::json!({"change": input.change}), ctx)
                    .await
            }
            SpecCheckAction::Verify => CheckVerifyStage.call(serde_json::json!({}), ctx).await,
            SpecCheckAction::Preflight => {
                let name = input.change.or(input.name).ok_or_else(|| {
                    ToolError::InvalidInput("change is required for preflight".to_string())
                })?;
                SpecPreflightOperation
                    .call(serde_json::json!({"name": name}), ctx)
                    .await
            }
        }
    }
}

#[async_trait]
impl Tool for CheckValidateStage {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Validate a spec-driven change or the whole spec subsystem: structural checks on \
         required artifacts, spec/delta parsing, drift detection, and cross-platform/schema \
         rules from .kcoder/specs/config.yaml. This is the rule enforcer; SpecStatus only reads \
         state. Use action=verify for scenario-to-test coverage and action=preflight before archive."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CheckValidateStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CheckValidateStageInput = parse_input(&input)?;

        match kcoder_specs::validate(&ctx.state.cwd(), input.change.as_deref()) {
            Ok(errors) => {
                if errors.is_empty() {
                    Ok(ToolOutput::text("Validation passed.".to_string()))
                } else {
                    let mut text = String::from("Validation errors:");
                    for err in errors {
                        let _ = writeln!(text, "\n- {}", err);
                    }
                    Ok(ToolOutput::text(text))
                }
            }
            Err(e) => Err(ToolError::Execution(format!("failed to validate: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for CheckVerifyStage {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Compare spec scenarios against the project's test suite (cargo tests by default) and report coverage gaps. This differs from action=validate structural checks and action=preflight readiness checks."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CheckVerifyStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _: CheckVerifyStageInput = parse_input(&input)?;

        match kcoder_specs::verify(&ctx.state.cwd()) {
            Ok(report) => {
                let mut text = format!(
                    "Spec coverage: {} covered, {} gaps",
                    report.covered.len(),
                    report.gaps.len()
                );
                if !report.covered.is_empty() {
                    text.push_str("\n\nCovered:");
                    for item in &report.covered {
                        let _ = writeln!(text, "\n- {}", item);
                    }
                }
                if !report.gaps.is_empty() {
                    text.push_str("\n\nGaps:");
                    for item in &report.gaps {
                        let _ = writeln!(text, "\n- {}", item);
                    }
                }
                Ok(ToolOutput::text(text))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to verify specs: {:#}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecRecordVerificationTool {
    fn name(&self) -> String {
        "SpecRecordVerification".to_string()
    }

    fn description(&self) -> String {
        "Write retained verification evidence to `.kcoder/specs/changes/<name>/verification.md`. \
         Use this when Verification Mode is retained-recommended or retained-required, or when \
         commands/manual checks should be preserved with the change."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecRecordVerificationInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecRecordVerificationInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        let record = kcoder_specs::SpecVerificationRecord {
            completion_decision: input.completion_decision,
            commands_run: input.commands_run,
            manual_checks: input.manual_checks,
            evidence: input.evidence,
            residual_risks: input.residual_risks,
        };

        match kcoder_specs::record_verification(&ctx.state.cwd(), &input.name, record) {
            Ok(path) => Ok(ToolOutput::text(format!(
                "Recorded verification evidence at {}",
                path.display()
            ))),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to record verification: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for ReviewWritebackStage {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Write review findings back into the canonical spec-driven-superpowers artifacts (review stage 3 of 3). \
         Updates review.md Review Status and Findings Summary, appends accepted follow-ups \
         to tasks.md and plan.md, and can retain verification notes in verification.md while \
         preserving Manual Adjustments and Previous Iterations. Run this after SpecReview/ \
         action=dispatch produced findings (stages 1-2); it mutates the change artifacts."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ReviewWritebackStageInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReviewWritebackStageInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        if input.review_status.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "review_status cannot be empty".to_string(),
            ));
        }

        let record = kcoder_specs::SpecReviewWritebackRecord {
            review_status: input.review_status,
            findings_summary: input.findings_summary,
            accepted_followups: input.accepted_followups,
            verification_notes: input.verification_notes,
        };

        match kcoder_specs::review_writeback(&ctx.state.cwd(), &input.name, record) {
            Ok(report) => serde_json::to_string_pretty(&report)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize review writeback: {e}"))
                }),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to write back review findings: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecReviewTool {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Run the spec review lifecycle by action: prepare a reviewer prompt (default), dispatch a reviewer subagent, or writeback accepted findings into review/tasks/plan/verification artifacts. Writeback mutates files, so the consolidated tool is serialized."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<SpecReviewInput>()
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecReviewInput = parse_input(&input)?;

        match input.action {
            SpecReviewAction::Dispatch => {
                return ReviewDispatchStage
                    .call(
                        serde_json::json!({
                            "name": input.name,
                            "base_sha": input.base_sha,
                            "max_turns": input.max_turns,
                        }),
                        ctx,
                    )
                    .await;
            }
            SpecReviewAction::Writeback => {
                let review_status = input.review_status.ok_or_else(|| {
                    ToolError::InvalidInput("review_status is required for writeback".to_string())
                })?;
                return ReviewWritebackStage
                    .call(
                        serde_json::json!({
                            "name": input.name,
                            "review_status": review_status,
                            "findings_summary": input.findings_summary,
                            "accepted_followups": input.accepted_followups,
                            "verification_notes": input.verification_notes,
                        }),
                        ctx,
                    )
                    .await;
            }
            SpecReviewAction::Prepare => {}
        }

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::review(&ctx.state.cwd(), &input.name, input.base_sha.as_deref()) {
            Ok(report) => {
                let mut text = format!("# Code Review Request: {}\n\n", report.change_name);
                if let Some(title) = &report.title {
                    let _ = writeln!(text, "**Title:** {}\n", title);
                }
                let _ = writeln!(
                    text,
                    "**Base:** {}\n**Head:** {}\n",
                    report.git_base, report.git_head
                );
                if !report.git_diff_stat.is_empty() {
                    let _ = writeln!(text, "## Diff stat\n\n{}\n", report.git_diff_stat);
                }
                let _ = writeln!(
                    text,
                    "## Pre-review checks\n\n{}\n",
                    report.precheck_summary
                );
                let _ = writeln!(text, "## Reviewer prompt\n\n{}", report.reviewer_prompt);
                Ok(ToolOutput::text(text))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to build review: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for ReviewDispatchStage {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Dispatch a code reviewer subagent for a spec-driven change (review stage 2 of 3). \
         Builds the review prompt from the change metadata, deltas, git diff, \
         and pre-review checks, then runs a review subagent and returns its findings. \
         Prepare the prompt with SpecReview (stage 1) when you need to inspect or adjust it \
         first; persist accepted findings with action=writeback (stage 3)."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<ReviewDispatchStageInput>()
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReviewDispatchStageInput = parse_input(&input)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        let report = kcoder_specs::review(&ctx.state.cwd(), &input.name, input.base_sha.as_deref())
            .map_err(|e| ToolError::Execution(format!("failed to build review: {}", e)))?;

        let runner = ctx
            .agent_runner
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;

        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let prompt = report.reviewer_prompt;
        let max_turns = clamp_agent_max_turns(input.max_turns);
        let id =
            ctx.spawn_subagent_background(format!("spec review for {}", input.name), async move {
                match runner.run_agent(prompt, max_turns).await {
                    Ok(text) => ToolOutput::text(text),
                    Err(e) => ToolOutput::error(e.to_string()),
                }
            })?;

        Ok(ToolOutput::text(format!(
            "Started background spec review task {id}. It will run independently and the result will be incorporated automatically when it completes."
        )))
    }
}
