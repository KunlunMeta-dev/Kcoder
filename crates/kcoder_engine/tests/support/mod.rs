//! Shared assembly for the KWorker built-in tool-policy integration tests.
//!
//! These tests assert the *assembled* tool set through the public engine API, so the
//! provider is never called: a policy test must not depend on model traffic.

use std::path::Path;
use std::sync::Arc;

use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::Settings;
use kcoder_engine::QueryEngine;
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
use kcoder_types::{ClientPresentationV1, MessagesRequest, StudioWorkMode};

/// Provider that fails loudly if a tool-policy test ever requests a model turn.
pub struct UnusedProvider;

impl Provider for UnusedProvider {
    fn name(&self) -> &'static str {
        "unused-policy-test-provider"
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        Err(ApiErrorKind::Api {
            error_type: "unused_provider".to_string(),
            message: "a KWorker tool-policy test must not start a model turn".to_string(),
        })
    }
}

pub fn engine(cwd: &Path, settings: Settings, tools: ToolRegistry) -> QueryEngine {
    let skill_registry = SkillRegistry::load_project_only(cwd).expect("project skill registry");
    QueryEngine::new_with_folder_trust(
        Arc::new(UnusedProvider),
        AppState::new(cwd),
        tools,
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        skill_registry,
        Arc::new(DenyAllUserQuestioner),
        cwd.to_path_buf(),
        None,
    )
}

/// A Studio turn that presents itself as KWorker without visualizations.
pub fn kworker_presentation() -> Option<ClientPresentationV1> {
    Some(ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(StudioWorkMode::Kworker),
        inline_widgets: false,
        isolated_widgets: false,
    })
}
