//! Tool batch runtime within the shared engine ownership boundary.

use super::*;

pub(super) fn should_retry_shell_without_sandbox(
    tool_name: &str,
    sandbox_config: &kcoder_types::SandboxConfig,
    escalated_attempts: usize,
) -> bool {
    is_shell_tool_name(tool_name)
        && sandbox_config.allow_shell_escalation
        && escalated_attempts < sandbox_config.shell_escalation_max_attempts
}

pub(super) fn sandbox_escalation_request_context(
    tool: &dyn kcoder_tools::Tool,
    input: &Value,
    reason: &str,
    output: Option<&str>,
) -> PermissionRequestContext {
    let mut context = request_context_for(tool, input);
    context.description = format!(
        "Sandbox escalation requested for `{}`. The first attempt was denied by the sandbox: {}. Retry without the sandbox only if this command is necessary and trusted.\n\n{}",
        context.tool_name, reason, context.description
    );
    context
        .detail_lines
        .push(format!("Sandbox denial: {reason}"));
    if let Some(output) = output.filter(|text| !text.trim().is_empty()) {
        context.detail_lines.push(format!(
            "Sandboxed output preview: {}",
            truncate_chars(output, 500)
        ));
    }
    context
}

pub(super) fn effective_tool_timeout_ms(
    tool_name: &str,
    input: &mut Value,
    default_timeout_ms: u64,
) -> u64 {
    if tool_name == "wait" {
        return 20_000;
    }

    // Agent tools and Strict Goal verifiers manage their own lifecycles; a generic tool timeout would kill valid blocking calls.
    if matches!(
        tool_name,
        "spawn_agent" | "explore_agent" | "PlanAgent" | "update_goal"
    ) {
        return 0;
    }

    let default_timeout = default_timeout_ms.max(1);

    if matches!(tool_name, "bash" | "PowerShell") {
        let Some(input_object) = input.as_object_mut() else {
            return default_timeout;
        };
        if let Some(timeout) = input_object.get("timeout").and_then(Value::as_u64) {
            let explicit_timeout = timeout.max(1);
            input_object.insert(
                "timeout".to_string(),
                Value::Number(serde_json::Number::from(explicit_timeout)),
            );
            return explicit_timeout;
        }
        input_object.insert(
            "timeout".to_string(),
            Value::Number(serde_json::Number::from(default_timeout)),
        );
    }

    default_timeout
}

pub(super) fn unknown_tool_output(name: &str, tools: &ToolRegistry) -> ToolOutput {
    let guidance = if tools.names().is_empty() {
        "Available tools: none."
    } else {
        // Registered tools can include hidden Goal, permission, or edit-surface
        // entries. Only the request's attached definitions grant callability.
        "Use only the tool definitions attached to the current request; do not infer availability from the backing registry or earlier turns."
    };
    ToolOutput::error(format!(
        "Unknown tool `{name}`. This tool is not available in the current execution context. {guidance}"
    ))
}

pub(super) fn permission_capability_class(tool_name: &str) -> String {
    match tool_name.to_ascii_lowercase().as_str() {
        "read" | "grep" | "glob" | "ls" | "find" | "ctx_inspect" => "filesystem_read".to_string(),
        "write" | "edit" | "apply_patch" => "filesystem_write".to_string(),
        "bash" | "powershell" => "shell_execute".to_string(),
        "agent" | "spawn_agent" | "explore_agent" | "wait_agent" | "sendmessage"
        | "send_message" => "subagent_control".to_string(),
        "skill" | "discover_skills" | "skill_guard" => "project_skill".to_string(),
        "web" | "web_search" | "web_fetch" | "web_browser" => "network_access".to_string(),
        "askuserquestion" | "ask_user_question" | "enterplanmode" | "exitplanmode" => {
            "user_elicitation".to_string()
        }
        name if name.starts_with("goal")
            || name.starts_with("task")
            || name.starts_with("todo") =>
        {
            "task_state".to_string()
        }
        other => format!("tool:{other}"),
    }
}

pub(super) fn permission_capability_hint(capability: &str) -> &'static str {
    match capability {
        "filesystem_read" => "allow the required read/glob/grep operations",
        "filesystem_write" => "allow scoped write/edit operations in the target worktree",
        "shell_execute" => "allow the required scoped shell or test command",
        "subagent_control" => "allow the requested sub-agent operation",
        "project_skill" => "trust the project and allow the required Skill",
        "network_access" => "allow the required network tool",
        "user_elicitation" => "run interactively or provide the missing decision up front",
        "task_state" => "allow the required task or goal state operation",
        _ => "allow the denied tool explicitly",
    }
}

pub(super) fn is_goal_tool_name(name: &str) -> bool {
    matches!(name, "get_goal" | "create_goal" | "update_goal")
}

pub(super) fn is_user_elicitation_tool_name(name: &str) -> bool {
    matches!(
        name,
        "AskUserQuestion" | "ask_user_question" | "EnterPlanMode" | "ExitPlanMode"
    )
}

/// True when `name` is an edit-surface tool that the current configuration
/// hides from the model. Hidden tools stay registered so restored sessions
/// keep replaying; execution is rejected by `execute_tool_with_registry`.
pub(crate) fn edit_surface_is_hidden(surface: kcoder_config::FileEditSurface, name: &str) -> bool {
    matches!(name, "edit" | "apply_patch") && name != surface.as_str()
}

pub(super) fn partition_tool_uses(
    tool_uses: Vec<ToolUseItem>,
    registry: &ToolRegistry,
) -> Vec<ToolUseGroup> {
    let mut groups: Vec<ToolUseGroup> = Vec::new();
    for item in tool_uses {
        let is_safe = registry
            .get(&item.name)
            .map(|tool| tool.is_concurrency_safe(&item.input))
            .unwrap_or(true);
        let sequential = !is_safe;
        if let Some(last) = groups.last_mut()
            && last.sequential == sequential
        {
            last.items.push(item);
            continue;
        }
        groups.push(ToolUseGroup {
            sequential,
            items: vec![item],
        });
    }
    groups
}

impl QueryEngine {
    pub(super) async fn execute_tool<P: PermissionPrompt>(
        &self,
        id: &str,
        name: &str,
        input: serde_json::Value,
        prompt: &P,
    ) -> Result<(
        ToolOutput,
        PermissionDecision,
        Option<Value>,
        Vec<EngineEvent>,
    )> {
        let arrangement_mode = self.is_arrangement_mode_active();
        let active_tools = self.active_tool_registry_for_mode(arrangement_mode);
        self.execute_tool_with_registry(id, name, input, prompt, &active_tools, arrangement_mode)
            .await
    }

    pub(super) async fn execute_tool_with_registry<P: PermissionPrompt>(
        &self,
        id: &str,
        name: &str,
        input: serde_json::Value,
        prompt: &P,
        active_tools: &ToolRegistry,
        arrangement_mode: bool,
    ) -> Result<(
        ToolOutput,
        PermissionDecision,
        Option<Value>,
        Vec<EngineEvent>,
    )> {
        let mut events: Vec<EngineEvent> = Vec::new();
        let Some(tool) = active_tools.get(name) else {
            debug!("model requested unavailable tool `{}`", name);
            return Ok((
                unknown_tool_output(name, active_tools),
                PermissionDecision::Deny,
                None,
                events,
            ));
        };
        if self.permission_mode_suppresses_user_elicitation() && is_user_elicitation_tool_name(name)
        {
            return Ok((
                ToolOutput::error(format!(
                    "Tool {name} was not executed: yolo mode does not ask the user. Make a reasonable assumption, continue autonomously, and report any important assumption in the final answer."
                )),
                PermissionDecision::Deny,
                None,
                events,
            ));
        }
        if is_goal_tool_name(name) && !recover_read_lock(&self.settings, "settings").goal_enabled {
            return Ok((
                ToolOutput::error(
                    "The `/goal` feature is disabled. Ask the user to run `/set goal_enabled true` before using goal tools.",
                ),
                PermissionDecision::Deny,
                None,
                events,
            ));
        }

        let hidden_edit = edit_surface_is_hidden(self.file_edit_surface, name);
        if hidden_edit {
            let active = self.file_edit_surface.as_str();
            return Ok((
                ToolOutput::error(format!(
                    "Tool {name} was not executed: the configured file-edit surface is \
                     `{active}`. Use that tool instead."
                )),
                PermissionDecision::Deny,
                None,
                events,
            ));
        }

        // --- Checkpoint: snapshot write/edit targets before this turn's
        // first mutation of each file (enables `/rewind`).
        if matches!(name, "write" | "edit")
            && let Some(path) = checkpoint::tool_target_path(&input)
        {
            let path = if path.is_absolute() {
                path
            } else {
                self.cwd.join(path)
            };
            self.checkpoints
                .snapshot_before_write(self.checkpoint_turn_index(), &path);
        }

        if name == "apply_patch"
            && let Some(patch) = input.get("patch").and_then(Value::as_str)
        {
            for relative in kcoder_tools::apply_patch::patch_affected_paths(patch) {
                let path = PathBuf::from(relative);
                let path = if path.is_absolute() {
                    path
                } else {
                    self.cwd.join(path)
                };
                self.checkpoints
                    .snapshot_before_write(self.checkpoint_turn_index(), &path);
            }
        }

        // --- Built-in TDD gate ---
        let tdd_decision = if self.is_luna_mode_active() {
            tdd_guard::TddGateDecision::Allow
        } else {
            let tdd_gate = recover_read_lock(&self.settings, "settings").tdd_gate;
            tdd_guard::decision(name, &input, &self.cwd, tdd_gate)
        };
        if tdd_decision.should_activate_skill() {
            self.activate_skill_if_available(TDD_SKILL_NAME);
        }
        match tdd_decision {
            tdd_guard::TddGateDecision::Block(error) => {
                return Ok((
                    ToolOutput::error(error),
                    PermissionDecision::Deny,
                    None,
                    events,
                ));
            }
            tdd_guard::TddGateDecision::Warn(text) => {
                events.push(EngineEvent::HookMessage {
                    text,
                    is_error: false,
                });
            }
            tdd_guard::TddGateDecision::Allow => {}
        }

        // The orchestration machine transformer must run before user hooks so hooks receive the complete transformed result.
        let input = if self.state.session_mode().is_orchestrate() {
            let settings = recover_read_lock(&self.settings, "settings").clone();
            match orchestrate::input::transform_input(&self.cwd, &settings, name, input) {
                Ok(input) => input,
                Err(error) => {
                    return Ok((
                        ToolOutput::error(format!(
                            "Orchestrate input transformation failed: {error:#}"
                        )),
                        PermissionDecision::Deny,
                        None,
                        events,
                    ));
                }
            }
        } else {
            input
        };

        // --- PreToolUse hooks ---
        let pre_input = self
            .hook_input(kcoder_hooks::HookEvent::PreToolUse, name, input.clone())
            .with_extra("tool_name", serde_json::json!(name))
            .with_extra("tool_input", input.clone());
        let pre_results = kcoder_hooks::execute_hooks(&self.hook_registry, pre_input).await;
        let pre_effects = kcoder_hooks::AggregatedEffects::aggregate(
            pre_results
                .iter()
                .filter_map(|r| match &r.outcome {
                    kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                    _ => None,
                })
                .collect(),
        );

        for (text, is_error) in &pre_effects.messages {
            events.push(EngineEvent::HookMessage {
                text: text.clone(),
                is_error: *is_error,
            });
        }

        if let Some(error) = kcoder_hooks::first_blocking_error(&pre_results) {
            return Ok((
                ToolOutput::error(error),
                PermissionDecision::Deny,
                None,
                events,
            ));
        }

        if pre_effects.prevent_continuation {
            return Ok((
                ToolOutput::error(
                    pre_effects
                        .stop_reason
                        .unwrap_or_else(|| "hook prevented continuation".into()),
                ),
                PermissionDecision::Deny,
                None,
                events,
            ));
        }

        let mut effective_input = input;
        if let Some(updated) = pre_effects.updated_input {
            effective_input = updated;
        }

        // Hook permission decision overrides the engine when explicit.
        let hook_decision = pre_effects.permission_decision;

        // --- Permission engine ---
        let (decision, mut effective_input) = match hook_decision {
            Some(kcoder_hooks::HookPermissionBehavior::Deny) => {
                (PermissionDecision::Deny, effective_input)
            }
            Some(kcoder_hooks::HookPermissionBehavior::Allow) => {
                (PermissionDecision::Allow, effective_input)
            }
            Some(kcoder_hooks::HookPermissionBehavior::Ask) => {
                if self.permission_mode_bypasses_prompts() {
                    (PermissionDecision::Allow, effective_input)
                } else {
                    let (mut request_events, _effects, _blocking_error) = self
                        .run_simple_hooks(
                            kcoder_hooks::HookEvent::PermissionRequest,
                            name,
                            serde_json::json!({
                                "tool_name": name,
                                "tool_input": effective_input.clone(),
                                "source": "pre_tool_use_hook",
                            }),
                        )
                        .await;
                    events.append(&mut request_events);
                    let context = request_context_for(tool.as_ref(), &effective_input);
                    let result = prompt.ask_context_with_edit(&context).await;
                    let decision = permission_response_to_decision(
                        result.response,
                        name,
                        &effective_input,
                        self,
                    )
                    .await;
                    let effective_input = apply_edited_input(result, effective_input);
                    (decision, effective_input)
                }
            }
            None => {
                let engine_decision = {
                    let permissions = recover_read_lock(&self.permissions, "permissions");
                    permissions.decide(tool.as_ref(), &effective_input)
                };
                if engine_decision == PermissionDecision::Ask {
                    let (mut request_events, _effects, _blocking_error) = self
                        .run_simple_hooks(
                            kcoder_hooks::HookEvent::PermissionRequest,
                            name,
                            serde_json::json!({
                                "tool_name": name,
                                "tool_input": effective_input.clone(),
                                "source": "permission_engine",
                            }),
                        )
                        .await;
                    events.append(&mut request_events);
                    let context = request_context_for(tool.as_ref(), &effective_input);
                    let result = prompt.ask_context_with_edit(&context).await;
                    let decision = permission_response_to_decision(
                        result.response,
                        name,
                        &effective_input,
                        self,
                    )
                    .await;
                    let effective_input = apply_edited_input(result, effective_input);
                    (decision, effective_input)
                } else {
                    (engine_decision, effective_input)
                }
            }
        };
        debug!("final permission decision for {}: {:?}", name, decision);

        match decision {
            PermissionDecision::Allow => {
                let input_schema = self.input_schema_for_tool(name, tool.as_ref());
                normalize_freeform_tool_input(&tool.input_format(), &mut effective_input);
                kcoder_tools::normalize_tool_input(name, &mut effective_input);
                let (
                    max_out,
                    head_out,
                    tail_out,
                    max_subagents,
                    coerce_options,
                    default_tool_timeout_ms,
                    sandbox_config,
                ) = {
                    let settings = recover_read_lock(&self.settings, "settings");
                    (
                        settings.max_tool_output_bytes,
                        settings.tool_output_head_bytes,
                        settings.tool_output_tail_bytes,
                        Some(effective_max_concurrent_subagents(&settings)),
                        kcoder_tools::CoercionOptions::from(&settings.tools.coerce),
                        settings.tool_timeout_ms,
                        settings.sandbox.clone(),
                    )
                };
                kcoder_tools::coerce_input_with_options(
                    &mut effective_input,
                    &input_schema,
                    &coerce_options,
                );
                if self.state.session_mode().is_orchestrate() {
                    let settings = recover_read_lock(&self.settings, "settings").clone();
                    match orchestrate::input::evaluate_final_input(
                        &self.cwd,
                        &self.state,
                        &settings,
                        name,
                        &effective_input,
                    ) {
                        orchestrate::input::PolicyDecision::Allow => {}
                        orchestrate::input::PolicyDecision::AllowWithDiagnostic(text) => {
                            events.push(EngineEvent::HookMessage {
                                text,
                                is_error: false,
                            });
                        }
                        orchestrate::input::PolicyDecision::Block(error) => {
                            return Ok((
                                ToolOutput::error(error),
                                PermissionDecision::Deny,
                                None,
                                events,
                            ));
                        }
                        orchestrate::input::PolicyDecision::BlockCompletion(error) => {
                            self.state.record_goal_completion_rejected(&error);
                            return Ok((
                                ToolOutput::error(error),
                                PermissionDecision::Deny,
                                None,
                                events,
                            ));
                        }
                    }
                }
                let tool_timeout_ms =
                    effective_tool_timeout_ms(name, &mut effective_input, default_tool_timeout_ms);
                if let Err(detail) =
                    kcoder_tools::validate_input_against_schema(&effective_input, &input_schema)
                {
                    debug!("tool {} input failed schema validation: {}", name, detail);
                    let error = ToolError::InvalidInput(detail);
                    let output = self.model_visible_tool_error(
                        name,
                        &effective_input,
                        Some(&input_schema),
                        &error,
                    );
                    let (mut failure_events, _effects, _blocking_error) = self
                        .run_post_tool_failure_hooks(name, &effective_input, &output)
                        .await;
                    events.append(&mut failure_events);
                    return Ok((output, PermissionDecision::Deny, None, events));
                }
                let track_shell_file_changes =
                    should_track_shell_file_changes(name, &effective_input);
                let shell_snapshot_before = if track_shell_file_changes {
                    let snapshot = snapshot_files_async(self.state.cwd()).await;
                    if snapshot.is_none() {
                        debug!(
                            "skipping shell FileChanged snapshot for {} because the working tree is too large or unreadable",
                            name
                        );
                    }
                    snapshot
                } else {
                    None
                };
                let mut use_sandbox = true;
                let mut escalated_attempts = 0usize;
                let mut output = loop {
                    let mut ctx = self
                        .base_tool_context_with_arrangement_mode(
                            max_out,
                            head_out,
                            tail_out,
                            max_subagents,
                            arrangement_mode,
                        )
                        .with_tool_call_id(id);
                    if use_sandbox {
                        ctx = ctx.with_sandbox(Arc::clone(&self.sandbox));
                    }
                    let invocation_timeout_ms = if matches!(name, "bash" | "PowerShell") {
                        tool_timeout_ms.saturating_add(SHELL_TOOL_CLEANUP_GRACE_MS)
                    } else {
                        tool_timeout_ms
                    };
                    let (_read_guard, _write_guard) =
                        if kcoder_tools::workflow::coordinates_execution(name) {
                            (None, None)
                        } else if tool.is_concurrency_safe(&effective_input) {
                            (Some(self.tool_execution_gate.read().await), None)
                        } else {
                            (None, Some(self.tool_execution_gate.write().await))
                        };
                    let call_result = if invocation_timeout_ms == 0 {
                        Ok(tool.call(effective_input.clone(), &ctx).await)
                    } else {
                        timeout(
                            Duration::from_millis(invocation_timeout_ms),
                            tool.call(effective_input.clone(), &ctx),
                        )
                        .await
                    };
                    match call_result {
                        Ok(Ok(output)) => break output,
                        Ok(Err(ToolError::SandboxDenied { reason, output }))
                            if should_retry_shell_without_sandbox(
                                name,
                                &sandbox_config,
                                escalated_attempts,
                            ) =>
                        {
                            let attempt = escalated_attempts + 1;
                            let bypasses_prompts = self.permission_mode_bypasses_prompts();
                            let notice = if bypasses_prompts {
                                format!(
                                    "Shell command was denied by the sandbox; retrying without the sandbox because the current permission mode bypasses prompts: {reason}"
                                )
                            } else {
                                format!(
                                    "Shell command was denied by the sandbox; requesting approval to retry without the sandbox: {reason}"
                                )
                            };
                            events.push(EngineEvent::SystemNotice(notice));
                            let (mut attempt_events, attempt_effects, attempt_blocking_error) =
                                self.run_simple_hooks(
                                    kcoder_hooks::HookEvent::SandboxEscalationAttempt,
                                    name,
                                    serde_json::json!({
                                        "tool_name": name,
                                        "tool_input": effective_input.clone(),
                                        "reason": reason.clone(),
                                        "output": output.clone(),
                                        "attempt": attempt,
                                        "from_sandbox": "configured",
                                        "to_sandbox": "unrestricted",
                                    }),
                                )
                                .await;
                            events.append(&mut attempt_events);
                            let attempt_blocking_error = attempt_blocking_error.or_else(|| {
                                if attempt_effects.prevent_continuation {
                                    Some(attempt_effects.stop_reason.unwrap_or_else(|| {
                                        "sandbox escalation attempt hook prevented continuation"
                                            .to_string()
                                    }))
                                } else {
                                    None
                                }
                            });
                            if let Some(error) = attempt_blocking_error {
                                let denied = ToolOutput::error(error);
                                let (mut failure_events, _effects, _blocking_error) = self
                                    .run_post_tool_failure_hooks(name, &effective_input, &denied)
                                    .await;
                                events.append(&mut failure_events);
                                return Ok((denied, PermissionDecision::Deny, None, events));
                            }
                            if sandbox_config.require_shell_escalation_approval && !bypasses_prompts
                            {
                                let context = sandbox_escalation_request_context(
                                    tool.as_ref(),
                                    &effective_input,
                                    &reason,
                                    output.as_deref(),
                                );
                                let response = prompt.ask_context(&context).await;
                                let re_decision = permission_response_to_decision(
                                    response,
                                    name,
                                    &effective_input,
                                    self,
                                )
                                .await;
                                if re_decision != PermissionDecision::Allow {
                                    let denied = ToolOutput::error(
                                        "permission denied: sandbox escalation was not approved",
                                    );
                                    let (mut failure_events, _effects, _blocking_error) = self
                                        .run_post_tool_failure_hooks(
                                            name,
                                            &effective_input,
                                            &denied,
                                        )
                                        .await;
                                    events.append(&mut failure_events);
                                    return Ok((denied, PermissionDecision::Deny, None, events));
                                }
                            }
                            let (mut escalated_events, escalated_effects, escalated_blocking_error) =
                                self.run_simple_hooks(
                                    kcoder_hooks::HookEvent::SandboxEscalated,
                                    name,
                                    serde_json::json!({
                                        "tool_name": name,
                                        "tool_input": effective_input.clone(),
                                        "reason": reason.clone(),
                                        "output": output.clone(),
                                        "attempt": attempt,
                                        "from_sandbox": "configured",
                                        "to_sandbox": "unrestricted",
                                    }),
                                )
                                .await;
                            events.append(&mut escalated_events);
                            let escalated_blocking_error = escalated_blocking_error.or_else(|| {
                                if escalated_effects.prevent_continuation {
                                    Some(escalated_effects.stop_reason.unwrap_or_else(|| {
                                        "sandbox escalated hook prevented continuation".to_string()
                                    }))
                                } else {
                                    None
                                }
                            });
                            if let Some(error) = escalated_blocking_error {
                                let denied = ToolOutput::error(error);
                                let (mut failure_events, _effects, _blocking_error) = self
                                    .run_post_tool_failure_hooks(name, &effective_input, &denied)
                                    .await;
                                events.append(&mut failure_events);
                                return Ok((denied, PermissionDecision::Deny, None, events));
                            }
                            escalated_attempts += 1;
                            use_sandbox = false;
                            continue;
                        }
                        Ok(Err(ToolError::SandboxDenied { reason, output }))
                            if is_shell_tool_name(name)
                                && sandbox_config.allow_shell_escalation =>
                        {
                            let error = ToolError::SandboxDenied {
                                reason: format!(
                                    "{reason}; sandbox escalation chain exhausted after {escalated_attempts} attempt(s)"
                                ),
                                output,
                            };
                            debug!("tool {} returned model-visible error: {}", name, error);
                            let output = self.model_visible_tool_error(
                                name,
                                &effective_input,
                                Some(&input_schema),
                                &error,
                            );
                            let (mut failure_events, _effects, _blocking_error) = self
                                .run_post_tool_failure_hooks(name, &effective_input, &output)
                                .await;
                            events.append(&mut failure_events);
                            return Ok((output, PermissionDecision::Deny, None, events));
                        }
                        Ok(Err(error)) => {
                            debug!("tool {} returned model-visible error: {}", name, error);
                            let output = self.model_visible_tool_error(
                                name,
                                &effective_input,
                                Some(&input_schema),
                                &error,
                            );
                            let (mut failure_events, _effects, _blocking_error) = self
                                .run_post_tool_failure_hooks(name, &effective_input, &output)
                                .await;
                            events.append(&mut failure_events);
                            return Ok((output, PermissionDecision::Deny, None, events));
                        }
                        Err(_) => {
                            debug!("tool {} timed out after {} ms", name, tool_timeout_ms);
                            let output = self.model_visible_timeout_error(
                                name,
                                &effective_input,
                                tool_timeout_ms,
                            );
                            let (mut failure_events, _effects, _blocking_error) = self
                                .run_post_tool_failure_hooks(name, &effective_input, &output)
                                .await;
                            events.append(&mut failure_events);
                            return Ok((output, PermissionDecision::Deny, None, events));
                        }
                    }
                };
                let (shell_changed_paths, shell_changes_truncated) =
                    if let Some(before) = shell_snapshot_before.as_ref() {
                        snapshot_files_async(self.state.cwd())
                            .await
                            .map(|after| changed_snapshot_paths(before, &after))
                            .unwrap_or_else(|| (Vec::new(), false))
                    } else {
                        (Vec::new(), false)
                    };
                let recovered_failure = if output.is_error {
                    self.append_repeated_failure_warning(name, &effective_input, &mut output);
                    self.mark_verification_failure(name, &effective_input);
                    let (mut failure_events, _effects, _blocking_error) = self
                        .run_post_tool_failure_hooks(name, &effective_input, &output)
                        .await;
                    events.append(&mut failure_events);
                    None
                } else {
                    self.mark_tool_success(name, &effective_input)
                };
                let recovered_verification_failure = if output.is_error {
                    None
                } else {
                    self.mark_verification_success(name, &effective_input)
                };

                if !shell_changed_paths.is_empty() {
                    let query = if shell_changed_paths.len() == 1 {
                        shell_changed_paths[0].clone()
                    } else {
                        name.to_string()
                    };
                    let (mut shell_events, _effects, _blocking_error) = self
                        .run_simple_hooks(
                            kcoder_hooks::HookEvent::FileChanged,
                            query,
                            serde_json::json!({
                                "tool": name,
                                "paths": shell_changed_paths,
                                "input": effective_input.clone(),
                                "source": "shell_snapshot",
                                "is_error": output.is_error,
                                "truncated": shell_changes_truncated,
                            }),
                        )
                        .await;
                    events.append(&mut shell_events);
                }
                let file_observation_paths = if output.is_error {
                    Vec::new()
                } else if !shell_changed_paths.is_empty() {
                    shell_changed_paths.clone()
                } else if is_direct_file_mutation_tool_name(name) {
                    collect_touched_paths(&effective_input, &self.cwd)
                } else {
                    Vec::new()
                };
                self.record_file_change_observation(
                    id,
                    name,
                    &file_observation_paths,
                    shell_changes_truncated,
                );
                self.record_verification_observation(id, name, &effective_input, output.is_error);
                self.record_failure_recovery_observation(
                    id,
                    name,
                    &effective_input,
                    recovered_failure.as_ref(),
                );
                if recovered_failure.is_none() {
                    self.record_verification_target_recovery_observation(
                        id,
                        name,
                        &effective_input,
                        recovered_verification_failure.as_ref(),
                    );
                }

                let mut lifecycle_events = self
                    .run_success_lifecycle_hooks(name, &effective_input, &output)
                    .await;
                events.append(&mut lifecycle_events);

                // --- PostToolUse hooks ---
                let post_input = self
                    .hook_input(
                        kcoder_hooks::HookEvent::PostToolUse,
                        name,
                        effective_input.clone(),
                    )
                    .with_extra("tool_name", serde_json::json!(name))
                    .with_extra("tool_input", effective_input)
                    .with_extra("tool_output", serde_json::json!(tool_output_text(&output)))
                    .with_extra("is_error", serde_json::json!(output.is_error));
                let post_results =
                    kcoder_hooks::execute_hooks(&self.hook_registry, post_input).await;
                let post_effects = kcoder_hooks::AggregatedEffects::aggregate(
                    post_results
                        .iter()
                        .filter_map(|r| match &r.outcome {
                            kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                            _ => None,
                        })
                        .collect(),
                );
                for (text, is_error) in &post_effects.messages {
                    events.push(EngineEvent::HookMessage {
                        text: text.clone(),
                        is_error: *is_error,
                    });
                }

                Ok((output, decision, None, events))
            }
            PermissionDecision::Deny => {
                warn!("tool {} denied", name);
                let mut output =
                    ToolOutput::error(format!("Tool {} was not executed: permission denied", name));
                self.append_repeated_failure_warning(name, &effective_input, &mut output);
                events.push(EngineEvent::ToolDenied {
                    id: id.to_string(),
                    name: name.to_string(),
                    reason: "permission denied by configured policy".to_string(),
                });
                let (mut denied_events, _effects, _blocking_error) = self
                    .run_simple_hooks(
                        kcoder_hooks::HookEvent::PermissionDenied,
                        name,
                        serde_json::json!({
                            "tool_name": name,
                            "tool_input": effective_input,
                            "reason": "permission denied",
                        }),
                    )
                    .await;
                events.append(&mut denied_events);
                Ok((output, PermissionDecision::Deny, None, events))
            }
            PermissionDecision::Ask => unreachable!(),
        }
    }
}
