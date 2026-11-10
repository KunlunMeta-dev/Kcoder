// Actual source-control stdio; bounded local Provider and MCP fixture, no external accounts.
#[cfg(target_os = "linux")]
mod integrations_task_capability_scope {
    use super::*;
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        let reply = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"actual-task-sources","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":true,"taskSourceDirectoryV1":true,"taskSourcesV1":true,"taskSourceChoicesV1":true}}}),
        );
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["taskSourcesV1"], true,
            "{reply}"
        );
        rpc(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn envelope(scope: &Value, request: &str, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":request,"scope":scope,"timeoutMs":10000,"payload":payload})
    }
    fn turn(server: &mut TestAppServer, id: i64, thread: &str) -> Value {
        let response = rpc(
            server,
            id,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":format!("original-source-turn-{id}"),"input":[{"type":"text","text":"Return one bounded visible result."}]}),
        );
        assert!(response["error"].is_null(), "{response}");
        let target = json!({"initialAttempt":{"threadId":thread,"turnId":response["result"]["turn"]["id"],"attemptId":response["result"]["turn"]["attemptId"]}});
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed"
                && event["params"]["turnId"] == target["initialAttempt"]["turnId"]
            {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        target
    }
    fn read(server: &mut TestAppServer, id: i64, scope: &Value, target: &Value) -> Value {
        let reply = rpc(
            server,
            id,
            "integrations/tasks/readTaskSources",
            envelope(
                scope,
                "read-original-task",
                json!({"target":target,"params":{"threadId":target["initialAttempt"]["threadId"]}}),
            ),
        );
        assert_eq!(reply["result"]["status"], "completed", "{reply}");
        reply["result"]["result"].clone()
    }
    #[test]
    fn initial_source_retry_after_model_revision_change_preserves_receipts_and_history() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |index, _| {
                if index == 0 {
                    FixtureAnswer::Custom(outage_first_call)
                } else {
                    FixtureAnswer::Text("Recovered the original task.".into())
                }
            },
            Some(2),
            Duration::from_secs(30),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        config["session_memory"] = json!({"enabled":false});
        // Ordinary Studio guards also run without enabled channel services.
        // These legacy scopes retain explicit model configuration revisions.
        config["integrations"] = json!({"connectivity":{"enabled":false}});
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        std::fs::set_permissions(
            &settings,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600),
        )
        .unwrap();
        let spawn = || {
            let mut builder = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario();
            builder.training_mode = true;
            if let Some(binary) = std::env::var_os("KCODER_E2E_BASELINE_KCODER_BIN") {
                builder = builder.binary(std::path::Path::new(&binary));
            }
            builder.spawn()
        };
        let mut server = spawn();
        let original_scope = initialize(&mut server);
        let started = rpc(&mut server, 3, "thread/start", json!({"cwd":workspace}));
        let thread = started["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let accepted = rpc(
            &mut server,
            4,
            "turn/start",
            json!({
                "threadId":thread,"clientMessageId":"original-source-retry",
                "input":[{"type":"text","text":"Return a bounded result."}]
            }),
        );
        assert!(accepted["error"].is_null(), "{accepted}");
        let failed_turn = accepted["result"]["turn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut events = Vec::new();
        let failed = loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" {
                break event;
            }
            events.push(event);
        };
        assert_eq!(failed["params"]["turn"]["status"], "failed", "{failed}");
        assert_eq!(calls.lock().unwrap().len(), 1, "{failed} {events:?}");
        let catalog_path = find_named_file(&profile, "native-sources.json").unwrap();
        let original_catalog: Value =
            serde_json::from_slice(&std::fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(original_catalog["operations"].as_object().unwrap().len(), 1);
        server.shutdown_successfully();

        config["providers"]["fixture"]["default_model"] = json!("fixture-model-two");
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        let mut server = spawn();
        let current_scope = initialize(&mut server);
        assert_eq!(original_scope["accountId"], current_scope["accountId"]);
        assert_ne!(
            original_scope["targetRevision"],
            current_scope["targetRevision"]
        );
        let resumed = rpc(&mut server, 5, "thread/resume", json!({"threadId":thread}));
        assert!(resumed["error"].is_null(), "{resumed}");
        server.send(continuation_request(&thread, &failed_turn, 6));
        let retry = server.response(6);
        assert!(retry["error"].is_null(), "{retry}");
        let completed = server.wait_for_method("turn/completed");
        assert_eq!(
            completed["params"]["turn"]["status"], "completed",
            "{completed}"
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(user_message_count(&mut server, &thread, 7), 1);
        let catalog: Value =
            serde_json::from_slice(&std::fs::read(&catalog_path).unwrap()).unwrap();
        let operations = catalog["operations"].as_object().unwrap();
        assert_eq!(operations.len(), 2);
        for (id, intent) in original_catalog["operations"].as_object().unwrap() {
            assert_eq!(operations.get(id), Some(intent));
        }
        server.shutdown_successfully();
        fixture.join().unwrap();
    }

    #[test]
    fn actual_stdio_initial_source_binding_exact_two_tasks_lost_ack_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        let mcp = temp.path().join("mcp");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&mcp).unwrap();
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("A bounded original source result.".into()),
            Some(2),
            Duration::from_secs(5),
        );
        mcp_apps_fixture_settings(&settings, &endpoint, &mcp);
        let builder = || {
            let mut builder = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario();
            builder.training_mode = true;
            builder
        };
        let mut server = builder().spawn();
        let scope = initialize(&mut server);
        let cold = rpc(
            &mut server,
            3,
            "integrations/tasks/readSavedTaskSourceBindings",
            envelope(&scope, "cold-directory", json!({})),
        );
        assert_eq!(
            cold["result"]["result"]["observationState"], "unknown",
            "{cold}"
        );
        assert!(find_named_file(&profile, "task-sources-index.json").is_none());
        let thread =
            rpc(&mut server, 4, "thread/start", json!({"cwd":workspace}))["result"]["thread"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
        let first = turn(&mut server, 10, &thread);
        let first_snapshot = read(&mut server, 11, &scope, &first);
        let choices = rpc(
            &mut server,
            12,
            "integrations/tasks/listTaskSourceChoices",
            envelope(&scope, "actual-task-choices", json!({"target":first})),
        );
        assert_eq!(choices["result"]["status"], "completed", "{choices}");
        let catalog = &choices["result"]["result"];
        assert_eq!(catalog["target"], first);
        assert_eq!(catalog["catalogState"], "observed");
        let descriptors = catalog["items"].as_array().unwrap();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0]["displayName"], "owned-server");
        assert_eq!(descriptors[0]["state"], "ready");
        assert_eq!(
            descriptors[0]["sourceRef"],
            first_snapshot["effectiveSources"][0]["sourceRef"]
        );
        assert_eq!(
            descriptors[0]["accountRef"],
            first_snapshot["effectiveSources"][0]["accountRef"]
        );
        assert_eq!(first_snapshot["selection"]["mode"], "inherit_current");
        assert_eq!(
            first_snapshot["effectiveSources"].as_array().unwrap().len(),
            1,
            "actual registered native MCP source must be retained"
        );
        let second = turn(&mut server, 20, &thread);
        let second_snapshot = read(&mut server, 21, &scope, &second);
        assert_eq!(second_snapshot["revision"], 1);
        let mut change = envelope(
            &scope,
            "source-change-original",
            json!({"target":first,"params":{"threadId":thread,"selection":{"mode":"none","sources":[]}}}),
        );
        change["operationId"] = json!("source-change-original");
        change["expectedRevision"] = first_snapshot["revision"].to_string().into();
        // Discard the first acknowledgement and reconcile with the exact same intent.
        let _discarded = rpc(
            &mut server,
            30,
            "integrations/tasks/setTaskSources",
            change.clone(),
        );
        let repeated = rpc(&mut server, 31, "integrations/tasks/setTaskSources", change);
        assert_eq!(
            repeated["result"]["result"]["operation"]["phase"], "completed",
            "{repeated}"
        );
        let changed = read(&mut server, 32, &scope, &first);
        assert_eq!(changed["revision"], 3);
        assert_eq!(changed["selection"]["mode"], "none");
        assert_eq!(
            read(&mut server, 33, &scope, &second),
            second_snapshot,
            "a different original Accepted task keeps its source selection"
        );
        let operation = rpc(
            &mut server,
            34,
            "integrations/tasks/readTaskSourceOperation",
            envelope(
                &scope,
                "read-source-operation",
                json!({"target":first,"operationId":"source-change-original"}),
            ),
        );
        assert_eq!(
            operation["result"]["result"]["operation"]["phase"], "completed",
            "{operation}"
        );
        let original_settings = std::fs::read(&settings).unwrap();
        let mut disabled_settings: Value = serde_json::from_slice(&original_settings).unwrap();
        disabled_settings["mcp_disabled_servers"] = json!(["owned-server"]);
        std::fs::write(&settings, serde_json::to_vec(&disabled_settings).unwrap()).unwrap();
        let mut disabled_change = envelope(
            &scope,
            "disabled-source-change",
            json!({"target":second,"params":{"threadId":thread,"selection":{"mode":"selected","sources":second_snapshot["effectiveSources"]}}}),
        );
        disabled_change["operationId"] = json!("disabled-source-change");
        disabled_change["expectedRevision"] = second_snapshot["revision"].to_string().into();
        let disabled = rpc(
            &mut server,
            35,
            "integrations/tasks/setTaskSources",
            disabled_change,
        );
        assert_eq!(
            disabled["result"]["result"]["operation"]["phase"], "unknown",
            "{disabled}"
        );
        assert_eq!(disabled["result"]["result"]["snapshot"], second_snapshot);
        assert_eq!(read(&mut server, 36, &scope, &second), second_snapshot);
        assert_eq!(calls.lock().unwrap().len(), 2);
        std::fs::write(&settings, original_settings).unwrap();
        server.shutdown_successfully();
        let mut reopened = builder().spawn();
        let scope = initialize(&mut reopened);
        let directory = rpc(
            &mut reopened,
            3,
            "integrations/tasks/readSavedTaskSourceBindings",
            envelope(
                &scope,
                "cold-reopened-directory",
                json!({"threadId":thread}),
            ),
        );
        assert_eq!(
            directory["result"]["result"]["entries"]
                .as_array()
                .unwrap()
                .len(),
            2,
            "{directory}"
        );
        let missing_resident = rpc(
            &mut reopened,
            4,
            "integrations/tasks/readTaskSources",
            envelope(
                &scope,
                "no-resume-on-read",
                json!({"target":first,"params":{"threadId":thread}}),
            ),
        );
        assert!(
            missing_resident["error"].is_object(),
            "a read never resumes an absent runtime"
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        let resumed = rpc(
            &mut reopened,
            5,
            "thread/resume",
            json!({"threadId":thread}),
        );
        assert!(resumed["error"].is_null(), "{resumed}");
        assert_eq!(
            read(&mut reopened, 6, &scope, &first)["selection"]["mode"],
            "none"
        );
        assert_eq!(read(&mut reopened, 7, &scope, &second), second_snapshot);
        assert_eq!(
            calls.lock().unwrap().len(),
            2,
            "metadata reopen does not call a Provider"
        );
        reopened.shutdown_successfully();
        fixture.join().unwrap();
    }

    #[test]
    fn actual_stdio_live_source_controls_require_their_own_negotiated_capability() {
        for experimental in [
            json!({}),
            json!({"taskSourcesV1":true}),
            json!({"integrationScopeV1":true,"taskSourceDirectoryV1":true,"taskSourcesV1":false}),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let workspace = temp.path().join("workspace");
            let profile = temp.path().join("profile");
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::create_dir_all(&profile).unwrap();
            let settings = profile.join("settings.json");
            write_fixture_provider_settings(&settings, "http://127.0.0.1:9");
            let mut server = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn();
            let initialized = rpc(
                &mut server,
                1,
                "initialize",
                json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"unnegotiated-task-sources","version":"1"},"capabilities":{"experimental":experimental}}),
            );
            assert!(initialized["error"].is_null(), "{initialized}");
            assert_ne!(
                initialized["result"]["capabilities"]["experimental"]["taskSourcesV1"],
                true
            );
            for (id, method) in [
                (2, "integrations/tasks/readTaskSources"),
                (3, "integrations/tasks/setTaskSources"),
                (4, "integrations/tasks/readTaskSourceOperation"),
            ] {
                let reply = rpc(&mut server, id, method, json!({}));
                assert_eq!(
                    reply["error"]["message"], "TASK_CAPABILITY_SCOPE_UNAVAILABLE",
                    "{reply}"
                );
            }
            assert!(find_named_file(&profile, "task-sources-index.json").is_none());
            server.shutdown_successfully();
        }
    }
}
