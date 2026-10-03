#[derive(Debug)]
struct UsageThenTextProvider {
    usage: Usage,
}

impl Provider for UsageThenTextProvider {
    fn name(&self) -> &'static str {
        "usage-then-text"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let usage = self.usage.clone();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(usage),
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "should not stream after budget".to_string(),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn goal_feature_disabled_hides_and_rejects_goal_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        goal_enabled: false,
        ..Settings::default()
    };
    let engine = QueryEngine::new(
        Arc::new(EmptyProvider),
        AppState::new(tmp.path()),
        kcoder_tools::default_registry(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );

    let tool_names = engine
        .tool_definitions_for_model()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!tool_names.iter().any(|name| is_goal_tool_name(name)));

    let (output, decision, _, _) = engine
        .execute_tool(
            "tool-1",
            "get_goal",
            serde_json::json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
}

#[tokio::test]
async fn goal_budget_trip_lets_in_flight_response_finish_within_grace() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(UsageThenTextProvider {
            usage: Usage {
                input_tokens: 20,
                output_tokens: 1,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            },
        }),
        tmp.path(),
        Settings::default(),
    );
    engine.state.set_goal_prepared_with_mode(
        "orchestrate under budget",
        None,
        Some(10),
        kcoder_state::GoalMode::Arrangement,
    );
    engine.state.add_message(Message::user_text("go"));
    let running_agent = engine
        .background_jobs
        .spawn_subagent_with_cap(
            "Plan agent: slow plan",
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                ToolOutput::text("should not finish")
            }),
            Some(1),
        )
        .expect("background subagent should start");

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = engine.run_turn_stream(&prompt).collect::<Vec<_>>().await;

    assert!(events.iter().any(|event| {
            matches!(event, EngineEvent::SystemNotice(text) if text.contains("UltGoal token budget reached") && text.contains("Cancelled 1 running sub-agent") && text.contains("grace"))
        }));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. })),
        "the in-flight response must finish within the grace instead of aborting"
    );
    assert_eq!(
        engine.state.goal().unwrap().status,
        kcoder_state::GoalStatus::BudgetLimited
    );
    assert!(engine.state.task(&running_agent).is_none());
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("should not stream")),
        "the wrap-up response must be preserved in history"
    );
}

#[tokio::test]
async fn goal_budget_grace_overflow_aborts_but_preserves_partial_response() {
    #[derive(Debug)]
    struct GraceOverflowProvider;

    impl Provider for GraceOverflowProvider {
        fn name(&self) -> &'static str {
            "grace-overflow"
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            let stream = async_stream::stream! {
                yield Ok(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: None,
                        stop_sequence: None,
                        usage: Some(Usage {
                            input_tokens: 20,
                            output_tokens: 1,
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: None,
                            total_tokens: None,
                            iterations: None,
                        }),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: "partial wrap-up text".to_string(),
                    },
                });
                // Exceed the 4000-token grace: the wrap-up keeps spending.
                yield Ok(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: None,
                        stop_sequence: None,
                        usage: Some(Usage {
                            input_tokens: 20,
                            output_tokens: 6_000,
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: None,
                            total_tokens: None,
                            iterations: None,
                        }),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: " NEVER STREAMED".to_string(),
                    },
                });
                yield Ok(StreamEvent::MessageStop);
            };
            Ok(Box::pin(stream))
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(GraceOverflowProvider),
        tmp.path(),
        Settings::default(),
    );
    engine
        .state
        .set_goal_prepared("wrap up under budget", None, Some(10));
    engine.state.add_message(Message::user_text("go"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = engine.run_turn_stream(&prompt).collect::<Vec<_>>().await;

    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::StreamAborted { reason } if reason.contains("grace exhausted"))
    }));
    assert_eq!(
        engine.state.goal().unwrap().status,
        kcoder_state::GoalStatus::BudgetLimited
    );
    let transcript: String = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(4096))
        .collect();
    assert!(
        transcript.contains("partial wrap-up text"),
        "the preserved partial response is missing: {transcript}"
    );
    assert!(
        transcript.contains("turn truncated: goal token budget exhausted"),
        "the truncation note is missing: {transcript}"
    );
    assert!(
        !transcript.contains("NEVER STREAMED"),
        "content after the grace cut-off must not be preserved: {transcript}"
    );
}

#[tokio::test]
async fn goal_budget_trip_stops_turn_at_next_subturn_boundary() {
    #[derive(Debug)]
    struct ToolCallAfterTripProvider {
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Provider for ToolCallAfterTripProvider {
        fn name(&self) -> &'static str {
            "tool-call-after-trip"
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let stream = async_stream::stream! {
                yield Ok(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: None,
                        stop_sequence: None,
                        usage: Some(Usage {
                            input_tokens: 20,
                            output_tokens: 1,
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: None,
                            total_tokens: None,
                            iterations: None,
                        }),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "call-1".to_string(),
                        name: "bash".to_string(),
                        input: serde_json::json!({}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: r#"{"command":"echo boundary-tool-ran"}"#.to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            };
            Ok(Box::pin(stream))
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let engine = test_engine_with_settings(
        Arc::new(ToolCallAfterTripProvider {
            calls: Arc::clone(&calls),
        }),
        tmp.path(),
        Settings::default(),
    );
    engine
        .state
        .set_goal_prepared("stop at the boundary", None, Some(10));
    engine.state.add_message(Message::user_text("go"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = engine.run_turn_stream(&prompt).collect::<Vec<_>>().await;

    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("no further API calls"))
    }));
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no new API call may start once the budget has tripped"
    );
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("boundary-tool-ran")),
        "tool calls in the finishing response still execute"
    );
    assert_eq!(
        engine.state.goal().unwrap().status,
        kcoder_state::GoalStatus::BudgetLimited
    );
}

#[tokio::test]
async fn goal_audit_epoch_counts_outer_execution_not_host_scheduling() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(UsageThenTextProvider { usage: Usage {
            input_tokens: 1, output_tokens: 1,
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            total_tokens: None, iterations: None,
        }}), tmp.path(), Settings::default(),
    );
    let goal = engine.state.set_goal("ship", None);
    for expected in [1, 2] {
        if expected == 2 { engine.state.record_goal_continuation_start(&goal.goal_id); }
        engine.state.add_message(Message::user_text("continue"));
        let _ = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        assert_eq!(engine.state.goal().unwrap().turn_count, expected);
    }
    assert_eq!(engine.state.goal().unwrap().continuation_count, 1);
}

#[tokio::test]
async fn goal_audit_explicit_cancel_stops_turn_and_live_subagents() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    engine.state.set_goal("ship", None);
    let id = engine.background_jobs.spawn_subagent_with_cap("owned agent", Box::pin(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        ToolOutput::text("unexpected completion")
    }), Some(1)).unwrap();
    engine.state.update_goal_status(kcoder_state::GoalStatus::Cancelled);
    let turn_cancel = CancellationToken::new();
    assert_eq!(engine.cancel_goal_execution(Some(&turn_cancel)), 1);
    assert!(turn_cancel.is_cancelled());
    assert!(!engine.cancel_token().is_cancelled(), "the reusable engine must accept later conversations");
    assert!(!engine.state.tasks().contains_key(&id));
    assert_eq!(engine.state.goal().unwrap().status, kcoder_state::GoalStatus::Cancelled);
}
