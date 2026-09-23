// Protocol regression: the deterministic provider ends its answer without
// update_goal. The runtime must schedule a bounded completion-audit turn.
#[test]
fn active_goal_continues_after_an_answer_without_a_completion_tool() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["goal_max_auto_continuations"] = json!(1);
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .stream_delay_ms("1")
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"thread/goal/set","params":{"threadId":thread,"objective":"Finish and verify the fixture"}}));
    assert!(server.response(3).get("error").is_none());
    std::thread::sleep(Duration::from_millis(650));
    server.send(
        json!({"jsonrpc":"2.0","id":4,"method":"thread/goal/get","params":{"threadId":thread}}),
    );
    assert_eq!(server.response(4)["result"]["goal"]["turnCount"], 0);
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Complete the fixture"}]}}));
    assert!(server.response(5).get("error").is_none());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut completed = 0;
    while completed < 2 {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed");
            completed += 1;
        }
    }
    std::thread::sleep(Duration::from_millis(650));
    server.send(
        json!({"jsonrpc":"2.0","id":6,"method":"thread/goal/get","params":{"threadId":thread}}),
    );
    let goal = server.response(6)["result"]["goal"].clone();
    assert_eq!(goal["turnCount"], 1);
    assert_eq!(
        goal["status"], "active",
        "A final answer must not fabricate goal completion"
    );
    server
        .send(json!({"jsonrpc":"2.0","id":7,"method":"thread/read","params":{"threadId":thread}}));
    let transcript = server.response(7);
    assert!(
        !transcript
            .to_string()
            .contains("Continue working toward the active")
    );
    server.shutdown_successfully();
}

#[test]
fn goal_pause_clear_and_owner_suspend_disarm_automatic_turns() {
    for action in ["pause", "clear", "suspend"] {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("settings.json");
        write_test_settings(&settings);
        let mut server = TestAppServer::builder(temp.path(), &settings)
            .stream_delay_ms("1")
            .spawn();
        server.initialize(1);
        server.send(json!({"id":2,"method":"thread/start","params":{}}));
        let thread = server.response(2)["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        server.send(json!({"id":3,"method":"thread/goal/set","params":{"threadId":thread,"objective":"Pending audit"}}));
        assert!(server.response(3).get("error").is_none());
        server.send(json!({"id":4,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Start the fixture"}]}}));
        assert!(server.response(4).get("error").is_none());
        server.wait_for_method("turn/completed");
        let (method, params) = match action {
            "pause" => (
                "thread/goal/set",
                json!({"threadId":thread,"status":"paused"}),
            ),
            "clear" => ("thread/goal/clear", json!({"threadId":thread})),
            _ => ("thread/automation/suspend", json!({"threadId":thread})),
        };
        server.send(json!({"id":5,"method":method,"params":params}));
        assert!(server.response(5).get("error").is_none(), "{action}");
        std::thread::sleep(Duration::from_millis(850));
        server.send(json!({"id":6,"method":"thread/goal/get","params":{"threadId":thread}}));
        let goal = server.response(6)["result"]["goal"].clone();
        if action == "clear" {
            assert!(goal.is_null());
        } else {
            // The initial user turn counts; pausing must prevent any continuation.
            assert_eq!(goal["turnCount"], 1, "{action}");
            assert_eq!(
                goal["status"],
                if action == "pause" {
                    "paused"
                } else {
                    "active"
                }
            );
        }
        server.shutdown_successfully();
    }
}

#[test]
fn goal_pro_uses_the_same_bounded_continuation_without_bypassing_verification() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["goal_max_auto_continuations"] = json!(1);
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .stream_delay_ms("1")
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"thread/goal/set","params":{"threadId":thread,"objective":"Verify an answer","mode":"strict","verificationKind":"answer"}}));
    let created = server.response(3);
    assert!(created.get("error").is_none(), "{created}");
    server.send(json!({"id":4,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Inspect the fixture"}]}}));
    assert!(server.response(4).get("error").is_none());
    server.wait_for_method("turn/completed");
    server.wait_for_method("turn/completed");
    server.send(json!({"id":5,"method":"thread/goal/get","params":{"threadId":thread}}));
    let goal = server.response(5)["result"]["goal"].clone();
    assert_eq!(goal["mode"], "strict");
    assert_eq!(goal["turnCount"], 1);
    assert_eq!(goal["status"], "active");
    server.send(
        json!({"id":6,"method":"thread/goal/set","params":{"threadId":thread,"status":"complete"}}),
    );
    assert!(
        server.response(6).get("error").is_some(),
        "RPC must not bypass the verifier"
    );
    server.send(json!({"id":7,"method":"thread/goal/clear","params":{"threadId":thread}}));
    assert_eq!(server.response(7)["result"]["cleared"], true);
    server.shutdown_successfully();
}
