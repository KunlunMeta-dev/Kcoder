#[test]
fn stdio_app_server_persists_shared_studio_context_across_processes() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config_dir = temp.path().join("config");
    let settings = temp.path().join("runtime-settings.json");
    std::fs::create_dir_all(&workspace).unwrap();
    write_test_settings(&settings);

    let mut first = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config_dir)
        .spawn();
    assert!(first.initialize(1).get("error").is_none());

    first.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "runtime.context.get",
        "params": {}
    }));
    let initial = first.response(2);
    assert_eq!(initial["result"]["instructions"], "", "{initial}");
    assert_eq!(initial["result"]["personality"], "pragmatic");
    assert_eq!(initial["result"]["instructionsConfigured"], false);
    assert_eq!(initial["result"]["personalityConfigured"], false);

    first.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "runtime.context.update",
        "params": {
            "instructions": "SHARED_STDIO_INSTRUCTIONS",
            "personality": "friendly"
        }
    }));
    let updated = first.response(3);
    assert!(updated.get("error").is_none(), "{updated}");
    assert_eq!(updated["result"]["instructions"], "SHARED_STDIO_INSTRUCTIONS");
    assert_eq!(updated["result"]["personality"], "friendly");
    assert_eq!(updated["result"]["instructionsConfigured"], true);
    assert_eq!(updated["result"]["personalityConfigured"], true);

    first.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "runtime.context.update",
        "params": { "personality": "unsafe" }
    }));
    let invalid = first.response(4);
    assert!(
        invalid["error"]["message"]
            .as_str()
            .unwrap()
            .contains("friendly or pragmatic"),
        "{invalid}"
    );
    first.shutdown_successfully();

    let persisted: Value = serde_json::from_slice(
        &std::fs::read(config_dir.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["studio_context"],
        json!({
            "instructions": "SHARED_STDIO_INSTRUCTIONS",
            "personality": "friendly",
            "instructions_configured": true,
            "personality_configured": true
        })
    );

    let mut second = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config_dir)
        .spawn();
    assert!(second.initialize(5).get("error").is_none());
    second.send(json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "runtime.context.get",
        "params": {}
    }));
    let restored = second.response(6);
    assert_eq!(restored["result"]["instructions"], "SHARED_STDIO_INSTRUCTIONS");
    assert_eq!(restored["result"]["personality"], "friendly");

    second.send(json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "runtime.context.update",
        "params": { "instructions": "" }
    }));
    let cleared = second.response(7);
    assert_eq!(cleared["result"]["instructions"], "");
    assert_eq!(cleared["result"]["instructionsConfigured"], true);
    second.send(json!({
        "jsonrpc": "2.0",
        "id": 8,
        "method": "runtime.context.update",
        "params": {
            "instructions": "STALE_BROWSER_VALUE",
            "personality": "pragmatic",
            "onlyIfUnconfigured": true
        }
    }));
    let stale_migration = second.response(8);
    assert_eq!(stale_migration["result"]["instructions"], "");
    assert_eq!(stale_migration["result"]["personality"], "friendly");
    second.shutdown_successfully();

    let settings_path = config_dir.join("settings.json");
    let loaded: kcoder_config::Settings =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    loaded.save_to(&settings_path).unwrap();
    let after_unrelated_save: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(
        after_unrelated_save["studio_context"]["instructions_configured"],
        true
    );
    assert_eq!(after_unrelated_save["studio_context"]["instructions"], "");
}
