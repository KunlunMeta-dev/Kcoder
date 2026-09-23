// F03: a tool whose side effect started but whose result was never committed
// must not be re-run automatically. The caller is refused explicitly and can
// still see the unverified call in the transcript.

fn busy_wait_scenario() -> &'static str {
    "busy-wait"
}

fn start_busy_wait_server(
    workspace: &std::path::Path,
    settings: &std::path::Path,
) -> TestAppServer {
    TestAppServer::builder(workspace, settings)
        .scenario(busy_wait_scenario())
        .stream_delay_ms("1")
        .discard_stderr()
        .spawn()
}

#[test]
fn an_uncommitted_tool_outcome_refuses_the_continuation_instead_of_rerunning_it() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut server = start_busy_wait_server(&workspace, &settings);
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "run the wait"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");

    // Wait until the side-effecting tool is actually running, then kill the
    // process before any result can be committed.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut tool_started = false;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "item/started" && event.to_string().contains("tui-lab-busy-wait") {
            tool_started = true;
            break;
        }
    }
    assert!(tool_started, "the tool must have started before the kill");
    std::thread::sleep(Duration::from_millis(3000));
    server.child.kill().unwrap();
    let _ = server.child.wait();

    // A fresh process restores the same thread with an unpaired tool call.
    let mut server = start_busy_wait_server(&workspace, &settings);
    server.initialize(4);
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/resume",
        "params": {"threadId": thread_id.clone()}
    }));
    let resumed = server.response(5);
    assert!(resumed.get("error").is_none(), "{resumed}");

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let transcript = server.response(6);
    let pending = transcript["result"]["messages"]
        .as_array()
        .expect("thread/read messages")
        .iter()
        .filter_map(|message| message["blocks"].as_array())
        .flatten()
        .find(|block| block["tool_use_id"] == "tui-lab-busy-wait")
        .expect("the unverified call must stay visible in the transcript");
    assert_eq!(pending["status"], "pending", "{transcript}");
    assert!(pending["tool_output"].is_null(), "{transcript}");
    assert!(pending["completed_at"].is_null(), "{transcript}");

    // Continuing from a context with an unknown tool outcome must be refused
    // instead of re-running the tool.
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [], "retryFromTurnId": "turn-1"}
    }));
    let refused = server.response(7);
    assert_eq!(refused["error"]["code"], -32046, "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("continue") || message.contains("继续"),
        "the refusal must explain why it cannot continue: {refused}"
    );

    // The unverified call stays unverified: it is never marked done and never
    // receives an output, so the caller keeps the "needs review" fact.
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let after = server.response(8);
    let still_pending = after["result"]["messages"]
        .as_array()
        .expect("thread/read messages")
        .iter()
        .filter_map(|message| message["blocks"].as_array())
        .flatten()
        .find(|block| block["tool_use_id"] == "tui-lab-busy-wait")
        .expect("the unverified call must stay visible");
    assert_eq!(still_pending["status"], "pending", "{after}");
    assert!(still_pending["tool_output"].is_null(), "{after}");

    // Nothing re-executes the tool: no new tool call starts within the window.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match server.rx.try_recv() {
            Ok(line) => {
                let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
                assert!(
                    event["method"] != "item/started" || !event.to_string().contains("toolCall"),
                    "the refused continuation must not re-run the tool: {event}"
                );
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    server.shutdown();
}
