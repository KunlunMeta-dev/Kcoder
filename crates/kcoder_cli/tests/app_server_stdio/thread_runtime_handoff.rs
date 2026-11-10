// Normal stdio and independent processes; the configured model is unavailable.
#[cfg(target_os = "linux")]
mod thread_runtime_handoff {
    use super::*;
    const READ: &str = kcoder_app_protocol::METHOD_THREAD_RUNTIME_HANDOFF_READ;
    const RELEASE: &str = kcoder_app_protocol::METHOD_THREAD_RUNTIME_HANDOFF_RELEASE;
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn init(server: &mut TestAppServer, offer: bool) {
        let r = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"original-runtime-handoff","version":"1"},
            "capabilities":{"experimental":{"threadRuntimeHandoffV1":offer,"threadCreationReceiptsV1":true}}}),
        );
        assert!(r.get("error").is_none(), "{r}");
    }
    fn read(server: &mut TestAppServer, id: i64, thread: &str) -> Value {
        let r = rpc(server, id, READ, json!({"threadId":thread}));
        assert!(r.get("error").is_none(), "{r}");
        r["result"]["snapshot"].clone()
    }
    fn release_body(s: &Value, operation: &str) -> Value {
        json!({"threadId":s["threadId"],"operationId":operation,
            "expectedServerId":s["serverId"],"expectedOwnerRef":s["ownerRef"],
            "expectedClientTurnCount":s["clientTurnCount"]})
    }
    #[test]
    fn original_task_runtime_handoff_releases_one_lease_and_fences_old_requests_across_resume() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        // No configured model can answer; control and original history operations
        // must not depend on a model response or a scenario replacement.
        // Reuse the bounded fixture's existing HEAD/probe separation. Every
        // inference request would return 503 and be recorded as a model call.
        let (endpoint, model_calls, model_fixture) = serving_fixture_decided_bounded(
            |_, _| {
                FixtureAnswer::Custom(|socket| {
                    write!(socket,"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                })
            },
            Some(1),
            Duration::from_secs(2),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        value["session_memory"] = json!({"enabled":false});
        std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
        let spawn = || {
            TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn()
        };
        let mut a = spawn();
        init(&mut a, true);
        let mut b = spawn();
        init(&mut b, true);
        let mut legacy = spawn();
        init(&mut legacy, false);
        assert_eq!(
            rpc(&mut legacy, 2, READ, json!({"threadId":"not-owned"}))["error"]["code"],
            -32087
        );
        legacy.shutdown_successfully();
        let created = rpc(
            &mut a,
            2,
            "thread/start",
            json!({"clientRequestId":"original-handoff-task"}),
        );
        assert!(created.get("error").is_none(), "{created}");
        let thread = created["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let history = find_named_file(root.path(), &format!("{thread}.jsonl")).unwrap();
        let before = std::fs::read(&history).unwrap();
        let original = read(&mut a, 3, &thread);
        assert_eq!(original["releasable"], true, "{original}");
        assert!(
            rpc(&mut b, 2, "thread/resume", json!({"threadId":thread}))
                .get("error")
                .is_some(),
            "A second process acquired the original active lease"
        );
        let request = release_body(&original, "original-release-a");
        // Discard the original acknowledgement and read the exact operation.
        a.send(json!({"jsonrpc":"2.0","id":4,"method":RELEASE,"params":request}));
        let reconciled = rpc(
            &mut a,
            12,
            READ,
            json!({"threadId":thread,"operationId":"original-release-a"}),
        );
        assert!(reconciled.get("error").is_none(), "{reconciled}");
        let released = json!({"result":{"receipt":reconciled["result"]["operation"],"snapshot":reconciled["result"]["snapshot"]}});
        assert_eq!(
            released["result"]["receipt"]["status"], "released",
            "{released}"
        );
        assert_eq!(released["result"]["snapshot"]["ownerRef"], Value::Null);
        assert_eq!(
            std::fs::read(&history).unwrap(),
            before,
            "Release rewrote original history"
        );
        // Persist a declared worktree using the original State API while the
        // original lease is free. This tests cwd restoration, not Git creation.
        let worktree = workspace.join("owned-worktree");
        kcoder_config::PrivateDirectory::open_or_create(&worktree).unwrap();
        let saved = kcoder_state::AppState::new(&workspace);
        saved.resume_from_history(&history).unwrap();
        saved.enter_worktree_session(&workspace, &worktree, "owned-worktree", None, None, false);
        drop(saved);
        let resumed = rpc(&mut b, 3, "thread/resume", json!({"threadId":thread}));
        assert_eq!(resumed["result"]["thread"]["id"], thread, "{resumed}");
        assert_eq!(resumed["result"]["thread"]["cwd"], json!(worktree));
        let b_owner = read(&mut b, 4, &thread);
        let b_release = rpc(
            &mut b,
            5,
            RELEASE,
            release_body(&b_owner, "original-release-b"),
        );
        assert_eq!(
            b_release["result"]["receipt"]["status"], "released",
            "{b_release}"
        );
        assert_eq!(
            rpc(&mut a, 5, "thread/resume", json!({"threadId":thread}))["result"]["thread"]["id"],
            thread
        );
        let fresh = read(&mut a, 6, &thread);
        assert_ne!(fresh["ownerRef"], original["ownerRef"]);
        let replay = rpc(&mut a, 7, RELEASE, request.clone());
        assert_eq!(replay["result"]["receipt"], released["result"]["receipt"]);
        assert_eq!(
            replay["result"]["snapshot"]["ownerRef"], fresh["ownerRef"],
            "An old receipt hid the new runtime"
        );
        assert!(
            rpc(&mut b, 6, "thread/resume", json!({"threadId":thread}))
                .get("error")
                .is_some(),
            "The old release closed the new runtime"
        );
        let mut changed = release_body(&fresh, "original-release-a");
        assert!(
            rpc(&mut a, 8, RELEASE, changed.clone())
                .get("error")
                .is_some(),
            "A changed intent reused the original operation"
        );
        changed["operationId"] = json!("old-server-release");
        changed["expectedServerId"] = json!("a-retired-server");
        let wrong_server = rpc(&mut a, 9, RELEASE, changed);
        assert_eq!(wrong_server["result"]["receipt"]["status"], "unknown");
        assert_eq!(read(&mut a, 10, &thread)["ownerRef"], fresh["ownerRef"]);
        let creation = rpc(
            &mut a,
            11,
            "thread/creation/read",
            json!({"clientRequestId":"original-handoff-task"}),
        );
        assert_eq!(creation["result"]["receipt"]["threadId"], thread);
        for server in [&a, &b] {
            let journal = server.observed.lock().unwrap();
            assert!(
                !journal
                    .iter()
                    .any(|line| line.contains("\"method\":\"turn/started\"")),
                "A control operation started a model turn"
            );
        }
        a.shutdown_successfully();
        let mut restarted = spawn();
        init(&mut restarted, true);
        let restored = rpc(
            &mut restarted,
            2,
            "thread/resume",
            json!({"threadId":thread}),
        );
        assert_eq!(restored["result"]["thread"]["id"], thread, "{restored}");
        let restarted_owner = read(&mut restarted, 3, &thread);
        assert_ne!(restarted_owner["serverId"], original["serverId"]);
        let old_process = rpc(&mut restarted, 4, RELEASE, request);
        assert_eq!(old_process["result"]["receipt"]["status"], "unknown");
        assert_eq!(
            read(&mut restarted, 5, &thread)["ownerRef"],
            restarted_owner["ownerRef"]
        );
        restarted.shutdown_successfully();
        b.shutdown_successfully();
        model_fixture.join().unwrap();
        assert!(
            model_calls.lock().unwrap().is_empty(),
            "A control operation invoked model inference"
        );
    }
}
