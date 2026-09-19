#[test]
fn append_moa_context_adds_private_block_to_latest_user_text() {
    let messages = vec![
        Message::user_text("first"),
        Message::assistant_text("answer"),
        Message::user_text("latest"),
    ];
    let context = moa_reference_context(
        "default",
        &MoaModelConfig::new("minimax", "MiniMax-M3"),
        &[MoaReferenceOutput {
            index: 0,
            label: "minimax:MiniMax-M2.7".to_string(),
            text: "aggregated advice".to_string(),
        }],
    );

    let enhanced = append_moa_context(messages.into(), &context);
    let last_text = match enhanced.last().unwrap() {
        Message::User { content } => content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .unwrap(),
        _ => panic!("expected latest message to remain user"),
    };

    assert!(last_text.starts_with("latest"));
    assert!(last_text.contains("[Mixture of Agents reference context]"));
    assert!(last_text.contains("Aggregator/acting model: minimax:MiniMax-M3"));
    assert!(last_text.contains("Reference 1"));
    assert!(last_text.contains("aggregated advice"));
}

#[test]
fn append_moa_context_adds_trailing_user_when_latest_message_is_not_user() {
    let messages = vec![
        Message::user_text("first"),
        Message::assistant_text("answer"),
    ];
    let context = moa_reference_context(
        "default",
        &MoaModelConfig::new("minimax", "MiniMax-M3"),
        &[MoaReferenceOutput {
            index: 0,
            label: "minimax:MiniMax-M2.7".to_string(),
            text: "private advice".to_string(),
        }],
    );

    let enhanced = append_moa_context(messages.into(), &context);

    assert_eq!(enhanced.len(), 3);
    let last_text = match enhanced.last().unwrap() {
        Message::User { content } => content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .unwrap(),
        _ => panic!("expected MoA context to be appended as a trailing user message"),
    };
    assert!(last_text.starts_with("[Mixture of Agents reference context]"));
    assert!(last_text.contains("private advice"));
}

#[test]
fn moa_reference_messages_flatten_tools_but_strip_thinking_blocks() {
    let messages = vec![
        Message::user_text("please inspect"),
        Message::Assistant {
            content: vec![
                ContentBlock::Thinking {
                    thinking: "hidden reasoning".to_string(),
                    signature: String::new(),
                },
                ContentBlock::Text {
                    text: "visible assistant text".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    input: serde_json::json!({"file_path": "secret.txt"}),
                },
            ],
            usage: None,
        },
        Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: "tool-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "tool output".to_string(),
            }],
            is_error: Some(false),
        }]),
    ];

    let projected = moa_reference_messages(&messages);
    let rendered = projected
        .iter()
        .map(|message| message.preview(4096))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(rendered.contains("please inspect"));
    assert!(rendered.contains("visible assistant text"));
    assert!(rendered.contains("[called tool: read({\"file_path\":\"secret.txt\"})]"));
    assert!(rendered.contains("[tool result: ok id=tool-1]"));
    assert!(rendered.contains("tool output"));
    assert!(rendered.contains("provide concise private guidance"));
    assert!(!rendered.contains("hidden reasoning"));
    assert_eq!(projected.last().unwrap().role(), MessageRole::User);
}

#[tokio::test]
async fn run_moa_references_returns_failed_reference_outputs() {
    let preset = MoaPresetConfig {
        reference_models: vec![MoaModelConfig::new("missing-provider", "MissingModel")],
        ..MoaPresetConfig::default()
    };

    let outputs = run_moa_references(
        Settings::default(),
        preset,
        &vec![Message::user_text("hello")].into(),
        "test-session".to_string(),
        CancellationToken::new(),
        1,
    )
    .await
    .unwrap();

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].label, "missing-provider:MissingModel");
    assert!(outputs[0].text.starts_with("[failed:"));
}

#[test]
fn moa_context_detaches_only_the_latest_user_payload() {
    let original = kcoder_types::SharedMessages::from(vec![
        Message::user_text("large history".repeat(100_000)),
        Message::assistant_text("stable answer"),
        Message::user_text("latest"),
    ]);
    let enhanced = append_moa_context(original.clone(), "private advice");
    for index in 0..2 {
        assert!(std::ptr::eq(&original[index], &enhanced[index]));
    }
    assert!(!std::ptr::eq(&original[2], &enhanced[2]));
    assert_eq!(original[2], Message::user_text("latest"));
    assert_eq!(enhanced[2], Message::user_text("latest\n\nprivate advice"));
}

#[test]
fn moa_context_trailing_user_keeps_all_existing_payloads_shared() {
    let original = kcoder_types::SharedMessages::from(vec![
        Message::user_text("request"),
        Message::assistant_text("answer"),
    ]);
    let enhanced = append_moa_context(original.clone(), "advice");
    for index in 0..original.len() {
        assert!(std::ptr::eq(&original[index], &enhanced[index]));
    }
    assert_eq!(enhanced[2], Message::user_text("advice"));
    assert_eq!(original.len(), 2);
}

#[test]
fn moa_reference_projection_accepts_borrowed_shared_messages() {
    let original = kcoder_types::SharedMessages::from(vec![
        Message::user_text("request"),
        Message::assistant_text("answer"),
    ]);
    let retained = original.clone();
    let projected = moa_reference_messages(&original);
    assert_eq!(projected, moa_reference_messages(&original.to_vec()));
    for index in 0..original.len() {
        assert!(std::ptr::eq(&original[index], &retained[index]));
    }
}

#[test]
fn reject_recursive_moa_provider_blocks_moa_provider_slots() {
    assert!(reject_recursive_moa_provider("moa").is_err());
    assert!(reject_recursive_moa_provider("minimax").is_ok());
}

#[test]
fn resolve_moa_model_current_uses_active_settings() {
    let settings = Settings {
        provider: Some("kunlunmeta".to_string()),
        model: "MiniMax-M3".to_string(),
        ..Settings::default()
    };
    let resolved = resolve_moa_model(&settings, &MoaModelConfig::new("current", "")).unwrap();

    assert_eq!(resolved.provider, "kunlunmeta");
    assert_eq!(resolved.model, "MiniMax-M3");
}
