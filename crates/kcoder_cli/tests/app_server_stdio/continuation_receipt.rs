// R054/R056: a continuation that was already accepted must answer a repeated
// request with the same accepted attempt instead of a new one or an error, and
// must still refuse once the recovery boundary has changed.

#[test]
fn a_repeated_continuation_replays_the_same_accepted_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    server.send(continuation_request(&thread_id, &failed_turn, 4));
    let accepted = server.response(4);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let attempt = accepted["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    let after_attempt = fixture_call_count(&calls);

    // The same request again: the response may have been lost on the wire, so the
    // caller must learn the accepted attempt instead of being told there is
    // nothing to continue or starting a second attempt.
    server.send(continuation_request(&thread_id, &failed_turn, 5));
    let replayed = server.response(5);
    assert!(replayed.get("error").is_none(), "{replayed}");
    assert_eq!(replayed["result"]["turn"]["id"], attempt, "{replayed}");
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(fixture_call_count(&calls), after_attempt);
}

#[test]
fn a_replayed_continuation_is_refused_once_the_boundary_changed() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

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

    // Rolling back moves the recovery boundary, so the recorded attempt must not
    // be replayed as if it still applied.
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/rollback",
        "params": {"threadId": thread_id.clone(), "turn": 1}
    }));
    let rolled_back = server.response(7);
    assert!(rolled_back.get("error").is_none(), "{rolled_back}");
    let before = fixture_call_count(&calls);
    server.send(continuation_request(&thread_id, &failed_turn, 8));
    let refused = server.response(8);
    assert_eq!(refused["error"]["code"], -32046, "{refused}");
    assert_eq!(fixture_call_count(&calls), before);
    server.shutdown_successfully();
    fixture.join().unwrap();
}
