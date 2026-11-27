// Actual Accepted source/MCP binding read by the existing task workspace route.
// One bounded local Provider seeds native history; aggregation never starts work.
#[cfg(target_os = "linux")]
mod integrations_task_workspace_sources {
    use super::*;
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, sources: bool) -> Value {
        let reply = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"actual-task-workspace-sources","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"taskSourceDirectoryV1":true,"taskSourcesV1":true,"taskWorkspaceV1":true,"taskWorkspaceSourcesV1":sources}}}),
        );
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["taskWorkspaceSourcesV1"], sources,
            "{reply}"
        );
        rpc(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn read(
        server: &mut TestAppServer,
        id: i64,
        scope: &Value,
        thread: &str,
        source: Option<&Value>,
    ) -> Value {
        let mut payload = json!({"threadId":thread});
        if let Some(source) = source {
            payload["sourceTarget"] = source.clone();
        }
        rpc(
            server,
            id,
            "integrations/tasks/readWorkspace",
            json!({"contractVersion":"parallel-v1","requestId":format!("readonly-original-{id}"),"scope":scope,"timeoutMs":5000,"payload":payload}),
        )
    }
    fn facet<'a>(snapshot: &'a Value, kind: &str) -> &'a Value {
        snapshot["facets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["kind"] == kind)
            .unwrap()
    }
    #[test]
    fn ordinary_turn_keeps_verified_source_when_another_account_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        let mcp = temp.path().join("mcp");
        for root in [&workspace, &profile, &mcp] {
            std::fs::create_dir_all(root).unwrap();
        }
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("The local task completed.".into()),
            Some(1),
            Duration::from_secs(5),
        );
        mcp_apps_fixture_settings(&settings, &endpoint, &mcp);
        let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        let mut unavailable = config["mcp_servers"][0].clone();
        unavailable["name"] = json!("owned-unverified-server");
        unavailable["env"] = json!({"SYNTHETIC_TOKEN":"fixture-value"});
        config["mcp_servers"]
            .as_array_mut()
            .unwrap()
            .push(unavailable);
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        let before = std::fs::read(&settings).unwrap();
        let mut builder = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario();
        builder.training_mode = true;
        let mut server = builder.spawn();
        let scope = initialize(&mut server, true);
        let thread =
            rpc(&mut server, 3, "thread/start", json!({"cwd":workspace}))["result"]["thread"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
        let accepted = rpc(
            &mut server,
            4,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":"unverified-source-regression","input":[{"type":"text","text":"Run an ordinary local task."}]}),
        );
        assert!(accepted["error"].is_null(), "{accepted}");
        let target = json!({"initialAttempt":{"threadId":thread,"turnId":accepted["result"]["turn"]["id"],"attemptId":accepted["result"]["turn"]["attemptId"]}});
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
        let actual = read(&mut server, 5, &scope, &thread, Some(&target));
        assert_eq!(actual["result"]["status"], "completed", "{actual}");
        assert_eq!(
            actual["result"]["result"]["sourceSelection"]["effectiveSources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(std::fs::read(&settings).unwrap(), before);
        server.shutdown_successfully();
        fixture.join().unwrap();
    }

    #[test]
    #[ignore = "requires an explicitly supplied pre-fix CLI binary"]
    fn session_with_previous_task_capability_scope_binding_failure_can_continue_after_upgrade() {
        let old_binary = std::env::var_os("KCODER_E2E_BASELINE_KCODER_BIN")
            .expect("an explicit pre-fix binary is required");
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        let mcp = temp.path().join("mcp");
        for root in [&workspace, &profile, &mcp] {
            std::fs::create_dir_all(root).unwrap();
        }
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("Continued after upgrade.".into()),
            Some(2),
            Duration::from_secs(30),
        );
        mcp_apps_fixture_settings(&settings, &endpoint, &mcp);
        let builder = || {
            let mut builder = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario();
            builder.training_mode = true;
            builder
        };
        let mut old = builder().binary(std::path::Path::new(&old_binary)).spawn();
        initialize(&mut old, true);
        let thread = rpc(&mut old, 3, "thread/start", json!({"cwd":workspace}))["result"]["thread"]
            ["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let seed = rpc(
            &mut old,
            4,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":"seed-existing-session","input":[{"type":"text","text":"Create an existing session."}]}),
        );
        assert!(seed.get("error").is_none(), "{seed}");
        let seed_turn = seed["result"]["turn"]["id"].clone();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = old.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["turnId"] == seed_turn {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 1);
        old.shutdown_successfully();

        let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        let mut unavailable = config["mcp_servers"][0].clone();
        unavailable["name"] = json!("owned-unverified-server");
        unavailable["env"] = json!({"SYNTHETIC_TOKEN":"fixture-value"});
        config["mcp_servers"]
            .as_array_mut()
            .unwrap()
            .push(unavailable);
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        let before = std::fs::read(&settings).unwrap();
        let mut old = builder().binary(std::path::Path::new(&old_binary)).spawn();
        initialize(&mut old, true);
        let resumed = rpc(&mut old, 5, "thread/resume", json!({"threadId":thread}));
        assert!(resumed.get("error").is_none(), "{resumed}");
        let first = rpc(
            &mut old,
            6,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":"before-upgrade","input":[{"type":"text","text":"Original request before upgrade."}]}),
        );
        assert!(first["error"].is_null(), "{first}");
        let first_turn = first["result"]["turn"]["id"].clone();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut original_error = false;
        loop {
            let event = old.next_value(deadline);
            original_error |= event.to_string().contains(
                "TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE:NATIVE_SOURCE_ACCOUNT_UNAVAILABLE",
            );
            if event["method"] == "turn/completed" && event["params"]["turnId"] == first_turn {
                assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
                break;
            }
        }
        assert!(
            original_error,
            "the pre-fix turn must fail for the reported reason"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        old.shutdown_successfully();

        let mut updated = builder().spawn();
        initialize(&mut updated, true);
        let resumed = rpc(&mut updated, 5, "thread/resume", json!({"threadId":thread}));
        assert!(resumed.get("error").is_none(), "{resumed}");
        assert_eq!(resumed["result"]["thread"]["id"], thread);
        let next = rpc(
            &mut updated,
            6,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":"after-upgrade","input":[{"type":"text","text":"Continue the original session."}]}),
        );
        assert!(next.get("error").is_none(), "{next}");
        let next_turn = next["result"]["turn"]["id"].clone();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = updated.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["turnId"] == next_turn {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert!(
                calls[1]["messages"]
                    .to_string()
                    .contains("Create an existing session."),
                "the resumed model request must retain the previous conversation"
            );
        }
        assert_eq!(std::fs::read(&settings).unwrap(), before);
        updated.shutdown_successfully();
        fixture.join().unwrap();
    }
    #[test]
    fn actual_public_task_workspace_reads_only_explicit_source_tuple_and_cold_missing_owner_stays_unknown()
     {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        let mcp = temp.path().join("mcp");
        for root in [&workspace, &profile, &mcp] {
            std::fs::create_dir_all(root).unwrap();
        }
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| {
                FixtureAnswer::Text(
                    "An original accepted task with an actual source binding.".into(),
                )
            },
            Some(1),
            Duration::from_secs(5),
        );
        mcp_apps_fixture_settings(&settings, &endpoint, &mcp);
        let settings_before = std::fs::read(&settings).unwrap();
        let builder = || {
            let mut builder = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario();
            builder.training_mode = true;
            builder
        };
        let mut server = builder().spawn();
        let scope = initialize(&mut server, true);
        let thread =
            rpc(&mut server, 3, "thread/start", json!({"cwd":workspace}))["result"]["thread"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
        let accepted = rpc(
            &mut server,
            4,
            "turn/start",
            json!({"threadId":thread,"clientMessageId":"actual-source-aggregate","input":[{"type":"text","text":"Return one bounded visible source result."}]}),
        );
        assert!(accepted["error"].is_null(), "{accepted}");
        let target = json!({"initialAttempt":{"threadId":thread,"turnId":accepted["result"]["turn"]["id"],"attemptId":accepted["result"]["turn"]["attemptId"]}});
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
        let legacy = read(&mut server, 10, &scope, &thread, None);
        assert_eq!(legacy["result"]["status"], "completed", "{legacy}");
        assert!(legacy["result"]["result"].get("sourceTarget").is_none());
        let actual = read(&mut server, 11, &scope, &thread, Some(&target));
        assert_eq!(actual["result"]["status"], "completed", "{actual}");
        let snapshot = &actual["result"]["result"];
        assert_eq!(snapshot["sourceTarget"], target);
        assert_eq!(snapshot["sourceSelection"]["threadId"], thread);
        assert_eq!(
            snapshot["sourceSelection"]["effectiveSources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(facet(snapshot, "sources")["availability"], "available");
        assert_eq!(facet(snapshot, "sources")["observedCount"], 1);
        assert!(snapshot["runtime"].is_null());
        assert_eq!(facet(snapshot, "runtime")["availability"], "unknown");
        let mut forged = target.clone();
        forged["initialAttempt"]["attemptId"] = json!("never-accepted-original-attempt");
        let unknown = read(&mut server, 12, &scope, &thread, Some(&forged));
        assert_eq!(unknown["result"]["status"], "completed", "{unknown}");
        assert_eq!(
            unknown["result"]["result"]["thread"]["reference"]["threadId"],
            thread
        );
        assert!(unknown["result"]["result"]["sourceSelection"].is_null());
        assert_eq!(
            facet(&unknown["result"]["result"], "sources")["availability"],
            "unknown"
        );
        assert!(facet(&unknown["result"]["result"], "sources")["observedCount"].is_null());
        let mut missing_runtime = target.clone();
        missing_runtime["runtimeOperationId"] = json!("unobserved-runtime-operation");
        let unknown = read(&mut server, 13, &scope, &thread, Some(&missing_runtime));
        assert_eq!(unknown["result"]["status"], "completed", "{unknown}");
        assert!(unknown["result"]["result"]["runtime"].is_null());
        assert!(facet(&unknown["result"]["result"], "runtime")["observedCount"].is_null());
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "readonly aggregation must not dispatch Provider"
        );
        assert_eq!(std::fs::read(&settings).unwrap(), settings_before);
        server.shutdown_successfully();
        let mut cold = builder().spawn();
        let scope = initialize(&mut cold, true);
        let observed = read(&mut cold, 20, &scope, &thread, Some(&target));
        assert_eq!(observed["result"]["status"], "completed", "{observed}");
        assert_eq!(
            observed["result"]["result"]["thread"]["reference"]["threadId"],
            thread
        );
        assert!(observed["result"]["result"]["sourceSelection"].is_null());
        assert_eq!(
            facet(&observed["result"]["result"], "sources")["availability"],
            "unknown"
        );
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "cold readonly lookup must not resume or create work"
        );
        cold.shutdown_successfully();
        let mut old_client = builder().spawn();
        let scope = initialize(&mut old_client, false);
        let old_wire = read(&mut old_client, 30, &scope, &thread, None);
        assert_eq!(old_wire["result"]["status"], "completed", "{old_wire}");
        assert!(old_wire["result"]["result"].get("sourceTarget").is_none());
        let unnegotiated = read(&mut old_client, 31, &scope, &thread, Some(&target));
        assert!(
            unnegotiated["error"].is_object(),
            "new optional facet requires its actual negotiated capability"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        old_client.shutdown_successfully();
        fixture.join().unwrap();
    }
}
