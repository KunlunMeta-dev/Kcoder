// Lean plan M2 demo: a goal survives a real process kill.
//
// 1. A goal is set; the model starts a background test run, then a slow
//    foreground step. The app-server process is killed during that step.
// 2. After a restart the goal is still active, and the killed turn reads back
//    as `unknown`: neither failed nor completed, since its last tool call may
//    or may not have run. Nothing runs on its own and no tool is replayed.
// 3. The next request carries one recovery notice naming the interrupted turn
//    and background task, asking the model to check before redoing anything.
// 4. A second restart does not add the notice again.

fn m2_answer(index: usize, request: &Value) -> FixtureAnswer {
    if request.to_string().contains("<recovery_notice") {
        return FixtureAnswer::Text("RECOVERED".into());
    }
    match index {
        0 => FixtureAnswer::Tool {
            id: "m2-tests".into(),
            name: "bash".into(),
            input: json!({
                "command": "sleep 120",
                "description": "run the long test suite",
                "run_in_background": true
            }),
        },
        1 => FixtureAnswer::Tool {
            id: "m2-step".into(),
            name: "bash".into(),
            input: json!({
                "command": "echo run >> .step-count; sleep 120",
                "description": "slow migration step"
            }),
        },
        _ => FixtureAnswer::Text("AFTER".into()),
    }
}

fn m2_server(workspace: &std::path::Path, settings: &std::path::Path) -> TestAppServer {
    let mut server = TestAppServer::builder(workspace, settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server
}

#[test]
fn m2_demo_a_killed_goal_turn_reads_back_interrupted_and_recovers_once() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (endpoint, calls, fixture) =
        serving_fixture_decided_bounded(m2_answer, None, Duration::from_secs(60));
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["permission_mode"] = json!("bypass");
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let mut server = m2_server(&workspace, &settings);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/goal/set",
        "params": {"threadId": thread_id.clone(), "objective": "Migrate the schema"}
    }));
    assert!(server.response(3).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "clientMessageId": "m2-first",
            "input": [{"type": "text", "text": "migrate the schema"}]}
    }));
    assert!(server.response(4).get("error").is_none());
    let deadline = Instant::now() + Duration::from_secs(30);
    while !workspace.join(".step-count").exists() {
        assert!(Instant::now() < deadline, "the slow step never started");
        let _ = server.rx.recv_timeout(Duration::from_millis(50));
    }
    // A real crash: no shutdown, no terminal record.
    server.child.kill().unwrap();
    let _ = server.child.wait();
    let calls_before_restart = calls.lock().unwrap().len();
    assert_eq!(calls_before_restart, 2);

    let mut server = m2_server(&workspace, &settings);
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/resume",
        "params": {"threadId": thread_id.clone()}
    }));
    let resumed = server.response(5);
    assert!(resumed.get("error").is_none(), "{resumed}");
    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "turn/receipt/read",
        "params": {"threadId": thread_id.clone(), "clientMessageId": "m2-first"}
    }));
    let receipt = server.response(6);
    assert_eq!(
        receipt["result"]["receipt"]["status"], "unknown",
        "{receipt}"
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/goal/get",
        "params": {"threadId": thread_id.clone()}
    }));
    assert_eq!(server.response(7)["result"]["goal"]["status"], "active");
    // Nothing runs by itself after the restart: no provider call, no replay.
    let quiet = Instant::now() + Duration::from_secs(3);
    while Instant::now() < quiet {
        let _ = server.rx.recv_timeout(Duration::from_millis(50));
    }
    assert_eq!(calls.lock().unwrap().len(), calls_before_restart);

    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "continue"}]}
    }));
    assert!(server.response(8).get("error").is_none());
    server.wait_for_method("turn/completed");
    let next = calls.lock().unwrap()[calls_before_restart].to_string();
    assert_eq!(next.matches("<recovery_notice").count(), 1, "{next}");
    assert!(next.contains("Interrupted turn turn-1 (outcome unknown"), "{next}");
    assert!(next.contains("run the long test suite"), "{next}");
    assert!(next.contains("Do not repeat an external action"), "{next}");
    server.shutdown();

    // A second restart neither repeats the notice nor reruns the step.
    let mut server = m2_server(&workspace, &settings);
    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "thread/resume",
        "params": {"threadId": thread_id.clone()}
    }));
    assert!(server.response(9).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 10, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "status?"}]}
    }));
    assert!(server.response(10).get("error").is_none());
    server.wait_for_method("turn/completed");
    let last = calls.lock().unwrap().last().unwrap().to_string();
    assert_eq!(last.matches("<recovery_notice").count(), 1, "{last}");
    let step_runs = std::fs::read_to_string(workspace.join(".step-count")).unwrap();
    assert_eq!(step_runs.lines().count(), 1, "the interrupted step was replayed");
    server.shutdown();
    drop(fixture);
}
