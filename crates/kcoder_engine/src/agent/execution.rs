//! Agent execution; state ownership is retained by the agent facade.

use super::*;
use anyhow::Context;

#[derive(Clone, Copy)]
enum ForkHistorySource<'a> {
    Parent(Option<&'a kcoder_state::context_archive::ContextHistoryAnchor>),
    Checkpoint,
}

pub(super) fn subagent_model_detail_due(
    last_emit: std::time::Instant,
    now: std::time::Instant,
) -> bool {
    now.saturating_duration_since(last_emit) >= SUBAGENT_MODEL_DETAIL_INTERVAL
}

pub(super) async fn run_subagent_hook(
    parent: &QueryEngine,
    event: kcoder_hooks::HookEvent,
    agent_id: &str,
    data: serde_json::Value,
) -> anyhow::Result<()> {
    let (_events, effects, blocking_error) = parent
        .run_simple_hooks(event, agent_id.to_string(), data)
        .await;
    if let Some(reason) = blocking_error.or(effects.blocking_error) {
        return Err(anyhow::anyhow!(
            "{} hook blocked subagent operation: {}",
            event.as_str(),
            reason
        ));
    }
    if effects.prevent_continuation {
        return Err(anyhow::anyhow!(
            "{} hook prevented subagent continuation: {}",
            event.as_str(),
            effects
                .stop_reason
                .unwrap_or_else(|| "no reason provided".to_string())
        ));
    }
    Ok(())
}

/// Run a forked agent that shares the parent's cache-safe parameters.
///
/// The fork is an in-process same-runtime task. It reuses the parent's
/// provider and rebuilds the same system prompt for cache sharing.
pub async fn run_forked_agent(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    prompt_messages: Vec<Message>,
    overrides: SubagentContextOverrides,
    max_turns: usize,
) -> anyhow::Result<ForkedAgentResult> {
    run_forked_agent_with_tools(
        parent,
        cache_safe,
        prompt_messages,
        overrides,
        max_turns,
        tool_policy::filter_tools_for_agent_kind_in_mode(
            &parent.tools,
            AgentKind::General,
            true,
            parent.is_arrangement_mode_active(),
        ),
    )
    .await
}

pub async fn run_forked_agent_with_tools(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    prompt_messages: Vec<Message>,
    overrides: SubagentContextOverrides,
    max_turns: usize,
    tools: ToolRegistry,
) -> anyhow::Result<ForkedAgentResult> {
    let prompt_message_count = prompt_messages.len();
    let mut initial_messages = cache_safe.fork_context_messages.to_vec();
    initial_messages.extend(prompt_messages);
    run_forked_agent_from_messages(
        parent,
        cache_safe,
        ForkedAgentRequest {
            agent_id: None,
            messages: initial_messages,
            prompt_message_count,
            initial_delivery: None,
            overrides,
            max_turns,
            tools,
            runtime: None,
        },
    )
    .await
}

/// Switch a verifier to an isolated write root while preserving parent read-deny and OS sandbox policies.
///
/// `denied_paths` may be relative to the parent workspace, so use the already
/// re-anchored configuration from the parent Sandbox instead of reinterpreting fork
/// Settings. The verifier may run tests in the candidate worktree, pristine read-only
/// baseline, and private runtime directory, but cannot escalate or write shared caches.
pub(super) fn verifier_sandbox_from_parent(
    parent: &kcoder_tools::Sandbox,
    shell_write_root: PathBuf,
    baseline_root: Option<PathBuf>,
    runtime_write_root: PathBuf,
) -> kcoder_tools::Sandbox {
    let allowed_paths = std::iter::once(shell_write_root.display().to_string())
        .chain(baseline_root.iter().map(|path| path.display().to_string()))
        .collect();
    let readonly_paths = baseline_root.into_iter().collect();
    let mut config = parent.reanchored_config();
    config.enabled = true;
    config.readonly = false;
    config.allow_shell_escalation = false;
    config.require_shell_escalation_approval = true;
    config.shell_escalation_max_attempts = 0;
    config.allowed_paths = allowed_paths;

    kcoder_tools::Sandbox::new(shell_write_root, config)
        .with_readonly_paths(readonly_paths)
        .with_runtime_write_path(runtime_write_root)
        .without_shared_dev_cache_writes()
}

pub async fn continue_forked_agent_with_tools(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    debug_assert!(request.agent_id.is_some());
    run_forked_agent_from_messages_native(
        parent,
        cache_safe,
        request,
        None,
        ForkHistorySource::Checkpoint,
    )
    .await
}

impl fmt::Display for ForkedAgentAborted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "forked agent aborted: {}", self.reason)
    }
}

impl StdError for ForkedAgentAborted {}

impl fmt::Display for ForkedAgentMaxTurnsReached {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "forked agent reached maximum turns ({})",
            self.max_turns
        )
    }
}

impl StdError for ForkedAgentMaxTurnsReached {}

pub(crate) fn is_forked_agent_max_turns_reached(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ForkedAgentMaxTurnsReached>().is_some()
}

pub(super) fn map_forked_agent_error(error: anyhow::Error) -> AgentError {
    match error.downcast_ref::<ForkedAgentAborted>() {
        Some(aborted) if aborted.reason == "agent_control:paused" => {
            AgentError::Paused("pause requested by parent Orchestrate session".to_string())
        }
        Some(aborted) if aborted.reason == "agent_control:halted" => {
            AgentError::Halted("halt requested by parent Orchestrate session".to_string())
        }
        Some(aborted) if aborted.cancelled => AgentError::Cancelled(aborted.reason.clone()),
        _ => AgentError::Execution(error.to_string()),
    }
}

pub(crate) async fn run_forked_agent_from_messages(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    run_forked_agent_from_messages_native(
        parent,
        cache_safe,
        request,
        None,
        ForkHistorySource::Parent(cache_safe.context_history_anchor.as_ref()),
    )
    .await
}

pub(super) async fn run_forked_agent_with_native_source(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    source_parent: &crate::integrations::core::NativeToolExecutionWitness,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    run_forked_agent_from_messages_native(
        parent,
        cache_safe,
        request,
        Some(source_parent),
        ForkHistorySource::Parent(cache_safe.context_history_anchor.as_ref()),
    )
    .await
}

pub(super) async fn continue_forked_agent_with_native_source(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    source_parent: &crate::integrations::core::NativeToolExecutionWitness,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    run_forked_agent_from_messages_native(
        parent,
        cache_safe,
        request,
        Some(source_parent),
        ForkHistorySource::Checkpoint,
    )
    .await
}

async fn run_forked_agent_from_messages_native(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    request: ForkedAgentRequest,
    source_parent: Option<&crate::integrations::core::NativeToolExecutionWitness>,
    history_source: ForkHistorySource<'_>,
) -> anyhow::Result<ForkedAgentResult> {
    let workflow_parent = if parent.native_tool_authorization.is_some() {
        let original = source_parent.ok_or_else(|| {
            anyhow::anyhow!(
                "forked agent native admission rejected: NATIVE_CHILD_ORIGINAL_PARENT_REQUIRED"
            )
        })?;
        anyhow::ensure!(
            original.matches_state(&parent.state) && original.session_id() == parent.session_id(),
            "forked agent native admission rejected: NATIVE_CHILD_ORIGINAL_PARENT_CHANGED"
        );
        if original.attempt().is_some() {
            None
        } else {
            Some(
                parent
                    .capture_native_workflow_parent(
                        original,
                        request.agent_id.as_deref().ok_or_else(|| {
                            anyhow::anyhow!("NATIVE_WORKFLOW_NATIVE_RUN_REQUIRED")
                        })?,
                    )
                    .await?,
            )
        }
    } else {
        None
    };
    let ForkedAgentRequest {
        agent_id: agent_id_override,
        messages: mut initial_messages,
        prompt_message_count,
        initial_delivery,
        overrides,
        max_turns,
        tools,
        runtime,
    } = request;
    let history_anchor = match history_source {
        ForkHistorySource::Parent(anchor) => anchor,
        ForkHistorySource::Checkpoint => None,
    };
    if let Some(anchor) = history_anchor
        && let Some(prefix) = anchor.canonical_prefix_len(&initial_messages)?
    {
        initial_messages.drain(..prefix);
    }
    let verifier_terminal_verdict = overrides.verifier_terminal_verdict;
    let artifact_replay_output = overrides.artifact_replay_output.clone();
    let verifier_vote_channel = overrides.verifier_vote_channel.clone();
    let review_vote_channel = overrides.review_vote_channel.clone();
    let terminal_verdict = verifier_terminal_verdict || review_vote_channel.is_some();
    let _subagent_permit = parent
        .acquire_subagent_permit()
        .await
        .map_err(anyhow::Error::msg)?;

    // Isolation worktrees re-root the child's session cwd; the engine-level
    // sandbox stays anchored at the parent workspace, which already contains
    // the managed `.kcoder/worktrees/` directory.
    let fork_cwd = overrides
        .cwd_override
        .clone()
        .unwrap_or_else(|| parent.cwd.clone());
    let agent_id = match agent_id_override {
        Some(id) => id,
        None => generate_agent_id(parent)?,
    };
    let transcript_path = parent
        .state
        .task(&agent_id)
        .and_then(|task| task.transcript_path)
        .unwrap_or_else(|| parent.state.subagent_transcript_path(&agent_id));
    let fork_state = if let Some(registry) = parent.state.short_id_registry() {
        let state = AppState::new_with_short_id(fork_cwd.clone(), &registry)?;
        state.set_messages(initial_messages);
        state
    } else {
        AppState::with_messages(fork_cwd.clone(), initial_messages)
    };
    fork_state.set_usage_history_root(parent.state.usage_history_root().as_deref());
    if let Some(project_dir) = parent.state.session_artifact_project_dir() {
        fork_state
            .with_session_artifact_project_dir(project_dir, parent.state.artifact_session_id());
    }
    if history_anchor.is_some() {
        parent.state.flush_history().await?;
    }
    let source = parent.clone();
    let child = fork_state.clone();
    let anchor = history_anchor.cloned();
    let path = transcript_path.clone();
    let restore_checkpoint = matches!(history_source, ForkHistorySource::Checkpoint);
    let cancel = parent.cancel_token().child_token();
    {
        let _copy_scope = cancel.clone().drop_guard();
        tokio::task::spawn_blocking(move || {
            anyhow::ensure!(
                !cancel.is_cancelled(),
                "context history initialization cancelled"
            );
            child.with_subagent_context_history(&path)?;
            let inherited = if let Some(anchor) = anchor {
                child.inherit_compacted_history_from(&source.state, &anchor, || {
                    cancel.is_cancelled()
                })?
            } else if restore_checkpoint {
                if let Some((messages, reference)) = checkpoint::read_checkpoint_context(&path)? {
                    child.inherit_checkpoint_context_history(
                        &path,
                        &reference,
                        &messages,
                        || cancel.is_cancelled(),
                    )?
                } else {
                    false
                }
            } else {
                false
            };
            if !inherited {
                child.save_history()?;
            }
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("subagent context history worker stopped")??;
    }
    let allowed_write_paths = overrides.allowed_write_paths.clone();
    let allowed_shell_prefixes = overrides.scoped_allowed_shell_prefixes.clone();
    let block_shell_file_mutation = overrides.block_shell_file_mutation;
    let arrangement_mode = overrides
        .arrangement_mode
        .unwrap_or_else(|| parent.is_arrangement_mode_active());
    let subagent =
        SubagentContext::from_parent_with_agent_id(parent, fork_state, overrides, agent_id.clone());
    subagent.state.with_llm_request_history_dir(
        parent.state.subagent_llm_request_history_dir(&agent_id),
        parent.state.artifact_session_id(),
    );
    let tool_names = tools.names();
    let unbound_question_projection = initial_delivery.is_some()
        && parent.state.task(&agent_id).is_some_and(|task| {
            tool_policy::is_unbound_question_projection(&task.resolved_tool_allowlist, &tool_names)
        });
    let deferred_native_office_tools =
        workflow_parent.is_some() && parent.native_office_projection.is_some();
    if !unbound_question_projection && !deferred_native_office_tools {
        parent
            .state
            .record_agent_resolved_tool_allowlist(&agent_id, tool_names.clone())?;
    }
    run_subagent_hook(
        parent,
        kcoder_hooks::HookEvent::SubagentStart,
        &agent_id,
        serde_json::json!({
            "agent_id": agent_id.clone(),
            "max_turns": max_turns,
            "prompt_messages": prompt_message_count,
            "tools": tool_names,
            "cwd": fork_cwd.display().to_string(),
        }),
    )
    .await?;

    let inherited_client_storage = matches!(
        parent.workspace_persistence_mode,
        WorkspacePersistenceMode::Client
    )
    .then(|| {
        Ok((
            parent.session_storage_root.clone(),
            parent.client_storage_owner.clone(),
        ))
    });
    let fork_provider = runtime
        .as_ref()
        .map(|runtime| Arc::clone(&runtime.provider))
        .unwrap_or_else(|| parent.current_provider());
    let fork_settings = runtime
        .as_ref()
        .map(|runtime| runtime.settings.clone())
        .unwrap_or_else(|| crate::recover_read_lock(&parent.settings, "settings").clone());
    let mut forked_engine = QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
        fork_provider,
        subagent.state,
        tools,
        subagent.permissions,
        fork_settings,
        parent.memory_manager.as_ref().clone(),
        crate::recover_read_lock(&parent.skill_registry, "skill_registry").clone(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        fork_cwd.clone(),
        None,
        Some(parent.plugin_snapshot.as_ref().clone()),
        parent.workspace_persistence_mode,
        inherited_client_storage,
        Some(parent.workspace_runtime_services()),
        true,
    )?
    .with_owned_command_program(parent.owned_command_program.clone())
    .with_inherited_native_tool_ceiling(parent)
    .with_project_user_context_from(parent)?
    .with_subagent_system_prompt(subagent.overrides.role_system_prompt.clone())
    .with_subagent_runtime_control(
        parent.state.clone(),
        agent_id.clone(),
        transcript_path.clone(),
    )
    .with_subagent_tools(parent.active_subagent_tools_for_mode(arrangement_mode))
    // The supplied `tools` are already role-filtered for Arrangement worker
    // semantics. Do not put the forked worker engine into main-orchestrator
    // Arrangement mode, or its active registry/system prompt would be replaced
    // by the orchestrator profile and hide edit/write/bash from implementers.
    .with_arrangement_mode(false)
    .with_agent_depth(subagent.depth)
    .with_skill_mutation_actor(subagent.tool_context.skill_mutation_actor.clone())
    .with_allowed_write_paths(allowed_write_paths)
    .with_allowed_shell_prefixes(allowed_shell_prefixes)
    .with_block_shell_file_mutation(block_shell_file_mutation)
    .with_block_dependency_mutation(subagent.overrides.block_dependency_mutation)
    .with_shell_isolation_root(subagent.overrides.shell_isolation_root.clone())
    .with_verifier_test_policy(
        subagent.overrides.verifier_minimum_test_scope,
        subagent.overrides.verifier_require_raw_exit_code,
    )
    .with_verifier_behavior_delta(subagent.overrides.verifier_require_behavior_delta)
    .with_verifier_baseline_root(subagent.overrides.verifier_baseline_root.clone())
    .with_verifier_vote_channel(subagent.overrides.verifier_vote_channel.clone())
    .with_review_vote_channel(subagent.overrides.review_vote_channel.clone())
    .with_terminal_verdict_turn(
        subagent.overrides.verifier_terminal_verdict
            || subagent.overrides.review_vote_channel.is_some(),
    )
    .with_cancel_token(
        subagent
            .tool_context
            .abort_token
            .clone()
            .unwrap_or_default(),
    );
    forked_engine = forked_engine.inherit_native_model_requests_from(parent)?;
    forked_engine.request_class = parent.request_class;
    if subagent.overrides.isolate_shell_writes {
        let shell_write_root = subagent
            .overrides
            .shell_write_root
            .clone()
            .unwrap_or_else(|| forked_engine.state.cwd());
        let sandbox = verifier_sandbox_from_parent(
            parent.sandbox.as_ref(),
            shell_write_root,
            subagent.overrides.verifier_baseline_root.clone(),
            subagent
                .overrides
                .shell_isolation_root
                .clone()
                .unwrap_or_else(|| forked_engine.state.cwd()),
        );
        forked_engine = forked_engine.with_sandbox(sandbox);
    }

    // Regular sub-agents use the parent task's active runtime; an MoA planner may
    // explicitly carry independent provider settings. Cache-safe snapshots carry
    // context only and do not participate in runtime selection.
    {
        let mut settings = crate::recover_write_lock(&forked_engine.settings, "settings");
        if runtime.is_none() {
            let parent_settings = crate::recover_read_lock(&parent.settings, "settings");
            settings.model = parent_settings.model.clone();
            settings.model_reasoning_effort = parent_settings.model_reasoning_effort.clone();
            settings.max_tokens = parent_settings.max_tokens;
        }
        settings.auto_memory_enabled = false;
        settings.session_memory.update_enabled = false;
        settings.auto_skill_review_enabled = false;
    }
    if let Some(observer) = &subagent.overrides.configuration_observer {
        // The fork now owns its resolved settings and actual role-filtered registry.
        // Capture here, after queued permit waits and all inheritance, rather than
        // projecting the mutable parent before the child starts.
        let mut configuration = forked_engine.active_model_configuration_summary()?;
        if let Some(tools) = &mut configuration.tool_set {
            tools.registry_scope = kcoder_types::ModelToolRegistryScope::SessionRole;
        }
        observer
            .capture(
                configuration,
                if runtime.is_some() {
                    "explicit_runtime"
                } else {
                    "inherited_session"
                },
            )
            .map_err(anyhow::Error::msg)?;
    }
    *crate::recover_write_lock(&forked_engine.active_skills, "active_skills") =
        cache_safe.active_skills.clone();

    let (initial_messages, repaired_initial_sequence) =
        crate::repair_tool_message_sequence(forked_engine.state.messages());
    if repaired_initial_sequence {
        warn!(
            message_count = initial_messages.len(),
            "repaired legacy or interrupted ToolUse/ToolResult sequence before a forked provider request"
        );
        forked_engine
            .state
            .set_messages_preserving_history_ids(initial_messages.clone());
    }
    debug_assert!(unmatched_tool_use_ids(&initial_messages).is_empty());

    let admission = forked_engine
        .admit_native_child(parent, source_parent, workflow_parent.as_ref())
        .await?;
    let admitted_workflow_child = admission.is_some() && workflow_parent.is_some();
    let execution = async {
        if admitted_workflow_child {
            // This future runs inside the real child Accepted history scope.
            // Only the parent's opaque native authority can expose this child.
            forked_engine = forked_engine.with_native_core_workflow_office_child_from(parent)?;
        }
        if deferred_native_office_tools && !unbound_question_projection {
            parent
                .state
                .record_agent_resolved_tool_allowlist(&agent_id, forked_engine.tools.names())?;
        }
        let protected_stream = forked_engine.native_tool_authorization.is_some();
        if protected_stream {
            forked_engine = forked_engine.with_private_native_child_checkpoints();
            // Cached artifact output and public checkpoints are output paths too.
            // A real child Accepted/TI must exist before any of them can publish.
            forked_engine
                .authorize_native_provider()
                .await
                .map_err(|error| {
                    anyhow::anyhow!("forked agent native admission rejected: {error}")
                })?;
        }
        let auto_prompt = AutoDenyPrompt;
        let artifact_run = artifact_validation::begin(
            parent,
            &forked_engine,
            &agent_id,
            initial_delivery.as_ref(),
            artifact_replay_output.is_some(),
        )
        .await?;
        if let Some(output_text) = artifact_replay_output {
            artifact_validation::finish(parent, &forked_engine, &agent_id, artifact_run).await?;
            return Ok(ForkedAgentResult {
                agent_id,
                messages: forked_engine.state.messages(),
                output_text,
                trusted_tool_results: HashMap::new(),
            });
        }
        if protected_stream {
            forked_engine
                .write_context_checkpoint(&transcript_path, &forked_engine.state.messages(), false)
                .await?;
        } else {
            forked_engine
                .write_context_checkpoint(&transcript_path, &forked_engine.state.messages(), true)
                .await?;
        }
        let initial_delivery_index = initial_delivery.as_ref().and_then(|delivery| {
            parent
                .state
                .task(&agent_id)
                .and_then(|task| {
                    task.message_queue
                        .into_iter()
                        .find(|queued| queued.message_id == delivery.message_id)
                })
                .and_then(|queued| {
                    queued
                        .transcript_anchor
                        .map(|anchor| anchor.baseline_message_count)
                })
        });
        if let Some(delivery) = initial_delivery.as_ref() {
            let expected = forked_engine
                .subagent_runtime_control
                .as_ref()
                .as_ref()
                .and_then(|control| control.expected_background_run.as_ref());
            let acknowledged = if let Some(run) = expected {
                parent.state.ack_subagent_delivery_for_run(
                    &agent_id,
                    &delivery.message_id,
                    &delivery.lease_id,
                    run,
                )?
            } else {
                parent.state.ack_subagent_delivery(
                    &agent_id,
                    &delivery.message_id,
                    &delivery.lease_id,
                )?
            };
            if !acknowledged {
                anyhow::bail!(
                    "initial delivery {} disappeared before its transcript checkpoint could be acknowledged",
                    delivery.message_id
                );
            }
        }
        if let Some(delivery) = initial_delivery.as_ref() {
            let queue_depth = parent
                .state
                .task(&agent_id)
                .map(|task| task.message_queue.len())
                .unwrap_or_default();
            parent.background_jobs.report_subagent_steer_applied(
                &agent_id,
                &delivery.message_id,
                queue_depth,
            );
        }
        let mut stream = forked_engine.run_native_turn_stream_with_subagent_finish_reminders(
            &auto_prompt,
            max_turns,
            agent_id.clone(),
        );
        let mut streamed_output_text = String::new();
        let mut live_view: Option<crate::agent_live_view::AgentLiveWriter> = None;
        let mut native_event_rejection = None;
        let mut trusted_tool_results = HashMap::new();
        let mut trusted_tool_result_bytes = 0usize;
        let mut pending_abort: Option<(String, bool)> = None;
        let mut forced_terminal_output: Option<String> = None;
        let mut current_turn = 1usize;
        let mut advance_turn_on_next_message = false;
        let mut last_progress = Some((1usize, "Waiting for model".to_string()));
        let mut latest_model_text = String::new();
        let mut last_model_detail_emit = std::time::Instant::now()
            .checked_sub(SUBAGENT_MODEL_DETAIL_INTERVAL)
            .unwrap_or_else(std::time::Instant::now);
        parent.report_background_job_progress(
            &agent_id,
            "Waiting for model",
            Some(1),
            Some(max_turns),
        );

        while let Some(frame) = stream.next().await {
            if native_event_rejection.is_none()
                && let Err(error) = forked_engine
                    .authorize_native_child_event(parent, &frame)
                    .await
            {
                native_event_rejection = Some(error);
                // Drain the same owned stream after cancelling so it can commit the
                // original interrupted tool results. Rejected payloads never reach
                // presentation, progress, trusted results, Hooks or parent output.
                forked_engine.cancel_token().cancel();
                streamed_output_text.clear();
                latest_model_text.clear();
                trusted_tool_results.clear();
            }
            if native_event_rejection.is_some() {
                continue;
            }
            let event = frame.into_event();
            let writer = live_view.get_or_insert_with(|| {
                let writer = parent.background_jobs.live_views.register_with_run(
                    &agent_id,
                    forked_engine.state.messages(),
                    parent
                        .state
                        .task(&agent_id)
                        .and_then(|task| task.background_run)
                        .map(|run| run.run_id)
                        .unwrap_or_else(|| format!("agent-{}", uuid::Uuid::new_v4())),
                );
                if let (Some(delivery), Some(index)) =
                    (initial_delivery.as_ref(), initial_delivery_index)
                {
                    let client_message_id = parent.state.task(&agent_id).and_then(|task| {
                        task.command_receipts
                            .into_iter()
                            .find(|receipt| receipt.message_id == delivery.message_id)
                            .map(|receipt| receipt.client_message_id)
                    });
                    writer.bind_source_message(index, &delivery.message_id, client_message_id);
                }
                writer
            });
            writer.update(&event, || forked_engine.state.messages());
            record_agent_breaker_event(parent, &agent_id, &event);
            if let EngineEvent::SubagentSteerApplied {
                agent_id: applied_agent_id,
                message_id,
                queue_depth,
            } = &event
            {
                if applied_agent_id == &agent_id {
                    parent.background_jobs.report_subagent_steer_applied(
                        applied_agent_id,
                        message_id,
                        *queue_depth,
                    );
                } else {
                    warn!(
                        expected_agent_id = %agent_id,
                        actual_agent_id = %applied_agent_id,
                        %message_id,
                        "ignored a cross-agent steer-applied event from a forked child"
                    );
                }
            }
            if matches!(&event, EngineEvent::AssistantMessageStarted)
                && advance_turn_on_next_message
            {
                current_turn = current_turn.saturating_add(1);
                advance_turn_on_next_message = false;
            }
            let progress_message = match &event {
                EngineEvent::AssistantMessageStarted => {
                    Some("Receiving model response".to_string())
                }
                EngineEvent::AssistantThinkingDelta(_) => Some("Thinking".to_string()),
                EngineEvent::AssistantTextDelta(_) => Some("Writing response".to_string()),
                EngineEvent::ToolInputProgress { name, .. } => Some(format!("Preparing {name}")),
                EngineEvent::ToolUseStarted { name, .. } => Some(format!("Running {name}")),
                EngineEvent::ToolResult { name, .. } => Some(format!("Finished {name}")),
                EngineEvent::ToolDenied { name, .. } => Some(format!("Denied {name}")),
                EngineEvent::AssistantMessageDone => Some("Planning next step".to_string()),
                _ => None,
            };
            if let Some(message) = progress_message {
                let turn = current_turn;
                if last_progress.as_ref() != Some(&(turn, message.clone())) {
                    parent.report_background_job_progress(
                        &agent_id,
                        &message,
                        Some(turn),
                        Some(max_turns),
                    );
                    last_progress = Some((turn, message));
                }
            }
            if let EngineEvent::AssistantTextDelta(delta) = &event {
                latest_model_text.push_str(delta);
                const MAX_LATEST_MODEL_CHARS: usize = 2_000;
                let char_count = latest_model_text.chars().count();
                if char_count > MAX_LATEST_MODEL_CHARS {
                    latest_model_text = latest_model_text
                        .chars()
                        .skip(char_count - MAX_LATEST_MODEL_CHARS)
                        .collect();
                }
                let now = std::time::Instant::now();
                if subagent_model_detail_due(last_model_detail_emit, now) {
                    parent.report_background_job_progress_detail(
                        &agent_id,
                        "Writing response",
                        &latest_model_text,
                        Some(current_turn),
                        Some(max_turns),
                    );
                    last_model_detail_emit = now;
                }
            }
            if matches!(&event, EngineEvent::AssistantMessageDone) {
                if !latest_model_text.is_empty() {
                    parent.report_background_job_progress_detail(
                        &agent_id,
                        "Writing response",
                        &latest_model_text,
                        Some(current_turn),
                        Some(max_turns),
                    );
                    last_model_detail_emit = std::time::Instant::now();
                }
                // AssistantMessageDone closes one provider response but precedes
                // that response's tool execution. Advance only when the next
                // assistant message actually starts, after any tools complete.
                advance_turn_on_next_message = true;
            }
            if matches!(
                &event,
                EngineEvent::AssistantMessageStarted | EngineEvent::AssistantMessageDone
            ) {
                let checkpoint_messages = forked_engine.state.messages();
                // AssistantMessageDone precedes tool execution, while the next
                // AssistantMessageStarted follows the completed ToolResults from
                // the preceding response. Persist both protocol-complete
                // boundaries so a later hard-abort fallback retains every fully
                // completed tool cycle instead of falling back to the initial user
                // message.
                if unmatched_tool_use_ids(&checkpoint_messages).is_empty() {
                    forked_engine
                        .write_context_checkpoint(&transcript_path, &checkpoint_messages, true)
                        .await?;
                }
                if matches!(&event, EngineEvent::AssistantMessageDone) {
                    checkpoint_agent_usage(parent, &agent_id, &checkpoint_messages);
                }
            }
            match event {
                EngineEvent::AssistantTextDelta(text) => streamed_output_text.push_str(&text),
                EngineEvent::ToolResult { id, name, output } => {
                    // Authenticated IDs and trusted results share one source: both are captured by
                    // the engine before transcript persistence and cross-checked against
                    // VerifierVote verified_tool_use_ids.
                    if verifier_terminal_verdict
                        && let Some(channel) = verifier_vote_channel.as_ref()
                    {
                        channel.record_authenticated_tool_use(&id);
                    }
                    if !trusted_tool_results.contains_key(&id)
                        && trusted_tool_results.len() < MAX_VERIFIER_TRUSTED_TOOL_RESULTS
                        && let Some((output, bytes)) = bounded_verifier_tool_result(&name, output)
                        && trusted_tool_result_bytes.saturating_add(bytes)
                            <= MAX_VERIFIER_TRUSTED_TOOL_RESULTS_BYTES
                    {
                        trusted_tool_result_bytes += bytes;
                        trusted_tool_results.insert(id, output);
                    }
                }
                EngineEvent::Error(err) | EngineEvent::ProviderFailed { message: err, .. } => {
                    if pending_abort.is_some() {
                        // Cancellation can surface an additional provider/tool
                        // error while the engine is still committing interrupted
                        // ToolResults. Keep draining so the protocol is repaired.
                        continue;
                    }
                    let messages = forked_engine.state.messages();
                    if unmatched_tool_use_ids(&messages).is_empty() {
                        forked_engine
                            .write_context_checkpoint(&transcript_path, &messages, true)
                            .await?;
                    }
                    let stop_result = run_subagent_hook(
                        parent,
                        kcoder_hooks::HookEvent::SubagentStop,
                        &agent_id,
                        serde_json::json!({
                            "agent_id": agent_id.clone(),
                            "status": "failed",
                            "error": err.clone(),
                            "output_text": streamed_output_text.clone(),
                        }),
                    )
                    .await;
                    if let Err(hook_error) = stop_result {
                        return Err(anyhow::anyhow!(
                            "forked agent error: {}; additionally {}",
                            err,
                            hook_error
                        ));
                    }
                    return Err(anyhow::anyhow!("forked agent error: {}", err));
                }
                EngineEvent::MaxTurnsReached { max_turns, .. } => {
                    if pending_abort.is_some() {
                        continue;
                    }
                    if terminal_verdict {
                        let output = if verifier_terminal_verdict {
                            "FLAKY\nThe verifier reached its final decision boundary without an explicit verdict from the evidence already collected, so PASS or FAIL cannot be accepted safely."
                            .to_string()
                        } else {
                            "REVIEW_UNAVAILABLE\nThe critic reached its turn boundary without a valid ReviewVote; runtime will count this as an infrastructure retry, not a semantic reject."
                            .to_string()
                        };
                        forked_engine
                            .state
                            .add_message(Message::assistant_text(output.clone()));
                        forced_terminal_output = Some(output);
                        let messages = forked_engine.state.messages();
                        forked_engine
                            .write_context_checkpoint(&transcript_path, &messages, true)
                            .await?;
                        break;
                    }
                    let messages = forked_engine.state.messages();
                    if unmatched_tool_use_ids(&messages).is_empty() {
                        forked_engine
                            .write_context_checkpoint(&transcript_path, &messages, true)
                            .await?;
                    }
                    let stop_result = run_subagent_hook(
                        parent,
                        kcoder_hooks::HookEvent::SubagentStop,
                        &agent_id,
                        serde_json::json!({
                            "agent_id": agent_id.clone(),
                            "status": "max_turns_reached",
                            "max_turns": max_turns,
                            "output_text": streamed_output_text.clone(),
                        }),
                    )
                    .await;
                    if let Err(hook_error) = stop_result {
                        return Err(anyhow::anyhow!(
                            "forked agent reached maximum turns ({}); additionally {}",
                            max_turns,
                            hook_error
                        ));
                    }
                    return Err(anyhow::Error::new(ForkedAgentMaxTurnsReached { max_turns }));
                }
                EngineEvent::StreamAborted { reason } => {
                    let cancelled = reason == "cancelled by user"
                        || forked_engine.cancel_token().is_cancelled();
                    // Do not return here. During tool cancellation the engine emits
                    // StreamAborted before it writes the synthetic interrupted
                    // ToolResults. Dropping the stream now would persist an invalid
                    // ToolUse-without-ToolResult transcript.
                    pending_abort = Some((reason, cancelled));
                    if unmatched_tool_use_ids(&forked_engine.state.messages()).is_empty() {
                        // Provider/idle cancellation has no pending tool protocol
                        // to repair, so there is nothing useful to drain.
                        break;
                    }
                }
                _ => {}
            }
        }

        let messages = forked_engine.state.messages();
        if let Some(error) = native_event_rejection {
            forked_engine
                .write_context_checkpoint(&transcript_path, &messages, false)
                .await?;
            let native_stop = forked_engine
                .subagent_runtime_control
                .as_ref()
                .as_ref()
                .and_then(|control| {
                    control
                        .parent_state
                        .task(&control.agent_id)
                        .filter(|task| {
                            task.background_run.as_ref() == control.expected_background_run.as_ref()
                        })
                        .and_then(|task| match task.status {
                            kcoder_types::TaskStatus::Paused => Some(("paused", false)),
                            kcoder_types::TaskStatus::Halted => Some(("halted", false)),
                            kcoder_types::TaskStatus::Cancelled => Some(("cancelled", true)),
                            _ => None,
                        })
                });
            if let Some(writer) = live_view.as_mut() {
                writer.finish_native_denial(native_stop.map_or("failed", |(status, _)| status));
            }
            if let Some((status, cancelled)) = native_stop {
                return Err(anyhow::Error::new(ForkedAgentAborted {
                    reason: if cancelled {
                        "cancelled by parent".into()
                    } else {
                        format!("agent_control:{status}")
                    },
                    cancelled,
                }));
            }
            return Err(anyhow::anyhow!(
                "forked agent native event rejected: {error}"
            ));
        }
        forked_engine
            .write_context_checkpoint(&transcript_path, &messages, true)
            .await?;
        acknowledge_persisted_breaker_steer(parent, &agent_id, &messages)?;
        // A control request may arrive while the final tool-free model response streams.
        // The turn loop may not reach another provider boundary, so claim once more after
        // the final protocol-complete checkpoint; otherwise a later Completed commit could
        // overwrite pause/halt.
        if pending_abort.is_none()
            && let Some(mode) = forked_engine.prepare_subagent_safe_boundary()?
        {
            pending_abort = Some((format!("agent_control:{mode}"), false));
        }
        if let Some((reason, cancelled)) = pending_abort {
            let status = if cancelled { "cancelled" } else { "aborted" };
            let stop_result = run_subagent_hook(
                parent,
                kcoder_hooks::HookEvent::SubagentStop,
                &agent_id,
                serde_json::json!({
                    "agent_id": agent_id.clone(),
                    "status": status,
                    "reason": reason.clone(),
                    "messages": messages.len(),
                    "output_text": streamed_output_text.clone(),
                }),
            )
            .await;
            if let Err(hook_error) = stop_result {
                return Err(anyhow::Error::new(ForkedAgentAborted {
                    reason: format!("{reason}; SubagentStop hook failed: {hook_error}"),
                    cancelled,
                }));
            }
            return Err(anyhow::Error::new(ForkedAgentAborted { reason, cancelled }));
        }
        let output_text = verifier_vote_channel
            .as_ref()
            .and_then(|channel| channel.recorded_vote())
            .map(|vote| vote.input.summary.clone())
            .or_else(|| {
                review_vote_channel
                    .as_ref()
                    .and_then(|channel| channel.recorded_vote())
                    .map(|vote| vote.input.summary.clone())
            })
            .or(forced_terminal_output)
            .or_else(|| latest_assistant_response_text(&messages))
            .unwrap_or_else(|| streamed_output_text.clone());
        run_subagent_hook(
            parent,
            kcoder_hooks::HookEvent::SubagentStop,
            &agent_id,
            serde_json::json!({
                "agent_id": agent_id.clone(),
                "status": "completed",
                "messages": messages.len(),
                "output_text": output_text.clone(),
            }),
        )
        .await?;

        persist_orchestrate_agent_evidence(
            parent,
            &agent_id,
            &messages,
            &trusted_tool_results,
            &fork_cwd,
            &output_text,
        )
        .await?;

        artifact_validation::finish(parent, &forked_engine, &agent_id, artifact_run).await?;
        let managed = parent
            .state
            .task(&agent_id)
            .and_then(|task| task.background_run)
            .is_some();
        if let Some(writer) = live_view.as_mut() {
            writer.finish(managed);
        }
        Ok(ForkedAgentResult {
            agent_id,
            messages,
            output_text,
            trusted_tool_results,
        })
    };
    match admission {
        Some(admission) => admission.run(execution).await,
        None => execution.await,
    }
}
