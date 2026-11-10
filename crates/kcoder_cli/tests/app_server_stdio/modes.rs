// Model-independent protocol tests: these exercise mode ownership and recovery,
// not the quality of the deterministic provider's plans or answers.
#[test]
fn session_modes_are_persisted_and_cannot_change_after_the_first_message() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .stream_delay_ms("1")
        .spawn();
    assert_eq!(
        server.initialize(1)["result"]["capabilities"]["experimental"]["sessionModes"],
        true
    );
    server.send(json!({"id":2,"method":"thread/start","params":{"sessionMode":"orchestrate"}}));
    let result = server.response(2);
    assert_eq!(result["result"]["thread"]["sessionMode"], "orchestrate");
    let thread = result["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"session/modes","params":{"threadId":thread}}));
    assert_eq!(server.response(3)["result"]["sessionMode"], "orchestrate");
    server.send(json!({"id":4,"method":"thread/sessionMode/set","params":{"threadId":thread,"mode":"default"}}));
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Inspect the fixture"}]}}));
    assert!(server.response(5).get("error").is_none());
    server.wait_for_method("turn/completed");
    server.send(json!({"id":6,"method":"thread/start","params":{}}));
    let ordinary = server.response(6)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":7,"method":"turn/start","params":{"threadId":ordinary,"input":[{"type":"text","text":"Hello"}]}}));
    assert!(server.response(7).get("error").is_none());
    server.wait_for_method("turn/completed");
    server.send(json!({"id":8,"method":"thread/sessionMode/set","params":{"threadId":ordinary,"mode":"orchestrate"}}));
    assert!(server.response(8).get("error").is_some());
    server.shutdown_successfully();
    let mut restored = TestAppServer::builder(temp.path(), &settings).spawn();
    restored.initialize(1);
    restored.send(json!({"id":2,"method":"thread/resume","params":{"threadId":thread}}));
    assert_eq!(
        restored.response(2)["result"]["thread"]["sessionMode"],
        "orchestrate"
    );
    restored.send(
        json!({"id":3,"method":"thread/fork","params":{"threadId":thread,"lastTurnId":"turn-1"}}),
    );
    let fork = restored.response(3);
    assert_eq!(
        fork["result"]["thread"]["sessionMode"], "orchestrate",
        "{fork}"
    );
    restored.shutdown_successfully();
}

#[test]
fn moa_plan_preflight_failure_does_not_poison_a_new_thread() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["moa_plan"] = json!({"enabled":false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .stream_delay_ms("1")
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"session/modes","params":{}}));
    assert!(
        server.response(2)["result"]["moaPlanError"]
            .as_str()
            .unwrap()
            .contains("disabled")
    );
    server.send(json!({"id":3,"method":"thread/start","params":{}}));
    let thread = server.response(3)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":4,"method":"turn/start","params":{"threadId":thread,"turnMode":"moa-plan","input":[{"type":"text","text":"Plan it"}]}}));
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"thread/read","params":{"threadId":thread}}));
    assert!(!server.response(5).to_string().contains("Plan it"));
    server.send(json!({"id":6,"method":"turn/start","params":{"threadId":thread,"turnMode":"standard","input":[{"type":"text","text":"Hello"}]}}));
    assert!(server.response(6).get("error").is_none());
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    server.shutdown_successfully();
}

#[test]
fn studio_office_mode_requires_current_capabilities_and_persists_without_cli_inheritance() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut document: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    document["tools"]["luna"]["allowed"] = json!(["read"]);
    std::fs::write(&settings, serde_json::to_vec(&document).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker"}}));
    assert!(
        server.response(2)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("studioWorkModesV1")
    );
    server.shutdown_successfully();

    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"office-test","version":"1"},"capabilities":{"experimental":{"studioWorkModesV1":true,"inlineWidgetsV1":true}}}}));
    assert!(server.response(1).get("error").is_none());
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker","clientRequestId":"office-create-1"}}));
    let created = server.response(2);
    assert!(created.get("error").is_none(), "{created}");
    let thread = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(created["result"]["thread"]["studioWorkMode"], "kworker");
    let names = |response: Value| -> Vec<String> {
        assert!(response.get("error").is_none(), "{response}");
        response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    };
    server.send(json!({"id":3,"method":"tools/catalog","params":{"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":false}}}));
    // KWorker keeps its built-in shell (KWORKER_DEFAULT_SHELL_TOOLS); on this
    // Linux host only `bash` is registered, so PowerShell is not restored.
    assert_eq!(names(server.response(3)), [
        "SendMessage", "Workflow", "WorkflowDraft", "bash", "close_agent",
        "explore_agent", "read", "spawn_agent", "tool_execute", "tool_search", "wait",
    ].map(str::to_owned));
    server.send(json!({"id":4,"method":"tools/catalog","params":{"threadId":thread}}));
    let coding = names(server.response(4));
    assert!(coding.len() > 1);
    assert!(!coding.iter().any(|name| name == "show_widget"));
    assert!(!coding.iter().any(|name| name == "tool_search"));
    server.send(json!({"id":5,"method":"tools/catalog","params":{"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":"kcoder"}}}));
    assert!(server.response(5).get("error").is_some());
    server.shutdown_successfully();

    let mut legacy = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    legacy.initialize(1);
    legacy.send(json!({"id":2,"method":"thread/resume","params":{"threadId":thread}}));
    let restored = legacy.response(2);
    assert_eq!(
        restored["result"]["thread"]["studioWorkMode"], "kworker",
        "{restored}"
    );
    legacy.send(json!({"id":3,"method":"tools/catalog","params":{"threadId":thread}}));
    assert_eq!(names(legacy.response(3)), coding);
    legacy.shutdown_successfully();
}

#[test]
fn studio_office_failed_turn_refuses_lost_mode_before_another_provider_request() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, calls, fixture) = serving_fixture();
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"office-test","version":"1"},"capabilities":{"experimental":{"studioWorkModesV1":true,"inlineWidgetsV1":true}}}}));
    assert!(server.response(1).get("error").is_none());
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker"}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let presentation = json!({"version":1,"studioWorkMode":"kworker","inlineWidgets":false});
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"clientPresentation":presentation,"input":[{"type":"text","text":"organize the supplied notes"}]}}));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let turn = started["result"]["turn"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "failed"
    );
    server.send(continuation_request(&thread, &turn, 4));
    let refused = server.response(4);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("original Studio mode"),
        "{refused}"
    );
    assert_eq!(calls.lock().unwrap().len(), 1);
    let mut retry = continuation_request(&thread, &turn, 5);
    retry["params"]["clientPresentation"] = presentation;
    server.send(retry);
    let accepted = server.response(5);
    assert!(accepted.get("error").is_none(), "{accepted}");
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
    let requests = calls.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        assert!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "system"
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("You are KWorker")
                            && !text.contains("everyday-work mode of KCoder Studio")))
        );
    }
}
