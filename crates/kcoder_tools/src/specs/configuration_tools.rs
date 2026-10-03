//! Spec configuration tools adapter behavior; domain operations remain in kcoder_specs.

use super::*;

#[async_trait]
impl Tool for SpecConfigTool {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Read or update `.kcoder/specs/config.yaml` by action=get/set. Set regenerates the using-specs skill and reloads the registry; get is read-only, but this consolidated tool is serialized because set mutates files."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecConfigInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecConfigInput = parse_input(&input)?;
        match input.action {
            SpecConfigAction::Get => {
                ConfigGetStage
                    .call(serde_json::json!({"key": input.key}), ctx)
                    .await
            }
            SpecConfigAction::Set => {
                let key = input.key.ok_or_else(|| {
                    ToolError::InvalidInput("key is required for set".to_string())
                })?;
                let value = input.value.ok_or_else(|| {
                    ToolError::InvalidInput("value is required for set".to_string())
                })?;
                ConfigSetStage
                    .call(serde_json::json!({"key": key, "value": value}), ctx)
                    .await
            }
        }
    }
}

#[async_trait]
impl Tool for ConfigGetStage {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Read a value from .kcoder/specs/config.yaml. \
         Supports keys: schema, context, precheck, rules.<artifact>. \
         Omit key to read the whole file."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ConfigGetStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ConfigGetStageInput = parse_input(&input)?;
        let specs_dir = ctx.state.cwd().join(".kcoder").join("specs");

        match kcoder_specs::config::config_get(&specs_dir, input.key.as_deref()) {
            Ok(value) => Ok(ToolOutput::text(value)),
            Err(e) => Err(ToolError::Execution(format!("failed to get config: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for ConfigSetStage {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Set a value in .kcoder/specs/config.yaml. \
         Supports keys: schema, context, precheck, rules.<artifact>. \
         For rules.<artifact>, provide a YAML list of strings."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ConfigSetStageInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ConfigSetStageInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;
        let specs_dir = ctx.state.cwd().join(".kcoder").join("specs");

        match kcoder_specs::config::config_set(&specs_dir, &input.key, &input.value) {
            Ok(()) => {
                let worker_cwd = ctx.state.cwd();
                let (skill_path, receipt) = tokio::task::spawn_blocking(move || {
                    kcoder_specs::sync_using_specs_skill_report(&worker_cwd)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("using-specs worker failed: {error}"))
                })?
                .map_err(|e| {
                    ToolError::Execution(format!("failed to sync using-specs skill: {}", e))
                })?;
                let root = project_skills_root(&ctx.state.cwd());
                match reload_skill_registry(ctx) {
                    Ok(_) => {
                        record_spec_reload_status(&root, Some(&receipt.transaction_id), true);
                        Ok(ToolOutput::text(format!(
                            "Set {} in .kcoder/specs/config.yaml and regenerated {}",
                            input.key,
                            skill_path.display()
                        )))
                    }
                    Err(error) => {
                        record_spec_reload_status(&root, Some(&receipt.transaction_id), false);
                        Ok(ToolOutput::text(format!(
                            "Set {} and committed {}; committed_reload_pending ({error}); only retry registry reload",
                            input.key,
                            skill_path.display()
                        )))
                    }
                }
            }
            Err(e) => Err(ToolError::Execution(format!("failed to set config: {}", e))),
        }
    }
}
