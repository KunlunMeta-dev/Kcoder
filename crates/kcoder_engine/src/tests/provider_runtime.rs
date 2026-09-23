#[derive(Debug)]
struct FlakySseErrorProvider {
    attempts: Arc<AtomicUsize>,
}

#[derive(Debug)]
struct ReasoningRecoveryProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    boundary: u8,
    status: u16,
    parameter: Option<kcoder_api::RejectedReasoningParameter>,
    capable: bool,
    repeated: bool,
    tool_turn: bool,
}

impl Provider for ReasoningRecoveryProvider {
    fn name(&self) -> &'static str {
        "reasoning-recovery"
    }

    fn supports_reasoning_suppression(
        &self,
        parameter: kcoder_api::RejectedReasoningParameter,
    ) -> bool {
        self.capable && parameter == kcoder_api::RejectedReasoningParameter::ReasoningEffort
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let mut requests = self.requests.lock().unwrap();
        let attempt = requests.len();
        requests.push(request);
        drop(requests);
        if attempt == 0 || self.repeated {
            let error = kcoder_api::ApiErrorKind::Http {
                error_type: "invalid_request_error".into(),
                message: "unsupported reasoning; context window exceeded".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: self.status,
                    provider_code: Some("unsupported_parameter".into()),
                    provider_type: Some("invalid_request_error".into()),
                    rejected_reasoning_parameter: self.parameter,
                    retry_after: None,
                },
            };
            return match self.boundary {
                0 => Err(error),
                1 => Ok(Box::pin(futures::stream::iter([Err(error)]))),
                3 => Ok(Box::pin(futures::stream::iter([
                    Ok(StreamEvent::ContentBlockDelta {
                        index: 0,
                        delta: ContentDelta::TextDelta {
                            text: "partial without start".into(),
                        },
                    }),
                    Err(error),
                ]))),
                _ => Ok(Box::pin(futures::stream::iter([
                    Ok(StreamEvent::ContentBlockStart {
                        index: 0,
                        content_block: ContentBlock::Text {
                            text: "partial".into(),
                        },
                    }),
                    Err(error),
                ]))),
            };
        }
        let events = if self.tool_turn && attempt == 1 {
            sleep_tool_call_events(0)
        } else {
            simple_text_events("recovered")
        };
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

#[tokio::test]
async fn reasoning_recovery_main_request_boundaries_and_budget() {
    // boundary, max retries, training, capability, repeated rejection, status, typed param, expected calls
    for (boundary, max_retries, training, capable, repeated, status, known, expected) in [
        (0, 3, false, true, false, 400, true, 2),
        (1, 3, false, true, false, 422, true, 2),
        (0, 3, false, true, true, 400, true, 2),
        (1, 3, false, true, true, 400, true, 2),
        (0, 0, false, true, false, 400, true, 1),
        (1, 0, false, true, false, 400, true, 1),
        (2, 3, false, true, false, 400, true, 1),
        (3, 3, false, true, false, 400, true, 1),
        (0, 3, true, true, false, 400, true, 1),
        (1, 3, true, true, false, 400, true, 1),
        (0, 3, false, false, false, 400, true, 1),
        (0, 3, false, true, false, 401, true, 1),
        (1, 3, false, true, false, 403, true, 1),
        (0, 3, false, true, false, 400, false, 1),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = test_engine_with_settings(
            Arc::new(ReasoningRecoveryProvider {
                requests: requests.clone(),
                boundary,
                status,
                parameter: known.then_some(kcoder_api::RejectedReasoningParameter::ReasoningEffort),
                capable,
                repeated,
                tool_turn: false,
            }),
            tmp.path(),
            Settings {
                max_retries,
                training_mode: training,
                model_reasoning_effort: Some(kcoder_types::ReasoningEffort::High),
                ..Settings::default()
            },
        );
        engine.state.add_message(Message::user_text("hello"));
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let events: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            expected,
            "{boundary}/{max_retries}/{training}/{capable}/{repeated}/{status}/{known}"
        );
        assert!(!requests[0].recovery_disable_reasoning);
        if expected == 2 {
            assert!(requests[1].recovery_disable_reasoning);
            assert_eq!(requests[1].reasoning_effort, None);
            assert_eq!(requests[0].model, requests[1].model);
            assert_eq!(
                serde_json::to_value(&requests[0]).unwrap(),
                serde_json::to_value(&requests[1]).unwrap()
            );
            assert_eq!(events.iter().filter(|event| matches!(event, EngineEvent::SystemNotice(message) if message.contains("Optional reasoning disabled"))).count(), 1);
        }
        assert_eq!(
            recover_read_lock(&engine.settings, "settings").model_reasoning_effort,
            Some(kcoder_types::ReasoningEffort::High)
        );
    }
}

#[tokio::test]
async fn reasoning_recovery_next_tool_request_restores_reasoning() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(ReasoningRecoveryProvider {
            requests: requests.clone(),
            boundary: 1,
            status: 400,
            parameter: Some(kcoder_api::RejectedReasoningParameter::ReasoningEffort),
            capable: true,
            repeated: false,
            tool_turn: true,
        }),
        tmp.path(),
        Settings {
            max_retries: 1,
            model_reasoning_effort: Some(kcoder_types::ReasoningEffort::High),
            ..Settings::default()
        },
    );
    engine.state.add_message(Message::user_text("hello"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let _: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].recovery_disable_reasoning);
    assert!(!requests[2].recovery_disable_reasoning);
    assert_eq!(
        requests[2].reasoning_effort,
        Some(kcoder_types::ReasoningEffort::High)
    );
}

#[tokio::test]
async fn reasoning_recovery_survives_compaction_and_shares_retry_budget() {
    #[derive(Debug)]
    struct SequenceProvider {
        requests: Arc<Mutex<Vec<MessagesRequest>>>,
        compact: bool,
    }
    impl Provider for SequenceProvider {
        fn name(&self) -> &'static str {
            "reasoning-sequence"
        }
        fn supports_reasoning_suppression(
            &self,
            _: kcoder_api::RejectedReasoningParameter,
        ) -> bool {
            true
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
                return crate::test_support::providers::SummaryCountingProvider {
                    requests: Arc::new(AtomicUsize::new(0)),
                }
                .stream_messages(request);
            }
            let mut requests = self.requests.lock().unwrap();
            let attempt = requests.len();
            requests.push(request);
            drop(requests);
            if attempt <= 1 {
                return Err(kcoder_api::ApiErrorKind::Http {
                    error_type: "invalid_request_error".into(),
                    message: "fixture rejection".into(),
                    metadata: kcoder_api::HttpErrorMetadata {
                        status: if attempt == 1 && !self.compact {
                            503
                        } else {
                            400
                        },
                        provider_code: Some(
                            if attempt == 0 {
                                "unsupported_parameter"
                            } else if self.compact {
                                "context_length_exceeded"
                            } else {
                                "overloaded_error"
                            }
                            .into(),
                        ),
                        provider_type: Some("invalid_request_error".into()),
                        rejected_reasoning_parameter: (attempt == 0)
                            .then_some(kcoder_api::RejectedReasoningParameter::ReasoningEffort),
                        retry_after: None,
                    },
                });
            }
            Ok(Box::pin(futures::stream::iter(
                simple_text_events("done").into_iter().map(Ok),
            )))
        }
    }
    for (compact, max_retries) in [(false, 1), (false, 2), (true, 1)] {
        let tmp = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let settings = settings_using_main_summary_runtime(Settings {
            context_window_tokens: Some(100_000),
            auto_compact_threshold_tokens: Some(90_000),
            prefire_threshold_tokens: Some(90_000),
            context_output_headroom: Some(2_000),
            max_tokens: Some(1_000),
            estimated_tool_growth_tokens: Some(1),
            ..Settings::default()
        });
        let engine = test_engine_with_settings(
            Arc::new(SequenceProvider {
                requests: requests.clone(),
                compact,
            }),
            tmp.path(),
            settings,
        );
        engine.state.set_messages(vec![
            Message::user_text("old request ".repeat(1_000)),
            Message::assistant_text("old response ".repeat(1_000)),
            Message::user_text("middle request ".repeat(1_000)),
            Message::assistant_text("middle response ".repeat(1_000)),
            Message::user_text("recent request"),
            Message::assistant_text("recent response"),
            Message::user_text("current request must remain verbatim"),
        ]);
        {
            let mut settings = recover_write_lock(&engine.settings, "settings");
            settings.max_retries = max_retries;
            settings.retry_base_delay_ms = 0;
            settings.session_memory.enabled = false;
            settings.model_reasoning_effort = Some(kcoder_types::ReasoningEffort::High);
        }
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "reasoning-fixture");
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let events: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            if compact || max_retries == 2 { 3 } else { 2 },
            "{events:?}"
        );
        assert!(requests.iter().skip(1).all(
            |request| request.recovery_disable_reasoning && request.reasoning_effort.is_none()
        ));
        drop(requests);
        assert!(
            engine
                .state
                .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        let records: Vec<serde_json::Value> = std::fs::read_dir(tmp.path().join("recovery"))
            .unwrap()
            .flat_map(|entry| {
                let value: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
                value["records"].as_array().unwrap().clone()
            })
            .collect();
        assert_eq!(
            records
                .iter()
                .filter(|record| record["decision"] == "downgrade_thinking"
                    && record["outcome"] == "reasoning_disabled")
                .count(),
            1
        );
        assert!(
            !records
                .iter()
                .any(|record| record["decision"] != "downgrade_thinking"
                    && record["outcome"] == "reasoning_disabled")
        );
        if compact {
            assert!(records.iter().any(|record| record["decision"] == "compact"
                && record["outcome"] == "compact_succeeded"));
        } else {
            let expected = if max_retries == 1 {
                "budget_rejected"
            } else {
                "wait_completed"
            };
            assert!(
                records
                    .iter()
                    .any(|record| record["decision"] == "retry_wait"
                        && record["outcome"] == expected)
            );
        }
    }
}

#[tokio::test]
async fn reasoning_recovery_notice_respects_cancel_and_absolute_deadline() {
    for cancel in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut settings = Settings {
            max_retries: 2,
            ..Settings::default()
        };
        settings.recovery.provider.total_timeout_ms = Some(200);
        let engine = test_engine_with_settings(
            Arc::new(ReasoningRecoveryProvider {
                requests: requests.clone(),
                boundary: 1,
                status: 400,
                parameter: Some(kcoder_api::RejectedReasoningParameter::ReasoningEffort),
                capable: true,
                repeated: false,
                tool_turn: false,
            }),
            tmp.path(),
            settings,
        );
        engine.state.add_message(Message::user_text("hello"));
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut stream = engine.run_turn_stream(&prompt);
        let mut notice = false;
        let mut stopped = false;
        while let Some(event) = stream.next().await {
            match event {
                EngineEvent::SystemNotice(message)
                    if message.contains("Optional reasoning disabled") =>
                {
                    notice = true;
                    if cancel {
                        engine.cancel();
                    } else {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
                EngineEvent::StreamAborted { .. } if cancel => stopped = true,
                EngineEvent::Error(message) if !cancel && message.contains("deadline") => {
                    stopped = true
                }
                _ => {}
            }
        }
        assert!(notice && stopped, "cancel={cancel}");
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn reasoning_recovery_native_http_and_diagnostics_match_attempt() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut bodies = Vec::new();
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (header_end, content_length) = loop {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < header_end + content_length {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            bodies.push(
                serde_json::from_slice::<serde_json::Value>(
                    &bytes[header_end..header_end + content_length],
                )
                .unwrap(),
            );
            let (status, content_type, body) = if attempt == 0 {
                ("400 Bad Request", "application/json", r#"{"error":{"code":"unsupported_parameter","type":"invalid_request_error","param":"reasoning_effort","message":"SENTINEL_PRIVATE Bearer multiple words https://host/?token=secret"}}"#.to_string())
            } else {
                ("200 OK", "text/event-stream", "data: {\"id\":\"test\",\"object\":\"chat.completion.chunk\",\"model\":\"test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_string())
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        bodies
    });
    let tmp = tempfile::tempdir().unwrap();
    let provider = kcoder_api::providers::OpenAiProvider::local_compatible()
        .unwrap()
        .with_base_url(format!("http://{address}/v1"))
        .with_proxy_url(None)
        .unwrap()
        .with_extra_body_field("reasoning_effort", serde_json::json!("high"))
        .with_extra_body_field("temperature", serde_json::json!(0.7));
    let engine = test_engine_with_settings(
        Arc::new(provider),
        tmp.path(),
        Settings {
            max_retries: 1,
            model_reasoning_effort: Some(kcoder_types::ReasoningEffort::High),
            ..Settings::default()
        },
    );
    engine
        .state
        .with_history_path(tmp.path().join("session.jsonl"));
    engine.state.add_message(Message::user_text("hello"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events: Vec<_> = tokio::time::timeout(
        Duration::from_secs(5),
        engine.run_turn_stream(&prompt).collect(),
    )
    .await
    .unwrap();
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    let mut bodies = tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        bodies[0]
            .as_object_mut()
            .unwrap()
            .remove("reasoning_effort"),
        Some(serde_json::json!("high"))
    );
    assert_eq!(bodies[0], bodies[1]);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    let records: Vec<serde_json::Value> =
        std::fs::read_dir(engine.state.llm_request_history_dir().unwrap())
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                (path.extension().is_some_and(|ext| ext == "json"))
                    .then(|| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
            })
            .collect();
    assert_eq!(records.len(), 2);
    let captured_error = records
        .iter()
        .find_map(|record| record["response"]["error"].as_str())
        .unwrap();
    assert!(captured_error.contains("400"));
    assert!(captured_error.contains("invalid_request_error"));
    assert!(captured_error.len() <= 512);
    assert!(
        !serde_json::to_string(&records)
            .unwrap()
            .contains("SENTINEL_PRIVATE")
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["request_metadata"]["reasoning_effort"] == "high")
            .count(),
        1
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["request_metadata"]["reasoning_effort"].is_null())
            .count(),
        1
    );
}

#[tokio::test]
async fn non_http_types_control_all_main_retry_boundaries() {
    #[derive(Debug)]
    struct FailureProvider {
        kind: &'static str,
        boundary: usize,
        attempts: Arc<AtomicUsize>,
    }
    impl Provider for FailureProvider {
        fn name(&self) -> &'static str {
            "typed-failure"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            let message = if matches!(self.kind, "authentication_error" | "unknown") {
                "context window network 429 stream idle timeout retry_after=99"
            } else {
                "network 429 stream idle timeout retry_after=99"
            }
            .to_string();
            let error = match self.kind {
                "parser" | "utf8" => kcoder_api::ApiErrorKind::SseStream {
                    error_type: "sse_stream".into(),
                    message: message.clone(),
                    kind: if self.kind == "parser" {
                        kcoder_api::SseErrorKind::Parser
                    } else {
                        kcoder_api::SseErrorKind::Utf8
                    },
                },
                "json_parse" => kcoder_api::ApiErrorKind::JsonParse(
                    serde_json::from_str::<serde_json::Value>("invalid").unwrap_err(),
                    message.clone(),
                ),
                _ => kcoder_api::ApiErrorKind::Api {
                    error_type: self.kind.into(),
                    message: message.clone(),
                },
            };
            match self.boundary {
                0 => Err(error),
                1 => Ok(Box::pin(futures::stream::iter([Err(error)]))),
                _ => Ok(Box::pin(futures::stream::iter([Ok(StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: self.kind.into(),
                        message,
                    },
                })]))),
            }
        }
    }
    for boundary in 0..3 {
        for (kind, expected_attempts) in [
            ("authentication_error", 1),
            ("invalid_request_error", 1),
            ("unknown", 1),
            ("parser", 1),
            ("utf8", 1),
            ("json_parse", 1),
            ("overloaded_error", 4),
            ("rate_limit_error", 3),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let attempts = Arc::new(AtomicUsize::new(0));
            let engine = test_engine_with_settings(
                Arc::new(FailureProvider {
                    kind,
                    boundary,
                    attempts: attempts.clone(),
                }),
                tmp.path(),
                Settings {
                    max_retries: 3,
                    retry_base_delay_ms: 0,
                    ..Settings::default()
                },
            );
            engine.state.add_message(Message::user_text("hello"));
            tokio::time::timeout(Duration::from_secs(5), async {
                let prompt = kcoder_permissions::AutoAllowPrompt;
                let mut stream = engine.run_turn_stream(&prompt);
                let mut retries = 0;
                let mut errors = 0;
                while let Some(event) = stream.next().await {
                    match event {
                        EngineEvent::ProviderRetry(details) => {
                            assert_eq!(details.timeout_kind, None, "{kind}/{boundary}");
                            assert_eq!(
                                details.retry_after_ms, 0,
                                "body retry_after must not be read"
                            );
                            assert!(!details.reason.contains("next idle tolerance="));
                            retries += 1;
                        }
                        EngineEvent::StreamAborted { reason } => {
                            panic!("{kind}/{boundary}: {reason}")
                        }
                        EngineEvent::Error(message) | EngineEvent::ProviderFailed { message, .. } => {
                            if boundary != 2 {
                                match kind {
                                    "authentication_error" => assert!(message.ends_with("Check API key and provider permissions.")),
                                    "invalid_request_error" => assert!(message.ends_with("This is a request-parameter error, not a network failure.")),
                                    "unknown" => {
                                        assert!(!message.contains("KCoder retries"));
                                        assert!(message.ends_with("check the provider response and configuration."));
                                    }
                                    "overloaded_error" | "rate_limit_error" => assert!(message.ends_with("If this is the final error, retry later or switch provider/model.")),
                                    _ => {}
                                }
                            }
                            errors += 1;
                        }
                        _ => {}
                    }
                }
                assert_eq!(errors, 1, "{kind}/{boundary}");
                assert_eq!(retries, expected_attempts - 1, "{kind}/{boundary}");
            })
            .await
            .expect("diagnostic Retry-After must not delay retries");
            assert_eq!(
                attempts.load(Ordering::SeqCst),
                expected_attempts,
                "{kind}/{boundary}"
            );
        }
    }
}

#[tokio::test]
async fn http_metadata_controls_main_retry_boundaries() {
    #[derive(Debug)]
    struct HttpFailureProvider {
        status: u16,
        code: Option<&'static str>,
        constructor_error: bool,
        attempts: Arc<AtomicUsize>,
    }
    impl Provider for HttpFailureProvider {
        fn name(&self) -> &'static str {
            "http-failure"
        }

        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            let error = kcoder_api::ApiErrorKind::Http {
                error_type: "provider_error".into(),
                message: if self.status == 400 {
                    "stream idle network 429 retry_after=99"
                } else {
                    "stream idle auth context window network 429 retry_after=99"
                }
                .into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: self.status,
                    provider_code: self.code.map(str::to_string),
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: Some(Duration::from_millis(1)),
                },
            };
            if self.constructor_error {
                Err(error)
            } else {
                Ok(Box::pin(futures::stream::iter([Err(error)])))
            }
        }
    }

    for constructor_error in [false, true] {
        for (status, code, expected_attempts) in [
            (401, None, 1),
            (403, Some("insufficient_quota"), 1),
            (400, None, 1),
            (404, None, 1),
            (418, None, 1),
            (429, None, 3),
            (429, Some("insufficient_quota"), 1),
            (429, Some("billing_hard_limit_reached"), 1),
            (503, None, 4),
            (599, None, 1),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let attempts = Arc::new(AtomicUsize::new(0));
            let engine = test_engine_with_settings(
                Arc::new(HttpFailureProvider {
                    status,
                    code,
                    constructor_error,
                    attempts: attempts.clone(),
                }),
                tmp.path(),
                Settings {
                    max_retries: 3,
                    retry_base_delay_ms: 0,
                    ..Settings::default()
                },
            );
            engine.state.add_message(Message::user_text("hello"));
            let prompt = kcoder_permissions::AutoAllowPrompt;
            engine
                .state
                .with_llm_request_history_dir(tmp.path(), "terminal-fixture");
            let retries = tokio::time::timeout(Duration::from_secs(5), async {
                let mut stream = engine.run_turn_stream(&prompt);
                let mut retries = 0;
                let mut errors = 0;
                while let Some(event) = stream.next().await {
                    match event {
                        EngineEvent::ProviderRetry(details) => {
                            assert_eq!(details.retry_after_ms, 1);
                            assert_eq!(details.timeout_kind, None);
                            assert!(!details.reason.contains("next idle tolerance="));
                            retries += 1;
                        }
                        EngineEvent::StreamAborted { reason } => panic!("HTTP {status} must end as Error, not StreamAborted: {reason}"),
                        EngineEvent::Error(message) => panic!("HTTP terminal lost typed facts: {message}"),
                        EngineEvent::ProviderFailed { message, details } => {
                            assert_eq!(details.http_status, Some(status));
                            assert_eq!(details.retryable, matches!(status, 429 | 503) && code.is_none());
                            assert_eq!(details.resume_safe, details.retryable);
                            assert_eq!(details.retry_after_ms, details.retryable.then_some(1));
                            let category = match status {
                                401 => "authentication_error",
                                403 => "forbidden",
                                404 => "model_or_route",
                                400 => "invalid_parameter",
                                429 if code.is_some() => "quota_exceeded",
                                429 => "rate_limit",
                                _ => "provider_error",
                            };
                            assert_eq!(details.category.as_str(), category);
                            assert_eq!(details.recovery_action == kcoder_types::ProviderFailureRecoveryAction::NeedsHuman, matches!(status, 400 | 401 | 403 | 404) || (status == 429 && code.is_some()));
                            let help = match status {
                                401 | 403 => "Check API key and provider permissions.",
                                404 => "Check model name and provider endpoint.",
                                400 => "This is a request-parameter error, not a network failure.",
                                429 if code.is_some() => "Check provider quota and billing before retrying.",
                                429 | 503 => "If this is the final error, retry later or switch provider/model.",
                                _ => "check the provider response and configuration.",
                            };
                            assert!(message.ends_with(help), "{status}: {message}");
                            errors += 1;
                        }
                        _ => {}
                    }
                }
                assert_eq!(errors, 1);
                retries
            })
            .await
            .expect("HTTP Retry-After header must override body text");
            assert!(
                engine
                    .state
                    .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                    .await
            );
            let records: Vec<serde_json::Value> = std::fs::read_dir(tmp.path().join("recovery"))
                .unwrap()
                .flat_map(|entry| {
                    let value: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap())
                            .unwrap();
                    value["records"].as_array().unwrap().clone()
                })
                .collect();
            assert_eq!(
                records
                    .iter()
                    .any(|record| record["decision"] == "needs_human"),
                matches!(status, 400 | 401 | 403 | 404) || (status == 429 && code.is_some())
            );
            assert!(records.iter().any(|record| record["decision"] == "stop"));
            assert_eq!(
                attempts.load(Ordering::SeqCst),
                expected_attempts,
                "status={status}, constructor={constructor_error}"
            );
            assert_eq!(retries, expected_attempts - 1);
        }
    }
}

#[tokio::test]
async fn idle_terminal_preserves_typed_timeout_and_records_stop() {
    #[derive(Debug)]
    struct IdleProvider {
        partial: u8,
        calls: Arc<AtomicUsize>,
    }
    impl Provider for IdleProvider {
        fn name(&self) -> &'static str {
            "idle-test"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let events = match self.partial {
                1 => simple_text_events("partial").into_iter().take(3).collect(),
                2 => vec![StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "partial".into(),
                    },
                }],
                _ => Vec::new(),
            };
            Ok(crate::stream::timed_stream(
                futures::stream::iter(events.into_iter().map(Ok)).chain(futures::stream::pending()),
                Duration::from_millis(10),
            ))
        }
    }
    for partial in 0..3 {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let engine = test_engine_with_settings(
            Arc::new(IdleProvider {
                partial,
                calls: calls.clone(),
            }),
            tmp.path(),
            Settings {
                max_retries: 1,
                retry_base_delay_ms: 0,
                ..Settings::default()
            },
        );
        engine.state.add_message(Message::user_text("hello"));
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "idle-terminal");
        tokio::time::timeout(Duration::from_secs(5), async {
            let prompt = kcoder_permissions::AutoAllowPrompt;
            let mut stream = engine.run_turn_stream(&prompt);
            let mut retries = 0;
            let mut failed = 0;
            let mut partial_seen = false;
            while let Some(event) = stream.next().await {
                match event {
                    EngineEvent::AssistantTextDelta(text) => partial_seen |= text == "partial",
                    EngineEvent::ProviderRetry(details) => {
                        assert!(details.reason.contains("next idle tolerance="));
                        assert_eq!(details.timeout_kind.as_deref(), Some("token_idle"));
                        retries += 1;
                    }
                    EngineEvent::ProviderFailed { message, details } => {
                        assert!(message.contains("Try again or increase the idle timeout."));
                        assert_eq!(
                            details.category,
                            kcoder_types::ProviderFailureCategory::TimeoutError
                        );
                        assert_eq!(details.http_status, None);
                        assert!(details.retryable);
                        assert_eq!(details.resume_safe, partial == 0);
                        failed += 1;
                    }
                    EngineEvent::StreamAborted { reason } => {
                        panic!("idle terminal lost typed facts: {reason}")
                    }
                    EngineEvent::Error(message) => {
                        panic!("idle terminal lost typed facts: {message}")
                    }
                    _ => {}
                }
            }
            assert_eq!((retries, failed), (usize::from(partial == 0), 1));
            assert_eq!(partial_seen, partial != 0);
        })
        .await
        .expect("real idle timeout should end promptly");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if partial == 0 { 2 } else { 1 }
        );
        assert!(
            engine
                .state
                .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        let records: Vec<serde_json::Value> = std::fs::read_dir(tmp.path().join("recovery"))
            .unwrap()
            .flat_map(|entry| {
                let record: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
                record["records"].as_array().unwrap().clone()
            })
            .collect();
        assert!(
            records
                .iter()
                .any(|record| record["decision"] == "stop" && record["outcome"] == "failed"),
            "{records:?}"
        );
    }
}

#[tokio::test]
async fn provider_failure_partial_delta_before_message_start_is_not_resume_safe() {
    #[derive(Debug)]
    struct PartialProvider(bool);
    impl Provider for PartialProvider {
        fn name(&self) -> &'static str {
            "partial-failure"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            let final_event = if self.0 {
                Err(kcoder_api::ApiErrorKind::Http {
                    error_type: "provider_error".into(),
                    message: "opaque".into(),
                    metadata: kcoder_api::HttpErrorMetadata {
                        status: 503,
                        provider_code: None,
                        provider_type: None,
                        rejected_reasoning_parameter: None,
                        retry_after: None,
                    },
                })
            } else {
                Ok(StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: "overloaded_error".into(),
                        message: "opaque".into(),
                    },
                })
            };
            Ok(Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "partial".into(),
                    },
                }),
                final_event,
            ])))
        }
    }
    for http in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine_with_settings(
            Arc::new(PartialProvider(http)),
            tmp.path(),
            Settings {
                max_retries: 0,
                ..Settings::default()
            },
        );
        engine.state.add_message(Message::user_text("hello"));
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let events: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
        assert!(events.iter().any(
            |event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "partial")
        ));
        let failures: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::ProviderFailed { details, .. } => Some(details),
                EngineEvent::Error(error) => panic!("typed failure lost: {error}"),
                _ => None,
            })
            .collect();
        assert_eq!(failures.len(), 1, "{events:?}");
        assert!(failures[0].retryable);
        assert!(!failures[0].resume_safe);
    }
}

#[derive(Debug)]
struct PartialFinalRetryProvider {
    calls: AtomicUsize,
    normal_start: Option<bool>,
    sse_error: bool,
    tool_round: bool,
}

impl Provider for PartialFinalRetryProvider {
    fn name(&self) -> &'static str {
        "partial-final-retry"
    }

    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.tool_round && call == 0 {
            return Ok(Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::ToolUse { id: "read-once".into(), name: "read".into(), input: serde_json::json!({}) } }),
                Ok(StreamEvent::ContentBlockDelta { index: 0, delta: ContentDelta::InputJsonDelta { partial_json: serde_json::json!({"file_path": std::path::PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root")).join("crates/kcoder_engine/Cargo.toml")}).to_string() } }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ])));
        }
        if call != usize::from(self.tool_round) {
            return Ok(Box::pin(futures::stream::iter(
                simple_text_events("fresh response").into_iter().map(Ok),
            )));
        }
        let prefix: Vec<_> = match self.normal_start {
            Some(true) => simple_text_events("partial response")
                .into_iter()
                .take(3)
                .collect(),
            Some(false) => vec![StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "partial response".into(),
                },
            }],
            None => Vec::new(),
        };
        let failure = if self.sse_error {
            Ok(StreamEvent::Error {
                error: kcoder_types::ApiError {
                    error_type: "overloaded_error".into(),
                    message: "opaque".into(),
                },
            })
        } else {
            Err(kcoder_api::ApiErrorKind::Http {
                error_type: "provider_error".into(),
                message: "opaque".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            })
        };
        Ok(Box::pin(futures::stream::iter(
            prefix.into_iter().map(Ok).chain([failure]),
        )))
    }
}

#[tokio::test]
async fn partial_final_output_prevents_transient_stream_replay() {
    for normal_start in [false, true] {
        for sse_error in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let provider = Arc::new(PartialFinalRetryProvider {
                calls: AtomicUsize::new(0),
                normal_start: Some(normal_start),
                sse_error,
                tool_round: false,
            });
            let engine = test_engine_with_settings(
                provider.clone(),
                tmp.path(),
                Settings {
                    max_retries: 1,
                    retry_base_delay_ms: 0,
                    ..Settings::default()
                },
            );
            engine.state.add_message(Message::user_text("hello"));
            let prompt = kcoder_permissions::AutoAllowPrompt;
            let events: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
            assert_eq!(
                provider.calls.load(Ordering::SeqCst),
                1,
                "normal_start={normal_start}, sse={sse_error}: {events:?}"
            );
            let text: String = events
                .iter()
                .filter_map(|event| match event {
                    EngineEvent::AssistantTextDelta(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(text, "partial response");
            assert!(!events.iter().any(|event| matches!(
                event,
                EngineEvent::ProviderRetry(_) | EngineEvent::AssistantMessageDone
            )));
            let failures: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    EngineEvent::ProviderFailed { details, .. } => Some(details),
                    _ => None,
                })
                .collect();
            assert_eq!(failures.len(), 1);
            assert!(failures[0].retryable);
            assert!(!failures[0].resume_safe);
        }
    }
}

#[tokio::test]
async fn partial_final_pre_response_retry_remains_valid_after_tool_round() {
    for tool_round in [false, true] {
        for sse_error in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let provider = Arc::new(PartialFinalRetryProvider {
                calls: AtomicUsize::new(0),
                normal_start: None,
                sse_error,
                tool_round,
            });
            let mut engine = test_engine_with_settings(
                provider.clone(),
                tmp.path(),
                Settings {
                    max_retries: 1,
                    retry_base_delay_ms: 0,
                    ..Settings::default()
                },
            );
            engine.tools = ToolRegistry::new().register(kcoder_tools::FileReadTool);
            engine.state.add_message(Message::user_text("hello"));
            let prompt = kcoder_permissions::AutoAllowPrompt;
            let events: Vec<_> = engine.run_turn_stream(&prompt).collect().await;
            assert_eq!(
                provider.calls.load(Ordering::SeqCst),
                2 + usize::from(tool_round),
                "{events:?}"
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, EngineEvent::ProviderRetry(_)))
                    .count(),
                1
            );
            assert!(!events.iter().any(|event| matches!(
                event,
                EngineEvent::ProviderFailed { .. }
                    | EngineEvent::Error(_)
                    | EngineEvent::StreamAborted { .. }
            )));
            assert!(events.iter().any(|event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "fresh response")));
            if tool_round {
                assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolResult { name, output, .. } if name == "read" && !output.is_error)), "{events:?}");
            }
        }
    }
}

#[test]
fn configured_catalog_does_not_replace_a_profile_model_with_the_running_model() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    let mut glm = settings.providers.values().next().unwrap().clone();
    glm.default_model = "GLM-5.3".into();
    settings.providers.insert("GLM-5.3".into(), glm);
    settings.active_provider = Some("GLM-5.3".into());
    settings.model = "MiniMax-M3".into();
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), temp.path(), settings);
    let entry = engine
        .configured_model_profiles()
        .into_iter()
        .find(|profile| profile.profile_name == "GLM-5.3")
        .unwrap();
    assert_eq!(entry.model, "GLM-5.3");
    assert_eq!(
        engine.model_name(),
        "MiniMax-M3",
        "Listing must not rewrite an existing session selection"
    );
}

#[test]
fn configured_multi_model_selection_keeps_provider_and_independent_limits() {
    let temp = tempfile::tempdir().unwrap();
    let profile: kcoder_config::ProviderConfig = serde_json::from_value(serde_json::json!({
        "api_format":"openai_chat_completions", "authentication":{"mode":"none"},
        "endpoint":"http://127.0.0.1:9/v1", "default_model":"small",
        "models": {
            "small":{"context_window_tokens":32000,"output_headroom_tokens":4000,"max_output_tokens":3000,"capabilities":{"vision":false}},
            "large":{"context_window_tokens":200000,"output_headroom_tokens":20000,"max_output_tokens":12000,"capabilities":{"vision":true},"reasoning_effort":"high"}
        }
    })).unwrap();
    let mut settings = Settings::default();
    settings.providers.clear();
    settings.providers.insert("shared".into(), profile.clone());
    settings.providers.insert("another".into(), profile);
    settings.apply_provider(Some("shared")).unwrap();
    settings.training_mode = true;
    settings.model_discovery.enabled = false;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), temp.path(), settings);
    let catalog = engine.configured_model_profiles();
    assert_eq!(catalog.len(), 4);
    assert_eq!(catalog.iter().filter(|row| row.current).count(), 1);
    engine.select_client_model("shared::large").unwrap();
    assert_eq!(engine.client_model_selector(), "shared::large");
    assert!(engine.model_supports_vision());
    let selected = recover_read_lock(&engine.settings, "settings");
    assert_eq!(selected.context_window_tokens, Some(200000));
    assert_eq!(selected.max_tokens, Some(12000));
    assert_eq!(selected.model_reasoning_effort, Some(kcoder_types::ReasoningEffort::High));
    drop(selected);
    engine.select_client_model("small").unwrap();
    assert_eq!(engine.client_model_selector(), "shared::small");
    assert!(!engine.model_supports_vision());
    assert!(engine.select_client_model("shared::missing").is_err());
    assert_eq!(engine.client_model_selector(), "shared::small");
    recover_write_lock(&engine.settings, "settings").model_discovery.enabled = true;
    engine.select_client_model("shared::new-discovered").unwrap();
    assert_eq!(engine.client_model_selector(), "shared::new-discovered");
}

impl Provider for FlakySseErrorProvider {
    fn name(&self) -> &'static str {
        "flaky-sse-error"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        let stream = async_stream::stream! {
            if attempt == 0 {
                yield Ok(StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: "overloaded_error".to_string(),
                        message: "temporarily unavailable 500".to_string(),
                    },
                });
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: "ok".to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct FlakyTransportErrorProvider {
    attempts: Arc<AtomicUsize>,
}

impl Provider for FlakyTransportErrorProvider {
    fn name(&self) -> &'static str {
        "flaky-transport-error"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        let stream = async_stream::stream! {
            if attempt == 0 {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Thinking {
                        thinking: String::new(),
                        signature: String::new(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::ThinkingDelta {
                        thinking: "partial reasoning that must not be committed".to_string(),
                    },
                });
                yield Err(kcoder_api::ApiErrorKind::Api {
                    error_type: "stream_incomplete".to_string(),
                    message: "connection reset while streaming".to_string(),
                });
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "complete final response".to_string(),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct HangingProvider;

impl Provider for HangingProvider {
    fn name(&self) -> &'static str {
        "hanging"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            tokio::time::sleep(Duration::from_secs(60)).await;
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct ExactOversizedRequestProvider {
    stream_calls: Arc<AtomicUsize>,
}

impl Provider for ExactOversizedRequestProvider {
    fn name(&self) -> &'static str {
        "exact-oversized-request"
    }

    fn count_tokens(&self, _request: MessagesRequest) -> kcoder_api::ProviderTokenCount {
        Box::pin(async { Ok(Some(1_000)) })
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.stream_calls.fetch_add(1, Ordering::SeqCst);
        let stream = futures::stream::empty();
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn exact_count_above_hard_limit_blocks_request_before_provider_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let stream_calls = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100),
        context_output_headroom: Some(10),
        context_hard_input_tokens: Some(90),
        auto_compact_threshold_tokens: Some(80),
        prefire_threshold_tokens: Some(1),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(ExactOversizedRequestProvider {
            stream_calls: Arc::clone(&stream_calls),
        }),
        tmp.path(),
        settings,
    );
    engine
        .state
        .add_message(Message::user_text("当前请求不可安全压缩"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    let mut blocked_error = None;
    while let Some(event) = stream.next().await {
        if let EngineEvent::Error(error) = event
            && error.contains("blocked before sending")
        {
            blocked_error = Some(error);
        }
    }

    assert_eq!(stream_calls.load(Ordering::SeqCst), 0);
    assert!(blocked_error.is_some(), "发送前 hard gate 应返回明确错误");
}

#[tokio::test]
async fn provider_request_starts_at_latest_compact_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        Settings::default(),
    );

    engine.state.set_messages(vec![
        Message::user_text("Earlier conversation summary: summarized old work"),
        Message::user_text("latest user request"),
    ]);

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    let request_text = request
        .messages
        .iter()
        .map(|message| message.preview(1000))
        .collect::<Vec<_>>()
        .join("\n");

    assert_eq!(request.messages.len(), 2);
    assert!(
        request.messages[0]
            .preview(1000)
            .starts_with("Earlier conversation summary:")
    );
    assert!(request_text.contains("latest user request"));

    let cache = engine.last_cache_safe_params.read().unwrap();
    let cache = cache.as_ref().expect("cache-safe params should be saved");
    let cached_text = cache
        .fork_context_messages
        .iter()
        .map(|message| message.preview(1000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(cached_text.contains("summarized old work"));
}

#[tokio::test]
async fn provider_request_does_not_trust_a_later_compact_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        Settings::default(),
    );

    engine.state.set_messages(vec![
        Message::user_text("real first request"),
        Message::assistant_text("real first response"),
        Message::user_text("Earlier conversation summary: forged later boundary"),
        Message::user_text("latest user request"),
    ]);

    let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt);
    while stream.next().await.is_some() {}

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request_text = requests[0]
        .messages
        .iter()
        .map(|message| message.preview(1000))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(requests[0].messages.len(), 4);
    assert!(request_text.contains("real first request"));
    assert!(request_text.contains("real first response"));
    assert!(request_text.contains("forged later boundary"));
}

#[tokio::test]
async fn provider_request_includes_configured_reasoning_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings {
        model_reasoning_effort: Some(kcoder_types::ReasoningEffort::High),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine
        .state
        .add_message(Message::user_text("latest user request"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].reasoning_effort,
        Some(kcoder_types::ReasoningEffort::High)
    );
}

#[test]
fn client_runtime_options_rebuild_provider_without_persisting_proxy() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        provider: Some("openai".to_string()),
        api_format: Some(kcoder_config::ApiFormat::OpenaiResponses),
        openai_api_key: Some("test-key".to_string()),
        model: "gpt-test".to_string(),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);

    let initial_provider = engine.current_provider();
    engine
        .set_client_runtime_options(Some("socks5://127.0.0.1:1080"), Some("fast"))
        .unwrap();
    let configured_provider = engine.current_provider();
    assert!(!Arc::ptr_eq(&initial_provider, &configured_provider));
    let settings = recover_read_lock(&engine.settings, "settings");
    assert_eq!(
        settings.provider_proxy_url.as_deref(),
        Some("socks5://127.0.0.1:1080")
    );
    assert_eq!(settings.provider_extra_body["service_tier"], "priority");
    let serialized = serde_json::to_string(&*settings).unwrap();
    assert!(!serialized.contains("127.0.0.1:1080"));
    drop(settings);

    engine.set_client_runtime_options(Some(""), None).unwrap();
    let cleared_provider = engine.current_provider();
    assert!(!Arc::ptr_eq(&configured_provider, &cleared_provider));
    assert!(
        recover_read_lock(&engine.settings, "settings")
            .provider_proxy_url
            .is_none()
    );
    engine
        .set_client_runtime_options(None, Some("standard"))
        .unwrap();
    assert!(!Arc::ptr_eq(&cleared_provider, &engine.current_provider()));
    assert_eq!(
        recover_read_lock(&engine.settings, "settings").provider_extra_body["service_tier"],
        "default"
    );
    assert!(
        engine
            .set_client_runtime_options(Some("file:///tmp/not-a-proxy"), None)
            .is_err()
    );
}

#[test]
fn client_runtime_options_preserve_provider_for_normalized_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        provider: Some("openai".to_string()),
        api_format: Some(kcoder_config::ApiFormat::OpenaiResponses),
        openai_api_key: Some("test-key".to_string()),
        model: "gpt-test".to_string(),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    engine
        .set_client_runtime_options(Some("socks5://127.0.0.1:1080"), Some("fast"))
        .unwrap();
    let provider = engine.current_provider();
    let before = serde_json::to_value(&*recover_read_lock(&engine.settings, "settings")).unwrap();

    for tier in ["fast", "priority", "  PrIoRiTy  ", " FAST ", "运行快速"] {
        engine
            .set_client_runtime_options(Some("  socks5://127.0.0.1:1080  "), Some(tier))
            .unwrap();
        assert!(Arc::ptr_eq(&provider, &engine.current_provider()), "{tier}");
        let settings = recover_read_lock(&engine.settings, "settings");
        assert_eq!(
            settings.provider_proxy_url.as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(serde_json::to_value(&*settings).unwrap(), before);
    }
    engine.set_client_runtime_options(None, None).unwrap();
    assert!(Arc::ptr_eq(&provider, &engine.current_provider()));
}

#[test]
fn client_runtime_options_preserve_provider_for_repeated_proxy_clear() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        provider: Some("openai".to_string()),
        api_format: Some(kcoder_config::ApiFormat::OpenaiResponses),
        openai_api_key: Some("test-key".to_string()),
        model: "gpt-test".to_string(),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    engine
        .set_client_runtime_options(Some("http://127.0.0.1:8080"), Some("standard"))
        .unwrap();
    engine.set_client_runtime_options(Some(""), None).unwrap();
    let provider = engine.current_provider();
    for proxy in ["", "  "] {
        engine
            .set_client_runtime_options(Some(proxy), Some(" DEFAULT "))
            .unwrap();
        assert!(Arc::ptr_eq(&provider, &engine.current_provider()));
        let settings = recover_read_lock(&engine.settings, "settings");
        assert!(settings.provider_proxy_url.is_none());
        assert_eq!(settings.provider_extra_body["service_tier"], "default");
    }
}

#[test]
fn client_runtime_options_validate_duplicates_before_preserving_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        provider: Some("openai".to_string()),
        api_format: Some(kcoder_config::ApiFormat::OpenaiResponses),
        openai_api_key: Some("test-key".to_string()),
        model: "gpt-test".to_string(),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    let proxy = "socks5://127.0.0.1:1080";
    engine
        .set_client_runtime_options(Some(proxy), Some("fast"))
        .unwrap();
    let provider = engine.current_provider();
    let before = serde_json::to_value(&*recover_read_lock(&engine.settings, "settings")).unwrap();
    let too_long = format!("http://{}", "a".repeat(4096));
    for (proxy_input, tier) in [
        ("file:///tmp/not-a-proxy", "priority"),
        ("http://proxy host", "priority"),
        (too_long.as_str(), "priority"),
        (proxy, "unsupported"),
        ("http://127.0.0.1:8080", "unsupported"),
    ] {
        assert!(
            engine
                .set_client_runtime_options(Some(proxy_input), Some(tier))
                .is_err()
        );
        assert!(Arc::ptr_eq(&provider, &engine.current_provider()));
        let settings = recover_read_lock(&engine.settings, "settings");
        assert_eq!(settings.provider_proxy_url.as_deref(), Some(proxy));
        assert_eq!(serde_json::to_value(&*settings).unwrap(), before);
    }
}

#[test]
fn fixed_provider_accepts_client_runtime_options_without_factory_rebuild() {
    #[derive(Debug)]
    struct FixedProvider;

    impl Provider for FixedProvider {
        fn name(&self) -> &'static str {
            "fixed-provider"
        }

        fn supports_client_runtime_reconfiguration(&self) -> bool {
            false
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(FixedProvider), tmp.path(), Settings::default());

    engine
        .set_client_runtime_options(Some("socks5://127.0.0.1:1080"), Some("fast"))
        .unwrap();

    assert_eq!(engine.provider_name(), "fixed-provider");
    let settings = recover_read_lock(&engine.settings, "settings");
    assert_eq!(
        settings.provider_proxy_url.as_deref(),
        Some("socks5://127.0.0.1:1080")
    );
    assert_eq!(settings.provider_extra_body["service_tier"], "priority");
    let selected = format!("{}::{}", settings.active_provider.as_deref().unwrap(), settings.model);
    drop(settings);
    let provider = engine.current_provider();
    engine.select_client_model(&selected).unwrap();
    assert!(Arc::ptr_eq(&provider, &engine.current_provider()));
    assert!(engine.select_client_model("missing-provider::missing-model").is_err());
    assert!(Arc::ptr_eq(&provider, &engine.current_provider()));

}

#[tokio::test]
async fn cancel_token_aborts_silent_provider_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(HangingProvider), tmp.path(), Settings::default());
    engine.state.add_message(Message::user_text("hi"));

    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel_for_task.cancel();
    });

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel);
    let event = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(event) = stream.next().await {
            if matches!(event, EngineEvent::StreamAborted { .. }) {
                return event;
            }
        }
        panic!("stream ended without cancellation event");
    })
    .await
    .expect("cancelled stream should return promptly");

    assert!(matches!(
        event,
        EngineEvent::StreamAborted { reason } if reason == "cancelled by user"
    ));
}

#[tokio::test]
async fn pre_cancelled_token_aborts_silent_provider_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(HangingProvider), tmp.path(), Settings::default());
    engine.state.add_message(Message::user_text("hi"));

    let cancel = CancellationToken::new();
    cancel.cancel();

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel);
    let event = tokio::time::timeout(Duration::from_millis(100), async {
        while let Some(event) = stream.next().await {
            if matches!(event, EngineEvent::StreamAborted { .. }) {
                return event;
            }
        }
        panic!("stream ended without cancellation event");
    })
    .await
    .expect("pre-cancelled stream should return immediately");

    assert!(matches!(
        event,
        EngineEvent::StreamAborted { reason } if reason == "cancelled by user"
    ));
}

#[tokio::test]
async fn cancelled_forked_agent_does_not_report_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(HangingProvider), tmp.path(), Settings::default());
    *engine.last_cache_safe_params.write().unwrap() = Some(crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("parent user")].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }.into());

    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel_for_task.cancel();
    });

    // During parallel workspace tests, fork initialization, transcript persistence,
    // and background cleanup contend for executor and filesystem capacity. This test
    // verifies that cancellation never reports false completion, not a narrow scheduling delay.
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        engine.run_forked_agent(
            vec![Message::user_text("wait forever")],
            crate::agent::SubagentContextOverrides {
                abort_token: Some(cancel),
                ..crate::agent::SubagentContextOverrides::default()
            },
            10,
        ),
    )
    .await
    .expect("cancelled forked agent should return promptly")
    .expect_err("cancelled forked agent must not report completion");

    assert!(
        result.to_string().contains("cancelled by user"),
        "{result:#}"
    );
}

#[tokio::test]
async fn provider_failure_forked_agent_returns_error_without_waiting_for_recovery() {
    #[derive(Debug)]
    struct AuthProvider;
    impl Provider for AuthProvider {
        fn name(&self) -> &'static str {
            "auth-failure"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            Err(kcoder_api::ApiErrorKind::Api {
                error_type: "authentication_error".into(),
                message: "opaque".into(),
            })
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(Arc::new(AuthProvider), tmp.path(), Settings::default());
    *engine.last_cache_safe_params.write().unwrap() = Some(crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("parent user")].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }.into());
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        engine.run_forked_agent(
            vec![Message::user_text("hello")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        ),
    )
    .await
    .expect("typed terminal must not hang child agent")
    .expect_err("typed terminal must fail child agent");
    assert!(
        error
            .to_string()
            .contains("Check API key and provider permissions."),
        "{error:#}"
    );
}

#[tokio::test]
async fn retryable_sse_error_event_is_retried() {
    let tmp = tempfile::tempdir().unwrap();
    let attempts = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        model: "test-model".to_string(),
        max_retries: 2,
        retry_base_delay_ms: 0,
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(FlakySseErrorProvider {
            attempts: Arc::clone(&attempts),
        }),
        tmp.path(),
        settings,
    );
    engine.state.add_message(Message::user_text("hello"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    let mut retry_notice = None;
    let mut saw_error = false;
    while let Some(event) = stream.next().await {
        match event {
            EngineEvent::ProviderRetry(details) if details.attempt == 1 => {
                retry_notice = Some(details);
            }
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. } => saw_error = true,
            _ => {}
        }
    }

    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    let retry_notice = retry_notice.expect("expected retry notice");
    assert_eq!(retry_notice.request_kind, "main");
    assert_eq!(retry_notice.provider, "flaky-sse-error");
    assert_eq!(retry_notice.model, "test-model");
    assert_eq!(retry_notice.max_retries, 2);
    assert!(retry_notice.reason.contains("overloaded_error"));
    assert_eq!(retry_notice.timeout_kind, None);
    assert_eq!(retry_notice.retry_after_ms, 0);
    assert!(!saw_error);
}

#[tokio::test]
async fn transport_error_after_partial_thinking_stops_without_replay_or_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let attempts = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        max_retries: 2,
        retry_base_delay_ms: 0,
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(FlakyTransportErrorProvider {
            attempts: Arc::clone(&attempts),
        }),
        tmp.path(),
        settings,
    );
    engine.state.add_message(Message::user_text("hello"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    let mut started = 0;
    let mut done = 0;
    let mut failures = 0;
    while let Some(event) = stream.next().await {
        match event {
            EngineEvent::AssistantMessageStarted => started += 1,
            EngineEvent::AssistantMessageDone => done += 1,
            EngineEvent::ProviderFailed { details, .. } => {
                assert!(details.retryable);
                assert!(!details.resume_safe);
                failures += 1;
            }
            EngineEvent::ProviderRetry(_) => panic!("published thinking must not be replayed"),
            _ => {}
        }
    }

    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(started, 1);
    assert_eq!(done, 0);
    assert_eq!(failures, 1);
    let transcript = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(10_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!transcript.contains("complete final response"));
    assert!(!transcript.contains("partial reasoning that must not be committed"));
}

#[test]
fn retry_error_summary_collapses_and_truncates_details() {
    let message = format!(
        "network error:\n{}\n{}",
        "connection reset by peer ".repeat(20),
        "after sending request"
    );
    let summary = retry_error_summary(&message);

    assert!(!summary.contains('\n'));
    assert!(summary.chars().count() <= 243);
    assert!(summary.ends_with("..."));
}

#[test]
fn unstructured_provider_500_error_message_does_not_claim_automatic_retry() {
    let message = provider_error_message(
        "anthropic",
        &kcoder_api::ApiErrorKind::Api {
            error_type: "500 Internal Server Error".to_string(),
            message: "request_id=0682981b03c2829bec558fdf18928abf; anthropic_error_type=api_error"
                .to_string(),
        },
    );

    assert!(message.contains("anthropic provider API error"));
    assert!(!message.contains("0682981b03c2829bec558fdf18928abf"));
    assert!(message.contains("Response details withheld"));
    assert!(!message.contains("transient provider/server error"));
    assert!(!message.contains("max_retries"));
    assert!(message.ends_with("check the provider response and configuration."));
}

fn escalation_provider_config(model: &str) -> kcoder_config::ProviderConfig {
    serde_json::from_value(serde_json::json!({
        "provider": "test",
        "api_format": "anthropic_messages",
        "endpoint": "https://unreachable.invalid/anthropic",
        "model": model,
        "context_window_tokens": 200000,
        "output_headroom_tokens": 20000,
        "max_output_tokens": 20000
    }))
    .unwrap()
}

fn escalation_test_settings(threshold: usize) -> Settings {
    let mut settings = Settings {
        active_provider: Some("main".to_string()),
        model: "main-model".to_string(),
        ..Settings::default()
    };
    settings
        .providers
        .insert("main".to_string(), escalation_provider_config("main-model"));
    settings.providers.insert(
        "ladder".to_string(),
        escalation_provider_config("ladder-model"),
    );
    settings
        .stored_provider_credentials
        .insert("main".to_string(), "test-key".to_string());
    settings
        .stored_provider_credentials
        .insert("ladder".to_string(), "test-key".to_string());
    settings.goal_pro.model_escalation = kcoder_config::GoalProModelEscalationSettings {
        enabled: true,
        threshold,
        models: vec![kcoder_config::GoalProModelSlotConfig {
            profile: None,
            provider: Some("ladder".to_string()),
            model: Some("ladder-model".to_string()),
        }],
    };
    settings
}

fn strict_goal_with_rejections(engine: &QueryEngine, rejections: usize) {
    let goal = engine
        .state
        .set_goal_prepared_with_mode_and_verification(
            "ship",
            None,
            None,
            kcoder_state::GoalMode::Strict,
            kcoder_state::GoalVerificationKind::Artifact,
        )
        .unwrap();
    let mut revision = goal.revision;
    for _ in 0..rejections {
        let outcome = engine.state.commit_goal_verification(
            &goal.goal_id,
            revision,
            kcoder_state::GoalVerificationVerdict::Fail,
            "verifier found a gap",
        );
        let kcoder_state::GoalVerificationCommitOutcome::Applied(goal) = outcome else {
            panic!("rejection commit should apply")
        };
        revision = goal.revision;
    }
}

#[test]
fn goal_model_escalation_switches_at_threshold_and_advances_once() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(StaticTextProvider {
            requests: Arc::new(Mutex::new(Vec::new())),
            text: "ok".to_string(),
        }),
        tmp.path(),
        escalation_test_settings(1),
    );
    strict_goal_with_rejections(&engine, 1);

    let notice = engine
        .maybe_escalate_goal_model()
        .expect("escalation should fire at the threshold");
    assert!(notice.contains("ladder:ladder-model"), "{notice}");
    assert!(notice.contains("fully preserved"), "{notice}");
    assert_eq!(engine.model_name(), "ladder-model");
    assert_eq!(engine.state.goal().unwrap().model_escalation_rung, 1);

    // The ladder is exhausted, so the same rejection count cannot trigger another switch.
    assert!(engine.maybe_escalate_goal_model().is_none());
}

#[test]
fn goal_model_escalation_respects_threshold_disabled_and_inactive_goal() {
    // Below threshold: threshold=2 with only one rejection.
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(StaticTextProvider {
            requests: Arc::new(Mutex::new(Vec::new())),
            text: "ok".to_string(),
        }),
        tmp.path(),
        escalation_test_settings(2),
    );
    strict_goal_with_rejections(&engine, 1);
    assert!(engine.maybe_escalate_goal_model().is_none());

    // Disabled.
    let mut settings = escalation_test_settings(1);
    settings.goal_pro.model_escalation.enabled = false;
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(StaticTextProvider {
            requests: Arc::new(Mutex::new(Vec::new())),
            text: "ok".to_string(),
        }),
        tmp.path(),
        settings,
    );
    strict_goal_with_rejections(&engine, 3);
    assert!(engine.maybe_escalate_goal_model().is_none());

    // The goal is not active.
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(StaticTextProvider {
            requests: Arc::new(Mutex::new(Vec::new())),
            text: "ok".to_string(),
        }),
        tmp.path(),
        escalation_test_settings(1),
    );
    strict_goal_with_rejections(&engine, 3);
    engine
        .state
        .update_goal_status(kcoder_state::GoalStatus::Paused)
        .unwrap();
    assert!(engine.maybe_escalate_goal_model().is_none());
}

#[tokio::test]
async fn goal_model_escalation_fires_before_the_next_provider_request() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = escalation_test_settings(1);
    // The escalated ladder provider targets an unreachable address; zero retries keeps the test fast.
    settings.max_retries = 0;
    let engine = test_engine_with_settings(
        Arc::new(StaticTextProvider {
            requests: Arc::new(Mutex::new(Vec::new())),
            text: "ok".to_string(),
        }),
        tmp.path(),
        settings,
    );
    strict_goal_with_rejections(&engine, 1);
    engine
        .state
        .add_message(Message::user_text("continue the goal"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = engine.run_turn_stream(&prompt).collect::<Vec<_>>().await;

    assert!(
        events.iter().any(|event| {
            matches!(event, EngineEvent::SystemNotice(text) if text.contains("Goal Pro model escalation"))
        }),
        "escalation SystemNotice must be emitted"
    );
    let transcript = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(500))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        transcript.contains("Goal Pro model escalation"),
        "{transcript}"
    );
    assert!(transcript.contains("ladder:ladder-model"), "{transcript}");
    assert_eq!(engine.model_name(), "ladder-model");
    assert_eq!(engine.state.goal().unwrap().model_escalation_rung, 1);
}

#[tokio::test]
async fn initial_content_blocks_reach_clients_without_duplicate_history() {
    #[derive(Debug)]
    struct InitialBlocks;
    impl Provider for InitialBlocks {
        fn name(&self) -> &'static str { "initial-blocks" }
        fn stream_messages(&self, _: MessagesRequest) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::Thinking { thinking: "initial thought".into(), signature: String::new() } }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::ContentBlockStart { index: 1, content_block: ContentBlock::Text { text: "initial answer".into() } }),
                Ok(StreamEvent::ContentBlockStop { index: 1 }),
                Ok(StreamEvent::MessageStop),
            ])))
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.session_memory.enabled = false;
    let engine = test_engine_with_settings(Arc::new(InitialBlocks), temp.path(), settings);
    engine.state.set_messages(vec![Message::user_text("fixture")]);
    let events: Vec<_> = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect().await;
    assert_eq!(events.iter().filter(|event| matches!(event, EngineEvent::AssistantThinkingDelta(value) if value == "initial thought")).count(), 1);
    assert_eq!(events.iter().filter(|event| matches!(event, EngineEvent::AssistantTextDelta(value) if value == "initial answer")).count(), 1);
    let messages = engine.state.messages();
    assert_eq!(messages.iter().filter_map(|message| match message { Message::Assistant { content, .. } => Some(content), _ => None }).flatten().filter(|block| matches!(block, ContentBlock::Text {text} if text == "initial answer")).count(), 1);
}
