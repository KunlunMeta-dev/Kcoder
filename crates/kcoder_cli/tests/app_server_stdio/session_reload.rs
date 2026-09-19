#[test]
#[cfg(unix)]
fn new_sessions_reload_models_skills_and_hooks_without_mutating_resident_sessions() {
    // Only configuration snapshots and startup hooks are exercised; no model request is sent.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["providers"]["integration-test"]["authentication"] = json!({"mode":"none"});
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let initial = server.response(2);
    assert!(initial.get("error").is_none(), "{initial}");
    let old_thread = initial["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let marker = temp.path().join("new-session-hook");
    settings["providers"]["integration-test"]["default_model"] = json!("updated-model");
    settings["hooks"] = json!({"SessionStart":[{"hooks":[{"type":"command","shell":"sh","timeout":5,"command":format!("printf new-session >> '{}'", marker.display())}]}]});
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let skill = config.join("skills/fresh-skill/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(
        &skill,
        "---\nname: fresh-skill\ndescription: A newly installed skill\n---\nFRESH_SKILL_CONTENT\n",
    )
    .unwrap();
    server.send(json!({"id":3,"method":"runtime.models.list","params":{}}));
    assert!(
        server.response(3)["result"]
            .to_string()
            .contains("updated-model")
    );
    server.send(json!({"id":4,"method":"runtime.models.list","params":{"threadId":old_thread}}));
    let old_catalog = server.response(4);
    assert!(
        old_catalog["result"]
            .to_string()
            .contains("deterministic-scenario")
    );
    assert!(!old_catalog["result"].to_string().contains("updated-model"));
    server.send(json!({"id":5,"method":"device/execute","params":{"command_key":"ls_skills"}}));
    let skills = server.response(5);
    assert!(
        skills["result"].to_string().contains("fresh-skill"),
        "{skills}"
    );
    server.send(json!({"id":6,"method":"thread/start","params":{}}));
    let next = server.response(6);
    assert!(next.get("error").is_none(), "{next}");
    assert!(
        next["result"]["thread"]["model"]
            .as_str()
            .unwrap()
            .contains("updated-model")
    );
    server.send(json!({"id":21,"method":"device/execute","params":{"command_key":"ls_skills","threadId":next["result"]["thread"]["id"]}}));
    assert!(
        server.response(21)["result"]
            .to_string()
            .contains("fresh-skill")
    );
    server.send(json!({"id":22,"method":"device/execute","params":{"command_key":"ls_skills","threadId":old_thread}}));
    assert!(
        !server.response(22)["result"]
            .to_string()
            .contains("fresh-skill")
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "new-session");
    server.send(json!({"id":7,"method":"runtime.providers.list","params":{}}));
    let providers = server.response(7);
    assert_eq!(providers["result"]["supportsNewSessionReload"], true);
    assert_eq!(providers["result"]["restartRequired"], false);
    std::fs::write(&settings_path, "{").unwrap();
    server.send(json!({"id":8,"method":"thread/start","params":{}}));
    assert!(server.response(8).get("error").is_some());
    server.send(json!({"id":9,"method":"runtime.models.list","params":{"threadId":old_thread}}));
    assert_eq!(server.response(9)["result"], old_catalog["result"]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":10,"method":"thread/start","params":{}}));
    assert!(server.response(10).get("error").is_none());
    server.shutdown_successfully();
}

#[test]
#[cfg(unix)]
fn new_sessions_load_installed_plugin_tools_and_keep_existing_tool_snapshots() {
    // A synthetic stdio MCP server verifies lifecycle and ownership without model calls.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["providers"]["integration-test"]["authentication"] = json!({"mode":"none"});
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let old_thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = temp.path().join("plugin");
    std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(source.join("skills/plugin-fresh")).unwrap();
    std::fs::write(
        source.join(".codex-plugin/plugin.json"),
        r#"{"name":"session-reload","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("skills/plugin-fresh/SKILL.md"),
        "---\nname: plugin-fresh\ndescription: Fresh plugin skill\n---\nPLUGIN_SKILL\n",
    )
    .unwrap();
    std::fs::write(
        source.join(".mcp.json"),
        r#"{"mcpServers":{"fresh":{"command":"python3","args":["${PLUGIN_ROOT}/server.py"]}}}"#,
    )
    .unwrap();
    std::fs::write(source.join("server.py"), r#"
import sys, json
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    if req['method'] == 'initialize':
        result = {'protocolVersion': req['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name':'fresh','version':'1'}}
    elif req['method'] == 'tools/list':
        result = {'tools': [{'name':'fresh_probe','description':'Fresh plugin probe','inputSchema':{'type':'object'}}]}
    else: result = {'content': [{'type':'text','text':'ok'}]}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}), flush=True)
"#).unwrap();
    server.send(json!({"id":3,"method":"plugin/install","params":{"path":source}}));
    let installed = server.response(3);
    assert!(installed.get("error").is_none(), "{installed}");
    // A failed optional server must not block a conversation or poison the cache.
    let recovery_script = temp.path().join("recovering-mcp.py");
    settings["mcp_servers"] =
        json!([{"name":"unavailable", "command":"python3", "args":[recovery_script]}]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":4,"method":"thread/start","params":{}}));
    let next = server.response(4);
    assert!(next.get("error").is_none(), "{next}");
    let new_thread = next["result"]["thread"]["id"].as_str().unwrap().to_owned();
    server.send(json!({"id":5,"method":"tools/catalog","params":{"threadId":new_thread}}));
    let fresh_tools = server.response(5);
    assert!(
        fresh_tools["result"].to_string().contains("fresh_probe"),
        "{fresh_tools}"
    );
    server.send(json!({"id":6,"method":"tools/catalog","params":{"threadId":old_thread}}));
    assert!(
        !server.response(6)["result"]
            .to_string()
            .contains("fresh_probe")
    );
    server.send(json!({"id":7,"method":"device/execute","params":{"command_key":"ls_skills"}}));
    let skills = server.response(7);
    assert!(
        skills["result"].to_string().contains("plugin-fresh"),
        "{skills}"
    );
    assert!(
        !fresh_tools["result"]
            .to_string()
            .contains("mcp__unavailable__fresh_probe")
    );
    std::fs::copy(source.join("server.py"), &recovery_script).unwrap();
    server.send(json!({"id":31,"method":"thread/start","params":{}}));
    let recovered = server.response(31);
    assert!(recovered.get("error").is_none(), "{recovered}");
    server.send(json!({"id":32,"method":"tools/catalog","params":{"threadId":recovered["result"]["thread"]["id"]}}));
    assert!(
        server.response(32)["result"]
            .to_string()
            .contains("mcp__unavailable__fresh_probe")
    );
    settings["mcp_servers"] = json!([]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(
        json!({"id":8,"method":"plugin/disable","params":{"pluginId":"session-reload@local"}}),
    );
    assert!(server.response(8).get("error").is_none());
    server.send(json!({"id":9,"method":"thread/start","params":{}}));
    let third = server.response(9)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":10,"method":"tools/catalog","params":{"threadId":third}}));
    assert!(
        !server.response(10)["result"]
            .to_string()
            .contains("fresh_probe")
    );
    server.send(json!({"id":11,"method":"tools/catalog","params":{"threadId":new_thread}}));
    assert_eq!(server.response(11)["result"], fresh_tools["result"]);
    server.shutdown_successfully();
}

#[test]
#[cfg(unix)]
fn silent_user_prompt_plugin_hook_allows_a_complete_turn() {
    // The deterministic provider verifies the hook gate, not model behavior.
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let root = temp.path().join(".kcoder/plugins/ai-plugins");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"ai-plugins"}"#,
    )
    .unwrap();
    std::fs::write(root.join("hooks/hooks.json"), r#"{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/suggest-endor-tools.sh\""}]}]}}"#).unwrap();
    std::fs::write(
        root.join("hooks/suggest-endor-tools.sh"),
        r#"
payload=$(cat)
case "$payload" in
  *'"prompt":"silent-hook-message"'*) exit 0 ;;
  *) printf 'prompt alias missing' >&2; exit 2 ;;
esac
"#,
    )
    .unwrap();
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"silent-hook-message"}]}}));
    assert!(server.response(3).get("error").is_none());
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
    server.shutdown_successfully();
}

#[test]
fn initialize_remains_available_when_mcp_never_responds() {
    // A stalled optional HTTP server must not consume the Gateway handshake deadline.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings_path = temp.path().join("settings.json");
    write_test_settings(&settings_path);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["providers"]["integration-test"]["authentication"] = json!({"mode":"none"});
    settings["mcp_servers"] =
        json!([{"name":"stalled", "transport":"http", "url":format!("http://{address}/mcp")}]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let started = Instant::now();
    let mut server = TestAppServer::builder(&workspace, &settings_path)
        .without_scenario()
        .spawn();
    server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"stalled-mcp-test","version":"1"}}}));
    let line = server
        .rx
        .recv_timeout(Duration::from_secs(11))
        .unwrap_or_else(|error| {
            let _ = server.child.kill();
            let mut stderr = String::new();
            if let Some(mut pipe) = server.child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
            }
            panic!("initialize unavailable: {error}: {stderr}");
        })
        .unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert!(response.get("error").is_none(), "{response}");
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "optional MCP delayed initialize by {:?}",
        started.elapsed()
    );
    server.shutdown_successfully();
    drop(listener);
}

#[test]
fn invalid_optional_http_mcp_does_not_block_new_conversation() {
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
    let mut settings: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["mcp_servers"] = json!([{"name":"broken-http","transport":"http","url":"invalid-url"}]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let response = server.response(2);
    assert!(response.get("error").is_none(), "{response}");
    server.shutdown_successfully();
}

#[test]
fn mcp_list_reloads_target_configuration_without_exposing_secrets_or_starting_servers() {
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
        .config_dir(&config).without_scenario().spawn();
    assert!(server.initialize(1).get("error").is_none());
    let mut settings: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["mcp_servers"] = json!([
        {"name":"local-tool","command":"private-command-that-does-not-exist","env":{"TOKEN":"private-env-secret"}},
        {"name":"oauth-tool","transport":"http","url":"https://example.invalid/mcp?token=private-url-secret"},
        {"name":"header-tool","transport":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer private-header-secret"}}
    ]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":2,"method":"mcp/list","params":{}}));
    let response = server.response(2);
    assert!(response.get("error").is_none(), "{response}");
    let servers = response["result"]["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 3);
    let state = |name: &str| servers.iter().find(|item| item["name"] == name).unwrap()["authorization"].as_str().unwrap();
    assert_eq!(state("local-tool"), "notApplicable");
    assert_eq!(state("oauth-tool"), "notAuthorized");
    assert_eq!(state("header-tool"), "configuredHeader");
    assert!(!response.to_string().contains("private-"));
    for (id, params) in [
        (4, json!({"name":"unknown"})),
        (5, json!({"name":"oauth-tool","pluginId":"different-plugin"})),
        (6, json!({"name":"local-tool"})),
        (7, json!({"name":"header-tool"})),
        (8, json!({"name":"oauth-tool","url":"https://other.invalid"})),
    ] {
        server.send(json!({"id":id,"method":"mcp/logout","params":params}));
        let rejected = server.response(id);
        assert!(rejected.get("error").is_some(), "{rejected}");
        assert!(!rejected.to_string().contains("private-"));
    }
    let unchanged = std::fs::read(&settings_path).unwrap();
    server.send(json!({"id":9,"method":"mcp/logout","params":{"name":"oauth-tool"}}));
    assert_eq!(server.response(9)["result"]["loggedOut"], true);
    assert_eq!(std::fs::read(&settings_path).unwrap(), unchanged);
    server.send(json!({"id":10,"method":"mcp/list","params":{}}));
    let after_logout = server.response(10);
    assert_eq!(after_logout["result"]["servers"][1]["authorization"], "notAuthorized");
    settings["mcp_servers"] = json!([]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":3,"method":"mcp/list","params":{}}));
    assert!(server.response(3)["result"]["servers"].as_array().unwrap().is_empty());
    server.shutdown_successfully();
}

#[test]
fn mcp_oauth_rpc_completes_discovery_registration_callback_and_logout() {
    use std::io::Read;
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
        .config_dir(&config).without_scenario().spawn();
    assert!(server.initialize(1).get("error").is_none());
    let mut foreign = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config).without_scenario().spawn();
    assert!(foreign.initialize(1).get("error").is_none());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    let fixture_root = root.clone();
    let fixture = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        for expected in ["/mcp", "/metadata", "/.well-known/oauth-authorization-server", "/register", "/token"] {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("OAuth fixture accept failed: {error}"),
                }
            };
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            let (head, body) = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
                    let length: usize = head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    }).unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break (head, bytes[end + 4..end + 4 + length].to_vec());
                    }
                }
            };
            assert_eq!(head.lines().next().unwrap().split_whitespace().nth(1), Some(expected));
            let (status, headers, response) = match expected {
                "/mcp" => ("401 Unauthorized", format!("WWW-Authenticate: Bearer resource_metadata=\"{fixture_root}/metadata\"\r\n"), json!({})),
                "/metadata" => ("200 OK", String::new(), json!({"resource":fixture_root,"authorization_servers":[fixture_root]})),
                "/.well-known/oauth-authorization-server" => ("200 OK", String::new(), json!({
                    "issuer":fixture_root,"authorization_endpoint":format!("{fixture_root}/authorize"),
                    "token_endpoint":format!("{fixture_root}/token"),"registration_endpoint":format!("{fixture_root}/register"),
                    "response_types_supported":["code"],"code_challenge_methods_supported":["S256"],
                    "token_endpoint_auth_methods_supported":["none"]
                })),
                "/register" => {
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(request["redirect_uris"][0], "http://127.0.0.1:34567/callback");
                    ("201 Created", String::new(), json!({"client_id":"fixture-client","token_endpoint_auth_method":"none"}))
                }
                "/token" => {
                    let form: std::collections::HashMap<_, _> = reqwest::Url::parse(&format!("http://localhost/?{}", String::from_utf8(body).unwrap()))
                        .unwrap().query_pairs().into_owned().collect();
                    assert_eq!(form["code"], "fixture-code");
                    assert_eq!(form["code_verifier"].len(), 43);
                    ("200 OK", String::new(), json!({"access_token":"private-access-token","token_type":"Bearer","expires_in":3600}))
                }
                _ => unreachable!(),
            };
            let body = response.to_string();
            socket.write_all(format!("HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        }
    });
    let mut settings: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    settings["mcp_servers"] = json!([{"name":"oauth","transport":"http","url":format!("{root}/mcp")}]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":2,"method":"mcp/login","params":{"server":{"name":"oauth"},"redirectUri":"http://127.0.0.1:34567/callback"}}));
    let login = server.response(2);
    assert!(login.get("error").is_none(), "{login}");
    let authorization = reqwest::Url::parse(login["result"]["authorizationUrl"].as_str().unwrap()).unwrap();
    let state = authorization.query_pairs().find(|(name, _)| name == "state").unwrap().1.into_owned();
    let mut callback = reqwest::Url::parse("http://127.0.0.1:34567/callback").unwrap();
    callback.query_pairs_mut().append_pair("state", &state).append_pair("code", "fixture-code");
    foreign.send(json!({"id":2,"method":"mcp/callback","params":{"flowId":login["result"]["flowId"],"callbackUrl":callback.as_str()}}));
    let rejected = foreign.response(2);
    assert!(rejected["error"]["message"].as_str().unwrap().contains("unavailable on this connection"));
    foreign.send(json!({"id":3,"method":"mcp/cancel","params":{"flowId":login["result"]["flowId"]}}));
    assert!(foreign.response(3).get("error").is_some());
    foreign.shutdown_successfully();
    let original_settings = std::fs::read(&settings_path).unwrap();
    settings["mcp_servers"][0]["url"] = json!(format!("{root}/changed"));
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":20,"method":"mcp/callback","params":{"flowId":login["result"]["flowId"],"callbackUrl":callback.as_str()}}));
    let changed = server.response(20);
    assert!(changed["error"]["message"].as_str().unwrap().contains("configuration changed"));
    settings["mcp_servers"] = json!([]);
    std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    server.send(json!({"id":21,"method":"mcp/callback","params":{"flowId":login["result"]["flowId"],"callbackUrl":callback.as_str()}}));
    let removed = server.response(21);
    assert!(removed["error"]["message"].as_str().unwrap().contains("not configured"));
    std::fs::write(&settings_path, original_settings).unwrap();
    server.send(json!({"id":3,"method":"mcp/callback","params":{"flowId":login["result"]["flowId"],"callbackUrl":callback.as_str()}}));
    assert_eq!(server.response(3)["result"]["authorized"], true);
    fixture.join().unwrap();
    server.send(json!({"id":4,"method":"mcp/list","params":{}}));
    let listed = server.response(4);
    assert_eq!(listed["result"]["servers"][0]["authorization"], "authorized");
    assert!(!listed.to_string().contains("private-access-token"));
    server.send(json!({"id":5,"method":"mcp/cancel","params":{"flowId":login["result"]["flowId"]}}));
    assert!(server.response(5).get("error").is_some());
    server.send(json!({"id":6,"method":"mcp/logout","params":{"name":"oauth"}}));
    assert_eq!(server.response(6)["result"]["loggedOut"], true);
    server.send(json!({"id":7,"method":"mcp/list","params":{}}));
    assert_eq!(server.response(7)["result"]["servers"][0]["authorization"], "notAuthorized");
    server.shutdown_successfully();
}

#[test]
fn mcp_install_remove_edit_only_target_user_settings_and_respect_overlays() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings_path = config.join("settings.json");
    write_test_settings(&settings_path);
    let before: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config).without_scenario().spawn();
    assert!(server.initialize(1).get("error").is_none());
    let params = json!({"config":{"name":"standalone","transport":"http","url":"https://example.invalid/mcp","headers":{"X-Key":"private-fixture-value"}}});
    server.send(json!({"id":2,"method":"mcp/install","params":params}));
    let installed = server.response(2);
    assert_eq!(installed["result"]["appliesToNewConversations"], true, "{installed}");
    assert!(!installed.to_string().contains("private-fixture-value"));
    let saved: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(saved["providers"], before["providers"]);
    assert_eq!(saved["mcp_servers"][0]["name"], "standalone");
    server.send(json!({"id":3,"method":"mcp/list","params":{}}));
    assert_eq!(server.response(3)["result"]["servers"][0]["name"], "standalone");
    let installed_bytes = std::fs::read(&settings_path).unwrap();
    server.send(json!({"id":4,"method":"mcp/install","params":params}));
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"mcp/remove","params":{"name":"standalone","pluginId":"plugin-fixture"}}));
    assert!(server.response(5).get("error").is_some());
    assert_eq!(std::fs::read(&settings_path).unwrap(), installed_bytes);
    server.send(json!({"id":6,"method":"mcp/remove","params":{"name":"standalone"}}));
    assert_eq!(server.response(6)["result"]["name"], "standalone");
    let removed: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(removed["providers"], before["providers"]);
    assert_eq!(removed["mcp_servers"], json!([]));
    let before_overlay = std::fs::read(&settings_path).unwrap();
    std::fs::write(&overlay, r#"{"mcp_servers":[]}"#).unwrap();
    server.send(json!({"id":7,"method":"mcp/install","params":params}));
    let controlled = server.response(7);
    assert!(controlled["error"]["message"].as_str().unwrap().contains("overlay"), "{controlled}");
    assert_eq!(std::fs::read(&settings_path).unwrap(), before_overlay);
    server.shutdown_successfully();
}

#[test]
fn skill_import_remove_use_target_user_store_and_reload_inventory() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let source = temp.path().join("source");
    for directory in [&workspace, &config, &source] { std::fs::create_dir_all(directory).unwrap(); }
    write_test_settings(&config.join("settings.json"));
    std::fs::write(source.join("SKILL.md"), "---\r\nname: studio-imported\r\ndescription: Imported fixture\r\n---\r\nUse this test skill.\r\n").unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay).config_dir(&config).without_scenario().spawn();
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({"id":2,"method":"skills/import","params":{"path":source}}));
    let imported = server.response(2);
    assert_eq!(imported["result"]["name"], "studio-imported", "{imported}");
    assert!(config.join("skills/studio-imported/SKILL.md").exists());
    server.send(json!({"id":3,"method":"device/execute","params":{"command_key":"ls_skills"}}));
    let listed = server.response(3);
    assert!(listed["result"].to_string().contains("studio-imported"));
    let items = listed["result"]["stdout"].as_array().unwrap();
    assert_eq!(items.iter().find(|item| item["name"] == "studio-imported").unwrap()["can_remove"], true);
    server.send(json!({"id":4,"method":"skills/import","params":{"path":source}}));
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"skills/remove","params":{"name":"studio-imported"}}));
    let removed = server.response(5);
    assert!(removed["result"]["archiveName"].is_string(), "{removed}");
    assert!(!config.join("skills/studio-imported").exists());
    server.send(json!({"id":6,"method":"device/execute","params":{"command_key":"ls_skills"}}));
    assert!(!server.response(6)["result"].to_string().contains("studio-imported"));
    assert!(source.join("SKILL.md").exists());
    server.shutdown_successfully();
}
