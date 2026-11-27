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
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
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

    // A manifest without usable components must remain unavailable.
    server.send(json!({
        "jsonrpc": "2.0", "id": 41, "method": "plugin/install",
        "params": {"marketplaceName": "fixture-market", "pluginName": "fixture-two", "installAttemptId": "stdio-marketplace-unavailable"}
    }));
    let unavailable = server.response(41);
    assert_eq!(unavailable["error"]["code"], -32050, "{unavailable}");
    assert_eq!(unavailable["error"]["data"]["kind"], "policy_denied");
    assert!(
        unavailable["error"]["message"]
            .as_str()
            .unwrap()
            .contains("does not declare any components")
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "plugin/install",
        "params": {
            "marketplaceName": "fixture-market",
            "pluginName": "fixture-one",
            "installAttemptId": "stdio-marketplace-success"
        }
    }));
    let installed = server.response(4);
    assert!(installed.get("error").is_none(), "{installed}");
    assert_eq!(
        installed["result"]["plugin"]["id"],
        "fixture-one@fixture-market"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "plugin/uninstall",
        "params": {
            "pluginId": "fixture-one@fixture-market",
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

#[test]
fn exited_plugin_mcp_is_unavailable_and_next_thread_reinitializes() {
    assert_plugin_mcp_reinitializes("exit");
}

#[test]
fn recovered_plugin_mcp_does_not_promote_old_resident_connection() {
    assert_plugin_mcp_reinitializes("recover");
}

fn assert_plugin_mcp_reinitializes(mode: &str) {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let source = temp.path().join("plugin-source");
    std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
    let fixture = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo must provide the workspace root"),
    )
    .join("crates/kcoder_mcp/tests/fixtures/lifecycle_server.py");
    std::fs::copy(fixture, source.join("server.py")).unwrap();
    std::fs::write(source.join(".codex-plugin/plugin.json"), json!({
        "name":"idle-exit", "version":"1.0.0", "mcpServers": {
            "fixture": {"command":"python3", "args":["${CODEX_PLUGIN_ROOT}/server.py", mode, temp.path()]}
        }
    }).to_string()).unwrap();
    let mut server = TestAppServerBuilder::new(temp.path(), &settings).without_scenario().spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"plugin/install","params":{"path":source,"installAttemptId":"idle-exit-fixture"}}));
    let installed = server.response(2);
    assert!(installed.get("error").is_none(), "{installed}");
    let plugin = installed["result"]["plugin"]["id"].clone();
    let mut first_thread = None;
    for base in [10, 20] {
        server.send(json!({"jsonrpc":"2.0","id":base,"method":"thread/start","params":{}}));
        let thread = server.response(base)["result"]["thread"]["id"].clone();
        assert!(thread.is_string());
        if first_thread.is_none() { first_thread = Some(thread.clone()); }
        std::thread::sleep(Duration::from_millis(100));
        server.send(json!({"jsonrpc":"2.0","id":base+1,"method":"plugin/activation/read","params":{"pluginId":plugin,"threadId":thread}}));
        let activation = server.response(base+1);
        let components = activation["result"]["components"].as_array().unwrap();
        let mcp = components.iter().find(|component| component["kind"] == "mcp").unwrap();
        let recovered = mode == "recover" && base == 20;
        assert_eq!(mcp["phase"], if recovered { "usable" } else { "failed" }, "{activation}");
        server.send(json!({"jsonrpc":"2.0","id":base+2,"method":"mcp/list","params":{}}));
        let summary = server.response(base+2);
        assert_eq!(summary["result"]["servers"][0]["lastConnectionAttempt"], if recovered { "ready" } else { "unavailable" }, "{summary}");
    }
    if mode == "recover" {
        server.send(json!({"jsonrpc":"2.0","id":31,"method":"plugin/activation/read","params":{"pluginId":plugin,"threadId":first_thread.unwrap()}}));
        let old = server.response(31);
        assert_eq!(old["result"]["components"][0]["phase"], "failed", "{old}");
    }
    assert_eq!(std::fs::read_to_string(temp.path().join("launches.jsonl")).unwrap().lines().count(), 2);
    server.shutdown();
}
