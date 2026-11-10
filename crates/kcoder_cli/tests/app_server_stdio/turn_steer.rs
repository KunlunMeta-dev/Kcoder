// Lean plan M1-2: `turn/steer` adds user input to the running main-thread turn.
// The text must reach the very next provider request exactly once, after the
// running tool batch, and the client must see `turn/steer/applied`.

#[test]
fn a_steer_reaches_the_next_provider_request_exactly_once() {
    const STEER: &str = "STEER_USE_THE_STAGING_DATABASE";
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (endpoint, calls, fixture) = serving_fixture_decided(|index, _request| {
        if index == 0 {
            return FixtureAnswer::Tool {
                id: "steer-wait-call".into(),
                name: "bash".into(),
                input: json!({
                    // Keep the tool batch open until the steer was accepted.
                    "command": "n=0; while [ ! -e .steer-sent ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done; echo TOOL_DONE",
                    "description": "wait for the steer"
                }),
            };
        }
        FixtureAnswer::Text("STEER_ACKNOWLEDGED".into())
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

    // No turn is running yet: nothing is recorded and the client must start one.
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/steer",
        "params": {"threadId": thread_id.clone(), "text": "too early"}
    }));
    assert_eq!(server.response(3)["result"]["status"], "no_active_turn");

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "run the slow step"}]}
    }));
    let started = server.response(4);
    assert!(started.get("error").is_none(), "{started}");
    let turn_id = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The mailbox opens when the turn stream starts; retry until it accepts.
    let mut request_id = 10;
    let accept_deadline = Instant::now() + Duration::from_secs(20);
    let steer_id = loop {
        server.send(json!({
            "jsonrpc": "2.0", "id": request_id, "method": "turn/steer",
            "params": {"threadId": thread_id.clone(), "turnId": turn_id.clone(), "text": STEER, "clientMessageId": "client-steer-1"}
        }));
        let reply = server.response(request_id);
        let result = &reply["result"];
        if result["status"] == "queued" {
            assert_eq!(result["turnId"], turn_id, "{reply}");
            break result["steerId"].as_u64().expect("queued steer has an id");
        }
        assert!(
            Instant::now() < accept_deadline,
            "the running turn never accepted the steer: {reply}"
        );
        request_id += 1;
        std::thread::sleep(Duration::from_millis(50));
    };
    std::fs::write(workspace.join(".steer-sent"), b"sent").unwrap();

    let deadline = Instant::now() + Duration::from_secs(40);
    let mut applied = 0usize;
    loop {
        let event = server.next_value(deadline);
        assert_ne!(event["method"], "turn/steer/dropped", "{event}");
        if event["method"] == "turn/steer/applied" {
            assert_eq!(event["params"]["steerId"].as_u64(), Some(steer_id), "{event}");
            assert_eq!(event["params"]["clientMessageId"], "client-steer-1");
            applied += 1;
        }
        if event["method"] == "turn/completed"
            && event["params"]["turn"]["id"].as_str() == Some(turn_id.as_str())
        {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    assert_eq!(applied, 1, "the steer is settled exactly once");

    let requests = calls.lock().unwrap().clone();
    assert!(requests.len() >= 2, "a follow-up provider request is required");
    assert!(!requests[0].to_string().contains(STEER));
    let next = requests[1].to_string();
    assert_eq!(next.matches(STEER).count(), 1, "{next}");
    // The steer follows the complete tool result, never splitting the pair.
    let tool_result = next.find("TOOL_DONE").expect("tool result in next request");
    assert!(next.find(STEER).unwrap() > tool_result, "{next}");
    for later in &requests[2..] {
        assert!(later.to_string().matches(STEER).count() <= 1);
    }
    server.shutdown();
    drop(fixture);
}
