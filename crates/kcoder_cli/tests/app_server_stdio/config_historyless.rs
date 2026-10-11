#[test]
fn deterministic_app_server_ignores_invalid_provider_settings() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("invalid-settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({ "active_provider": "missing-profile" })).unwrap(),
    )
    .unwrap();

    let config = temp.path().join("config");
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    server.send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "invalid-settings-test", "version": "1"}}
    }));

    let message = server.next_value(Instant::now() + Duration::from_secs(10));
    assert_eq!(message["id"], 1);
    assert!(message.get("result").is_some(), "{message:#}");

    server.shutdown_successfully();
    assert!(
        !temp.path().join(".kcoder").exists(),
        "deterministic app-server must not initialize project-local KCoder metadata"
    );
}

#[test]
fn missing_provider_context_limits_fail_turns_without_poisoning_the_session() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    std::fs::write(&settings, r#"{"providers":{},"model":"tui-dev-mock"}"#).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&temp.path().join("config"))
        .spawn();
    server.send_batch([
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"missing-budget","version":"1"}}}),
        json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}),
    ]);
    let deadline = Instant::now() + Duration::from_secs(10);
    let thread_id = loop {
        let message = server.next_value(deadline);
        if message["id"] == 2 { break message["result"]["thread"]["id"].as_str().unwrap().to_owned(); }
    };
    for id in [3, 4] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":"hello"}]}}));
        let mut turn_id = None;
        loop {
            let message = server.next_value(deadline);
            if message["id"] == id {
                assert!(message.get("error").is_none(), "{message}");
                turn_id = message["result"]["turn"]["id"].as_str().map(str::to_owned);
            }
            if message["method"] == "turn/completed" {
                assert!(turn_id.is_some());
                assert_eq!(message["params"]["turn"]["id"].as_str(), turn_id.as_deref());
                assert_eq!(message["params"]["turn"]["status"], "failed");
                break;
            }
        }
    }
    server.shutdown_successfully();
}

#[test]
fn historyless_app_server_starts_and_completes_a_turn_outside_the_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("historyless-settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({
            "history_enabled": false,
            "active_provider": "integration-test",
            "providers": {
                "integration-test": {
                    "api_format": "openai_chat_completions",
                    "endpoint": "http://127.0.0.1:1/v1",
                    "default_model": "deterministic-scenario",
                    "context_window_tokens": 128000,
                    "output_headroom_tokens": 8192,
                    "max_output_tokens": 8192,
                    "request_timeout_secs": 30,
                    "no_proxy": true,
                    "extra_body": {}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let config = temp.path().join("config");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut server = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .stream_delay_ms("1")
        .spawn();
    server.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "historyless-test", "version": "1"}}
        }),
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}),
    ]);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut messages = Vec::new();
    let thread_id = loop {
        let message = server.next_value(deadline);
        let thread_id = message
            .get("result")
            .and_then(|result| result.get("thread"))
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        messages.push(message);
        if let Some(thread_id) = thread_id {
            break thread_id;
        }
    };
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/metadata/update",
        "params": {"threadId": thread_id, "title": "首轮前标题"}
    }));
    loop {
        let message = server.next_value(deadline);
        let updated = message["id"] == 4;
        if updated {
            assert_eq!(message["result"]["thread"]["title"], "首轮前标题");
            assert_eq!(message["result"]["thread"]["metadata"]["revision"], 1);
            assert!(message["result"]["thread"]["metadata"]["archivedAt"].is_null());
        }
        messages.push(message);
        if updated {
            break;
        }
    }
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "historyless turn"}]}
    }));
    loop {
        let message = server.next_value(deadline);
        let completed = message["method"] == "turn/completed";
        messages.push(message);
        if completed {
            break;
        }
    }
    assert_eq!(
        messages.iter().find(|message| message["id"] == 1).unwrap()["result"]["capabilities"]["threadResume"],
        false
    );
    assert!(messages.iter().any(|message| message["id"] == 2));
    assert!(messages.iter().any(|message| message["id"] == 3));
    assert!(messages.iter().any(|message| message["id"] == 4));
    server.shutdown_successfully();
    assert!(
        !workspace.join(".kcoder").exists(),
        "history-less app-server must keep all session artifacts outside the workspace"
    );
}
