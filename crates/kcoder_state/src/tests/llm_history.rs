    #[test]
    fn provider_error_summary_capture_omits_error_secrets_keeps_success_content() {
        let request = MessagesRequest::new("test", vec![Message::user_text("SUCCESS_PRIVATE")]);
        let events = [StreamEvent::Error {
            error: kcoder_types::ApiError {
                error_type: "SENTINEL_PRIVATE".into(),
                message: "SENTINEL_PRIVATE Bearer multiple words".repeat(1000),
            },
        }];
        let bytes = crate::llm_history::encode_llm_exchange(
            "test",
            &request,
            &events,
            Some("SENTINEL_PRIVATE https://host/?token=secret"),
            0,
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("SENTINEL_PRIVATE"));
        assert!(text.contains("SUCCESS_PRIVATE"));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(value["response"]["error"].as_str().unwrap().len() <= 512);
    }

    #[test]
    fn record_llm_exchange_writes_request_and_response_artifact() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        let request = MessagesRequest::new("test-model", vec![Message::user_text("hello")])
            .with_reasoning_effort(Some(ReasoningEffort::High))
            .with_debug_session_id("debug-session");

        state.record_llm_exchange(&request, &[StreamEvent::MessageStop], None);

        let dir = llm_request_history_dir_path(tmp.path(), "session");
        let files = sorted_json_files(&dir);
        assert_eq!(files.len(), 1);
        let raw = fs::read_to_string(&files[0]).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schema"], "kcoder.llm_exchange.v2");
        assert_eq!(value["session_id"], "session");
        assert_eq!(value["request"]["model"], "test-model");
        assert_eq!(
            value["request"]["messages"][0]["content"][0]["text"],
            "hello"
        );
        assert_eq!(value["request_metadata"]["reasoning_effort"], "high");
        assert_eq!(
            value["request_metadata"]["debug_session_id"],
            "debug-session"
        );
        assert_eq!(value["request_metadata"]["has_response_json_schema"], false);
        assert_eq!(value["response"]["events"][0]["type"], "message_stop");
        assert_eq!(value["response"]["prompt_cache"]["status"], "not_reported");
        assert!(value["response"].get("error").is_none());
    }

    #[test]
    fn write_llm_exchange_record_supports_repeated_writes_to_the_same_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("llm-requests");
        let request = MessagesRequest::new("test-model", vec![Message::user_text("hello")]);

        write_llm_exchange_record(&dir, "session", &request, &[], None).unwrap();
        write_llm_exchange_record(&dir, "session", &request, &[], None).unwrap();

        assert_eq!(sorted_json_files(&dir).len(), 2);
    }

    #[test]
    fn record_llm_exchange_summarizes_upstream_prompt_cache_usage() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        let request = MessagesRequest::new("claude-test", vec![Message::user_text("hello")]);
        let events = vec![
            StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-1".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "claude-test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(kcoder_types::Usage {
                        input_tokens: 64,
                        output_tokens: 1,
                        cache_creation_input_tokens: Some(256),
                        cache_read_input_tokens: Some(4096),
                        total_tokens: None,
                        iterations: None,
                    }),
                },
            },
            StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: Some(kcoder_types::Usage {
                        input_tokens: 0,
                        output_tokens: 32,
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                        total_tokens: None,
                        iterations: None,
                    }),
                },
            },
            StreamEvent::MessageStop,
        ];

        state.record_llm_exchange(&request, &events, None);

        let files = sorted_json_files(&llm_request_history_dir_path(tmp.path(), "session"));
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
        assert_eq!(value["schema"], "kcoder.llm_exchange.v2");
        assert_eq!(value["response"]["usage"]["input_tokens"], 64);
        assert_eq!(value["response"]["usage"]["output_tokens"], 32);
        assert_eq!(value["response"]["prompt_cache"]["status"], "hit");
        assert_eq!(
            value["response"]["prompt_cache"]["cache_creation_input_tokens"],
            256
        );
        assert_eq!(
            value["response"]["prompt_cache"]["cache_read_input_tokens"],
            4096
        );
    }

    #[test]
    fn record_llm_exchange_marks_unreported_prompt_cache_usage() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        let request = MessagesRequest::new("model", vec![Message::user_text("hello")]);
        let events = vec![StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(kcoder_types::Usage {
                    input_tokens: 10,
                    output_tokens: 2,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    total_tokens: None,
                    iterations: None,
                }),
            },
        }];

        state.record_llm_exchange(&request, &events, None);

        let files = sorted_json_files(&llm_request_history_dir_path(tmp.path(), "session"));
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
        assert_eq!(value["response"]["prompt_cache"]["status"], "not_reported");
    }

    #[test]
    fn record_llm_exchange_prunes_oldest_artifacts_after_limit() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);

        for index in 0..35 {
            let request = MessagesRequest::new(
                "test-model",
                vec![Message::user_text(format!("request-{index:02}"))],
            );
            state.record_llm_exchange(&request, &[], None);
        }

        let dir = llm_request_history_dir_path(tmp.path(), "session");
        let files = sorted_json_files(&dir);
        assert_eq!(files.len(), LLM_EXCHANGE_HISTORY_LIMIT);
        let joined = files
            .iter()
            .map(|file| fs::read_to_string(file).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!joined.contains("request-00"));
        assert!(!joined.contains("request-04"));
        assert!(joined.contains("request-05"));
        assert!(joined.contains("request-34"));
    }

    #[test]
    fn record_session_memory_llm_exchange_uses_subdir_and_prunes_oldest_artifacts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);

        for index in 0..35 {
            let request = MessagesRequest::new(
                "test-model",
                vec![Message::user_text(format!(
                    "session-memory-request-{index:02}"
                ))],
            );
            state.record_session_memory_llm_exchange(&request, &[StreamEvent::MessageStop], None);
        }

        let main_dir = llm_request_history_dir_path(tmp.path(), "session");
        assert!(sorted_json_files(&main_dir).is_empty());

        let dir = session_memory_llm_request_history_dir_path(tmp.path(), "session");
        let files = sorted_json_files(&dir);
        assert_eq!(files.len(), LLM_EXCHANGE_HISTORY_LIMIT);
        let joined = files
            .iter()
            .map(|file| fs::read_to_string(file).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!joined.contains("session-memory-request-00"));
        assert!(!joined.contains("session-memory-request-04"));
        assert!(joined.contains("session-memory-request-05"));
        assert!(joined.contains("session-memory-request-34"));
    }

    #[test]
    fn record_llm_exchange_can_use_subagent_override_dir() {
        let tmp = TempDir::new().unwrap();
        let state = AppState::new("/");
        let dir = tmp
            .path()
            .join("session")
            .join("subagents")
            .join("job-1")
            .join("llm-requests");
        state.with_llm_request_history_dir(&dir, "session");

        let request = MessagesRequest::new("test-model", vec![Message::user_text("subagent")]);
        state.record_llm_exchange(&request, &[StreamEvent::MessageStop], None);

        let files = sorted_json_files(&dir);
        assert_eq!(files.len(), 1);
        let raw = fs::read_to_string(&files[0]).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["session_id"], "session");
        assert_eq!(
            value["request"]["messages"][0]["content"][0]["text"],
            "subagent"
        );
    }

    #[test]
    fn record_session_memory_llm_exchange_uses_isolated_subdir() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);

        let request = MessagesRequest::new(
            "summary-model",
            vec![Message::user_text("session memory prompt")],
        )
        .with_debug_session_id("session");
        state.record_session_memory_llm_exchange(
            &request,
            &[StreamEvent::MessageStop],
            Some("validation failed"),
        );

        let dir = session_memory_llm_request_history_dir_path(tmp.path(), "session");
        let files = sorted_json_files(&dir);
        assert_eq!(files.len(), 1);
        assert!(sorted_json_files(&llm_request_history_dir_path(tmp.path(), "session")).is_empty());
        let raw = fs::read_to_string(&files[0]).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schema"], "kcoder.llm_exchange.v2");
        assert_eq!(value["session_id"], "session");
        assert_eq!(value["request"]["model"], "summary-model");
        assert_eq!(
            value["request"]["messages"][0]["content"][0]["text"],
            "session memory prompt"
        );
        assert_eq!(value["response"]["events"][0]["type"], "message_stop");
        assert_eq!(
            value["response"]["error"],
            kcoder_types::provider_error_summary("unknown_error", None)
        );
    }

    fn sorted_json_files(dir: &Path) -> Vec<PathBuf> {
        if !dir.exists() {
            return Vec::new();
        }
        let mut files = fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        files.sort();
        files
    }
