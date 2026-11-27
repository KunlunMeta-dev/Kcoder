use super::*;
use kcoder_types::{migration_agent::ImportedAgentExecution, plugin_prompt::PluginPromptPolicy};
#[test]
fn persisted_mapping_restores_without_parent_fallback_and_rejects_redefinition() {
    let mut task = kcoder_state::Task::new("child", "review");
    task.plugin_prompt_policy = Some(PluginPromptPolicy {
        native_model_revision: None,
        imported_agent: Some(ImportedAgentExecution {
            adapter_revision: "static-agent/v1".into(),
            source_sha256: "a".repeat(64),
            model: ImportedAgentModel::Target {
                provider: "target".into(),
                model: "review-model".into(),
            },
        }),
        allowed_tools: Some(vec!["read".into()]),
        max_turns: Some(3),
    });
    let mut options = AgentRunOptions::default();
    let mut settings = Settings::default();
    let mut provider = kcoder_config::default_active_provider_config();
    provider.default_model = "review-model".into();
    provider.models.clear();
    task.plugin_prompt_policy
        .as_mut()
        .unwrap()
        .native_model_revision = Some(provider.runtime_configuration_revision().unwrap());
    settings.providers.insert("target".into(), provider);
    restore(&task, &mut options, &settings).unwrap();
    assert_eq!(
        options.runtime_selection.as_ref().unwrap().model.as_deref(),
        Some("review-model")
    );
    options.runtime_selection.as_mut().unwrap().provider = Some("different-parent".into());
    assert!(restore(&task, &mut options, &settings).is_err());
}

#[tokio::test]
async fn imported_agent_actual_runner_keeps_model_and_tools_on_restored_continuation() {
    use std::sync::Mutex;
    struct Source(Arc<dyn Provider>);
    impl crate::ClientModelConfiguration for Source {
        fn settings(&self, _: &str) -> anyhow::Result<Settings> {
            unreachable!()
        }
        fn provider(&self, settings: &Settings) -> anyhow::Result<Arc<dyn Provider>> {
            assert_eq!(settings.active_provider.as_deref(), Some("mapped-provider"));
            assert_eq!(settings.model, "mapped-model");
            Ok(self.0.clone())
        }
    }
    let root = tempfile::tempdir().unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&root.path().join("test-config")).unwrap();
    let parent_requests = Arc::new(Mutex::new(Vec::new()));
    let child_requests = Arc::new(Mutex::new(Vec::new()));
    let parent = Arc::new(crate::test_support::providers::RequestRecordingProvider {
        requests: parent_requests.clone(),
    });
    let child = Arc::new(crate::test_support::providers::TextDraftProvider {
        text: "reviewed".into(),
        requests: child_requests.clone(),
        delay: None,
    });
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .provider(parent)
        .tool_registry(
            ToolRegistry::new()
                .register(kcoder_tools::FileReadTool)
                .register(kcoder_tools::FileWriteTool),
        )
        .build_with_profile_directory()
        .with_client_model_configuration(Arc::new(Source(child)));
    engine
        .state
        .with_history_path(root.path().join("session.jsonl"));
    let mut provider = kcoder_config::default_active_provider_config();
    provider.default_model = "mapped-model".into();
    provider.models.clear();
    provider.context_window_tokens = 32000;
    provider.output_headroom_tokens = 2048;
    provider.max_output_tokens = 2048;
    let revision = provider.runtime_configuration_revision().unwrap();
    engine
        .settings
        .write()
        .unwrap()
        .providers
        .insert("mapped-provider".into(), provider);
    *engine.last_cache_safe_params.write().unwrap() = Some(
        CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            context_history_anchor: None,
            full_context_compatible: true,
        }
        .into(),
    );
    let mut task = kcoder_state::Task::new("review-child", "review");
    task.arrangement_mode = Some(false);
    task.kind = kcoder_state::TaskKind::Subagent;
    task.plugin_prompt_policy = Some(PluginPromptPolicy {
        native_model_revision: Some(revision),
        imported_agent: Some(ImportedAgentExecution {
            adapter_revision: "static-agent/v1".into(),
            source_sha256: "b".repeat(64),
            model: ImportedAgentModel::Target {
                provider: "mapped-provider".into(),
                model: "mapped-model".into(),
            },
        }),
        allowed_tools: Some(vec!["read".into()]),
        max_turns: Some(3),
    });
    engine.state.upsert_task(task);
    let runner = QueryEngineAgentRunner::new(engine.clone());
    let options = AgentRunOptions {
        context_mode: SubagentContextMode::None,
        ..Default::default()
    };
    runner
        .run_agent_session_with_options(
            "review-child".into(),
            "Review only.".into(),
            1,
            AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap();
    let restored: kcoder_state::Task = serde_json::from_slice(
        &serde_json::to_vec(&engine.state.task("review-child").unwrap()).unwrap(),
    )
    .unwrap();
    engine.state.upsert_task(restored);
    engine.settings.write().unwrap().model = "different-parent-model".into();
    runner
        .send_message_to_agent_with_options(
            "review-child".into(),
            "Continue reviewing.".into(),
            1,
            AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap();
    assert!(parent_requests.lock().unwrap().is_empty());
    {
        let requests = child_requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert_eq!(request.model, "mapped-model");
            assert_eq!(
                request
                    .tools
                    .iter()
                    .map(|tool| tool.name.as_str())
                    .collect::<Vec<_>>(),
                vec!["read"]
            );
        }
    }

    engine
        .settings
        .write()
        .unwrap()
        .providers
        .get_mut("mapped-provider")
        .unwrap()
        .endpoint
        .push_str("/changed");
    assert!(
        runner
            .send_message_to_agent_with_options(
                "review-child".into(),
                "Must fail.".into(),
                1,
                AgentKind::General,
                options
            )
            .await
            .is_err()
    );
    assert_eq!(child_requests.lock().unwrap().len(), 2);
}
