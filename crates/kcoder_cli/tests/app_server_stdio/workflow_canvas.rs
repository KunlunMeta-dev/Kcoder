// Actual app-server persistence and generation-mode boundaries; no model calls.
#[test]
fn workflow_run_archive_routes_require_confirmation_and_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workflowRunArchiveV1"],
        true
    );
    server.send(json!({"id":2,"method":"workflow/create","params":{"title":"Archive routes"}}));
    assert!(server.response(2).get("error").is_none());
    let library_lock = find_named_file(root.path(), "library.lock").unwrap();
    let runs_root = library_lock.parent().unwrap().parent().unwrap().join("workflow-runs");
    let snapshot = serde_json::from_value(json!({
        "runId":"archive-route-run", "threadId":"archive-route-thread",
        "workspace":root.path().to_string_lossy(), "status":"running",
        "startedAtMs":1, "updatedAtMs":1, "resumeCount":0, "nodeStates":[]
    })).unwrap();
    let observation = kcoder_tools::workflow_runs::RunObservation::start(runs_root, snapshot).unwrap();
    observation.update(|run| run.status = "completed".to_owned()).unwrap();
    drop(observation);
    server.send(json!({"id":3,"method":"workflow/runs/archive/preview","params":{"runIds":["archive-route-run"]}}));
    let preview = server.response(3);
    assert!(preview.get("error").is_none(), "{preview}");
    let token = preview["result"]["previewToken"].as_str().unwrap();
    assert_eq!(preview["result"]["activeRecords"], 1);
    assert_eq!(preview["result"]["entries"][0]["blockers"], json!([]));
    server.send(json!({"id":4,"method":"workflow/runs/archive","params":{"runIds":["archive-route-run"],"previewToken":token,"confirm":false}}));
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"workflow/runs/list","params":{}}));
    assert_eq!(server.response(5)["result"]["total"], 1);
    server.send(json!({"id":6,"method":"workflow/runs/archive","params":{"runIds":["archive-route-run"],"previewToken":token,"confirm":true}}));
    let receipt = server.response(6);
    assert!(receipt.get("error").is_none(), "{receipt}");
    assert_eq!(receipt["result"]["archivedRunIds"], json!(["archive-route-run"]));
    assert_eq!(receipt["result"]["retainedRecoveryArtifacts"], true);
    server.send(json!({"id":7,"method":"workflow/runs/list","params":{}}));
    assert_eq!(server.response(7)["result"]["total"], 0);
    server.send(json!({"id":8,"method":"workflow/runs/archive/list","params":{}}));
    assert_eq!(server.response(8)["result"]["total"], 1);
    server.send(json!({"id":9,"method":"workflow/runs/archive/read","params":{"runId":"archive-route-run"}}));
    let archived = server.response(9);
    assert_eq!(archived["result"]["status"], "completed");
    server.shutdown_successfully();
    let mut restored = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    restored.initialize(1);
    restored.send(json!({"id":2,"method":"workflow/runs/archive/read","params":{"runId":"archive-route-run"}}));
    assert_eq!(restored.response(2)["result"], archived["result"]);
    restored.shutdown_successfully();
}

#[test]
fn workflow_library_lock_does_not_block_independent_connection_requests() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"workflow/create","params":{"title":"Locked library"}}));
    assert!(server.response(2).get("error").is_none());
    let path = find_named_file(root.path(), "library.lock").unwrap();
    let lock = std::fs::OpenOptions::new().read(true).write(true).open(path).unwrap();
    lock.lock_exclusive().unwrap();
    server.send(json!({"id":3,"method":"workflow/list","params":{}}));
    let started = Instant::now();
    server.send(json!({"id":4,"method":"workflow/capabilities/read","params":{}}));
    let response = server.response(4);
    let elapsed = started.elapsed();
    fs2::FileExt::unlock(&lock).unwrap();
    assert!(response.get("error").is_none(), "{response}");
    assert!(elapsed < Duration::from_millis(750), "independent request waited for the library lock: {elapsed:?}");
    server.shutdown_successfully();
}

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
    server.send(json!({"id":90,"method":"workflow/create","params":{"title":"Bound generation"}}));
    let definition=server.response(90)["result"]["id"].as_str().unwrap().to_owned();
    for (request_id, mode, id) in [(91,"default",definition.as_str()),(92,"workflow_draft","missing-definition")] {
        server.send(json!({"id":request_id,"method":"thread/start","params":{"sessionMode":mode,"workflowDefinitionId":id}}));
        assert!(server.response(request_id).get("error").is_some());
    }
    server.send(json!({"id":2,"method":"thread/start","params":{"sessionMode":"workflow_draft","workflowDefinitionId":definition}}));
    let created = server.response(2);
    assert!(created.get("error").is_none(), "{created}");
    let thread = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(created["result"]["thread"]["workflowDefinitionId"], definition);
    server.send(json!({"id":93,"method":"session/modes","params":{"threadId":thread}}));
    assert_eq!(server.response(93)["result"]["workflowDefinitionId"], definition);
    server.send(json!({"id":94,"method":"thread/read","params":{"threadId":thread}}));
    assert_eq!(server.response(94)["result"]["thread"]["workflowDefinitionId"], definition);
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
        assert_eq!(fork["result"]["thread"]["workflowDefinitionId"], definition);
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
    let durable=durable.unwrap();
    restored.send(json!({"id":95,"method":"thread/list","params":{}}));
    let listed=restored.response(95);
    assert!(listed["result"]["threads"].as_array().unwrap().iter().any(|row|row["id"]==durable && row["workflowDefinitionId"]==definition),"{listed}");
    restored.send(json!({"id":2,"method":"thread/resume","params":{"threadId":durable}}));
    let resumed=restored.response(2);
    assert_eq!(resumed["result"]["thread"]["sessionMode"],"workflow_draft");
    assert_eq!(resumed["result"]["thread"]["workflowDefinitionId"],definition);
    restored.shutdown_successfully();
}

#[test]
fn workflow_layout_moves_are_independent_of_content_revision() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings).without_scenario().spawn();
    assert_eq!(server.initialize(1)["result"]["capabilities"]["experimental"]["workflowLayoutV1"], true);
    server.send(json!({"id":2,"method":"workflow/create","params":{"title":"Layout"}}));
    let created = server.response(2)["result"].clone();
    let id = &created["id"];
    server.send(json!({"id":3,"method":"workflow/upsertNode","params":{"id":id,"expectedRevision":created["revision"],"node":{"id":"a","title":"A","prompt":"Original","position":{"x":0,"y":0}}}}));
    let node = server.response(3)["result"].clone();
    server.send(json!({"id":4,"method":"workflow/moveNode","params":{"id":id,"nodeId":"a","expectedPosition":{"x":0,"y":0},"position":{"x":80,"y":120}}}));
    let moved = server.response(4);
    assert!(moved.get("error").is_none(), "{moved}");
    assert_eq!(moved["result"]["revision"], node["revision"]);
    server.send(json!({"id":5,"method":"workflow/update","params":{"id":id,"expectedRevision":node["revision"],"title":"Edited during layout","inputSchema":{"type":"object"}}}));
    let updated = server.response(5);
    assert!(updated.get("error").is_none(), "{updated}");
    assert_eq!(updated["result"]["nodes"][0]["position"], json!({"x":80.0,"y":120.0}));
    server.send(json!({"id":6,"method":"workflow/moveNode","params":{"id":id,"nodeId":"a","expectedPosition":{"x":0,"y":0},"position":{"x":90,"y":130}}}));
    assert!(server.response(6)["error"].to_string().contains("workflow_layout_conflict"));
    server.shutdown_successfully();
}

#[test]
fn workflow_interaction_rpc_accepts_null_and_ignores_request_without_id() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let runs = root.path().join("config/workflow-runs");
    let snapshot = serde_json::from_value(json!({"revision":1,"runId":"interaction-run",
        "threadId":"fixture-thread","workspace":root.path(),"status":"running",
        "startedAtMs":1,"updatedAtMs":1,"resumeCount":0,"nodeStates":[]})).unwrap();
    let _observation = kcoder_tools::workflow_runs::RunObservation::start(runs.clone(), snapshot).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let task = runtime.spawn({
        let runs = runs.clone();
        async move {
            kcoder_tools::workflow_interactions::wait(&runs, "interaction-run", "reply", "approval",
                kcoder_types::workflow::WorkflowAwaitRequest::Event {
                    name: "test-event".into(), schema: json!({"type":"null"}), timeout_ms: 30000,
                }, tokio_util::sync::CancellationToken::new()).await
        }
    });
    for _ in 0..200 {
        if !kcoder_tools::workflow_interactions::list(&runs,"interaction-run").unwrap().is_empty() { break; }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut server = TestAppServer::builder(root.path(), &settings).without_scenario().spawn();
    let caps = server.initialize(1);
    assert_eq!(caps["result"]["capabilities"]["experimental"]["workflowInteractionsV1"],true);
    let reply = json!({"runId":"interaction-run","requestId":"reply","value":null});
    server.send(json!({"method":"workflow/runs/respond","params":reply}));
    server.send(json!({"id":2,"method":"workflow/runs/requests","params":{"runId":"interaction-run"}}));
    let pending = server.response(2);
    assert_eq!(pending["result"]["requests"].as_array().map(Vec::len),Some(1),"{pending}");
    server.send(json!({"id":3,"method":"workflow/runs/respond","params":reply}));
    let accepted = server.response(3);
    assert_eq!(accepted["result"]["accepted"],true,"{accepted}");
    assert_eq!(runtime.block_on(task).unwrap().unwrap(),serde_json::Value::Null);
    server.send(json!({"id":4,"method":"workflow/runs/respond","params":{"runId":"missing","requestId":"reply","value":null}}));
    assert!(server.response(4).get("error").is_some());
    server.shutdown_successfully();
}
