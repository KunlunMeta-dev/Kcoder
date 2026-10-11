use kcoder_tools::{normalize_tool_input, validate_input_against_schema};

#[test]
fn schema_validation_rejects_missing_required_fields_and_wrong_types() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "limit": {"type": "integer"}
        },
        "required": ["path"],
        "additionalProperties": false
    });

    assert!(
        validate_input_against_schema(&serde_json::json!({"path": "README.md"}), &schema).is_ok()
    );
    assert!(validate_input_against_schema(&serde_json::json!({"limit": 2}), &schema).is_err());
    assert!(
        validate_input_against_schema(
            &serde_json::json!({"path": "README.md", "limit": "many"}),
            &schema
        )
        .is_err()
    );
}

#[test]
fn todo_input_normalization_converts_aliases_to_the_public_schema() {
    let mut input = serde_json::json!({
        "todos": [
            "编译工作区",
            {"content": "运行测试", "active_form": "正在运行测试"}
        ]
    });
    normalize_tool_input("TodoWrite", &mut input);

    assert!(input.get("todos").is_none());
    assert_eq!(input["TodoList"][0]["content"], "编译工作区");
    assert_eq!(input["TodoList"][0]["status"], "pending");
    assert_eq!(input["TodoList"][1]["activeForm"], "正在运行测试");
    assert!(input["TodoList"][1].get("active_form").is_none());
}
