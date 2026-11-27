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

#[test]
fn computer_use_turn_status_is_capability_gated_owner_scoped_and_read_only() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut unnegotiated = TestAppServer::builder(&workspace, &settings)
        .discard_stderr()
        .spawn();
    unnegotiated.initialize(1);
    unnegotiated.send(json!({
        "jsonrpc":"2.0","id":2,"method":"computerUse/turn/status",
        "params":{"threadId":"thread","turnId":"turn"}
    }));
    let rejected = unnegotiated.response(2);
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("computerUseTurnStatusV1")
    );
    unnegotiated.shutdown_successfully();

    let mut server = TestAppServer::builder(&workspace, &settings)
        .discard_stderr()
        .spawn();
    server.send(json!({
        "jsonrpc":"2.0","id":10,"method":"initialize",
        "params":{
            "protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,
            "clientInfo":{"name":"computer-use-turn-status-test","version":"1"},
            "capabilities":{"experimental":{"computerUseTurnStatusV1":true}}
        }
    }));
    let initialized = server.response(10);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["computerUseTurnStatusV1"], true,
        "{initialized}"
    );
    server.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/start","params":{}}));
    let started = server.response(11);
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .expect("owned thread starts")
        .to_owned();

    server.send(json!({
        "jsonrpc":"2.0","id":12,"method":"computerUse/turn/status",
        "params":{"threadId":"foreign-thread","turnId":"turn"}
    }));
    let foreign = server.response(12);
    assert_eq!(foreign["error"]["code"], -32602, "{foreign}");
    assert!(
        foreign["error"]["message"]
            .as_str()
            .unwrap()
            .contains("does not belong")
    );

    server.send(json!({"jsonrpc":"2.0","id":13,"method":"thread/list","params":{}}));
    let before = server.response(13)["result"]["threads"]
        .as_array()
        .unwrap()
        .len();
    server.send(json!({
        "jsonrpc":"2.0","id":14,"method":"computerUse/turn/status",
        "params":{"threadId":thread_id,"turnId":"no-desktop-turn"}
    }));
    let status = server.response(14);
    assert_eq!(status["result"]["threadId"], thread_id);
    assert_eq!(status["result"]["turnId"], "no-desktop-turn");
    assert!(status["result"]["sequence"].as_u64().is_some(), "{status}");
    assert!(status["result"].get("observation").is_none(), "{status}");
    server.send(json!({"jsonrpc":"2.0","id":15,"method":"thread/list","params":{}}));
    let after = server.response(15)["result"]["threads"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(after, before, "a status read must not create a runtime");
    server.shutdown_successfully();
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
