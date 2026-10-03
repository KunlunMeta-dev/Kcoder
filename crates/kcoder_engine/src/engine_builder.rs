//! Engine builder within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
    ) -> Self {
        Self::new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            None,
            None,
            WorkspacePersistenceMode::Interactive,
            None,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_plugin_snapshot(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        plugin_snapshot: kcoder_plugins::EffectivePluginSnapshot,
    ) -> Self {
        Self::new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            None,
            Some(plugin_snapshot),
            WorkspacePersistenceMode::Interactive,
            None,
            true,
        )
    }

    /// Construct a client-hosted engine without materializing bundled/user skill telemetry in the
    /// remote workspace. Project-owned skills still load and function; the app-server transport
    /// simply avoids mutating a workspace merely because a client connected to it.
    #[allow(clippy::too_many_arguments)]
    pub fn new_for_client(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
    ) -> Self {
        Self::try_new_for_client(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
        )
        .expect("failed to construct client engine with private artifact storage")
    }

    /// Fallible client constructor used by real client hosts so a secure
    /// fallback directory failure is propagated instead of silently using an
    /// unprotected or predictable path.
    #[allow(clippy::too_many_arguments)]
    pub fn try_new_for_client(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
    ) -> anyhow::Result<Self> {
        Self::try_new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            None,
            None,
            WorkspacePersistenceMode::Client,
            None,
            None,
            true,
        )
    }

    /// Construct independent client engines using workspace-singleton services.
    ///
    /// The caller must still provide independent `AppState`, `Settings`, and
    /// `PermissionEngine` instances for each engine. Only the cron runner and
    /// startup shell snapshot are shared here.
    #[allow(clippy::too_many_arguments)]
    pub fn try_new_for_client_with_services(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        folder_trusted_override: Option<bool>,
        workspace_services: WorkspaceRuntimeServices,
    ) -> anyhow::Result<Self> {
        Self::try_new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            folder_trusted_override,
            None,
            WorkspacePersistenceMode::Client,
            None,
            Some(workspace_services),
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn try_new_for_client_with_services_and_plugin_snapshot(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        folder_trusted_override: Option<bool>,
        workspace_services: WorkspaceRuntimeServices,
        plugin_snapshot: kcoder_plugins::EffectivePluginSnapshot,
    ) -> anyhow::Result<Self> {
        Self::try_new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            folder_trusted_override,
            Some(plugin_snapshot),
            WorkspacePersistenceMode::Client,
            None,
            Some(workspace_services),
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_folder_trust(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        folder_trusted_override: Option<bool>,
    ) -> Self {
        Self::new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            folder_trusted_override,
            None,
            WorkspacePersistenceMode::Interactive,
            None,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn new_with_folder_trust_and_project_skill_telemetry(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        folder_trusted_override: Option<bool>,
        plugin_snapshot_override: Option<kcoder_plugins::EffectivePluginSnapshot>,
        workspace_persistence_mode: WorkspacePersistenceMode,
        workspace_services: Option<WorkspaceRuntimeServices>,
        register_session_on_construct: bool,
    ) -> Self {
        Self::try_new_with_folder_trust_and_project_skill_telemetry(
            provider,
            state,
            tools,
            permissions,
            settings,
            memory_manager,
            skill_registry,
            user_questioner,
            cwd,
            folder_trusted_override,
            plugin_snapshot_override,
            workspace_persistence_mode,
            None,
            workspace_services,
            register_session_on_construct,
        )
        .expect("failed to construct engine with private artifact storage")
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn try_new_with_folder_trust_and_project_skill_telemetry(
        provider: Arc<dyn Provider>,
        state: AppState,
        tools: ToolRegistry,
        permissions: PermissionEngine,
        settings: Settings,
        mut memory_manager: MemoryManager,
        mut skill_registry: SkillRegistry,
        user_questioner: Arc<dyn UserQuestioner>,
        cwd: PathBuf,
        folder_trusted_override: Option<bool>,
        plugin_snapshot_override: Option<kcoder_plugins::EffectivePluginSnapshot>,
        workspace_persistence_mode: WorkspacePersistenceMode,
        inherited_client_storage: Option<
            anyhow::Result<(PathBuf, Option<Arc<kcoder_config::PrivateTempDir>>)>,
        >,
        workspace_services: Option<WorkspaceRuntimeServices>,
        register_session_on_construct: bool,
    ) -> anyhow::Result<Self> {
        state.set_history_max_messages(settings.history_max_messages);
        state.configure_orchestrate_runtime_audit(
            settings.orchestrate.audit.enabled,
            settings.orchestrate.audit.max_events,
            settings.orchestrate.audit.max_event_bytes,
        );
        let sandbox = Arc::new(Sandbox::new(&cwd, settings.sandbox.clone()));
        if !settings.memory.structured_enabled {
            memory_manager = memory_manager.without_structured_store();
        }
        let memory_store = Arc::new(memory_manager.global_store());
        let initial_memory_prompt_count = count_memory_prompt_candidates(&state.messages());
        if register_session_on_construct {
            record_structured_memory_session(&memory_manager, &state, &cwd);
        }
        let folder_trusted =
            folder_trusted_override.unwrap_or_else(|| folder_trusted_for_cwd(&settings, &cwd));
        let mut hook_matchers =
            kcoder_hooks::discover_hooks_with_trust(&cwd, folder_trusted).into_matchers();
        let plugin_snapshot = if settings.training_mode {
            kcoder_plugins::EffectivePluginSnapshot::default()
        } else {
            plugin_snapshot_override.unwrap_or_else(|| {
                kcoder_plugins::PluginRegistry::discover_with_trust_and_settings(
                    &cwd,
                    folder_trusted,
                    &settings.plugins,
                )
                .map(|registry| registry.effective_snapshot())
                .unwrap_or_else(|error| {
                    warn!(
                        "failed to load plugin registry: {}, using settings hooks only",
                        error
                    );
                    kcoder_plugins::EffectivePluginSnapshot::default()
                })
            })
        };
        let plugin_hook_count = plugin_snapshot.hook_matchers.len();
        if plugin_hook_count > 0 {
            debug!(
                "loaded {} hook matcher(s) from {} enabled plugin(s)",
                plugin_hook_count,
                plugin_snapshot.plugin_ids.len()
            );
        }
        hook_matchers.extend(plugin_snapshot.hook_matchers.clone());
        let hook_registry = if settings.training_mode {
            kcoder_hooks::HookRegistry::from_matchers(hook_matchers).without_model_calls()
        } else {
            kcoder_hooks::HookRegistry::from_matchers(hook_matchers)
        };
        if settings.training_mode {
            skill_registry.remove_named("kcoder-settings");
        }
        if workspace_persistence_mode.allows_implicit_project_writes() {
            record_loaded_skill_metadata(&cwd, &settings.skills.external_dirs, &skill_registry);
        }
        let project_instructions = kcoder_config::build_project_md_system_prompt(&cwd);
        let project_user_context = (!project_instructions.is_empty()).then(|| {
            Message::runtime_text(format!(
                "<project-instructions>\n{}\n</project-instructions>",
                project_instructions
            ))
        });
        let skill_registry = Arc::new(RwLock::new(skill_registry));
        let (background_jobs, background_job_rx) = BackgroundJobManager::new(state.clone());
        let subagent_tools = tools.clone();
        let tool_schema_revision = tools.revision();
        let (tool_definitions, tool_input_schemas, tool_input_hints) = build_tool_caches(&tools);
        let (session_storage_root, client_storage_owner) = match workspace_persistence_mode {
            WorkspacePersistenceMode::Interactive => (cwd.join(".kcoder").join("sessions"), None),
            WorkspacePersistenceMode::Client => {
                if let Some(inherited) = inherited_client_storage {
                    inherited?
                } else if let Some(storage) = workspace_services
                    .as_ref()
                    .and_then(|services| services.client_storage.clone())
                {
                    storage
                } else {
                    client_session_storage_root(&cwd)?
                }
            }
        };
        if matches!(workspace_persistence_mode, WorkspacePersistenceMode::Client)
            && state.session_artifact_project_dir().is_none()
        {
            state.with_session_artifact_project_dir(
                session_storage_root.clone(),
                state.session_id(),
            );
        }
        let checkpoints_dir =
            kcoder_state::session_dir_path(&session_storage_root, &state.artifact_session_id());
        let tool_repair_index = Arc::new(tool_repair::ToolRepairIndex::load(&cwd));
        let memory_observer_queue = MemoryObserverQueue::with_config(MemoryObserverQueueConfig {
            capacity: settings.memory.observer_queue_size,
            overflow_policy: MemoryObserverQueueOverflowPolicy::InlineFallback,
        });
        let now = SystemTime::now();
        let workspace_services = workspace_services
            .unwrap_or_else(|| WorkspaceRuntimeServices::new(&cwd, &state.session_id()));
        state.set_diagnostic_context(
            workspace_services.diagnostic_writer.clone(),
            client_storage_owner.clone(),
        );
        if !settings.training_mode {
            workspace_services.prewarm_provider_once(provider.clone());
        }
        let cron_scheduler = workspace_services.cron_scheduler;
        let shell_environment_snapshot = workspace_services.shell_environment_snapshot;
        let auto_compact_state = Arc::new(RwLock::new(AutoCompactState::default()));
        // Pin the edit surface at engine creation: the session cannot switch
        // surfaces mid-run (see `file_edit_surface`).
        let file_edit_surface = settings.tools.file_edit_tool;
        Ok(Self {
            provider: Arc::new(RwLock::new(provider)),
            client_model_configuration: None,
            client_model_options: Arc::new(RwLock::new(
                client_model_configuration::ClientModelOptions {
                    default_reasoning: settings.model_reasoning_effort.clone(),
                    selection: Some((settings.active_provider.clone(), settings.model.clone())),
                    ..Default::default()
                },
            )),
            request_class: request_admission::RequestClass::Foreground,
            state,
            tools,
            subagent_tools: Arc::new(RwLock::new(subagent_tools)),
            tool_definitions: Arc::new(tool_definitions),
            tool_input_hints: Arc::new(tool_input_hints),
            tool_schema_revision,
            tool_input_schemas: Arc::new(tool_input_schemas),
            permissions: Arc::new(RwLock::new(permissions)),
            settings: Arc::new(RwLock::new(settings)),
            file_edit_surface,
            settings_persistence_target: Arc::new(RwLock::new(SettingsPersistenceTarget::Disabled)),
            settings_persistence_order: Arc::new(AsyncMutex::new(())),
            tool_execution_gate: Arc::new(tokio::sync::RwLock::new(())),
            memory_manager: Arc::new(memory_manager),
            memory_store,
            memory_prompt_counter: Arc::new(RwLock::new(initial_memory_prompt_count)),
            memory_observer_queue: Arc::new(RwLock::new(memory_observer_queue)),
            memory_idle_gate: Arc::new(RwLock::new(())),
            memory_idle_reserved: Arc::new(AtomicBool::new(false)),
            memory_observer_last_validation_failure: Arc::new(RwLock::new(None)),
            memory_observer_worker_diagnostics: Arc::new(RwLock::new(
                MemoryObserverWorkerDiagnostics::default(),
            )),
            memory_observer_worker_running: Arc::new(AtomicBool::new(false)),
            memory_observer_worker_handle: Arc::new(Mutex::new(None)),
            memory_session_end_summary_recorded: Arc::new(AtomicBool::new(false)),
            skill_registry,
            active_skills: Arc::new(RwLock::new(Vec::new())),
            skill_registry_generation: Arc::new(AtomicU64::new(0)),
            skill_mutation_actor: Arc::new(None),
            cwd,
            session_storage_root,
            client_storage_owner,
            workspace_persistence_mode,
            cancel_token: CancellationToken::new(),
            input_persistence_failed: Arc::new(AtomicBool::new(false)),
            shorten_signal: Arc::new(tokio::sync::Notify::new()),
            prefire_owner: Arc::new(PrefireOwner::new(Arc::clone(&auto_compact_state))),
            auto_compact_state,
            token_estimate_cache: Arc::new(token_estimate_cache::TokenEstimateCache::default()),
            session_inspection_store: Arc::default(),
            desktop_binding: Default::default(),
            session_request_observation: Arc::default(),
            tool_serialization_cache: Arc::new(
                tool_serialization_cache::ToolSerializationCache::default(),
            ),
            hook_registry,
            plugin_snapshot: Arc::new(plugin_snapshot),
            folder_trusted,
            last_cache_safe_params: Arc::new(RwLock::new(None)),
            project_user_context: Arc::new(project_user_context),
            subagent_system_prompt: Arc::new(None),
            subagent_runtime_control: Arc::new(None),
            cumulative_usage: Arc::new(RwLock::new(UsageAccumulator::default())),
            auto_skill_review_counter: Arc::new(RwLock::new(0)),
            auto_skill_review_running: Arc::new(AtomicBool::new(false)),
            auto_curator_last_run: Arc::new(RwLock::new(Some(now))),
            auto_curator_last_activity: Arc::new(RwLock::new(now)),
            auto_curator_running: Arc::new(AtomicBool::new(false)),
            session_memory_update_running: Arc::new(AtomicBool::new(false)),
            session_memory_update_started_at: Arc::new(Mutex::new(None)),
            session_memory_update_notify: Arc::new(Notify::new()),
            session_memory_update_handle: Arc::new(Mutex::new(None)),
            user_questioner,
            sandbox,
            checkpoints: checkpoint::CheckpointManager::new(checkpoints_dir),
            arrangement_mode: Arc::new(AtomicBool::new(false)),
            luna_mode: Arc::new(AtomicBool::new(false)),
            allowed_write_paths: Arc::new(RwLock::new(Vec::new())),
            allowed_shell_prefixes: Arc::new(RwLock::new(Vec::new())),
            block_shell_file_mutation: Arc::new(AtomicBool::new(false)),
            block_dependency_mutation: Arc::new(AtomicBool::new(false)),
            shell_isolation_root: Arc::new(RwLock::new(None)),
            verifier_minimum_test_scope: Arc::new(RwLock::new(None)),
            verifier_require_raw_exit_code: Arc::new(AtomicBool::new(false)),
            verifier_require_behavior_delta: Arc::new(AtomicBool::new(false)),
            verifier_baseline_root: Arc::new(RwLock::new(None)),
            verifier_vote_channel: Arc::new(RwLock::new(None)),
            review_vote_channel: Arc::new(RwLock::new(None)),
            terminal_verdict_turn: Arc::new(AtomicBool::new(false)),
            tool_path_previews: false,
            agent_depth: Arc::new(AtomicU32::new(0)),
            background_jobs: Arc::new(background_jobs),
            subagent_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_SUBAGENTS)),
            background_recovery_announced: Default::default(),
            background_started_announced: Default::default(),
            background_job_rx: Arc::new(tokio::sync::Mutex::new(background_job_rx)),
            turn_driver_signal: turn_driver::TurnDriverSignal::default(),
            tool_failure_tracker: Arc::new(RwLock::new(ToolFailureTracker::default())),
            todo_update_reminder_tracker: Arc::new(RwLock::new(
                TodoUpdateReminderTracker::default(),
            )),
            tool_repair_recorder: Arc::new(RwLock::new(
                tool_repair::ToolRepairSessionRecorder::default(),
            )),
            tool_repair_index,
            next_moa_request: Arc::new(RwLock::new(None)),
            turn_steer_mailbox: Arc::new(Mutex::new(TurnSteerMailbox::default())),
            shell_environment_snapshot,
            cron_scheduler,
        })
    }
}
