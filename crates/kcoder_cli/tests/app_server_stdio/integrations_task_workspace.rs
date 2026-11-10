// Actual public task observations preserve the original thread/goal and never resume it.
#[cfg(target_os = "linux")]
mod integrations_task_workspace {
    use super::*;
    use kcoder_types::integrations::core::TaskWorkspaceSnapshot;

    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, task_workspace: bool) -> Value {
        let reply = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"actual-task-workspace","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":true,"taskWorkspaceV1":task_workspace,"threadRunSummaryV1":true}}}),
        );
        assert!(reply["error"].is_null(), "{reply}");
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["taskWorkspaceV1"],
            task_workspace
        );
        rpc(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn envelope(scope: &Value, request: &str, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":request,"scope":scope,"timeoutMs":10000,"payload":payload})
    }
    fn read(
        server: &mut TestAppServer,
        id: i64,
        scope: &Value,
        thread: &str,
    ) -> TaskWorkspaceSnapshot {
        let value = rpc(
            server,
            id,
            "integrations/tasks/readWorkspace",
            envelope(scope, "read-native-workspace", json!({"threadId":thread})),
        );
        assert_eq!(value["result"]["status"], "completed", "{value}");
        let view: TaskWorkspaceSnapshot =
            serde_json::from_value(value["result"]["result"].clone()).unwrap();
        view.validate().unwrap();
        view
    }
    #[test]
    fn actual_public_task_workspace_reads_original_goal_and_cold_thread_without_creating_a_run() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("The original conversation is durably recorded.".into()),
            Some(1),
            Duration::from_secs(2),
        );
        std::fs::write(&settings,serde_json::to_vec(&json!({"active_provider":"metadata-only","session_memory":{"enabled":false},"providers":{"metadata-only":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":endpoint,"default_model":"metadata-only","context_window_tokens":128000,"max_output_tokens":4096,"output_headroom_tokens":8192,"discover_models":false}}})).unwrap()).unwrap();
        let builder = || {
            let mut value = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario();
            value.training_mode = true;
            value
        };
        let mut server = builder().spawn();
        let scope = initialize(&mut server, true);
        let started = rpc(&mut server, 3, "thread/start", json!({"cwd":workspace}));
        let thread = started["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        // A cold observation requires an actually published conversation. An
        // unused creation receipt must not be promoted into invented history.
        let turn = rpc(
            &mut server,
            20,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Persist one ordinary original conversation before observing task metadata."}]}),
        );
        let turn_id = turn["result"]["turn"]["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["turnId"] == turn_id {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 1);
        let goal = rpc(
            &mut server,
            4,
            "thread/goal/set",
            json!({"threadId":thread,"objective":"Keep this original goal active while observing members.","mode":"strict","verificationKind":"answer","tokenBudget":2000}),
        );
        assert!(goal["error"].is_null(), "{goal}");
        let view = read(&mut server, 5, &scope, &thread);
        assert_eq!(view.thread.reference.thread_id(), thread);
        assert!(view.entries.iter().any(|entry|matches!(&entry.reference,kcoder_types::integrations::core::TaskWorkspaceNativeRef::Goal {goal_id,revision,..} if goal_id==goal["result"]["goal"]["goalId"].as_str().unwrap() && *revision==goal["result"]["goal"]["revision"].as_u64().unwrap())));
        assert_ne!(view.thread.native_status.as_deref(), Some("completed"));
        assert!(view.runtime.is_none() && view.source_selection.is_none());
        let wire = serde_json::to_string(&view).unwrap();
        assert!(
            !wire.contains(&workspace.to_string_lossy().to_string())
                && !wire.contains("output_path")
                && !wire.contains("transcript_path")
        );
        let mut wrong = scope.clone();
        wrong["accountId"] = json!("different-owner");
        let denied = rpc(
            &mut server,
            6,
            "integrations/tasks/readWorkspace",
            envelope(&wrong, "wrong-owner", json!({"threadId":thread})),
        );
        assert!(denied["error"].is_object() && denied["result"].is_null());
        let paths = rpc(
            &mut server,
            7,
            "integrations/tasks/readWorkspace",
            envelope(
                &scope,
                "path-is-not-a-thread",
                json!({"threadId":"../peer","path":"/arbitrary"}),
            ),
        );
        assert!(paths["error"].is_object());
        let unchanged = rpc(
            &mut server,
            8,
            "thread/goal/get",
            json!({"threadId":thread}),
        );
        assert_eq!(unchanged["result"]["goal"], goal["result"]["goal"]);
        server.shutdown_successfully();
        let mut cold = builder().spawn();
        let scope = initialize(&mut cold, true);
        let view = read(&mut cold, 3, &scope, &thread);
        let agents = view
            .facets
            .iter()
            .find(|facet| {
                facet.kind == kcoder_types::integrations::core::TaskWorkspaceFacetKind::Agents
            })
            .unwrap();
        // Since 36d56b07b a cold read reports the historical members snapshot
        // from the original sidecar (read-only) instead of Unknown.
        assert_eq!(
            agents.availability,
            kcoder_types::integrations::core::TaskWorkspaceAvailability::Partial
        );
        assert_eq!(agents.observed_count, Some(0));
        assert_eq!(
            agents.reason_code.as_deref(),
            Some("HISTORICAL_AGENTS_SNAPSHOT")
        );
        let list = rpc(&mut cold, 4, "thread/list", json!({}));
        assert_eq!(list["result"]["threads"].as_array().unwrap().len(), 1);
        cold.shutdown_successfully();
        let mut legacy = builder().spawn();
        let scope = initialize(&mut legacy, false);
        let denied = rpc(
            &mut legacy,
            3,
            "integrations/tasks/readWorkspace",
            envelope(&scope, "no-task-capability", json!({"threadId":thread})),
        );
        assert!(denied["error"].is_object());
        assert!(rpc(&mut legacy, 4, "thread/list", json!({}))["error"].is_null());
        legacy.shutdown_successfully();
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "Observations must not invoke another model"
        );
        fixture.join().unwrap();
    }
}
