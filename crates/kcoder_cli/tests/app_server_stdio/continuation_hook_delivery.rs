// R057: a recovery must not re-deliver what was already delivered. A hook is the
// observable side of that promise, because it fires per tool event.

fn write_user_hook_settings(config_dir: &std::path::Path, log_path: &std::path::Path) {
    std::fs::create_dir_all(config_dir).unwrap();
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::to_vec(&json!({
            "hooks": {
                "PostToolUse": [{
                    "matcher": "read",
                    "hooks": [{
                        "type": "command",
                        "command": format!("printf 'hook\\n' >> '{}'", log_path.display())
                    }]
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn hook_lines(log_path: &std::path::Path) -> usize {
    std::fs::read_to_string(log_path)
        .map(|contents| contents.lines().count())
        .unwrap_or_default()
}

#[test]
fn a_recovery_does_not_deliver_an_already_fired_hook_again() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("fixture.txt"), "fixture-file-contents\n").unwrap();
    let log_path = temp.path().join("hook.log");
    // The harness points KCODER_CONFIG_DIR at <workspace>/config, and user-level
    // hooks are not trust-gated, so this is where a hook is picked up from.
    write_user_hook_settings(&workspace.join("config"), &log_path);

    let (endpoint, calls, fixture) =
        serving_fixture_scripted(vec![read_tool_call_path, outage_first_call]);
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "read the file once"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The tool runs and its hook fires; the follow-up model call then fails.
    // Configuring a command hook makes the tool call ask for approval, so the
    // request is accepted here rather than left hanging.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut approvals = 0;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "approval/request" {
            approvals += 1;
            let request_id = event["id"].clone();
            server.send(json!({
                "jsonrpc": "2.0", "id": request_id, "result": {"decision": "accept"}
            }));
            continue;
        }
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    assert_eq!(approvals, 1, "the gated tool call asks for approval once");
    let delivered = hook_lines(&log_path);
    assert_eq!(delivered, 1, "the tool's hook must fire exactly once");

    // The recovery resumes from the committed result: no second tool execution and
    // therefore no second delivery of the hook that already fired.
    server.send(continuation_request(&thread_id, &failed_turn, 4));
    let accepted = server.response(4);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert_eq!(
        hook_lines(&log_path),
        delivered,
        "a recovery must not deliver the already fired hook again"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();

    let recorded = calls.lock().unwrap().clone();
    assert_eq!(recorded.len(), 3, "calls={}", recorded.len());
}

fn read_tool_call_path(socket: &mut std::net::TcpStream) {
    read_tool_call(socket, "fixture.txt")
}
