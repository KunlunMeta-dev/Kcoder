//! Translate model arguments and workflow agent calls at the host execution boundary.

use super::*;

/// The saved definition supplies the argument schema unavailable in the generic tool schema.
/// Preserve already-valid values, including intentionally JSON-looking string inputs.
pub(super) fn prepare_model_arguments(
    definition: &kcoder_types::workflow::WorkflowDefinition,
    args: &mut Value,
    options: &crate::CoercionOptions,
) -> anyhow::Result<Value> {
    match kcoder_workflow::graph::prepare_arguments(definition, args) {
        Ok(value) => Ok(value),
        Err(original) => {
            let Some(schema) = &definition.input_schema else {
                return Err(original);
            };
            let mut candidate = args.clone();
            crate::coerce_input_with_options(&mut candidate, schema, options);
            if candidate == *args {
                return Err(original);
            }
            *args = candidate;
            kcoder_workflow::graph::prepare_arguments(definition, args)
        }
    }
}

/// JSON-text inputs are already explicit: validate rather than silently repairing
/// their types. Native model arguments retain schema-guided compatibility coercion.
pub(super) fn prepare_supplied_arguments(
    definition: &kcoder_types::workflow::WorkflowDefinition,
    args: &mut Value,
    options: &crate::CoercionOptions,
    lossless: bool,
) -> anyhow::Result<Value> {
    if lossless {
        kcoder_workflow::graph::prepare_arguments(definition, args)
    } else {
        prepare_model_arguments(definition, args, options)
    }
}

#[cfg(test)]
mod argument_contract_tests {
    use super::*;
    #[test]
    fn workflow_contract_lossless_json_never_coerces_types_or_guesses_wrappers() {
        let temp = tempfile::tempdir().unwrap();
        let store = kcoder_workflow::store::WorkflowStore::new(temp.path().join("library"));
        let mut definition = store.create("Typed inputs", "").unwrap();
        definition.input_schema = Some(
            json!({"type":"object","required":["items"],"properties":{"items":{"type":"array","items":{"type":"string"}}}}),
        );
        let bad = json!({"items":{"item":["1","2","3"]}});
        let mut args = bad.clone();
        assert!(
            prepare_supplied_arguments(
                &definition,
                &mut args,
                &crate::CoercionOptions::default(),
                true
            )
            .is_err()
        );
        assert_eq!(args, bad);
        let good = json!({"items":["1","2","3"]});
        assert_eq!(
            prepare_supplied_arguments(
                &definition,
                &mut good.clone(),
                &crate::CoercionOptions::default(),
                true
            )
            .unwrap(),
            good
        );
        definition.input_schema = None;
        assert_eq!(
            prepare_supplied_arguments(
                &definition,
                &mut bad.clone(),
                &crate::CoercionOptions::default(),
                true
            )
            .unwrap(),
            bad
        );
    }
}

#[async_trait]
impl AgentExecutor for ToolAgentExecutor {
    fn tool_is_read_only(&self, name: &str) -> bool {
        self.runner.workflow_tool_is_read_only(name)
    }
    async fn await_request(
        &self,
        id: &str,
        node_id: &str,
        request: kcoder_types::workflow::WorkflowAwaitRequest,
    ) -> Result<Value, String> {
        let root = self
            .wait_root
            .as_ref()
            .ok_or("workflow_wait: durable request storage unavailable")?;
        crate::workflow_interactions::wait(
            root,
            &self.run_id,
            id,
            node_id,
            request,
            self.cancellation.clone(),
        )
        .await
        .map_err(|error| format!("{error:#}"))
    }

    async fn resolve_workflow(
        &self,
        id: &str,
        version: u64,
    ) -> Result<kcoder_types::workflow::WorkflowDefinition, String> {
        let root = self
            .library_root
            .as_ref()
            .ok_or("workflow_subworkflow: account library unavailable")?;
        kcoder_workflow::store::WorkflowStore::new(root)
            .read_saved(id, Some(version))
            .map_err(|error| error.to_string())
    }

    async fn execute_tool(
        &self,
        operation_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.execute_direct_tool(operation_id, name, arguments)
            .await
            .map_err(|error| format!("{error:#}"))
    }

    async fn execute(&self, agent_id: &str, request: AgentRequest) -> Result<String, String> {
        if !valid_agent_artifact_id(agent_id) {
            return Err("workflow_invalid: unsafe agent identity".into());
        }
        if let Some(run_dir) = &self.resume_run_dir {
            let agent_dir = run_dir
                .join("agents")
                .join(kcoder_state::artifact_id_path_component(agent_id));
            let cached = agent_dir.join("output.md");
            if cached_agent_request_matches(&agent_dir, &request) {
                return secure_read_file(&cached, 16 * 1024 * 1024)
                    .and_then(|bytes| {
                        String::from_utf8(bytes).map_err(|error| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, error)
                        })
                    })
                    .map_err(|error| {
                        format!(
                            "failed to read cached workflow agent output `{}`: {error}",
                            cached.display()
                        )
                    });
            }
        }
        let kind = crate::AgentKind::from_alias(&request.agent_type)
            .ok_or_else(|| format!("unknown workflow agent_type `{}`", request.agent_type))?;
        if self.arrangement_mode
            && matches!(kind, crate::AgentKind::Implementer)
            && request.allowed_write_paths.is_empty()
        {
            return Err(
                "Arrangement workflow implementer agents require allowed_write_paths".to_string(),
            );
        }
        if self.arrangement_mode
            && !matches!(
                kind,
                crate::AgentKind::Implementer | crate::AgentKind::Verifier
            )
            && !request.allowed_write_paths.is_empty()
        {
            return Err(
                "only Arrangement implementer and verifier workflow agents may receive allowed_write_paths"
                    .to_string(),
            );
        }

        let contract = crate::agent::AgentTaskContract {
            allowed_write_paths: request.allowed_write_paths.clone(),
            allowed_shell_prefixes: Vec::new(),
            acceptance_criteria: request.acceptance_criteria,
            expected_artifacts: request.expected_artifacts,
            context_paths: request.context_paths,
            out_of_scope: request.out_of_scope,
            verification: request.verification,
        };
        let prompt = kind.build_prompt_with_contract(&request.prompt, Some(&contract));
        let mut options = AgentRunOptions::with_allowed_write_paths(request.allowed_write_paths)
            .with_block_shell_file_mutation(crate::agent::agent_kind_blocks_shell_file_mutation(
                kind,
                self.arrangement_mode,
            ))
            .with_arrangement_mode(self.arrangement_mode)
            .with_abort_token(self.cancellation.clone());
        if self.isolate_context {
            // Declarative nodes already carry their complete input/dependency context.
            // Do not inherit the parent's instruction to launch the entire workflow.
            options.context_mode = crate::SubagentContextMode::None;
            options.context_turns = 0;
        }
        if request.output_repair_only {
            options.tool_allowlist = Some(Vec::new());
        }
        self.runner
            .run_agent_session_with_options(
                agent_id.to_string(),
                prompt,
                request.max_turns,
                kind,
                options,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

pub(super) fn preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let value = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{value}...")
    } else {
        value
    }
}

pub(super) fn valid_agent_artifact_id(agent_id: &str) -> bool {
    !agent_id.is_empty()
        && agent_id.len() <= 160
        && agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
