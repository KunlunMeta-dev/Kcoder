// F04: two windows racing to continue the same failed turn must produce exactly
// one new attempt, and the losing request must be refused explicitly.

#[test]
fn two_windows_racing_to_continue_a_failed_turn_start_only_one_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);
    assert_eq!(user_message_count(&mut server, &thread_id, 4), 1);

    // Two windows continue the same failed turn at the same time.
    server.send_batch([
        continuation_request(&thread_id, &failed_turn, 5),
        continuation_request(&thread_id, &failed_turn, 6),
    ]);
    let first = server.response(5);
    let second = server.response(6);
    // Both windows may legitimately learn the same accepted attempt (the
    // receipt replays it once the winner committed), or the loser may be refused
    // while the winner still holds the gate. What must never happen is a second
    // attempt.
    let accepted: Vec<&Value> = [&first, &second]
        .iter()
        .filter(|response| response.get("error").is_none())
        .copied()
        .collect();
    assert!(!accepted.is_empty(), "first={first} second={second}");
    for response in &accepted {
        assert_eq!(
            response["result"]["turn"]["id"], failed_turn,
            "a continuation must keep the failed turn's identity: {response}"
        );
    }
    let refused = if first.get("error").is_some() {
        &first
    } else {
        &second
    };
    if let Some(code) = refused["error"]["code"].as_i64() {
        // -32003 is the running-turn gate; -32046 means the recovery point was
        // already consumed. Both are explicit refusals.
        assert!(
            code == -32003 || code == -32046,
            "the losing window must be refused explicitly: {refused}"
        );
        assert!(
            !refused["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .is_empty(),
            "refusal must explain itself: {refused}"
        );
    }

    // The accepted attempt recovers, and the transcript still holds one user input.
    let deadline = Instant::now() + Duration::from_secs(30);
    let recovered = loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            break event;
        }
    };
    assert_eq!(user_message_count(&mut server, &thread_id, 7), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();

    // Exactly one continuation reached the provider: the losing window neither
    // started a second attempt nor replayed the user input.
    let requests = calls.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        2,
        "provider calls={} recovered={recovered}",
        requests.len()
    );
    assert_eq!(
        recovered["params"]["turn"]["status"],
        "completed",
        "provider calls={} recovered={recovered}",
        requests.len()
    );
    let continuation_users = requests[1]["messages"]
        .as_array()
        .expect("continuation messages")
        .iter()
        .filter(|message| message["role"] == "user")
        .count();
    assert_eq!(continuation_users, 1, "{}", requests[1]);
}
