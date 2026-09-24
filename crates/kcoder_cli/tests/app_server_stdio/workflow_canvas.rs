// Actual app-server persistence and generation-mode boundaries; no model calls.
#[test]
fn workflow_library_survives_restart_and_generation_cannot_escalate() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    assert_eq!(
        server.initialize(1)["result"]["capabilities"]["experimental"]["workflowCanvasV1"],
        true
    );
    server.send(json!({"id":2,"method":"workflow/create","params":{"title":"Reusable review"}}));
    let created = server.response(2);
    assert!(created.get("error").is_none(), "{created}");
    let id = created["result"]["id"].as_str().unwrap().to_owned();
    let revision = created["result"]["revision"].as_u64().unwrap();
    server.send(json!({"id":3,"method":"workflow/upsertNode","params":{"id":id,"expectedRevision":revision,"node":{"id":"review","title":"Review","prompt":"Inspect only","agentType":"review","position":{"x":12,"y":40}}}}));
    let node = server.response(3);
    assert!(node.get("error").is_none(), "{node}");
    let revision = node["result"]["revision"].as_u64().unwrap();
    server.send(
        json!({"id":4,"method":"workflow/save","params":{"id":id,"expectedRevision":revision}}),
    );
    let saved = server.response(4);
    assert_eq!(saved["result"]["status"], "saved", "{saved}");
    assert_eq!(saved["result"]["savedVersion"], 1);
    server.send(json!({"id":5,"method":"workflow/save","params":{"id":id,"expectedRevision":1}}));
    assert!(server.response(5).get("error").is_some());
    server.send(json!({"id":6,"method":"thread/start","params":{"sessionMode":"workflow_draft"}}));
    let started = server.response(6);
    assert!(started.get("error").is_none(), "{started}");
    let thread = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(started["result"]["thread"]["sessionMode"], "workflow_draft");
    server.send(json!({"id":7,"method":"tools/catalog","params":{"threadId":thread}}));
    let catalog = server.response(7);
    let names = catalog["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["WorkflowDraft"]);
    server.send(json!({"id":8,"method":"thread/sessionMode/set","params":{"threadId":thread,"mode":"default"}}));
    assert!(server.response(8).get("error").is_some());
    server.send(json!({"id":9,"method":"thread/sessionMode/set","params":{"threadId":thread,"mode":"orchestrate"}}));
    assert!(server.response(9).get("error").is_some());
    server.shutdown_successfully();
    let mut restored = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    restored.initialize(1);
    restored.send(json!({"id":2,"method":"workflow/read","params":{"id":id}}));
    assert_eq!(restored.response(2)["result"], saved["result"]);
    restored.send(json!({"id":3,"method":"workflow/list","params":{"limit":1}}));
    assert_eq!(restored.response(3)["result"]["items"][0]["id"], id);
    restored.shutdown_successfully();
    let other = root.path().join("other-account");
    std::fs::create_dir_all(&other).unwrap();
    let mut isolated = TestAppServer::builder(root.path(), &settings)
        .config_dir(&other)
        .without_scenario()
        .spawn();
    isolated.initialize(1);
    isolated.send(json!({"id":2,"method":"workflow/read","params":{"id":id}}));
    assert!(isolated.response(2).get("error").is_some());
    isolated.shutdown_successfully();
}

#[test]
fn workflow_generation_forks_keep_the_restricted_mode() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    let (endpoint, _calls, fixture) = serving_fixture_scripted(vec![]);
    write_fixture_provider_settings(&settings, &endpoint);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{"sessionMode":"workflow_draft"}}));
    let created = server.response(2);
    assert!(created.get("error").is_none(), "{created}");
    let thread = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Record a design note without executing anything"}]}}));
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");
    let mut durable = None;
    for (index, ephemeral) in [false, true].into_iter().enumerate() {
        let id = 10 + index as i64 * 4;
        server.send(json!({"id":id,"method":"thread/fork","params":{"threadId":thread,"lastTurnId":"turn-1","ephemeral":ephemeral}}));
        let fork = server.response(id);
        assert!(fork.get("error").is_none(), "{fork}");
        assert_eq!(fork["result"]["thread"]["sessionMode"], "workflow_draft");
        let fork_id = fork["result"]["thread"]["id"].as_str().unwrap().to_owned();
        if !ephemeral {
            server.send(json!({"id":id+1,"method":"thread/resume","params":{"threadId":fork_id}}));
            let resumed = server.response(id + 1);
            assert!(resumed.get("error").is_none(), "{resumed}");
        }
        server.send(json!({"id":id+2,"method":"tools/catalog","params":{"threadId":fork_id}}));
        let tools = server.response(id + 2);
        assert!(tools.get("error").is_none(), "{tools}");
        let names = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["WorkflowDraft"]);
        server.send(json!({"id":id+3,"method":"thread/sessionMode/set","params":{"threadId":fork_id,"mode":"default"}}));
        assert!(server.response(id + 3).get("error").is_some());
        if !ephemeral {
            durable = Some(fork_id);
        }
    }
    server.shutdown_successfully();
    fixture.join().unwrap();
    let mut restored = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    restored.initialize(1);
    restored.send(json!({"id":2,"method":"thread/resume","params":{"threadId":durable.unwrap()}}));
    assert_eq!(
        restored.response(2)["result"]["thread"]["sessionMode"],
        "workflow_draft"
    );
    restored.shutdown_successfully();
}
