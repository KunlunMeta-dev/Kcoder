#[test]
fn initialize_advertises_settings_template_capability() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["settingsTemplatesV1"],
        true
    );
    server.shutdown();
}

#[test]
fn settings_template_requests_round_trip_through_the_store() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/templates/save",
        "params": {
            "name": "Fast Local",
            "description": "tight context",
            "content": "{ \"context_window_tokens\": 32000 }\n"
        }
    }));
    let saved = server.response(2);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["template"]["id"], "fast-local");
    assert_eq!(saved["result"]["template"]["description"], "tight context");
    let template_path = temp
        .path()
        .join("config")
        .join("templates")
        .join("fast-local.jsonc");
    assert!(template_path.is_file(), "template file was not persisted");

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "settings/templates/list", "params": {}
    }));
    let listed = server.response(3);
    assert_eq!(listed["result"]["templates"].as_array().unwrap().len(), 1);
    assert!(listed["result"].get("defaultId").is_none(), "{listed}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "settings/templates/read",
        "params": {"id": "fast-local"}
    }));
    let read = server.response(4);
    assert_eq!(read["result"]["content"], "{ \"context_window_tokens\": 32000 }\n");

    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "settings/templates/default",
        "params": {"id": "fast-local"}
    }));
    let defaulted = server.response(5);
    assert_eq!(defaulted["result"]["defaultId"], "fast-local");

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "settings/templates/delete",
        "params": {"id": "fast-local"}
    }));
    let deleted = server.response(6);
    assert_eq!(deleted["result"]["templates"].as_array().unwrap().len(), 0);
    assert!(deleted["result"].get("defaultId").is_none(), "{deleted}");
    assert!(!template_path.is_file());
    server.shutdown();
}

#[test]
fn settings_template_errors_report_invalid_params_without_leaking_paths() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/templates/read",
        "params": {"id": "missing"}
    }));
    let response = server.response(2);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    let message = response["error"]["message"].as_str().unwrap();
    assert!(message.contains("unknown settings template"), "{message}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "settings/templates/save",
        "params": {"name": "Missing content"}
    }));
    let response = server.response(3);
    assert_eq!(response["error"]["code"], -32602, "{response}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "settings/templates/save",
        "params": {"name": "Leaky", "content": "{ \"api_key\": \"secret\" }\n"}
    }));
    let response = server.response(4);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    let message = response["error"]["message"].as_str().unwrap();
    assert!(message.contains("credential"), "{message}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "settings/templates/default",
        "params": {"id": "missing"}
    }));
    let response = server.response(5);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    server.shutdown();
}

#[test]
fn thread_start_applies_a_session_settings_template() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/templates/save",
        "params": {"name": "No Bash", "content": "{ \"tools\": { \"disabled\": [\"bash\"] } }\n"}
    }));
    let saved = server.response(2);
    assert!(saved.get("error").is_none(), "{saved}");
    assert!(config.join("templates/no-bash.jsonc").is_file());

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/start",
        "params": {"settingsTemplate": "no-bash"}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let templated = started["result"]["thread"]["id"].as_str().unwrap().to_owned();

    server.send(json!({"jsonrpc": "2.0", "id": 4, "method": "thread/start", "params": {}}));
    let baseline = server.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let tool_names = |value: &Value| {
        value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    server.send(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/catalog", "params": {"threadId": templated}}));
    let templated_catalog = server.response(5);
    server.send(json!({"jsonrpc": "2.0", "id": 6, "method": "tools/catalog", "params": {"threadId": baseline}}));
    let baseline_catalog = server.response(6);
    assert!(
        !tool_names(&templated_catalog).contains(&"bash".to_string()),
        "{templated_catalog}"
    );
    assert!(
        tool_names(&baseline_catalog).contains(&"bash".to_string()),
        "{baseline_catalog}"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/start",
        "params": {"settingsTemplate": "missing"}
    }));
    let response = server.response(7);
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown settings template"),
        "{response}"
    );
    server.shutdown();
}

fn template_sandbox() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
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

fn save_no_bash_template(server: &mut TestAppServer, id: i64) -> String {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "settings/templates/save",
        "params": {"name": "No Bash", "content": "{ \"tools\": { \"disabled\": [\"bash\"] } }\n"}
    }));
    let saved = server.response(id);
    assert!(saved.get("error").is_none(), "{saved}");
    saved["result"]["template"]["revisionSha256"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn catalog_names(server: &mut TestAppServer, id: i64, thread_id: &str) -> Vec<String> {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/catalog",
        "params": {"threadId": thread_id}
    }));
    let catalog = server.response(id);
    catalog["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn thread_start_reports_the_settings_template_binding() {
    let (_temp, workspace, config, overlay) = template_sandbox();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());
    let revision = save_no_bash_template(&mut server, 2);

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/start",
        "params": {"settingsTemplate": "no-bash"}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    assert_eq!(started["result"]["thread"]["settingsTemplate"]["id"], "no-bash");
    assert_eq!(
        started["result"]["thread"]["settingsTemplate"]["revisionSha256"],
        revision
    );
    let thread_id = started["result"]["thread"]["id"].as_str().unwrap().to_owned();

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/read", "params": {"threadId": thread_id}
    }));
    let read = server.response(4);
    assert_eq!(read["result"]["thread"]["settingsTemplate"]["id"], "no-bash", "{read}");

    server.send(json!({"jsonrpc": "2.0", "id": 5, "method": "thread/list", "params": {}}));
    let listed = server.response(5);
    let row = listed["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(thread_id))
        .cloned()
        .expect("thread row");
    assert_eq!(row["settingsTemplate"]["revisionSha256"], revision, "{listed}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/resume",
        "params": {"threadId": thread_id, "settingsTemplate": "no-bash"}
    }));
    let rejected = server.response(6);
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cannot change the settings template"),
        "{rejected}"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/resume", "params": {"threadId": thread_id}
    }));
    let resumed = server.response(7);
    assert_eq!(resumed["result"]["thread"]["settingsTemplate"]["id"], "no-bash", "{resumed}");

    // A running session reports the same binding read-only, so Studio can show it without
    // offering to switch templates.
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "session/modes", "params": {"threadId": thread_id}
    }));
    let modes = server.response(8);
    assert!(modes.get("error").is_none(), "{modes}");
    assert_eq!(modes["result"]["settingsTemplate"]["id"], "no-bash", "{modes}");
    assert_eq!(modes["result"]["settingsTemplate"]["revisionSha256"], revision);

    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "session/modes", "params": {}
    }));
    let default_modes = server.response(9);
    assert!(default_modes.get("error").is_none(), "{default_modes}");
    assert!(
        default_modes["result"]["settingsTemplate"].is_null(),
        "{default_modes}"
    );
    server.shutdown();
}

fn persisted_thread_with_template(
    workspace: &std::path::Path,
    config: &std::path::Path,
    overlay: &std::path::Path,
) -> String {
    let mut server = TestAppServer::builder(workspace, overlay)
        .config_dir(config)
        .stream_delay_ms("1")
        .spawn();
    server.initialize(1);
    save_no_bash_template(&mut server, 2);
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/start",
        "params": {"settingsTemplate": "no-bash"}
    }));
    let thread_id = server.response(3)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "clientMessageId": "client-message-1",
            "input": [{"type": "text", "text": "hello templates"}]
        }
    }));
    assert!(server.response(4).get("error").is_none());
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if server.next_value(deadline)["method"] == json!("turn/completed") {
            break;
        }
    }
    server.shutdown();
    thread_id
}

#[test]
fn resume_reapplies_the_recorded_settings_template() {
    let (_temp, workspace, config, overlay) = template_sandbox();
    let thread_id = persisted_thread_with_template(&workspace, &config, &overlay);

    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/resume", "params": {"threadId": thread_id}
    }));
    let resumed = server.response(2);
    assert!(resumed.get("error").is_none(), "{resumed}");
    assert_eq!(resumed["result"]["thread"]["settingsTemplate"]["id"], "no-bash");
    assert!(
        !catalog_names(&mut server, 3, &thread_id).contains(&"bash".to_string()),
        "resumed thread lost its settings template overlay"
    );
    server.shutdown();
}

#[test]
fn resume_reports_a_missing_template_without_blocking_the_baseline() {
    let (_temp, workspace, config, overlay) = template_sandbox();
    let thread_id = persisted_thread_with_template(&workspace, &config, &overlay);

    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "settings/templates/delete", "params": {"id": "no-bash"}
    }));
    assert!(server.response(2).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/resume", "params": {"threadId": thread_id}
    }));
    let resumed = server.response(3);
    assert!(resumed.get("error").is_none(), "{resumed}");
    assert_eq!(resumed["result"]["thread"]["settingsTemplate"]["id"], "no-bash");
    assert!(
        catalog_names(&mut server, 4, &thread_id).contains(&"bash".to_string()),
        "missing template must fall back to baseline settings"
    );
    server.shutdown();
}

#[test]
fn the_default_template_is_applied_to_new_sessions_without_a_choice() {
    let (_temp, workspace, config, overlay) = template_sandbox();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());
    let revision = save_no_bash_template(&mut server, 2);

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/start", "params": {}
    }));
    let baseline = server.response(3);
    let baseline_id = baseline["result"]["thread"]["id"].as_str().unwrap().to_owned();
    assert!(
        catalog_names(&mut server, 4, &baseline_id).contains(&"bash".to_string()),
        "an unset default must keep the baseline settings"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "settings/templates/default", "params": {"id": "no-bash"}
    }));
    assert!(server.response(5).get("error").is_none());

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/start", "params": {}
    }));
    let defaulted = server.response(6);
    assert!(defaulted.get("error").is_none(), "{defaulted}");
    assert_eq!(defaulted["result"]["thread"]["settingsTemplate"]["id"], "no-bash");
    assert_eq!(
        defaulted["result"]["thread"]["settingsTemplate"]["revisionSha256"],
        revision
    );
    let defaulted_id = defaulted["result"]["thread"]["id"].as_str().unwrap().to_owned();
    assert!(
        !catalog_names(&mut server, 7, &defaulted_id).contains(&"bash".to_string()),
        "the default template must be applied to new sessions"
    );
    server.shutdown();
}
