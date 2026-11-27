#[test]
fn web_search_status_is_read_only_and_probe_receipts_do_not_replay() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let mut settings: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["permission_mode"] = json!("bypass");
    settings["web"] = json!({"search":{"providers":[]}});
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let before = std::fs::read(&settings_path).unwrap();
    let mut server = TestAppServer::builder(&workspace, &settings_path).config_dir(&config).without_scenario().spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"clientInfo":{"name":"search-management-test","version":"1"},"capabilities":{"experimental":{"webSearchStatusV1":true,"webSearchProbeV1":true}}}}));
    let init = server.response(1);
    assert!(init.get("error").is_none(), "{init}");
    assert_eq!(init["result"]["capabilities"]["experimental"]["webSearchStatusV1"], true);
    assert_eq!(init["result"]["capabilities"]["experimental"]["webSearchProbeV1"], true);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"webSearch/status/read","params":{"mode":"kcoder"}}));
    let status = server.response(2);
    assert!(status.get("error").is_none(), "{status}");
    assert_eq!(status["result"]["candidates"], json!([]));
    let revision = status["result"]["revision"].as_str().unwrap();
    let binding = json!({"requestId":"management-receipt","expectedRevision":revision});
    for id in 3..5 {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"webSearch/probe/read","params":binding}));
        assert_eq!(server.response(id)["result"]["state"], "unknown");
    }
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"webSearch/probe/start","params":{"requestId":"management-receipt","expectedRevision":"stale","mode":"kcoder"}}));
    assert!(server.response(5)["error"]["message"].as_str().unwrap().contains("REVISION_CONFLICT"));
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"webSearch/probe/start","params":{"requestId":"management-receipt","expectedRevision":revision,"mode":"kcoder","query":"must never leave client"}}));
    assert!(server.response(6).get("error").is_some());
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"webSearch/probe/start","params":{"requestId":"management-receipt","expectedRevision":revision,"mode":"kcoder"}}));
    let start = server.response(7);
    assert!(start.get("error").is_none(), "{start}");
    let deadline = Instant::now() + Duration::from_secs(5);
    let completed = loop {
        server.send(json!({"jsonrpc":"2.0","id":8,"method":"webSearch/probe/read","params":binding}));
        let read = server.response(8);
        if read["result"]["state"] != "running" { break read["result"].clone(); }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(completed["state"], "completed");
    assert_eq!(completed["response"]["status"], "failed");
    assert_eq!(completed["response"]["attempts"], json!([]));
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"webSearch/probe/start","params":{"requestId":"management-receipt","expectedRevision":revision,"mode":"kcoder"}}));
    assert_eq!(server.response(9)["result"], completed);
    assert_eq!(std::fs::read(settings_path).unwrap(), before);
    server.shutdown();
}

#[test]
fn web_search_diagnostics_remain_explicitly_negotiated_with_legacy_clients() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings).without_scenario().spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"webSearch/status/read","params":{"mode":"kcoder"}}));
    assert!(server.response(2)["error"]["message"].as_str().unwrap().contains("UNSUPPORTED"));
    server.shutdown();
}

#[test]
fn web_search_probe_uses_fresh_profile_after_bootstrap_started_without_search_tools() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let transport = temp.path().join("transport.json");
    write_test_settings(&transport);
    let settings = config.join("settings.json");
    std::fs::write(&settings, serde_json::to_vec(&json!({"tools":{"profile":"none"},"permission_mode":"auto","web":{"search":{"providers":[]}}})).unwrap()).unwrap();
    let mut server = TestAppServer::builder(&workspace, &transport).config_dir(&config).without_scenario().spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"clientInfo":{"name":"search-profile-upgrade","version":"1"},"capabilities":{"experimental":{"webSearchStatusV1":true,"webSearchProbeV1":true,"toolProfilesV1":true}}}}));
    let initialized = server.response(1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"webSearch/status/read","params":{"mode":"kcoder"}}));
    let before = server.response(2);
    assert_eq!(before["result"]["webSearchVisible"], false, "{before}");
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"settings/tools/save","params":{"profile":"full"}}));
    let saved = server.response(3);
    assert_eq!(saved["result"]["effectiveProfile"], "full", "{saved}");
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"webSearch/status/read","params":{"mode":"kcoder"}}));
    let status = server.response(4);
    assert_eq!(status["result"]["webSearchVisible"], true, "{status}");
    let revision = status["result"]["revision"].as_str().unwrap();
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"webSearch/probe/start","params":{"requestId":"upgraded-profile","expectedRevision":revision,"mode":"kcoder"}}));
    let started = server.response(5);
    assert!(started.get("error").is_none(), "{started}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        server.send(json!({"jsonrpc":"2.0","id":6,"method":"webSearch/probe/read","params":{"requestId":"upgraded-profile","expectedRevision":revision}}));
        let read = server.response(6);
        if read["result"]["state"] != "running" {
            assert_eq!(read["result"]["state"], "completed", "{read}");
            assert_eq!(read["result"]["response"]["attempts"], json!([]));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    server.shutdown();
}
