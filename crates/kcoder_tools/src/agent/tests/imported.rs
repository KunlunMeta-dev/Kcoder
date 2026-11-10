use super::*;
use kcoder_types::{
    migration_agent::{ImportedAgentExecution, ImportedAgentModel},
    plugin_prompt::PluginPromptProfile,
};

struct Runner(Mutex<Vec<(String, AgentRunOptions)>>);
#[async_trait::async_trait]
impl AgentRunner for Runner {
    async fn run_agent(&self, _: String, _: usize) -> Result<String, AgentError> {
        panic!("options required")
    }
    async fn run_agent_session_with_options(
        &self,
        _: String,
        prompt: String,
        _: usize,
        _: AgentKind,
        options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        self.0.lock().unwrap().push((prompt, options));
        Ok("review complete".into())
    }
}

#[tokio::test]
async fn imported_agent_uses_explicit_native_mapping_and_preserves_literal_task_instructions() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("skills/reviewed-agent");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("SKILL.md"), "---\nname: reviewed-agent\ndescription: Review\nmetadata:\n  kcoder:\n    category: plugin-prompt\n---\nReviewed native launcher.").unwrap();
    let profile = PluginPromptProfile {
        imported_agent: Some(ImportedAgentExecution {
            adapter_revision: "static-agent/v1".into(),
            source_sha256: "a".repeat(64),
            model: ImportedAgentModel::Target {
                provider: "mapped-provider".into(),
                model: "mapped-model".into(),
            },
        }),
        instructions: "Keep $0 and ${CLAUDE_PROJECT_DIR} literal.".into(),
        argument_names: vec![],
        plugin_root: String::new(),
        source: String::new(),
        kind: "agent".into(),
        allowed_tools: Some(vec!["read".into()]),
        max_turns: Some(3),
    };
    std::fs::write(
        directory.join("plugin-agent.json"),
        serde_json::to_vec(&profile).unwrap(),
    )
    .unwrap();
    let registry = kcoder_skills::SkillRegistry::load_with_external_dirs(
        root.path(),
        [root.path().join("skills")],
    )
    .unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join("session.jsonl"));
    let runner = Arc::new(Runner(Mutex::new(vec![])));
    let mut settings = kcoder_config::Settings::default();
    let mut provider = kcoder_config::default_active_provider_config();
    provider.models.clear();
    provider.default_model = "mapped-model".into();
    settings.providers.clear();
    settings
        .providers
        .insert("mapped-provider".into(), provider);
    let runtime = Arc::new(std::sync::RwLock::new(settings));
    let ctx = ToolContext::new(state)
        .with_agent_runner(runner.clone())
        .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
        .with_skill_registry(Arc::new(std::sync::RwLock::new(registry)))
        .with_runtime_settings(runtime.clone())
        .with_trust_external_skills(true);
    AgentTool.call(serde_json::json!({"plugin_agent":"reviewed-agent","message":"target.rs","context_mode":"none"}), &ctx).await.unwrap();
    {
        let calls = runner.0.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0]
                .0
                .contains("Keep $0 and ${CLAUDE_PROJECT_DIR} literal.")
        );
        assert_eq!(calls[0].1.tool_allowlist, Some(vec!["read".into()]));
        let selection = calls[0].1.runtime_selection.as_ref().unwrap();
        assert_eq!(selection.provider.as_deref(), Some("mapped-provider"));
        assert_eq!(selection.model.as_deref(), Some("mapped-model"));
        let task = ctx.state.tasks().into_values().next().unwrap();
        let restored: kcoder_state::Task =
            serde_json::from_slice(&serde_json::to_vec(&task).unwrap()).unwrap();
        assert_eq!(
            restored.plugin_prompt_policy.unwrap().imported_agent,
            profile.imported_agent
        );
    }

    runtime.write().unwrap().providers.clear();
    assert!(
        AgentTool
            .call(
                serde_json::json!({"plugin_agent":"reviewed-agent","message":"new task"}),
                &ctx
            )
            .await
            .is_err()
    );
    assert_eq!(runner.0.lock().unwrap().len(), 1);
}
