//! Tool context runtime within the shared engine ownership boundary.

use super::*;

#[async_trait::async_trait]
impl UserQuestioner for YoloUserQuestioner {
    fn supports_async_user_questions(&self) -> bool {
        self.async_questioner
            .as_ref()
            .is_some_and(|questioner| questioner.supports_async_user_questions())
    }

    async fn register_async_user_question(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        request: kcoder_types::async_user_questions::AsyncQuestionRequest,
    ) -> Result<kcoder_types::async_user_questions::AsyncQuestionAccepted, String> {
        let Some(questioner) = self
            .async_questioner
            .as_ref()
            .filter(|questioner| questioner.supports_async_user_questions())
        else {
            return Err("asynchronous user questions are not available in this environment".into());
        };
        questioner
            .register_async_user_question(state, owner, request)
            .await
    }

    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        if !self.allow_internal_auto_answers {
            return Err("interactive questions are not available in this environment".into());
        }
        let mut answers = HashMap::new();
        for question in &request.questions {
            let Some(option) = question.options.first() else {
                return Err(format!(
                    "yolo mode could not auto-answer question without options: {}",
                    question.question
                ));
            };
            answers.insert(question.question.clone(), option.label.clone());
        }
        Ok(UserQuestionResponse {
            questions: request.questions,
            answers,
            annotations: request.annotations,
        })
    }
}

impl QueryEngine {
    /// Set the interactive user question backend.
    pub fn set_user_questioner(&mut self, questioner: Arc<dyn UserQuestioner>) {
        self.user_questioner = questioner;
        let tools = self.tools.clone();
        *self = self.clone().with_turn_tools(tools);
    }

    pub(super) fn base_tool_context(
        &self,
        max_out: usize,
        head_out: usize,
        tail_out: usize,
        max_subagents: Option<usize>,
    ) -> ToolContext {
        self.base_tool_context_with_arrangement_mode(
            max_out,
            head_out,
            tail_out,
            max_subagents,
            self.is_arrangement_mode_active(),
        )
    }

    pub(super) fn base_tool_context_with_arrangement_mode(
        &self,
        max_out: usize,
        head_out: usize,
        tail_out: usize,
        max_subagents: Option<usize>,
        arrangement_mode: bool,
    ) -> ToolContext {
        let (
            mut external_skill_dirs,
            trust_external_skills,
            skill_guard_policy,
            auto_lessons_learned,
            tool_limits,
            default_subagent_max_turns,
        ) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.skills.external_dirs.clone(),
                settings.skills.trust_external,
                SkillGuardPolicy {
                    enabled: settings.skills.guard.enabled,
                    block_high_risk: settings.skills.guard.block_high_risk,
                    block_medium_risk_for_community: settings
                        .skills
                        .guard
                        .block_medium_risk_for_community,
                },
                settings.skills.auto_lessons_learned,
                settings.tool_limits.clone(),
                settings.default_subagent_max_turns,
            )
        };
        external_skill_dirs.extend(self.plugin_snapshot.skill_roots.iter().cloned());
        if let Some(resources) = &self.agent_skill_resources {
            external_skill_dirs.push(resources.root.clone());
        }
        external_skill_dirs.sort();
        external_skill_dirs.dedup();
        let context = self
            .desktop_binding
            .apply(ToolContext::new(self.state.clone()))
            .with_native_web_source_identity(self.native_web_source_identity.clone())
            .with_owned_command_program(self.owned_command_program.clone())
            .with_inline_widgets_authorized(self.inline_widgets_enabled())
            .with_tool_search_backend(self.tool_search_backend())
            .with_bundled_search_backend(self.bundled_search_backend.clone())
            .with_web_search_runtime(self.web_search_runtime.clone())
            .with_web_session_resources(self.web_session_resources.clone())
            .with_native_wiki_read_access(
                self.native_wiki_read_factory
                    .as_ref()
                    .map(|factory| factory.bind(self)),
            )
            .with_session_inspection(Arc::clone(&self.session_inspection_store), {
                let engine = self.clone();
                Arc::new(move || engine.session_inspection_observation())
            })
            .with_runtime_settings(Arc::clone(&self.settings))
            .with_web_settings_reader(self.bound_web_settings_reader())
            .with_file_edit_surface(self.file_edit_surface)
            .with_settings_persistence_path(self.settings_persistence_path())
            .with_settings_persistence_order(Arc::clone(&self.settings_persistence_order))
            .with_runtime_settings_observer({
                let permissions = Arc::clone(&self.permissions);
                let state = self.state.clone();
                Arc::new(move |settings: &Settings| {
                    recover_write_lock(&permissions, "permissions")
                        .refresh_persisted_settings(settings);
                    state.configure_orchestrate_runtime_audit(
                        settings.orchestrate.audit.enabled,
                        settings.orchestrate.audit.max_events,
                        settings.orchestrate.audit.max_event_bytes,
                    );
                })
            })
            .with_memory_manager(Arc::clone(&self.memory_manager))
            .with_memory_store(Arc::clone(&self.memory_store))
            .with_skill_registry(Arc::clone(&self.skill_registry))
            .with_skill_registry_generation(Arc::clone(&self.skill_registry_generation))
            .with_active_skills(Arc::clone(&self.active_skills))
            .with_blocked_skill_names(self.blocked_skill_names_for_request())
            .with_external_skill_dirs(external_skill_dirs)
            .with_trust_external_skills(trust_external_skills)
            .with_selected_expert_skill_loads(
                self.agent_skill_resources
                    .as_ref()
                    .map(|resources| resources.approved_loads.clone())
                    .unwrap_or_default(),
            )
            .with_skill_guard_policy(skill_guard_policy)
            .with_auto_lessons_learned(auto_lessons_learned)
            .with_project_skill_telemetry(
                self.workspace_persistence_mode
                    .allows_implicit_project_writes(),
            )
            .with_abort_token(self.cancel_token.clone())
            .with_shorten_signal(Arc::clone(&self.shorten_signal))
            .with_agent_runner(Arc::new(crate::agent::QueryEngineAgentRunner::new(
                self.clone(),
            )))
            .with_agent_runtime_identity(self.provider_name(), self.model_name())
            .with_background_job_manager(
                self.background_jobs.clone() as Arc<dyn BackgroundJobSpawner>
            )
            .with_user_questioner(self.effective_user_questioner())
            .with_lifecycle_hooks(Arc::new(EngineLifecycleHookEmitter::new(self.clone())))
            .with_output_limits(max_out, head_out, tail_out)
            .with_max_concurrent_subagents(max_subagents)
            .with_default_subagent_max_turns(default_subagent_max_turns)
            .with_agent_depth(self.agent_depth())
            .with_optional_skill_mutation_actor(self.skill_mutation_actor.as_ref().clone())
            .with_allowed_write_paths(
                recover_read_lock(&self.allowed_write_paths, "allowed_write_paths").clone(),
            )
            .with_allowed_shell_prefixes(
                recover_read_lock(&self.allowed_shell_prefixes, "allowed_shell_prefixes").clone(),
            )
            .with_block_shell_file_mutation(self.block_shell_file_mutation.load(Ordering::SeqCst))
            .with_block_dependency_mutation(self.block_dependency_mutation.load(Ordering::SeqCst))
            .with_shell_isolation_root(
                recover_read_lock(&self.shell_isolation_root, "shell_isolation_root").clone(),
            )
            .with_verifier_test_policy(
                *recover_read_lock(
                    &self.verifier_minimum_test_scope,
                    "verifier_minimum_test_scope",
                ),
                self.verifier_require_raw_exit_code.load(Ordering::SeqCst),
            )
            .with_verifier_behavior_delta(
                self.verifier_require_behavior_delta.load(Ordering::SeqCst),
            )
            .with_verifier_baseline_root(
                recover_read_lock(&self.verifier_baseline_root, "verifier_baseline_root").clone(),
            )
            .with_verifier_vote_channel(
                recover_read_lock(&self.verifier_vote_channel, "verifier_vote_channel").clone(),
            )
            .with_review_vote_channel(
                recover_read_lock(&self.review_vote_channel, "review_vote_channel").clone(),
            )
            .with_arrangement_mode(arrangement_mode)
            .with_tool_limits(tool_limits)
            .with_shell_environment_snapshot(self.shell_environment_snapshot.clone())
            .with_cron_scheduler(self.cron_scheduler.clone());
        #[cfg(feature = "web-network-test-fixture")]
        let context = context.with_web_network_test_dns(self.web_network_test_dns.clone());
        context
    }

    pub(super) fn active_tool_registry_for_mode(&self, arrangement_mode: bool) -> ToolRegistry {
        let base = if arrangement_mode
            || self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft
        {
            self.tools.clone()
        } else {
            self.wiki_tools_for_current_profile()
        };
        let registry = if self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft {
            let registry = base.filtered_to_names(&["WorkflowDraft".to_string()]);
            if self.is_luna_mode_active() {
                registry.filtered_to_names(
                    &recover_read_lock(&self.settings, "settings")
                        .tools
                        .luna
                        .allowed,
                )
            } else {
                registry
            }
        } else if arrangement_mode {
            if self.state.session_mode().is_orchestrate() {
                let registry = kcoder_tools::orchestrate_orchestrator_registry();
                let optional_allowlist = recover_read_lock(&self.settings, "settings")
                    .orchestrate
                    .main
                    .optional_tool_allowlist
                    .clone();
                if let Some(optional_allowlist) = optional_allowlist {
                    let allowed = kcoder_config::orchestrate_main_core_tools()
                        .iter()
                        .map(|name| (*name).to_string())
                        .chain(optional_allowlist)
                        .collect::<Vec<_>>();
                    registry.filtered_to_names(&allowed)
                } else {
                    registry
                }
            } else {
                kcoder_tools::arrangement_orchestrator_registry()
            }
        } else if self.agent_uses_own_tool_selection
            || (self.office_tool_policy_active() && self.studio_selected_tools().is_some())
        {
            base
        } else if self.is_luna_mode_active() || self.office_tool_policy_active() {
            let mut allowed = recover_read_lock(&self.settings, "settings")
                .tools
                .luna
                .allowed
                .clone();
            if self.office_tool_policy_active() {
                allowed.extend(
                    crate::studio_presentation::KWORKER_BUILTIN_SHELL_TOOLS
                        .iter()
                        .chain(crate::studio_presentation::KWORKER_WORKFLOW_TOOLS.iter())
                        .chain(crate::studio_presentation::KWORKER_AGENT_TOOLS.iter())
                        .filter(|name| base.get(name).is_some())
                        .map(|name| (*name).to_string()),
                );
            }
            if self.inline_widgets_enabled() && base.get("show_widget").is_some() {
                allowed.push("show_widget".into());
            }
            crate::studio_presentation::shrink_to_luna_allowlist(base, &allowed)
        } else {
            base
        };
        let registry = self.with_discovered_tools(registry);
        // Defense in depth: an inherited or manually composed registry cannot bypass
        // the current foreground client's presentation declaration.
        let registry = if !self.inline_widgets_enabled() && registry.get("show_widget").is_some() {
            registry.filtered_out_by_patterns(&["show_widget".to_owned()])
        } else {
            registry
        };
        let registry = if !self.client_questions_supported
            && [
                "AskUserQuestion",
                "ask_user_question",
                "EnterPlanMode",
                "ExitPlanMode",
            ]
            .iter()
            .any(|name| registry.get(name).is_some())
        {
            let allowed = registry
                .names()
                .into_iter()
                .filter(|name| !is_user_elicitation_tool_name(name))
                .collect::<Vec<_>>();
            registry.filtered_to_names(&allowed)
        } else {
            registry
        };
        let registry = if self.async_user_questions_available() {
            registry
        } else {
            registry.filtered_out_by_patterns(&["AskUserQuestionAsync".to_owned()])
        };
        let registry =
            self.restrict_to_native_tool_ceiling(self.filter_task_tool_selection(registry));
        let Some(control) = self.subagent_runtime_control.as_ref() else {
            return registry;
        };
        let Some(task) = control.parent_state.task(&control.agent_id) else {
            // Direct forks, MoA, verifier tests, and internal calls do not always create a
            // background task first. Missing control-plane state means no additional
            // restriction; it must not be interpreted as revoking every tool.
            return registry;
        };
        let registry = if task.control.tool_gate.is_empty() {
            registry
        } else {
            registry.filtered_to_names(&task.control.tool_gate)
        };
        if task.breaker.tool_gate.is_empty() {
            registry
        } else {
            registry.filtered_to_names(&task.breaker.tool_gate)
        }
    }

    fn wiki_tools_for_current_profile(&self) -> ToolRegistry {
        // Host tool composition remains the outer permission boundary. Never add
        // capabilities to empty or restricted child registries merely from config.
        let eligible = self.tools.get("Wiki").is_some()
            || self.tools.get("WikiManage").is_some()
            || (self.subagent_runtime_control.is_none() && self.tools.get("Config").is_some());
        if !eligible {
            return self.tools.clone();
        }
        let settings = match self.settings_persistence_path() {
            Some(path) => kcoder_config::read_settings_file(&path)
                .ok()
                .and_then(|document| {
                    serde_json::from_value::<kcoder_config::KnowledgeSettings>(
                        document
                            .get("knowledge")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({})),
                    )
                    .ok()
                }),
            // A child has no settings write target. Its inherited opaque host
            // reader can report only the original profile's current availability.
            None => self
                .native_wiki_read_factory
                .as_ref()
                .and_then(|factory| factory.current_knowledge_settings()),
        }
        .unwrap_or_default();
        let mut registry = self.tools.clone();
        if !settings.can_retrieve() {
            registry = registry.filtered_out_by_patterns(&["Wiki".into()]);
        } else if registry.get("Wiki").is_none()
            && self.subagent_runtime_control.is_none()
            && self.tools.get("Config").is_some()
        {
            registry = registry.register(kcoder_tools::wiki::WikiTool);
        }
        if !settings.can_organize() {
            registry = registry.filtered_out_by_patterns(&["WikiManage".into()]);
        } else if self.subagent_runtime_control.is_none()
            && self.tools.get("Config").is_some()
            && registry.get("WikiManage").is_none()
        {
            registry = registry.register(kcoder_tools::wiki_manage::WikiManageTool);
        }
        registry
    }

    pub fn active_tool_registry(&self) -> ToolRegistry {
        self.active_tool_registry_for_mode(self.is_arrangement_mode_active())
    }
}
