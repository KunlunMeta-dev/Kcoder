#[test]
fn ephemeral_fork_inherits_history_without_listing_or_persisting_as_a_normal_thread() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["ephemeralThreads"], true);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let source = server.response(2)["result"]["thread"]["id"].as_str().unwrap().to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
        "threadId":source,"input":[{"type":"text","text":"source-context-marker"}]
    }}));
    assert!(server.response(3)["result"].is_object());
    server.wait_for_method("turn/completed");
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/fork","params":{
        "threadId":source,"ephemeral":true
    }}));
    let forked = server.response(4);
    assert_eq!(forked["result"]["ephemeral"], true, "{forked}");
    let child = forked["result"]["thread"]["id"].as_str().unwrap().to_owned();
    assert_ne!(child, source);
    server.send(json!({"jsonrpc":"2.0","id":40,"method":"thread/fork","params":{
        "threadId":child,"lastTurnId":"turn-1"
    }}));
    assert!(server.response(40)["error"].is_object());
    server.send(json!({"jsonrpc":"2.0","id":41,"method":"thread/fork","params":{
        "threadId":source,"lastTurnId":"turn-1","ephemeral":"true"
    }}));
    assert!(server.response(41)["error"].is_object());
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"thread/read","params":{"threadId":child}}));
    assert!(server.response(5)["result"].to_string().contains("source-context-marker"));
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"thread/list","params":{}}));
    let listed = server.response(6)["result"].to_string();
    assert!(listed.contains(&source));
    assert!(!listed.contains(&child));
    assert!(find_named_file(temp.path(), &format!("{child}.jsonl")).is_none());
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"turn/start","params":{
        "threadId":child,"input":[{"type":"text","text":"temporary-only-marker"}]
    }}));
    assert!(server.response(7)["result"].is_object());
    server.wait_for_method("turn/completed");
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"thread/read","params":{"threadId":source}}));
    assert!(!server.response(8)["result"].to_string().contains("temporary-only-marker"));
    server.send(json!({"jsonrpc":"2.0","id":80,"method":"server/info","params":{}}));
    let info = server.response(80);
    assert_eq!(info["result"]["id"], source);
    assert!(!info.to_string().contains(&child));
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"thread/dispose","params":{"threadId":source}}));
    assert!(server.response(9)["error"].is_object());
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"thread/dispose","params":{"threadId":child}}));
    assert_eq!(server.response(10)["result"]["disposed"], true);
    server.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/resume","params":{"threadId":child}}));
    assert!(server.response(11)["error"].is_object());
    server.shutdown();
}

#[test]
fn ephemeral_fork_rejects_an_incomplete_source_turn_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServerBuilder::new(&workspace, &settings).stream_delay_ms("500").spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let source = server.response(2)["result"]["thread"]["id"].as_str().unwrap().to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
        "threadId":source,"input":[{"type":"text","text":"still-running-source"}]
    }}));
    assert!(server.response(3)["result"].is_object());
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/fork","params":{
        "threadId":source,"ephemeral":true
    }}));
    assert!(server.response(4)["error"]["message"].as_str().unwrap().contains("completed source turn"));
    server.shutdown();
}
