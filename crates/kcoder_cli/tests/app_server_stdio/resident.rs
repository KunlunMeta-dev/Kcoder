#[test]
#[cfg(unix)]
fn resident_resume_after_hook_rejection_does_not_commit_a_missing_user_turn() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    std::fs::create_dir_all(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["hooks"] = json!({"UserPromptSubmit":[{"hooks":[{
        "type":"command", "shell":"sh", "timeout":5,
        "command":"read -r input; case \"$input\" in *allowed*) echo '{}';; *) echo 'blocked by test hook' >&2; exit 2;; esac"
    }]}]});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":"blocked"}]}}));
    assert_eq!(server.response(3)["result"]["turn"]["id"], "turn-1");
    let failed = server.wait_for_method("turn/completed");
    assert_eq!(failed["params"]["turn"]["status"], "failed");
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/resume","params":{"threadId":id}}));
    assert!(server.response(4)["result"]["thread"].is_object());
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":"allowed"}]}}));
    assert_eq!(server.response(5)["result"]["turn"]["id"], "turn-1");
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
    server.send(
        json!({"jsonrpc":"2.0","id":6,"method":"thread/read","params":{"threadId":id,"limit":20}}),
    );
    let transcript = server.response(6).to_string();
    assert!(transcript.contains("allowed"));
    assert!(!transcript.contains("blocked by test hook"));
    server.shutdown();
}

#[test]
fn resident_resume_keeps_durable_turn_count_without_reopening_transcript() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut creator =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    creator.initialize(1);
    creator.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let id = creator.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    creator.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":"one"}]}}));
    creator.response(3);
    creator.wait_for_method("turn/completed");
    creator.shutdown();
    let path =
        wait_for_named_file(temp.path(), &format!("{id}.jsonl"), Duration::from_secs(5)).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let state = kcoder_state::AppState::new(temp.path());
        state.resume_from_history(&path).unwrap();
        for text in ["two", "three"] {
            state.add_message(kcoder_types::Message::user_text(text));
            state.add_message(kcoder_types::Message::assistant_text("answer"));
        }
        state
            .set_messages_after_compaction(
                vec![kcoder_types::Message::user_text(
                    "Earlier conversation summary: compacted",
                )],
                kcoder_state::CompactionTranscriptEvent {
                    trigger: kcoder_state::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "compacted".into(),
                },
            )
            .await
            .unwrap();
    });
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{"threadId":id}}));
    assert!(server.response(2)["result"]["thread"].is_object());
    // Fault injection only on this test's owned transcript. Restore it before any new turn.
    let parked = path.with_extension("parked");
    std::fs::rename(&path, &parked).unwrap();
    for request in 3..8 {
        server.send(
            json!({"jsonrpc":"2.0","id":request,"method":"thread/resume","params":{"threadId":id}}),
        );
        assert!(server.response(request)["result"]["thread"].is_object());
    }
    std::fs::rename(&parked, &path).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":"four"}]}}));
    assert_eq!(server.response(8)["result"]["turn"]["id"], "turn-4");
    server.wait_for_method("turn/completed");
    server.shutdown();
}

#[test]
fn automatic_followup_only_serializes_its_own_thread_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start_scenario(
        temp.path(),
        &settings,
        "subagent-trace",
        "10",
        "300",
        "1000",
    );
    server.initialize(1);

    // Persist a non-current thread first to cover final rechecking inside the Persisted resume gate.
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let persisted_thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": persisted_thread_id, "input": [{"type": "text", "text": "prepare persisted thread"}]}
    }));
    let persisted_turn_id = server.response(3)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/completed" && value["params"]["turn"]["id"] == persisted_turn_id
        {
            break;
        }
    }
    server.send(json!({
        "jsonrpc": "2.0", "id": 40, "method": "thread/read",
        "params": {"threadId": persisted_thread_id, "limit": 100}
    }));
    let baseline_model = server.response(40)["result"]["thread"]["model"].clone();

    server.send(json!({"jsonrpc": "2.0", "id": 4, "method": "thread/start", "params": {}}));
    let current_thread_id = server.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": current_thread_id, "input": [{"type": "text", "text": "app-server-background-subagent"}]}
    }));
    server.response(5);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/started"
            && value["params"]["turn"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("background-followup-"))
        {
            break;
        }
    }

    // Automatic follow-up occupies only its owning thread and must not block creation or recovery of other resident threads.
    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/start",
        "params": {}
    }));
    assert!(server.response(6)["result"]["thread"]["id"].is_string());
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/resume",
        "params": {"threadId": current_thread_id}
    }));
    let resumed_current = server.response(7);
    assert_eq!(resumed_current["result"]["thread"]["id"], current_thread_id);
    assert_eq!(resumed_current["result"]["thread"]["status"], "running");
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "thread/resume",
        "params": {"threadId": persisted_thread_id}
    }));
    assert_eq!(
        server.response(8)["result"]["thread"]["id"],
        persisted_thread_id
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "thread/read",
        "params": {"threadId": current_thread_id, "limit": 100}
    }));
    assert_eq!(
        server.response(9)["result"]["thread"]["model"],
        baseline_model,
        "恢复另一条 thread 不得污染正在运行的自动聚合轮模型"
    );
    server.shutdown();
}

#[test]
fn resident_threads_run_concurrently_and_interrupt_is_thread_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "full-turn", "200", "0", "0");
    server.initialize(1);

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let first = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({"jsonrpc": "2.0", "id": 3, "method": "thread/start", "params": {}}));
    let second = server.response(3)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": first, "input": [{"type": "text", "text": "first concurrent turn"}]}
    }));
    let first_turn = server.response(4)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": second, "input": [{"type": "text", "text": "second concurrent turn"}]}
    }));
    let second_turn = server.response(5)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // One thread still permits only one foreground turn.
    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "turn/start",
        "params": {"threadId": first, "input": [{"type": "text", "text": "must be rejected"}]}
    }));
    assert_eq!(server.response(6)["error"]["code"], -32003);

    for (id, thread_id, turn_id) in [
        (61, first.as_str(), "wrong-turn"),
        (62, "wrong-thread", first_turn.as_str()),
    ] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "turn/interrupt",
            "params": {"threadId": thread_id, "turnId": turn_id}
        }));
        assert_eq!(server.response(id)["result"]["interrupted"], false);
    }
    server.send(json!({"jsonrpc":"2.0","id":64,"method":"thread/list","params":{}}));
    let running = server.response(64);
    for thread_id in [&first, &second] {
        assert!(
            running["result"]["threads"]
                .as_array()
                .unwrap()
                .iter()
                .any(|thread| { thread["id"] == *thread_id && thread["status"] == "running" })
        );
    }

    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "turn/interrupt",
        "params": {"threadId": first, "turnId": first_turn}
    }));
    assert_eq!(server.response(7)["result"]["interrupted"], true);

    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "turn/interrupt",
        "params": {"threadId": first, "turnId": first_turn}
    }));
    assert_eq!(server.response(8)["result"]["interrupted"], false);

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "turn/completed"
            && value["params"]["threadId"] == second
            && value["params"]["turn"]["id"] == second_turn
        {
            assert_eq!(value["params"]["turn"]["status"], "completed");
            break;
        }
    }
    server.shutdown();
}


#[test]
fn shorten_wait_reports_and_does_not_cancel_the_running_turn() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "full-turn", "200", "0", "0");
    server.initialize(1);

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "turn with a wait tool"}]}
    }));
    let turn_id = server.response(3)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // shorten_wait NEVER cancels the turn — it only collapses a running
    // Sleep/wait's remaining wait. Without a shortenable tool in flight it is
    // still a benign ack, and the turn must keep running either way.
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/shorten_wait",
        "params": {"threadId": thread_id, "turnId": turn_id}
    }));
    assert_eq!(server.response(4)["result"]["shortened"], true);

    server.send(json!({"jsonrpc":"2.0","id":5,"method":"thread/list","params":{}}));
    let running = server.response(5);
    assert!(running["result"]["threads"].as_array().unwrap().iter().any(
        |thread| { thread["id"] == thread_id && thread["status"] == "running" }
    ));

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "turn/interrupt",
        "params": {"threadId": thread_id, "turnId": turn_id}
    }));
    assert_eq!(server.response(6)["result"]["interrupted"], true);

    server.shutdown();
}

#[test]
fn wrong_interrupt_does_not_cancel_but_connection_close_cancels_the_turn() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "full-turn", "2000", "0", "0");
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
            "threadId":thread_id,"input":[{"type":"text","text":"disconnect cancellation fixture"}]
        }}),
    );
    let turn_id = server.response(3)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.wait_for_method("item/started");
    server.send(
        json!({"jsonrpc":"2.0","id":4,"method":"turn/interrupt","params":{
            "threadId":thread_id,"turnId":"wrong-turn"
        }}),
    );
    assert_eq!(server.response(4)["result"]["interrupted"], false);
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"server/info","params":{}}));
    let info = server.response(5)["result"].clone();
    assert_eq!(info["status"], "running");
    server.send(
        json!({"jsonrpc":"2.0","id":6,"method":"thread/read","params":{"threadId":thread_id}}),
    );
    let read = server.response(6)["result"]["thread"].clone();
    assert_eq!(read["status"], "running");
    assert_eq!(read["createdAt"], info["createdAt"]);
    assert_eq!(read["updatedAt"], info["updatedAt"]);
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"thread/list","params":{}}));
    let list = server.response(7);
    let listed = list["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == thread_id)
        .unwrap();
    assert_eq!(listed["status"], "running");
    assert_eq!(listed["createdAt"], info["createdAt"]);
    assert_eq!(listed["updatedAt"], info["updatedAt"]);
    drop(server.stdin.take());
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(completed["params"]["threadId"], thread_id);
    assert_eq!(completed["params"]["turn"]["id"], turn_id);
    assert_eq!(completed["params"]["turn"]["status"], "interrupted");
    server.shutdown();
}

#[test]
fn resident_thread_read_is_empty_before_its_first_history_flush() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 100}
    }));
    let transcript = server.response(3);

    assert_eq!(transcript["result"]["thread"]["id"], thread_id);
    assert_eq!(transcript["result"]["messages"], json!([]));
    server.shutdown();
}

#[test]
fn one_app_server_keeps_multiple_threads_resident_and_routes_status_delete_and_turns() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "full-turn", "100", "0", "0");
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["residentThreads"],
        true
    );

    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let first = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": first, "input": [{"type": "text", "text": "first resident turn"}]}
    }));
    server.response(3);
    server.wait_for_method("turn/completed");

    server.send(json!({"jsonrpc": "2.0", "id": 4, "method": "thread/start", "params": {}}));
    let second = server.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": second, "input": [{"type": "text", "text": "second resident turn"}]}
    }));
    server.response(5);
    server.wait_for_method("turn/completed");

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/resume",
        "params": {"threadId": first}
    }));
    assert_eq!(server.response(6)["result"]["thread"]["id"], first);
    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "turn/start",
        "params": {"threadId": first, "input": [{"type": "text", "text": "first resident again"}]}
    }));
    assert_eq!(server.response(7)["result"]["turn"]["id"], "turn-2");
    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "thread/read",
        "params": {"threadId": second, "limit": 100}
    }));
    assert_eq!(server.response(8)["result"]["thread"]["status"], "idle");
    server.wait_for_method("turn/completed");

    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "thread/delete",
        "params": {"threadId": second}
    }));
    assert_eq!(server.response(9)["result"]["deleted"], true);
    server.send(json!({
        "jsonrpc": "2.0", "id": 10, "method": "thread/resume",
        "params": {"threadId": second}
    }));
    assert!(server.response(10)["error"].is_object());

    server.send(json!({"jsonrpc": "2.0", "id": 11, "method": "thread/start", "params": {}}));
    let empty = server.response(11)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 12, "method": "thread/delete",
        "params": {"threadId": empty}
    }));
    assert_eq!(server.response(12)["result"]["deleted"], true);
    server.send(json!({
        "jsonrpc": "2.0", "id": 13, "method": "thread/resume",
        "params": {"threadId": empty}
    }));
    assert!(server.response(13)["error"].is_object());
    server.send(json!({
        "jsonrpc": "2.0", "id": 14, "method": "server/info", "params": {}
    }));
    assert_eq!(
        server.response(14)["result"]["id"],
        first,
        "server/info must select the most recently used remaining resident"
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 15, "method": "thread/delete",
        "params": {"threadId": first}
    }));
    assert_eq!(server.response(15)["result"]["deleted"], true);
    server.send(json!({
        "jsonrpc": "2.0", "id": 16, "method": "server/info", "params": {}
    }));
    assert_eq!(server.response(16)["error"]["code"], -32022);
    server.shutdown();
}

#[test]
fn capacity_rejection_does_not_apply_persisted_resume_sidecar_mutations() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut creator = TestAppServer::start(temp.path(), &settings);
    creator.initialize(1);
    creator.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let persisted_id = creator.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    creator.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": persisted_id, "input": [{"type": "text", "text": "persist capacity fixture"}]}
    }));
    creator.response(3);
    creator.wait_for_method("turn/completed");
    creator.shutdown();

    let history_path = wait_for_named_file(
        temp.path(),
        &format!("{persisted_id}.jsonl"),
        Duration::from_secs(5),
    )
    .unwrap();
    let state_path =
        kcoder_state::session_state_path(history_path.parent().unwrap(), &persisted_id);
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let mut running = kcoder_state::Task::new("capacity-running", "容量拒绝不得中断");
    running.managed = true;
    running.delivery = kcoder_state::TaskDelivery::Background;
    running.status = kcoder_state::TaskStatus::Running;
    state
        .as_object_mut()
        .unwrap()
        .entry("tasks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap()
        .insert(
            "capacity-running".to_string(),
            serde_json::to_value(running).unwrap(),
        );
    std::fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    let before = std::fs::read(&state_path).unwrap();

    let mut server = TestAppServer::start_with_resident_limit(temp.path(), &settings, 1);
    server.initialize(10);
    server.send(json!({"jsonrpc": "2.0", "id": 11, "method": "thread/start", "params": {}}));
    server.response(11);
    server.send(json!({
        "jsonrpc": "2.0", "id": 12, "method": "thread/resume",
        "params": {"threadId": persisted_id}
    }));
    assert_eq!(server.response(12)["error"]["code"], -32039);
    assert_eq!(std::fs::read(&state_path).unwrap(), before);
    server.shutdown();
}

#[test]
fn workspace_model_catalog_does_not_follow_selected_resident_thread() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut configured: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    configured["providers"]["z-resident-test"] = json!({
        "api_format": "openai_chat_completions",
        "endpoint": "http://127.0.0.1:1/v1",
        "default_model": "resident-thread-selected-model",
        "context_window_tokens": 128000,
        "output_headroom_tokens": 8192,
        "max_output_tokens": 8192,
        "request_timeout_secs": 30,
        "no_proxy": true,
        "extra_body": {}
    });
    std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
    std::fs::create_dir_all(temp.path().join("config")).unwrap();
    std::fs::write(
        temp.path().join("config/credentials.json"),
        serde_json::to_vec(&json!({
            "z-resident-test": {"type": "api", "key": "test-only"}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "runtime.models.list", "params": {}
    }));
    let baseline = server.response(2)["result"].clone();

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "thread/start",
        "params": {"model": "z-resident-test"}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    assert_eq!(
        started["result"]["thread"]["model"],
        "z-resident-test::resident-thread-selected-model"
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "runtime.models.list", "params": {}
    }));
    assert_eq!(
        server.response(4)["result"],
        baseline,
        "工作区模型目录不得随当前选中的 resident thread 漂移"
    );
    server.shutdown();
}

#[test]
fn turn_file_changes_commands_route_to_the_explicit_resident_thread() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "KCoder Test"]);
    git(&["config", "user.email", "kcoder@example.invalid"]);
    std::fs::write(temp.path().join("README.md"), "fixture\n").unwrap();
    git(&["add", "README.md"]);
    git(&["commit", "-m", "fixture"]);

    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    let mut create_thread = |start_id: i64, turn_id: i64, prompt: &str| {
        server.send(
            json!({"jsonrpc": "2.0", "id": start_id, "method": "thread/start", "params": {}}),
        );
        let thread_id = server.response(start_id)["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        server.send(json!({
            "jsonrpc": "2.0", "id": turn_id, "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type": "text", "text": prompt}]}
        }));
        server.response(turn_id);
        server.wait_for_method("turn/completed");
        thread_id
    };
    let thread_a = create_thread(2, 3, "persist A");
    let thread_b = create_thread(4, 5, "persist B and leave it selected");

    let history_a = wait_for_named_file(
        temp.path(),
        &format!("{thread_a}.jsonl"),
        Duration::from_secs(5),
    )
    .unwrap();
    std::fs::write(temp.path().join("a.txt"), "a\n").unwrap();
    std::fs::write(temp.path().join("b.txt"), "b\n").unwrap();
    let artifact_a = "a".repeat(64);
    let artifact_b = "b".repeat(64);
    let patch_a = write_turn_file_changes_fixture(
        history_a.parent().unwrap(),
        temp.path(),
        &thread_a,
        &artifact_a,
        "a.txt",
    );
    let patch_b = write_turn_file_changes_fixture(
        history_a.parent().unwrap(),
        temp.path(),
        &thread_b,
        &artifact_b,
        "b.txt",
    );

    for (id, thread_id, artifact_id, expected_patch) in [
        (6, &thread_a, &artifact_a, &patch_a),
        (7, &thread_b, &artifact_b, &patch_b),
    ] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "device/execute",
            "params": {
                "command_key": "turn_file_changes_review",
                "threadId": thread_id,
                "path": temp.path(),
                "args": [artifact_id]
            }
        }));
        assert_eq!(
            server.response(id)["result"]["stdout"]["diff"],
            *expected_patch
        );
    }

    server.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "device/execute",
        "params": {
            "command_key": "turn_file_changes_revert",
            "threadId": thread_a,
            "path": temp.path(),
            "args": [artifact_a]
        }
    }));
    assert_eq!(
        server.response(8)["result"]["stdout"]["file_changes"]["status"],
        "reverted"
    );
    assert!(!temp.path().join("a.txt").exists());
    assert!(temp.path().join("b.txt").exists());

    server.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "device/execute",
        "params": {
            "command_key": "turn_file_changes_review",
            "threadId": thread_b,
            "path": temp.path(),
            "args": [artifact_a]
        }
    }));
    assert!(server.response(9)["error"].is_object());
    server.send(json!({
        "jsonrpc": "2.0", "id": 10, "method": "device/execute",
        "params": {
            "command_key": "turn_file_changes_review",
            "path": temp.path(),
            "args": [artifact_a]
        }
    }));
    assert!(
        server.response(10)["error"].is_object(),
        "多线程下旧请求必须 fail closed"
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 11, "method": "thread/delete",
        "params": {"threadId": thread_b}
    }));
    assert_eq!(server.response(11)["result"]["deleted"], true);
    server.send(json!({
        "jsonrpc": "2.0", "id": 12, "method": "device/execute",
        "params": {
            "command_key": "turn_file_changes_review",
            "path": temp.path(),
            "args": [artifact_a]
        }
    }));
    assert_eq!(server.response(12)["result"]["stdout"]["diff"], patch_a);
    server.shutdown();
}
