fn policy_sandbox() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let overlay = temp.path().join("runtime.json");
    std::fs::create_dir(&workspace).unwrap();
    write_test_settings(&overlay);
    (temp, workspace, config, overlay)
}

#[test]
fn turn_file_changes_policy_reads_defaults_and_persists_edits() {
    let (_temp, workspace, config, overlay) = policy_sandbox();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/turn-file-changes/read", "params": {}
    }));
    let defaults = server.response(2);
    assert!(defaults.get("error").is_none(), "{defaults}");
    assert_eq!(defaults["result"]["enabled"], true, "{defaults}");
    assert_eq!(defaults["result"]["retentionDays"], 14);
    assert_eq!(defaults["result"]["maxTotalBytes"], 5 * 1024 * 1024 * 1024u64);
    assert_eq!(defaults["result"]["maxFileBytes"], 64 * 1024 * 1024);

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "settings/turn-file-changes/save",
        "params": {
            "enabled": true,
            "retentionDays": 3,
            "maxTotalBytes": 1048576,
            "maxFileBytes": 524288,
            "ignoreGlobs": ["**/*.gguf"]
        }
    }));
    let saved = server.response(3);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["retentionDays"], 3);

    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(config.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["turn_file_changes"]["retention_days"], 3,
        "{persisted}"
    );
    assert_eq!(
        persisted["turn_file_changes"]["ignore_globs"][0],
        "**/*.gguf"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "settings/turn-file-changes/read", "params": {}
    }));
    let reread = server.response(4);
    assert_eq!(reread["result"]["maxFileBytes"], 524288, "{reread}");
    server.shutdown();
}

#[test]
fn turn_file_changes_policy_rejects_invalid_globs_without_touching_the_file() {
    let (_temp, workspace, config, overlay) = policy_sandbox();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);
    let before = std::fs::read(config.join("settings.json")).unwrap();

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/turn-file-changes/save",
        "params": {
            "enabled": true,
            "retentionDays": 14,
            "maxTotalBytes": 1048576,
            "maxFileBytes": 1048576,
            "ignoreGlobs": ["["]
        }
    }));
    let rejected = server.response(2);
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ignore_globs"),
        "{rejected}"
    );
    assert_eq!(std::fs::read(config.join("settings.json")).unwrap(), before);
    server.shutdown();
}
