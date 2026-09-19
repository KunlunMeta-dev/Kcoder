#[test]
fn initialize_advertises_agent_artifact_read_capability() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["agentArtifactsV1"],
        true
    );
    server.shutdown();
}

#[test]
fn agent_artifact_read_requires_an_active_thread() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "agent/artifact/read",
        "params": {"threadId": "thread-not-started", "agentId": "agent-1"}
    }));
    let response = server.response(2);
    assert_eq!(response["error"]["code"], -32024, "{response}");
    server.shutdown();
}

#[test]
fn agent_artifact_read_rejects_unknown_agents_without_echoing_paths() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}
    }));
    let started = server.response(2);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"].as_str().unwrap().to_string();
    let smuggled = temp.path().join("smuggled-report.md");
    std::fs::write(&smuggled, b"secret").unwrap();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "agent/artifact/read",
        "params": {
            "threadId": thread_id,
            "agentId": "missing-agent",
            "path": smuggled.to_string_lossy()
        }
    }));
    let response = server.response(3);
    assert_eq!(response["error"]["code"], -32026, "{response}");
    let message = response["error"]["message"].as_str().unwrap();
    assert!(!message.contains("smuggled-report.md"), "{message}");
    assert!(message.contains("does not belong to this thread"), "{message}");
    server.shutdown();
}
