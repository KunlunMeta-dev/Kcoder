#[derive(Debug)]
struct StopHookRequestRecorder {
    inner: SequentialEventsProvider,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for StopHookRequestRecorder {
    fn name(&self) -> &'static str {
        "stop-hook-request-recorder"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request.clone());
        self.inner.stream_messages(request)
    }
}

#[tokio::test]
async fn stop_hooks_do_not_abandon_pending_tools() {
    for fail_hook in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let hook_command = match (cfg!(windows), fail_hook) {
            (true, false) => {
                "Add-Content stop-hook-runs.txt stop; Write-Output '{\"continue\":false}'"
            }
            (true, true) => "Add-Content stop-hook-runs.txt stop; exit 1",
            (false, false) => "echo stop >> stop-hook-runs.txt; printf '{\"continue\":false}'",
            (false, true) => "echo stop >> stop-hook-runs.txt; exit 1",
        };
        let hook_settings = serde_json::from_value(serde_json::json!({
            "Stop": [{ "hooks": [{ "type": "command", "command": hook_command }] }]
        }))
        .unwrap();
        let mut tool_events = named_tool_call_events(
            "inspect-file",
            "input_echo",
            serde_json::json!({"file": "document.docx"}),
        );
        tool_events.splice(
            4..4,
            [
                StreamEvent::ContentBlockStart {
                    index: 1,
                    content_block: ContentBlock::ToolUse {
                        id: "inspect-converters".into(),
                        name: "input_echo".into(),
                        input: serde_json::json!({"converter": "python"}),
                    },
                },
                StreamEvent::ContentBlockStop { index: 1 },
            ],
        );
        let (provider, calls) = SequentialEventsProvider::new(vec![
            tool_events,
            simple_text_events("Document inspection finished."),
        ]);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut engine = TestEngineBuilder::new(tmp.path())
            .provider(Arc::new(StopHookRequestRecorder {
                inner: provider,
                requests: Arc::clone(&requests),
            }))
            .settings(Settings {
                permission_mode: PermissionMode::Bypass,
                ..Settings::default()
            })
            .tool_registry(ToolRegistry::new().register(InputEchoTool {
                seen: Arc::clone(&seen),
            }))
            .build_with_profile_directory();
        engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(hook_settings);
        *engine.settings_persistence_target.write().unwrap() = SettingsPersistenceTarget::Disabled;
        engine.state.set_usage_history_root(None);
        let history = tmp.path().join("session.jsonl");
        engine.state.with_history_path(&history);
        engine
            .state
            .add_message(Message::user_text("Inspect the attached document."));

        let events = engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        engine.state.flush_history().await.unwrap();

        assert_eq!(
            seen.lock().unwrap().len(),
            2,
            "Stop must not intercept pending tools; fail_hook={fail_hook}; events={events:?}"
        );
        assert_eq!(
            *calls.lock().unwrap(),
            2,
            "the model must receive the real tool result"
        );
        let next_request = &requests.lock().unwrap()[1];
        for expected in ["inspect-file", "inspect-converters"] {
            assert!(
                next_request.messages.iter().any(|message| matches!(message,
                    Message::User { content, .. } if content.iter().any(|block| matches!(block,
                        ContentBlock::ToolResult { tool_use_id, content, is_error }
                            if tool_use_id == expected && *is_error != Some(true)
                                && !content_blocks_plain_text(content).contains("interrupted")
                    ))
                )),
                "the next request must contain the real result for {expected}"
            );
        }
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event,
                    EngineEvent::ToolResult { output, .. } if !output.is_error
                ))
                .count(),
            2
        );
        let history = kcoder_state::load_history(&history).unwrap();
        for expected in ["inspect-file", "inspect-converters"] {
            assert!(
                history.iter().any(|entry| matches!(&entry.message,
                    Message::User { content, .. } if content.iter().any(|block| matches!(block,
                        ContentBlock::ToolResult { tool_use_id, is_error, .. }
                            if tool_use_id == expected && *is_error != Some(true)
                    ))
                )),
                "the tool result {expected} must survive history reload"
            );
        }
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("stop-hook-runs.txt"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn pre_tool_hook_still_blocks_execution_at_the_tool_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let hook_command = if cfg!(windows) {
        "Write-Output '{\"continue\":false}'"
    } else {
        "printf '{\"continue\":false}'"
    };
    let hook_settings = serde_json::from_value(serde_json::json!({
        "PreToolUse": [{ "hooks": [{ "type": "command", "command": hook_command }] }]
    }))
    .unwrap();
    let (provider, _) = SequentialEventsProvider::new(vec![
        named_tool_call_events(
            "blocked",
            "input_echo",
            serde_json::json!({"file":"document.docx"}),
        ),
        simple_text_events("Document inspection was denied."),
    ]);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut engine = TestEngineBuilder::new(tmp.path())
        .provider(Arc::new(provider))
        .settings(Settings {
            permission_mode: PermissionMode::Bypass,
            ..Settings::default()
        })
        .tool_registry(ToolRegistry::new().register(InputEchoTool {
            seen: Arc::clone(&seen),
        }))
        .build_with_profile_directory();
    engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(hook_settings);
    *engine.settings_persistence_target.write().unwrap() = SettingsPersistenceTarget::Disabled;
    engine.state.set_usage_history_root(None);
    engine
        .state
        .add_message(Message::user_text("Inspect the attached document."));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(seen.lock().unwrap().is_empty());
    assert!(
        events.iter().any(|event| matches!(event,
            EngineEvent::ToolResult { id, output, .. } if id == "blocked" && output.is_error
        )),
        "a denied tool must still return a real result to the model"
    );
}
