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
#[path = "engine_factory/history_continuation.rs"]
mod history_continuation;
#[cfg(test)]
#[path = "engine_factory/model_preview_tests.rs"]
mod model_preview_tests;
#[path = "engine_factory/native_input.rs"]
mod native_input;
#[cfg(test)]
#[path = "engine_factory/native_installation.rs"]
mod native_installation;
#[cfg(test)]
#[path = "engine_factory/project_settings_tests.rs"]
mod project_settings_tests;
#[path = "engine_factory/task_successor.rs"]
mod task_successor;
#[path = "engine_factory/tool_selections.rs"]
mod tool_selections;
#[cfg(feature = "web-network-test-fixture")]
#[path = "engine_factory/web_network_test_fixture.rs"]
mod web_network_test_fixture;
#[path = "engine_factory/web_search.rs"]
pub mod web_search;

/// Immutable composition baseline used by the app-server to create independent thread engines.
///
/// The factory shares only workspace-level services and connected Tool/MCP handles.
/// Each construction copies base settings and permissions and creates a new `AppState`,
/// so it cannot inherit another thread's temporary model/proxy, session permissions, or background task state.
#[derive(Clone)]
pub struct AppServerEngineFactory {
    configuration: Option<super::session_configuration::SessionConfiguration>,
    #[cfg(feature = "web-network-test-fixture")]
    web_network_test_dns: Option<kcoder_tools::web_network::test_fixture::WebNetworkTestDns>,
    provider: Arc<dyn Provider>,
    tools: ToolRegistry,
    base_permissions: PermissionEngine,
    base_settings: Settings,
    memory_manager: MemoryManager,
    skill_registry: SkillRegistry,
    plugin_snapshot: EffectivePluginSnapshot,
    skill_catalog_leases: Arc<std::sync::Mutex<Vec<Arc<kcoder_config::PrivateTempDir>>>>,
    cwd: PathBuf,
    history_directory: Option<PathBuf>,
    folder_trusted: bool,
    workspace_services: WorkspaceRuntimeServices,
    settings_persistence_path: Option<PathBuf>,
    short_id_registry: PathBuf,
    owned_command_program: Option<PathBuf>,
    native_acp_backend: bool,
    bind_new_tool_selection: bool,
    native_engine_installer: fn(QueryEngine) -> Result<QueryEngine>,
}

impl AppServerEngineFactory {
    /// Host wiring for owned Shell/REPL commands; never populated from tool input.
    pub fn with_owned_command_program(mut self, program: Option<PathBuf>) -> Self {
        // Optional host probing must not downgrade an explicitly required owner.
        self.owned_command_program = program.or(self.owned_command_program);
        self
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
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
        #[cfg(not(test))] native_engine_installer: fn(QueryEngine) -> Result<QueryEngine>,
    ) -> Self {
        Self {
            configuration: None,
            #[cfg(feature = "web-network-test-fixture")]
            web_network_test_dns: None,
            provider,
            tools,
            base_permissions,
            base_settings,
            memory_manager,
            skill_registry,
            plugin_snapshot,
            skill_catalog_leases: Default::default(),
            cwd,
            history_directory,
            folder_trusted,
            workspace_services,
            settings_persistence_path,
            short_id_registry,
            owned_command_program: None,
            native_acp_backend: false,
            bind_new_tool_selection: true,
            #[cfg(not(test))]
            native_engine_installer,
            #[cfg(test)]
            native_engine_installer: native_installation::install_native_engine,
        }
    }

    pub fn with_session_configuration(
        mut self,
        loader: kcoder_config::SettingsLoader,
        cli: crate::Cli,
        mcp_snapshot_complete: bool,
    ) -> Result<Self> {
        #[cfg(feature = "web-network-test-fixture")]
        {
            self.web_network_test_dns = web_network_test_fixture::load()?;
        }
        self.native_acp_backend = cli.internal_acp_backend;
        #[cfg(target_os = "linux")]
        if cli.internal_acp_backend {
            self.owned_command_program = Some(std::env::current_exe()?);
        }
        let mut configuration =
            super::session_configuration::SessionConfiguration::new(loader, cli);
        if mcp_snapshot_complete {
            configuration.seed_mcp(&self.base_settings, &self.plugin_snapshot, &self.tools)?;
        }
        self.configuration = Some(configuration);
        Ok(self)
    }

    pub fn is_native_acp_backend(&self) -> bool {
        self.native_acp_backend
    }

    pub fn tool_profile_settings(
        &self,
        profile: Option<kcoder_app_protocol::ToolProfile>,
    ) -> Result<kcoder_app_protocol::ToolsSettingsResult> {
        let configuration = self
            .configuration
            .as_ref()
            .context("Tool settings unavailable for this runtime")?;
        match profile {
            Some(profile) => configuration.save_tool_profile(profile),
            None => configuration.read_tool_profile(),
        }
    }

    pub fn supports_session_reload(&self) -> bool {
        self.configuration.is_some()
    }

    pub fn cli_permission_mode_override(&self) -> Result<Option<kcoder_config::PermissionMode>> {
        self.configuration
            .as_ref()
            .map(super::session_configuration::SessionConfiguration::cli_permission_mode_override)
            .transpose()
            .map(Option::flatten)
    }

    pub fn supports_turn_model_reload(&self) -> bool {
        self.configuration.is_some() && self.provider.supports_client_runtime_reconfiguration()
    }

    pub fn knowledge_recipe(
        &self,
        path: &std::path::Path,
        settings: &Settings,
        model: &super::knowledge_model::ProviderWikiModel,
        purpose: &str,
    ) -> Result<String> {
        if !super::knowledge_worker::is_remote() {
            return super::knowledge_job_runner::recipe_key(settings, model, purpose);
        }
        let source = self
            .configuration
            .as_ref()
            .context("Persistent Wiki model configuration is unavailable")?
            .model_source();
        super::knowledge_worker_model::save(path, settings, model, purpose, source.as_ref())
    }

    pub fn knowledge_model(&self) -> Result<(Settings, super::knowledge_model::ProviderWikiModel)> {
        let loaded = self.current_settings()?;
        anyhow::ensure!(
            loaded.knowledge.can_organize(),
            "Wiki organization is disabled"
        );
        let selection = loaded
            .knowledge
            .organization_model
            .clone()
            .unwrap_or_else(|| {
                loaded
                    .active_provider
                    .as_ref()
                    .map(|id| format!("{id}::{}", loaded.model))
                    .unwrap_or_else(|| loaded.model.clone())
            });
        if loaded.knowledge.organization_model.is_some() {
            anyhow::ensure!(
                selection
                    .split_once("::")
                    .is_some_and(|(id, model)| !id.is_empty() && !model.is_empty()),
                "Wiki organization model must be a qualified Provider::model selection"
            );
        }
        let mut settings = match &self.configuration {
            Some(configuration) => configuration.model_source().settings(&selection)?,
            None => {
                anyhow::ensure!(
                    selection == self.base_settings.model
                        || self.base_settings.active_provider.as_ref().is_some_and(
                            |id| selection == format!("{id}::{}", self.base_settings.model)
                        ),
                    "This runtime cannot resolve a Wiki model override"
                );
                loaded.clone()
            }
        };
        if let Some(effort) = loaded.knowledge.organization_reasoning_effort {
            settings.model_reasoning_effort = Some(effort);
            settings.validate_model_reasoning_policy()?;
        }
        super::knowledge_worker_model::prepare_settings(&mut settings)?;
        let provider = match &self.configuration {
            Some(configuration) => configuration.model_source().provider(&settings)?,
            None => self.provider.clone(),
        };
        let model = super::knowledge_model::ProviderWikiModel {
            configuration: Some(super::knowledge_worker_model::summary(&settings)?),
            provider,
            model: settings.model.clone(),
            max_output_tokens: settings.max_tokens,
            reasoning: settings.model_reasoning_effort.clone(),
        };
        Ok((settings, model))
    }

    pub fn connectivity_settings_sources(&self) -> Result<kcoder_config::LoadedSettings> {
        self.configuration
            .as_ref()
            .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?
            .connectivity_settings_sources()
    }

    pub fn current_settings(&self) -> Result<Settings> {
        match &self.configuration {
            Some(configuration) => configuration.settings(&self.cwd, self.folder_trusted),
            None => Ok(self.base_settings.clone()),
        }
    }

    /// The channel policy reads feature switches and credential backend mode.
    /// Its actual credential is verified separately by the channel vault.
    pub fn connectivity_policy_settings(&self) -> Result<Settings> {
        match &self.configuration {
            Some(configuration) => configuration.connectivity_policy_settings(),
            None => Ok(self.base_settings.clone()),
        }
    }

    pub fn scenario_model_name(&self) -> Option<&str> {
        (self.configuration.is_none() && self.provider.name() == "tui-dev-mock")
            .then_some(self.base_settings.model.as_str())
    }

    pub fn current_model_profiles(&self) -> Result<Vec<kcoder_engine::ConfiguredModelProfile>> {
        let settings = self.current_settings()?;
        match &self.configuration {
            Some(configuration) => QueryEngine::configured_model_profiles_with_source(
                &settings,
                configuration.model_source().as_ref(),
            ),
            None => Ok(QueryEngine::configured_model_profiles_for_settings(
                &settings,
            )),
        }
    }

    pub fn hook_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration.hook_user_settings_path(),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Writable user settings are unavailable")),
        }
    }

    pub fn mcp_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration.mcp_user_settings_path(),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Writable user settings are unavailable")),
        }
    }

    pub fn migration_project_settings_path(&self, fields: &[&str]) -> Result<PathBuf> {
        anyhow::ensure!(self.folder_trusted, "migration_project_target_untrusted");
        let path = match &self.configuration {
            Some(configuration) => configuration.migration_project_settings_path(fields)?,
            None => self.cwd.join(".kcoder/settings.json"),
        };
        anyhow::ensure!(
            path == self.cwd.join(".kcoder/settings.json"),
            "migration_project_target_scope_changed"
        );
        Ok(path)
    }

    pub fn migration_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration
                .migration_user_settings_path()
                .map_err(|_| anyhow::anyhow!("migration_target_controlled_by_overlay")),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_target_unavailable")),
        }
    }

    pub fn migration_project_target_context(&self) -> (PathBuf, Option<PathBuf>) {
        (
            self.cwd.clone(),
            self.workspace_services.client_workspace_registry_root(),
        )
    }

    pub fn migration_source_roots(&self) -> Result<kcoder_migration::discovery::DiscoveryRoots> {
        Ok(kcoder_migration::discovery::DiscoveryRoots {
            home: dirs::home_dir().context("migration_home_unavailable")?,
            claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            codex_home: std::env::var_os("CODEX_HOME").map(PathBuf::from),
            project: self.folder_trusted.then(|| self.cwd.clone()),
        })
    }

    pub fn migration_mcp_settings_path(&self) -> Result<PathBuf> {
        let path = self
            .mcp_user_settings_path()
            .map_err(|_| anyhow::anyhow!("migration_target_controlled_by_overlay"))?;
        self.mcp_activation_user_settings_path()
            .map_err(|_| anyhow::anyhow!("migration_target_controlled_by_overlay"))?;
        Ok(path)
    }

    pub fn mcp_connection_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
    ) -> Option<kcoder_app_protocol::McpConnectionAttempt> {
        self.configuration.as_ref()?.mcp_connection_attempt(config)
    }

    pub fn mcp_activation_user_settings_path(&self) -> Result<PathBuf> {
        match &self.configuration {
            Some(configuration) => configuration.mcp_activation_user_settings_path(),
            None => self
                .settings_persistence_path
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Writable user settings are unavailable")),
        }
    }

    pub fn mcp_connection_attempt_for_registry(
        &self,
        config: &kcoder_mcp::McpServerConfig,
        registry: &kcoder_tools::ToolRegistry,
    ) -> Option<kcoder_app_protocol::McpConnectionAttempt> {
        self.configuration
            .as_ref()?
            .mcp_connection_attempt_for_registry(config, registry)
    }

    /// Refresh private values only for the currently frozen, unchanged installation set.
    pub fn refresh_plugin_credentials<'a>(
        &'a self,
        engine: &'a QueryEngine,
    ) -> futures::future::BoxFuture<'a, Result<Option<QueryEngine>>> {
        Box::pin(self.refresh_plugin_credentials_producer(engine))
    }
    async fn refresh_plugin_credentials_producer(
        &self,
        engine: &QueryEngine,
    ) -> Result<Option<QueryEngine>> {
        let Some(configuration) = &self.configuration else {
            return Ok(None);
        };
        let frozen = engine.plugin_snapshot();
        if frozen.plugin_ids.is_empty() {
            return Ok(None);
        }
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("Plugin turn settings unavailable"))?
            .clone();
        let profile = engine
            .settings_persistence_path()
            .context("Plugin credential profile unavailable")?;
        let Some(refresh) = configuration
            .refresh_plugin_credentials(&self.cwd, self.folder_trusted, settings, &profile, &frozen)
            .await?
        else {
            return Ok(None);
        };
        Ok(Some(engine.clone().with_host_plugin_runtime(
            refresh.settings,
            refresh.tools,
            refresh.snapshot,
        )?))
    }

    /// Read presentation sources without startup-only bundled-plugin installation.
    pub fn current_mcp_apps_sources(
        &self,
    ) -> Result<(Settings, Vec<super::mcp_apps_runtime::ConfiguredAppSource>)> {
        let settings = self.current_settings()?;
        let plugins = if self.configuration.is_some() {
            let profile = self
                .settings_persistence_path
                .as_ref()
                .context("MCP Apps credential profile is unavailable")?;
            crate::runtime_plugin_snapshot_with_profile(
                &self.cwd,
                self.folder_trusted,
                &settings,
                &profile.with_file_name("credentials.json"),
            )?
        } else {
            self.plugin_snapshot.clone()
        };
        let result = super::mcp_apps_runtime::configured_app_sources(
            &settings,
            plugins,
            self.configuration.is_none(),
        );
        Ok((settings, result))
    }

    /// Observe the current actual plugin set separately from a retained Engine snapshot.
    pub fn current_plugin_snapshot(&self) -> Result<EffectivePluginSnapshot> {
        self.current_plugins_with_settings()
            .map(|(_, plugins)| plugins)
    }

    pub fn current_plugins_with_settings(&self) -> Result<(Settings, EffectivePluginSnapshot)> {
        let settings = self.current_settings()?;
        let plugins = if self.configuration.is_some() {
            crate::runtime_plugin_snapshot(&self.cwd, self.folder_trusted, &settings)?
        } else {
            self.plugin_snapshot.clone()
        };
        Ok((settings, plugins))
    }

    pub fn current_mcp_servers(&self) -> Result<Vec<super::mcp_processor::ConfiguredMcp>> {
        self.current_mcp_servers_with_settings()
            .map(|(_, servers)| servers)
    }

    /// One coherent settings/configuration observation for native dispatch checks.
    pub fn current_mcp_servers_with_settings(
        &self,
    ) -> Result<(Settings, Vec<super::mcp_processor::ConfiguredMcp>)> {
        self.current_mcp_configuration()
            .map(|(settings, _, servers)| (settings, servers))
    }

    pub fn current_mcp_configuration(
        &self,
    ) -> Result<(
        Settings,
        EffectivePluginSnapshot,
        Vec<super::mcp_processor::ConfiguredMcp>,
    )> {
        let (settings, plugins) = self.current_plugins_with_settings()?;
        let servers = kcoder_plugin_rpc::runtime_snapshot::configured_mcp_servers(
            &settings,
            &plugins,
            self.configuration.is_none(),
        );
        Ok((settings, plugins, servers))
    }

    pub fn current_skills(&self) -> Result<SkillRegistry> {
        if self.configuration.is_none() {
            return Ok(self.skill_registry.clone());
        }
        let settings = self.current_settings()?;
        let plugins = crate::runtime_plugin_snapshot(&self.cwd, self.folder_trusted, &settings)?;
        let mut roots = settings.skills.external_dirs.clone();
        roots.extend(plugins.skill_roots.iter().cloned());
        let mut skills = SkillRegistry::load_with_external_dirs_and_trust(
            &self.cwd,
            roots.iter(),
            self.folder_trusted,
        )?;
        for (root, directory) in &plugins.skill_trust_roots {
            skills.require_folder_trust(root, directory, Settings::config_dir().ok());
        }
        crate::apply_training_skill_isolation(&settings, &mut skills);
        *self
            .skill_catalog_leases
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = plugins.prompt_leases;
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
            next.plugin_snapshot = crate::runtime_plugin_snapshot_with_profile(
                &next.cwd,
                next.folder_trusted,
                &next.base_settings,
                &next
                    .settings_persistence_path
                    .as_ref()
                    .context("Plugin credential profile unavailable")?
                    .with_file_name("credentials.json"),
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
            next.base_settings.runtime_plugin_mcp_count = next.plugin_snapshot.mcp_configs.len();
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
    #[cfg(test)]
    pub async fn create_fresh_thread_with_template(
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

    /// Create a fresh engine and bind private client MCP tools only to this session.
    pub fn create_fresh_thread_with_mcp<'a>(
        &'a self,
        template: Option<PathBuf>,
        user_questioner: Arc<dyn UserQuestioner>,
        servers: &'a [kcoder_app_protocol::ThreadMcpServerV1],
        disconnected: &'a tokio_util::sync::CancellationToken,
        cleanup: &'a mut tokio::task::JoinSet<Result<()>>,
    ) -> futures::future::BoxFuture<
        'a,
        Result<(QueryEngine, kcoder_state::AppStateLifecycleIdentity)>,
    > {
        Box::pin(self.create_fresh_thread_with_mcp_producer(
            template,
            user_questioner,
            servers,
            disconnected,
            cleanup,
        ))
    }
    async fn create_fresh_thread_with_mcp_producer(
        &self,
        template: Option<PathBuf>,
        user_questioner: Arc<dyn UserQuestioner>,
        servers: &[kcoder_app_protocol::ThreadMcpServerV1],
        disconnected: &tokio_util::sync::CancellationToken,
        cleanup: &mut tokio::task::JoinSet<Result<()>>,
    ) -> Result<(QueryEngine, kcoder_state::AppStateLifecycleIdentity)> {
        let factory = match template {
            Some(path) => self.with_settings_template(path).refreshed().await?,
            None => self.refreshed().await?,
        };
        let state = factory.new_state()?;
        let lifecycle = state
            .try_inspection_lifecycle_identity()
            .context("New thread lifecycle is unavailable; retry the operation")?;
        let engine = factory.build(state, user_questioner)?;
        let engine =
            super::session_mcp::attach(engine, servers, self.folder_trusted, disconnected, cleanup)
                .await?;
        Ok((engine, lifecycle))
    }

    /// Adds a session settings template to this factory's reload layer.
    pub fn with_settings_template(&self, path: PathBuf) -> Self {
        let mut next = self.clone();
        next.configuration = next
            .configuration
            .map(|configuration| configuration.with_template(path));
        next
    }

    /// Resumes a thread with its recorded session settings template reapplied.
    #[cfg(test)]
    pub async fn resume_fresh_thread_with_template(
        &self,
        template: Option<PathBuf>,
        permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize)> {
        let (engine, restored, _) = self
            .resume_fresh_thread_with_template_and_lifecycle(
                template,
                permission_mode_at_creation,
                prepared,
                user_questioner,
            )
            .await?;
        Ok((engine, restored))
    }

    pub fn resume_fresh_thread_with_template_and_lifecycle<'a>(
        &'a self,
        template: Option<PathBuf>,
        permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> futures::future::BoxFuture<
        'a,
        Result<(QueryEngine, usize, kcoder_state::AppStateLifecycleIdentity)>,
    > {
        Box::pin(
            self.resume_fresh_thread_with_template_and_lifecycle_producer(
                template,
                permission_mode_at_creation,
                prepared,
                user_questioner,
            ),
        )
    }
    async fn resume_fresh_thread_with_template_and_lifecycle_producer(
        &self,
        template: Option<PathBuf>,
        permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize, kcoder_state::AppStateLifecycleIdentity)> {
        let template_permission_mode = match template.as_deref() {
            Some(path) => self.settings_template_sets_permission_mode(path)?,
            None => false,
        };
        let mut factory = match template {
            Some(path) => self.with_settings_template(path).refreshed().await?,
            None => self.refreshed().await?,
        };
        if self.cli_permission_mode_override()?.is_none()
            && !template_permission_mode
            && let Some(permission_mode) = permission_mode_at_creation
        {
            factory.base_settings.permission_mode = permission_mode;
        }
        factory.resume_thread_with_lifecycle(prepared, user_questioner)
    }

    fn settings_template_sets_permission_mode(&self, path: &std::path::Path) -> Result<bool> {
        let Some(configuration) = &self.configuration else {
            return Ok(false);
        };
        configuration.template_sets_permission_mode(path.to_path_buf())
    }

    #[cfg(test)]
    pub fn create_new_thread(
        &self,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        self.build(self.new_state()?, user_questioner)
    }

    #[cfg(test)]
    pub fn create_ephemeral_thread(
        &self,
        source: &QueryEngine,
        messages: Vec<kcoder_types::Message>,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        self.create_ephemeral_thread_with_lifecycle(source, messages, user_questioner)
            .map(|(engine, _)| engine)
    }

    pub fn create_ephemeral_thread_with_lifecycle(
        &self,
        source: &QueryEngine,
        messages: Vec<kcoder_types::Message>,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, kcoder_state::AppStateLifecycleIdentity)> {
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
        factory.inherit_studio_tool_selection(source);
        factory.base_settings.permission_mode = self.base_settings.permission_mode;
        factory.base_settings.memory.structured_enabled = false;
        factory.base_settings.session_memory.enabled = false;
        factory.history_directory = Some(owner.path().to_path_buf());
        factory.base_settings.history_enabled = true;
        factory.workspace_services = self.workspace_services.with_private_client_storage(owner);
        // Install the source selections together on the fresh fork State.
        factory.bind_new_tool_selection = false;
        let state = factory.new_state()?;
        state.inherit_task_configuration_before_first_message(&source.state)?;
        state.set_studio_work_mode_before_first_message(source.state.studio_work_mode())?;
        state.enter_session_mode_before_first_message(source.state.session_mode())?;
        if let Some(id) = source.state.workflow_definition_id() {
            state.bind_workflow_definition_before_first_message(&id)?;
        }
        source.capture_imported_context_snapshot()?;
        state.inherit_imported_context_snapshot(&source.state)?;
        state.set_messages(messages);
        let lifecycle = state
            .try_inspection_lifecycle_identity()
            .context("Fork lifecycle is unavailable; retry the operation")?;
        let engine = factory.build(state, user_questioner)?;
        Ok((
            engine.with_client_model_configuration_from(source),
            lifecycle,
        ))
    }

    pub fn resume_thread(
        &self,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize)> {
        self.resume_thread_with_lifecycle(prepared, user_questioner)
            .map(|(engine, restored, _)| (engine, restored))
    }

    /// Resolve the original model and mode without resuming or changing its history.
    pub fn preview_thread_configuration(
        &self,
        load: impl FnOnce(&std::path::Path) -> Result<AppState>,
    ) -> Result<(
        kcoder_types::ModelConfigurationSummary,
        kcoder_types::StudioWorkMode,
    )> {
        let state = load(&self.cwd)?;
        let work_mode = state.studio_work_mode();
        if let Some(configuration) = &self.configuration
            && self.provider.supports_client_runtime_reconfiguration()
        {
            let mut settings = self.base_settings.clone();
            settings.tools.studio = state.studio_tool_selection().unwrap_or_default();
            let settings = QueryEngine::resolve_next_turn_model_settings(
                settings,
                configuration.model_source().as_ref(),
                state.model_selection_mode(),
                state.selected_model().as_deref(),
            )?;
            return Ok((
                kcoder_engine::model_configuration_summary(
                    &settings,
                    kcoder_types::ModelConfigurationBoundary::NextTurn,
                )?,
                work_mode,
            ));
        }
        // Fixed providers keep the original active-snapshot semantics.
        let mut factory = self.clone();
        factory.bind_new_tool_selection = false;
        factory.base_settings.tools.studio = state.studio_tool_selection().unwrap_or_default();
        let preview = factory.build(state, Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        Ok((preview.next_turn_model_configuration_summary()?, work_mode))
    }

    fn resume_thread_with_lifecycle(
        &self,
        prepared: PreparedSessionResume,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize, kcoder_state::AppStateLifecycleIdentity)> {
        let state = AppState::new(&self.cwd);
        state.set_short_id_registry(&self.short_id_registry);
        let restored = state.apply_prepared_session_resume(prepared)?;
        let lifecycle = state
            .try_inspection_lifecycle_identity()
            .context("Restored thread lifecycle is unavailable; retry the operation")?;
        let mut restored_factory = self.clone();
        // Legacy sessions predate UI selection and retain the legacy tool surface.
        restored_factory.bind_new_tool_selection = false;
        restored_factory.base_settings.tools.studio =
            state.studio_tool_selection().unwrap_or_default();
        Ok((
            restored_factory.build(state, user_questioner)?,
            restored,
            lifecycle,
        ))
    }

    pub fn build_with_state(
        &self,
        state: AppState,
        user_questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        self.build(state, user_questioner)
    }

    fn new_state(&self) -> Result<AppState> {
        let state = AppState::new_with_short_id(&self.cwd, &self.short_id_registry)?;
        // Freeze a fresh session's tool selection before installing its
        // deferred history path. Candidate runtimes must not publish a sidecar
        // until the host has admitted and activated them.
        if self.bind_new_tool_selection {
            state.bind_studio_tool_selection_once(self.base_settings.tools.studio.clone())?;
        }
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
        let mut settings = self.base_settings.clone();
        let selection = state
            .studio_tool_selection()
            .unwrap_or_else(|| settings.tools.studio.clone());
        settings.tools.studio = selection.clone();
        let engine = QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
            Arc::clone(&self.provider),
            state,
            self.tools.clone(),
            self.base_permissions.clone(),
            settings,
            self.memory_manager.clone(),
            self.skill_registry.clone(),
            user_questioner,
            self.cwd.clone(),
            Some(self.folder_trusted),
            self.workspace_services.clone(),
            self.plugin_snapshot.clone(),
        )?;
        #[cfg(feature = "web-network-test-fixture")]
        let engine = engine.with_web_network_test_dns(self.web_network_test_dns.clone());
        if self.bind_new_tool_selection {
            engine.state.bind_studio_tool_selection_once(selection)?;
        }
        let engine = match &self.configuration {
            Some(configuration) => {
                engine.with_client_model_configuration(configuration.model_source())
            }
            None => engine,
        };
        let engine = engine
            .with_owned_command_program(self.owned_command_program.clone())
            .with_bundled_search_backend(Arc::new(kcoder_mcp::web_search::BundledWebSearch::new()));
        let engine = match self.settings_persistence_path.clone() {
            Some(path) => engine.with_settings_persistence_path(path),
            None => engine,
        };
        (self.native_engine_installer)(engine)
    }
}

#[cfg(test)]
mod tests {
    use super::AppServerEngineFactory;
    use crate::app_server::SessionLease;
    use crate::tui_dev_mock::{MockScenarioProvider, TuiDevScenario};
    use clap::Parser;
    use kcoder_config::{PermissionMode, Settings};
    use kcoder_engine::WorkspaceRuntimeServices;
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use kcoder_types::Message;
    use std::sync::Arc;

    const PERMISSION_BASELINE_TEST_ROOT_ENV: &str = "KCODER_TEST_PERMISSION_BASELINE_ISOLATED_ROOT";
    const PERMISSION_BASELINE_TEST_NAME: &str = "app_server::engine_factory::tests::creation_fork_and_resume_use_creation_permission_baselines_and_layer_priority";

    struct OwnedTestChild(std::process::Child);

    impl Drop for OwnedTestChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }

    fn run_permission_baseline_test_in_isolated_child() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let isolation = tempfile::tempdir().unwrap();
        let root = isolation.path();
        let home = root.join("home");
        let xdg_config = root.join("xdg-config");
        let config_dir = root.join("config");
        let kcoder_home = root.join("kcoder-home");
        let environment_directories = [&home, &xdg_config, &config_dir, &kcoder_home];
        for directory in environment_directories {
            std::fs::create_dir_all(directory).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for directory in environment_directories {
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
        }

        let mut child = OwnedTestChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    PERMISSION_BASELINE_TEST_NAME,
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(PERMISSION_BASELINE_TEST_ROOT_ENV, root)
                // The debug-build configuration path exceeds libtest's
                // default worker stack; callers can still request a larger one.
                .env(
                    "RUST_MIN_STACK",
                    std::env::var_os("RUST_MIN_STACK").unwrap_or_else(|| "16777216".into()),
                )
                .env("HOME", &home)
                .env("XDG_CONFIG_HOME", &xdg_config)
                .env("KCODER_CONFIG_DIR", &config_dir)
                .env("KCODER_HOME", &kcoder_home)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "isolated permission baseline test child timed out"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "isolated permission baseline test failed: {status}"
        );
    }

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

    pub fn configured_factory(
        cwd: &std::path::Path,
        config_dir: &std::path::Path,
        settings_path: &std::path::Path,
        cli_settings_file: Option<&std::path::Path>,
    ) -> AppServerEngineFactory {
        let mut cli = crate::Cli::parse_from(["kcoder"]);
        if let Some(path) = cli_settings_file {
            cli.settings_files.push(path.to_path_buf());
        }
        let loader = kcoder_config::SettingsLoader::new(cwd)
            .with_config_dir(config_dir)
            .with_executable_dir(cwd)
            .with_overlay_files(cli.settings_files.clone());
        let mut factory = factory(cwd);
        factory.history_directory = Some(cwd.join("history"));
        factory.settings_persistence_path = Some(settings_path.to_path_buf());
        // Keep every persisted thread artifact within an owned private directory.
        let owner = Arc::new(
            kcoder_config::create_private_temp_dir("kcoder-execution-default-test").unwrap(),
        );
        factory.workspace_services = WorkspaceRuntimeServices::new(cwd, "execution-default-test")
            .with_private_client_storage(owner);
        factory
            .with_session_configuration(loader, cli, false)
            .unwrap()
    }

    fn write_execution_settings(path: &std::path::Path, permission_mode: &str) {
        std::fs::write(
            path,
            serde_json::to_vec(&serde_json::json!({
                "active_provider": "fixture",
                "model": "fixture-model",
                "permission_mode": permission_mode,
                "history_enabled": true,
                "providers": {
                    "fixture": {
                        "api_format": "openai_chat_completions",
                        "endpoint": "http://127.0.0.1:1/v1",
                        "default_model": "fixture-model",
                        "context_window_tokens": 128000,
                        "output_headroom_tokens": 8192,
                        "max_output_tokens": 8192,
                        "request_timeout_secs": 30,
                        "authentication": {"mode": "none"},
                        "no_proxy": true,
                        "extra_body": {}
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
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
        source_factory.base_settings.tools.studio.kcoder = Some(vec!["Read".into()]);
        source_factory.base_settings.tools.studio.kworker = Some(vec![]);
        let source = source_factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        source
            .state
            .set_model_selection(
                kcoder_types::ModelSelectionMode::Explicit,
                Some("profile-with-shared-model::chosen-model".into()),
            )
            .unwrap();
        source.state.bind_agent_definition(serde_json::from_value(serde_json::json!({
            "owner":{"accountId":"owner","targetId":"target","workspaceId":null,"organizationId":null},
            "definition":{"id":"expert","version":"1","definitionSha256":"a".repeat(64)},
            "title":"Pinned expert","source":"expert","sourceId":null
        })).unwrap()).unwrap();
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
        assert_eq!(
            ephemeral.state.agent_definition(),
            source.state.agent_definition()
        );
        assert_eq!(
            ephemeral.state.studio_tool_selection(),
            source.state.studio_tool_selection()
        );
        assert_eq!(
            ephemeral.state.selected_model(),
            source.state.selected_model()
        );
        assert_eq!(
            ephemeral.state.model_selection_mode(),
            source.state.model_selection_mode()
        );
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

    #[tokio::test]
    async fn creation_fork_and_resume_use_creation_permission_baselines_and_layer_priority() {
        if let Some(root) = std::env::var_os(PERMISSION_BASELINE_TEST_ROOT_ENV) {
            let root = std::path::PathBuf::from(root);
            for (name, path) in [
                ("HOME", std::env::var_os("HOME")),
                ("XDG_CONFIG_HOME", std::env::var_os("XDG_CONFIG_HOME")),
                ("KCODER_CONFIG_DIR", std::env::var_os("KCODER_CONFIG_DIR")),
                ("KCODER_HOME", std::env::var_os("KCODER_HOME")),
            ] {
                let path = path.unwrap_or_else(|| panic!("{name} is unset in isolated child"));
                assert!(
                    std::path::Path::new(&path).starts_with(&root),
                    "{name} must resolve inside the isolated child root"
                );
            }
        } else {
            run_permission_baseline_test_in_isolated_child();
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let config_dir = temp.path().join("config");
        let history_dir = cwd.join("history");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        let settings_path = config_dir.join("settings.json");
        write_execution_settings(&settings_path, "ask");

        let factory = configured_factory(&cwd, &config_dir, &settings_path, None);
        let source = factory
            .create_fresh_thread_with_template(None, Arc::new(DenyAllUserQuestioner))
            .await
            .unwrap();
        assert_eq!(
            source.settings.read().unwrap().permission_mode,
            PermissionMode::Ask
        );
        super::super::record_thread_permission_mode_at_creation(&source, PermissionMode::Ask)
            .unwrap();
        source
            .state
            .add_message(Message::user_text("baseline history"));
        source.state.save_history().unwrap();
        let source_id = source.session_id();
        let source_history = source.state.history_path().unwrap();
        let source_baseline =
            super::super::recorded_thread_permission_mode_at_creation(&source, &source_id).unwrap();
        assert_eq!(source_baseline, Some(PermissionMode::Ask));

        // The durable fork records the effective policy of its source engine.
        let fork_state = kcoder_state::AppState::new(&cwd);
        let fork_id = fork_state.session_id();
        let fork_history = history_dir.join(format!("{fork_id}.jsonl"));
        fork_state.with_history_path(&fork_history);
        fork_state.set_messages(source.state.messages());
        fork_state.save_history().unwrap();
        let fork_permission_mode =
            super::super::thread_restore_requests::fork_permission_mode_at_creation(&source)
                .unwrap();
        super::super::record_thread_permission_mode_for_thread(
            &source,
            &fork_id,
            fork_permission_mode,
        )
        .unwrap();
        assert_eq!(
            super::super::recorded_thread_permission_mode_at_creation(&source, &fork_id).unwrap(),
            Some(PermissionMode::Ask)
        );

        write_execution_settings(&settings_path, "bypass");
        let new_thread = factory
            .create_fresh_thread_with_template(None, Arc::new(DenyAllUserQuestioner))
            .await
            .unwrap();
        assert_eq!(
            new_thread.settings.read().unwrap().permission_mode,
            PermissionMode::Bypass,
            "changing the target default applies to newly created conversations"
        );
        super::super::record_thread_permission_mode_at_creation(
            &new_thread,
            PermissionMode::Bypass,
        )
        .unwrap();
        assert_eq!(
            super::super::recorded_thread_permission_mode_at_creation(
                &new_thread,
                &new_thread.session_id()
            )
            .unwrap(),
            Some(PermissionMode::Bypass)
        );

        let source_prepared = kcoder_state::prepare_session_resume(&source_history).unwrap();
        let (resumed_source, _) = factory
            .resume_fresh_thread_with_template(
                None,
                source_baseline,
                source_prepared,
                Arc::new(DenyAllUserQuestioner),
            )
            .await
            .unwrap();
        assert_eq!(
            resumed_source.settings.read().unwrap().permission_mode,
            PermissionMode::Ask,
            "a persisted baseline survives a target-default change"
        );

        let fork_prepared = kcoder_state::prepare_session_resume(&fork_history).unwrap();
        let (resumed_fork, _) = factory
            .resume_fresh_thread_with_template(
                None,
                Some(PermissionMode::Ask),
                fork_prepared,
                Arc::new(DenyAllUserQuestioner),
            )
            .await
            .unwrap();
        assert_eq!(
            resumed_fork.settings.read().unwrap().permission_mode,
            PermissionMode::Ask,
            "a fork uses the source conversation's permission baseline"
        );

        let template_path = temp.path().join("permission-template.json");
        std::fs::write(&template_path, r#"{"permission_mode":"auto"}"#).unwrap();
        let template_prepared = kcoder_state::prepare_session_resume(&source_history).unwrap();
        let (templated_resume, _) = factory
            .resume_fresh_thread_with_template(
                Some(template_path),
                source_baseline,
                template_prepared,
                Arc::new(DenyAllUserQuestioner),
            )
            .await
            .unwrap();
        assert_eq!(
            templated_resume.settings.read().unwrap().permission_mode,
            PermissionMode::Auto,
            "an explicit template permission mode takes precedence over the baseline"
        );

        let cli_overlay = temp.path().join("cli-settings.json");
        std::fs::write(&cli_overlay, r#"{"permission_mode":"yolo"}"#).unwrap();
        let cli_factory = configured_factory(&cwd, &config_dir, &settings_path, Some(&cli_overlay));
        let cli_prepared = kcoder_state::prepare_session_resume(&source_history).unwrap();
        let (cli_resume, _) = cli_factory
            .resume_fresh_thread_with_template(
                Some(temp.path().join("permission-template.json")),
                source_baseline,
                cli_prepared,
                Arc::new(DenyAllUserQuestioner),
            )
            .await
            .unwrap();
        assert_eq!(
            cli_resume.settings.read().unwrap().permission_mode,
            PermissionMode::Yolo,
            "an explicit CLI settings file takes precedence over template and baseline"
        );

        // A busy metadata publisher must not save only one half of the creation policy.
        let candidate = factory
            .create_fresh_thread_with_template(None, Arc::new(DenyAllUserQuestioner))
            .await
            .unwrap();
        super::super::record_thread_permission_mode_at_creation(&candidate, PermissionMode::Ask)
            .unwrap();
        let candidate_id = candidate.session_id();
        let metadata_path = super::super::thread_metadata_path(&candidate, &candidate_id).unwrap();
        let before = std::fs::read(&metadata_path).unwrap();
        let binding = kcoder_app_protocol::SettingsTemplateBinding {
            id: "fixture-template".into(),
            revision_sha256: "a".repeat(64),
        };
        let fence = kcoder_state::history_index::journal::JournalFence::try_acquire(
            &candidate.client_storage_root(),
            kcoder_state::history_index::journal::JournalDomain::ClientMetadata,
        )
        .unwrap();
        assert!(
            super::super::record_thread_creation_configuration(
                &candidate,
                &candidate_id,
                PermissionMode::Auto,
                Some(&binding),
            )
            .is_err()
        );
        drop(fence);
        assert_eq!(std::fs::read(&metadata_path).unwrap(), before);
        super::super::record_thread_creation_configuration(
            &candidate,
            &candidate_id,
            PermissionMode::Auto,
            Some(&binding),
        )
        .unwrap();
        assert_eq!(
            super::super::recorded_thread_permission_mode_at_creation(&candidate, &candidate_id,)
                .unwrap(),
            Some(PermissionMode::Auto)
        );
        assert_eq!(
            super::super::checked_recorded_settings_template_binding(&candidate, &candidate_id,)
                .unwrap(),
            Some(binding)
        );
    }

    #[test]
    fn unactivated_candidate_does_not_persist_an_empty_session_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let history_directory = temp.path().join("history");
        let mut factory = factory(temp.path());
        factory.base_settings.history_enabled = true;
        factory.base_settings.tools.studio.kcoder = Some(vec!["Read".into()]);
        let expected_selection = factory.base_settings.tools.studio.clone();
        factory.history_directory = Some(history_directory);

        let candidate = factory
            .create_new_thread(Arc::new(DenyAllUserQuestioner))
            .unwrap();
        let sidecar = candidate.state.session_state_path().unwrap();
        assert_eq!(
            candidate.state.studio_tool_selection(),
            Some(expected_selection.clone())
        );
        assert!(!sidecar.exists());

        candidate.activate_client_session();
        assert!(sidecar.exists());
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(sidecar).unwrap()).unwrap();
        assert_eq!(
            persisted["studio_tool_selection"],
            serde_json::to_value(expected_selection).unwrap()
        );
    }
}
