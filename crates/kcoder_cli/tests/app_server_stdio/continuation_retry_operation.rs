// R054: a client-supplied retry identity lets any client recognise that the
// recovery it is asking for has already been accepted, and stops that identity
// from being reused for a different failed turn.

fn continuation_with_operation(
    thread_id: &str,
    failed_turn: &str,
    operation: &str,
    id: i64,
) -> Value {
    let mut request = continuation_request(thread_id, failed_turn, id);
    request["params"]["retryOperationId"] = json!(operation);
    request
}

fn completed(server: &mut TestAppServer) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
}

#[test]
fn a_retry_operation_id_is_honoured_across_clients() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    server.send(continuation_with_operation(
        &thread_id,
        &failed_turn,
        "retry-1",
        4,
    ));
    let accepted = server.response(4);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let attempt = accepted["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    completed(&mut server);
    let after_attempt = fixture_call_count(&calls);

    // Another client asking for the same operation must learn the same attempt,
    // even though it never saw the first response.
    server.send(continuation_with_operation(
        &thread_id,
        &failed_turn,
        "retry-1",
        5,
    ));
    let replayed = server.response(5);
    assert!(replayed.get("error").is_none(), "{replayed}");
    assert_eq!(replayed["result"]["turn"]["id"], attempt, "{replayed}");
    assert_eq!(replayed["result"]["turn"]["status"], "completed", "{replayed}");
    assert_eq!(fixture_call_count(&calls), after_attempt);
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn a_retry_operation_id_cannot_be_reused_for_another_failed_turn() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture_scripted(vec![
        outage_first_call,
        outage_first_call,
        outage_first_call,
    ]);
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, first_failed) = start_failed_turn(temp.path(), &settings);

    server.send(continuation_with_operation(
        &thread_id,
        &first_failed,
        "retry-1",
        4,
    ));
    let accepted = server.response(4);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }

    // A newer failed turn is a different operation; reusing the identity must be
    // refused instead of quietly continuing under the old name.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "second request"}]}
    }));
    let second = server.response(5);
    assert!(second.get("error").is_none(), "{second}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }

    server.send(continuation_with_operation(
        &thread_id, "turn-2", "retry-1", 6,
    ));
    let refused = server.response(6);
    assert_eq!(refused["error"]["code"], -32047, "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&first_failed),
        "the refusal must name the turn this operation already committed: {refused}"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn rejected_continuation_parameters_do_not_commit_an_acceptance_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    let mut invalid = continuation_with_operation(&thread_id, &failed_turn, "retry-valid-after-reject", 4);
    invalid["params"]["proxyUrl"] = json!("ftp://127.0.0.1:1");
    server.send(invalid);
    let rejected = server.response(4);
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    assert_eq!(fixture_call_count(&calls), 1);
    server.send(json!({"jsonrpc":"2.0","id":41,"method":"turn/receipt/read", "params": {
        "threadId": thread_id, "retryOperationId":"retry-valid-after-reject"
    }}));
    assert_eq!(server.response(41)["result"], json!({"receipt":null}));
    server.send(continuation_with_operation(&thread_id, &failed_turn, "retry-valid-after-reject", 5));
    let accepted = server.response(5);
    assert!(accepted.get("error").is_none(), "{accepted}");
    completed(&mut server);
    assert_eq!(fixture_call_count(&calls), 2);
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn accepted_continuation_status_survives_restart_and_missing_evidence_refuses_reexecution() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);
    server.send(continuation_with_operation(&thread_id, &failed_turn, "durable-status", 4));
    assert!(server.response(4).get("error").is_none());
    completed(&mut server);
    server.shutdown_successfully();
    fixture.join().unwrap();

    let mut restored = TestAppServer::builder(temp.path(), &settings).without_scenario().spawn();
    restored.initialize(1);
    // Receipt reads do not activate the persisted thread or require its execution lease.
    restored.send(json!({"jsonrpc":"2.0","id":11,"method":"turn/receipt/read", "params": {
        "threadId": thread_id, "retryOperationId":"durable-status"
    }}));
    let receipt = restored.response(11);
    assert_eq!(receipt["result"]["receipt"]["turnId"], failed_turn, "{receipt}");
    assert_eq!(receipt["result"]["receipt"]["status"], "completed", "{receipt}");
    restored.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{"threadId":thread_id}}));
    assert!(restored.response(2).get("error").is_none());
    restored.send(continuation_with_operation(&thread_id, &failed_turn, "durable-status", 3));
    assert_eq!(restored.response(3)["result"]["turn"]["status"], "completed");

    let filename = format!("{:x}.json", Sha256::digest(failed_turn.as_bytes()));
    let artifact = find_named_file(temp.path(), &filename).expect("durable turn artifact");
    let outcome = artifact.parent().unwrap().parent().unwrap().join("turn-outcomes").join(filename);
    assert!(outcome.is_file());
    std::fs::remove_file(outcome).unwrap();
    restored.send(json!({"jsonrpc":"2.0","id":12,"method":"turn/receipt/read", "params": {
        "threadId": thread_id, "retryOperationId":"durable-status"
    }}));
    assert_eq!(restored.response(12)["result"]["receipt"]["status"], "completed", "attempt ledger remains terminal evidence");
    let attempt_id = receipt["result"]["receipt"]["attemptId"].as_str().unwrap();
    let attempt_filename = format!("{:x}.attempt.json", Sha256::digest(attempt_id.as_bytes()));
    let attempt_file = find_named_file(temp.path(), &attempt_filename).unwrap();
    std::fs::remove_file(attempt_file).unwrap();
    restored.send(json!({"jsonrpc":"2.0","id":14,"method":"turn/receipt/read", "params": {
        "threadId": thread_id, "retryOperationId":"durable-status"
    }}));
    assert_eq!(restored.response(14)["result"]["receipt"]["status"], "unknown");
    restored.send(json!({"jsonrpc":"2.0","id":13,"method":"turn/receipt/read", "params": {
        "threadId": "../other", "retryOperationId":"durable-status"
    }}));
    assert!(restored.response(13).get("error").is_some());
    restored.send(continuation_with_operation(&thread_id, &failed_turn, "durable-status", 4));
    assert_eq!(restored.response(4)["error"]["code"], -32046);
    assert_eq!(fixture_call_count(&calls), 2, "receipt lookup cannot execute another request");
    restored.shutdown_successfully();
}
