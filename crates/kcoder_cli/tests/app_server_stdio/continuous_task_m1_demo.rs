// Lean plan M1 demo: one goal is carried to completion by the local loop.
//
// 1. A goal is set and the model starts the test suite in the background.
// 2. The suite fails after the turn ended; the result wakes the same thread.
// 3. The model starts a fix; meanwhile the user adds "keep the public API"
//    through `turn/steer`, and it reaches the very next provider request once.
// 4. The model marks the goal complete; the completion gate accepts it because
//    no background work or result is left unsettled.

const DEMO_STEER: &str = "STEER_KEEP_THE_PUBLIC_API";

fn demo_answer(index: usize, request: &Value) -> FixtureAnswer {
    let body = request.to_string();
    if body.contains("Goal marked complete") || body.contains("\\\"status\\\":\\\"complete\\\"") {
        return FixtureAnswer::Text("DEMO_DONE".into());
    }
    if body.contains(DEMO_STEER) {
        return FixtureAnswer::Tool {
            id: "demo-complete".into(),
            name: "update_goal".into(),
            input: json!({"status": "complete"}),
        };
    }
    // The system prompt itself mentions the tag, so match the injected entry.
    let failed_result =
        body.contains("<task_notification id=") && body.contains("status=\\\"failed\\\"");
    if failed_result && !body.contains("demo-fix") {
        return FixtureAnswer::Tool {
            id: "demo-fix".into(),
            name: "bash".into(),
            input: json!({
                // Hold the tool batch open until the user's steer was accepted.
                "command": "touch .fix-started; n=0; while [ ! -e .steer-sent ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done; touch fixed.txt; echo FIXED",
                "description": "fix the failing test"
            }),
        };
    }
    if index == 0 {
        return FixtureAnswer::Tool {
            id: "demo-tests".into(),
            name: "bash".into(),
            input: json!({
                "command": "sleep 1; printf 'TESTS_%s\\n' FAILED; exit 1",
                "description": "run the test suite",
                "run_in_background": true
            }),
        };
    }
    FixtureAnswer::Text("WORKING".into())
}

#[test]
fn m1_demo_a_goal_survives_a_failed_background_test_and_a_steer_to_completion() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (endpoint, calls, fixture) =
        serving_fixture_decided_bounded(demo_answer, None, Duration::from_secs(60));
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
        "jsonrpc": "2.0", "id": 3, "method": "thread/goal/set",
        "params": {"threadId": thread_id.clone(), "objective": "Fix the failing test"}
    }));
    let goal = server.response(3);
    assert!(goal.get("error").is_none(), "{goal}");
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "fix the failing test"}]}
    }));
    let started = server.response(4);
    assert!(started.get("error").is_none(), "{started}");

    // Wait until the fix is running, then steer it with the user's addition.
    let fix_deadline = Instant::now() + Duration::from_secs(60);
    while !workspace.join(".fix-started").exists() {
        assert!(Instant::now() < fix_deadline, "the failed test never woke a fix");
        let _ = server.rx.recv_timeout(Duration::from_millis(50));
    }
    let mut request_id = 10;
    loop {
        server.send(json!({
            "jsonrpc": "2.0", "id": request_id, "method": "turn/steer",
            "params": {"threadId": thread_id.clone(), "text": DEMO_STEER}
        }));
        let reply = server.response(request_id);
        if reply["result"]["status"] == "queued" {
            break;
        }
        assert!(Instant::now() < fix_deadline, "no turn accepted the steer: {reply}");
        request_id += 1;
        std::thread::sleep(Duration::from_millis(50));
    }
    std::fs::write(workspace.join(".steer-sent"), b"sent").unwrap();

    // The goal completes through update_goal, not through a final answer.
    let done_deadline = Instant::now() + Duration::from_secs(60);
    let mut status = Value::Null;
    while Instant::now() < done_deadline {
        while server.rx.recv_timeout(Duration::from_millis(20)).is_ok() {}
        request_id += 1;
        server.send(json!({
            "jsonrpc": "2.0", "id": request_id, "method": "thread/goal/get",
            "params": {"threadId": thread_id.clone()}
        }));
        status = server.response(request_id)["result"]["goal"]["status"].clone();
        if status == "complete" {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(status, "complete");
    assert!(workspace.join("fixed.txt").exists());

    let requests: Vec<String> = calls
        .lock()
        .unwrap()
        .iter()
        .map(Value::to_string)
        .collect();
    // The failed background result reached the model.
    assert!(
        requests
            .iter()
            .any(|body| body.contains("<task_notification id=") && body.contains("status=\\\"failed\\\"")),
        "the failed test result must reach the original thread"
    );
    // The steer entered history once and right after the fix's tool result.
    let first_steer = requests
        .iter()
        .position(|body| body.contains(DEMO_STEER))
        .expect("the steer reached the model");
    assert_eq!(requests[first_steer].matches(DEMO_STEER).count(), 1);
    assert!(requests[first_steer].contains("FIXED"));
    for body in &requests[first_steer..] {
        assert_eq!(body.matches(DEMO_STEER).count(), 1, "{body}");
    }
    server.shutdown();
    drop(fixture);
}
