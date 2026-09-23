#[test]
fn stdio_browser_preflight_reports_prerequisites_without_starting_a_session() {
    // The deterministic provider isolates protocol validation; no model request is needed.
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("runtime-settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["browserPreflight"], true);
    for id in [2, 3] {
        server.send(json!({"jsonrpc":"2.0", "id":id, "method":"browser/preflight", "params":{}}));
        let response = server.response(id);
        assert!(response["result"]["available"].is_boolean(), "{response}");
        if response["result"]["available"] == false {
            assert!(!response["result"]["reason"].as_str().unwrap().is_empty());
        }
        assert!(response["result"].get("session_id").is_none());
    }
    server.send(json!({"jsonrpc":"2.0", "id":4, "method":"browser/preflight", "params":{"unknown":true}}));
    assert_eq!(server.response(4)["error"]["code"], -32602);
    server.shutdown_successfully();
}
