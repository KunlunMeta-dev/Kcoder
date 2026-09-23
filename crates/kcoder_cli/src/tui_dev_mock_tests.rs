use super::*;
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};

#[tokio::test]
async fn tui_dev_steer_gate_waits_for_explicit_release_before_stream_events() {
    use futures::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let mut stream = targeted_steer_gated_stream(
        vec![Ok(StreamEvent::MessageStop)],
        directory.path().to_path_buf(),
        Duration::from_secs(1),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), stream.next())
            .await
            .is_err()
    );
    assert!(directory.path().join("entered").is_file());
    assert!(!directory.path().join("release").exists());
    tokio::fs::write(directory.path().join("release"), [])
        .await
        .unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Ok(StreamEvent::MessageStop))
    ));
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn tui_dev_steer_gate_reports_a_bounded_failure_and_ends_the_stream() {
    use futures::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let mut stream = targeted_steer_gated_stream(
        vec![Ok(StreamEvent::MessageStop)],
        directory.path().to_path_buf(),
        Duration::from_millis(25),
    );
    assert!(
        matches!(stream.next().await, Some(Err(kcoder_api::ApiErrorKind::Api { error_type, .. })) if error_type == "mock_steer_gate")
    );
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn tui_dev_steer_gate_can_be_dropped_without_a_background_waiter() {
    use futures::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let mut stream = targeted_steer_gated_stream(
        vec![Ok(StreamEvent::MessageStop)],
        directory.path().to_path_buf(),
        Duration::from_secs(120),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), stream.next())
            .await
            .is_err()
    );
    drop(stream);
    directory.close().unwrap();
}

#[test]
fn tui_dev_targeted_steer_observation_is_not_added_to_unsteered_sibling_report() {
    for steered in [false, true] {
        let mut prompt = "tui-lab-subagent-worker-sentinel Global sub-agent contract".to_string();
        if steered {
            prompt.push_str(" STUDIO_TARGETED_SUBAGENT_STEER_E2E");
        }
        let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text(prompt)]);
        let text = MockScenarioProvider::subagent_trace_events(&request)
            .into_iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                }) => Some(text),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text.contains("tui-lab-targeted-steer-observed"), steered);
    }
}

#[test]
fn tui_dev_steer_gate_selects_the_delegated_worker_not_parent_history() {
    let target = Message::user_text(
        "You are a KCoder general sub-agent.\n\nTask:\ntui-lab-subagent-worker-sentinel tui-lab-targeted-subagent-steer-long-transcript\n\nGlobal sub-agent contract:",
    );
    let sibling = Message::user_text(
        "You are a KCoder general sub-agent.\n\nTask:\ntui-lab-subagent-worker-sentinel sibling\n\nGlobal sub-agent contract:",
    );
    assert!(is_targeted_steer_worker(&MessagesRequest::new(
        "tui-dev-mock",
        vec![target.clone()]
    )));
    assert!(!is_targeted_steer_worker(&MessagesRequest::new(
        "tui-dev-mock",
        vec![target, sibling]
    )));
}

#[test]
fn tui_dev_markdown_streaming_exceeds_old_preview_limit_before_capture() {
    let text = MockScenarioProvider::markdown_streaming_events()
        .into_iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text),
            _ => None,
        })
        .collect::<String>();
    let probe = text.find("codex-stream-line-1600").unwrap();
    let closing = text.rfind("```").unwrap();
    assert!(probe > 64 * 1024 && probe < closing);
    assert!(closing < 512 * 1024);
    assert!(text.ends_with("tui-lab-final-sentinel"));
}

#[test]
fn tui_dev_markdown_showcase_covers_all_semantic_styles() {
    let events = MockScenarioProvider::markdown_showcase_events();
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    for expected in [
        "# H1 · bold underline",
        "###### H6 · italic",
        "> Blockquotes use full-row green",
        "- [ ] Task markers use the default color",
        "1. Ordered lists use light blue",
        "| Header | Active syntax theme |",
        "```rust",
        "tui-lab-final-line-001",
        "tui-lab-final-line-120",
        "tui-lab-final-sentinel",
    ] {
        assert!(
            text.contains(expected),
            "comprehensive scenario is missing: {expected}"
        );
    }
}

#[test]
fn tui_dev_orchestrate_scenario_uses_only_a_read_only_main_tool() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text("orchestrate smoke")],
    );
    let events = MockScenarioProvider::orchestrate_events(&request);
    let names = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { name, .. },
                ..
            }) => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["read"]);
}

fn tool_result_message(tool_use_id: &str, text: impl Into<String>) -> Message {
    Message::User {
        content: vec![ContentBlock::ToolResult {
            tool_use_id: tool_use_id.to_string(),
            content: vec![ContentBlock::Text { text: text.into() }],
            is_error: Some(false),
        }],
    }
}

fn first_tool(
    events: &[Result<StreamEvent, kcoder_api::ApiErrorKind>],
) -> (String, serde_json::Value) {
    let (tool_index, name) = events
        .iter()
        .find_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                index,
                content_block: ContentBlock::ToolUse { name, .. },
            }) => Some((*index, name.clone())),
            _ => None,
        })
        .expect("scenario should emit one tool");
    let input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                index,
                delta: ContentDelta::InputJsonDelta { partial_json },
            }) if *index == tool_index => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();
    (
        name,
        serde_json::from_str(&input).expect("tool input chunks should form JSON"),
    )
}

#[test]
fn tui_dev_orchestrate_control_scenario_follows_the_structured_control_sequence() {
    const SPAWN_ID: &str = "tui-lab-orchestrate-control-spawn";
    const PAUSE_ID: &str = "tui-lab-orchestrate-control-pause";
    const SEND_ID: &str = "tui-lab-orchestrate-control-send";
    const FLEET_ID: &str = "tui-lab-orchestrate-control-fleet";
    let mut messages = vec![Message::user_text("exercise reliable control")];

    let initial = MessagesRequest::new("tui-dev-mock", messages.clone());
    assert_eq!(
        first_tool(&MockScenarioProvider::orchestrate_control_events(&initial)).0,
        "spawn_agent"
    );

    messages.push(tool_result_message(
        SPAWN_ID,
        r#"{"agent_id":"agent-control","status":"running"}"#,
    ));
    let after_spawn = MessagesRequest::new("tui-dev-mock", messages.clone());
    let (name, input) = first_tool(&MockScenarioProvider::orchestrate_control_events(
        &after_spawn,
    ));
    assert_eq!(name, "ControlAgent");
    assert_eq!(input["agent_id"], "agent-control");
    assert_eq!(input["expected_control_revision"], 0);

    messages.push(tool_result_message(
        PAUSE_ID,
        r#"{"run_mode":"pause_requested"}"#,
    ));
    let after_pause = MessagesRequest::new("tui-dev-mock", messages.clone());
    let (name, input) = first_tool(&MockScenarioProvider::orchestrate_control_events(
        &after_pause,
    ));
    assert_eq!(name, "SendMessage");
    assert_eq!(input["agent_id"], "agent-control");

    messages.push(tool_result_message(SEND_ID, r#"{"status":"queued"}"#));
    let after_send = MessagesRequest::new("tui-dev-mock", messages.clone());
    assert_eq!(
        first_tool(&MockScenarioProvider::orchestrate_control_events(
            &after_send
        ))
        .0,
        "AgentFleet"
    );

    messages.push(tool_result_message(FLEET_ID, r#"{"run_mode":"paused"}"#));
    let after_fleet = MessagesRequest::new("tui-dev-mock", messages);
    let final_text = MockScenarioProvider::orchestrate_control_events(&after_fleet)
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(final_text.contains("tui-lab-orchestrate-control-final-sentinel"));

    let mut resumed_messages = after_fleet.messages.clone();
    resumed_messages.push(Message::assistant_text(final_text));
    resumed_messages.push(Message::user_text("new input after resume"));
    let resumed = MessagesRequest::new_shared("tui-dev-mock", resumed_messages);
    let resumed_text = MockScenarioProvider::orchestrate_control_events(&resumed)
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(resumed_text.contains("new input after resume"));
    assert!(resumed_text.contains("tui-lab-second-turn-sentinel"));
}

#[test]
fn tui_dev_goal_pro_requires_verifier_before_final_response() {
    let parent = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text("complete strict goal")],
    );
    let parent_events = MockScenarioProvider::goal_pro_events(&parent);
    assert!(parent_events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "update_goal"
    )));

    let verifier = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "Independently review this Strict Goal; first line must strictly be PASS",
        )],
    );
    let verifier_text = MockScenarioProvider::goal_pro_events(&verifier)
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(verifier_text.starts_with("PASS"));
}

#[test]
fn tui_dev_goal_pro_does_not_reuse_an_earlier_goal_tool_result() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("We were fixing the resident JSON-RPC transport."),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tui-lab-goal-pro-update".to_string(),
                    name: "update_goal".to_string(),
                    input: serde_json::json!({"status": "complete"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tui-lab-goal-pro-update".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "previous result".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
            Message::user_text("Proceed."),
        ],
    );

    let events = MockScenarioProvider::goal_pro_events(&request);

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "update_goal"
    )));
}

#[test]
fn tui_dev_thinking_preview_streams_multiple_reasoning_deltas() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text("请仔细分析这个问题")],
    );
    let events = MockScenarioProvider::thinking_preview_events(&request);
    let thinking_deltas = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::ThinkingDelta { .. },
                    ..
                })
            )
        })
        .count();

    assert!(thinking_deltas >= 8, "got {thinking_deltas} deltas");
    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockDelta {
            delta: ContentDelta::TextDelta { text },
            ..
        }) if text.contains("thinking preview complete")
    )));
}

#[test]
fn tui_dev_long_write_streams_a_large_write_input() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "测试你的write工具，写一篇2W字的红楼梦，然后删掉他",
        )],
    );
    let events = MockScenarioProvider::long_write_events(&request);
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "write"
    )));
    assert!(tool_input.chars().count() > 20_000, "{}", tool_input.len());
    assert!(tool_input.contains("tui-lab-long-write.txt"));
}

#[test]
fn tui_dev_long_write_path_first_matches_request_without_changing_payload() {
    let mut request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("write")]);
    let input = |request: &MessagesRequest| {
        MockScenarioProvider::long_write_events(request)
            .into_iter()
            .filter_map(|event| match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::InputJsonDelta { partial_json },
                    ..
                }) => Some(partial_json),
                _ => None,
            })
            .collect::<String>()
    };
    let legacy = input(&request);
    request.path_first_tools = true;
    let path_first = input(&request);
    assert!(legacy.starts_with("{\"content\":"));
    assert!(path_first.starts_with("{\"file_path\":\"tui-lab-long-write.txt\",\"content\":"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&legacy).unwrap(),
        serde_json::from_str::<serde_json::Value>(&path_first).unwrap()
    );
}

#[test]
fn tui_dev_busy_wait_calls_a_real_silent_bash_command() {
    let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("wait")]);
    let events = MockScenarioProvider::busy_wait_events(&request);
    let json = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(json.contains("sleep 12"), "{json}");
    assert!(json.contains("tui-lab-busy-wait-start"), "{json}");
    assert!(json.contains("tui-lab-busy-wait-end"), "{json}");
}

#[test]
fn tui_dev_full_turn_starts_with_tool_use() {
    let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("hello tui")]);
    let events = MockScenarioProvider::full_turn_events(&request);
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "bash"
    )));
    assert!(tool_input.contains("tui-lab-tool-line-%03d"));
    assert!(tool_input.contains("\\\"$i\\\""));
}

#[test]
fn tui_dev_scenarios_ignore_injected_skill_notification_examples() {
    let messages = vec![
        Message::user_text("hello tui"),
        Message::user_text(
            "<skill_content name=\"using-superpowers\">\n\
                 Example: inspect <subagent_notification output_file=\"result.txt\"/>.\n\
                 </skill_content>",
        ),
    ];

    for events in [
        MockScenarioProvider::full_turn_events(&MessagesRequest::new(
            "tui-dev-mock",
            messages.clone(),
        )),
        MockScenarioProvider::lsp_diagnostics_events(&MessagesRequest::new(
            "tui-dev-mock",
            messages.clone(),
        )),
        MockScenarioProvider::subagent_trace_events(&MessagesRequest::new(
            "tui-dev-mock",
            messages.clone(),
        )),
    ] {
        assert!(
            events.iter().any(|event| matches!(
                event,
                Ok(StreamEvent::ContentBlockStart {
                    content_block: ContentBlock::ToolUse { .. },
                    ..
                })
            )),
            "an injected skill must not advance a deterministic scenario"
        );
    }
}

#[test]
fn tui_dev_mixed_tools_starts_with_mixed_tool_uses() {
    let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("hello tui")]);
    let events = MockScenarioProvider::mixed_tools_events(&request);
    let names = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { name, .. },
                ..
            }) => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert_eq!(names, vec!["read", "grep", "edit", "TodoWrite", "bash"]);
    assert!(tool_input.contains("src/sample.txt"));
    assert!(tool_input.contains("tui-lab-tool-line-%03d"));
    assert!(tool_input.contains("Verify mixed tool folding"));
    assert!(tool_input.contains("sample workspace file edited by mixed tool scenario"));
}

#[test]
fn tui_dev_lsp_diagnostics_starts_with_python_write_tool() {
    let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("hello lsp")]);
    let events = MockScenarioProvider::lsp_diagnostics_events(&request);
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "write"
    )));
    assert!(tool_input.contains("src/diagnostic-fixture/lsp_case.py"));
    assert!(tool_input.contains("takes_int"));
    assert!(tool_input.contains("not-an-int"));
}

#[test]
fn tui_dev_ocr_review_starts_with_ocr_preview_tool() {
    let request = MessagesRequest::new("tui-dev-mock", vec![Message::user_text("hello ocr")]);
    let events = MockScenarioProvider::ocr_review_events(&request);
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "ocr"
    )));
    assert!(tool_input.contains("\"command\":\"review\""));
    assert!(tool_input.contains("\"preview\":true"));
    assert!(tool_input.contains("\"timeoutMinutes\":1"));
}

#[test]
fn tui_dev_subagent_trace_starts_with_spawn_agent_tool() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text("hello subagent trace")],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { name, .. },
            ..
        }) if name == "spawn_agent"
    )));
    assert!(tool_input.contains("tui-lab-subagent-worker-sentinel"));
    assert!(tool_input.contains("\"agent_type\":\"general\""));
}

#[test]
fn tui_dev_targeted_subagent_trace_starts_two_background_agents() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "app-server-background-subagent tui-lab-targeted-subagent-steer",
        )],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);
    let tools = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { id, name, .. },
                ..
            }) => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(
        tools,
        vec![
            ("tui-lab-spawn-agent", "spawn_agent"),
            ("tui-lab-spawn-agent-sibling", "spawn_agent"),
        ]
    );
    let tool_input = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { partial_json },
                ..
            }) => Some(partial_json.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(tool_input.matches("\"run_in_background\":true").count(), 2);
}

#[test]
fn tui_dev_targeted_subagent_stop_starts_two_background_agents() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "app-server-background-subagent tui-lab-targeted-subagent-stop",
        )],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);
    let tools = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { id, name, .. },
                ..
            }) => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(
        tools,
        vec![
            ("tui-lab-spawn-agent", "spawn_agent"),
            ("tui-lab-spawn-agent-sibling", "spawn_agent"),
        ]
    );
}

#[test]
fn tui_dev_subagent_trace_worker_finishes_without_recursive_spawn() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "You are a KCoder general sub-agent.\n\nTask:\ntui-lab-subagent-worker-sentinel\n\nGlobal sub-agent contract:",
        )],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);

    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(text.contains("tui-lab-subagent-worker-done"));
}

#[test]
fn tui_dev_targeted_subagent_worker_emits_long_transcript_fixture() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "You are a KCoder general sub-agent.\n\nTask:\ntui-lab-subagent-worker-sentinel tui-lab-targeted-subagent-steer-long-transcript\n\nGlobal sub-agent contract:",
        )],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("tui-lab-child-line-001"));
    assert!(text.contains("tui-lab-child-line-180"));
}

#[test]
fn tui_dev_subagent_trace_notification_followup_does_not_spawn_again() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("hello subagent trace"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tui-lab-spawn-agent".to_string(),
                    name: "spawn_agent".to_string(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tui-lab-spawn-agent".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "{\"status\":\"running\"}".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
            Message::user_text(
                "<subagent_notification id=\"job-1\" status=\"completed\" output_file=\"/tmp/output.md\"/>",
            ),
        ],
    );
    let events = MockScenarioProvider::subagent_trace_events(&request);

    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(text.contains("subagent completion notification observed"));
}

#[test]
fn tui_dev_full_turn_finishes_after_tool_result() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("hello tui"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tui-lab-counted-lines".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tui-lab-counted-lines".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "done".to_string(),
                    }],
                    is_error: None,
                }],
            },
        ],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("tui-lab-final-sentinel"));
    assert!(text.contains("tui-lab-final-line-001"));
    assert!(text.contains("tui-lab-final-line-120"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_full_turn_recognizes_user_input_after_tool_result_as_live_steer() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("first request"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tui-lab-counted-lines".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tui-lab-counted-lines".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "done".to_string(),
                    }],
                    is_error: None,
                }],
            },
            Message::user_text("new constraint while the tool was running"),
        ],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("tui-lab-live-steer-sentinel"));
    assert!(text.contains("new constraint while the tool was running"));
    assert!(text.contains("tui-lab-final-sentinel"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_lsp_diagnostics_reports_visibility_after_tool_result() {
    let request = MessagesRequest::new(
            "tui-dev-mock",
            vec![
                Message::user_text("hello lsp"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolUse {
                        id: "tui-lab-lsp-write".to_string(),
                        name: "write".to_string(),
                        input: serde_json::json!({}),
                    }],
                    usage: None,
                },
                Message::User {
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-lsp-write".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "<diagnostics source=\"lsp\" server=\"pyright\" file=\"src/lsp_case.py\">\nERROR [6:25] bad [reportArgumentType] (pyright)\n</diagnostics>".to_string(),
                        }],
                        is_error: None,
                    }],
                },
            ],
        );
    let events = MockScenarioProvider::lsp_diagnostics_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let thinking = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ThinkingDelta { thinking },
                ..
            }) => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("LSP diagnostics scenario complete"));
    assert!(text.contains("contains real pyright LSP diagnostics"));
    assert!(text.contains("tui-lab-lsp-diagnostics-final-sentinel"));
    assert!(text.contains("tui-lab-final-sentinel"));
    assert!(thinking.contains("LSP diagnostics visible: true"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_ocr_review_reports_preview_visibility_after_tool_result() {
    let request = MessagesRequest::new(
            "tui-dev-mock",
            vec![
                Message::user_text("hello ocr"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolUse {
                        id: "tui-lab-ocr-preview".to_string(),
                        name: "ocr".to_string(),
                        input: serde_json::json!({}),
                    }],
                    usage: None,
                },
                Message::User {
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-ocr-preview".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "OpenCodeReview command: ocr review --preview\nPreview: 1 file(s) changed".to_string(),
                        }],
                        is_error: None,
                    }],
                },
            ],
        );
    let events = MockScenarioProvider::ocr_review_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let thinking = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ThinkingDelta { thinking },
                ..
            }) => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("OCR preview scenario complete"));
    assert!(text.contains("contains OpenCodeReview preview output"));
    assert!(text.contains("tui-lab-ocr-review-final-sentinel"));
    assert!(text.contains("tui-lab-final-sentinel"));
    assert!(thinking.contains("preview visible: true"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_mixed_tools_finishes_after_tool_results() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("hello tui"),
            Message::Assistant {
                content: vec![
                    ContentBlock::ToolUse {
                        id: "tui-lab-mixed-read".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({}),
                    },
                    ContentBlock::ToolUse {
                        id: "tui-lab-mixed-grep".to_string(),
                        name: "grep".to_string(),
                        input: serde_json::json!({}),
                    },
                    ContentBlock::ToolUse {
                        id: "tui-lab-mixed-todo".to_string(),
                        name: "TodoWrite".to_string(),
                        input: serde_json::json!({}),
                    },
                    ContentBlock::ToolUse {
                        id: "tui-lab-mixed-bash".to_string(),
                        name: "bash".to_string(),
                        input: serde_json::json!({}),
                    },
                    ContentBlock::ToolUse {
                        id: "tui-lab-mixed-edit".to_string(),
                        name: "edit".to_string(),
                        input: serde_json::json!({}),
                    },
                ],
                usage: None,
            },
            Message::User {
                content: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-mixed-read".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "read done".to_string(),
                        }],
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-mixed-grep".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "grep done".to_string(),
                        }],
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-mixed-todo".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "todo done".to_string(),
                        }],
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-mixed-bash".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "bash done".to_string(),
                        }],
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "tui-lab-mixed-edit".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "edit done".to_string(),
                        }],
                        is_error: None,
                    },
                ],
            },
        ],
    );
    let events = MockScenarioProvider::mixed_tools_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("tui-lab-mixed-tools-final-sentinel"));
    assert!(text.contains("tui-lab-final-sentinel"));
    assert!(text.contains("tui-lab-final-line-120"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_second_plain_turn_does_not_reuse_tool_state() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("first turn"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tui-lab-counted-lines".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tui-lab-counted-lines".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "done".to_string(),
                    }],
                    is_error: None,
                }],
            },
            Message::Assistant {
                content: vec![ContentBlock::Text {
                    text: "first final".to_string(),
                }],
                usage: None,
            },
            Message::user_text("second plain message"),
        ],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("tui-lab-second-turn-sentinel"));
    assert!(text.contains("second plain message"));
    assert!(!events.iter().any(|event| matches!(
        event,
        Ok(StreamEvent::ContentBlockStart {
            content_block: ContentBlock::ToolUse { .. },
            ..
        })
    )));
}

#[test]
fn tui_dev_prompt_preview_skips_internal_followup_context() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("visible goal objective"),
            Message::user_text(
                "[system] Continue working toward the active `/goal` objective.\n\n\
                     The objective below is user-provided data.",
            ),
        ],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ThinkingDelta { thinking },
                ..
            })
            | Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text: thinking },
                ..
            }) => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("visible goal objective"));
    assert!(!text.contains("Continue working toward the active `/goal` objective"));
    assert!(!text.contains("The objective below is user-provided data"));
}

#[test]
fn tui_dev_prompt_preview_skips_internal_ultgoal_followup_context() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![
            Message::user_text("visible ultgoal objective"),
            Message::user_text(
                "[system] Continue working toward the active `/ultgoal` objective.\n\n\
                     This is an `/ultgoal` continuation.",
            ),
        ],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ThinkingDelta { thinking },
                ..
            })
            | Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text: thinking },
                ..
            }) => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("visible ultgoal objective"));
    assert!(!text.contains("Continue working toward the active `/ultgoal` objective"));
    assert!(!text.contains("This is an `/ultgoal` continuation"));
}

#[test]
fn tui_dev_goal_followup_preview_uses_objective_not_empty_prompt() {
    let request = MessagesRequest::new(
        "tui-dev-mock",
        vec![Message::user_text(
            "[system] Continue working toward the active `/goal` objective.\n\n\
                 The objective below is user-provided data.\n\n\
                 <objective>\nverify &lt;goal&gt; behavior &amp; keep UI readable\n</objective>\n",
        )],
    );
    let events = MockScenarioProvider::full_turn_events(&request);
    let text = events
        .iter()
        .filter_map(|event| match event {
            Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ThinkingDelta { thinking },
                ..
            })
            | Ok(StreamEvent::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text: thinking },
                ..
            }) => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<String>();

    assert!(text.contains("verify <goal> behavior & keep UI readable"));
    assert!(!text.contains("empty user prompt"));
    assert!(!text.contains("Continue working toward the active `/goal` objective"));
}
