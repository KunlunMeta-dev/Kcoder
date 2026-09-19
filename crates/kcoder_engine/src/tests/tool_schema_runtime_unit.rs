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
