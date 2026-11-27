#[test]
fn exact_native_agent_stdio_observes_original_run_and_rejects_foreign_selectors() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .scenario("subagent-trace")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("25")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"exact-native-agent","version":"1"},
            "capabilities":{"experimental":{"agentExactRunV1":true}}
        }}),
    );
    let initialized = server.response(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["agentExactRunV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
        "threadId":thread,"input":[{"type":"text","text":"app-server-background-subagent original native run"}]
    }}));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");
    let deadline = Instant::now() + Duration::from_secs(30);
    let agent = loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "item/event"
            && frame["params"]["event"]["type"] == "background_job_associated"
        {
            break frame["params"]["event"]["id"].as_str().unwrap().to_owned();
        }
    };
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"agent/list","params":{"threadId":thread}}));
    let listed = server.response(4);
    let native = listed["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == agent)
        .expect("actual spawned agent")["backgroundRun"]
        .clone();
    assert_eq!(native["parentSessionId"], thread);
    assert_eq!(native["agentId"], agent);
    assert!(native["runId"].as_str().is_some_and(|run| !run.is_empty()));
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"agent/stream/subscribe","params":{
        "threadId":thread,"agentId":agent,"subscriptionId":"original-exact-observer","expectedBackgroundRun":native
    }}));
    let subscribed = server.response(5);
    assert!(subscribed.get("error").is_none(), "{subscribed}");
    assert_eq!(subscribed["result"]["runId"], native["runId"]);
    // A retained completed stream and an active stream obey the same original-run fence.
    if subscribed["result"]["active"] == true {
        loop {
            let frame = server.next_value(deadline);
            if frame["method"] == "agent/stream/event"
                && frame["params"]["subscriptionId"] == "original-exact-observer"
            {
                assert_eq!(frame["params"]["threadId"], thread);
                assert_eq!(frame["params"]["agentId"], agent);
                assert_eq!(frame["params"]["runId"], native["runId"]);
                if frame["params"]["method"] == "turn/completed" {
                    break;
                }
            }
        }
    }
    server.send(
        json!({"jsonrpc":"2.0","id":6,"method":"agent/live/read","params":{
            "threadId":thread,"agentId":agent,"expectedBackgroundRun":native
        }}),
    );
    let live = server.response(6);
    assert!(live.get("error").is_none(), "{live}");
    assert_eq!(live["result"]["backgroundRun"], native);
    assert_eq!(live["result"]["active"], false);
    assert!(
        live["result"]["content"]
            .as_str()
            .unwrap()
            .contains("tui-lab-subagent-worker-done"),
        "{live}"
    );
    server.send(
        json!({"jsonrpc":"2.0","id":7,"method":"agent/artifact/read","params":{
            "threadId":thread,"agentId":agent,"expectedBackgroundRun":native
        }}),
    );
    let artifact = server.response(7);
    assert!(artifact.get("error").is_none(), "{artifact}");
    assert_eq!(artifact["result"]["backgroundRun"], native);
    assert!(
        std::path::Path::new(artifact["result"]["path"].as_str().unwrap()).ends_with(
            std::path::Path::new("runs")
                .join(native["runId"].as_str().unwrap())
                .join("output.md")
        )
    );
    for (index, method) in [
        "agent/live/read",
        "agent/artifact/read",
        "agent/stream/subscribe",
    ]
    .iter()
    .enumerate()
    {
        let mut foreign = native.clone();
        foreign["runId"] = json!(format!("{}-other", native["runId"].as_str().unwrap()));
        let mut params = json!({"threadId":thread,"agentId":agent,"expectedBackgroundRun":foreign});
        if *method == "agent/stream/subscribe" {
            params["subscriptionId"] = json!("wrong-run-observer");
        }
        let id = 8 + index as i64;
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let denied = server.response(id);
        assert_eq!(denied["error"]["code"], -32038, "{denied}");
        assert!(
            denied.get("result").is_none(),
            "a rejected selector returned another run: {denied}"
        );
    }
    // Omitting the new selector remains a supported legacy wire shape.
    server.send(
        json!({"jsonrpc":"2.0","id":11,"method":"agent/stream/subscribe","params":{
            "threadId":thread,"agentId":agent,"subscriptionId":"legacy-observer"
        }}),
    );
    let legacy = server.response(11);
    assert!(legacy.get("error").is_none(), "{legacy}");
    assert_eq!(legacy["result"]["runId"], native["runId"]);
    server.shutdown();
}

#[test]
fn exact_native_member_commands_queue_once_and_stop_only_the_original_run() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .scenario("subagent-trace")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("500")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"exact-member-commands","version":"1"},
        "capabilities":{"experimental":{"agentExactControlV1":true,"agentExactRunV1":true}}
    }}));
    assert_eq!(
        server.response(1)["result"]["capabilities"]["experimental"]["agentExactControlV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
        "threadId":thread,"input":[{"type":"text","text":"app-server-background-subagent exact member commands"}]
    }}));
    assert_eq!(server.response(3)["result"]["turn"]["status"], "running");
    let deadline = Instant::now() + Duration::from_secs(45);
    let agent = loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "item/event"
            && frame["params"]["event"]["type"] == "background_job_associated"
        {
            break frame["params"]["event"]["id"].as_str().unwrap().to_owned();
        }
    };
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"agent/list","params":{"threadId":thread}}));
    let listing = server.response(4);
    let run = listing["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == agent)
        .unwrap()["backgroundRun"]
        .clone();
    let mut other = run.clone();
    other["runId"] = json!("not-the-selected-run");
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"agent/steer","params":{
        "threadId":thread,"agentId":agent,"message":"wrong run must not enqueue","clientMessageId":"cmd:0:wrong","expectedBackgroundRun":other
    }}));
    let wrong = server.response(5);
    assert_eq!(wrong["result"]["status"], "rejected", "{wrong}");
    assert_eq!(wrong["result"]["reasonCode"], "subagent_run_changed");
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"agent/steer","params":{
        "threadId":thread,"agentId":agent,"message":"bounded original instruction","clientMessageId":"cmd:0:exact","expectedBackgroundRun":run
    }}));
    let accepted = server.response(6);
    assert_eq!(accepted["result"]["queued"], true, "{accepted}");
    assert_eq!(accepted["result"]["expectedBackgroundRun"], run);
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"agent/steer","params":{
        "threadId":thread,"agentId":agent,"message":"bounded original instruction","clientMessageId":"cmd:0:exact","expectedBackgroundRun":run
    }}));
    let duplicate = server.response(7);
    assert_eq!(
        duplicate["result"]["messageId"],
        accepted["result"]["messageId"]
    );
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"agent/message/read","params":{
        "threadId":thread,"agentId":agent,"clientMessageId":"cmd:0:exact","expectedBackgroundRun":run
    }}));
    let receipt = server.response(8);
    assert_eq!(
        receipt["result"]["receipt"]["backgroundRun"], run,
        "{receipt}"
    );
    assert_eq!(
        receipt["result"]["receipt"]["messageId"],
        accepted["result"]["messageId"]
    );
    server.send(
        json!({"jsonrpc":"2.0","id":9,"method":"agent/stop","params":{
            "threadId":thread,"agentId":agent,"expectedBackgroundRun":other
        }}),
    );
    assert!(server.response(9).get("error").is_some());
    server.send(
        json!({"jsonrpc":"2.0","id":10,"method":"agent/stop","params":{
            "threadId":thread,"agentId":agent,"expectedBackgroundRun":run
        }}),
    );
    let stopped = server.response(10);
    assert_eq!(stopped["result"]["expectedBackgroundRun"], run);
    assert_eq!(stopped["result"]["stopped"], true, "{stopped}");
    server.shutdown();
}

#[test]
fn legacy_agent_capabilities_do_not_enable_exact_member_commands() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(root.path(), &settings);
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"agent/steer","params":{
        "threadId":"missing-parent","agentId":"missing-member","message":"no effect","clientMessageId":"cmd:0:no-effect",
        "expectedBackgroundRun":{"parentSessionId":"missing-parent","agentId":"missing-member","runId":"missing-run"}
    }}));
    assert_eq!(
        server.response(2)["error"]["message"],
        "agent_exact_control_unavailable"
    );
    server.shutdown();
}

#[test]
fn original_completed_member_continuation_keeps_one_command_and_one_replacement_run() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .scenario("subagent-trace")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("1")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"original-member-continuation","version":"1"},
        "capabilities":{"experimental":{"agentExactControlV1":true,"agentExactContinuationV1":true}}
    }}));
    assert_eq!(
        server.response(1)["result"]["capabilities"]["experimental"]["agentExactContinuationV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
        "threadId":thread,"input":[{"type":"text","text":"app-server-background-subagent continuation receipt"}]
    }}));
    server.response(3);
    let deadline = Instant::now() + Duration::from_secs(40);
    let agent = loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "item/event"
            && frame["params"]["event"]["type"] == "background_job_associated"
        {
            break frame["params"]["event"]["id"].as_str().unwrap().to_owned();
        }
    };
    let mut request = 10;
    let old = loop {
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"agent/list","params":{"threadId":thread}}));
        let list = server.response(request);
        request += 1;
        if let Some(item) = list["result"]["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["agentId"] == agent && item["status"] == "completed")
        {
            break item.clone();
        }
        assert!(
            Instant::now() < deadline,
            "original member did not complete"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let original = old["backgroundRun"].clone();
    let message = json!({"threadId":thread,"agentId":agent,"message":"continue the original member once",
        "clientMessageId":"cmd:0:single-continuation","expectedBackgroundRun":original});
    server.send(json!({"jsonrpc":"2.0","id":request,"method":"agent/continue","params":message}));
    let accepted = server.response(request);
    request += 1;
    assert_eq!(accepted["result"]["queued"], true, "{accepted}");
    assert_eq!(accepted["result"]["expectedBackgroundRun"], original);
    server.send(
        json!({"jsonrpc":"2.0","id":request,"method":"agent/list","params":{"threadId":thread}}),
    );
    let current = server.response(request);
    request += 1;
    let replacement = current["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == agent)
        .unwrap()
        .clone();
    assert_ne!(replacement["backgroundRun"], original);
    server.send(json!({"jsonrpc":"2.0","id":request,"method":"agent/continue","params":message}));
    let duplicate = server.response(request);
    request += 1;
    assert_eq!(
        duplicate["result"]["messageId"], accepted["result"]["messageId"],
        "{duplicate}"
    );
    server.send(
        json!({"jsonrpc":"2.0","id":request,"method":"agent/list","params":{"threadId":thread}}),
    );
    let after = server.response(request);
    request += 1;
    let same = after["result"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agentId"] == agent)
        .unwrap();
    assert_eq!(same["backgroundRun"], replacement["backgroundRun"]);
    assert_eq!(same["retainedRuns"], replacement["retainedRuns"]);
    server.send(json!({"jsonrpc":"2.0","id":request,"method":"agent/message/read","params":{
        "threadId":thread,"agentId":agent,"clientMessageId":"cmd:0:single-continuation","expectedBackgroundRun":original
    }}));
    let observed = server.response(request);
    assert_eq!(observed["result"]["receipt"]["backgroundRun"], original);
    server.shutdown();
}
