// R057: an already delivered background result must not be delivered again by a
// recovery. Delivery count is measured per request body rather than assumed.

fn background_bash_call(socket: &mut std::net::TcpStream) {
    // The command text deliberately differs from the string it prints, so the
    // sentinel below counts deliveries of the *result*, not mentions of the
    // command inside the tool call.
    background_bash_tool_call(socket, "printf 'bg-%s\\n' out-sentinel")
}

#[test]
fn a_recovery_does_not_redeliver_a_finished_background_job() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (endpoint, calls, fixture) =
        serving_fixture_scripted(vec![background_bash_call, outage_first_call]);
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
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "start a background job"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Wait for the failed turn, then give the background job time to finish and be
    // delivered before the recovery is attempted.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    std::thread::sleep(Duration::from_secs(2));

    // The finished background job was delivered into the conversation between the
    // failure and this request, so the recorded recovery boundary no longer
    // applies. The runtime must say so instead of continuing from a stale point or
    // replaying the delivered result.
    let before = fixture_call_count(&calls);
    server.send(continuation_request(&thread_id, &failed_turn, 4));
    let refused = server.response(4);
    assert_eq!(refused["error"]["code"], -32046, "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("context changed"),
        "the refusal must name the changed boundary: {refused}"
    );
    assert_eq!(fixture_call_count(&calls), before);
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let transcript = server.response(5);
    assert_eq!(
        transcript["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1,
        "{transcript}"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();

    let recorded = calls.lock().unwrap().clone();
    // Counted structurally, because the raw text legitimately repeats an id in both
    // the call and its result. The invariants hold whichever way the background
    // delivery and the refused recovery interleave: nothing is ever declared or
    // delivered twice, and the scenario really did commit both.
    let mut max_calls = 0;
    let mut max_results = 0;
    for (index, request) in recorded.iter().enumerate() {
        let calls_for_job = tool_call_count(request, "fixture-background-call");
        let results_for_job = tool_result_count(request, "fixture-background-call");
        max_calls = max_calls.max(calls_for_job);
        max_results = max_results.max(results_for_job);
        assert!(
            calls_for_job <= 1 && results_for_job <= 1,
            "request {index} must not repeat the background call or its result: {request}"
        );
        assert!(
            request.to_string().matches("bg-out-sentinel").count() <= 1,
            "request {index} must not carry the finished background result twice: {request}"
        );
    }
    assert_eq!(
        max_calls, 1,
        "the scenario must have started the background job"
    );
    assert_eq!(
        max_results, 1,
        "the tool result must have been committed once"
    );
}
