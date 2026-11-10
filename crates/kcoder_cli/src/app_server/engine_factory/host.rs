//! Host ownership around the independently compiled concrete Engine factory.
use anyhow::Result;
use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_engine::{QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::MemoryManager;
use kcoder_permissions::PermissionEngine;
use kcoder_plugins::EffectivePluginSnapshot;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{ToolRegistry, UserQuestioner};
use std::{
    ops::{Deref, DerefMut},
    path::PathBuf,
    sync::Arc,
};

pub(super) use kcoder_engine_factory::app_server::engine_factory::web_search;

#[derive(Clone)]
pub(crate) struct AppServerEngineFactory(kcoder_engine_factory::AppServerEngineFactory);

impl Deref for AppServerEngineFactory {
    type Target = kcoder_engine_factory::AppServerEngineFactory;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for AppServerEngineFactory {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl AppServerEngineFactory {
    pub(crate) fn with_owned_command_program(self, program: Option<PathBuf>) -> Self {
        Self(self.0.with_owned_command_program(program))
    }

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
        Self(kcoder_engine_factory::AppServerEngineFactory::new(
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
            install_native_engine,
        ))
    }
    pub(crate) fn with_session_configuration(
        self,
        loader: kcoder_config::SettingsLoader,
        cli: crate::Cli,
        mcp_snapshot_complete: bool,
    ) -> Result<Self> {
        self.0
            .with_session_configuration(loader, cli, mcp_snapshot_complete)
            .map(Self)
    }
    pub(crate) fn with_settings_template(&self, path: PathBuf) -> Self {
        Self(self.0.with_settings_template(path))
    }
    pub(crate) fn for_native_application(
        &self,
        origin: &QueryEngine,
        settings: Settings,
        tools: ToolRegistry,
    ) -> Result<Self> {
        self.0
            .for_native_application(origin, settings, tools)
            .map(Self)
    }
    pub(crate) fn for_native_input_only(
        &self,
        origin: &QueryEngine,
        settings: Settings,
    ) -> Result<Self> {
        self.0.for_native_input_only(origin, settings).map(Self)
    }
    // Keep inherent method resolution ahead of the MigrationHost trait methods.
    pub(crate) fn migration_source_roots(
        &self,
    ) -> Result<kcoder_migration::discovery::DiscoveryRoots> {
        self.0.migration_source_roots()
    }
    pub(crate) fn hook_user_settings_path(&self) -> Result<PathBuf> {
        self.0.hook_user_settings_path()
    }
    pub(crate) fn migration_user_settings_path(&self) -> Result<PathBuf> {
        self.0.migration_user_settings_path()
    }
    pub(crate) fn migration_mcp_settings_path(&self) -> Result<PathBuf> {
        self.0.migration_mcp_settings_path()
    }
    pub(crate) fn migration_project_settings_path(&self, fields: &[&str]) -> Result<PathBuf> {
        self.0.migration_project_settings_path(fields)
    }
    pub(crate) fn migration_project_target_context(&self) -> (PathBuf, Option<PathBuf>) {
        self.0.migration_project_target_context()
    }
    pub(crate) fn current_settings(&self) -> Result<Settings> {
        self.0.current_settings()
    }
    pub(crate) fn current_skills(&self) -> Result<SkillRegistry> {
        self.0.current_skills()
    }
    pub(crate) fn continuation_workspace(&self) -> &std::path::Path {
        self.0.continuation_workspace()
    }
    pub(crate) fn continuation_source(
        &self,
        thread_id: &str,
    ) -> Result<Option<kcoder_types::historical_continuation::HistoricalContinuationSource>> {
        self.0.continuation_source(thread_id)
    }
    pub(in crate::app_server) async fn create_task_successor(
        &self,
        boundary: &crate::app_server::thread_runtime::task_boundary::TaskIdleReservation,
        source: &QueryEngine,
        configuration: kcoder_state::TaskSuccessorConfiguration,
        model_snapshot: Option<&serde_json::Value>,
        questioner: Arc<dyn UserQuestioner>,
    ) -> Result<QueryEngine> {
        boundary.verify_configuration_source(source)?;
        self.0
            .create_task_successor_after_source_check(
                source,
                configuration,
                model_snapshot,
                questioner,
            )
            .await
    }
}

#[path = "native_installation.rs"]
mod native_installation;
use native_installation::install_native_engine;
