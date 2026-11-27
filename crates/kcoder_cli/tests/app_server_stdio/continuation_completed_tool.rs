// F01: a completed tool result survives the failure and is not executed again by
// the continuation, which resumes from the committed context.

fn read_only_tool_call(socket: &mut std::net::TcpStream) {
    read_tool_call(socket, "fixture.txt")
}

/// Counts assistant tool calls and committed tool results in a request body.
fn tool_call_count(request: &Value, id: &str) -> usize {
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
                .flatten()
                .filter(|call| call["id"] == id)
                .count()
        })
        .unwrap_or_default()
}

fn tool_result_count(request: &Value, id: &str) -> usize {
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message["role"] == "tool" && message["tool_call_id"] == id)
                .count()
        })
        .unwrap_or_default()
}

#[test]
fn a_completed_tool_result_survives_the_failure_and_is_not_run_twice() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("fixture.txt"), "fixture-file-contents\n").unwrap();
    let (endpoint, calls, fixture) =
        serving_fixture_scripted(vec![read_only_tool_call, outage_first_call]);
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

    // The tool runs, its result is committed, and only the next model call fails.
    let deadline = Instant::now() + Duration::from_secs(30);
    let failure = loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            break event;
        }
    };
    assert_eq!(failure["params"]["turn"]["status"], "failed", "{failure}");
    assert_eq!(
        failure["params"]["error"]["details"]["category"],
        "provider_error"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let transcript = server.response(4);
    assert_eq!(
        transcript["result"]["messages"]
            .as_array()
            .expect("thread/read messages")
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1
    );
    let tool_blocks: Vec<&Value> = transcript["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["blocks"].as_array())
        .flatten()
        .filter(|block| block["tool_use_id"] == "fixture-read-call")
        .collect();
    assert_eq!(
        tool_blocks.len(),
        1,
        "the tool must be recorded once: {transcript}"
    );
    assert_ne!(tool_blocks[0]["status"], "pending", "{transcript}");

    // The continuation resumes with the committed result instead of re-reading.
    server.send(continuation_request(&thread_id, &failed_turn, 5));
    let accepted = server.response(5);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();

    let recorded = calls.lock().unwrap().clone();
    assert_eq!(recorded.len(), 3, "{recorded:?}");
    // The follow-up call after the tool and the continuation both carry exactly
    // one completed result for exactly one call, so the tool ran once.
    for (index, request) in recorded.iter().enumerate().skip(1) {
        assert_eq!(
            tool_call_count(request, "fixture-read-call"),
            1,
            "request {index}: {request}"
        );
        assert_eq!(
            tool_result_count(request, "fixture-read-call"),
            1,
            "request {index}: {request}"
        );
        assert!(
            request.to_string().contains("fixture-file-contents"),
            "request {index} must carry the committed result: {request}"
        );
    }
}
