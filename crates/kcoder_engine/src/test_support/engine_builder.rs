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
    plugin_snapshot: Option<kcoder_plugins::EffectivePluginSnapshot>,
    owned_test_fixture: bool,
    fixture_context_limits: bool,
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
            plugin_snapshot: None,
            owned_test_fixture: false,
            fixture_context_limits: true,
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

    /// Restrict a fixture to its owned child process and disable ancestor discovery.
    /// Keep unset context limits unset. By default the builder supplies the
    /// limits real turns require, because fresh installations ship an empty
    /// Provider catalog and default settings carry no active profile's limits.
    pub(crate) fn without_fixture_context_limits(mut self) -> Self {
        self.fixture_context_limits = false;
        self
    }

    pub(crate) fn owned_test_fixture(mut self) -> Self {
        super::owned_case::prepare_workspace(self.cwd);
        self.skill_registry = Some(SkillRegistry::empty());
        self.plugin_snapshot = Some(kcoder_plugins::EffectivePluginSnapshot::default());
        self.folder_trusted = Some(false);
        self.owned_test_fixture = true;
        self
    }

    /// Prepare the owned settings directory for fixtures exercising persisted turns.
    /// Native settings content still requires explicit native-profile initialization.
    pub(crate) fn build_with_profile_directory(self) -> QueryEngine {
        let engine = self.build();
        kcoder_config::PrivateDirectory::open_existing(&engine.cwd)
            .expect("test workspace must exist")
            .open_child(std::ffi::OsStr::new("test-config"), true)
            .expect("prepare the explicitly requested fixture profile directory");
        engine
    }

    pub(crate) fn build(self) -> QueryEngine {
        let mut settings = self.settings.unwrap_or_default();
        if self.fixture_context_limits {
            settings.context_window_tokens.get_or_insert(1_048_576);
            settings.context_output_headroom.get_or_insert(100_000);
        }
        let provider = self.provider.unwrap_or_else(|| Arc::new(EmptyProvider));
        let memory_manager = self
            .memory_manager
            .unwrap_or_else(|| MemoryManager::global_only(MemoryStore::empty()));
        let tool_registry = self.tool_registry.unwrap_or_default();
        let skill_registry = self
            .skill_registry
            .unwrap_or_else(|| SkillRegistry::load_project_only(self.cwd).unwrap());
        // These input/side-question fixtures do not exercise scheduled jobs,
        // provider prewarming, or shell snapshots. Avoid spawning unrelated
        // background processes that could outlive the owned test child.
        let workspace_services = self
            .owned_test_fixture
            .then(|| crate::WorkspaceRuntimeServices {
                web_search_runtime: Arc::new(kcoder_tools::web_search::WebSearchRuntime::new()),
                diagnostic_writer: Default::default(),
                cron_scheduler: Arc::new(crate::CronScheduler::load(self.cwd)),
                shell_environment_snapshot: Default::default(),
                provider_prewarmed: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                model_health: Default::default(),
                client_storage: None,
            });

        QueryEngine::new_with_folder_trust_and_project_skill_telemetry(
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
            self.plugin_snapshot,
            crate::WorkspacePersistenceMode::Interactive,
            workspace_services,
            true,
        )
        .with_settings_persistence_path(self.cwd.join("test-config/settings.json"))
    }
}

/// Settings for engine tests that run real turns.
///
/// Fresh installations ship an empty Provider catalog, while turn admission
/// and context budgeting require the active profile's context facts. Tests
/// supply those limits explicitly instead of relying on a built-in profile.
pub(crate) fn fixture_settings() -> Settings {
    Settings {
        context_window_tokens: Some(1_048_576),
        context_output_headroom: Some(100_000),
        ..Settings::default()
    }
}

/// Settings with an explicit legacy Provider fixture for catalog tests.
pub(crate) fn fixture_settings_with_default_provider() -> Settings {
    const FIXTURE_PROVIDER: &str = "kunlunmeta";
    let mut settings = Settings::default();
    let provider_id = "fixture-provider".to_string();
    settings.providers.insert(
        provider_id.clone(),
        kcoder_config::default_active_provider_config(),
    );
    settings.active_provider = Some(provider_id);
    settings
        .apply_provider(None)
        .expect("fixture Provider profile must apply");
    settings
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
        .build_with_profile_directory()
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
        .build_with_profile_directory()
}

pub(crate) fn settings_using_main_summary_runtime(mut settings: Settings) -> Settings {
    settings.summary_profile = None;
    settings.summary_provider = None;
    settings.summary_model = None;
    settings
}

/// Explicit fixture opt-in for consumers that exercise native profile capture.
/// Ordinary builders keep their original no-profile-write behavior.
pub(crate) fn initialize_owned_native_profile(engine: &QueryEngine) -> anyhow::Result<()> {
    let expected = engine.cwd.join("test-config/settings.json");
    anyhow::ensure!(
        engine.settings_persistence_path().as_ref() == Some(&expected),
        "native fixture profile must stay in its owned workspace"
    );
    let root = kcoder_config::PrivateDirectory::open_existing(&engine.cwd)?;
    let directory = match root.open_child(std::ffi::OsStr::new("test-config"), false) {
        Ok(directory) => directory,
        Err(_) => root.create_private_child(std::ffi::OsStr::new("test-config"))?,
    };
    let settings = crate::recover_read_lock(&engine.settings, "settings");
    let bytes = serde_json::to_vec_pretty(&*settings)?;
    directory.atomic_replace(std::ffi::OsStr::new("settings.json"), &bytes)?;
    Ok(())
}

#[test]
fn native_fixture_profile_is_explicit_and_uses_the_actual_fixture_settings() {
    let temp = tempfile::tempdir().unwrap();
    let settings = Settings {
        model: "owned-native-fixture-model".into(),
        training_mode: true,
        ..Settings::default()
    };
    let engine = TestEngineBuilder::new(temp.path())
        .settings(settings)
        .build();
    assert!(!temp.path().join("test-config").exists());
    initialize_owned_native_profile(&engine).unwrap();
    let root = kcoder_config::PrivateDirectory::open_existing(temp.path()).unwrap();
    let directory = root
        .open_child(std::ffi::OsStr::new("test-config"), false)
        .unwrap();
    let file = directory
        .open_single_link_regular_file(std::ffi::OsStr::new("settings.json"))
        .unwrap();
    let value: serde_json::Value = serde_json::from_reader(file).unwrap();
    assert_eq!(value["model"], "owned-native-fixture-model");
}

#[cfg(unix)]
#[test]
fn native_fixture_profile_rejects_an_existing_symlink_without_touching_its_target() {
    let temp = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path()).build();
    std::os::unix::fs::symlink(peer.path(), temp.path().join("test-config")).unwrap();
    assert!(initialize_owned_native_profile(&engine).is_err());
    assert!(std::fs::read_dir(peer.path()).unwrap().next().is_none());
}
