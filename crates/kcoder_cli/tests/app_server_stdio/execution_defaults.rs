#[test]
fn execution_defaults_rpc_reads_and_writes_the_target_user_file_around_cli_overlays() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["permission_mode"] = json!("auto");
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let overlay = temp.path().join("cli-overlay.json");
    std::fs::write(&overlay, r#"{"permission_mode":"ask"}"#).unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();

    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["executionDefaultsV1"],
        true
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 2,
        "method": "settings/execution-defaults/read", "params": {}
    }));
    let read = server.response(2);
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["persistedPermissionMode"], "auto");
    assert_eq!(read["result"]["effectivePermissionMode"], "ask");
    assert_eq!(read["result"]["cliPermissionModeOverride"], "ask");

    server.send(json!({
        "jsonrpc": "2.0", "id": 3,
        "method": "settings/execution-defaults/save",
        "params": {"permissionMode": "bypass"}
    }));
    let saved = server.response(3);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["persistedPermissionMode"], "bypass");
    assert_eq!(saved["result"]["effectivePermissionMode"], "ask");
    assert_eq!(saved["result"]["cliPermissionModeOverride"], "ask");
    let persisted: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(persisted["permission_mode"], "bypass");
    assert!(persisted["providers"]["integration-test"].is_object());
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&overlay).unwrap()).unwrap()["permission_mode"],
        "ask"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 4,
        "method": "settings/execution-defaults/save",
        "params": {"permissionMode": null}
    }));
    let cleared = server.response(4);
    assert!(cleared.get("error").is_none(), "{cleared}");
    assert!(cleared["result"]["persistedPermissionMode"].is_null());
    assert_eq!(cleared["result"]["effectivePermissionMode"], "ask");
    assert_eq!(cleared["result"]["cliPermissionModeOverride"], "ask");
    let cleared_settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert!(cleared_settings.get("permission_mode").is_none());

    server.send(json!({
        "jsonrpc": "2.0", "id": 5,
        "method": "settings/execution-defaults/save", "params": {}
    }));
    assert_eq!(server.response(5)["error"]["code"], -32602);
    server.shutdown_successfully();
}
