//! Ordinary Studio coding gets managed presentation, never office isolation or a new tool grant.
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_tools::{FileReadTool, FileWriteTool, ShowWidgetTool};

fn coding_presentation() -> Option<ClientPresentationV1> {
    Some(ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(StudioWorkMode::Kcoder),
        inline_widgets: true,
        isolated_widgets: false,
    })
}

#[tokio::test]
async fn coding_widgets_are_managed_turn_local_and_match_the_model_catalog() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.tools.studio.kcoder = Some(vec!["read".into(), "show_widget".into()]);
    let resident = TestEngineBuilder::new(root.path())
        .settings(settings)
        .tool_registry(
            ToolRegistry::new()
                .register(FileReadTool)
                .register(FileWriteTool),
        )
        .build_with_profile_directory();
    let coding = resident
        .clone()
        .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
        .with_client_presentation(coding_presentation())
        .with_widget_tool(ShowWidgetTool::preview());
    assert!(coding.inline_widgets_enabled());
    assert!(!coding.isolated_widgets_enabled());
    assert!(!coding.office_tool_policy_active());
    let names = coding.active_tool_registry().names();
    assert_eq!(names, ["read", "show_widget"]);
    let catalog = coding.effective_tool_catalog().await;
    let definitions = coding.tool_definitions_for_model().await;
    assert_eq!(
        catalog
            .iter()
            .map(|tool| &tool.name)
            .collect::<HashSet<_>>(),
        definitions
            .iter()
            .map(|tool| &tool.name)
            .collect::<HashSet<_>>()
    );
    let widget = definitions
        .iter()
        .find(|tool| tool.name == "show_widget")
        .unwrap();
    assert!(widget.description.contains("managed mode only"));
    assert!(
        !widget
            .description
            .contains("also permits execution_mode=isolated_html")
    );
    assert!(resident.active_tool_registry().get("show_widget").is_none());
    for presentation in [
        None,
        Some(ClientPresentationV1 {
            inline_widgets: false,
            ..coding_presentation().unwrap()
        }),
    ] {
        let hidden = coding.clone().with_client_presentation(presentation);
        assert!(!hidden.inline_widgets_enabled());
        assert!(hidden.active_tool_registry().get("show_widget").is_some());
    }
    // Even a manually composed Engine declaration cannot enable the office sandbox.
    let forged_isolation = coding
        .clone()
        .with_client_presentation(Some(ClientPresentationV1 {
            isolated_widgets: true,
            ..coding_presentation().unwrap()
        }));
    assert!(!forged_isolation.isolated_widgets_enabled());
    let worker = coding.with_client_presentation(Some(ClientPresentationV1 {
        studio_work_mode: Some(StudioWorkMode::Kworker),
        isolated_widgets: true,
        ..coding_presentation().unwrap()
    }));
    assert!(worker.inline_widgets_enabled());
    assert_eq!(worker.effective_studio_work_mode(), StudioWorkMode::Kcoder);
    assert!(!worker.isolated_widgets_enabled());
    let worker = worker.with_studio_work_mode(Some(StudioWorkMode::Kworker));
    assert!(worker.isolated_widgets_enabled());
}

#[test]
fn coding_widget_defaults_do_not_restore_explicitly_denied_or_unsupported_tools() {
    let root = tempfile::tempdir().unwrap();
    for (profile, disabled, model_tools) in [
        (
            kcoder_config::ToolProfile::Full,
            vec!["show_*".into()],
            true,
        ),
        (kcoder_config::ToolProfile::Nano, Vec::new(), true),
        (kcoder_config::ToolProfile::None, Vec::new(), true),
        (kcoder_config::ToolProfile::Full, Vec::new(), false),
    ] {
        let mut settings = Settings::default();
        settings.tools.profile = profile;
        settings.tools.disabled = disabled;
        settings.model_capabilities.tools = model_tools;
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build_with_profile_directory()
            .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
            .with_client_presentation(coding_presentation())
            .with_widget_tool(ShowWidgetTool::preview());
        assert!(engine.active_tool_registry().get("show_widget").is_none());
    }
    let mut settings = Settings::default();
    settings.tools.studio.kcoder = Some(Vec::new());
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .build_with_profile_directory()
        .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
        .with_client_presentation(coding_presentation())
        .with_widget_tool(ShowWidgetTool::preview());
    assert!(engine.active_tool_registry().get("show_widget").is_none());
}

#[test]
fn coding_widget_capability_does_not_expand_expert_or_special_role_permissions() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(FileReadTool))
        .build_with_profile_directory()
        .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
        .with_client_presentation(coding_presentation())
        .with_widget_tool(ShowWidgetTool::preview());
    let mut expert: kcoder_types::integrations::office::AgentDefinition =
        serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert",
            "description":"Configuration","language":"en","instructions":"Instructions",
            "inputSchema":{"type":"object"},"modelSelection":{"kind":"inherit_current"},
            "outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
        }))
        .unwrap();
    expert.allowed_tools = Some(vec!["read".into()]);
    let restricted = engine
        .clone()
        .with_agent_definition_context(expert.clone())
        .unwrap();
    assert!(restricted.active_tool_registry().get("read").is_some());
    assert!(
        restricted
            .active_tool_registry()
            .get("show_widget")
            .is_none()
    );
    expert.allowed_tools = Some(vec!["show_widget".into()]);
    let allowed = engine
        .clone()
        .with_agent_definition_context(expert.clone())
        .unwrap();
    assert!(allowed.active_tool_registry().get("show_widget").is_some());
    expert.allowed_tools = Some(Vec::new());
    let empty = engine
        .clone()
        .with_agent_definition_context(expert)
        .unwrap();
    assert!(empty.active_tool_registry().get("show_widget").is_none());
    let child = engine
        .clone()
        .with_subagent_system_prompt(Some("Read-only child".into()));
    assert!(!child.inline_widgets_enabled());
    assert!(child.active_tool_registry().get("show_widget").is_none());
    engine
        .state
        .enter_workflow_draft_before_first_message()
        .unwrap();
    assert!(!engine.inline_widgets_enabled());
    assert!(engine.active_tool_registry().get("show_widget").is_none());
    let descendant = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
        .with_client_presentation(coding_presentation())
        .with_widget_tool(ShowWidgetTool::preview())
        .with_agent_depth(1);
    assert!(!descendant.inline_widgets_enabled());
    assert!(
        descendant
            .active_tool_registry()
            .get("show_widget")
            .is_none()
    );
}
