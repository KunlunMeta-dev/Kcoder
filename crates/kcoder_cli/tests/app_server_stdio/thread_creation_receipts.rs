#[test]
fn missing_provider_rejects_before_thread_creation_without_an_unknown_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings = config.join("settings.json");
    std::fs::write(&settings, r#"{"providers":{}}"#).unwrap();
    let mut server = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{"clientRequestId":"missing-provider-request"}}));
    let response = server.response(2);
    assert_eq!(
        response["error"]["code"],
        kcoder_app_protocol::PROVIDER_CONFIGURATION_REQUIRED,
        "{response}"
    );
    server.send(json!({"id":3,"method":"thread/creation/read","params":{"clientRequestId":"missing-provider-request"}}));
    let receipt = server.response(3);
    assert!(receipt.get("error").is_none(), "{receipt}");
    assert!(receipt["result"]["receipt"].is_null(), "{receipt}");
    server.send(json!({"id":4,"method":"thread/list","params":{}}));
    let threads = server.response(4);
    assert_eq!(threads["result"]["threads"], json!([]), "{threads}");
    server.shutdown_successfully();
}

#[test]
fn missing_api_key_rejects_the_turn_without_losing_the_created_thread() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{"clientRequestId":"no-key"}}));
    let response = server.response(2);
    assert!(response.get("error").is_none(), "{response}");
    let thread = response["result"]["thread"]["id"].as_str().unwrap();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"clientMessageId":"no-key-turn","input":[{"type":"text","text":"hello"}]}}));
    let turn = server.response(3);
    assert_eq!(
        turn["error"]["code"],
        kcoder_app_protocol::PROVIDER_AUTHENTICATION_REQUIRED,
        "{turn}"
    );
    server.send(
        json!({"id":4,"method":"thread/creation/read","params":{"clientRequestId":"no-key"}}),
    );
    let receipt = server.response(4);
    assert_eq!(receipt["result"]["receipt"]["status"], "ready", "{receipt}");
    assert_eq!(receipt["result"]["receipt"]["threadId"], thread);
    server.shutdown_successfully();
}

#[test]
fn temporary_mcp_failure_rejects_before_a_thread_creation_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"mcp-rejection","version":"1"},"capabilities":{"experimental":{"threadMcpServersV1":true}}}}));
    let initialized = server.response(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadMcpServersV1"],
        true
    );
    server.send(json!({"id":2,"method":"thread/start","params":{"clientRequestId":"failed-mcp","mcpServers":[{"name":"owned-missing-mcp","command":"must-not-exist-kcoder-test-server"}]}}));
    let response = server.response(2);
    assert_eq!(
        response["error"]["code"],
        kcoder_app_protocol::THREAD_MCP_SETUP_FAILED,
        "{response}"
    );
    server.send(
        json!({"id":3,"method":"thread/creation/read","params":{"clientRequestId":"failed-mcp"}}),
    );
    let receipt = server.response(3);
    assert!(receipt.get("error").is_none(), "{receipt}");
    assert!(receipt["result"]["receipt"].is_null(), "{receipt}");
    server.shutdown_successfully();
}

#[test]
fn durable_fork_receipts_reuse_the_original_thread_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || {
        TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .stream_delay_ms("1")
            .spawn()
    };
    let mut server = spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadForkReceiptsV1"],
        true
    );
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let parent = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":parent,"input":[{"type":"text","text":"fork receipt test"}]}}));
    let response = server.response(3);
    assert!(response.get("error").is_none(), "{response}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if server.next_value(deadline)["method"] == "turn/completed" {
            break;
        }
    }
    server.send(json!({"id":100,"method":"thread/fork","params":{"threadId":parent,"ephemeral":true,"clientRequestId":"temporary-id"}}));
    assert!(server.response(100).get("error").is_some());
    server.send(json!({"id":101,"method":"thread/creation/read","params":{"clientRequestId":"temporary-id"}}));
    assert!(server.response(101)["result"]["receipt"].is_null());
    let fork = |id| json!({"id":id,"method":"thread/fork","params":{"threadId":parent,"lastTurnId":"turn-1","clientRequestId":"fork-once","excludeTurns":true}});
    server.send(fork(4));
    let original = server.response(4);
    assert!(original.get("error").is_none(), "{original}");
    let fork_id = original["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(fork_id, parent);
    server.send(fork(5));
    assert_eq!(server.response(5)["result"], original["result"]);
    server.send(
        json!({"id":6,"method":"thread/creation/read","params":{"clientRequestId":"fork-once"}}),
    );
    let receipt = server.response(6);
    assert_eq!(receipt["result"]["receipt"]["status"], "ready", "{receipt}");
    assert_eq!(receipt["result"]["receipt"]["threadId"], fork_id);
    server.send(json!({"id":7,"method":"thread/fork","params":{"threadId":parent,"lastTurnId":"other-turn","clientRequestId":"fork-once"}}));
    assert!(server.response(7).get("error").is_some());
    // A fork identity cannot be reinterpreted as a thread/start identity.
    server.send(json!({"id":8,"method":"thread/start","params":{"clientRequestId":"fork-once"}}));
    assert!(server.response(8).get("error").is_some());
    server.shutdown_successfully();
    let mut restored = spawn();
    restored.initialize(1);
    // Replays need no resident source thread and cannot create another fork.
    restored.send(fork(2));
    assert_eq!(restored.response(2)["result"], original["result"]);
    // A crash after reservation must remain unknown instead of retrying writes.
    let filename = format!("{:x}.json", Sha256::digest(b"fork-once"));
    let path = find_named_file(temp.path(), &filename).unwrap();
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["thread"] = Value::Null;
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    restored.send(fork(3));
    assert!(restored.response(3).get("error").is_some());
    restored.send(
        json!({"id":4,"method":"thread/creation/read","params":{"clientRequestId":"fork-once"}}),
    );
    assert_eq!(
        restored.response(4)["result"]["receipt"]["status"],
        "unknown"
    );
    restored.shutdown_successfully();
}

#[test]
#[cfg(unix)]
fn thread_creation_receipts_survive_restart_without_repeating_startup_hooks() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let marker = temp.path().join("startup-count");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["providers"]["integration-test"]["authentication"] = json!({"mode":"none"});
    value["hooks"] = json!({"SessionStart":[{"hooks":[{"type":"command","shell":"sh","timeout":5,
        "command":format!("printf x >> '{}'\nprintf '%s\\n' '{}'", marker.display(),
            r#"{"hookSpecificOutput":{"additionalContext":"original-creation-hook-context"}}"#)}]}]});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let spawn = || {
        TestAppServer::builder(&workspace, &overlay)
            .config_dir(&config)
            .without_scenario()
            .spawn()
    };
    let mut server = spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"],
        true
    );
    let create = |id| json!({"jsonrpc":"2.0","id":id,"method":"thread/start","params":{"clientRequestId":"create-once"}});
    server.send(create(2));
    let first = server.response(2);
    assert!(first.get("error").is_none(), "{first}");
    let thread = first["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let history_path = find_named_file(temp.path(), &format!("{thread}.jsonl")).unwrap();
    let initial = kcoder_state::prepare_session_resume(&history_path).unwrap();
    let initial_digest = initial.initial_creation_history_digest().unwrap().unwrap();
    let messages = initial.load_transcript_messages().unwrap();
    assert!(
        !messages.is_empty(),
        "Startup context must be durable before ready"
    );
    assert!(
        messages
            .iter()
            .all(|message| message.origin() == kcoder_types::MessageOrigin::Runtime)
    );
    assert!(
        serde_json::to_string(&messages)
            .unwrap()
            .contains("original-creation-hook-context")
    );
    let filename = format!("{:x}.json", Sha256::digest(b"create-once"));
    let path = find_named_file(temp.path(), &filename).unwrap();
    let original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(original["initial_creation_sha256"], initial_digest);
    server.send(create(3));
    let replay = server.response(3);
    assert_eq!(replay["result"], first["result"], "{replay}");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    server.send(json!({"id":4,"method":"thread/start","params":{"clientRequestId":"create-once","model":"other"}}));
    assert_eq!(server.response(4)["error"]["code"], -32059);
    server.shutdown_successfully();
    let mut restored = spawn();
    restored.initialize(1);
    restored.send(
        json!({"id":2,"method":"thread/creation/read","params":{"clientRequestId":"create-once"}}),
    );
    let receipt = restored.response(2);
    assert_eq!(receipt["result"]["receipt"]["status"], "ready", "{receipt}");
    assert_eq!(receipt["result"]["receipt"]["threadId"], thread);
    serde_json::from_value::<kcoder_app_protocol::ThreadCreationReadResult>(
        receipt["result"].clone(),
    )
    .unwrap();
    restored.send(create(3));
    assert_eq!(restored.response(3)["result"], first["result"]);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    kcoder_state::prepare_session_resume(&history_path)
        .unwrap()
        .verify_initial_creation_history(&initial_digest)
        .unwrap();
    // Simulate a crash after startup but before writing completion evidence.
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["thread"] = Value::Null;
    std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    restored.send(
        json!({"id":4,"method":"thread/creation/read","params":{"clientRequestId":"create-once"}}),
    );
    assert_eq!(
        restored.response(4)["result"]["receipt"]["status"],
        "unknown"
    );
    restored.send(create(5));
    assert_eq!(restored.response(5)["error"]["code"], -32059);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    restored.shutdown_successfully();
}
