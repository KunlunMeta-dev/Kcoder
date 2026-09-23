#[tokio::test]
async fn input_hint_cache_matches_uncached_definitions_across_modes() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(kcoder_tools::default_registry()).build();
    let mut uncached = engine.clone();
    uncached.tool_input_hints = Arc::new(crate::tool_input_hints::ToolInputHints::default());
    for luna in [false, true] {
        engine.set_luna_mode(luna);
        uncached.set_luna_mode(luna);
        assert_eq!(serde_json::to_value(engine.tool_definitions_for_model().await).unwrap(),
            serde_json::to_value(uncached.tool_definitions_for_model().await).unwrap());
    }
}

#[tokio::test]
async fn effective_tool_catalog_matches_model_definitions_across_filters() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        goal_enabled: false,
        permission_mode: PermissionMode::Yolo,
        ..Settings::default()
    };
    settings.tools.luna.allowed = vec!["read".into()];
    settings.enable_training_mode();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(temp.path())
        .settings(settings)
        .tool_registry(kcoder_tools::default_registry())
        .build();
    for luna in [false, true, false] {
        engine.set_luna_mode(luna);
        let mut expected = engine
            .tool_definitions_for_model()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        expected.sort();
        let actual = engine
            .effective_tool_catalog()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        assert!(
            !actual
                .iter()
                .any(|name| is_goal_tool_name(name) || is_user_elicitation_tool_name(name))
        );
        if luna {
            assert_eq!(actual, vec!["read"]);
        }
    }
    engine
        .state
        .enter_orchestrate_before_first_message()
        .unwrap();
    let mut expected = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|tool| tool.name)
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(
        engine
            .effective_tool_catalog()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>(),
        expected
    );
    engine.settings.write().unwrap().model_capabilities.tools = false;
    assert!(engine.effective_tool_catalog().await.is_empty());
}

fn schema_ref_paths(value: &Value) -> Vec<String> {
    fn visit(value: &Value, path: &str, refs: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if map.contains_key("$ref") {
                    refs.push(format!("{path}.$ref"));
                }
                for (key, child) in map {
                    visit(child, &format!("{path}.{key}"), refs);
                }
            }
            Value::Array(values) => {
                for (index, child) in values.iter().enumerate() {
                    visit(child, &format!("{path}[{index}]"), refs);
                }
            }
            _ => {}
        }
    }

    let mut refs = Vec::new();
    visit(value, "$", &mut refs);
    refs
}

async fn tool_definition_for_model(tool: &dyn kcoder_tools::Tool) -> kcoder_types::ToolDefinition {
    let name = tool.name();
    let input_format = tool.input_format();
    let input_schema = model_schema_for_tool_input(&name, &tool.input_schema(), &input_format);
    let ctx = ToolDescriptionContext {
        permission_mode: ToolPermissionMode::Ask,
        is_non_interactive: false,
        active_skills: Vec::new(),
    };
    let description = tool.description_for_model(None, &ctx).await;
    let description =
        description_for_model_with_input_format(&description, &input_schema, &tool.input_format());
    kcoder_types::ToolDefinition {
        name,
        description,
        input_schema,
    }
}

#[test]
fn messages_request_serializes_tools() {
    let tools = vec![kcoder_types::ToolDefinition {
        name: "read".to_string(),
        description: "read a file".to_string(),
        input_schema: serde_json::json!({"type":"object","properties":{}}),
    }];
    let request = MessagesRequest::new("kcoder-test", vec![])
        .with_system("test")
        .with_tools(tools);
    let json = serde_json::to_value(request).unwrap();
    assert!(json.get("tools").is_some());
    assert_eq!(json["tools"].as_array().unwrap().len(), 1);
    assert_eq!(json["tools"][0]["name"], "read");
}

#[tokio::test]
async fn tool_definition_for_model_includes_input_shape_guidance() {
    let registry = kcoder_tools::default_registry();
    let tool = registry.get("TodoWrite").unwrap();
    let definition = tool_definition_for_model(tool.as_ref()).await;

    assert_eq!(definition.name, "TodoWrite");
    assert!(definition.description.contains("Input format:"));
    assert!(definition.description.contains("JSON shape example:"));
    assert!(definition.description.contains("\"TodoList\":["));
    assert!(definition.description.contains("placeholder strings"));
    assert!(definition.description.contains("{\"TodoList\":[\"\"]}"));
    assert!(definition.description.contains("Required fields:"));
    assert!(definition.description.contains("$.TodoList"));
    assert!(
        definition
            .description
            .contains("Array fields must use JSON arrays")
    );
    assert!(
        definition.input_schema["properties"]["TodoList"]["description"]
            .as_str()
            .unwrap()
            .contains("Complete replacement TodoList")
    );
    assert!(
        definition.input_schema["properties"]["TodoList"]["description"]
            .as_str()
            .unwrap()
            .contains("null-valued fields")
    );
    assert!(
            definition.input_schema["properties"]["TodoList"]["items"]["properties"]["activeForm"]
                ["description"]
                .as_str()
                .unwrap()
                .contains("Present-continuous")
        );
    assert!(
            definition.input_schema["properties"]["TodoList"]["items"]["properties"]["status"]
                ["description"]
                .as_str()
                .unwrap()
                .contains("do not send `null`")
        );
    assert!(
        definition
            .input_schema
            .pointer("/properties/TodoList/items/$ref")
            .is_none()
    );
    assert!(
        definition
            .input_schema
            .pointer("/properties/TodoList/items/properties/status/allOf")
            .is_none()
    );
}

#[test]
fn model_tool_definitions_inline_local_refs_for_every_default_tool() {
    let registry = kcoder_tools::default_registry();
    let (definitions, _, _) = build_tool_caches(&registry);

    assert!(!definitions.is_empty());
    for definition in definitions {
        assert!(
            schema_ref_paths(&definition.input_schema).is_empty(),
            "model-facing schema for tool `{}` still contains local refs: {}",
            definition.name,
            schema_ref_paths(&definition.input_schema).join(", ")
        );
    }
}
