// F06: a continuation keeps the semantic model snapshot, and an explicit model
// choice must be validated before anything reaches the provider.

fn continuation_with_model(thread_id: &str, failed_turn: &str, model: &str, id: i64) -> Value {
    let mut params = continuation_request(thread_id, failed_turn, id);
    params["params"]["model"] = json!(model);
    params
}

fn request_models(calls: &FixtureCalls) -> Vec<String> {
    calls
        .lock()
        .unwrap()
        .iter()
        .map(|request| request["model"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[test]
fn a_continuation_keeps_the_model_snapshot_when_it_is_not_explicitly_switched() {
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
    server.shutdown_successfully();
    fixture.join().unwrap();

    // The continuation resumes under the same model as the failed attempt: a
    // recovery must not silently re-target the conversation.
    assert_eq!(
        request_models(&calls),
        vec!["fixture-model", "fixture-model"]
    );
}

#[test]
fn an_explicit_model_on_a_continuation_is_sent_as_requested() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    // A passthrough (OpenAI-compatible) endpoint serves whatever model id the
    // caller names, so an explicit choice must reach the provider unchanged
    // instead of being silently replaced by the previous model.
    server.send(continuation_with_model(
        &thread_id,
        &failed_turn,
        "missing-model-xyz",
        4,
    ));
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
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(
        request_models(&calls),
        vec!["fixture-model", "missing-model-xyz"]
    );
}

#[test]
fn a_continuation_accepts_the_model_it_is_already_using() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    server.send(continuation_with_model(
        &thread_id,
        &failed_turn,
        "fixture-model",
        4,
    ));
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
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(
        request_models(&calls),
        vec!["fixture-model", "fixture-model"]
    );
}
