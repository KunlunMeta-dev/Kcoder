use super::*;

#[tokio::test]
async fn recovery_total_deadline_interrupts_summary_without_user_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        hang_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
    document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":50}});
    *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
    let events = collect_stream_http_events(&engine).await;
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert!(!engine.is_cancelled());
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_dropped.load(Ordering::SeqCst), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
}

#[tokio::test]
async fn recovery_total_deadline_interrupts_session_memory_prepare_wait() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.recovery.provider.total_timeout_ms = Some(50);
        settings.session_memory.enabled = true;
        settings.session_memory.compact_enabled = true;
    }
    engine
        .session_memory_update_running
        .store(true, Ordering::SeqCst);
    *engine.session_memory_update_started_at.lock().unwrap() = Some(std::time::Instant::now());
    let before = engine.state.messages();
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        collect_stream_http_events(&engine),
    )
    .await
    .expect("deadline must interrupt the pre-commit session-memory wait");
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(engine.state.messages(), before);
    assert!(!engine.is_cancelled());
    assert!(engine.session_memory_update_running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn recovery_total_deadline_hard_preflight_passes_user_cancel_to_summary() {
    let source = include_str!("../../stream_response.rs");
    let hard_gate = source
        .split("hard_gate_compactions += 1;")
        .nth(1)
        .unwrap()
        .split(".await;")
        .next()
        .unwrap();
    assert!(
        hard_gate.contains("recovery_deadline.is_active().then(|| engine.cancel_token())"),
        "active hard preflight must forward user cancellation without changing None"
    );
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let engine = stream_http_compaction_engine(
        tmp.path(),
        Arc::new(HangingPrefireProvider {
            requests: requests.clone(),
            dropped: dropped.clone(),
        }),
    );
    let before = engine.state.messages();
    let cancel = CancellationToken::new();
    let mut deadline = crate::recovery_deadline::RecoveryDeadline::default();
    deadline.start(Some(500));
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        let (result, ()) = tokio::join!(
            engine.perform_compaction_with_recovery_deadline(
                true,
                false,
                true,
                deadline.is_active().then(|| cancel.clone()),
                deadline
            ),
            async {
                while requests.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
                cancel.cancel();
            },
        );
        result
    })
    .await
    .unwrap();
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("cancelled by user")
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(engine.state.messages(), before);
}

#[tokio::test]
async fn recovery_total_deadline_drops_moa_rebuild_workers_and_queued_references() {
    use futures::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let tmp = tempfile::tempdir().unwrap();
    let summaries = Arc::new(AtomicUsize::new(0));
    let engine = stream_http_compaction_engine(
        tmp.path(),
        Arc::new(SummaryCountingProvider {
            requests: summaries.clone(),
        }),
    );
    {
        let mut settings = engine.settings.write().unwrap();
        settings.recovery.provider.total_timeout_ms = Some(500);
        settings.kunlunmeta_api_key = Some("fixture-key".into());
        settings.api_key = Some("fixture-key".into());
        settings.providers.get_mut("kunlunmeta").unwrap().endpoint = endpoint;
        settings.moa.enabled = true;
        settings.moa.max_reference_workers = 1;
        settings.moa.default_preset = "deadline".into();
        settings.moa.presets.insert(
            "deadline".into(),
            kcoder_config::MoaPresetConfig {
                reference_models: vec![
                    kcoder_config::MoaModelConfig::new("kunlunmeta", "reference-one"),
                    kcoder_config::MoaModelConfig::new("kunlunmeta", "reference-two"),
                ],
                aggregator: kcoder_config::MoaModelConfig::new("kunlunmeta", "aggregator"),
                ..Default::default()
            },
        );
    }
    engine.enable_moa_for_next_turn(Some("deadline".into()));
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let server = async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let call = observed.fetch_add(1, Ordering::SeqCst);
            if call == 3 {
                assert_eq!(request["model"], "reference-one");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n").await.unwrap();
                let mut byte = [0];
                assert_eq!(
                    socket.read(&mut byte).await.unwrap(),
                    0,
                    "dropping MoA must close its owned in-flight stream"
                );
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                        .await
                        .is_err(),
                    "queued reference must not start after deadline"
                );
                break;
            }
            let (status, content_type, body) = if request["model"] == "aggregator" {
                ("400 Bad Request", "application/json", serde_json::json!({"error":{"type":"invalid_request_error","message":"context_length_exceeded"}}).to_string())
            } else {
                let events = [
                    serde_json::json!({"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}),
                    serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"advice"}}),
                    serde_json::json!({"type":"content_block_stop","index":0}),
                    serde_json::json!({"type":"message_stop"}),
                ];
                (
                    "200 OK",
                    "text/event-stream",
                    events
                        .iter()
                        .map(|event| {
                            format!(
                                "event: {}\ndata: {event}\n\n",
                                event["type"].as_str().unwrap()
                            )
                        })
                        .collect::<String>(),
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    };
    // Generous wall-clock backstop: the fixture asserts its own deadline
    // semantics (requests/summaries below); a 3 s budget proved flaky on
    // loaded machines where the first request had not been issued yet.
    let events = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (events, ()) = tokio::join!(engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>(), server);
        events
    }).await.unwrap_or_else(|_| panic!("active recovery deadline must stop MoA reference collection; requests={}, summaries={}", requests.load(Ordering::SeqCst), summaries.load(Ordering::SeqCst)));
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    assert_eq!(summaries.load(Ordering::SeqCst), 1);
    assert!(!engine.is_cancelled());
}

#[tokio::test]
async fn recovery_total_deadline_finishes_completed_tail_and_preserves_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(DeadlineProvider {
        inner: Default::default(),
        mode: "tail",
        calls: AtomicUsize::new(0),
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .settings
        .write()
        .unwrap()
        .recovery
        .provider
        .total_timeout_ms = Some(200);
    let events = collect_stream_http_events(&engine).await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            crate::EngineEvent::Error(_)
                | crate::EngineEvent::ProviderFailed { .. }
                | crate::EngineEvent::ProviderRetry(_)
        )),
        "{events:?}"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.cumulative_usage.read().unwrap().input_tokens, 177);
    assert_eq!(engine.cumulative_usage.read().unwrap().output_tokens, 23);
}

#[tokio::test]
async fn recovery_total_deadline_bounds_stream_backoff_and_compaction_rebuild() {
    for (mode, timeout, expected_calls) in
        [("hang", 40, 1), ("backoff", 40, 1), ("compact", 210, 2)]
    {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode,
            calls: AtomicUsize::new(0),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "deadline-fixture");
        let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
        document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":timeout}});
        *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
        let started = std::time::Instant::now();
        let events = collect_stream_http_events(&engine).await;
        let records = recovery_records(&engine, tmp.path()).await;
        assert_eq!(records.len(), 1);
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["outcome"] == "deadline_exceeded")
        );
        if mode == "backoff" {
            assert!(
                records[0]["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "retry_wait" && r["outcome"] == "deadline_exceeded")
            );
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "{mode}: {events:?}"
        );
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{mode}: {events:?}");
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::StreamAborted { .. })),
            "{events:?}"
        );
        assert!(!engine.is_cancelled());
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            expected_calls,
            "{mode}: {events:?}"
        );
        if mode == "compact" {
            assert!(latest_compact_boundary(&engine.state.messages()).is_some());
            assert_eq!(provider.inner.summary_requests.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn recovery_total_deadline_resets_after_tool_response_and_none_is_compatible() {
    for timeout in [None, Some(130)] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode: "tool",
            calls: AtomicUsize::new(0),
        });
        let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine.tools = ToolRegistry::new().register(kcoder_tools::FileReadTool);
        let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
        document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":timeout}});
        *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
        let events = collect_stream_http_events(&engine).await;
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2, "{events:?}");
        assert!(
            !events.iter().any(|event| matches!(
                event,
                crate::EngineEvent::Error(_)
                    | crate::EngineEvent::ProviderFailed { .. }
                    | crate::EngineEvent::StreamAborted { .. }
            )),
            "{events:?}"
        );
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::ToolResult { output, .. } if !output.is_error)), "{events:?}");
    }
}

#[tokio::test]
async fn recovery_total_deadline_bounds_admission_without_starting_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(DeadlineProvider {
        inner: Default::default(),
        mode: "hang",
        calls: AtomicUsize::new(0),
    });
    let provider_dyn: Arc<dyn Provider> = provider.clone();
    let held = crate::request_admission::acquire(
        &provider_dyn,
        crate::request_admission::RequestClass::Foreground,
    )
    .await
    .unwrap();
    let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine.request_class = crate::request_admission::RequestClass::SkillReview;
    engine
        .settings
        .write()
        .unwrap()
        .recovery
        .provider
        .total_timeout_ms = Some(40);
    let events = collect_stream_http_events(&engine).await;
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    drop(held);
    assert!(
        crate::request_admission::acquire(
            &provider_dyn,
            crate::request_admission::RequestClass::SkillReview
        )
        .await
        .is_ok()
    );
}
