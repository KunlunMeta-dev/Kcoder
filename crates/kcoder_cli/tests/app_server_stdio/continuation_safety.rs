// F05: a continuation is accepted only from a valid recovery point. A newer turn,
// a rollback, or a damaged recovery record must refuse it explicitly instead of
// splicing the new attempt into the wrong history.

fn find_dir(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|value| value.to_str()) == Some(name) {
                return Some(path);
            }
            if let Some(found) = find_dir(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn outage_endpoint() -> (String, FixtureCalls, std::thread::JoinHandle<()>) {
    serving_fixture()
}

fn refused(response: &Value) {
    let code = response["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("continuation must be refused: {response}"));
    assert_eq!(code, -32046, "{response}");
    assert!(
        !response["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "{response}"
    );
}

#[test]
fn a_newer_turn_makes_the_failed_turn_uncontinuable() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = outage_endpoint();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    // A second, successful turn supersedes the failed one.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "second request"}]}
    }));
    let second = server.response(4);
    assert!(second.get("error").is_none(), "{second}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }

    server.send(continuation_request(&thread_id, &failed_turn, 5));
    refused(&server.response(5));
    server.shutdown_successfully();

    // The refused continuation never reached the provider.
    fixture.join().unwrap();
    assert_eq!(fixture_call_count(&calls), 2);
}

#[test]
fn a_rollback_after_a_failure_refuses_the_continuation() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = outage_endpoint();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (mut server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/rollback",
        "params": {"threadId": thread_id.clone(), "turn": 1}
    }));
    let rolled_back = server.response(4);
    assert!(rolled_back.get("error").is_none(), "{rolled_back}");

    server.send(continuation_request(&thread_id, &failed_turn, 5));
    refused(&server.response(5));
    server.shutdown_successfully();

    // A rolled-back history must not be continued by replaying the model call.
    fixture.join().unwrap();
    assert_eq!(fixture_call_count(&calls), 1);
}

#[test]
fn a_restart_continues_only_from_an_intact_recovery_record() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = outage_endpoint();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);
    server.shutdown_successfully();

    // Damaged recovery record: the continuation must be refused, not replayed.
    let outcomes =
        find_dir(temp.path(), "turn-outcomes").expect("turn-outcomes artifact directory");
    let artifact = std::fs::read_dir(&outcomes)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .expect("turn outcome artifact");
    std::fs::write(&artifact, b"{ damaged").unwrap();

    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(6);
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/resume",
        "params": {"threadId": thread_id.clone()}
    }));
    let resumed = server.response(7);
    assert!(resumed.get("error").is_none(), "{resumed}");
    server.send(continuation_request(&thread_id, &failed_turn, 8));
    refused(&server.response(8));
    server.shutdown_successfully();

    fixture.join().unwrap();
    assert_eq!(fixture_call_count(&calls), 1);
}

#[test]
fn a_restart_continues_from_an_intact_recovery_record() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = outage_endpoint();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let (server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);
    server.shutdown_successfully();

    // The same recovery point is still valid after a restart, so the positive
    // control for the damaged-record case must continue and only then finish.
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(6);
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/resume",
        "params": {"threadId": thread_id.clone()}
    }));
    let resumed = server.response(7);
    assert!(resumed.get("error").is_none(), "{resumed}");
    server.send(continuation_request(&thread_id, &failed_turn, 8));
    let accepted = server.response(8);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert_eq!(user_message_count(&mut server, &thread_id, 9), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(fixture_call_count(&calls), 2);
}

#[test]
fn a_manual_compaction_after_a_failure_refuses_the_continuation() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = outage_endpoint();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);

    // A context far larger than the configured window makes the manual
    // compaction do real work instead of bailing out on a trivial transcript.
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["providers"]["fixture"]["context_window_tokens"] = json!(16_000);
    value["providers"]["fixture"]["output_headroom_tokens"] = json!(2_048);
    value["providers"]["fixture"]["max_output_tokens"] = json!(2_048);
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let filler = "context filler ".repeat(4_000);
    let (mut server, thread_id, failed_turn) =
        start_failed_turn_with_input(temp.path(), &settings, &filler);

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/compact",
        "params": {"threadId": thread_id.clone()}
    }));
    let compacted = server.response(4);
    assert!(compacted.get("error").is_none(), "{compacted}");
    assert!(
        compacted["result"]["compacted"].is_boolean(),
        "compaction must report whether it rewrote history: {compacted}"
    );

    // Compaction supersedes the failed turn: the runtime must refuse the old
    // recovery point explicitly instead of splicing the attempt into the
    // compacted history.
    let after_compaction = fixture_call_count(&calls);
    server.send(continuation_request(&thread_id, &failed_turn, 5));
    refused(&server.response(5));
    assert_eq!(
        fixture_call_count(&calls),
        after_compaction,
        "the refused continuation must not reach the provider"
    );
    assert_eq!(user_message_count(&mut server, &thread_id, 6), 1);
    server.shutdown_successfully();
    fixture.join().unwrap();
}

/// Damage kinds for the durable recovery record. Those that leave an unreadable
/// artifact fall through to the missing-outcome branch; those that still parse
/// are rejected by the failure-shape check.
fn damage_syntax(path: &std::path::Path, _artifact: &Value) {
    std::fs::write(path, b"{ damaged").unwrap();
}

fn damage_empty(path: &std::path::Path, _artifact: &Value) {
    std::fs::write(path, b"").unwrap();
}

fn damage_another_turn(path: &std::path::Path, artifact: &Value) {
    let mut damaged = artifact.clone();
    damaged["turn_id"] = json!("turn-9");
    std::fs::write(path, serde_json::to_vec(&damaged).unwrap()).unwrap();
}

fn damage_missing_provider_failure(path: &std::path::Path, artifact: &Value) {
    let mut damaged = artifact.clone();
    assert!(
        damaged
            .as_object()
            .unwrap()
            .contains_key("provider_failure"),
        "the fixture must know the artifact shape: {damaged}"
    );
    damaged.as_object_mut().unwrap().remove("provider_failure");
    std::fs::write(path, serde_json::to_vec(&damaged).unwrap()).unwrap();
}

/// A directory in the artifact's place is unreadable for every user, including
/// root, unlike a mode-000 file.
fn damage_replaced_by_directory(path: &std::path::Path, _artifact: &Value) {
    std::fs::remove_file(path).unwrap();
    std::fs::create_dir(path).unwrap();
}

/// The loader also refuses artifacts above its 64 KiB bound.
fn damage_oversized(path: &std::path::Path, artifact: &Value) {
    let mut damaged = artifact.clone();
    damaged["error"] = json!("x".repeat(65 * 1024));
    std::fs::write(path, serde_json::to_vec(&damaged).unwrap()).unwrap();
}

/// R058: an old record without a context digest must be refused explicitly
/// rather than guessed from timestamps or message text.
fn damage_missing_context_digest(path: &std::path::Path, artifact: &Value) {
    let mut damaged = artifact.clone();
    assert!(
        damaged["continuation_context_hash"].is_string(),
        "{damaged}"
    );
    damaged
        .as_object_mut()
        .unwrap()
        .remove("continuation_context_hash");
    std::fs::write(path, serde_json::to_vec(&damaged).unwrap()).unwrap();
}

fn damage_completed_status(path: &std::path::Path, artifact: &Value) {
    let mut damaged = artifact.clone();
    damaged["status"] = json!("completed");
    std::fs::write(path, serde_json::to_vec(&damaged).unwrap()).unwrap();
}

#[test]
fn every_damaged_recovery_record_is_refused_by_its_own_branch() {
    // (damage, the refusal fragment that proves which check rejected it)
    let cases: Vec<(fn(&std::path::Path, &Value), &str)> = vec![
        (damage_syntax, "no pending failure"),
        (damage_empty, "no pending failure"),
        (damage_another_turn, "no pending failure"),
        (damage_replaced_by_directory, "no pending failure"),
        (damage_oversized, "no pending failure"),
        // Missing failure details still parse, so the failure-shape check
        // rejects it...
        (
            damage_missing_provider_failure,
            "Only a failed model generation",
        ),
        // A record that cannot prove its context boundary is refused instead of
        // being reconstructed from timestamps or text.
        (
            damage_missing_context_digest,
            "no safe continuation checkpoint",
        ),
        // ...while a record that no longer claims a failure is filtered out by
        // the loader itself and reads as "no pending failure".
        (damage_completed_status, "no pending failure"),
    ];
    for (damage, expected) in cases {
        let temp = tempfile::tempdir().unwrap();
        let (endpoint, calls, fixture) = outage_endpoint();
        let settings = temp.path().join("settings.json");
        write_fixture_provider_settings(&settings, &endpoint);
        let (server, thread_id, failed_turn) = start_failed_turn(temp.path(), &settings);
        server.shutdown_successfully();

        let outcomes = find_dir(temp.path(), "turn-outcomes").expect("turn-outcomes directory");
        let artifact_path = std::fs::read_dir(&outcomes)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .expect("turn outcome artifact");
        let artifact: Value =
            serde_json::from_slice(&std::fs::read(&artifact_path).unwrap()).unwrap();
        damage(&artifact_path, &artifact);

        let mut server = TestAppServer::builder(temp.path(), &settings)
            .without_scenario()
            .spawn();
        server.initialize(20);
        server.send(json!({
            "jsonrpc": "2.0", "id": 21, "method": "thread/resume",
            "params": {"threadId": thread_id.clone()}
        }));
        let resumed = server.response(21);
        assert!(resumed.get("error").is_none(), "{resumed}");
        let before = fixture_call_count(&calls);
        server.send(continuation_request(&thread_id, &failed_turn, 22));
        let refused = server.response(22);
        assert_eq!(refused["error"]["code"], -32046, "{refused}");
        let message = refused["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains(expected),
            "expected the {expected:?} branch for this damage, got: {refused}"
        );
        assert_eq!(fixture_call_count(&calls), before, "{refused}");
        assert_eq!(user_message_count(&mut server, &thread_id, 23), 1);
        server.shutdown_successfully();
        fixture.join().unwrap();
    }
}
