//! Capture the original interactive host's factory without creating another Engine.
use super::*;

impl AppServerEngineFactory {
    /// The actual cold owner supplies the held original artifact root. Never
    /// rehome an existing TUI/Native session into the bootstrap's storage.
    pub async fn resume_cold_peer_target(
        &self,
        artifact_root: &std::path::Path,
        artifact_identity: &str,
        template: Option<std::path::PathBuf>,
        permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
        prepared: kcoder_state::PreparedSessionResume,
        questioner: Arc<dyn UserQuestioner>,
    ) -> Result<(QueryEngine, usize, kcoder_state::AppStateLifecycleIdentity)> {
        let mut factory = self.clone();
        factory.workspace_services = self
            .workspace_services
            .with_existing_client_storage(artifact_root, artifact_identity)?;
        factory
            .resume_fresh_thread_with_template_and_lifecycle(
                template,
                permission_mode_at_creation,
                prepared,
                questioner,
            )
            .await
    }

    pub fn from_interactive_peer_owner(
        engine: &QueryEngine,
        loader: kcoder_config::SettingsLoader,
        cli: crate::Cli,
        folder_trusted: bool,
        mcp_snapshot_complete: bool,
        paths: &kcoder_config::ConfigPaths,
        #[cfg(not(test))] native_engine_installer: fn(QueryEngine) -> Result<QueryEngine>,
    ) -> Result<Self> {
        anyhow::ensure!(
            engine.is_independent_discovery_session(),
            "peer_factory_independent_owner_required"
        );
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("peer_factory_settings_busy"))?
            .clone();
        let permissions = engine
            .permissions
            .read()
            .map_err(|_| anyhow::anyhow!("peer_factory_permissions_busy"))?
            .clone();
        let skills = engine
            .skill_registry
            .read()
            .map_err(|_| anyhow::anyhow!("peer_factory_skills_busy"))?
            .clone();
        Self::new(
            engine.current_provider(),
            engine.active_tool_registry().clone(),
            permissions,
            settings,
            engine.memory_manager.as_ref().clone(),
            skills,
            engine.plugin_snapshot().as_ref().clone(),
            engine.state.cwd(),
            engine
                .state
                .history_path()
                .and_then(|path| path.parent().map(std::path::Path::to_owned)),
            folder_trusted,
            engine.workspace_runtime_services(),
            Some(paths.user_settings.clone()),
            paths.config_dir.join("session-ids"),
            #[cfg(not(test))]
            native_engine_installer,
        )
        .with_session_configuration(loader, cli, mcp_snapshot_complete)
    }
}
