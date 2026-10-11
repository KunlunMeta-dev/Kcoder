//! Spec query tools adapter behavior; domain operations remain in kcoder_specs.

use super::*;

#[async_trait]
impl Tool for SpecStatusTool {
    fn name(&self) -> String {
        "SpecStatus".to_string()
    }

    fn description(&self) -> String {
        "List active spec changes, show one change's quick dashboard with name, or deeply read its artifacts with change. Validation, verification, and apply preflight require the corresponding attached checking capability."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecStatusInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecStatusInput = parse_input(&input)?;
        if let Some(change) = input.change {
            return StatusDeepRead
                .call(
                    serde_json::json!({
                        "name": change,
                        "include_specs": input.include_specs,
                        "max_file_bytes": input.max_file_bytes,
                    }),
                    ctx,
                )
                .await;
        }
        let Some(name) = input.name else {
            let changes = kcoder_specs::list_changes(&ctx.state.cwd())
                .map_err(|e| ToolError::Execution(format!("failed to list changes: {e}")))?;
            return serde_json::to_string_pretty(&serde_json::json!({"changes": changes}))
                .map(ToolOutput::text)
                .map_err(|e| ToolError::Execution(format!("failed to serialize status: {e}")));
        };

        match kcoder_specs::status(&ctx.state.cwd(), &name) {
            Ok(summary) => {
                let artifacts = summary
                    .artifacts
                    .iter()
                    .map(|artifact| {
                        (
                            artifact.name.clone(),
                            serde_json::json!({
                                "exists": artifact.present,
                                "complete": artifact.non_empty,
                            }),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                let required_artifacts_complete =
                    summary.artifacts.iter().all(|artifact| artifact.non_empty);
                let drift_ok = summary.drift_errors.is_empty();
                let apply_blockers = summary.apply_blockers.clone();
                let apply_ok = apply_blockers.is_empty();
                let ready_to_apply =
                    required_artifacts_complete && summary.tasks_complete && drift_ok && apply_ok;
                let output = serde_json::json!({
                    "change": summary.name,
                    "title": summary.title,
                    "schema": summary.schema,
                    "status": summary.status,
                    "artifacts": artifacts,
                    "tasks": {
                        "complete": summary.tasks_complete,
                    },
                    "drift": {
                        "ok": drift_ok,
                        "errors": summary.drift_errors,
                    },
                    "apply": {
                        "blockers": apply_blockers,
                    },
                    "completion": {
                        "blockers": summary.completion_blockers,
                    },
                    "verification": summary.verification,
                    "ready_to_apply": ready_to_apply,
                });
                serde_json::to_string_pretty(&output)
                    .map(ToolOutput::text)
                    .map_err(|e| ToolError::Execution(format!("failed to serialize status: {e}")))
            }
            Err(e) => Err(ToolError::Execution(format!("failed to get status: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for StatusDeepRead {
    fn name(&self) -> String {
        "SpecStatus".to_string()
    }

    fn description(&self) -> String {
        "Show a spec-driven change as structured JSON: status summary plus proposal, \
         tasks, optional design, and delta spec files. This is the deep read of one change; \
         for a quick drift/completion glance use SpecStatus, rule enforcement requires an attached checking capability. Prefer this over directly guessing paths under .kcoder/specs/changes."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(StatusDeepReadInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: StatusDeepReadInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let change_dir = cwd
            .join(kcoder_specs::SPECS_DIR)
            .join("changes")
            .join(&input.name);
        if !change_dir.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "change '{}' does not exist",
                input.name
            )));
        }
        let status = kcoder_specs::status(&cwd, &input.name)
            .map_err(|e| ToolError::Execution(format!("failed to get status: {e}")))?;
        let mut files = Vec::new();
        for file in [
            "proposal.md",
            "design.md",
            "review.md",
            "tasks.md",
            "plan.md",
            "verification.md",
        ] {
            let path = change_dir.join(file);
            if path.is_file() {
                files.push(read_spec_show_file(
                    &change_dir,
                    &path,
                    input.max_file_bytes,
                )?);
            }
        }
        if input.include_specs {
            let specs_dir = change_dir.join("specs");
            if specs_dir.is_dir() {
                collect_spec_show_files(&change_dir, &specs_dir, input.max_file_bytes, &mut files)?;
            }
        }
        let output = serde_json::json!({
            "name": input.name,
            "status": status,
            "files": files,
        });
        serde_json::to_string_pretty(&output)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize spec show: {e}")))
    }
}
