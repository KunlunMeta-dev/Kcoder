//! An actual selected native provider with no extension or implicit memory side effects.
use super::*;
use anyhow::ensure;

impl AppServerEngineFactory {
    pub fn for_native_application(
        &self,
        origin: &QueryEngine,
        settings: Settings,
        tools: ToolRegistry,
    ) -> Result<Self> {
        let mut next = self.for_native_input_only(origin, settings)?;
        next.tools = tools;
        Ok(next)
    }
    /// Attenuation only. A private Runtime ticket and signed source still own
    /// admission and must install the fresh-state input boundary before startup.
    pub fn for_native_input_only(
        &self,
        origin: &QueryEngine,
        mut settings: Settings,
    ) -> Result<Self> {
        ensure!(
            origin.state.cwd() == self.cwd,
            "NATIVE_INPUT_FACTORY_WORKSPACE_CHANGED"
        );
        settings.integrations.knowledge.memory_center_enabled = false;
        settings.memory.structured_enabled = false;
        settings.session_memory.enabled = false;
        settings.skills.auto_skill_review_enabled = false;
        settings.skills.auto_curator_enabled = false;
        settings.skills.auto_lessons_learned = false;
        let mut next = self.clone();
        next.configuration = None;
        next.provider = origin.current_provider();
        next.tools = ToolRegistry::new();
        next.base_permissions = PermissionEngine::from_settings(&settings);
        next.base_settings = settings;
        next.memory_manager = MemoryManager::global_only(kcoder_memory::MemoryStore::empty());
        next.skill_registry = SkillRegistry::empty();
        next.plugin_snapshot = EffectivePluginSnapshot::default();
        next.skill_catalog_leases = Default::default();
        next.folder_trusted = false;
        next.settings_persistence_path = None;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct UnusableReviewedContext;
    impl kcoder_engine::integrations::knowledge::NativeReviewedMemoryTurnContext
        for UnusableReviewedContext
    {
        fn runtime_message(&self, _: &QueryEngine) -> Result<Option<kcoder_types::Message>> {
            panic!("An external sender must never consult the origin's reviewed-memory binding")
        }
        fn snapshot_id(&self) -> Option<&str> {
            Some("origin-private-reviewed-context")
        }
    }
    #[tokio::test]
    async fn native_input_and_application_factories_disable_personal_memory_without_mutating_origin()
    -> Result<()> {
        let owned = tempfile::tempdir()?;
        let mut settings = Settings {
            history_enabled: false,
            ..Default::default()
        };
        settings.memory.structured_enabled = true;
        settings.session_memory.enabled = true;
        settings.integrations.knowledge.memory_center_enabled = true;
        let path = owned.path().join("settings.json");
        let client_storage = Arc::new(kcoder_config::create_private_temp_dir(
            "native-memory-attenuation",
        )?);
        let services = WorkspaceRuntimeServices::new(owned.path(), "native-memory-attenuation")
            .with_private_client_storage(client_storage.clone());
        let factory = AppServerEngineFactory::new(
            Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                crate::tui_dev_mock::TuiDevScenario::FullTurn,
            )),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings.clone(),
            MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            SkillRegistry::empty(),
            EffectivePluginSnapshot::default(),
            owned.path().to_path_buf(),
            None,
            true,
            services,
            Some(path.clone()),
            owned.path().join("session-ids"),
        );
        let origin = factory
            .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?
            .with_native_reviewed_memory_turn_context(Arc::new(UnusableReviewedContext))?;
        assert!(
            origin
                .client_storage_root()
                .starts_with(client_storage.path())
        );
        assert_eq!(
            origin.native_reviewed_memory_snapshot_id(),
            Some("origin-private-reviewed-context")
        );
        for actor in [
            factory.for_native_input_only(&origin, settings.clone())?,
            factory.for_native_application(&origin, settings.clone(), ToolRegistry::new())?,
        ] {
            assert!(!actor.base_settings.memory.structured_enabled);
            assert!(!actor.base_settings.session_memory.enabled);
            assert!(
                !actor
                    .base_settings
                    .integrations
                    .knowledge
                    .memory_center_enabled
            );
            assert!(actor.settings_persistence_path.is_none());
            let engine = actor.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
            assert!(
                !engine
                    .settings
                    .read()
                    .unwrap()
                    .integrations
                    .knowledge
                    .memory_center_enabled
            );
            assert_eq!(engine.native_reviewed_memory_snapshot_id(), None);
        }
        assert!(
            factory
                .base_settings
                .integrations
                .knowledge
                .memory_center_enabled
        );
        assert_eq!(factory.settings_persistence_path, Some(path));
        assert!(
            origin
                .settings
                .read()
                .unwrap()
                .integrations
                .knowledge
                .memory_center_enabled
        );
        assert_eq!(
            origin.native_reviewed_memory_snapshot_id(),
            Some("origin-private-reviewed-context")
        );
        Ok(())
    }
}
