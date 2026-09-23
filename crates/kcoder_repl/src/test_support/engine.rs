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
        settings,
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
        settings,
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
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::load(cwd).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
    )
    .with_settings_persistence_path(cwd.join("test-config/settings.json"))
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
        settings,
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
        let finished = matches!(event, AppEvent::TurnFinished);
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
