use super::*;

struct MutableSchemaTool(Arc<std::sync::atomic::AtomicBool>);
#[async_trait::async_trait]
impl kcoder_tools::Tool for MutableSchemaTool {
    fn name(&self) -> String {
        "mutable_schema".into()
    }
    fn description(&self) -> String {
        "schema fixture".into()
    }
    fn input_schema(&self) -> Value {
        let field = if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            "new"
        } else {
            "old"
        };
        serde_json::json!({"type":"object","properties":{(field):{"type":"string"}},"required":[field]})
    }
    async fn call(
        &self,
        _: Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text("unused"))
    }
}

#[tokio::test]
async fn mutable_same_object_schema_never_uses_frozen_definition() {
    let root = tempfile::tempdir().unwrap();
    let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(MutableSchemaTool(changed.clone())))
        .build();
    for enabled in [false, true, false] {
        changed.store(enabled, std::sync::atomic::Ordering::SeqCst);
        let tool = engine.tools.get("mutable_schema").unwrap();
        assert_eq!(
            engine.input_schema_for_tool("mutable_schema", tool.as_ref()),
            tool.input_schema()
        );
        let definition = engine.tool_definitions_for_model().await.remove(0);
        let expected = model_schema_for_tool_input(
            "mutable_schema",
            &tool.input_schema(),
            &tool.input_format(),
        );
        assert_eq!(definition.input_schema, expected);
        assert_eq!(
            definition.description,
            description_for_model_with_input_format(
                &tool.description(),
                &expected,
                &tool.input_format()
            )
        );
    }
}

struct MutableFormatTool(Arc<std::sync::atomic::AtomicBool>);

#[async_trait::async_trait]
impl kcoder_tools::Tool for MutableFormatTool {
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn name(&self) -> String {
        "mutable_format".into()
    }
    fn description(&self) -> String {
        "format fixture".into()
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({"type":"object","properties":{"value":{"type":"string"}},"required":["value"]})
    }
    fn input_format(&self) -> kcoder_tools::ToolInputFormat {
        if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            kcoder_tools::ToolInputFormat::Freeform {
                syntax: "patch".into(),
                example: "sample".into(),
            }
        } else {
            kcoder_tools::ToolInputFormat::Json
        }
    }
    async fn call(
        &self,
        _: Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text("unused"))
    }
}

#[tokio::test]
async fn runtime_input_format_changes_rebuild_model_transport_schema() {
    let root = tempfile::tempdir().unwrap();
    let freeform = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(MutableFormatTool(freeform.clone())))
        .build();
    for enabled in [false, true, false] {
        freeform.store(enabled, std::sync::atomic::Ordering::SeqCst);
        let tool = engine.tools.get("mutable_format").unwrap();
        let definition = engine.tool_definitions_for_model().await.remove(0);
        let expected = model_schema_for_tool_input(
            "mutable_format",
            &tool.input_schema(),
            &tool.input_format(),
        );
        assert_eq!(definition.input_schema, expected);
        assert_eq!(
            definition.description,
            description_for_model_with_input_format(
                &tool.description(),
                &expected,
                &tool.input_format()
            )
        );
    }
}

struct RevisionSchemaTool {
    name: &'static str,
    field: &'static str,
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for RevisionSchemaTool {
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn name(&self) -> String {
        self.name.into()
    }
    fn description(&self) -> String {
        "revision fixture".into()
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({"type":"object","properties":{(self.field):{"type":"string"}},"required":[self.field]})
    }
    async fn call(
        &self,
        _: Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text("unused"))
    }
}

#[tokio::test]
async fn structural_revision_refreshes_model_and_execution_schemas() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(RevisionSchemaTool {
            name: "fixture",
            field: "old",
        }))
        .build();
    let different_instance = RevisionSchemaTool {
        name: "fixture",
        field: "other-instance",
    };
    assert_eq!(
        engine.input_schema_for_tool("fixture", &different_instance)["required"],
        serde_json::json!(["other-instance"])
    );
    engine
        .tools
        .replace_builtin(RevisionSchemaTool {
            name: "fixture",
            field: "new",
        })
        .unwrap();
    let tool = engine.tools.get("fixture").unwrap();
    assert_eq!(
        engine.input_schema_for_tool("fixture", tool.as_ref())["required"],
        serde_json::json!(["new"])
    );
    assert_eq!(
        engine.tool_definitions_for_model().await[0].input_schema["required"],
        serde_json::json!(["new"])
    );
    engine
        .tools
        .try_register(Arc::new(RevisionSchemaTool {
            name: "extra",
            field: "value",
        }))
        .unwrap();
    assert_eq!(engine.tool_definitions_for_model().await.len(), 2);
    engine.tools = engine.tools.filtered_to_names(&["extra".into()]);
    let definitions = engine.tool_definitions_for_model().await;
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name, "extra");
}

#[test]
fn client_tool_descriptions_never_probe_a_protocol_stdin_handle() {
    assert!(description_is_non_interactive(
        WorkspacePersistenceMode::Client,
        || { panic!("a client stdin probe can block behind the protocol reader") }
    ));
}

#[test]
fn interactive_tool_descriptions_preserve_terminal_detection() {
    assert!(!description_is_non_interactive(
        WorkspacePersistenceMode::Interactive,
        || true
    ));
    assert!(description_is_non_interactive(
        WorkspacePersistenceMode::Interactive,
        || false
    ));
}

#[tokio::test]
async fn file_edit_surface_is_pinned_at_engine_start() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = kcoder_config::Settings::default();
    settings.tools.file_edit_tool = kcoder_config::FileEditSurface::ApplyPatch;
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(
            ToolRegistry::new()
                .register(kcoder_tools::FileEditTool)
                .register(kcoder_tools::ApplyPatchTool),
        )
        .settings(settings)
        .build();

    let names = |definitions: Vec<kcoder_types::ToolDefinition>| -> Vec<String> {
        definitions
            .into_iter()
            .map(|definition| definition.name)
            .collect()
    };

    let applied = names(engine.tool_definitions_for_model().await);
    assert!(
        applied.iter().any(|name| name == "apply_patch"),
        "got: {applied:?}"
    );
    assert!(
        !applied.iter().any(|name| name == "edit"),
        "got: {applied:?}"
    );

    // The surface is pinned when the engine is created: flipping the live
    // setting mid-session must NOT switch the exposed edit tool.
    engine.settings.write().unwrap().tools.file_edit_tool = kcoder_config::FileEditSurface::Edit;
    let pinned = names(engine.tool_definitions_for_model().await);
    assert!(
        pinned.iter().any(|name| name == "apply_patch"),
        "got: {pinned:?}"
    );
    assert!(!pinned.iter().any(|name| name == "edit"), "got: {pinned:?}");
}

#[test]
fn oversized_schema_examples_are_omitted_instead_of_truncated_json() {
    let properties = (0..20).map(|index| (format!("field_{index}"), serde_json::json!({"type":"string","minLength":50}))).collect::<serde_json::Map<String, serde_json::Value>>();
    let required = properties.keys().cloned().collect::<Vec<_>>();
    let schema = serde_json::json!({"type":"object","properties":properties,"required":required});
    assert!(kcoder_tools::example_input_for_schema(&schema).is_some());
    assert!(super::format_schema_example_for_prompt(&schema).is_none());
    let small = serde_json::json!({"type":"object","properties":{"offset":{"type":"integer","minimum":1}},"required":["offset"]});
    let example = super::format_schema_example_for_prompt(&small).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&example).unwrap()["offset"], 1);
}

#[tokio::test]
async fn peer_guidance_tracks_final_request_capabilities_in_cached_and_uncached_paths() {
    use kcoder_tools::{AgentTool, BashTool, FileReadTool, TaskListTool};
    let cases = [
        ("agent-only", ToolRegistry::new().register(AgentTool)),
        ("task-list-only", ToolRegistry::new().register(TaskListTool)),
        ("planner-only", ToolRegistry::new().register(kcoder_tools::PlanAgentTool)),
        ("skill-only", ToolRegistry::new().register(kcoder_tools::SkillTool)),
        ("shell-only", ToolRegistry::new().register(BashTool)),
        ("read-only", ToolRegistry::new().register(FileReadTool)),
        ("none", ToolRegistry::new()),
        ("core", kcoder_tools::core_registry()),
        ("full", kcoder_tools::default_registry()),
    ];
    for (case, registry) in cases {
        let root = tempfile::tempdir().unwrap();
        let mut engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
            .tool_registry(registry).build();
        let cached = engine.tool_definitions_for_model().await;
        let names = cached.iter().map(|tool| tool.name.as_str()).collect::<std::collections::HashSet<_>>();
        for definition in &cached {
            if let Some((_, peer_text)) = definition.description.split_once("Available peer operations: ") {
                for operation in peer_text.split("Use ").skip(1) {
                    let peer = operation.split_whitespace().next().unwrap();
                    assert!(names.contains(peer), "{case}: unavailable peer {peer}");
                }
            }
            if case == "agent-only" || case == "task-list-only" {
                let serialized = serde_json::to_string(definition).unwrap();
                for absent in ["TaskOutput", "TaskStop", "SendMessage", "explore_agent", "close_agent"] {
                    assert!(!serialized.contains(absent), "{case}: leaked {absent}");
                }
            }
            if case == "planner-only" {
                assert!(definition.description.contains("persist the complete plan with WritePlan"));
                assert!(!names.contains("WritePlan"), "WritePlan belongs to the child role, not this request");
                assert!(!definition.description.contains("Use TaskOutput"));
            }
            if case == "skill-only" {
                let serialized = serde_json::to_string(definition).unwrap();
                for absent in ["DiscoverSkills", "skill_manage", "skill_hub", "skill_curator"] {
                    assert!(!serialized.contains(absent), "{case}: leaked {absent}");
                }
            }
            if case == "shell-only" {
                let serialized = serde_json::to_string(definition).unwrap();
                for absent in ["`read`", "`edit`", "`write`", "`glob`", "TaskOutput", "TaskStop"] {
                    assert!(!serialized.contains(absent), "{case}: leaked {absent}");
                }
                assert!(definition.description.contains("otherwise use bounded shell inspection"));
            }
        }
        if case == "none" { assert!(cached.is_empty()); }
        if case == "full" {
            let agent = cached.iter().find(|tool| tool.name == "spawn_agent").unwrap();
            assert!(agent.description.contains("Use SendMessage"));
            assert!(agent.description.contains("Use TaskOutput"));
        }
        engine.tool_schema_revision = kcoder_tools::ToolRegistryRevision::default();
        let uncached = engine.tool_definitions_for_model().await;
        assert_eq!(serde_json::to_value(cached).unwrap(), serde_json::to_value(uncached).unwrap(), "{case}");
    }
}

struct CapabilityProbe;
#[async_trait::async_trait]
impl kcoder_tools::Tool for CapabilityProbe {
    fn name(&self) -> String { "capability_probe".into() }
    fn description(&self) -> String { "probe".into() }
    fn input_schema(&self) -> Value { serde_json::json!({"type":"object","properties":{}}) }
    async fn description_for_model(&self, _: Option<&Value>, ctx: &kcoder_tools::ToolDescriptionContext) -> String {
        let mut names = ctx.available_tools.iter().cloned().collect::<Vec<_>>();
        names.sort(); serde_json::to_string(&names).unwrap()
    }
    async fn call(&self, _: Value, _: &kcoder_tools::ToolContext) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> { unreachable!() }
}

#[tokio::test]
async fn description_context_excludes_yolo_goal_edit_surface_and_terminal_filtered_tools() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(kcoder_tools::default_registry().register(CapabilityProbe)
            .register(kcoder_tools::verifier_vote::VerifierVoteTool)).build();
    for yolo in [false, true] {
        {
            let mut settings = engine.settings.write().unwrap();
            settings.permission_mode = if yolo { kcoder_config::PermissionMode::Yolo } else { kcoder_config::PermissionMode::Ask };
            settings.goal_enabled = !yolo;
        }
        let definitions = engine.tool_definitions_for_model().await;
        let mut names = definitions.iter().map(|tool| tool.name.clone()).collect::<Vec<_>>(); names.sort();
        let probe = definitions.iter().find(|tool| tool.name == "capability_probe").unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&probe.description).unwrap(), names);
        if yolo { for absent in ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "create_goal", "get_goal", "update_goal"] { assert!(!names.iter().any(|name| name == absent)); } }
        assert!(!(names.contains(&"edit".into()) && names.contains(&"apply_patch".into())));
    }
    let terminal = engine.tool_definitions_for_request(true).await;
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].name, kcoder_tools::VERIFIER_VOTE_TOOL_NAME);
    engine.settings.write().unwrap().model_capabilities.tools = false;
    assert!(engine.tool_definitions_for_request(true).await.is_empty());
    assert!(engine.tool_definitions_for_model().await.is_empty());
}

#[tokio::test]
async fn windows_core_request_does_not_advertise_full_profile_or_unix_controls() {
    let root = tempfile::tempdir().unwrap();
    let registry = kcoder_tools::core_registry()
        .filtered_out_by_patterns(&["bash".into(), "PowerShell".into()])
        .register(kcoder_tools::PowerShellTool)
        .register(kcoder_tools::ConfigTool);
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(registry).build();
    let definitions = engine.tool_definitions_for_model().await;
    let names = definitions.iter().map(|tool| tool.name.clone()).collect::<std::collections::HashSet<_>>();
    assert_eq!(names.len(), 27, "{names:?}");
    assert!(names.contains("PowerShell"));
    assert!(names.contains("CtxInspect"));
    assert!(names.contains("Config"));
    let prompt = crate::prompt_runtime::build_system_prompt(root.path(), "test", false, false, false, &names);
    assert!(prompt.contains("Windows process state"));
    assert!(!prompt.contains("stopped T/t"));
    let definitions = serde_json::to_string(&definitions).unwrap();
    for unavailable in ["PlanAgent", "Workflow", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "DiscoverSkills"] {
        assert!(!names.contains(unavailable));
        assert!(!prompt.contains(unavailable), "prompt advertised {unavailable}");
        assert!(!definitions.contains(unavailable), "definition advertised {unavailable}");
    }
}
