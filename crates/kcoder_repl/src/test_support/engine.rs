use super::EmptyProvider;
use crate::{
    APP_EVENT_CHANNEL_CAPACITY, AppEvent, AppEventSender, ReplApp, TuiPermissionPrompt, UserAction,
    handle_app_event, handle_user_action,
};
use kcoder_config::{PermissionMode, Settings};
use kcoder_engine::QueryEngine;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// Fresh installations ship an empty Provider catalog, so a test engine
/// declares its own KunlunMeta fixture profile and activates it through the
/// normal `apply_provider` path. Turn admission and context budgeting then see
/// the limits a real Provider would supply.
pub(crate) fn fixture_settings() -> Settings {
    with_fixture_context_limits(Settings::default())
}

fn with_fixture_context_limits(mut settings: Settings) -> Settings {
    if settings.providers.is_empty() {
        settings.providers.insert(
            kcoder_config::DEFAULT_ACTIVE_PROVIDER.to_string(),
            kcoder_config::default_active_provider_config(),
        );
        if settings.active_provider.is_none() {
            settings.active_provider = Some(kcoder_config::DEFAULT_ACTIVE_PROVIDER.to_string());
        }
        settings
            .apply_provider(None)
            .expect("fixture Provider profile must apply");
    }
    settings.context_window_tokens.get_or_insert(1_048_576);
    settings.context_output_headroom.get_or_insert(100_000);
    settings
}

pub(crate) fn test_engine(cwd: &Path) -> QueryEngine {
    let settings = Settings {
        summary_provider: None,
        summary_model: None,
        ..Settings::default()
    };
    QueryEngine::new_with_folder_trust(
        Arc::new(EmptyProvider),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        with_fixture_context_limits(settings),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::load(cwd).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
    )
    .with_settings_persistence_path(cwd.join("test-config/settings.json"))
}

pub(crate) fn test_engine_with_settings(cwd: &Path, settings: Settings) -> QueryEngine {
    QueryEngine::new_with_folder_trust(
        Arc::new(EmptyProvider),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        with_fixture_context_limits(settings),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::load(cwd).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
    )
    .with_settings_persistence_path(cwd.join("test-config/settings.json"))
}

pub(crate) fn test_engine_with_provider(
    cwd: &Path,
    provider: Arc<dyn kcoder_api::Provider>,
) -> QueryEngine {
    kcoder_config::PrivateDirectory::open_existing(cwd)
        .unwrap()
        .open_child(std::ffi::OsStr::new("test-config"), true)
        .unwrap();
    let settings = Settings {
        summary_provider: None,
        summary_model: None,
        ..Settings::default()
    };
    QueryEngine::new(
        provider,
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        with_fixture_context_limits(settings),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::load(cwd).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
    )
    .with_settings_persistence_path(cwd.join("test-config/settings.json"))
}

/// Assemble an owned test engine without discovering ancestors or personal skills.
pub(crate) fn test_engine_with_isolated_provider(
    cwd: &Path,
    provider: Arc<dyn kcoder_api::Provider>,
) -> QueryEngine {
    crate::isolated_test_profile::require_isolated_profile().expect("private test profile");
    let root = std::fs::canonicalize(std::env::temp_dir()).expect("private test temp root");
    let canonical_workspace = std::fs::canonicalize(cwd).expect("test workspace");
    assert!(
        canonical_workspace.starts_with(&root) && canonical_workspace != root,
        "workspace must belong to this test"
    );
    let workspace = cwd.to_path_buf();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o700))
            .expect("secure owned workspace");
    }
    let directory = kcoder_config::PrivateDirectory::open_existing(&workspace).unwrap();
    directory.verify_private_directory().unwrap();
    directory
        .open_child(std::ffi::OsStr::new("test-config"), true)
        .unwrap();
    std::fs::create_dir_all(workspace.join(".kcoder/skills")).expect("owned local skills root");
    std::fs::create_dir_all(workspace.join(".kcoder/specs")).expect("owned local specs root");
    std::fs::write(
        workspace.join(".kcoder/specs/config.yaml"),
        "schema: kcoder-spec-driven-superpowers\n",
    )
    .expect("owned local specs configuration");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(workspace.join("AGENTS.md"))
        .expect("owned local instruction boundary");
    let settings = Settings {
        summary_provider: None,
        summary_model: None,
        ..Settings::default()
    };
    QueryEngine::new_with_plugin_snapshot(
        provider,
        kcoder_state::AppState::new(&workspace),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        with_fixture_context_limits(settings),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::default(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
    )
    .with_settings_persistence_path(workspace.join("test-config/settings.json"))
}

pub(crate) fn test_engine_with_default_tools(cwd: &Path) -> QueryEngine {
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        ..Settings::default()
    };
    QueryEngine::new(
        Arc::new(EmptyProvider),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::default_registry(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        with_fixture_context_limits(settings),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::load(cwd).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
    )
    .with_settings_persistence_path(cwd.join("test-config/settings.json"))
}

pub(crate) async fn run_foreground_action_to_completion(
    action: UserAction,
    engine: &QueryEngine,
    app: &mut ReplApp,
) {
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    assert!(
        !handle_user_action(action, engine, app, &tx, &prompt)
            .await
            .unwrap()
    );

    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("foreground action should produce a terminal event")
            .expect("foreground action event channel should remain open");
        let finished = matches!(
            event,
            AppEvent::TurnFinished | AppEvent::TurnFinishedWithSteering { .. }
        );
        let handled = handle_app_event(event, app, engine, &tx, &prompt).await;
        if let Some(action) = handled.action {
            assert!(
                !handle_user_action(action, engine, app, &tx, &prompt)
                    .await
                    .unwrap()
            );
        }
        if finished {
            break;
        }
    }
}
