// F02: a model answer that is cut off mid-stream stays visible, is never
// committed as a complete answer, and is never replayed into the next attempt.

#[test]
fn a_cut_off_answer_stays_visible_without_becoming_committed_output() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture_with(partial_stream_first_call);
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
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The partial answer must still reach the client, so it stays visible even
    // though the stream never finished.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut partial_seen = false;
    let failure = loop {
        let event = server.next_value(deadline);
        if event["method"] == "item/delta" && event.to_string().contains("half an answer") {
            partial_seen = true;
        }
        if event["method"] == "turn/completed" {
            break event;
        }
    };
    assert!(
        partial_seen,
        "the partial delta must be delivered: {failure}"
    );
    assert_eq!(failure["params"]["turn"]["status"], "failed", "{failure}");

    // Visible history preserves the failed partial; model context must still exclude it.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let transcript = server.response(4);
    let messages = transcript["result"]["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|message| {
            message["role"] == "assistant" && message["status"] == "failed"
                && message["attemptId"] == failed_turn
                && message["content"].as_str().unwrap_or_default() == "half an answer"
        }),
        "a truncated stream must remain visible as failed, never as complete: {transcript}"
    );

    // The next attempt starts from the committed boundary, so the half answer is
    // not replayed and the caller is told the response may be regenerated.
    // The failure must name the reason and tell the caller the answer may be
    // regenerated instead of presenting the truncated text as the result.
    let details = &failure["params"]["error"]["details"];
    assert_eq!(details["category"], "provider_error", "{failure}");
    assert_eq!(details["retryable"], true, "{failure}");
    let failure_message = failure["params"]["error"]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        failure_message.contains("retry") || failure_message.contains("重新"),
        "the failure must tell the caller how to recover: {failure}"
    );

    // An interrupted generation is not resumable automatically, but an explicit
    // continuation still starts a fresh attempt from the committed boundary.
    server.send(continuation_request(&thread_id, &failed_turn, 5));
    let accepted = server.response(5);
    assert!(accepted.get("error").is_none(), "{accepted}");
    assert_eq!(
        accepted["result"]["turn"]["status"], "running",
        "{accepted}"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    server.shutdown_successfully();
    fixture.join().unwrap();

    let filename = format!("{:x}.attempt.json", Sha256::digest(failed_turn.as_bytes()));
    let artifact = find_named_file(temp.path(), &filename).expect("original attempt persisted");
    let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open(
        artifact.parent().unwrap().parent().unwrap(), &thread_id,
    ).unwrap();
    let attempts = store.list().unwrap();
    assert_eq!(attempts.len(), 2);
    let failed_attempt = attempts.iter().find(|attempt| attempt.identity.attempt_id == failed_turn).unwrap();
    assert_eq!(failed_attempt.status, kcoder_types::TurnAttemptStatus::Failed);
    assert!(failed_attempt.completion.as_ref().unwrap().partial_output.contains("half an answer"));
    let continued = attempts.iter().find(|attempt| attempt.identity.attempt_id != failed_turn).unwrap();
    assert_eq!(continued.status, kcoder_types::TurnAttemptStatus::Completed);
    assert_eq!(continued.parent_attempt_id.as_deref(), Some(failed_turn.as_str()));

    let mut restored = TestAppServer::builder(temp.path(), &settings).without_scenario().spawn();
    restored.initialize(1);
    restored.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{"threadId":thread_id}}));
    assert!(restored.response(2).get("error").is_none());
    restored.send(json!({"jsonrpc":"2.0","id":3,"method":"thread/read","params":{"threadId":thread_id,"limit":50}}));
    let history = restored.response(3);
    let visible = history["result"]["messages"].as_array().unwrap();
    let prior = visible.iter().position(|message| message["attemptId"] == failed_turn).expect("prior failed attempt remains visible");
    let final_answer = visible.iter().position(|message| message["content"] == "ok").expect("continued final answer");
    assert!(prior < final_answer, "failure must precede its continuation: {history}");
    assert_eq!(visible[prior]["status"], "failed");
    assert_eq!(visible[prior]["continuedByAttemptId"], continued.identity.attempt_id);
    assert_eq!(visible[prior]["content"], "half an answer");
    restored.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":50}}));
    assert_eq!(restored.response(4)["result"]["messages"], history["result"]["messages"]);
    restored.shutdown_successfully();

    let recorded = calls.lock().unwrap().clone();
    for (index, request) in recorded.iter().enumerate() {
        let body = request.to_string();
        assert!(
            !body.contains("half an answer"),
            "request {index} must not replay the truncated answer: {request}"
        );
    }
}

#[test]
fn a_cut_off_reasoning_block_is_never_committed_or_replayed() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture_with(partial_reasoning_stream_first_call);
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
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "think"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut partial_delivered = false;
    let failure = loop {
        let event = server.next_value(deadline);
        if event["method"] == "item/delta" && event.to_string().contains("half a thought") {
            partial_delivered = true;
        }
        if event["method"] == "turn/completed" {
            break event;
        }
    };
    assert_eq!(failure["params"]["turn"]["status"], "failed", "{failure}");
    assert_eq!(
        failure["params"]["error"]["details"]["category"], "provider_error",
        "{failure}"
    );
    assert_eq!(
        failure["params"]["error"]["details"]["retryable"], true,
        "{failure}"
    );
    // Observed behaviour on this path: unlike a truncated body, a truncated
    // reasoning delta is not projected to the client at all. The guarantee below
    // (nothing fabricated, nothing replayed) is what F02 requires; whether partial
    // reasoning should be shown is a separate product decision.
    assert!(
        !partial_delivered,
        "the fixture's reasoning delta is expected to be dropped before projection: {failure}"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/read",
        "params": {"threadId": thread_id.clone(), "limit": 50}
    }));
    let transcript = server.response(4);
    let thinking_blocks: Vec<&Value> = transcript["result"]["messages"]
        .as_array()
        .expect("thread/read messages")
        .iter()
        .filter_map(|message| message["blocks"].as_array())
        .flatten()
        .filter(|block| block["type"] == "thinking")
        .collect();
    assert!(
        !thinking_blocks
            .iter()
            .any(
                |block| block["content"].as_str().unwrap_or_default() == "half a thought"
                    && block["status"] == "done"
            ),
        "a truncated reasoning block must not be committed as complete: {transcript}"
    );

    server.shutdown_successfully();
    fixture.join().unwrap();
    let recorded = calls.lock().unwrap().clone();
    for (index, request) in recorded.iter().enumerate() {
        assert!(
            !request.to_string().contains("half a thought"),
            "request {index} must not replay the truncated reasoning: {request}"
        );
    }
}

#[test]
fn a_failed_continuation_can_continue_as_a_new_attempt_without_replaying_old_operations() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture_scripted(vec![outage_first_call, outage_first_call]);
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread, turn) = start_failed_turn(temp.path(), &settings);
    let request = |id: i64, parent: &str, operation: &str| json!({
        "jsonrpc":"2.0", "id":id, "method":"turn/start", "params": {
            "threadId":thread, "input":[], "retryFromTurnId":turn,
            "retryFromAttemptId":parent, "retryOperationId":operation
        }
    });
    server.send(request(10, &turn, "recovery-1"));
    let accepted = server.response(10);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let failed_attempt = accepted["result"]["turn"]["attemptId"].as_str().unwrap().to_owned();
    loop {
        let event = server.next_value(Instant::now() + Duration::from_secs(30));
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    server.send(request(11, &turn, "recovery-1"));
    let replay = server.response(11);
    assert_eq!(replay["result"]["turn"]["attemptId"], failed_attempt, "{replay}");
    assert_eq!(replay["result"]["turn"]["status"], "failed", "{replay}");
    server.send(request(12, &turn, "stale-new-operation"));
    assert!(server.response(12).get("error").is_some());
    server.send(request(13, &failed_attempt, "recovery-2"));
    let second = server.response(13);
    assert_eq!(second["result"]["turn"]["status"], "running", "{second}");
    assert_ne!(second["result"]["turn"]["attemptId"], failed_attempt);
    loop {
        let event = server.next_value(Instant::now() + Duration::from_secs(30));
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    server.send(request(14, &turn, "recovery-1"));
    let old_replay = server.response(14);
    assert_eq!(old_replay["result"]["turn"]["status"], "failed", "{old_replay}");
    assert_eq!(old_replay["result"]["turn"]["attemptId"], failed_attempt);
    server.send(json!({"jsonrpc":"2.0", "id":16, "method":"turn/receipt/read",
        "params":{"threadId":thread,"retryOperationId":"recovery-1"}}));
    let receipt = server.response(16);
    assert_eq!(receipt["result"]["receipt"]["attemptId"], failed_attempt);
    assert_eq!(receipt["result"]["receipt"]["status"], "failed", "{receipt}");
    assert_eq!(user_message_count(&mut server, &thread, 15), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(calls.lock().unwrap().len(), 3);
}
