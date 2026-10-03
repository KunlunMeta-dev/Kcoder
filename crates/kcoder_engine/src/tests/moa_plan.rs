use crate::moa_plan::{
    moa_plan_portable_messages, moa_plan_read_tools, resolve_moa_plan_models,
};
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::{ContentBlock, ContentDelta, StreamEvent};

#[derive(Debug)]
struct SubmitMoaToolProvider {
    tool_name: &'static str,
}

impl Provider for SubmitMoaToolProvider {
    fn name(&self) -> &'static str {
        "moa-submit-test"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<ProviderStream, ApiErrorKind> {
        let tool_name = self.tool_name.to_string();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "moa-submit-tool".to_string(),
                    name: tool_name,
                    input: serde_json::Value::Object(serde_json::Map::new()),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: serde_json::json!({"content": "# Submitted plan"}).to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[test]
fn moa_plan_models_include_current_planner_and_deduplicate_slots() {
    let mut settings = Settings {
        provider: Some("main-provider".to_string()),
        model: "main-model".to_string(),
        ..Settings::default()
    };
    settings.moa_plan.preset = "plan".to_string();
    settings.moa.presets.insert(
        "plan".to_string(),
        MoaPresetConfig {
            reference_models: vec![
                MoaModelConfig::new("current", "current"),
                MoaModelConfig::new("other-provider", "other-model"),
                MoaModelConfig::new("other-provider", "other-model"),
            ],
            ..MoaPresetConfig::default()
        },
    );

    let models = resolve_moa_plan_models(&settings).unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0], MoaModelConfig::new("main-provider", "main-model"));
    assert_eq!(
        models[1],
        MoaModelConfig::new("other-provider", "other-model")
    );
}

#[test]
fn moa_plan_models_reject_a_single_distinct_runtime() {
    let mut settings = Settings::default();
    settings.moa_plan.preset = "one".to_string();
    settings.moa.presets.insert(
        "one".to_string(),
        MoaPresetConfig {
            reference_models: vec![MoaModelConfig::new("current", "current")],
            ..MoaPresetConfig::default()
        },
    );

    let error = resolve_moa_plan_models(&settings).unwrap_err().to_string();
    assert!(error.contains("at least two distinct models"), "{error}");
}

#[test]
fn moa_plan_portable_context_strips_reasoning_and_keeps_full_tool_results() {
    let long_result = "x".repeat(6_000);
    let messages = vec![
        Message::Assistant {
            content: vec![
                ContentBlock::Thinking {
                    thinking: "private reasoning".to_string(),
                    signature: "provider-signature".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "provider-tool-id".to_string(),
                    name: "read".to_string(),
                    input: serde_json::json!({"file_path":"src/lib.rs"}),
                },
            ],
            usage: None,
        },
        Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: "provider-tool-id".to_string(),
            content: vec![ContentBlock::Text {
                text: long_result.clone(),
            }],
            is_error: Some(false),
        }]),
    ];

    let portable = moa_plan_portable_messages(&messages);
    let rendered = portable
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("private reasoning"));
    assert!(!rendered.contains("provider-signature"));
    assert!(rendered.contains("[called tool: read"));
    assert!(rendered.contains(&long_result));
    assert!(!rendered.contains("chars omitted"));
}

#[test]
fn moa_plan_planners_only_receive_repository_read_tools() {
    let temp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path())
        .tool_registry(kcoder_tools::default_registry())
        .build();
    let tools = moa_plan_read_tools(&engine);
    let names = tools.names();

    for expected in ["read", "glob", "grep"] {
        assert!(names.iter().any(|name| name == expected), "{names:?}");
    }
    for forbidden in [
        "write",
        "edit",
        "bash",
        "spawn_agent",
        "Workflow",
        "AskUserQuestion",
    ] {
        assert!(!names.iter().any(|name| name == forbidden), "{names:?}");
    }
}

#[test]
fn moa_plan_validation_failure_does_not_mutate_conversation() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.moa_plan.preset = "one".to_string();
    settings.moa.presets.insert(
        "one".to_string(),
        MoaPresetConfig {
            reference_models: vec![MoaModelConfig::new("current", "current")],
            ..MoaPresetConfig::default()
        },
    );
    let engine = TestEngineBuilder::new(temp.path()).settings(settings).build();
    assert!(engine.moa_plan_preflight().is_err());
    assert!(engine.state.messages().is_empty());
}

#[tokio::test]
async fn moa_planner_keeps_submission_at_max_turn_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        provider: Some("moa-submit-test".to_string()),
        model: "test-model".to_string(),
        ..Settings::default()
    };
    settings.moa_plan.draft_max_turns = 1;
    let engine = TestEngineBuilder::new(temp.path())
        .provider(Arc::new(SubmitMoaToolProvider {
            tool_name: "SubmitMoaDraft",
        }))
        .settings(settings.clone())
        .build();

    let outcome = engine
        .run_moa_planner(
            "test-run",
            0,
            MoaModelConfig::new("moa-submit-test", "test-model"),
            vec![Message::user_text("make a plan")],
            &settings,
            std::time::Duration::from_secs(30),
        )
        .await
        .unwrap();

    assert_eq!(outcome.content.as_deref(), Some("# Submitted plan"));
    assert!(outcome.error.is_none());
}

#[tokio::test]
async fn moa_planner_reports_provider_configuration_errors_as_failed_outcomes() {
    let temp = tempfile::tempdir().unwrap();
    let settings = Settings::default();
    let engine = TestEngineBuilder::new(temp.path())
        .settings(settings.clone())
        .build();

    let outcome = engine
        .run_moa_planner(
            "test-run",
            1,
            MoaModelConfig::new("missing-provider", "missing-model"),
            vec![Message::user_text("make a plan")],
            &settings,
            std::time::Duration::from_secs(5),
        )
        .await
        .unwrap();

    assert!(outcome.content.is_none());
    let error = outcome.error.expect("provider error must be retained");
    assert!(error.contains("failed to initialize planner provider"), "{error}");
    assert!(error.contains("unknown provider or profile"), "{error}");
}

#[tokio::test]
async fn moa_synthesis_keeps_submission_at_max_turn_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        provider: Some("moa-submit-test".to_string()),
        model: "test-model".to_string(),
        ..Settings::default()
    };
    settings.moa_plan.draft_max_turns = 1;
    let engine = TestEngineBuilder::new(temp.path())
        .provider(Arc::new(SubmitMoaToolProvider {
            tool_name: "SubmitMoaFinal",
        }))
        .settings(settings.clone())
        .build();
    let draft = temp.path().join("draft.md");
    std::fs::write(&draft, "# Draft").unwrap();

    let final_plan = engine
        .run_moa_synthesis("test-run", "make a plan", &[draft], &[], &settings)
        .await
        .unwrap();

    assert_eq!(final_plan, "# Submitted plan");
}
