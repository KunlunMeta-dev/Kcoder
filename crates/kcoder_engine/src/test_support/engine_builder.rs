use std::path::Path;
use std::sync::Arc;

use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};

use crate::QueryEngine;

use super::providers::EmptyProvider;

/// Centralize dependency assembly for engine tests so individual tests do not copy production constructor arguments.
pub(crate) struct TestEngineBuilder<'a> {
    cwd: &'a Path,
    provider: Option<Arc<dyn Provider>>,
    settings: Option<Settings>,
    folder_trusted: Option<bool>,
    memory_manager: Option<MemoryManager>,
    tool_registry: Option<ToolRegistry>,
    skill_registry: Option<SkillRegistry>,
}

impl<'a> TestEngineBuilder<'a> {
    pub(crate) fn new(cwd: &'a Path) -> Self {
        Self {
            cwd,
            provider: None,
            settings: None,
            folder_trusted: None,
            memory_manager: None,
            tool_registry: None,
            skill_registry: None,
        }
    }

    pub(crate) fn provider(mut self, provider: Arc<dyn Provider>) -> Self {
        self.provider = Some(provider);
        self
    }

    pub(crate) fn settings(mut self, settings: Settings) -> Self {
        self.settings = Some(settings);
        self
    }

    pub(crate) fn folder_trusted(mut self, folder_trusted: Option<bool>) -> Self {
        self.folder_trusted = folder_trusted;
        self
    }

    pub(crate) fn memory_manager(mut self, memory_manager: MemoryManager) -> Self {
        self.memory_manager = Some(memory_manager);
        self
    }

    pub(crate) fn tool_registry(mut self, tool_registry: ToolRegistry) -> Self {
        self.tool_registry = Some(tool_registry);
        self
    }

    pub(crate) fn skill_registry(mut self, skill_registry: SkillRegistry) -> Self {
        self.skill_registry = Some(skill_registry);
        self
    }

    pub(crate) fn build(self) -> QueryEngine {
        let settings = self.settings.unwrap_or_default();
        let provider = self.provider.unwrap_or_else(|| Arc::new(EmptyProvider));
        let memory_manager = self
            .memory_manager
            .unwrap_or_else(|| MemoryManager::global_only(MemoryStore::empty()));
        let tool_registry = self.tool_registry.unwrap_or_default();
        let skill_registry = self
            .skill_registry
            .unwrap_or_else(|| SkillRegistry::load_project_only(self.cwd).unwrap());

        QueryEngine::new_with_folder_trust(
            provider,
            AppState::new(self.cwd),
            tool_registry,
            PermissionEngine::from_settings(&settings),
            settings,
            memory_manager,
            skill_registry,
            Arc::new(DenyAllUserQuestioner),
            self.cwd.to_path_buf(),
            self.folder_trusted,
        )
        .with_settings_persistence_path(self.cwd.join("test-config/settings.json"))
    }
}

pub(crate) fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
) -> QueryEngine {
    test_engine_with_settings_and_trust(provider, cwd, settings, None)
}

pub(crate) fn test_engine_with_settings_and_trust(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    folder_trusted: Option<bool>,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .folder_trusted(folder_trusted)
        .tool_registry(ToolRegistry::new())
        .skill_registry(SkillRegistry::load_project_only(cwd).unwrap())
        .build()
}

pub(crate) fn test_engine_with_memory_manager(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    memory_manager: MemoryManager,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .memory_manager(memory_manager)
        .build()
}

pub(crate) fn settings_using_main_summary_runtime(mut settings: Settings) -> Settings {
    settings.summary_profile = None;
    settings.summary_provider = None;
    settings.summary_model = None;
    settings
}
