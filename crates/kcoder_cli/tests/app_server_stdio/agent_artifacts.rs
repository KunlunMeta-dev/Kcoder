#[test]
fn initialize_advertises_agent_artifact_read_capability() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["agentArtifactsV1"],
        true
    );
    server.shutdown();
}

#[test]
fn agent_artifact_read_requires_an_active_thread() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "agent/artifact/read",
        "params": {"threadId": "thread-not-started", "agentId": "agent-1"}
    }));
    let response = server.response(2);
    assert_eq!(response["error"]["code"], -32024, "{response}");
    server.shutdown();
}

#[test]
fn agent_artifact_read_rejects_unknown_agents_without_echoing_paths() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}
    }));
    let started = server.response(2);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let smuggled = temp.path().join("smuggled-report.md");
    std::fs::write(&smuggled, b"secret").unwrap();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "agent/artifact/read",
        "params": {
            "threadId": thread_id,
            "agentId": "missing-agent",
            "path": smuggled.to_string_lossy()
        }
    }));
    let response = server.response(3);
    assert_eq!(response["error"]["code"], -32026, "{response}");
    let message = response["error"]["message"].as_str().unwrap();
    assert!(!message.contains("smuggled-report.md"), "{message}");
    assert!(
        message.contains("does not belong to this thread"),
        "{message}"
    );
    server.shutdown();
}

#[test]
fn child_conversation_stdio_streams_deltas_tools_and_exact_user_receipts_before_completion() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .scenario("subagent-trace")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("45")
        .followup_stream_delay_ms("0")
        .text_chunk_chars(24)
        .discard_stderr()
        .spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["agentConversationStreamV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":"APP_SERVER_LIVE_STEER_LAB start a background child"}]}}));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");
    let deadline = Instant::now() + Duration::from_secs(30);
    let agent_id = loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "item/event"
            && frame["params"]["event"]["type"] == "background_job_associated"
        {
            break frame["params"]["event"]["id"].as_str().unwrap().to_owned();
        }
    };
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"agent/stream/subscribe","params":{"threadId":thread_id,"agentId":agent_id,"subscriptionId":"live-view"}}));
    let response = server.response(4);
    assert!(response.get("error").is_none(), "{response}");
    let mut sequence = response["result"]["sequence"].as_u64().unwrap();
    let run_id = response["result"]["runId"].as_str().unwrap().to_owned();
    assert_eq!(response["result"]["active"], true);
    let mut tool_completed = false;
    let mut text_deltas = Vec::new();
    let mut applied_user = None;
    let mut receipt = None;
    let mut steer_sent = false;
    loop {
        let frame = server.next_value(deadline);
        if frame["id"] == 5 {
            receipt = Some(frame["result"].clone());
            continue;
        }
        if frame["method"] == "agent/stream/reset"
            && frame["params"]["subscriptionId"] == "live-view"
        {
            sequence = frame["params"]["sequence"].as_u64().unwrap();
            continue;
        }
        if frame["method"] != "agent/stream/event"
            || frame["params"]["subscriptionId"] != "live-view"
        {
            continue;
        }
        let event = &frame["params"];
        assert_eq!(event["threadId"], thread_id);
        assert_eq!(event["agentId"], agent_id);
        assert_eq!(event["runId"], run_id);
        assert_eq!(event["sequence"].as_u64().unwrap(), sequence + 1);
        sequence += 1;
        assert!(event["occurredAtMs"].as_u64().unwrap() > 0);
        assert!(!event.to_string().contains("tui-dev-signature"));
        let item = &event["params"]["item"];
        if event["method"] == "item/completed" && item["type"] == "toolCall" {
            assert!(item["output"].is_string());
            tool_completed = true;
            if !steer_sent {
                steer_sent = true;
                server.send(json!({"jsonrpc":"2.0","id":5,"method":"agent/steer","params":{"threadId":thread_id,"agentId":agent_id,"message":"APP_SERVER_TARGETED_STEER_SENTINEL","clientMessageId":"stream-client-command"}}));
            }
        }
        if event["method"] == "item/started"
            && item["type"] == "userMessage"
            && item["clientMessageId"] == "stream-client-command"
        {
            assert_eq!(item["text"], "APP_SERVER_TARGETED_STEER_SENTINEL");
            assert_eq!(item["message"]["clientMessageId"], "stream-client-command");
            assert!(
                applied_user.is_none(),
                "one user receipt must yield one visible message"
            );
            applied_user = Some(item["id"].as_str().unwrap().to_owned());
        }
        if event["method"] == "item/delta" {
            let delta = event["params"]["delta"]["text"].as_str().unwrap();
            assert!(
                delta.chars().count() <= 24,
                "only the new token chunk belongs in a delta"
            );
            text_deltas.push(delta.to_owned());
        }
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "completed");
            break;
        }
    }
    assert!(
        tool_completed,
        "tools must complete before the whole child conversation"
    );
    assert!(
        text_deltas.len() > 1,
        "text must be delivered incrementally before completion"
    );
    assert!(
        text_deltas
            .concat()
            .contains("tui-lab-subagent-worker-done")
    );
    let receipt = receipt.expect("steer response must be delivered");
    assert_eq!(applied_user.as_deref(), receipt["messageId"].as_str());
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"agent/stream/unsubscribe","params":{"subscriptionId":"live-view"}}));
    assert!(server.response(6).get("error").is_none());
    server.shutdown();
}

fn child_stop_fixture_tool(socket: &mut std::net::TcpStream, name: &str, input: Value, id: &str) {
    let delta = json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    let body = format!("data: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
}
fn child_stop_fixture_spawn(socket: &mut std::net::TcpStream) {
    child_stop_fixture_tool(
        socket,
        "spawn_agent",
        json!({"agent_type":"general","message":"STOP_SUBAGENT_QUESTION","max_turns":4,"run_in_background":true}),
        "spawn-stop-child",
    );
}
fn child_stop_fixture_question(socket: &mut std::net::TcpStream) {
    child_stop_fixture_tool(
        socket,
        "AskUserQuestion",
        json!({"questions":[{"header":"Stop fixture","question":"STOP_PENDING_CHILD_QUESTION","options":[{"label":"Proceed","description":"Complete the fixture."},{"label":"Hold","description":"Keep this question pending."}]}]}),
        "pending-child-question",
    );
}

#[test]
fn child_stop_stdio_confirms_cleanup_of_actual_pending_source_question() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    let (endpoint, _calls, provider) = serving_fixture_decided(|_, request| {
        let messages = request["messages"].as_array().unwrap();
        let worker = messages.iter().any(|message| {
            message["role"] == "user"
                && message["content"]
                    .to_string()
                    .contains("STOP_SUBAGENT_QUESTION")
        });
        if worker {
            FixtureAnswer::Custom(child_stop_fixture_question)
        } else if messages.iter().any(|message| message["role"] == "tool") {
            FixtureAnswer::Text("parent done".into())
        } else {
            FixtureAnswer::Custom(child_stop_fixture_spawn)
        }
    });
    write_fixture_provider_settings(&settings, &endpoint);
    let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    config["permission_mode"] = json!("bypass");
    config["tools"] = json!({"profile":"full"});
    std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    let stderr = server.child.stderr.take().unwrap();
    let log = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[stop fixture] {line}");
        }
    });
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":"start a background worker with a pending question"}]}}));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut parent_completed = false;
    let source = loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "turn/completed" {
            parent_completed = true;
        }
        if frame["method"] == "question/request"
            && frame["params"]["questions"]
                .to_string()
                .contains("STOP_PENDING_CHILD_QUESTION")
        {
            break frame["params"]["sourceAgent"].clone();
        }
    };
    while !parent_completed {
        let frame = server.next_value(deadline);
        parent_completed = frame["method"] == "turn/completed";
    }
    let agent_id = source["agentId"].as_str().unwrap().to_owned();
    let run = source["backgroundRun"].clone();
    assert_eq!(run["parentSessionId"], thread_id);
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"agent/stream/subscribe","params":{"threadId":thread_id,"agentId":agent_id,"subscriptionId":"stop-view"}}));
    assert_eq!(server.response(4)["result"]["active"], true);
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"agent/stop","params":{"threadId":thread_id,"agentId":agent_id,"expectedBackgroundRun":run}}));
    let stopped = server.response(5);
    server.send(
        json!({"jsonrpc":"2.0","id":6,"method":"agent/list","params":{"threadId":thread_id}}),
    );
    let listed = server.response(6);
    let agent = listed["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == agent_id)
        .unwrap()
        .clone();
    assert_eq!(
        agent["status"], "cancelled",
        "stop: {stopped}, task: {agent}"
    );
    assert_eq!(agent["acceptingMessages"], false);
    assert_eq!(agent["queueDepth"], 0);
    assert_eq!(stopped["result"]["status"], "stopped", "{stopped}");
    assert_eq!(stopped["result"]["stopped"], true);
    server.shutdown();
    log.join().unwrap();
    provider.join().unwrap();
}
