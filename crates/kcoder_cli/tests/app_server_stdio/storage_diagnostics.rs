fn storage_sandbox() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    write_test_settings(&config.join("settings.json"));
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    (temp, workspace, config, overlay)
}

fn seed_storage(config: &std::path::Path) {
    let log_dir = config.join("logs").join("llm-request").join("20260918").join("090000_a");
    std::fs::create_dir_all(&log_dir).unwrap();
    std::fs::write(log_dir.join("request.json"), vec![b'x'; 4096]).unwrap();

    let snapshot = config
        .join("projects")
        .join("demo")
        .join("client-sessions")
        .join("s1")
        .join("turn-file-changes")
        .join("snapshot-repository-abc")
        .join("objects");
    std::fs::create_dir_all(&snapshot).unwrap();
    std::fs::write(snapshot.join("aa"), vec![b'y'; 2048]).unwrap();

    std::fs::create_dir_all(config.join("projects").join("demo").join("client-sessions").join("s1")).unwrap();
    std::fs::write(
        config.join("projects").join("demo").join("client-sessions").join("s1").join("transcript.jsonl"),
        b"one turn\n",
    )
    .unwrap();
}

#[test]
fn initialize_advertises_storage_diagnostics_capability() {
    let (_temp, workspace, config, overlay) = storage_sandbox();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["storageDiagnosticsV1"],
        true
    );
    server.shutdown();
}

#[test]
fn storage_read_reports_buckets_totals_and_the_debug_recorder() {
    let (_temp, workspace, config, overlay) = storage_sandbox();
    seed_storage(&config);
    std::fs::write(config.join(".env"), "DEV_DEBUG=1\nKUNLUNMETA_BASE_API_KEY=secret\n").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "diagnostics/storage/read", "params": {}}));
    let report = server.response(2);
    assert!(report.get("error").is_none(), "{report}");
    let buckets = report["result"]["buckets"].as_array().unwrap();
    let bucket = |id: &str| {
        buckets
            .iter()
            .find(|bucket| bucket["id"] == json!(id))
            .cloned()
            .unwrap()
    };
    assert_eq!(bucket("debug-logs")["bytes"], 4096, "{report}");
    assert_eq!(bucket("debug-logs")["cleanable"], true);
    assert_eq!(bucket("turn-snapshots")["bytes"], 2048, "{report}");
    assert!(
        bucket("session-data")["bytes"].as_u64().unwrap() >= 9,
        "session-data covers the seeded transcript: {report}"
    );
    assert_eq!(bucket("turn-snapshots")["cleanable"], true);
    assert_eq!(bucket("session-data")["cleanable"], false);
    assert_eq!(report["result"]["devDebug"]["dotenvLines"], 1, "{report}");
    assert_eq!(report["result"]["devDebug"]["retentionDays"], 7);
    assert_eq!(report["result"]["devDebug"]["logFiles"], 1);
    server.shutdown();
}

#[test]
fn storage_clean_requires_confirmation_and_reclaims_only_the_target() {
    let (_temp, workspace, config, overlay) = storage_sandbox();
    seed_storage(&config);
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "diagnostics/storage/clean",
        "params": {"target": "debug-logs"}
    }));
    let refused = server.response(2);
    assert_eq!(refused["error"]["code"], -32602, "{refused}");
    assert!(config.join("logs").join("llm-request").exists());

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "diagnostics/storage/clean",
        "params": {"target": "turn-snapshots", "confirm": true}
    }));
    let cleaned = server.response(3);
    assert!(cleaned.get("error").is_none(), "{cleaned}");
    assert_eq!(cleaned["result"]["removedBytes"], 2048, "{cleaned}");
    assert_eq!(cleaned["result"]["removedFiles"], 1);
    assert!(!config
        .join("projects/demo/client-sessions/s1/turn-file-changes/snapshot-repository-abc")
        .exists());
    assert!(config.join("projects/demo/client-sessions/s1/transcript.jsonl").exists());
    assert!(config.join("logs/llm-request").exists(), "other buckets stay untouched");
    server.shutdown();
}

#[test]
fn debug_log_disable_comments_the_dotenv_assignment() {
    let (_temp, workspace, config, overlay) = storage_sandbox();
    std::fs::write(config.join(".env"), "DEV_DEBUG=1\nNO_PROXY=localhost\n").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "diagnostics/debug-log/disable", "params": {}
    }));
    let disabled = server.response(2);
    assert!(disabled.get("error").is_none(), "{disabled}");
    assert_eq!(disabled["result"]["changed"], true, "{disabled}");
    let dotenv = std::fs::read_to_string(config.join(".env")).unwrap();
    assert!(dotenv.contains("# DEV_DEBUG=1"), "{dotenv}");
    assert!(dotenv.contains("NO_PROXY=localhost"), "{dotenv}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "diagnostics/debug-log/disable", "params": {}
    }));
    let again = server.response(3);
    assert_eq!(again["result"]["changed"], false, "{again}");
    server.shutdown();
}

#[test]
fn storage_read_classifies_keyring_and_plaintext_credentials() {
    let (_temp, workspace, config, overlay) = storage_sandbox();
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("credentials.json"),
        serde_json::to_vec_pretty(&json!({
            "deepseek": { "type": "api", "key": "keyring:kcoder/deepseek" },
            "openai": { "type": "api", "key": "sk-plaintext" },
        }))
        .unwrap(),
    )
    .unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "diagnostics/storage/read", "params": {}
    }));
    let report = server.response(2);
    assert!(report.get("error").is_none(), "{report}");
    let credentials = &report["result"]["credentials"];
    assert_eq!(credentials["providers"], 2, "{report}");
    assert_eq!(credentials["keyringProviders"], json!(["deepseek"]), "{report}");
    assert_eq!(credentials["plaintextProviders"], json!(["openai"]), "{report}");
    assert!(
        credentials["keyringBackend"].as_str().is_some_and(|name| !name.is_empty()),
        "{report}"
    );
    assert!(credentials["keyringAvailable"].is_boolean(), "{report}");
    server.shutdown();
}
