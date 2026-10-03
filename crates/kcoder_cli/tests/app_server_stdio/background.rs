#[test]
fn background_subagent_lifecycle_is_forwarded_and_thread_rotation_remains_usable() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "subagent-trace", "10", "500", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "app-server-background-subagent"}]}
    }));
    let turn_response = server.response(3);
    assert_eq!(turn_response["result"]["turn"]["status"], "running");
    let original_turn_id = turn_response["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut job_id = None::<String>;
    let mut lifecycle = Vec::new();
    let mut event_index = 0usize;
    let mut parent_completed_at = None;
    let mut background_completed_at = None;
    let mut followup_turn_id = None::<String>;
    let mut followup_started = 0usize;
    let mut followup_completed = 0usize;
    let mut followup_text = String::new();
    while background_completed_at.is_none()
        || parent_completed_at.is_none()
        || followup_completed == 0
        || !followup_text.contains("subagent completion notification observed")
    {
        let value = server.next_value(deadline);
        event_index += 1;
        if value["method"] == "turn/started"
            && value["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            followup_started += 1;
            followup_turn_id = value["params"]["turn"]["id"].as_str().map(str::to_string);
        }
        if value["method"] == "turn/completed" {
            let completed_turn_id = value["params"]["turn"]["id"].as_str();
            if completed_turn_id == Some(original_turn_id.as_str()) {
                parent_completed_at = Some(event_index);
            }
            if completed_turn_id == followup_turn_id.as_deref() {
                followup_completed += 1;
            }
        }
        if value["method"] == "item/delta"
            && value["params"]["turnId"].as_str() == followup_turn_id.as_deref()
            && let Some(text) = value["params"]["delta"]["text"].as_str()
        {
            followup_text.push_str(text);
        }
        if value["method"] != "item/event" {
            continue;
        }
        let event = &value["params"]["event"];
        let event_type = event["type"].as_str().unwrap_or_default();
        if event_type == "background_job_associated" {
            job_id = event["id"].as_str().map(str::to_string);
            let id = job_id
                .as_deref()
                .expect("associated background job must have an ID");
            assert_eq!(id.len(), 5, "{id}");
            assert!(id.bytes().all(|byte| byte.is_ascii_alphanumeric()), "{id}");
        }
        if job_id.as_deref() == event["id"].as_str()
            && matches!(
                event_type,
                "background_job_associated"
                    | "background_job_progress"
                    | "background_job_completed"
            )
        {
            assert_eq!(value["params"]["threadId"], thread_id);
            assert_eq!(value["params"]["turnId"], original_turn_id);
            lifecycle.push(event_type.to_string());
            if event_type == "background_job_completed" {
                background_completed_at = Some(event_index);
            }
        }
    }
    let associated = lifecycle
        .iter()
        .position(|event| event == "background_job_associated")
        .unwrap();
    let progress = lifecycle
        .iter()
        .position(|event| event == "background_job_progress")
        .unwrap();
    let completed = lifecycle
        .iter()
        .position(|event| event == "background_job_completed")
        .unwrap();
    assert!(
        associated < progress && progress < completed,
        "{lifecycle:?}"
    );
    assert_eq!(
        lifecycle
            .iter()
            .filter(|event| *event == "background_job_completed")
            .count(),
        1
    );
    assert!(
        parent_completed_at.unwrap() < background_completed_at.unwrap(),
        "父轮必须先完成，迟到的后台终态仍应路由到原父轮"
    );
    assert_eq!(followup_started, 1);
    assert_eq!(followup_completed, 1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 100}
    }));
    let transcript = loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/started"
            && value["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            followup_started += 1;
        }
        if value["method"] == "turn/completed"
            && value["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            followup_completed += 1;
        }
        if value["id"] == 4 {
            break value;
        }
    };
    assert_eq!(followup_started, 1, "自动聚合轮不得重复启动");
    assert_eq!(followup_completed, 1, "自动聚合轮不得重复完成");
    assert!(
        !transcript
            .to_string()
            .contains("[system] All tracked background sub-agents have finished."),
        "内部聚合提示不得暴露到 thread/read"
    );

    server.send(json!({"jsonrpc": "2.0", "id": 5, "method": "thread/start", "params": {}}));
    assert!(server.response(5)["result"]["thread"]["id"].is_string());
    server.shutdown();
}

#[test]
fn running_subagent_can_be_steered_through_typed_app_server_rpc() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "subagent-trace", "10", "1500", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [{"type": "text", "text": "APP_SERVER_LIVE_STEER_LAB start steerable background subagent"}]
        }
    }));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");

    let deadline = Instant::now() + Duration::from_secs(30);
    let agent_id = loop {
        let value = server.next_value(deadline);
        if value["method"] == "item/event"
            && value["params"]["event"]["type"] == "background_job_associated"
        {
            break value["params"]["event"]["id"].as_str().unwrap().to_string();
        }
    };

    // Do not merely steer between registration and the child's first request:
    // require an in-flight response, then verify delivery at the next safe boundary.
    loop {
        let value = server.next_value(deadline);
        let event = &value["params"]["event"];
        if value["method"] == "item/event"
            && event["type"] == "background_job_progress"
            && event["id"] == agent_id
            && event["message"] == "Receiving model response"
        {
            break;
        }
    }

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 31,
        "method": "agent/list",
        "params": { "threadId": thread_id }
    }));
    let listed = server.response(31);
    let listed_agent = listed["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == agent_id)
        .expect("running target must be queryable after reconnect");
    assert_eq!(listed_agent["status"], "running");
    assert!(listed_agent.get("message").is_none());

    // The steering phase needs its own budget: the scenario waits for the
    // sub-agent to pick up the queued message, which is slower than reaching the
    // listing above.
    let deadline = Instant::now() + Duration::from_secs(60);
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "agent/steer",
        "params": {
            "threadId": thread_id,
            "agentId": agent_id,
            "message": "APP_SERVER_TARGETED_STEER_SENTINEL",
            "clientMessageId": "client-steer-1"
        }
    }));

    let mut response_index = None;
    let mut applied_index = None;
    let mut response = None;
    let mut applied = None;
    let mut index = 0usize;
    while response.is_none() || applied.is_none() {
        let value = server.next_value(deadline);
        index += 1;
        if value["id"] == 4 {
            response_index = Some(index);
            response = Some(value);
        } else if value["method"] == "agent/steer/applied" && value["params"]["agentId"] == agent_id
        {
            applied_index = Some(index);
            applied = Some(value);
        }
    }
    let response = response.unwrap();
    assert_eq!(response["result"]["status"], "queued_live");
    assert_eq!(response["result"]["queued"], true);
    assert_eq!(response["result"]["clientMessageId"], "client-steer-1");
    let message_id = response["result"]["messageId"].as_str().unwrap();
    let applied = applied.unwrap();
    assert_eq!(applied["params"]["threadId"], thread_id);
    assert_eq!(applied["params"]["messageId"], message_id);
    assert_eq!(applied["params"]["clientMessageId"], "client-steer-1");
    assert!(applied["params"].get("message").is_none());
    assert!(
        response_index.unwrap() < applied_index.unwrap(),
        "queued response must be observable before the applied notification"
    );
    server.shutdown();
}

#[test]
fn automatic_followup_serializes_thread_start_and_both_resume_paths() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start_scenario(
        temp.path(),
        &settings,
        "subagent-trace",
        "10",
        "300",
        "1000",
    );
    server.initialize(1);

    // Persist a non-current thread first to cover final rechecking inside the Persisted resume gate.
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let persisted_thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": persisted_thread_id, "input": [{"type": "text", "text": "prepare persisted thread"}]}
    }));
    let persisted_turn_id = server.response(3)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/completed" && value["params"]["turn"]["id"] == persisted_turn_id
        {
            break;
        }
    }
    server.send(json!({
        "jsonrpc": "2.0", "id": 40, "method": "thread/read",
        "params": {"threadId": persisted_thread_id, "limit": 100}
    }));
    let baseline_model = server.response(40)["result"]["thread"]["model"].clone();

    server.send(json!({"jsonrpc": "2.0", "id": 4, "method": "thread/start", "params": {}}));
    let current_thread_id = server.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": current_thread_id, "input": [{"type": "text", "text": "app-server-background-subagent"}]}
    }));
    server.response(5);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/started"
            && value["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            break;
        }
    }

    // Automatic follow-up occupies only the current resident runtime. Other threads
    // remain creatable/selectable, while resuming the current thread may only change selection and cannot replace running state.
    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/start",
        "params": {}
    }));
    let concurrent_thread = server.response(6);
    assert!(concurrent_thread["result"]["thread"]["id"].is_string());
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/resume",
        "params": {"threadId": current_thread_id}
    }));
    assert_eq!(
        server.response(7)["result"]["thread"]["id"],
        current_thread_id
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "thread/resume",
        "params": {"threadId": persisted_thread_id}
    }));
    assert_eq!(
        server.response(8)["result"]["thread"]["id"],
        persisted_thread_id
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "thread/read",
        "params": {"threadId": current_thread_id, "limit": 100}
    }));
    assert_eq!(
        server.response(9)["result"]["thread"]["model"],
        baseline_model,
        "并发 thread/start 不得污染正在运行的自动聚合轮模型"
    );
    server.shutdown();
}

#[test]
fn disconnect_cancels_background_event_pump_and_active_turn_within_bound() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "subagent-trace", "10", "1000", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "app-server-background-subagent"}]}
    }));
    server.response(3);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "item/event"
            && value["params"]["event"]["type"] == "background_job_associated"
        {
            break;
        }
    }
    server.shutdown();
}

#[test]
fn shorten_wait_without_an_active_turn_reports_false() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "subagent-trace", "10", "500", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "turn/shorten_wait", "params": {}}));
    let response = server.response(2);
    assert_eq!(response["result"]["shortened"], false);
    server.shutdown();
}

#[test]
fn shorten_wait_preserves_the_active_turn_for_a_following_interrupt() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "subagent-trace", "10", "500", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "app-server-background-subagent"}]}
    }));
    let turn_id = server.response(3)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The shorten request must reach the running engine while the turn is
    // still active.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/shorten_wait",
        "params": {"threadId": thread_id, "turnId": turn_id}
    }));
    assert_eq!(server.response(4)["result"]["shortened"], true);

    // Peek, not take: the active-turn record must survive the shorten request,
    // so a following ESC-stage-two interrupt still matches the same turn.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/interrupt",
        "params": {"threadId": thread_id, "turnId": turn_id}
    }));
    let interrupted = server.response(5);
    assert_eq!(
        interrupted["result"]["interrupted"], true,
        "interrupt must still match after a shorten request: {interrupted}"
    );
    server.shutdown();
}
