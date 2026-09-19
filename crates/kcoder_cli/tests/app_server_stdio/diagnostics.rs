#[cfg(unix)]
struct DiagnosticProcessGuard(TestAppServer);

// Idle lifecycle and instance binding do not depend on model behavior.
#[cfg(unix)]
#[test]
fn idle_shutdown_is_instance_bound_and_exits_with_stdin_open() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let settings = temp.path().join("settings.jsonc");
    write_test_settings(&settings);
    let mut guard = DiagnosticProcessGuard(TestAppServer::builder(&workspace, &settings)
        .config_dir(&temp.path().join("config"))
        .scenario("markdown-showcase").discard_stderr().spawn());
    let server = &mut guard.0;
    assert_eq!(server.initialize(1)["result"]["capabilities"]["experimental"]["serverIdleShutdownV1"], true);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    assert!(server.response(2).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"server/resources/read","params":{}}));
    let instance = server.response(3)["result"]["instanceId"].clone();
    for (id, params) in [(4, json!({})), (5, json!({"instanceId":"stale"})), (6, json!({"instanceId":instance,"extra":true}))] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"server/shutdown/idle","params":params}));
        assert_eq!(server.response(id)["error"]["code"], -32602);
    }
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"cron/create","params":{
        "prompt":"isolated future fixture", "confirmed":true,
        "schedule":{"kind":"every","every_seconds":3600}, "jitterSeconds":0
    }}));
    let created = server.response(7);
    let job = created["result"]["job"]["id"].as_str().expect("cron fixture created").to_owned();
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"server/shutdown/idle","params":{"instanceId":instance}}));
    assert_eq!(server.response(8)["result"]["accepted"], false);
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"cron/delete","params":{"jobId":job}}));
    assert!(server.response(9).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"server/shutdown/idle","params":{"instanceId":instance}}));
    assert_eq!(server.response(10)["result"]["accepted"], true);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(std::time::Instant::now() < deadline, "idle shutdown did not exit with stdin open");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

// Resource attribution is independent of model behavior; no turn is started.
#[cfg(unix)]
#[test]
fn process_resources_are_available_without_a_thread_and_report_target_pid() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let settings = temp.path().join("settings.jsonc");
    write_test_settings(&settings);
    let mut guard = DiagnosticProcessGuard(TestAppServer::builder(&workspace, &settings)
        .config_dir(&temp.path().join("config"))
        .scenario("markdown-showcase").discard_stderr().spawn());
    let server = &mut guard.0;
    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["serverResourceSnapshotV1"], true);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"server/resources/read","params":{}}));
    let response = server.response(2);
    assert_eq!(response["result"]["processId"], server.child.id());
    #[cfg(target_os = "linux")]
    assert!(response["result"]["residentBytes"].as_u64().unwrap() > 0);
    #[cfg(not(target_os = "linux"))]
    assert!(response["result"]["residentBytes"].is_null());
    assert_eq!(response["result"]["activityComplete"], false);
    assert_eq!(response["result"]["activity"]["residentThreads"], 0);
    assert_eq!(response["result"]["activity"]["runningTurns"], 0);
    assert_eq!(response["result"]["activity"]["terminalSessions"], 0);
    assert_eq!(response["result"]["activity"]["browserSessions"], 0);
    assert_eq!(response["result"]["activity"]["pendingAutomationRequests"], 0);
    assert_eq!(response["result"]["activity"]["automationSubscribed"], false);
    assert!(response["result"]["activity"]["cachedScheduledJobs"].is_null());
    for field in ["registeredBackgroundJobs", "backgroundCancellationMarkers", "registeredPrefires"] {
        assert_eq!(response["result"]["activity"][field], 0);
    }
    for field in ["pendingApprovals", "pendingQuestions", "queuedFollowups", "pendingGoalContinuations"] {
        assert_eq!(response["result"]["activity"][field], 0);
    }
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"server/resources/read","params":{"pid":1}}));
    assert_eq!(server.response(3)["error"]["code"], -32602);
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}));
    assert!(server.response(4).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"server/resources/read","params":{}}));
    let next = server.response(5);
    assert_eq!(next["result"]["activity"]["residentThreads"], 1);
    assert_eq!(next["result"]["instanceId"], response["result"]["instanceId"]);
    assert!(next["result"]["reclaimable"].is_null());
}

#[cfg(unix)]
impl Drop for DiagnosticProcessGuard {
    fn drop(&mut self) {
        if self.0.child.try_wait().ok().flatten().is_none() {
            let _ = self.0.child.kill();
            let _ = self.0.child.wait();
        }
    }
}

#[cfg(unix)]
#[test]
fn diagnostic_sigterm_exits_with_stdin_open_and_preserves_completed_exchange() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let settings = temp.path().join("settings.jsonc");
    write_test_settings(&settings);
    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&temp.path().join("config"))
        .scenario("markdown-showcase")
        .stream_delay_ms("0")
        .discard_stderr();
    // Disable unrelated maintenance calls while exercising the normal diagnostic path.
    builder.training_mode = true;
    let mut guard = DiagnosticProcessGuard(builder.spawn());
    let server = &mut guard.0;
    assert!(server.initialize(1).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let response = server.response(2);
    let thread_id = response["result"]["thread"]["id"]
        .as_str()
        .expect("thread/start must succeed")
        .to_owned();
    server.send(json!({
        "jsonrpc":"2.0","id":3,"method":"turn/start",
        "params":{"threadId":thread_id,"input":[{"type":"text","text":"diagnostic exit fixture"}]}
    }));
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(completed["params"]["turn"]["status"], "completed");
    let usage_path = find_named_file(temp.path(), "usage.json")
        .expect("completed attempt must have reliable usage");
    let usage_before: Value = serde_json::from_slice(&std::fs::read(&usage_path).unwrap()).unwrap();

    assert!(server.stdin.is_some(), "SIGTERM must not rely on stdin EOF");
    let child_pid = i32::try_from(server.child.id()).unwrap();
    // SAFETY: This PID identifies the child process owned by this test guard.
    assert_eq!(unsafe { libc::kill(child_pid, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success(), "SIGTERM shutdown failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "SIGTERM shutdown exceeded its deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let usage_after: Value = serde_json::from_slice(&std::fs::read(&usage_path).unwrap()).unwrap();
    assert_eq!(
        usage_after, usage_before,
        "shutdown must not add a model request"
    );
    let history = find_named_file(temp.path(), &format!("{thread_id}.jsonl"))
        .expect("completed thread history must remain available");
    let directory =
        kcoder_state::llm_request_history_dir_path(history.parent().unwrap(), &thread_id);
    let records = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["schema"], "kcoder.llm_exchange.v2");
    assert_eq!(records[0]["session_id"], thread_id);
    assert!(!workspace.join(".kcoder").exists());
}

#[cfg(unix)]
#[test]
fn diagnostic_ephemeral_sigterm_releases_current_engine_owner_after_flush() {
    let fixture = tempfile::tempdir().unwrap();
    let workspace = fixture.path().join("workspace");
    let child_temp = fixture.path().join("child-temp");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&child_temp).unwrap();
    let settings = fixture.path().join("settings.jsonc");
    write_test_settings(&settings);
    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&fixture.path().join("config"))
        .temp_dir(&child_temp)
        .scenario("markdown-showcase")
        .stream_delay_ms("0")
        .discard_stderr();
    builder.training_mode = true;
    let mut guard = DiagnosticProcessGuard(builder.spawn());
    let server = &mut guard.0;
    assert!(server.initialize(1).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let source = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
            "threadId":source,"input":[{"type":"text","text":"persistent source fixture"}]
        }}),
    );
    assert!(server.response(3)["result"].is_object());
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    server.send(
        json!({"jsonrpc":"2.0","id":4,"method":"thread/fork","params":{
            "threadId":source,"ephemeral":true
        }}),
    );
    let forked = server.response(4);
    assert_eq!(forked["result"]["ephemeral"], true);
    let child = forked["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{
            "threadId":child,"input":[{"type":"text","text":"ephemeral current alias fixture"}]
        }}),
    );
    assert!(server.response(5)["result"].is_object());
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );

    let child_history = find_named_file(&child_temp, &format!("{child}.jsonl"))
        .expect("ephemeral history must live inside this child's private temporary directory");
    let ephemeral_root = child_history.parent().unwrap().to_path_buf();
    assert!(ephemeral_root.starts_with(&child_temp));
    assert!(
        ephemeral_root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("kcoder-ephemeral-thread-")
    );
    let usage_path = find_named_file(fixture.path(), "usage.json").unwrap();
    let usage_before: Value = serde_json::from_slice(&std::fs::read(&usage_path).unwrap()).unwrap();
    assert!(server.stdin.is_some());
    let child_pid = i32::try_from(server.child.id()).unwrap();
    // SAFETY: The test guard owns this exact child process and reaps it on failure.
    assert_eq!(unsafe { libc::kill(child_pid, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success(), "SIGTERM shutdown failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "ephemeral SIGTERM shutdown exceeded its deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !ephemeral_root.exists(),
        "SIGTERM must release the current ephemeral Engine owner"
    );
    let usage_after: Value = serde_json::from_slice(&std::fs::read(&usage_path).unwrap()).unwrap();
    assert_eq!(
        usage_after, usage_before,
        "owner cleanup must not add a model request"
    );
    let source_history = find_named_file(fixture.path(), &format!("{source}.jsonl")).unwrap();
    let directory =
        kcoder_state::llm_request_history_dir_path(source_history.parent().unwrap(), &source);
    let records = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["schema"], "kcoder.llm_exchange.v2");
    assert_eq!(records[0]["session_id"], source);
    assert!(!workspace.join(".kcoder").exists());
}
