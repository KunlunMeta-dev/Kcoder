#[test]
fn stdio_provider_templates_are_inert_and_strict() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let overlay = temp.path().join("runtime.json");
    std::fs::create_dir(&workspace).unwrap();
    write_test_settings(&overlay);
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["providerTemplates"],
        true
    );
    let before = std::fs::read(config.join("settings.json")).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"runtime.providers.templates","params":{}}));
    let result = server.response(2);
    assert_eq!(result["result"]["templates"].as_array().unwrap().len(), 4);
    assert_eq!(result["result"]["supportsAuthenticationPolicy"], true);
    assert_eq!(result["result"]["templates"][0]["id"], "deepseek");
    assert!(result["result"]["templates"][0].get("model").is_none());
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"runtime.providers.templates","params":{"unexpected":true}}));
    assert!(server.response(3).get("error").is_some());
    assert_eq!(std::fs::read(config.join("settings.json")).unwrap(), before);
    server.shutdown_successfully();
}

#[test]
fn stdio_provider_configuration_is_target_owned_and_requires_explicit_reload() {
    // This scenario tests configuration persistence and protocol state, not model quality.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let overlay = temp.path().join("runtime.json");
    std::fs::create_dir(&workspace).unwrap();
    write_test_settings(&overlay);
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["providerConfiguration"],
        true
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["providerConnectionValidation"],
        true
    );
    let (endpoint, probe) = provider_validation_fixture(200);
    server.send(json!({"jsonrpc":"2.0", "id":2, "method":"runtime.providers.upsert", "params":{
        "id":"custom", "apiFormat":"openai_chat_completions", "endpoint":endpoint,
        "model":"user-model", "contextWindowTokens":32000, "maxOutputTokens":4096, "apiKey":"fixture-provider-secret", "makeDefault":true
    }}));
    let saved = server.response(2);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["restartRequired"], true);
    assert!(!saved.to_string().contains("fixture-provider-secret"));
    let probed = probe.join().unwrap().remove(0);
    assert_eq!(probed["model"], "user-model");
    assert_eq!(probed["max_completion_tokens"], 256);
    assert!(probed.get("tools").is_none());
    server.shutdown_successfully();
    assert!(
        !std::fs::read_to_string(config.join("settings.json"))
            .unwrap()
            .contains("fixture-provider-secret")
    );
    let mut reader = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .spawn();
    assert!(reader.initialize(3).get("error").is_none());
    reader.send(json!({"jsonrpc":"2.0", "id":4, "method":"runtime.providers.list", "params":{}}));
    let listed = reader.response(4);
    assert!(
        listed["result"]["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|profile| profile["id"] == "custom" && profile["apiKeyConfigured"] == true)
    );
    reader.send(json!({"jsonrpc":"2.0", "id":5, "method":"runtime.models.list", "params":{}}));
    let models = reader.response(5);
    assert!(
        models["result"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"] == "custom::user-model"),
        "{models}"
    );
    reader.shutdown_successfully();
}

// A real local HTTP/SSE response verifies transport and persistence, not model quality.
fn provider_validation_fixture(status: u16) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    provider_validation_fixture_with_gate(status, None)
}

fn provider_validation_fixture_with_gate(
    status: u16,
    gate: Option<(std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>)>,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    provider_validation_fixture_sequence(status, gate, 1)
}

fn provider_validation_fixture_sequence(
    status: u16,
    gate: Option<(std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>)>,
    request_count: usize,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    use std::io::Read;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut requests = Vec::new();
        for _ in 0..request_count {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let (body_start, length) = loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 32768);
                if bytes.ends_with(b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (bytes.len(), length);
                }
            };
            // A real main turn includes the full tool catalog, unlike a tiny save probe.
            assert!(length < 2 * 1024 * 1024);
            bytes.resize(body_start + length, 0);
            socket.read_exact(&mut bytes[body_start..]).unwrap();
            let mut input: Value = serde_json::from_slice(&bytes[body_start..]).unwrap();
            // Retain only the presence of authentication, never the header value.
            input["_fixtureAuthenticationPresent"] = json!(
                String::from_utf8_lossy(&bytes[..body_start])
                    .lines()
                    .any(
                        |line| line.to_ascii_lowercase().starts_with("authorization:")
                            || line.to_ascii_lowercase().starts_with("x-api-key:")
                    )
            );
            if let Some((gate, started)) = &gate {
                started.send(()).unwrap();
                gate.recv_timeout(Duration::from_secs(15)).unwrap();
            }
            let (content_type, body) = if status == 200 {
                (
                    "text/event-stream",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                )
            } else {
                (
                    "application/json",
                    "{\"error\":{\"message\":\"fixture-provider-secret must not be echoed\"}}",
                )
            };
            write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            requests.push(input);
        }
        requests
    });
    (endpoint, task)
}

#[test]
fn failed_api_validation_preserves_settings_and_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("runtime.json");
    write_test_settings(&settings);
    let config = temp.path().join("config");
    std::fs::create_dir_all(&config).unwrap();
    let runtime: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    let mut profile = runtime["providers"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    profile["default_model"] = json!("old-model");
    std::fs::write(
        config.join("settings.json"),
        serde_json::to_vec(&json!({
            "providers":{"rejected":profile},"active_provider":"rejected","model":"old-model"
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        config.join("credentials.json"),
        serde_json::to_vec(&json!({
            "rejected":{"type":"api","key":"old-key-to-preserve"}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    server.initialize(1);
    let profile_file = config.join("settings.json");
    let credential_file = config.join("credentials.json");
    let before_settings = std::fs::read(&profile_file).ok();
    let before_credentials = std::fs::read(&credential_file).ok();
    assert!(before_settings.is_some() && before_credentials.is_some());
    for (index, status) in [401, 403, 404, 429, 500, 204].into_iter().enumerate() {
        let (endpoint, fixture) = provider_validation_fixture(status);
        let id = index as i64 + 2;
        server.send(json!({"id":id,"method":"runtime.providers.upsert","params":{
            "id":"rejected","originalModel":"old-model","apiFormat":"openai_chat_completions","endpoint":endpoint,"model":"GLM-5.3","contextWindowTokens":32000,"maxOutputTokens":4096,"apiKey":"fixture-provider-secret","makeDefault":true
        }}));
        let result = server.response(id);
        assert!(result.get("error").is_some(), "status {status}");
        assert!(!result.to_string().contains("fixture-provider-secret"));
        let expected = match status {
            401 => "authentication",
            403 => "permission",
            404 => "model",
            429 => "rate_limit",
            _ => "response",
        };
        assert!(
            result["error"]["message"]
                .as_str()
                .unwrap()
                .contains(&format!("[provider_probe_{expected}]")),
            "{result}"
        );
        fixture.join().unwrap();
        assert_eq!(std::fs::read(&profile_file).ok(), before_settings);
        assert_eq!(std::fs::read(&credential_file).ok(), before_credentials);
    }
    server.shutdown_successfully();
}

#[test]
fn unauthenticated_provider_save_omits_headers_and_preserves_old_key() {
    // The real HTTP fixture tests transport authentication, not model quality.
    let temp = tempfile::tempdir().unwrap();
    let overlay = temp.path().join("runtime.json");
    write_test_settings(&overlay);
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(
        config.join("credentials.json"),
        r#"{"private-local":{"type":"api","key":"unused-fixture-key"}}"#,
    )
    .unwrap();
    let before = std::fs::read(config.join("credentials.json")).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &overlay)
        .config_dir(&config)
        .spawn();
    server.initialize(1);
    let (endpoint, fixture) = provider_validation_fixture(200);
    server.send(
        json!({"jsonrpc":"2.0","id":2,"method":"runtime.providers.upsert","params":{
            "id":"private-local","apiFormat":"openai_chat_completions","endpoint":endpoint,
            "model":"local-model","contextWindowTokens":32000,"maxOutputTokens":4096,
            "authentication":{"mode":"none"},"makeDefault":false
        }}),
    );
    let result = server.response(2);
    assert!(result.get("error").is_none(), "{result}");
    assert_eq!(
        fixture.join().unwrap()[0]["_fixtureAuthenticationPresent"],
        false
    );
    let profile = result["result"]["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "private-local")
        .unwrap();
    assert_eq!(profile["authentication"]["mode"], "none");
    assert_eq!(profile["apiKeyConfigured"], false);
    assert_eq!(
        std::fs::read(config.join("credentials.json")).unwrap(),
        before
    );
    let saved = std::fs::read(config.join("settings.json")).unwrap();
    server.send(
        json!({"jsonrpc":"2.0","id":3,"method":"runtime.providers.upsert","params":{
            "id":"private-local","apiFormat":"openai_chat_completions","endpoint":endpoint,
            "model":"local-model","contextWindowTokens":32000,"maxOutputTokens":4096,
            "authentication":{"mode":"none"},"apiKey":"must-not-be-sent","makeDefault":false
        }}),
    );
    assert!(server.response(3).get("error").is_some());
    assert_eq!(std::fs::read(config.join("settings.json")).unwrap(), saved);
    assert_eq!(
        std::fs::read(config.join("credentials.json")).unwrap(),
        before
    );
    server.shutdown_successfully();
}

#[test]
fn saved_unauthenticated_provider_runs_a_real_turn_after_restart() {
    // Test the persisted authentication contract through real HTTP, not model quality.
    let temp = tempfile::tempdir().unwrap();
    let overlay = temp.path().join("runtime.json");
    write_test_settings(&overlay);
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(
        config.join("credentials.json"),
        r#"{"private-local":{"type":"api","key":"unused-fixture-key"}}"#,
    )
    .unwrap();
    let mut writer = TestAppServer::builder(temp.path(), &overlay)
        .config_dir(&config)
        .spawn();
    writer.initialize(1);
    let (endpoint, fixture) = provider_validation_fixture_sequence(200, None, 2);
    writer.send(
        json!({"jsonrpc":"2.0","id":2,"method":"runtime.providers.upsert","params":{
            "id":"private-local","apiFormat":"openai_chat_completions","endpoint":endpoint,
            "model":"local-model","contextWindowTokens":128000,"maxOutputTokens":4096,
            "authentication":{"mode":"none"},"makeDefault":true
        }}),
    );
    let saved = writer.response(2);
    assert!(saved.get("error").is_none(), "{saved}");
    writer.shutdown_successfully();
    // The second process loads only the user-saved profile, with no scenario adapter.
    std::fs::write(&overlay, "{}").unwrap();
    let mut reader = TestAppServer::builder(temp.path(), &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(reader.initialize(3).get("error").is_none());
    reader.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}));
    let started = reader.response(4);
    let thread = started["result"]["thread"]["id"].as_str().unwrap();
    reader.send(
        json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":"Reply OK"}]
        }}),
    );
    assert!(reader.response(5).get("error").is_none());
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let event = reader.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    reader.shutdown_successfully();
    let requests = fixture.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request["_fixtureAuthenticationPresent"] == false)
    );
    assert!(
        requests
            .iter()
            .all(|request| request["model"] == "local-model")
    );
}

#[test]
fn slow_provider_validation_does_not_block_requests_or_overwrite_newer_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("runtime.json");
    write_test_settings(&settings);
    let config = temp.path().join("config");
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    server.initialize(1);
    let (release, wait) = std::sync::mpsc::channel();
    let (started, observed) = std::sync::mpsc::channel();
    let (endpoint, fixture) = provider_validation_fixture_with_gate(200, Some((wait, started)));
    server.send(json!({"id":2,"method":"runtime.providers.upsert","params":{
        "id":"custom","apiFormat":"openai_chat_completions","endpoint":endpoint,"model":"user-model","contextWindowTokens":32000,"maxOutputTokens":4096,"apiKey":"fixture-provider-secret","makeDefault":true
    }}));
    observed.recv_timeout(Duration::from_secs(10)).unwrap();
    server.send(json!({"id":3,"method":"runtime.models.list","params":{}}));
    assert!(server.response(3).get("error").is_none());
    // A separate writer can change settings while the network check is in flight.
    kcoder_config::update_settings_file(&config.join("settings.json"), |document| {
        document["studio_context"] = json!({"instructions":"concurrent change"});
        Ok(())
    })
    .unwrap();
    release.send(()).unwrap();
    fixture.join().unwrap();
    let result = server.response(2);
    assert!(result.get("error").is_some(), "{result}");
    let saved = kcoder_config::read_settings_file(&config.join("settings.json")).unwrap();
    assert_eq!(saved["studio_context"]["instructions"], "concurrent change");
    assert!(saved["providers"].get("custom").is_none());
    assert!(!config.join("credentials.json").exists());
    server.shutdown_successfully();
}

#[test]
fn stdio_provider_deletion_preserves_overlay_and_credentials_choice_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&config).unwrap();
    let profile = json!({
        "api_format": "openai_chat_completions", "endpoint": "https://example.invalid/v1",
        "default_model": "deletion-fixture", "context_window_tokens": 32000,
        "output_headroom_tokens": 4096, "max_output_tokens": 4096
    });
    let overlay = temp.path().join("overlay.json");
    let overlay_content =
        serde_json::to_vec(&json!({"providers": {"overlay-only": profile.clone()}})).unwrap();
    std::fs::write(&overlay, &overlay_content).unwrap();
    let settings_path = config.join("settings.json");
    std::fs::write(
        &settings_path,
        serde_json::to_vec(&json!({
            "active_provider": "alpha", "providers": {"alpha": profile.clone(), "beta": profile},
            "studio_context": {"instructions": "preserve across deletion"}
        }))
        .unwrap(),
    )
    .unwrap();
    let credential_path = config.join("credentials.json");
    std::fs::write(
        &credential_path,
        serde_json::to_vec(&json!({
            "alpha": {"type": "api", "key": "fixture-alpha-key"},
            "beta": {"type": "api", "key": "fixture-beta-key"}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .spawn();
    assert_eq!(
        server.initialize(1)["result"]["capabilities"]["experimental"]["providerDeletion"],
        true
    );
    server.send(json!({"jsonrpc":"2.0", "id":2, "method":"runtime.providers.list", "params":{}}));
    assert_eq!(server.response(2)["result"]["restartRequired"], false);
    for (id, params) in [
        (
            3,
            json!({"id":"alpha", "confirm":false, "replacementProvider":"beta"}),
        ),
        (4, json!({"id":"alpha", "confirm":true,"replacementProvider":"missing"})),
        (
            5,
            json!({"id":"overlay-only", "confirm":true, "removeCredentials":true}),
        ),
        (
            6,
            json!({"id":"alpha", "confirm":true, "replacementProvider":"overlay-only"}),
        ),
        (
            7,
            json!({"id":"alpha", "confirm":true, "apiKey":"must-not-be-echoed"}),
        ),
    ] {
        server.send(
            json!({"jsonrpc":"2.0", "id":id, "method":"runtime.providers.delete", "params":params}),
        );
        let response = server.response(id);
        assert!(response.get("error").is_some());
        assert!(!response.to_string().contains("must-not-be-echoed"));
    }
    server.send(
        json!({"jsonrpc":"2.0", "id":8, "method":"runtime.providers.delete", "params":{
            "id":"alpha", "confirm":true, "replacementProvider":"beta", "removeCredentials":false
        }}),
    );
    let removed = server.response(8);
    assert!(removed.get("error").is_none(), "{removed}");
    assert_eq!(removed["result"]["restartRequired"], true);
    assert_eq!(removed["result"]["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(removed["result"]["profiles"][0]["id"], "beta");
    assert!(!removed.to_string().contains("fixture-alpha-key"));
    server.shutdown_successfully();
    let keys: Value = serde_json::from_slice(&std::fs::read(&credential_path).unwrap()).unwrap();
    assert!(keys.get("alpha").is_some());
    assert_eq!(std::fs::read(&overlay).unwrap(), overlay_content);

    let mut reader = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .spawn();
    reader.initialize(10);
    reader.send(json!({"jsonrpc":"2.0", "id":11, "method":"runtime.providers.list", "params":{}}));
    let listed = reader.response(11);
    assert_eq!(listed["result"]["restartRequired"], false);
    assert_eq!(listed["result"]["profiles"][0]["id"], "beta");
    assert_eq!(listed["result"]["profiles"][0]["isDefault"], true);
    reader.send(json!({"jsonrpc":"2.0", "id":12, "method":"runtime.models.list", "params":{}}));
    let models = reader.response(12);
    assert!(
        !models["result"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"]
                .as_str()
                .unwrap_or_default()
                .starts_with("alpha::"))
    );
    assert!(
        models["result"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["id"]
                .as_str()
                .unwrap_or_default()
                .starts_with("overlay-only::"))
    );
    let (endpoint, fixture) = provider_validation_fixture(200);
    reader.send(
        json!({"jsonrpc":"2.0", "id":13, "method":"runtime.providers.upsert", "params":{
            "id":"gamma", "apiFormat":"openai_chat_completions", "endpoint":endpoint,
            "model":"gamma-model", "contextWindowTokens":32000, "maxOutputTokens":4096,
            "apiKey":"fixture-gamma-key", "makeDefault":true
        }}),
    );
    assert!(reader.response(13).get("error").is_none());
    fixture.join().unwrap();
    reader.send(
        json!({"jsonrpc":"2.0", "id":14, "method":"runtime.providers.delete", "params":{
            "id":"beta", "confirm":true, "removeCredentials":true
        }}),
    );
    assert!(reader.response(14).get("error").is_none());
    reader.send(
        json!({"jsonrpc":"2.0", "id":15, "method":"runtime.providers.validate", "params":{}}),
    );
    assert_eq!(reader.response(15)["result"]["valid"], true);
    reader.shutdown_successfully();
    let keys: Value = serde_json::from_slice(&std::fs::read(&credential_path).unwrap()).unwrap();
    assert!(keys.get("beta").is_none());
    assert!(keys.get("alpha").is_some());
    assert!(keys.get("gamma").is_some());
    assert_eq!(std::fs::read(&overlay).unwrap(), overlay_content);
}
