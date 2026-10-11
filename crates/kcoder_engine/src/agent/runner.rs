//! Agent runner; state ownership is retained by the agent facade.

use super::*;

impl QueryEngineAgentRunner {
    pub fn new(mut engine: QueryEngine) -> Self {
        // This runner is captured by the real spawning ToolContext. Its work may
        // begin after the parent turn ends; keep that turn's owned host context.
        if let Some(host) = engine.effective_user_questioner().snapshot_agent_host() {
            engine.user_questioner = host;
        }
        Self { engine }
    }

    pub(super) fn transcript_path(&self, agent_id: &str) -> PathBuf {
        self.engine
            .state
            .task(agent_id)
            .and_then(|task| task.transcript_path)
            .unwrap_or_else(|| self.engine.state.subagent_transcript_path(agent_id))
    }

    pub(super) fn record_agent_runtime_identity(
        &self,
        agent_id: &str,
        runtime: Option<&ForkedAgentRuntime>,
    ) {
        let provider = runtime
            .map(|runtime| runtime.provider.name().to_string())
            .unwrap_or_else(|| self.engine.provider_name());
        let model = runtime
            .map(|runtime| runtime.settings.model.clone())
            .unwrap_or_else(|| self.engine.model_name());
        self.engine.state.update_task(agent_id, |task| {
            task.agent_provider = Some(provider.clone());
            task.agent_model = Some(model.clone());
        });
    }

    pub(super) fn build_agent_runtime(
        &self,
        selection: &kcoder_tools::AgentRuntimeSelection,
    ) -> anyhow::Result<ForkedAgentRuntime> {
        let parent_settings = crate::recover_read_lock(&self.engine.settings, "settings").clone();
        let profile = selection
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let provider_name = selection
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let model = selection
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        if profile.is_none() && provider_name.is_none() && model.is_none() {
            anyhow::bail!("verifier runtime selection is empty")
        }

        let mut settings = parent_settings.clone();
        let (provider, effective_model) = if profile
            .is_some_and(|value| value.eq_ignore_ascii_case("current"))
            || provider_name.is_some_and(|value| value.eq_ignore_ascii_case("current"))
        {
            let effective_model = model.unwrap_or_else(|| parent_settings.model.clone());
            settings.model = effective_model.clone();
            (self.engine.current_provider(), effective_model)
        } else if let Some(profile) = profile {
            settings.apply_provider(Some(profile))?;
            let effective_model = model.unwrap_or_else(|| settings.model.clone());
            settings.apply_discovered_model(profile, &effective_model)?;
            let provider = if let Some(source) = &self.engine.client_model_configuration {
                source.provider(&settings)?
            } else {
                ProviderFactory::new(&settings).build_named(profile, &effective_model)?
            };
            (provider, effective_model)
        } else if let Some(provider_name) = provider_name {
            let effective_model = model.unwrap_or_else(|| parent_settings.model.clone());
            settings = ProviderFactory::new(&parent_settings)
                .settings_for_named_isolated(provider_name, &effective_model)?;
            let provider = if let Some(source) = &self.engine.client_model_configuration {
                source.provider(&settings)?
            } else {
                ProviderFactory::new(&parent_settings)
                    .build_named_isolated(provider_name, &effective_model)?
            };
            (provider, effective_model)
        } else {
            let effective_model = model.expect("model selection checked above");
            settings.model = effective_model.clone();
            (self.engine.current_provider(), effective_model)
        };

        if let Some(profile_name) = settings.active_provider.clone()
            && settings
                .providers
                .get(&profile_name)
                .is_some_and(|profile| profile.has_model(&effective_model))
        {
            settings.apply_discovered_model(&profile_name, &effective_model)?;
        }
        settings.model = effective_model;
        Ok(ForkedAgentRuntime { provider, settings })
    }

    pub(super) fn validate_continuation_runtime_identity(
        &self,
        agent_id: &str,
    ) -> Result<(), AgentError> {
        let task = self.engine.state.task(agent_id).ok_or_else(|| {
            AgentError::Execution(format!("agent {agent_id} has no persisted task metadata"))
        })?;
        let saved_provider = task.agent_provider.as_deref().ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates provider/model transcript tracking; spawn a fresh sub-agent"
            ))
        })?;
        let saved_model = task.agent_model.as_deref().ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates provider/model transcript tracking; spawn a fresh sub-agent"
            ))
        })?;
        let live_provider = self.engine.provider_name();
        let live_model = self.engine.model_name();
        if saved_provider == live_provider && saved_model == live_model {
            return Ok(());
        }
        Err(AgentError::Execution(format!(
            "agent {agent_id} transcript belongs to provider/model `{saved_provider}/{saved_model}`, but the live parent is `{live_provider}/{live_model}`; switch back before SendMessage or spawn a fresh sub-agent"
        )))
    }

    pub(super) async fn write_transcript(
        &self,
        agent_id: &str,
        messages: &[Message],
    ) -> Result<(), AgentError> {
        let path = self.transcript_path(agent_id);
        write_transcript_checkpoint(&path, messages)
            .await
            .map_err(|e| AgentError::Execution(format!("failed to write transcript: {e}")))
    }

    pub(super) async fn read_transcript(&self, agent_id: &str) -> Result<Vec<Message>, AgentError> {
        let path = self.transcript_path(agent_id);
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            AgentError::Execution(format!(
                "failed to read transcript `{}`: {e}",
                path.display()
            ))
        })?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AgentError::Execution(format!(
                "failed to parse transcript `{}`: {e}",
                path.display()
            ))
        })
    }

    pub(super) async fn run_agent_session_with_kind_and_runtime(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        runtime: Option<ForkedAgentRuntime>,
        verifier_guard: Option<VerifierRuntimeGuard>,
    ) -> Result<String, AgentError> {
        self.run_agent_session_result_with_kind_and_runtime(
            agent_id,
            prompt,
            max_turns,
            agent_kind,
            runtime,
            verifier_guard,
        )
        .await
        .map(|result| result.output_text)
    }

    pub(super) async fn run_agent_session_result_with_kind_and_runtime(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        runtime: Option<ForkedAgentRuntime>,
        verifier_guard: Option<VerifierRuntimeGuard>,
    ) -> Result<ForkedAgentResult, AgentError> {
        // Children of the main loop share the parent's cancel token by
        // default. Without this, hitting Ctrl+C in the REPL would only
        // abort the current turn, leaving the still-running sub-agents to
        // keep producing background work.
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        self.record_agent_runtime_identity(&agent_id, runtime.as_ref());
        let base_tools = self.engine.active_subagent_tools();
        let arrangement_mode = self.engine.is_arrangement_mode_active();
        let tools = if verifier_guard.is_some() {
            verifier_session_tools(&base_tools)
        } else {
            tool_policy::filter_tools_for_agent_kind_with_bound_questions(
                &base_tools,
                agent_kind,
                true,
                arrangement_mode,
                context::bound_questions_available(&self.engine).await,
            )
        };
        let role_system_prompt = verifier_guard
            .as_ref()
            .map(|guard| guard.role_system_prompt(agent_kind.system_prompt()))
            .unwrap_or_else(|| agent_kind.system_prompt().to_string());
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages: initial_agent_messages(
                    &cache_safe,
                    prompt,
                    agent_kind.default_context_mode(arrangement_mode),
                    2,
                ),
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: SubagentContextOverrides {
                    share_abort_controller: true,
                    block_shell_file_mutation:
                        kcoder_tools::agent::agent_kind_blocks_shell_file_mutation(
                            agent_kind,
                            arrangement_mode,
                        ),
                    block_dependency_mutation: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.block_dependency_mutation),
                    verifier_minimum_test_scope: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.minimum_test_scope),
                    verifier_require_raw_exit_code: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.require_raw_exit_code),
                    verifier_require_behavior_delta: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.require_behavior_delta),
                    verifier_terminal_verdict: verifier_guard.is_some(),
                    shell_isolation_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.shell_isolation_root.clone()),
                    isolate_shell_writes: verifier_guard.is_some(),
                    shell_write_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.workspace_root.clone()),
                    verifier_baseline_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.baseline_root.clone()),
                    verifier_vote_channel: verifier_guard
                        .as_ref()
                        .map(|guard| guard.vote_channel.clone()),
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    ),
                    cwd_override: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.cwd_override.clone()),
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result)
    }
}

#[async_trait::async_trait]
impl AgentRunner for QueryEngineAgentRunner {
    fn workflow_model_configuration(
        &self,
    ) -> Result<Option<kcoder_types::ModelConfigurationSummary>, AgentError> {
        self.engine
            .active_model_configuration_summary()
            .map(Some)
            .map_err(|error| AgentError::Execution(error.to_string()))
    }
    fn workflow_tool_contract(&self, name: &str) -> Option<kcoder_types::ToolDefinition> {
        if tool_policy::all_agent_disallowed_tools().contains(name)
            || kcoder_tools::workflow::coordinates_execution(name)
            || name == "Config"
        {
            return None;
        }
        let registry = self
            .engine
            .active_tool_registry_for_mode(self.engine.is_arrangement_mode_active());
        let tool = registry.get(name)?;
        if matches!(
            tool.input_format(),
            kcoder_tools::ToolInputFormat::Freeform { .. }
        ) {
            return None;
        }
        Some(kcoder_types::ToolDefinition {
            name: tool.name(),
            description: tool.description(),
            input_schema: tool.input_schema(),
        })
    }
    fn workflow_tool_is_read_only(&self, name: &str) -> bool {
        self.engine
            .active_tool_registry_for_mode(self.engine.is_arrangement_mode_active())
            .get(name)
            .is_some_and(|tool| tool.is_read_only())
    }

    async fn run_workflow_tool(
        &self,
        id: &str,
        name: &str,
        mut input: serde_json::Value,
    ) -> Result<(ToolOutput, bool), AgentError> {
        if tool_policy::all_agent_disallowed_tools().contains(name)
            || kcoder_tools::workflow::coordinates_execution(name)
            || name == "Config"
        {
            return Ok((
                ToolOutput::error(
                    "workflow_tool: orchestration/configuration tools cannot be invoked directly by a tool node",
                ),
                false,
            ));
        }
        // Deterministic data nodes have no conversational memory to resolve
        // "unchanged since last read" or compaction placeholders against.
        if name.eq_ignore_ascii_case("read")
            && let Some(fields) = input.as_object_mut()
        {
            fields.insert("fresh".into(), serde_json::Value::Bool(true));
        }
        let (output, decision, _, _events) = self
            .engine
            .execute_tool(id, name, input, &AutoDenyPrompt)
            .await
            .map_err(|error| AgentError::Execution(error.to_string()))?;
        Ok((
            output,
            decision != kcoder_permissions::PermissionDecision::Deny,
        ))
    }

    async fn run_agent(&self, prompt: String, max_turns: usize) -> Result<String, AgentError> {
        self.run_agent_session_with_kind(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            AgentKind::General,
        )
        .await
    }

    async fn run_agent_with_kind(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent_session_with_kind(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            agent_kind,
        )
        .await
    }

    async fn run_agent_session_with_kind(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent_session_with_kind_and_runtime(
            agent_id, prompt, max_turns, agent_kind, None, None,
        )
        .await
    }

    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        selection: Option<kcoder_tools::AgentRuntimeSelection>,
        options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let runtime = selection
            .as_ref()
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build agent runtime: {error}"))
            })?;
        let isolation = options
            .isolate_environment
            .then(|| kcoder_config::create_private_temp_dir("kcoder-goal-verifier"))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to create isolated verifier environment: {error:#}"
                ))
            })?;
        let isolation_root = isolation
            .as_ref()
            .map(|directory| directory.path().to_path_buf());
        let cancel = self.engine.cancel_token();
        let source_cwd = self.engine.state.cwd();
        let mut workspace_isolation = if options.verify_workspace_unchanged {
            Some(tokio::select! {
                result = create_verifier_workspace_isolation(&source_cwd, options.workspace_baseline.as_ref()) => result?,
                _ = cancel.cancelled() => return Err(AgentError::Cancelled("verifier workspace preparation cancelled".to_string())),
            })
        } else {
            None
        };
        let verification = async {
            let workspace_before = if options.verify_workspace_unchanged {
                let candidate_root = workspace_isolation
                    .as_ref()
                    .map(|isolation| isolation.worktree_root.as_path())
                    .ok_or_else(|| {
                        AgentError::Execution(
                            "Goal Pro workspace verification is missing its isolated candidate"
                                .to_string(),
                        )
                    })?;
                Some(verifier_workspace_fingerprint(candidate_root).await?)
            } else {
                None
            };
            let baseline_before = if options.verify_workspace_unchanged {
                let baseline = workspace_isolation
                    .as_ref()
                    .map(|isolation| isolation.baseline_root.as_path())
                    .ok_or_else(|| {
                        AgentError::Execution(
                            "Goal Pro workspace verification is missing its pristine baseline"
                                .to_string(),
                        )
                    })?;
                Some(verifier_workspace_fingerprint(baseline).await?)
            } else {
                None
            };
            let agent_id = generate_agent_id(&self.engine).map_err(map_forked_agent_error)?;
            let vote_channel = kcoder_tools::VerifierVoteChannel::default();
            let forked_result = self
                .run_agent_session_result_with_kind_and_runtime(
                    agent_id.clone(),
                    prompt,
                    max_turns,
                    AgentKind::Verifier,
                    runtime,
                    Some(VerifierRuntimeGuard {
                        block_dependency_mutation: options.block_dependency_mutation,
                        minimum_test_scope: options.minimum_test_scope,
                        require_raw_exit_code: options.require_raw_exit_code,
                        require_behavior_delta: options.require_behavior_delta,
                        shell_isolation_root: isolation_root,
                        cwd_override: workspace_isolation
                            .as_ref()
                            .map(|isolation| isolation.cwd.clone()),
                        workspace_root: workspace_isolation
                            .as_ref()
                            .map(|isolation| isolation.worktree_root.clone()),
                        baseline_root: workspace_isolation
                            .as_ref()
                            .map(|isolation| isolation.baseline_root.clone()),
                        vote_channel: vote_channel.clone(),
                    }),
                )
                .await?;
            let candidate_unchanged = if let Some(before) = workspace_before.as_deref() {
                let candidate_root = workspace_isolation
                    .as_ref()
                    .map(|isolation| isolation.worktree_root.as_path())
                    .ok_or_else(|| {
                        AgentError::Execution(
                            "Goal Pro workspace verification lost its isolated candidate"
                                .to_string(),
                        )
                    })?;
                verifier_workspace_fingerprint(candidate_root).await? == before
            } else {
                false
            };
            let baseline_unchanged = if let (Some(before), Some(isolation)) =
                (baseline_before.as_deref(), workspace_isolation.as_ref())
            {
                verifier_workspace_fingerprint(&isolation.baseline_root).await? == before
            } else {
                false
            };
            let workspace_snapshot_verified =
                workspace_before.is_some() && baseline_before.is_some();
            let workspace_unchanged = candidate_unchanged && baseline_unchanged;
            let mut result = AgentRunResult::from_messages_with_trusted_tool_results(
                forked_result.output_text,
                &forked_result.messages,
                &forked_result.trusted_tool_results,
                isolation.is_some(),
                options.block_dependency_mutation,
                workspace_snapshot_verified,
                workspace_unchanged,
            );
            result.verifier_vote = validated_verifier_vote(&vote_channel, &forked_result.messages);
            result.verifier_baseline_root = workspace_isolation
                .as_ref()
                .map(|isolation| isolation.baseline_root.clone());
            if let (Some(isolation), Some(baseline_root)) = (
                workspace_isolation.as_ref(),
                result.verifier_baseline_root.as_deref(),
            ) {
                for execution in &mut result.tool_executions {
                    // Tool errors such as SandboxDenied lack a standard Bash result body, but
                    // the engine still validates the requested workdir and uses it as the actual
                    // execution boundary, so its provenance must be retained.
                    let workdir = bash_execution_workdir(execution);
                    let provenance = workdir.as_deref().and_then(|workdir| {
                        verifier_test_provenance(workdir, &isolation.worktree_root, baseline_root)
                    });
                    execution.test_origin = provenance.as_ref().map(|(origin, _)| *origin);
                    execution.verifier_relative_workdir =
                        provenance.map(|(_, relative_workdir)| relative_workdir);
                }
            }
            result.candidate_fingerprint = workspace_before;
            result.candidate_changed_paths = workspace_isolation
                .as_ref()
                .map(|isolation| isolation.changed_paths.clone())
                .unwrap_or_default();
            Ok(result)
        };
        let result = tokio::select! {
            result = verification => result,
            _ = cancel.cancelled() => Err(AgentError::Cancelled("verifier operation cancelled".to_string())),
        };
        if let Some(isolation) = workspace_isolation.as_mut() {
            isolation.cleanup().await?;
        }
        result
    }

    async fn run_agent_with_kind_and_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        selection: Option<kcoder_tools::AgentRuntimeSelection>,
    ) -> Result<String, AgentError> {
        let runtime = selection
            .as_ref()
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build agent runtime: {error}"))
            })?;
        self.run_agent_session_with_kind_and_runtime(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            agent_kind,
            runtime,
            None,
        )
        .await
    }

    async fn run_agent_session_with_options(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        mut options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        kcoder_state::validate_artifact_requirements(&options.artifact_requirements)
            .map_err(AgentError::Execution)?;
        if let Some(task) = self.engine.state.task(&agent_id) {
            options.restore_artifact_requirements(&task)?;
        }
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        // The spawning tool latches the child's capability profile into the
        // options. Do not OR it with mutable parent UI state: doing so can
        // silently upgrade a normal child when Arrangement is entered later.
        let arrangement_mode = options.arrangement_mode;
        let runtime = options
            .runtime_selection
            .as_ref()
            .filter(|selection| {
                selection.profile.is_some()
                    || selection.provider.is_some()
                    || selection.model.is_some()
            })
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build persona runtime: {error:#}"))
            })?;
        let base_tools = self.engine.active_subagent_tools_for_mode(arrangement_mode);
        let mut tools = tool_policy::filter_tools_for_agent_kind_with_bound_questions(
            &base_tools,
            agent_kind,
            true,
            arrangement_mode,
            context::bound_questions_available(&self.engine).await,
        );
        if let Some(allowlist) = options.tool_allowlist.as_ref() {
            tools = filter_tools_by_owned_names(
                &tools,
                &allowlist.iter().cloned().collect::<HashSet<_>>(),
            );
        }
        if options.review_vote_channel.is_some() {
            tools = tools.register(kcoder_tools::ReviewVoteTool);
        }
        let context_mode = match options.context_mode {
            SubagentContextMode::Auto => agent_kind.default_context_mode(arrangement_mode),
            mode => mode,
        };
        validate_full_context_compatibility(&self.engine, &cache_safe, context_mode)?;
        if self.engine.state.task(&agent_id).is_none() && !options.artifact_requirements.is_empty()
        {
            let mut task = kcoder_state::Task::new(&agent_id, &prompt);
            task.kind = kcoder_state::TaskKind::Subagent;
            task.allowed_write_paths = options.allowed_write_paths.clone();
            task.worktree_path = options.worktree_path.clone();
            self.engine.state.upsert_task(task);
        }
        if !options.artifact_requirements.is_empty() {
            self.engine
                .state
                .bind_subagent_artifact_requirements(&agent_id, &options.artifact_requirements)
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to bind artifact declarations: {error:#}"
                    ))
                })?;
        }
        let role_system_prompt =
            if self.engine.state.session_mode() == kcoder_state::SessionMode::Orchestrate {
                orchestrate_role_prompt(agent_kind, options.persona_name.as_deref())
            } else {
                agent_kind.system_prompt().to_string()
            };
        self.record_agent_runtime_identity(&agent_id, runtime.as_ref());
        if let Some(persona) = options.persona_name.as_deref() {
            let runtime_provider = runtime
                .as_ref()
                .map(|runtime| runtime.provider.name().to_string())
                .unwrap_or_else(|| self.engine.provider_name());
            let runtime_model = runtime
                .as_ref()
                .map(|runtime| runtime.settings.model.clone())
                .unwrap_or_else(|| self.engine.model_name());
            let work_id = options.orchestrate_work_id.clone();
            let parent_session_id = self.engine.state.session_id();
            let fingerprint = resolved_profile_fingerprint(ProfileFingerprintInput {
                persona,
                agent_kind,
                role_prompt: &role_system_prompt,
                tools: &tools,
                runtime_provider: &runtime_provider,
                runtime_model: &runtime_model,
                runtime_selection: options.runtime_selection.as_ref(),
                context_mode,
                context_turns: options.context_turns,
                work_id: work_id.as_deref(),
                parent_session_id: &parent_session_id,
            });
            self.engine.state.update_task(&agent_id, |task| {
                task.resolved_profile_fingerprint = Some(fingerprint.clone());
            });
            if let Some(work_id) = work_id.as_deref() {
                let store =
                    kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.engine.cwd);
                let snapshot = store.read_work(work_id).map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to bind persona session to Orchestrate work: {error:#}"
                    ))
                })?;
                store
                    .append_task_session(
                        work_id,
                        kcoder_state::orchestrate_store::TaskSessionRecord {
                            agent_id: agent_id.clone(),
                            parent_session_id: self.engine.state.session_id(),
                            plan_revision: snapshot.work.revision,
                            status: "spawned".to_string(),
                            profile_fingerprint: fingerprint,
                            recorded_at: chrono::Utc::now(),
                        },
                    )
                    .map_err(|error| {
                        AgentError::Execution(format!(
                            "failed to persist persona session audit: {error:#}"
                        ))
                    })?;
            }
        }
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages: initial_agent_messages(
                    &cache_safe,
                    prompt,
                    context_mode,
                    options.context_turns,
                ),
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: SubagentContextOverrides {
                    configuration_observer: options.configuration_observer,
                    share_abort_controller: options.abort_token.is_none(),
                    abort_token: options.abort_token,
                    allowed_write_paths: options.allowed_write_paths,
                    scoped_allowed_shell_prefixes: options.allowed_shell_prefixes.clone(),
                    block_shell_file_mutation: options.block_shell_file_mutation,
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    )
                    .into_iter()
                    .chain(options.allowed_shell_prefixes)
                    .collect(),
                    cwd_override: options.worktree_path,
                    review_vote_channel: options.review_vote_channel,
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result.output_text)
    }

    async fn send_message_to_agent_with_kind(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        let task = self.engine.state.task(&agent_id).ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} has no persisted capability profile"
            ))
        })?;
        let arrangement_mode = task.arrangement_mode.ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates capability-profile tracking; spawn a fresh sub-agent"
            ))
        })?;
        let options = AgentRunOptions::with_allowed_write_paths(task.allowed_write_paths)
            .with_allowed_shell_prefixes(task.allowed_shell_prefixes)
            .with_artifact_requirements(task.artifact_requirements)
            .with_block_shell_file_mutation(
                kcoder_tools::agent::agent_kind_blocks_shell_file_mutation(
                    agent_kind,
                    arrangement_mode,
                ),
            )
            .with_arrangement_mode(arrangement_mode);
        self.send_message_to_agent_with_options(agent_id, message, max_turns, agent_kind, options)
            .await
    }

    async fn send_message_to_agent_with_options(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
        mut options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        let task = self.engine.state.task(&agent_id).ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} has no persisted task declarations"
            ))
        })?;
        options.restore_artifact_requirements(&task)?;
        if options.persona_name.is_none() {
            self.validate_continuation_runtime_identity(&agent_id)?;
        }
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        let (mut messages, repaired_transcript) =
            crate::repair_tool_message_sequence(self.read_transcript(&agent_id).await?);
        if repaired_transcript {
            warn!(
                agent_id = %agent_id,
                "repaired persisted sub-agent transcript before SendMessage continuation"
            );
        }
        let mut appended_delivery_message = true;
        let mut artifact_replay_output = None;
        if let Some(delivery) = options.delivery.as_ref() {
            let task = self.engine.state.task(&agent_id).ok_or_else(|| {
                AgentError::Execution(format!("agent {agent_id} task state disappeared"))
            })?;
            let queued = task
                .message_queue
                .iter()
                .find(|queued| queued.message_id == delivery.message_id)
                .ok_or_else(|| {
                    AgentError::Execution(format!(
                        "delivery {} disappeared from agent {agent_id}",
                        delivery.message_id
                    ))
                })?;
            let body_sha256 = format!("{:x}", Sha256::digest(message.as_bytes()));
            let anchor = if let Some(anchor) = queued.transcript_anchor.clone() {
                if anchor.body_sha256 != body_sha256 {
                    return Err(AgentError::Execution(format!(
                        "delivery {} body changed after it was leased",
                        delivery.message_id
                    )));
                }
                anchor
            } else {
                let anchor = kcoder_state::TranscriptDeliveryAnchor {
                    baseline_message_count: messages.len(),
                    baseline_sha256: transcript_messages_sha256(&messages)?,
                    body_sha256,
                };
                let prepared = self
                    .engine
                    .state
                    .prepare_subagent_delivery(
                        &agent_id,
                        &delivery.message_id,
                        &delivery.lease_id,
                        anchor.clone(),
                    )
                    .map_err(|error| AgentError::Execution(error.to_string()))?;
                if !prepared {
                    return Err(AgentError::Execution(format!(
                        "delivery {} disappeared before transcript preparation",
                        delivery.message_id
                    )));
                }
                anchor
            };
            if messages.len() < anchor.baseline_message_count {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript is shorter than its persisted baseline",
                    delivery.message_id
                )));
            }
            let baseline = &messages[..anchor.baseline_message_count];
            if transcript_messages_sha256(baseline)? != anchor.baseline_sha256 {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript baseline changed; refusing duplicate insertion",
                    delivery.message_id
                )));
            }
            if messages.len() == anchor.baseline_message_count {
                messages.push(Message::user_text(message.clone()));
            } else if !is_exact_delivery_message(&messages[anchor.baseline_message_count], &message)
            {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript anchor points to a different message",
                    delivery.message_id
                )));
            } else {
                appended_delivery_message = false;
                if let Some(output) =
                    completed_delivery_output(&messages, anchor.baseline_message_count)
                {
                    if task.artifact_requirements.is_empty() {
                        return Ok(output);
                    }
                    artifact_replay_output = Some(output);
                }
            }
        } else {
            messages.push(Message::user_text(message));
        }
        // Continuation reuses the capability profile persisted at spawn time;
        // the parent's current UI/loop mode must not upgrade this child.
        let arrangement_mode = options.arrangement_mode;
        let runtime = options
            .runtime_selection
            .as_ref()
            .filter(|selection| {
                selection.profile.is_some()
                    || selection.provider.is_some()
                    || selection.model.is_some()
            })
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to rebuild persona runtime: {error:#}"))
            })?;
        let base_tools = self.engine.active_subagent_tools_for_mode(arrangement_mode);
        let mut tools = tool_policy::filter_tools_for_agent_kind_with_bound_questions(
            &base_tools,
            agent_kind,
            true,
            arrangement_mode,
            context::bound_questions_available(&self.engine).await,
        );
        if let Some(allowlist) = options.tool_allowlist.as_ref() {
            tools = filter_tools_by_owned_names(
                &tools,
                &allowlist.iter().cloned().collect::<HashSet<_>>(),
            );
        }
        if let Some(allowlist) = task
            .plugin_prompt_policy
            .as_ref()
            .and_then(|p| p.allowed_tools.as_ref())
        {
            tools = filter_tools_by_owned_names(
                &tools,
                &allowlist.iter().cloned().collect::<HashSet<_>>(),
            );
        }
        let role_system_prompt =
            if self.engine.state.session_mode() == kcoder_state::SessionMode::Orchestrate {
                orchestrate_role_prompt(agent_kind, options.persona_name.as_deref())
            } else {
                agent_kind.system_prompt().to_string()
            };
        if let Some(persona) = options.persona_name.as_deref() {
            let task = self.engine.state.task(&agent_id).ok_or_else(|| {
                AgentError::Execution(format!("agent {agent_id} task state disappeared"))
            })?;
            let provider = runtime
                .as_ref()
                .map(|runtime| runtime.provider.name().to_string())
                .unwrap_or_else(|| self.engine.provider_name());
            let model = runtime
                .as_ref()
                .map(|runtime| runtime.settings.model.clone())
                .unwrap_or_else(|| self.engine.model_name());
            if task.agent_provider.as_deref() != Some(provider.as_str())
                || task.agent_model.as_deref() != Some(model.as_str())
            {
                return Err(AgentError::Execution(
                    "the resolved persona runtime changed; spawn a fresh sub-agent".to_string(),
                ));
            }
            let parent_session_id = self.engine.state.session_id();
            let fingerprint = resolved_profile_fingerprint(ProfileFingerprintInput {
                persona,
                agent_kind,
                role_prompt: &role_system_prompt,
                tools: &tools,
                runtime_provider: &provider,
                runtime_model: &model,
                runtime_selection: options.runtime_selection.as_ref(),
                context_mode: options.context_mode,
                context_turns: options.context_turns,
                work_id: task.orchestrate_work_id.as_deref(),
                parent_session_id: &parent_session_id,
            });
            if task.resolved_profile_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                return Err(AgentError::Execution(
                    "the Orchestrate persona prompt/tools/runtime/context/work fingerprint changed; spawn a fresh sub-agent"
                        .to_string(),
                ));
            }
        }
        let allowed_write_paths = if options.has_write_scope() {
            options.allowed_write_paths
        } else {
            self.engine
                .state
                .task(&agent_id)
                .map(|task| task.allowed_write_paths)
                .unwrap_or_default()
        };
        let allowed_shell_prefixes = if !options.allowed_shell_prefixes.is_empty() {
            options.allowed_shell_prefixes
        } else {
            self.engine
                .state
                .task(&agent_id)
                .map(|task| task.allowed_shell_prefixes)
                .unwrap_or_default()
        };
        // Continuations re-enter the same isolation worktree the agent was
        // spawned in, so follow-up edits do not leak into the parent workspace.
        let cwd_override = self
            .engine
            .state
            .task(&agent_id)
            .and_then(|task| task.worktree_path);
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages,
                prompt_message_count: usize::from(appended_delivery_message),
                initial_delivery: options.delivery.clone(),
                overrides: SubagentContextOverrides {
                    artifact_replay_output,
                    share_abort_controller: true,
                    allowed_write_paths,
                    scoped_allowed_shell_prefixes: allowed_shell_prefixes.clone(),
                    block_shell_file_mutation: options.block_shell_file_mutation,
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    )
                    .into_iter()
                    .chain(allowed_shell_prefixes)
                    .collect(),
                    cwd_override,
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result.output_text)
    }
}
