use anyhow::{Context, Result};
use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_engine::{QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::MemoryManager;
use kcoder_permissions::PermissionEngine;
use kcoder_plugins::EffectivePluginSnapshot;
use kcoder_skills::SkillRegistry;
use kcoder_state::{AppState, PreparedSessionResume};
use kcoder_tools::{ToolRegistry, UserQuestioner};
use std::path::PathBuf;
use std::sync::Arc;

/// Immutable composition baseline used by the app-server to create independent thread engines.
///
/// The factory shares only workspace-level services and connected Tool/MCP handles.
/// Each construction copies base settings and permissions and creates a new `AppState`,
/// so it cannot inherit another thread's temporary model/proxy, session permissions, or background task state.
#[derive(Clone)]
pub(crate) struct AppServerEngineFactory {
    configuration: Option<super::session_configuration::SessionConfiguration>,
    provider: Arc<dyn Provider>,
    tools: ToolRegistry,
    base_permissions: PermissionEngine,
    base_settings: Settings,
    memory_manager: MemoryManager,
    skill_registry: SkillRegistry,
    plugin_snapshot: EffectivePluginSnapshot,
    cwd: PathBuf,
    history_directory: Option<PathBuf>,
    folder_trusted: bool,
    workspace_services: WorkspaceRuntimeServices,
    settings_persistence_path: Option<PathBuf>,
    short_id_registry: PathBuf,
}

impl AppServerEngineFactory {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        provider: Arc<dyn Provider>,
        tools: ToolRegistry,
        base_permissions: PermissionEngine,
        base_settings: Settings,
        memory_manager: MemoryManager,
        skill_registry: SkillRegistry,
        plugin_snapshot: EffectivePluginSnapshot,
        cwd: PathBuf,
        history_directory: Option<PathBuf>,
        folder_trusted: bool,
        workspace_services: WorkspaceRuntimeServices,
        settings_persistence_path: Option<PathBuf>,
        short_id_registry: PathBuf,
    ) -> Self {
        Self {
            configuration: None,
            provider,
            tools,
            base_permissions,
            base_settings,
            memory_manager,
            skill_registry,
            plugin_snapshot,
            cwd,
            history_directory,
            folder_trusted,
            workspace_services,
            settings_persistence_path,
            short_id_registry,
        }
    }

    pub(crate) fn with_session_configuration(
        mut self,
        loader: kcoder_config::SettingsLoader,
        cli: crate::Cli,
        mcp_snapshot_complete: bool,
    ) -> Result<Self> {
        let mut configuration =
            super::session_configuration::SessionConfiguration::new(loader, cli);
        if mcp_snapshot_complete {
            configuration.seed_mcp(&self.base_settings, &self.plugin_snapshot, &self.tools)?;
        }
        self.configuration = Some(configuration);
        Ok(self)
    }

    pub(super) fn tool_profile_settings(&self, profile: Option<kcoder_app_protocol::ToolProfile>) -> Result<kcoder_app_protocol::ToolsSettingsResult> {
        let configuration = self.configuration.as_ref().context("Tool settings unavailable for this runtime")?;
        match profile {
            Some(profile) => configuration.save_tool_profile(profile),
            None => configuration.read_tool_profile(),
        }
    }

    pub(super) fn supports_session_reload(&self) -> bool {
        self.configuration.is_some()
    }

    pub(super) fn supports_turn_model_reload(&self) -> bool {
        self.configuration.is_some() && self.provider.supports_client_runtime_reconfiguration()
    }

    pub(super) fn current_settings(&self) -> Result<Settings> {
        match &self.configuration {
            Some(configuration) => configuration.settings(&self.cwd, self.folder_trusted),
            None => Ok(self.base_settings.clone()),
        }
    }

    pub(super) fn current_model_profiles(&self) -> Result<Vec<kcoder_engine::ConfiguredModelProfile>> {
        let settings = self.current_settings()?;
        match &self.configuration {
            Some(configuration) => QueryEngine::configured_model_profiles_with_source(&settings, configuration.model_source().as_ref()),
            None => Ok(QueryEngine::configured_model_profiles_for_settings(&settings)),
        }
    }

    pub(super) fn hook_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration.hook_user_settings_path(),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Writable user settings are unavailable")),

        }
    }

    pub(super) fn mcp_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration.mcp_user_settings_path(),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Writable user settings are unavailable")),
        }
    }

    pub(super) fn mcp_connection_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
    ) -> Option<kcoder_app_protocol::McpConnectionAttemptStatus> {
        self.configuration.as_ref()?.mcp_connection_attempt(config)
    }

    pub(super) fn current_mcp_servers(&self) -> Result<Vec<super::mcp_processor::ConfiguredMcp>> {
        let settings = self.current_settings()?;
        let plugins = if self.configuration.is_some() {
            crate::runtime_plugin_snapshot(&self.cwd, self.folder_trusted, &settings)?
        } else {
            self.plugin_snapshot.clone()
        };
        let configured_count = if self.configuration.is_some() {
            settings.mcp_servers.len()
        } else {
            settings
                .mcp_servers
                .len()
                .saturating_sub(plugins.mcp_configs.len())
        };
        let mut result: Vec<_> = settings
            .mcp_servers
            .into_iter()
            .take(configured_count)
            .map(|config| super::mcp_processor::ConfiguredMcp {
                config,
                plugin_id: None,
            })
            .collect();
        for (config, source) in plugins
            .mcp_configs
            .into_iter()
            .zip(plugins.mcp_config_sources)
        {
            result.push(super::mcp_processor::ConfiguredMcp {
                config,
                plugin_id: Some(source.plugin_id),
            });
        }
        Ok(result)
    }

    pub(super) fn current_skills(&self) -> Result<SkillRegistry> {
        if self.configuration.is_none() {
            return Ok(self.skill_registry.clone());
        }
        let settings = self.current_settings()?;
        let plugins = crate::runtime_plugin_snapshot(&self.cwd, self.folder_trusted, &settings)?;
        let mut roots = settings.skills.external_dirs.clone();
        roots.extend(plugins.skill_roots);
        let mut skills = SkillRegistry::load_with_external_dirs_and_trust(
            &self.cwd,
            roots.iter(),
            self.folder_trusted,
        )?;
        for (root, directory) in &plugins.skill_trust_roots {
            skills.require_folder_trust(root, directory, Settings::config_dir().ok());
        }
        crate::apply_training_skill_isolation(&settings, &mut skills);
        Ok(skills)
    }

    async fn refreshed(&self) -> Result<Self> {
        let Some(configuration) = self.configuration.clone() else {
            return Ok(self.clone());
        };
        let mut next = self.clone();
        next = tokio::task::spawn_blocking(move || {
            next.configuration = next
                .configuration
                .take()
                .map(|configuration| configuration.freeze_model_overlays())
                .transpose()?;
            next.base_settings = next.current_settings()?;
            // Reclaim turn-file snapshots per `turn_file_changes` policy once per
            // conversation, so unbounded snapshot growth is impossible by default.
            match super::storage_diagnostics::enforce_turn_snapshot_budget(
                &next.base_settings.turn_file_changes,
            ) {
                Ok(outcome) if outcome.removed_snapshots > 0 => tracing::info!(
                    snapshots = outcome.removed_snapshots,
                    bytes = outcome.removed_bytes,
                    remaining_bytes = outcome.remaining_bytes,
                    "reclaimed turn-file snapshots per policy"
                ),
                Ok(_) => {}
                Err(error) => tracing::warn!(
                    %error,
                    "failed to enforce the turn-file snapshot budget"
                ),
            }
            next.provider = configuration.provider(&next.base_settings)?;
            next.plugin_snapshot = crate::runtime_plugin_snapshot(
                &next.cwd,
                next.folder_trusted,
                &next.base_settings,
            )?;
            let mut skill_dirs = next.base_settings.skills.external_dirs.clone();
            skill_dirs.extend(next.plugin_snapshot.skill_roots.iter().cloned());
            next.skill_registry = SkillRegistry::load_with_external_dirs_and_trust(
                &next.cwd,
                skill_dirs.iter(),
                next.folder_trusted,
            )?;
            for (root, directory) in &next.plugin_snapshot.skill_trust_roots {
                next.skill_registry.require_folder_trust(
                    root,
                    directory,
                    Settings::config_dir().ok(),
                );
            }
            crate::apply_training_skill_isolation(&next.base_settings, &mut next.skill_registry);
            next.base_settings
                .mcp_servers
                .extend(next.plugin_snapshot.mcp_configs.iter().cloned());
            next.base_permissions = PermissionEngine::from_settings(&next.base_settings)
                .with_audit_log(kcoder_config::Settings::config_dir()?.join("permissions.log"));
            Ok::<_, anyhow::Error>(next)
        })
        .await??;
        next.tools = next
            .configuration
            .as_ref()
            .unwrap()
            .tools(&next.base_settings, &next.plugin_snapshot)
            .await?;
        Ok(next)
    }

    /// Creates a thread engine with an optional session settings template overlay.
    pub(super) async fn create_fresh_thread_with_template(
        &self,
        template: Option<PathBuf>,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        match template {
            Some(path) => self
                .with_settings_template(path)
                .refreshed()
                .await?
                .create_new_thread(user_questioner),
            None => self.refreshed().await?.create_new_thread(user_questioner),
        }
    }

    /// Adds a session settings template to this factory's reload layer.
    pub(super) fn with_settings_template(&self, path: PathBuf) -> Self {
        let mut next = self.clone();
        next.configuration = next
            .configuration
            .map(|configuration| configuration.with_template(path));
        next
    }

    /// Resumes a thread with its recorded session settings template reapplied.
    pub(super) async fn resume_fresh_thread_with_template(
        &self,
        template: Option<PathBuf>,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize)> {
        match template {
            Some(path) => self
                .with_settings_template(path)
                .refreshed()
                .await?
                .resume_thread(prepared, user_questioner),
            None => self
                .refreshed()
                .await?
                .resume_thread(prepared, user_questioner),
        }
    }

    pub(super) fn create_new_thread(
        &self,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        self.build(self.new_state()?, user_questioner)
    }

    pub(super) fn create_ephemeral_thread(
        &self,
        source: &QueryEngine,
        messages: Vec<kcoder_types::Message>,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        let owner = Arc::new(kcoder_config::create_private_temp_dir(
            "kcoder-ephemeral-thread",
        )?);
        let mut factory = self.clone();
        // Preserve the exact selected provider/profile, including duplicate model names.
        // Runtime goal state and session permission grants are not inherited.
        factory.provider = source.current_provider();
        factory.tools = source.tools.clone();
        factory.plugin_snapshot = (*source.plugin_snapshot()).clone();
        factory.skill_registry = source
            .skill_registry
            .read()
            .map_err(|_| anyhow::anyhow!("source skills are unavailable"))?
            .clone();
        factory.base_settings = source
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("source settings are unavailable"))?
            .clone();
        factory.base_settings.permission_mode = self.base_settings.permission_mode;
        factory.base_settings.memory.structured_enabled = false;
        factory.base_settings.session_memory.enabled = false;
        factory.history_directory = Some(owner.path().to_path_buf());
        factory.base_settings.history_enabled = true;
        factory.workspace_services = self.workspace_services.with_private_client_storage(owner);
        let state = factory.new_state()?;
        if source.state.session_mode().is_orchestrate() {
            state.enter_orchestrate_before_first_message()?;
        }
        state.set_messages(messages);
        let engine = factory.build(state, user_questioner)?;
        Ok(engine.with_client_model_configuration_from(source))
    }

    pub(super) fn resume_thread(
        &self,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize)> {
        let state = AppState::new(&self.cwd);
        state.set_short_id_registry(&self.short_id_registry);
        let restored = state.apply_prepared_session_resume(prepared)?;
        Ok((self.build(state, user_questioner)?, restored))
    }

    pub(crate) fn build_with_state(
        &self,
        state: AppState,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        self.build(state, user_questioner)
    }

    fn new_state(&self) -> Result<AppState> {
        let state = AppState::new_with_short_id(&self.cwd, &self.short_id_registry)?;
        if self.base_settings.history_enabled
            && let Some(history_directory) = self.history_directory.as_deref()
        {
            state.with_deferred_history_path(
                history_directory.join(format!("{}.jsonl", state.session_id())),
            );
        }
        Ok(state)
    }

    fn build(
        &self,
        state: AppState,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        let engine = QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
            Arc::clone(&self.provider),
            state,
            self.tools.clone(),
            self.base_permissions.clone(),
            self.base_settings.clone(),
            self.memory_manager.clone(),
            self.skill_registry.clone(),
            user_questioner,
            self.cwd.clone(),
            Some(self.folder_trusted),
            self.workspace_services.clone(),
            self.plugin_snapshot.clone(),
        )?;
        let engine = match &self.configuration {
            Some(configuration) => {
                engine.with_client_model_configuration(configuration.model_source())
            }
            None => engine,
        };
        Ok(match self.settings_persistence_path.clone() {
            Some(path) => engine.with_settings_persistence_path(path),
            None => engine,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::AppServerEngineFactory;
    use crate::app_server::SessionLease;
    use crate::tui_dev_mock::{MockScenarioProvider, TuiDevScenario};
    use kcoder_config::{PermissionMode, Settings};
    use kcoder_engine::WorkspaceRuntimeServices;
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use kcoder_types::Message;
    use std::sync::Arc;

    fn factory(cwd: &std::path::Path) -> AppServerEngineFactory {
        let settings = Settings {
            history_enabled: false,
            permission_mode: PermissionMode::Bypass,
            ..Settings::default()
        };
        let permissions = PermissionEngine::from_settings(&settings);
        AppServerEngineFactory::new(
            Arc::new(MockScenarioProvider::new(TuiDevScenario::FullTurn)),
            ToolRegistry::new(),
            permissions,
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            cwd.to_path_buf(),
            None,
            true,
            WorkspaceRuntimeServices::try_new_for_client(cwd, "factory-test").unwrap(),
            None,
            cwd.join("test-session-ids"),
        )
    }

    #[test]
    fn resident_threads_keep_external_tool_identity_after_rejected_registration() {
        struct ExternalTool;
        #[async_trait::async_trait]
        impl kcoder_tools::Tool for ExternalTool {
            fn name(&self) -> String {
                "mcp__docs__read".into()
            }
            fn source(&self) -> kcoder_tools::ToolSource {
                kcoder_tools::ToolSource::Plugin {
                    plugin: "docs@market".into(),
                    server: "docs".into(),
                    tool: "read".into(),
                }
            }
            fn description(&self) -> String {
                "read docs".into()
            }
            fn input_schema(&self) -> serde_json::Value {
                serde_json::json!({"type": "object"})
            }
            async fn call(
                &self,
                _: serde_json::Value,
                _: &kcoder_tools::ToolContext,
            ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
                Ok(kcoder_tools::ToolOutput::text("docs"))
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut factory = factory(temp.path());
        factory.tools.try_register(Arc::new(ExternalTool)).unwrap();
        assert!(factory.tools.try_register(Arc::new(ExternalTool)).is_err());
        let expected = factory.tools.source("mcp__docs__read").unwrap().clone();
        for _ in 0..2 {
            let engine = factory
                .create_new_thread(Arc::new(DenyAllUserQuestioner))
                .unwrap();
            assert_eq!(engine.tools.source("mcp__docs__read"), Some(&expected));
            assert_eq!(
                engine.active_tool_registry().source("mcp__docs__read"),
                Some(&expected)
            );
        }
    }

    #[test]
    fn ephemeral_threads_copy_full_context_into_private_owned_storage() {
        let temp = tempfile::tempdir().unwrap();
        let factory = factory(temp.path());
        let mut source_factory = factory.clone();
        source_factory.plugin_snapshot.plugin_ids = vec!["session-specific-plugin".into()];
        let source = source_factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let full_text = "history-not-a-ui-preview".repeat(10_000);
        source.state.add_message(Message::user_text(&full_text));
        source
            .state
            .add_message(Message::assistant_text("source answer"));
        source.state.set_goal("source-only goal", None);
        source
            .permissions
            .write()
            .unwrap()
            .session_allowed
            .push("source-only-tool".into());
        source.settings.write().unwrap().active_provider = Some("profile-with-shared-model".into());
        let ephemeral = factory
            .create_ephemeral_thread(
                &source,
                source.state.messages(),
                Arc::new(DenyAllUserQuestioner),
            )
            .unwrap();
        let root = ephemeral.client_storage_root();
        assert_ne!(root, source.client_storage_root());
        assert!(root.exists());
        assert_eq!(ephemeral.state.messages(), source.state.messages());
        assert!(Arc::ptr_eq(
            &source.current_provider(),
            &ephemeral.current_provider()
        ));
        assert_eq!(
            ephemeral
                .settings
                .read()
                .unwrap()
                .active_provider
                .as_deref(),
            Some("profile-with-shared-model")
        );
        assert_eq!(
            ephemeral.plugin_snapshot().plugin_ids,
            vec!["session-specific-plugin"]
        );
        assert!(ephemeral.state.goal().is_none());
        assert!(
            ephemeral
                .permissions
                .read()
                .unwrap()
                .session_allowed
                .is_empty()
        );
        assert!(!ephemeral.settings.read().unwrap().memory.structured_enabled);
        assert!(ephemeral.state.history_path().unwrap().starts_with(&root));
        ephemeral
            .state
            .add_message(Message::user_text("temporary-only"));
        ephemeral.state.save_history().unwrap();
        assert_eq!(source.state.messages().len(), 2);
        assert_eq!(ephemeral.state.messages().len(), 3);
        drop(ephemeral);
        assert!(
            !root.exists(),
            "ephemeral history and artifacts must be owned by the engine lifetime"
        );
    }

    #[test]
    fn new_session_approval_prompt_uses_the_loaded_engine_policy() {
        let temp = tempfile::tempdir().unwrap();
        let engine = factory(temp.path())
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        engine.settings.write().unwrap().permission_mode = PermissionMode::Ask;
        let (outbound, _) = tokio::sync::mpsc::channel(4);
        let mut state = super::super::ResidentTurnState::new(
            outbound,
            PermissionMode::Bypass,
            Arc::new(std::sync::atomic::AtomicU64::new(1)),
            Arc::new(std::sync::atomic::AtomicU64::new(2)),
            Arc::new(std::sync::Mutex::new(
                super::super::InteractionReceipts::default(),
            )),
        );
        state.configure_for_engine(&engine);
        assert_eq!(state.permission_prompt.mode, PermissionMode::Ask);
    }

    #[test]
    fn engines_have_independent_session_settings_permissions_and_storage() {
        let temp = tempfile::tempdir().unwrap();
        let factory = factory(temp.path());
        let first = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let second = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();

        assert_ne!(first.session_id(), second.session_id());
        assert_ne!(first.session_lease_target(), second.session_lease_target());
        assert!(!Arc::ptr_eq(&first.settings, &second.settings));
        assert!(!Arc::ptr_eq(&first.permissions, &second.permissions));
        let second_reasoning = second
            .settings
            .read()
            .unwrap()
            .model_reasoning_effort
            .clone();

        first.state.add_message(Message::user_text("first-only"));
        first
            .permissions
            .write()
            .unwrap()
            .session_allowed
            .push("bash".to_string());
        first.set_client_reasoning_effort("low").unwrap();

        assert!(second.state.messages().is_empty());
        assert!(
            second
                .permissions
                .read()
                .unwrap()
                .session_allowed
                .is_empty()
        );
        assert_eq!(
            second.settings.read().unwrap().model_reasoning_effort,
            second_reasoning
        );
        assert_ne!(
            first.settings.read().unwrap().model_reasoning_effort,
            second.settings.read().unwrap().model_reasoning_effort
        );

        let first_lease = SessionLease::acquire(&first.session_lease_target()).unwrap();
        let second_lease = SessionLease::acquire(&second.session_lease_target()).unwrap();
        drop((first_lease, second_lease));
    }

    #[test]
    fn engines_reuse_the_factory_plugin_snapshot_without_rediscovery() {
        let temp = tempfile::tempdir().unwrap();
        let mut factory = factory(temp.path());
        factory.plugin_snapshot.plugin_ids = vec!["frozen-plugin".to_string()];

        let engine = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();

        assert_eq!(
            engine.plugin_snapshot().plugin_ids,
            vec!["frozen-plugin".to_string()]
        );
    }

    #[test]
    fn resume_builds_the_engine_from_durable_state_before_runtime_initialization() {
        let temp = tempfile::tempdir().unwrap();
        let history_path = temp.path().join("resumed-thread.jsonl");
        let source = kcoder_state::AppState::new(temp.path());
        source.with_history_path(&history_path);
        source.add_message(Message::user_text("durable prompt"));
        source.save_history().unwrap();

        let prepared = kcoder_state::prepare_session_resume(&history_path).unwrap();
        let factory = factory(temp.path());
        let (resumed, restored) = factory
            .resume_thread(prepared, Arc::new(DenyAllUserQuestioner))
            .unwrap();

        assert_eq!(resumed.session_id(), "resumed-thread");
        assert_eq!(
            resumed.state.history_path().as_deref(),
            Some(history_path.as_path())
        );
        assert_eq!(restored, 1);
        assert_eq!(resumed.state.messages().len(), 1);
        assert_eq!(resumed.client_turn_count(), 1);
    }

    #[test]
    fn unactivated_candidate_does_not_persist_an_empty_session_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let history_directory = temp.path().join("history");
        let mut factory = factory(temp.path());
        factory.base_settings.history_enabled = true;
        factory.history_directory = Some(history_directory);

        let candidate = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let sidecar = candidate.state.session_state_path().unwrap();
        assert!(!sidecar.exists());

        candidate.activate_client_session();
        assert!(sidecar.exists());
    }
}
