// Real model transport -> dedicated MCP -> private widget -> typed host read.
#[cfg(unix)]
fn mcp_apps_chart_model_call(socket: &mut std::net::TcpStream) {
    let call = json!({"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"mcp-chart-call","type":"function","function":{"name":"mcp__owned-server__chart","arguments":"{}"}}]},"finish_reason":null}]});
    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    let body = format!("data: {call}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
}
#[cfg(unix)]
fn mcp_apps_fixture_settings(path: &std::path::Path, endpoint: &str, directory: &std::path::Path) {
    write_fixture_provider_settings(path, endpoint);
    let mut settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let script = std::path::Path::new(env!("KCODER_WORKSPACE_ROOT"))
        .join("crates/kcoder_mcp/tests/fixtures/apps_server.py");
    settings["permission_mode"] = json!("bypass");
    settings["tools"] = json!({"profile":"full","luna":{"allowed":["mcp__owned-server__chart","mcp__owned-server__refresh"]}});
    settings["mcp_servers"] = json!([{"name":"owned-server","transport":"stdio","command":"python3","args":[script,"normal",directory]}]);
    settings["session_memory"] = json!({"enabled":false});
    std::fs::write(path, serde_json::to_vec(&settings).unwrap()).unwrap();
}
#[cfg(unix)]
fn mcp_apps_generate_view(
    server: &mut TestAppServer,
    workspace: &std::path::Path,
    expect_approval: bool,
) -> (String, Value) {
    server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"mcp-apps-test","version":"1"},"capabilities":{"experimental":{"studioWorkModesV1":true,"inlineWidgetsV1":true,"isolatedWidgetsV1":true,"mcpAppsV1":true,"interactionBindingV1":true}}}}));
    assert!(server.response(1).get("error").is_none());
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker","cwd":workspace}}));
    let created = server.response(2);
    assert!(created.get("error").is_none(), "{created}");
    let thread = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":true,"isolatedWidgets":true},"input":[{"type":"text","text":"Show the supplied chart"}]}}));
    assert!(server.response(3).get("error").is_none());
    let mut approvals = 0;
    let deadline = Instant::now() + Duration::from_secs(30);
    let completed = loop {
        let event = server.next_value(deadline);
        if event["method"] == "approval/request" {
            approvals += 1;
            server.send(json!({"id":event["id"],"result":{"decision":"accept","approvalId":event["params"]["approvalId"],"threadId":thread,"turnId":event["params"]["turnId"]}}));
            continue;
        }

        if event["method"] == "item/completed" && event["params"]["item"]["id"] == "mcp-chart-call"
        {
            let widget = &event["params"]["item"]["widgetRef"];
            assert!(widget.is_object(), "{event}");
            server.send(json!({"id":30,"method":"widget/render/receipt","params":{"widget":{"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"]},"turnId":widget["turnId"],"attemptId":widget["attemptId"],"toolCallId":"mcp-chart-call","status":"rendered"}}));
            assert_eq!(server.response(30)["result"]["accepted"], true);
        }
        if event["method"] == "turn/completed" {
            break event;
        }
    };
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{}",
        completed["params"]["error"]
    );
    server.send(json!({"id":4,"method":"widget/list","params":{"threadId":thread}}));
    let list = server.response(4);
    assert!(list.get("error").is_none(), "{list}");
    let widgets = list["result"]["widgets"].as_array().unwrap();
    assert_eq!(widgets.len(), 1, "{list}");
    assert_eq!(approvals > 0, expect_approval);
    (thread, widgets[0].clone())
}
#[cfg(unix)]
#[test]
fn mcp_apps_dedicated_connection_commits_real_model_result_and_reads_bound_ui_data() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mcp_log = temporary.path().join("mcp");
    std::fs::create_dir_all(&mcp_log).unwrap();
    let (endpoint, calls, fixture) = serving_fixture_with(mcp_apps_chart_model_call);
    let settings = temporary.path().join("settings.json");
    mcp_apps_fixture_settings(&settings, &endpoint, &mcp_log);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .config_dir(&temporary.path().join("config"))
        .spawn();
    let (thread, widget) = mcp_apps_generate_view(&mut server, &workspace, false);
    let widget_id = widget["widgetId"].as_str().unwrap();
    let revision = widget["revision"].as_u64().unwrap();
    let connection = widget["mcpApp"]["connectionId"].as_str().unwrap();
    server.send(json!({"id":5,"method":"mcp/apps/read","params":{"threadId":thread,"widgetId":widget_id,"revision":revision,"connectionId":connection}}));
    let read = server.response(5);
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["live"], true, "{read}");
    assert_eq!(read["result"]["allowedTools"], json!(["chart", "refresh"]));
    assert_eq!(read["result"]["resourcesEnabled"], true);
    assert_eq!(read["result"]["toolInfo"]["name"], "chart");
    assert_eq!(read["result"]["toolInput"], json!({}));
    assert_eq!(read["result"]["structuredContent"]["series"], json!([1, 2]));
    assert!(read["result"].get("html").is_none());
    assert!(
        read["result"]["toolContent"]
            .as_array()
            .is_some_and(|content| !content.is_empty())
    );
    server.send(json!({"id":6,"method":"mcp/apps/read","params":{"threadId":thread,"widgetId":widget_id,"revision":revision,"connectionId":"another-connection"}}));
    assert!(server.response(6).get("error").is_some());
    let bound = json!({"threadId":thread,"widgetId":widget_id,"revision":revision,"connectionId":connection});
    let mut resource = bound.clone();
    resource["uri"] = json!("ui://fixture/chart");
    server.send(json!({"id":7,"method":"mcp/apps/resourceRead","params":resource}));
    let resource = server.response(7);
    assert!(resource.get("error").is_none(), "{resource}");
    let mut chunk = bound.clone();
    chunk["resourceId"] = resource["result"]["resource"]["resourceId"].clone();
    chunk["sha256"] = resource["result"]["resource"]["sha256"].clone();
    chunk["offset"] = json!(0);
    server.send(json!({"id":8,"method":"mcp/apps/resourceContentRead","params":chunk}));
    let content = server.response(8);
    assert!(content.get("error").is_none(), "{content}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content["result"]["dataBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        resource["result"]["resource"]["sha256"]
    );
    let decoded: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        decoded["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<html>")
    );
    let mut action = bound.clone();
    action["operationId"] = json!("refresh-once");
    action["name"] = json!("refresh");
    action["arguments"] = json!({});
    server.send(json!({"id":9,"method":"mcp/apps/toolCall","params":action}));
    let receipt = server.response(9);
    assert!(receipt.get("error").is_none(), "{receipt}");
    assert_eq!(receipt["result"]["status"], "completed", "{receipt}");
    assert_eq!(
        receipt["result"]["result"]["structuredContent"]["series"],
        json!([1, 2])
    );
    server.send(json!({"id":10,"method":"mcp/apps/toolCall","params":action}));
    assert_eq!(server.response(10)["result"], receipt["result"]);
    action["arguments"] = json!({"changed":true});
    server.send(json!({"id":11,"method":"mcp/apps/toolCall","params":action}));
    assert!(server.response(11).get("error").is_some());
    let mut lookup = bound.clone();
    lookup["operationId"] = json!("refresh-once");
    server.send(json!({"id":12,"method":"mcp/apps/operationRead","params":lookup}));
    assert_eq!(server.response(12)["result"], receipt["result"]);
    action["operationId"] = json!("model-only-denied");
    action["name"] = json!("model_only");
    server.send(json!({"id":13,"method":"mcp/apps/toolCall","params":action}));
    assert!(server.response(13).get("error").is_some());
    // Removing the source revokes this exact handle. Retained operation receipts
    // stay readable while all resource and business actions refuse dispatch.
    let mut changed: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    changed["mcp_servers"] = json!([]);
    std::fs::write(&settings, serde_json::to_vec(&changed).unwrap()).unwrap();
    server.send(json!({"id":14,"method":"mcp/apps/read","params":bound}));
    let revoked = server.response(14);
    assert_eq!(revoked["result"]["live"], false, "{revoked}");
    assert_eq!(revoked["result"]["allowedTools"], json!([]));
    server.send(json!({"id":15,"method":"mcp/apps/toolCall","params":action}));
    assert!(server.response(15).get("error").is_some());
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2);
    let model_calls = calls.lock().unwrap();
    for request in model_calls.iter() {
        let names = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"mcp__owned-server__chart"));
        assert!(
            !names.contains(&"mcp__owned-server__refresh"),
            "App-only action must never reach the model schema"
        );
    }
    drop(model_calls);
    let log = std::fs::read_to_string(mcp_log.join("messages.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(log.iter().any(|value| {
        value["method"] == "initialize"
            && value["params"]["capabilities"]["extensions"]["io.modelcontextprotocol/ui"]
                .is_object()
    }));
    assert_eq!(
        log.iter()
            .filter(|value| value["method"] == "tools/call")
            .count(),
        2
    );
}

#[cfg(unix)]
#[test]
fn mcp_apps_actions_require_bound_approval_and_keep_denied_receipts_without_replay() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mcp_log = temporary.path().join("mcp");
    std::fs::create_dir_all(&mcp_log).unwrap();
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| {
            if index == 0 {
                FixtureAnswer::Custom(mcp_apps_chart_model_call)
            } else {
                FixtureAnswer::Ok
            }
        },
        Some(2),
        Duration::from_secs(8),
    );
    let settings = temporary.path().join("settings.json");
    mcp_apps_fixture_settings(&settings, &endpoint, &mcp_log);
    let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    config["permission_mode"] = json!("ask");
    std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
    let hook_log = temporary.path().join("hook.log");
    let config_directory = temporary.path().join("config");
    std::fs::create_dir_all(&config_directory).unwrap();
    std::fs::write(config_directory.join("settings.json"),serde_json::to_vec(&json!({"hooks":{"PostToolUse":[{"matcher":"mcp__owned-server__refresh","hooks":[{"type":"command","command":format!("printf 'hook\\n' >> '{}'",hook_log.display())}]}]}})).unwrap()).unwrap();
    let mut server = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .config_dir(&temporary.path().join("config"))
        .spawn();
    let (thread, widget) = mcp_apps_generate_view(&mut server, &workspace, true);
    let bound = json!({"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"],"connectionId":widget["mcpApp"]["connectionId"]});
    let mut action = bound.clone();
    action["operationId"] = json!("declined");
    action["name"] = json!("refresh");
    action["arguments"] = json!({});
    server.send(json!({"id":50,"method":"mcp/apps/toolCall","params":action}));
    let approval = server.wait_for_method("approval/request");
    assert_eq!(approval["params"]["threadId"], thread);
    assert_eq!(approval["params"]["turnId"], "mcp-app-declined");
    // A reply naming another thread cannot authorize this operation.
    server.send(json!({"id":approval["id"],"result":{"decision":"accept","approvalId":approval["params"]["approvalId"],"threadId":"peer","turnId":approval["params"]["turnId"]}}));
    let replay = server.wait_for_method("approval/request");
    assert_eq!(replay["id"], approval["id"]);
    server.send(json!({"id":approval["id"],"result":{"decision":"decline","approvalId":approval["params"]["approvalId"],"threadId":thread,"turnId":approval["params"]["turnId"]}}));
    let denied = server.response(50);
    assert_eq!(denied["result"]["status"], "denied", "{denied}");
    server.send(json!({"id":51,"method":"mcp/apps/toolCall","params":action}));
    assert_eq!(server.response(51)["result"], denied["result"]);
    action["operationId"] = json!("accepted");
    server.send(json!({"id":52,"method":"mcp/apps/toolCall","params":action}));
    let approval = server.wait_for_method("approval/request");
    assert_eq!(approval["params"]["turnId"], "mcp-app-accepted");
    server.send(json!({"id":approval["id"],"result":{"decision":"accept","approvalId":approval["params"]["approvalId"],"threadId":thread,"turnId":approval["params"]["turnId"]}}));
    let deadline = Instant::now() + Duration::from_secs(15);
    let receipt = loop {
        let event = server.next_value(deadline);
        if event["method"] == "approval/request" {
            assert_eq!(event["params"]["turnId"], "mcp-app-accepted");
            server.send(json!({"id":event["id"],"result":{"decision":"accept","approvalId":event["params"]["approvalId"],"threadId":thread,"turnId":event["params"]["turnId"]}}));
        } else if event["id"] == 52 {
            break event;
        }
    };
    assert_eq!(receipt["result"]["status"], "completed", "{receipt}");
    assert_eq!(
        hook_lines(&hook_log),
        1,
        "only the authorized App operation fires the existing PostToolUse Hook"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2);
    let log = std::fs::read_to_string(mcp_log.join("messages.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        log.iter()
            .filter(|row| row["method"] == "tools/call")
            .count(),
        2
    );
}

#[cfg(unix)]
#[test]
fn mcp_apps_disconnect_keeps_unknown_receipt_and_does_not_replay_or_reconnect_by_name() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mcp_log = temporary.path().join("mcp");
    std::fs::create_dir_all(&mcp_log).unwrap();
    let config = temporary.path().join("config");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| {
            if index == 0 {
                FixtureAnswer::Custom(mcp_apps_chart_model_call)
            } else {
                FixtureAnswer::Ok
            }
        },
        Some(2),
        Duration::from_secs(8),
    );
    let settings = temporary.path().join("settings.json");
    mcp_apps_fixture_settings(&settings, &endpoint, &mcp_log);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .config_dir(&config)
        .spawn();
    let (thread, widget) = mcp_apps_generate_view(&mut server, &workspace, false);
    let bound = json!({"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"],"connectionId":widget["mcpApp"]["connectionId"]});
    let mut action = bound.clone();
    action["operationId"] = json!("lost-receipt");
    action["name"] = json!("refresh");
    action["arguments"] = json!({"_fixture_delay":true});
    server.send(json!({"id":50,"method":"mcp/apps/toolCall","params":action}));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !mcp_log.join("action-started").exists() {
        assert!(
            Instant::now() < deadline,
            "fixture action was never dispatched"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    server.send(json!({"id":55,"method":"server/resources/read","params":{}}));
    let resources = server.response(55);
    assert!(
        resources["result"]["activity"]["pendingServiceRequests"]
            .as_u64()
            .is_some_and(|count| count >= 1),
        "{resources}"
    );
    server.send(json!({"id":56,"method":"server/shutdown/idle","params":{"instanceId":resources["result"]["instanceId"]}}));
    let busy = server.response(56);
    assert_eq!(busy["result"]["accepted"], false, "{busy}");
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2);
    let mut restored = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .config_dir(&config)
        .spawn();
    restored.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"mcp-apps-test","version":"1"},"capabilities":{"experimental":{"studioWorkModesV1":true,"inlineWidgetsV1":true,"isolatedWidgetsV1":true,"mcpAppsV1":true}}}}));
    assert!(restored.response(1).get("error").is_none());
    restored.send(json!({"id":2,"method":"thread/resume","params":{"threadId":thread}}));
    let resumed = restored.response(2);
    assert!(resumed.get("error").is_none(), "{resumed}");
    let mut lookup = bound.clone();
    lookup["operationId"] = json!("lost-receipt");
    restored.send(json!({"id":3,"method":"mcp/apps/operationRead","params":lookup}));
    let unknown = restored.response(3);
    assert_eq!(unknown["result"]["status"], "outcome_unknown", "{unknown}");
    restored.send(json!({"id":4,"method":"mcp/apps/read","params":bound}));
    let history = restored.response(4);
    assert_eq!(history["result"]["live"], false, "{history}");
    assert_eq!(history["result"]["allowedTools"], json!([]));
    restored.send(json!({"id":5,"method":"mcp/apps/toolCall","params":action}));
    assert!(restored.response(5).get("error").is_some());
    restored.shutdown_successfully();
    let log = std::fs::read_to_string(mcp_log.join("messages.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        log.iter()
            .filter(|row| row["method"] == "tools/call")
            .count(),
        2,
        "lost receipt must not repeat the external action"
    );
}

#[cfg(unix)]
#[test]
fn mcp_apps_other_thread_network_preparation_never_turns_live_read_into_history_or_blocks_revoke() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mcp_log = temporary.path().join("mcp");
    std::fs::create_dir_all(&mcp_log).unwrap();
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        |index, _| {
            if index == 0 {
                FixtureAnswer::Custom(mcp_apps_chart_model_call)
            } else {
                FixtureAnswer::Ok
            }
        },
        None,
        Duration::from_secs(8),
    );
    let settings = temporary.path().join("settings.json");
    mcp_apps_fixture_settings(&settings, &endpoint, &mcp_log);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .without_scenario()
        .config_dir(&temporary.path().join("config"))
        .spawn();
    let (thread, widget) = mcp_apps_generate_view(&mut server, &workspace, false);
    std::fs::write(mcp_log.join("hold-app-initialize"), "hold").unwrap();
    server.send(json!({"id":50,"method":"thread/start","params":{"studioWorkMode":"kworker","cwd":workspace}}));
    let second = server.response(50)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":51,"method":"turn/start","params":{"threadId":second,"clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":true,"isolatedWidgets":true},"input":[{"type":"text","text":"SECOND_THREAD_PREPARATION"}]}}));
    let started = server.response(51);
    assert!(started.get("error").is_none(), "{started}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !mcp_log.join("app-initialize-held").exists() {
        assert!(
            Instant::now() < deadline,
            "dedicated initialization was not held"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let begin = Instant::now();
    server.send(json!({"id":52,"method":"mcp/apps/read","params":{"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"],"connectionId":widget["mcpApp"]["connectionId"]}}));
    let read = server.response(52);
    assert_eq!(
        read["result"]["live"], true,
        "busy preparation must not expire another thread: {read}"
    );
    assert!(begin.elapsed() < Duration::from_secs(1));
    let begin = Instant::now();
    server.send(json!({"id":53,"method":"mcp/apps/revoke","params":{"threadId":second}}));
    let revoked = server.response(53);
    assert_eq!(revoked["result"]["revoked"], true, "{revoked}");
    assert!(
        begin.elapsed() < Duration::from_secs(1),
        "revoke must not wait for the preparation actor"
    );
    server.send(json!({"id":54,"method":"turn/interrupt","params":{"threadId":second,"turnId":started["result"]["turn"]["id"]}}));
    assert!(server.response(54).get("error").is_none());
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(
        calls.lock().unwrap().len(),
        2,
        "revoked preparation must not proceed to another provider call"
    );
}
