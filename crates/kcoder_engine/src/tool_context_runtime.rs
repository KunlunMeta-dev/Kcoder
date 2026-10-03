//! Tool context runtime within the shared engine ownership boundary.

use super::*;

#[async_trait::async_trait]
impl UserQuestioner for YoloUserQuestioner {
    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
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
        external_skill_dirs.sort();
        external_skill_dirs.dedup();
        self.desktop_binding
            .apply(ToolContext::new(self.state.clone()))
            .with_session_inspection(Arc::clone(&self.session_inspection_store), {
                let engine = self.clone();
                Arc::new(move || engine.session_inspection_observation())
            })
            .with_runtime_settings(Arc::clone(&self.settings))
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
            .with_blocked_skill_names(if self.is_luna_mode_active() {
                vec![SPEC_WORKFLOW_SKILL_NAME.to_string()]
            } else {
                Vec::new()
            })
            .with_external_skill_dirs(external_skill_dirs)
            .with_trust_external_skills(trust_external_skills)
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
            .with_cron_scheduler(self.cron_scheduler.clone())
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
        } else if self.is_luna_mode_active() {
            let allowed = recover_read_lock(&self.settings, "settings")
                .tools
                .luna
                .allowed
                .clone();
            base.filtered_to_names(&allowed)
        } else {
            base
        };
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
        let settings = self
            .settings_persistence_path()
            .and_then(|path| kcoder_config::read_settings_file(&path).ok())
            .and_then(|document| {
                serde_json::from_value::<kcoder_config::KnowledgeSettings>(
                    document
                        .get("knowledge")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({})),
                )
                .ok()
            })
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
