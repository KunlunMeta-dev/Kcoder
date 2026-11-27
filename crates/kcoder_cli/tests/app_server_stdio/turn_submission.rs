// A retried submission must not append a second user message (S2/R034, S5/R045).

#[test]
fn a_retried_submission_is_refused_and_an_explicit_resubmit_is_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "full-turn", "1", "0", "0");
    server.initialize(1);

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let submission = |id: i64, text: &str, extra: Value| {
        let mut params = json!({
            "threadId": thread_id.clone(),
            "input": [{"type": "text", "text": text}],
            "clientMessageId": "client-message-1"
        });
        if let Some(object) = extra.as_object() {
            for (key, value) in object {
                params[key] = value.clone();
            }
        }
        json!({"jsonrpc": "2.0", "id": id, "method": "turn/start", "params": params})
    };

    server.send(submission(3, "first submission", json!({})));
    let accepted = server.response(3);
    assert_eq!(accepted["result"]["turn"]["status"], "running");
    let first_turn = accepted["result"]["turn"]["id"].as_str().unwrap().to_string();
    server.wait_for_method("turn/completed");

    let user_messages = |server: &mut TestAppServer, id: i64| {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "thread/read",
            "params": {"threadId": thread_id.clone(), "limit": 50}
        }));
        let read = server.response(id);
        read["result"]["messages"]
            .as_array()
            .expect("thread/read messages")
            .iter()
            .filter(|message| message["role"] == "user")
            .count()
    };
    assert_eq!(user_messages(&mut server, 4), 1);

    // The same submission identity arriving again is the retry-after-unknown
    // case: it must be refused instead of running the turn twice.
    server.send(submission(5, "first submission", json!({})));
    let refused = server.response(5);
    assert_eq!(refused["error"]["code"], -32047);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&first_turn),
        "the refusal must name the committed turn: {refused}"
    );
    assert_eq!(
        user_messages(&mut server, 6),
        1,
        "a refused retry must not append another user message"
    );

    // A deliberate re-submission is declared as such and does run again.
    server.send(submission(7, "second attempt", json!({"resubmit": true})));
    let second = server.response(7);
    assert_eq!(second["result"]["turn"]["status"], "running");
    assert_ne!(second["result"]["turn"]["id"], first_turn);
    server.wait_for_method("turn/completed");
    assert_eq!(user_messages(&mut server, 8), 2);
    server.shutdown();
}
