// Lean plan M1-1: a background tool job (here a failing "test" command) wakes
// the original thread exactly once after the parent turn ended, and the
// follow-up request carries the job's terminal notification.

#[test]
fn a_failed_background_command_wakes_the_original_thread_once() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (endpoint, calls, fixture) = serving_fixture_decided(|index, request| {
        let body = request.to_string();
        if body.contains("All tracked background work has finished") {
            return FixtureAnswer::Text("FOLLOWUP_SAW_FAILURE".into());
        }
        if index == 0 {
            return FixtureAnswer::Tool {
                id: "bg-test-call".into(),
                name: "bash".into(),
                input: json!({
                    // Finish only after the parent turn completed, so the result
                    // must travel through the idle follow-up path.
                    "command": "n=0; while [ ! -e .parent-done ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done; printf 'TESTS_%s\\n' FAILED; exit 3",
                    "description": "run the test suite",
                    "run_in_background": true
                }),
            };
        }
        FixtureAnswer::Text("WAITING_FOR_TESTS".into())
    });
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut fixture_settings: Value =
        serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    fixture_settings["permission_mode"] = json!("bypass");
    std::fs::write(&settings, serde_json::to_vec(&fixture_settings).unwrap()).unwrap();
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
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "run the tests in the background"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let parent_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(40);
    let mut followup_turn = None::<String>;
    let mut followup_started = 0usize;
    let mut followup_completed = 0usize;
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed"
            && event["params"]["turn"]["id"].as_str() == Some(parent_turn.as_str())
        {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            std::fs::write(workspace.join(".parent-done"), b"done").unwrap();
        }
        if event["method"] == "turn/started"
            && event["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            assert_eq!(event["params"]["threadId"], thread_id, "{event}");
            followup_started += 1;
            followup_turn = event["params"]["turn"]["id"].as_str().map(str::to_string);
        }
        if event["method"] == "turn/completed"
            && followup_turn.is_some()
            && event["params"]["turn"]["id"].as_str() == followup_turn.as_deref()
        {
            followup_completed += 1;
            break;
        }
    }
    // Give a duplicate wake the chance to appear before counting.
    let settle = Instant::now() + Duration::from_millis(1500);
    while let Ok(line) = server
        .rx
        .recv_timeout(settle.saturating_duration_since(Instant::now()))
    {
        let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if event["method"] == "turn/started" {
            followup_started += 1;
        }
    }
    assert_eq!(followup_started, 1, "the background result must wake once");
    assert_eq!(followup_completed, 1);

    let requests = calls.lock().unwrap().clone();
    let followups: Vec<&Value> = requests
        .iter()
        .filter(|request| {
            request
                .to_string()
                .contains("All tracked background work has finished")
        })
        .collect();
    assert_eq!(followups.len(), 1, "exactly one follow-up model request");
    let body = followups[0].to_string();
    assert!(body.contains("<task_notification id="), "{body}");
    assert!(body.contains("status=\\\"failed\\\""), "{body}");
    server.shutdown();
    drop(fixture);
}

// Lean plan M1-6: once the user paused automation, a background result that
// arrives later is kept but must not start a model turn on its own; the
// user's next turn carries it.
#[test]
fn a_background_result_after_pause_does_not_wake_the_thread() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    // The quiet window below outlasts the default fixture idle timeout.
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(|index, _request| {
        if index == 0 {
            return FixtureAnswer::Tool {
                id: "bg-paused-call".into(),
                name: "bash".into(),
                input: json!({
                    "command": "n=0; while [ ! -e .release ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done; printf 'LATE_%s\\n' RESULT",
                    "description": "late background job",
                    "run_in_background": true
                }),
            };
        }
        FixtureAnswer::Text("STARTED".into())
    }, None, Duration::from_secs(30));
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut fixture_settings: Value =
        serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    fixture_settings["permission_mode"] = json!("bypass");
    std::fs::write(&settings, serde_json::to_vec(&fixture_settings).unwrap()).unwrap();
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
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "start a long background job"}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let parent_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed"
            && event["params"]["turn"]["id"].as_str() == Some(parent_turn.as_str())
        {
            break;
        }
    }
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/automation/suspend",
        "params": {"threadId": thread_id.clone()}
    }));
    let suspended = server.response(4);
    assert_eq!(suspended["result"]["suspended"], true, "{suspended}");
    let calls_before_release = fixture_call_count(&calls);

    std::fs::write(workspace.join(".release"), b"go").unwrap();
    let mut woke = 0usize;
    let settle = Instant::now() + Duration::from_secs(6);
    while let Ok(line) = server
        .rx
        .recv_timeout(settle.saturating_duration_since(Instant::now()))
    {
        let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if event["method"] == "turn/started" {
            woke += 1;
        }
    }
    assert_eq!(woke, 0, "a paused thread must not be woken by a late result");
    assert_eq!(fixture_call_count(&calls), calls_before_release);

    // The result was kept: the user's next turn carries it to the model.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "continue"}]}
    }));
    let resumed = server.response(5);
    assert!(resumed.get("error").is_none(), "{resumed}");
    let resumed_turn = resumed["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed"
            && event["params"]["turn"]["id"].as_str() == Some(resumed_turn.as_str())
        {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    let requests = calls.lock().unwrap().clone();
    let carried = requests[calls_before_release..]
        .iter()
        .map(Value::to_string)
        .filter(|body| {
            body.contains("<task_notification id=") && body.contains("status=\\\"completed\\\"")
        })
        .count();
    assert!(
        carried >= 1,
        "the kept result must reach the next turn: {:?}",
        requests[calls_before_release..]
            .iter()
            .flat_map(|r| r["messages"].as_array().cloned().unwrap_or_default())
            .filter(|m| m["role"] != "system")
            .collect::<Vec<_>>()
    );
    server.shutdown();
    drop(fixture);
}
