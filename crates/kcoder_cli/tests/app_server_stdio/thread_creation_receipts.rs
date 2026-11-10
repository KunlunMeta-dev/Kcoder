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
