use kcoder_types::{ContentBlock, McpServerConfig, Message};

#[test]
fn message_wire_contract_round_trips_tagged_content() {
    let message = Message::User {
        content: vec![
            ContentBlock::Text {
                text: "检查契约".to_string(),
            },
            ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read_file".to_string(),
                input: serde_json::json!({"path": "README.md"}),
            },
        ],
    };

    let wire = serde_json::to_value(&message).expect("message should serialize");
    assert_eq!(wire["role"], "user");
    assert_eq!(wire["content"][0]["type"], "text");
    assert_eq!(wire["content"][1]["type"], "tool_use");
    assert_eq!(wire["content"][1]["name"], "read_file");

    let decoded: Message = serde_json::from_value(wire).expect("message should deserialize");
    assert_eq!(decoded, message);
}

#[test]
fn mcp_server_config_preserves_defaults_at_the_shared_boundary() {
    let decoded: McpServerConfig = serde_json::from_value(serde_json::json!({
        "name": "local"
    }))
    .expect("minimal MCP configuration should deserialize");

    assert_eq!(decoded.name, "local");
    assert_eq!(decoded.transport, "stdio");
    assert!(decoded.command.is_empty());
    assert!(decoded.args.is_empty());
    assert!(decoded.url.is_empty());
    assert!(decoded.env.is_empty());
}
