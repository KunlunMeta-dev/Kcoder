// F08: the server owns the continuation capability and enforces the precondition
// that keeps a continuation from being disguised as a resend.

#[test]
fn the_server_advertises_continuation_and_refuses_a_resend_disguised_as_one() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let negotiated = server.initialize(1);
    // The capability is advertised by the server, so a client that is talking to
    // an older server can tell it must show a limitation instead of pretending
    // the recovery happened.
    assert_eq!(
        negotiated["result"]["capabilities"]["experimental"]["failedTurnContinuationV1"], true,
        "the server must advertise the continuation capability: {negotiated}"
    );
    assert_eq!(
        negotiated["result"]["capabilities"]["experimental"]["turnRetryOperationV1"], true,
        "the server must advertise the named-retry capability: {negotiated}"
    );

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "run once"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }

    // A continuation that carries fresh user input would be a resend wearing the
    // continuation's clothes: it must be refused, not appended silently.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {
            "threadId": thread_id.clone(),
            "input": [{"type": "text", "text": "actually a resend"}],
            "retryFromTurnId": failed_turn.clone()
        }
    }));
    let disguised = server.response(4);
    assert_eq!(disguised["error"]["code"], -32046, "{disguised}");
    let message = disguised["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("Continuation cannot submit another user input"),
        "the refusal must name the precondition: {disguised}"
    );

    // An execution mode is equally not part of a continuation.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {
            "threadId": thread_id.clone(),
            "input": [],
            "turnMode": "moa",
            "retryFromTurnId": failed_turn
        }
    }));
    let mode = server.response(5);
    assert_eq!(mode["error"]["code"], -32046, "{mode}");
    assert!(
        mode["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("execution mode"),
        "a continuation must not carry an execution mode: {mode}"
    );

    // Neither attempt ran: the transcript still holds exactly one user message
    // and the provider was only ever asked once (the original failed attempt).
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    assert_eq!(fixture_call_count(&calls), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
}
