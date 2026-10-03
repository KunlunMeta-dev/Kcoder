#[test]
fn plugin_lifecycle_is_available_only_through_app_server_rpc() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let source = temp.path().join("plugin-source");
    std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
    std::fs::write(
        source.join(".codex-plugin/plugin.json"),
        r#"{"name":"rpc-demo","version":"1.0.0","description":"RPC fixture"}"#,
    )
    .unwrap();
    std::fs::create_dir_all(source.join("skills/fixture-skill")).unwrap();
    std::fs::write(source.join("skills/fixture-skill/SKILL.md"), "---\nname: fixture-skill\ndescription: Installed skill description\n---\nUse this fixture skill.").unwrap();
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "plugin/install",
        "params": {
            "path": source,
            "installAttemptId": "stdio-fixture-1"
        }
    }));
    let installed = server.response(2);
    assert_eq!(installed["result"]["generation"], 1);
    assert_eq!(installed["result"]["plugin"]["id"], "rpc-demo@local");
    let components = installed["result"]["plugin"]["components"].as_array().expect("plugin component inventory");
    assert!(components.iter().any(|component| component["kind"] == "skill" && component["name"] == "fixture-skill" && component["description"] == "Installed skill description"));
    let installed_root = installed["result"]["plugin"]["root"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(std::path::Path::new(&installed_root).is_dir());

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "plugin/list",
        "params": {"all": true}
    }));
    let listed = server.response(3);
    assert_eq!(listed["result"]["plugins"][0]["id"], "rpc-demo@local");
    assert_eq!(listed["result"]["plugins"][0]["managed"], true);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "plugin/disable",
        "params": {"pluginId": "rpc-demo@local"}
    }));
    let disabled = server.response(4);
    assert_eq!(disabled["result"]["generation"], 2);
    assert_eq!(disabled["result"]["plugin"]["enabled"], false);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "plugin/uninstall",
        "params": {"pluginId": "rpc-demo@local", "purgeData": true}
    }));
    let removed = server.response(5);
    assert_eq!(removed["result"]["generation"], 3);
    assert_eq!(removed["result"]["changed"], true);
    assert!(!std::path::Path::new(&installed_root).exists());

    server.shutdown();
}

#[test]
fn plugin_rpc_returns_stable_machine_readable_error_kind() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "plugin/read",
        "params": {"pluginId": "../escape"}
    }));
    let response = server.response(2);

    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(response["error"]["data"]["kind"], "invalid_params");
    server.shutdown();
}

#[test]
fn marketplace_rpc_adds_lists_installs_and_removes_local_fixture() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let marketplace = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT")
            .expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
    .join("crates/kcoder_plugins/tests/fixtures/marketplaces/local");
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "marketplace/add",
        "params": {
            "source": marketplace,
            "marketplaceName": "fixture-market"
        }
    }));
    assert_eq!(
        server.response(2)["result"]["marketplaceName"],
        "fixture-market"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "marketplace/list",
        "params": {}
    }));
    let listed = server.response(3);
    assert_eq!(listed["result"]["marketplaces"][0]["id"], "fixture-market");
    assert_eq!(
        listed["result"]["marketplaces"][0]["plugins"][0]["pluginId"],
        "fixture-one@fixture-market"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "plugin/install",
        "params": {
            "marketplaceName": "fixture-market",
            "pluginName": "fixture-two"
        }
    }));
    let installed = server.response(4);
    assert_eq!(
        installed["result"]["plugin"]["id"],
        "fixture-two@fixture-market"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "plugin/uninstall",
        "params": {
            "pluginId": "fixture-two@fixture-market",
            "purgeData": true
        }
    }));
    assert_eq!(server.response(5)["result"]["changed"], true);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "marketplace/remove",
        "params": {"marketplaceName": "fixture-market"}
    }));
    assert_eq!(server.response(6)["result"]["changed"], true);
    server.shutdown();
}
