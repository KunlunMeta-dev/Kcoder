use super::{AppState, tests::configured_factory};
use anyhow::Result;
use async_trait::async_trait;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput};
use kcoder_types::{MessagesRequest, ModelSelectionMode};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct PreviewProvider;
impl Provider for PreviewProvider {
    fn name(&self) -> &'static str {
        "configuration-preview"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        panic!("configuration preview must not call a model")
    }
}

struct CountedSchema(Arc<AtomicUsize>);
#[async_trait]
impl Tool for CountedSchema {
    fn name(&self) -> String {
        "preview-schema-probe".into()
    }
    fn description(&self) -> String {
        "Never executed by configuration preview".into()
    }
    fn input_schema(&self) -> Value {
        self.0.fetch_add(1, Ordering::SeqCst);
        json!({"type":"object","properties":{}})
    }
    async fn call(&self, _: Value, _: &ToolContext) -> std::result::Result<ToolOutput, ToolError> {
        panic!("configuration preview must not execute tools")
    }
}

#[test]
fn task_model_preview_matches_engine_without_rebuilding_tools_or_persisting_state() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = root.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&profile)?;
    let cwd = root.path().join("workspace");
    std::fs::create_dir(&cwd)?;
    let path = profile.join("settings.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "providers":{"fixture":{
                "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
                "default_model":"target-default", "discover_models":true,
                "context_window_tokens":128000, "output_headroom_tokens":8192,
                "max_output_tokens":8192, "authentication":{"mode":"none"}
            }},
            "active_provider":"fixture", "mcp_servers":[]
        }))?,
    )?;
    let original_settings = std::fs::read(&path)?;
    let mut factory = configured_factory(&cwd, &profile, &path, None);
    factory.provider = Arc::new(PreviewProvider);
    factory.base_settings = factory.current_settings()?;
    let schemas = Arc::new(AtomicUsize::new(0));
    factory.tools = factory
        .tools
        .clone()
        .register(CountedSchema(schemas.clone()));
    for (mode, expected_model) in [
        (ModelSelectionMode::Explicit, "persisted-model"),
        (ModelSelectionMode::FollowTargetDefault, "target-default"),
    ] {
        let state = AppState::new(&cwd);
        state.set_model_selection(mode, Some("fixture::persisted-model".into()))?;
        let history = cwd.join(format!("preview-{expected_model}.jsonl"));
        state.with_deferred_history_path(history.clone());
        let metadata = state.session_state_path().unwrap();
        let mut reference = factory.clone();
        reference.bind_new_tool_selection = false;
        reference.base_settings.tools.studio = state.studio_tool_selection().unwrap_or_default();
        let expected = reference
            .build(state.clone(), Arc::new(kcoder_tools::DenyAllUserQuestioner))?
            .next_turn_model_configuration_summary()?;
        let schemas_before = schemas.load(Ordering::SeqCst);
        assert!(
            schemas_before > 0,
            "the reference Engine must prepare the tool schema"
        );
        for _ in 0..3 {
            let (actual, work_mode) =
                factory.preview_thread_configuration(|_| Ok(state.clone()))?;
            assert_eq!(
                serde_json::to_value(&actual)?,
                serde_json::to_value(&expected)?
            );
            assert_eq!(actual.model_id, expected_model);
            assert_eq!(work_mode, state.studio_work_mode());
        }
        assert_eq!(schemas.load(Ordering::SeqCst), schemas_before);
        assert_eq!(
            state.selected_model().as_deref(),
            Some("fixture::persisted-model")
        );
        assert_eq!(state.model_selection_mode(), mode);
        assert!(!history.exists());
        assert!(!metadata.exists());
    }
    let rejected = AppState::new(&cwd);
    rejected.set_model_selection(
        ModelSelectionMode::Explicit,
        Some("removed-provider::removed-model".into()),
    )?;
    let schemas_before = schemas.load(Ordering::SeqCst);
    assert!(
        factory
            .preview_thread_configuration(|_| Ok(rejected.clone()))
            .is_err()
    );
    assert_eq!(schemas.load(Ordering::SeqCst), schemas_before);
    assert_eq!(
        rejected.selected_model().as_deref(),
        Some("removed-provider::removed-model")
    );
    assert_eq!(std::fs::read(path)?, original_settings);
    Ok(())
}
