use super::*;

#[derive(Debug, Default)]
struct StreamHttpCompactionProvider {
    main_requests: std::sync::Mutex<Vec<MessagesRequest>>,
    summary_requests: Arc<AtomicUsize>,
    repeat_error: bool,
    sse_error: bool,
    partial: Vec<StreamEvent>,
    fail_summary: bool,
    hang_summary: bool,
    summary_started: tokio::sync::Notify,
    summary_dropped: Arc<AtomicUsize>,
    failed_stream_dropped: Arc<AtomicUsize>,
}

impl Provider for StreamHttpCompactionProvider {
    fn name(&self) -> &'static str {
        "stream-http-compaction"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        if request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        }) {
            assert_eq!(self.failed_stream_dropped.load(Ordering::SeqCst), 1);
            if self.fail_summary || self.hang_summary {
                self.summary_requests.fetch_add(1, Ordering::SeqCst);
                self.summary_started.notify_one();
                if self.hang_summary {
                    let guard = PrefireStreamDrop(self.summary_dropped.clone());
                    return Ok(Box::pin(async_stream::stream! {
                        let _guard = guard;
                        std::future::pending::<()>().await;
                        yield Ok(StreamEvent::MessageStop);
                    }));
                }
                return Err(kcoder_api::ApiErrorKind::Api {
                    error_type: "invalid_request_error".into(),
                    message: "summary fixture failure".into(),
                });
            }
            return SummaryCountingProvider {
                requests: self.summary_requests.clone(),
            }
            .stream_messages(request);
        }
        let mut requests = self.main_requests.lock().unwrap();
        requests.push(request.clone());
        if requests.len() == 1 || self.repeat_error {
            let failure = if self.sse_error {
                Ok(StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: "context_length_exceeded".into(),
                        message: "context rejected".into(),
                    },
                })
            } else {
                Err(kcoder_api::ApiErrorKind::Http {
                    error_type: "invalid_request_error".into(),
                    message: "context rejected".into(),
                    metadata: kcoder_api::HttpErrorMetadata {
                        status: 400,
                        provider_code: Some("context_length_exceeded".into()),
                        provider_type: None,
                        rejected_reasoning_parameter: None,
                        retry_after: None,
                    },
                })
            };
            let events = self
                .partial
                .iter()
                .cloned()
                .map(Ok)
                .chain([failure])
                .collect::<Vec<_>>();
            let guard = PrefireStreamDrop(self.failed_stream_dropped.clone());
            return Ok(Box::pin(async_stream::stream! {
                let _guard = guard;
                for event in events {
                    yield event;
                }
                std::future::pending::<()>().await;
            }));
        }
        SummaryCountingProvider {
            requests: Arc::new(AtomicUsize::new(0)),
        }
        .stream_messages(request)
    }
}

fn stream_http_compaction_engine(cwd: &Path, provider: Arc<dyn Provider>) -> QueryEngine {
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(100_000);
    settings.auto_compact_threshold_tokens = Some(90_000);
    settings.prefire_threshold_tokens = Some(90_000);
    settings.context_output_headroom = Some(2_000);
    settings.max_tokens = Some(1_000);
    settings.estimated_tool_growth_tokens = Some(1);
    settings.session_memory.enabled = false;
    let engine = test_engine_with_settings(provider, cwd, settings);
    engine.state.set_messages(vec![
        Message::user_text("old request ".repeat(1_000)),
        Message::assistant_text("old response ".repeat(1_000)),
        Message::user_text("middle request ".repeat(1_000)),
        Message::assistant_text("middle response ".repeat(1_000)),
        Message::user_text("recent request"),
        Message::assistant_text("recent response"),
        Message::user_text("current request must remain verbatim"),
    ]);
    engine
}

async fn recovery_records(engine: &QueryEngine, root: &Path) -> Vec<serde_json::Value> {
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + std::time::Duration::from_secs(3))
            .await
    );
    std::fs::read_dir(root.join("recovery"))
        .unwrap()
        .map(|entry| {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(bytes.len() <= 16 * 1024);
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 4);
            assert!(
                value["request_id"]
                    .as_str()
                    .is_some_and(|id| id.len() == 36)
            );
            for record in value["records"].as_array().unwrap() {
                assert_eq!(record.as_object().unwrap().len(), 3);
                assert!(record["invocation"].is_u64());
                assert!(record["decision"].is_string());
                assert!(record["outcome"].is_string());
            }
            value
        })
        .collect()
}

#[tokio::test]
async fn recovery_record_cancel_or_drop_during_retry_wait() {
    use futures::StreamExt;
    for abandon in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode: "backoff",
            calls: AtomicUsize::new(0),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "wait-fixture");
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let cancel = CancellationToken::new();
        let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
        while let Some(event) = stream.next().await {
            if matches!(event, crate::EngineEvent::ProviderRetry(_)) {
                if abandon {
                    break;
                }
                cancel.cancel();
            }
        }
        drop(stream);
        let records = recovery_records(&engine, tmp.path()).await;
        assert_eq!(records.len(), 1);
        let outcome = if abandon { "abandoned" } else { "cancelled" };
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "retry_wait" && r["outcome"] == outcome),
            "{records:?}"
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn recovery_record_hard_gate_stop_is_known_not_abandoned() {
    for training in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(SummaryCountingProvider {
            requests: Arc::new(AtomicUsize::new(0)),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider)
            .with_subagent_system_prompt(Some("fixed system instruction ".repeat(30_000)));
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "hard-gate-fixture");
        {
            let mut settings = engine.settings.write().unwrap();
            settings.training_mode = training;
            settings.context_hard_input_tokens = Some(20_000);
        }
        let events = collect_stream_http_events(&engine).await;
        let records = recovery_records(&engine, tmp.path()).await;
        let outcome = if training {
            "policy_rejected"
        } else {
            "budget_rejected"
        };
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "stop"
                    && r["outcome"] == outcome
                    && r["invocation"] == 0),
            "{records:?} {events:?}"
        );
    }
}

#[tokio::test]
async fn stream_http_context_compacts_and_rebuilds_main_request_once() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events: Vec<_> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine.run_turn_stream(&prompt).collect(),
    )
    .await
    .expect("reactive compaction must not retain the failed request admission");
    assert!(!tmp.path().join("recovery").exists());
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    let requests = provider.main_requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "{events:?}");
    assert!(
        TokenCounter::count(&requests[1].messages) < TokenCounter::count(&requests[0].messages)
    );
    assert!(
        TokenCounter::count_request(&requests[1], true).tokens
            < TokenCounter::count_request(&requests[0], true).tokens
    );
    assert!(requests[1].messages.iter().any(|message| {
        message
            .preview(1_000)
            .contains("current request must remain verbatim")
    }));
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed"))));
    assert!(!events.iter().any(|event| matches!(
        event,
        crate::EngineEvent::Error(_)
            | crate::EngineEvent::ProviderFailed { .. }
            | crate::EngineEvent::ProviderRetry(_)
    )));
}

async fn collect_stream_http_events(engine: &QueryEngine) -> Vec<crate::EngineEvent> {
    use futures::StreamExt;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect(),
    )
    .await
    .expect("stream recovery must terminate promptly")
}

#[derive(Debug, Default)]
struct CompactionRetryBudgetProvider {
    inner: StreamHttpCompactionProvider,
    main_calls: AtomicUsize,
    tool_round: bool,
}

impl Provider for CompactionRetryBudgetProvider {
    fn name(&self) -> &'static str {
        "compaction-retry-budget"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        if request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        }) {
            return self.inner.stream_messages(request);
        }
        let call = self.main_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 1 || call == 3 || (self.tool_round && call == 5) {
            return Err(kcoder_api::ApiErrorKind::Http {
                error_type: "server_error".into(),
                message: "transient budget fixture".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            });
        }
        if self.tool_round && call == 4 {
            return Ok(Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "budget-tool".into(),
                        name: "read".into(),
                        input: serde_json::json!({}),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: serde_json::json!({"file_path": std::path::PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root")).join("crates/kcoder_engine/Cargo.toml")}).to_string(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ])));
        }
        self.inner.stream_messages(request)
    }
}

#[tokio::test]
async fn reactive_compaction_preserves_logical_request_retry_budget() {
    for (max_retries, tool_round, expected_calls, expected_attempts) in [
        (1, false, 3, vec![1]),
        (2, false, 4, vec![1, 2]),
        (2, true, 6, vec![1, 2, 1]),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(CompactionRetryBudgetProvider {
            tool_round,
            ..Default::default()
        });
        let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "recovery-fixture");
        engine.tools = ToolRegistry::new().register(kcoder_tools::FileReadTool);
        {
            let mut settings = engine.settings.write().unwrap();
            settings.max_retries = max_retries;
            settings.retry_base_delay_ms = 0;
        }
        let events = collect_stream_http_events(&engine).await;
        assert!(
            engine
                .state
                .flush_diagnostics_until(
                    std::time::Instant::now() + std::time::Duration::from_secs(2)
                )
                .await
        );
        let records: Vec<serde_json::Value> = std::fs::read_dir(tmp.path().join("recovery"))
            .unwrap()
            .map(|entry| {
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
            })
            .collect();
        assert_eq!(records.len(), if tool_round { 2 } else { 1 });
        let first = records
            .iter()
            .find(|record| {
                record["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "compact")
            })
            .unwrap();
        let invocations: Vec<_> = first["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["decision"] == "invoke")
            .map(|r| r["invocation"].as_u64().unwrap())
            .collect();
        assert_eq!(
            invocations,
            if max_retries == 1 {
                vec![1, 2, 3]
            } else {
                vec![1, 2, 3, 4]
            }
        );
        assert!(
            first["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "compact"
                    && r["outcome"] == "compact_succeeded"
                    && r["invocation"] == 2)
        );
        assert!(
            first["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "retry_wait" && r["outcome"] == "wait_completed")
        );
        if max_retries == 1 {
            assert!(
                first["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["outcome"] == "budget_rejected")
            );
        } else {
            assert!(
                first["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "invoke" && r["outcome"] == "success")
            );
        }
        if tool_round {
            assert_ne!(records[0]["request_id"], records[1]["request_id"]);
        }
        let attempts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                crate::EngineEvent::ProviderRetry(details) => Some(details.attempt),
                _ => None,
            })
            .collect();
        assert_eq!(attempts, expected_attempts, "{events:?}");
        assert_eq!(
            provider.main_calls.load(Ordering::SeqCst),
            expected_calls,
            "{events:?}"
        );
        assert_eq!(provider.inner.summary_requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            events.iter().any(|event| matches!(
                event,
                crate::EngineEvent::Error(_) | crate::EngineEvent::ProviderFailed { .. }
            )),
            max_retries == 1,
            "{events:?}"
        );
        if tool_round {
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, crate::EngineEvent::ToolResult { name, output, .. } if name == "read" && !output.is_error)),
                "{events:?}"
            );
        }
    }
}

fn assert_original_stream_http_error(events: &[crate::EngineEvent]) {
    assert!(
        events.iter().any(
            |event| matches!(event, crate::EngineEvent::ProviderFailed { details, .. }
        if details.http_status == Some(400)
            && details.category == kcoder_types::ProviderFailureCategory::ContextLengthExceeded
            && !details.retryable)
        ),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::EngineEvent::ProviderRetry(_)))
    );
}

#[tokio::test]
async fn stream_http_context_repeated_rejection_does_not_compact_again() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        repeat_error: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "policy-fixture");
    let events = collect_stream_http_events(&engine).await;
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "policy_rejected")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 2);
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_partial_response_never_compacts() {
    for partial in [
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "partial".into(),
                role: "assistant".into(),
                content: Vec::new(),
                model: "test".into(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: "partial answer".into(),
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "partial-tool".into(),
                name: "read".into(),
                input: serde_json::json!({"file_path": "not-executed"}),
            },
        },
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(StreamHttpCompactionProvider {
            partial: vec![partial],
            ..Default::default()
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        let events = collect_stream_http_events(&engine).await;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::AssistantMessageStarted))
        );
        assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
        assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
        assert!(latest_compact_boundary(&engine.state.messages()).is_none());
        assert_original_stream_http_error(&events);
    }
}

#[tokio::test]
async fn partial_final_context_response_prevents_compaction_replay() {
    for normal_start in [false, true] {
        for sse_error in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let delta = StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "partial answer".into(),
                },
            };
            let partial = if normal_start {
                vec![
                    StreamEvent::ContentBlockStart {
                        index: 0,
                        content_block: ContentBlock::Text {
                            text: String::new(),
                        },
                    },
                    delta,
                ]
            } else {
                vec![delta]
            };
            let provider = Arc::new(StreamHttpCompactionProvider {
                partial,
                sse_error,
                ..Default::default()
            });
            let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
            recover_write_lock(&engine.settings, "settings").max_retries = 1;
            let events = collect_stream_http_events(&engine).await;
            assert_eq!(
                provider.summary_requests.load(Ordering::SeqCst),
                0,
                "normal={normal_start}, sse={sse_error}: {events:?}"
            );
            assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
            assert!(latest_compact_boundary(&engine.state.messages()).is_none());
            assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::AssistantTextDelta(text) if text == "partial answer")));
            let failures: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    crate::EngineEvent::ProviderFailed { details, .. } => Some(details),
                    _ => None,
                })
                .collect();
            assert_eq!(failures.len(), 1, "{events:?}");
            assert_eq!(
                failures[0].category,
                kcoder_types::ProviderFailureCategory::ContextLengthExceeded
            );
            assert_eq!(
                failures[0].http_status,
                if sse_error { None } else { Some(400) }
            );
            assert!(!failures[0].resume_safe);
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, crate::EngineEvent::ProviderRetry(_)))
            );
        }
    }
}

#[tokio::test]
async fn stream_http_context_training_never_compacts() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    recover_write_lock(&engine.settings, "settings").training_mode = true;
    let events = collect_stream_http_events(&engine).await;
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_failed_compaction_preserves_original_error() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        fail_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let before = engine.state.messages();
    let events = collect_stream_http_events(&engine).await;
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_eq!(engine.state.messages(), before);
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_cancel_during_compaction_does_not_retry_main() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        hang_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "cancel-fixture");
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let (events, ()) = tokio::join!(
            engine
                .run_turn_stream_with_cancel(&prompt, cancel.clone())
                .collect::<Vec<_>>(),
            async {
                provider.summary_started.notified().await;
                cancel.cancel();
            },
        );
        events
    })
    .await
    .expect("cancellation must interrupt a pending summary stream");
    let records = recovery_records(&engine, tmp.path()).await;
    assert_eq!(records.len(), 1);
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_failed")
    );
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "stop" && r["outcome"] == "cancelled")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_dropped.load(Ordering::SeqCst), 1);
    assert!(!recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
    let provider: Arc<dyn Provider> = provider;
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        crate::request_admission::acquire(
            &provider,
            crate::request_admission::RequestClass::SkillReview,
        ),
    )
    .await
    .expect("cancelled summary must release provider admission")
    .unwrap();
    drop(permit);
}

#[tokio::test]
async fn stream_http_context_cancel_after_compaction_does_not_retry_main() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            if matches!(&event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed")) {
                cancel.cancel();
            }
            events.push(event);
        }
        events
    }).await.unwrap();
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
}

#[tokio::test]
async fn stream_http_context_noop_compaction_preserves_original_error() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "noop-fixture");
    engine
        .state
        .set_messages(vec![Message::user_text("current request")]);
    let events = collect_stream_http_events(&engine).await;
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_noop")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_original_stream_http_error(&events);
}

#[tokio::test(flavor = "current_thread")]
async fn stream_http_context_cancel_during_commit_finishes_history_and_sidecar() {
    assert_recovery_stop_during_commit(false, true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_total_deadline_during_commit_finishes_history_and_sidecar() {
    assert_recovery_stop_during_commit(true, false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_total_deadline_user_cancel_has_priority_during_commit() {
    assert_recovery_stop_during_commit(true, true).await;
}

async fn assert_recovery_stop_during_commit(deadline: bool, user_cancel: bool) {
    use futures::StreamExt;
    use std::task::Poll;

    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("commit-cancel.jsonl");
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "commit-fixture");
    if deadline {
        engine
            .settings
            .write()
            .unwrap()
            .recovery
            .provider
            .total_timeout_ms = Some(500);
    }
    let initial_messages = engine.state.messages();
    engine.state.set_messages(Vec::new());
    engine.state.with_history_path(&history);
    for message in initial_messages {
        engine.state.add_message(message);
    }
    engine.state.flush_history().await.unwrap();
    let sidecar = engine.state.session_state_path().unwrap();
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = Vec::new();
        loop {
            match futures::poll!(stream.next()) {
                Poll::Ready(Some(event)) => events.push(event),
                Poll::Ready(None) => panic!("turn ended before reaching the commit wait"),
                Poll::Pending => {
                    if latest_compact_boundary(&engine.state.messages()).is_some() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }
        }
        // On this single-thread runtime the writer cannot acknowledge the newly
        // enqueued boundary until we yield. Remove only the temporary sidecar so
        // its recreation proves the post-acknowledgement finalizer actually ran.
        std::fs::remove_file(&sidecar).unwrap();
        if deadline {
            // The stream remains suspended at its commit wait while the absolute
            // deadline passes; this does not depend on a scheduler race.
            tokio::time::sleep(std::time::Duration::from_millis(550)).await;
        }
        if user_cancel {
            cancel.cancel();
        }
        events.extend(stream.collect::<Vec<_>>().await);
        events
    })
    .await
    .expect("commit must finish before cancellation terminates the turn");
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_succeeded")
    );
    let stop = if user_cancel {
        "cancelled"
    } else {
        "deadline_exceeded"
    };
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "stop" && r["outcome"] == stop)
    );

    assert!(
        sidecar.exists(),
        "cancellation skipped the post-commit sidecar write"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
    assert_eq!(persisted["conversation_started"], true);
    assert_eq!(
        persisted["updated_at_ms"],
        engine.state.session_timestamps_ms().1
    );
    engine.state.flush_history().await.unwrap();
    let restored = kcoder_state::AppState::new(tmp.path());
    restored.resume_from_history(&history).unwrap();
    // Replay strips the internal compact marker from the summary's visible text.
    let visible = |messages: Vec<Message>| {
        messages
            .into_iter()
            .map(|message| {
                message
                    .preview(100_000)
                    .replace(crate::context::compact::COMPACT_BOUNDARY_MARKER, "")
                    .trim()
                    .to_string()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        visible(restored.messages()),
        visible(engine.state.messages())
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    if user_cancel {
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
        assert!(!events.iter().any(|event| matches!(
            event,
            crate::EngineEvent::Error(_) | crate::EngineEvent::ProviderFailed { .. }
        )));
    } else {
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
        assert!(!engine.is_cancelled());
    }
    assert!(!events.iter().any(|event| matches!(event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed"))));
}

#[path = "reactive_deadline.rs"]
mod deadline;

#[derive(Debug)]
struct DeadlineProvider {
    inner: StreamHttpCompactionProvider,
    mode: &'static str,
    calls: AtomicUsize,
}

impl Provider for DeadlineProvider {
    fn name(&self) -> &'static str {
        "deadline-fixture"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        use futures::StreamExt;
        let summary = request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        });
        let call = if summary {
            0
        } else {
            self.calls.fetch_add(1, Ordering::SeqCst) + 1
        };
        if self.mode == "backoff" {
            return Err(kcoder_api::ApiErrorKind::Http {
                error_type: "server_error".into(),
                message: "retry fixture".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: Some(std::time::Duration::from_secs(10)),
                },
            });
        }
        let mut stream = if self.mode == "compact" {
            self.inner.stream_messages(request)?
        } else if self.mode == "tool" && call == 1 {
            Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::ToolUse { id: "deadline-tool".into(), name: "read".into(), input: serde_json::json!({}) } }),
                Ok(StreamEvent::ContentBlockDelta { index: 0, delta: ContentDelta::InputJsonDelta { partial_json: serde_json::json!({"file_path": std::path::PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root")).join("crates/kcoder_engine/Cargo.toml")}).to_string() } }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }), Ok(StreamEvent::MessageStop),
            ])) as kcoder_api::ProviderStream
        } else {
            SummaryCountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }
            .stream_messages(request)?
        };
        let delay = if self.mode == "hang" { 10_000 } else { 80 };
        let tail = self.mode == "tail";
        let delayed = Box::pin(async_stream::stream! {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            while let Some(event) = stream.next().await { yield event; }
            if tail {
                // Deliver accounting after the 200ms recovery deadline, but
                // before the completed-stream idle watchdog expires.
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                yield Ok(StreamEvent::MessageDelta { delta: kcoder_types::MessageDeltaFields {
                    stop_reason: None, stop_sequence: None,
                    usage: Some(kcoder_types::Usage { input_tokens: 177, output_tokens: 23, total_tokens: None, cache_creation_input_tokens: None, cache_read_input_tokens: None, iterations: None }),
                }});
                std::future::pending::<()>().await;
            }
        });
        if tail {
            Ok(crate::stream::timed_stream(
                delayed,
                std::time::Duration::from_millis(400),
            ))
        } else {
            Ok(delayed)
        }
    }
}
