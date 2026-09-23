#[test]
fn configured_catalog_groups_models_without_collapsing_provider_or_default_identity() {
    assert_eq!(server_capabilities(false).experimental.get("qualifiedModelSelectionV1"), Some(&true));
    let row = |provider: &str, model: &str, current: bool, vision: bool| kcoder_engine::ConfiguredModelProfile {
        profile_name: provider.into(), provider: provider.into(), model: model.into(),
        current, vision, reasoning: !vision, reasoning_effort: None, configuration: None, available: true, error: None,
    };
    let response = configured_model_catalog_response(vec![
        row("primary", "text", false, false), row("primary", "vision", true, true),
        row("secondary", "text", false, false),
    ]);
    let models = response["data"].as_array().unwrap();
    let providers = response["providers"].as_array().unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0]["id"], "primary");
    assert_eq!(providers[0]["data"].as_array().unwrap().len(), 2);
    assert_eq!(models[0]["id"], "primary::text");
    assert_eq!(models[1]["id"], "primary::vision");
    assert_eq!(models[2]["id"], "secondary::text");
    assert_eq!(models.iter().filter(|model| model["isDefault"] == true).count(), 1);
    assert_eq!(models[0]["providerCurrent"], true);
    assert_eq!(models[1]["isDefault"], true);
    assert_eq!(models[1]["supportsVision"], true);
    assert_eq!(models[0]["supportsVision"], false);
    assert_eq!(models[2]["providerCurrent"], false);
}

#[test]
fn local_runtime_preflight_error_is_not_a_provider_failure() {
    let response = protocol_io::local_runtime_error_response(json!(7), "Storage initialization failed");
    assert_eq!(response["id"], 7);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(response["error"]["message"], "Storage initialization failed");
    assert_eq!(response["error"]["data"], json!({"error_type":"local_runtime_error"}));
    assert!(response["error"]["data"].get("provider_failure").is_none());
}

#[test]
fn tool_input_phase_events_preserve_scope_without_synthesizing_execution() {
    let mut projection = StreamProjection::new("server".into(), "thread".into(), "turn".into(), Arc::new(AtomicU64::new(0)));
    let reset = projection.project(EngineEvent::ToolInputReset);
    let progress = projection.project(EngineEvent::ToolInputProgress { id: "write-1".into(), name: "write".into(), chars: 0 });
    let started = projection.project(EngineEvent::ToolUseStarted { id: "write-1".into(), name: "write".into(), input: json!({"path":"fixture.txt","content":"finished arguments"}) });
    assert_eq!(reset[0]["method"], "item/event");
    assert_eq!(reset[0]["params"]["event"], json!({"type":"tool_input_reset"}));
    assert_eq!(progress[0]["method"], "item/event");
    assert_eq!(progress[0]["params"]["event"], json!({"type":"tool_input_progress","id":"write-1","name":"write","chars":0}));
    assert_eq!(started[0]["method"], "item/started");
    assert_eq!(started[0]["params"]["item"]["id"], "write-1");
    for event in [&reset[0], &progress[0], &started[0]] {
        assert_eq!(event["params"]["threadId"], "thread");
        assert_eq!(event["params"]["turnId"], "turn");
    }
    assert!(reset[0]["params"]["sequence"].as_u64().unwrap() < progress[0]["params"]["sequence"].as_u64().unwrap());
    assert!(progress[0]["params"]["sequence"].as_u64().unwrap() < started[0]["params"]["sequence"].as_u64().unwrap());
}

#[test]
fn e2e_approval_timeout_accepts_only_a_short_bounded_duration() {
    assert_eq!(
        parse_e2e_approval_timeout(Some("250")),
        Some(Duration::from_millis(250))
    );
    assert_eq!(parse_e2e_approval_timeout(None), None);
    assert_eq!(parse_e2e_approval_timeout(Some("not-a-number")), None);
    assert_eq!(parse_e2e_approval_timeout(Some("9")), None);
    assert_eq!(parse_e2e_approval_timeout(Some("30001")), None);
}
#[test]
fn prompt_accepts_simple_and_structured_input() {
    assert_eq!(
        prompt_from_params(&json!({"prompt": "hello"})).as_deref(),
        Some("hello")
    );
    assert_eq!(
        prompt_from_params(&json!({"input": [
            {"type": "text", "text": "hello"},
            {"type": "text", "text": "world"}
        ]}))
        .as_deref(),
        Some("hello\nworld")
    );
    assert!(prompt_from_params(&json!({"prompt": "  "})).is_none());
}
#[test]
fn initialization_gate_returns_machine_readable_error() {
    let state = ConnectionState::default();
    assert_eq!(
        state.require_initialized(json!(7)).unwrap(),
        json!({"jsonrpc": "2.0", "id": 7, "error": {"code": NOT_INITIALIZED, "message": "Not initialized"}})
    );
}

#[test]
fn path_preview_server_initialize_negotiates_and_freezes_capability() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    for offered in [None, Some(false), Some(true)] {
        let mut state = ConnectionState::default();
        assert!(!state.tool_path_preview_v1);
        let mut params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": {"name": "test", "version": "1"}
        });
        if let Some(value) = offered {
            params["capabilities"] = json!({"experimental": {"toolPathPreviewV1": value}});
        }
        let response = state.initialize(json!(1), &params, &engine);
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(
            response["result"]["capabilities"]["experimental"]["toolPathPreviewV1"],
            true
        );
        assert_eq!(state.tool_path_preview_v1, offered == Some(true));
        params["capabilities"] =
            json!({"experimental": {"toolPathPreviewV1": offered != Some(true)}});
        assert_eq!(
            state.initialize(json!(2), &params, &engine)["error"]["code"],
            -32600
        );
        assert_eq!(state.tool_path_preview_v1, offered == Some(true));
    }
}

#[test]
fn path_preview_server_invalid_initialize_does_not_commit_capability() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    for (protocol, offered) in [
        ("unsupported", json!(true)),
        (PROTOCOL_VERSION, json!("true")),
        (PROTOCOL_VERSION, json!(1)),
    ] {
        let mut state = ConnectionState::default();
        let mut params = json!({
            "protocolVersion": protocol,
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {"experimental": {"toolPathPreviewV1": offered}}
        });
        assert_eq!(
            state.initialize(json!(1), &params, &engine)["error"]["code"],
            -32602
        );
        assert!(!state.initialized);
        assert!(!state.tool_path_preview_v1);
        params["protocolVersion"] = json!(PROTOCOL_VERSION);
        params["capabilities"] = json!({"experimental": {"toolPathPreviewV1": true}});
        assert!(
            state
                .initialize(json!(2), &params, &engine)
                .get("error")
                .is_none()
        );
        assert!(state.tool_path_preview_v1);
    }
}

#[test]
fn path_preview_server_turn_engine_and_projection_preserve_connection_context() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let mut state = ConnectionState::default();
    let response = state.initialize(
        json!(1),
        &json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {"experimental": {"toolPathPreviewV1": true}}
        }),
        &engine,
    );
    assert!(response.get("error").is_none());
    let cancel = CancellationToken::new();
    let task_engine = state.configure_turn_engine(&engine, cancel.clone());
    let other = ConnectionState::default().configure_turn_engine(&engine, CancellationToken::new());
    cancel.cancel();
    assert!(task_engine.cancel_token().is_cancelled());
    assert!(!engine.cancel_token().is_cancelled());
    assert!(!other.cancel_token().is_cancelled());
    let mut projection = StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(0)),
    );
    for path in [Some("src/main.rs".to_string()), None] {
        let events = projection.project(EngineEvent::ToolPathPreview {
            attempt_id: "attempt".into(),
            id: "tool".into(),
            path: path.clone(),
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["method"], "item/event");
        let params = &events[0]["params"];
        assert_eq!(params["serverId"], "server");
        assert_eq!(params["threadId"], "thread");
        assert_eq!(params["turnId"], "turn");
        assert_eq!(params["event"]["type"], "tool_path_preview");
        assert_eq!(params["event"]["attempt_id"], "attempt");
        assert_eq!(params["event"]["id"], "tool");
        assert_eq!(params["event"]["path"], json!(path));
        assert!(params["event"].get("path").is_some());
    }
}
#[test]
fn envelopes_use_shared_jsonrpc_contract() {
    assert_eq!(
        success_response(json!(1), json!({"ok": true})),
        json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}})
    );
    assert_eq!(
        notification("turn/started", json!({"id": "t"})),
        json!({"jsonrpc": "2.0", "method": "turn/started", "params": {"id": "t"}})
    );
}
#[tokio::test]
async fn jsonrpc_line_reader_enforces_the_protocol_limit() {
    let mut accepted = vec![b'a'; MAX_JSONRPC_LINE_BYTES];
    accepted.push(b'\n');
    let mut reader = BufReader::new(accepted.as_slice());
    let Some(JsonRpcLine::Line(accepted)) = read_bounded_jsonrpc_line(&mut reader).await.unwrap()
    else {
        panic!("exact-limit JSON-RPC line should be accepted");
    };
    assert_eq!(accepted.len(), MAX_JSONRPC_LINE_BYTES);

    let mut rejected = vec![b'a'; MAX_JSONRPC_LINE_BYTES + 1];
    rejected.push(b'\n');
    let mut reader = BufReader::new(rejected.as_slice());
    assert_eq!(
        read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
        Some(JsonRpcLine::TooLarge)
    );
}

#[tokio::test]
async fn oversized_protocol_line_is_discarded_without_consuming_the_next_frame() {
    let mut input = vec![b'x'; MAX_JSONRPC_LINE_BYTES + 1];
    input.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}\n");
    let mut reader = BufReader::new(input.as_slice());

    assert_eq!(
        read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
        Some(JsonRpcLine::TooLarge)
    );
    let Some(JsonRpcLine::Line(next)) = read_bounded_jsonrpc_line(&mut reader).await.unwrap()
    else {
        panic!("next protocol frame should remain readable");
    };
    assert_eq!(next, r#"{"jsonrpc":"2.0","method":"initialized"}"#);
}

#[tokio::test]
async fn jsonrpc_line_reader_rejects_invalid_utf8_without_lossy_decoding() {
    let input = [0xff, b'\n'];
    let mut reader = BufReader::new(input.as_slice());
    assert_eq!(
        read_bounded_jsonrpc_line(&mut reader).await.unwrap(),
        Some(JsonRpcLine::InvalidUtf8)
    );
}
#[test]
fn browser_responses_and_errors_are_bounded_before_queueing() {
    let oversized = "x".repeat(MAX_DEVICE_RESULT_BYTES + 1);
    assert!(browser_success_response(json!(1), oversized, MAX_DEVICE_RESULT_BYTES).is_err());

    let error = error_response(
        json!(1),
        -32602,
        &format!("{}界", "x".repeat(MAX_ERROR_MESSAGE_BYTES)),
    );
    let message = error["error"]["message"].as_str().unwrap();
    assert!(message.len() <= MAX_ERROR_MESSAGE_BYTES);
    assert!(message.is_char_boundary(message.len()));
}
