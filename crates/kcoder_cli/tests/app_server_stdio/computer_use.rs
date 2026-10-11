#[test]
fn desktop_turn_without_explicit_approval_is_rejected_before_execution() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .discard_stderr()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"turn/start","params":{
        "threadId":"uncreated-thread","input":[],"computerUse":{"approved":false,"target":"local_windows_desktop"}
    }}));
    let response = server.response(2);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("explicit desktop approval")
    );
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"computerUse/status","params":{}}));
    let response = server.response(3);
    assert_eq!(response["result"]["canControl"], false, "{response}");
    server.shutdown();
}

// Protocol admission only: rejection must occur before any provider/tool work.
#[cfg(not(windows))]
#[test]
fn non_windows_desktop_approval_cannot_start_or_append_a_turn() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .discard_stderr()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"computerUse/status","params":{}}));
    let status = server.response(3);
    assert_eq!(status["result"]["availability"], "unsupported_platform");
    assert_eq!(status["result"]["canControl"], false);
    server.send(
        json!({"jsonrpc":"2.0","id":4,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":"DESKTOP_MUST_NOT_EXECUTE"}],
            "computerUse":{"approved":true,"target":"local_windows_desktop"}
        }}),
    );
    let rejected = server.response(4);
    assert_eq!(rejected["error"]["code"], -32602);
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Windows")
    );
    server.send(
        json!({"jsonrpc":"2.0","id":5,"method":"computerUse/status","params":{"approved":true}}),
    );
    assert_eq!(server.response(5)["error"]["code"], -32602);
    server
        .send(json!({"jsonrpc":"2.0","id":6,"method":"thread/read","params":{"threadId":thread}}));
    let history = server.response(6);
    assert!(history.get("result").is_some());
    assert!(!history.to_string().contains("DESKTOP_MUST_NOT_EXECUTE"));
    server.shutdown();
}
