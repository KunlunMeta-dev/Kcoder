// F02, second half: what survives when the process dies mid-stream. R4 promises
// only that partial stream is not replayed or committed as a complete answer, so
// this measures the actual behaviour instead of assuming it.

#[test]
fn a_crash_mid_stream_without_a_checkpoint_refuses_unsafe_continuation() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture_with(slow_partial_stream_first_call);
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
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
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "answer me"}]}
    }));
    assert!(server.response(3).get("error").is_none());

    // The delta reaches the client, then the process dies before the stream ends.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut partial_seen = false;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "item/delta" && event.to_string().contains("uncommitted half") {
            partial_seen = true;
            break;
        }
    }
    assert!(
        partial_seen,
        "the partial delta must be delivered before the crash"
    );
    // Do not call thread/read here: it flushes history and would conceal a
    // durability gap in the first accepted user input. Kill directly after the
    // first real provider delta, before any completed assistant exists.
    server.child.kill().unwrap();
    let _ = server.child.wait();

    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
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
    let messages = transcript["result"]["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1,
        "{transcript}"
    );
    assert!(
        !transcript.to_string().contains("uncommitted half"),
        "an uncommitted fragment must not be invented back into the transcript: {transcript}"
    );

    // A true process crash has no committed failure checkpoint. Unlike ordinary
    // provider EOF (which records a failed attempt), it must refuse continuation
    // rather than fabricate acceptance or replay the original user request.
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [], "retryFromTurnId": "turn-1"}
    }));
    let refused = server.response(7);
    assert_eq!(refused["error"]["code"], -32046, "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no pending failure"),
        "{refused}"
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let final_transcript = server.response(8);
    assert_eq!(
        final_transcript["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1,
        "{final_transcript}"
    );
    server.shutdown();
    fixture.join().unwrap();

    // No request ever carried the fragment the crash left uncommitted.
    let recorded = calls.lock().unwrap().clone();
    // Only the original call ever reached the provider: this fixture stops
    // listening once the crash left its stream unfinished. The refused continuation
    // must never start another provider call. What matters here is that no request carried the
    // fragment the crash left uncommitted.
    assert_eq!(recorded.len(), 1, "calls={}", recorded.len());
    for (index, request) in recorded.iter().enumerate() {
        assert!(
            !request.to_string().contains("uncommitted half"),
            "request {index} must not reuse the uncommitted fragment: {request}"
        );
    }
}
