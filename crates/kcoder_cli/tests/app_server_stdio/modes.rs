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
