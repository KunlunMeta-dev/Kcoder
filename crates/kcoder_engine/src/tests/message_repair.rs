#[test]
fn repair_tool_sequence_inserts_interrupted_result_for_unmatched_tool_use() {
    let messages = vec![
        Message::user_text("run a command"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command":"sleep 60"}),
            }],
            usage: None,
        },
        Message::user_text("new request after interrupt"),
    ];

    let (repaired, changed) = repair_tool_message_sequence(messages);
    assert!(changed);
    assert!(matches!(
        &repaired[2],
        Message::User { content }
            if matches!(
                &content[0],
                ContentBlock::ToolResult {
                    tool_use_id,
                    is_error: Some(true),
                    ..
                } if tool_use_id == "tool-1"
            )
    ));
    assert!(matches!(
        &repaired[3],
        Message::User { content }
            if matches!(&content[0], ContentBlock::Text { text } if text == "new request after interrupt")
    ));
}

#[test]
fn repair_tool_sequence_moves_late_tool_result_before_interleaved_user_text() {
    let messages = vec![
        Message::user_text("inspect"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"file_path":"Cargo.toml"}),
            }],
            usage: None,
        },
        Message::user_text("queued follow-up"),
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "file contents".to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];

    let (repaired, changed) = repair_tool_message_sequence(messages);
    assert!(changed);
    assert!(matches!(
        &repaired[2],
        Message::User { content }
            if matches!(
                &content[0],
                ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "tool-1"
            )
    ));
    assert!(matches!(
        &repaired[3],
        Message::User { content }
            if matches!(&content[0], ContentBlock::Text { text } if text == "queued follow-up")
    ));
}

#[test]
fn repair_tool_sequence_converts_orphan_tool_result_to_text() {
    let messages = vec![Message::User {
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "tool-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "late output".to_string(),
            }],
            is_error: Some(false),
        }],
    }];

    let (repaired, changed) = repair_tool_message_sequence(messages);
    assert!(changed);
    assert!(matches!(
        &repaired[0],
        Message::User { content }
            if matches!(
                &content[0],
                ContentBlock::Text { text }
                    if text.contains("orphaned tool result tool-1")
                        && text.contains("late output")
            )
    ));
}
