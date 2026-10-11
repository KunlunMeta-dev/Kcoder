#[test]
fn stdio_app_server_streams_a_deterministic_turn() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({
            "active_provider": "integration-test",
            "providers": {
                "integration-test": {
                    "api_format": "openai_chat_completions",
                    "endpoint": "http://127.0.0.1:1/v1",
                    "default_model": "deterministic-scenario",
                    "context_window_tokens": 128000,
                    "output_headroom_tokens": 8192,
                    "max_output_tokens": 8192,
                    "request_timeout_secs": 30,
                    "no_proxy": true,
                    "extra_body": {}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let config = temp.path().join("config");
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .stream_delay_ms("1")
        .spawn();
    server.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "integration-test", "version": "1"}}
        }),
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}})
    ]);

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut messages = Vec::<Value>::new();
    while !messages
        .iter()
        .any(|message| message["id"] == 2 && message["result"]["thread"]["id"].is_string())
    {
        messages.push(server.next_value(deadline));
    }
    let active_thread_id = messages
        .iter()
        .find(|message| message["id"] == 2)
        .and_then(|message| message["result"]["thread"]["id"].as_str())
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {
            "threadId": active_thread_id,
            "clientMessageId": "client-message-1",
            "input": [{"type": "text", "text": "hello studio"}]
        }
    }));

    while Instant::now() < deadline {
        let message = server.next_value(deadline);
        let completed = message.get("method").and_then(Value::as_str) == Some("turn/completed");
        messages.push(message);
        if completed {
            break;
        }
    }

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/fork",
        "params": {
            "threadId": active_thread_id,
            "lastTurnId": "turn-1",
            "cwd": temp.path(),
            "excludeTurns": true
        }
    }));
    let fork_response = server.response(4);
    let forked: Response<ThreadForkResult> = serde_json::from_value(fork_response.clone()).unwrap();
    let fork_thread_id = match forked.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => result.thread.id,
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/fork failed: {}", error.message)
        }
    };
    assert_ne!(fork_thread_id, active_thread_id);
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/read",
        "params": {"threadId": fork_thread_id, "limit": 50}
    }));
    let fork_transcript: Response<ThreadReadResult> =
        serde_json::from_value(server.response(5)).unwrap();
    assert!(matches!(
        fork_transcript.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.messages.iter().any(|message| {
                message.role == "user"
                    && message.content == "hello studio"
                    && message.client_message_id.as_deref() == Some("client-message-1")
            })
    ));
    messages.push(fork_response);

    assert!(
        messages
            .iter()
            .any(|message| message["id"] == 1 && message.get("result").is_some())
    );
    assert!(
        messages
            .iter()
            .any(|message| message["id"] == 2 && message["result"]["thread"]["id"].is_string())
    );
    assert!(
        messages
            .iter()
            .any(|message| message["id"] == 3 && message["result"]["turn"]["status"] == "running")
    );
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == "item/started"
                && message["params"]["item"]["type"] == "agentMessage")
    );
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == "item/delta"
                && message["params"]["delta"]["text"].is_string())
    );
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == "item/started"
                && message["params"]["item"]["type"] == "toolCall")
    );
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == "turn/completed")
    );

    let response = |id| {
        messages
            .iter()
            .find(|message| message["id"] == id)
            .unwrap()
            .clone()
    };
    serde_json::from_value::<Response<InitializeResult>>(response(1)).unwrap();
    let first_thread: Response<ThreadStartResult> = serde_json::from_value(response(2)).unwrap();
    let first_thread_id = match first_thread.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => result.thread.id,
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/start failed: {}", error.message)
        }
    };
    serde_json::from_value::<Response<TurnStartResult>>(response(3)).unwrap();
    for message in messages
        .iter()
        .filter(|message| message.get("method").is_some())
    {
        match message["method"].as_str().unwrap() {
            "thread/started" => {
                serde_json::from_value::<Notification<ThreadStartedParams>>(message.clone())
                    .unwrap();
            }
            "turn/started" => {
                serde_json::from_value::<Notification<TurnStartedParams>>(message.clone()).unwrap();
            }
            "turn/completed" => {
                serde_json::from_value::<Notification<TurnCompletedParams>>(message.clone())
                    .unwrap();
            }
            "item/started" => {
                serde_json::from_value::<Notification<ItemStartedParams>>(message.clone()).unwrap();
            }
            "item/delta" => {
                serde_json::from_value::<Notification<ItemDeltaParams>>(message.clone()).unwrap();
            }
            "item/completed" => {
                serde_json::from_value::<Notification<ItemCompletedParams>>(message.clone())
                    .unwrap();
            }
            "item/event" => {}
            method => panic!("unexpected notification method: {method}"),
        }
    }

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/goal/set",
        "params": {
            "threadId": first_thread_id,
            "objective": "shared readonly goal",
            "mode": "standard",
            "verificationKind": "artifact"
        }
    }));
    let goal_set: Response<ThreadGoalSetResult> =
        serde_json::from_value(server.response(6)).unwrap();
    assert!(matches!(
        goal_set.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.goal.objective == "shared readonly goal"
    ));

    let mut contender = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    contender.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 20, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "lease-contender", "version": "1"}}
        }),
        json!({
            "jsonrpc": "2.0", "id": 21, "method": "thread/resume",
            "params": {"threadId": first_thread_id}
        }),
        json!({
            "jsonrpc": "2.0", "id": 22, "method": "thread/goal/get",
            "params": {"threadId": first_thread_id}
        })
    ]);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut lease_error = None;
    let mut readonly_goal = None;
    while lease_error.is_none() || readonly_goal.is_none() {
        let message = contender.next_value(deadline);
        if message["id"] == 21 {
            lease_error = Some(message);
        } else if message["id"] == 22 {
            readonly_goal = Some(message);
        }
    }
    let lease_error = lease_error.unwrap();
    assert_eq!(lease_error["error"]["code"], -32022);
    assert!(
        lease_error["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("already active")
    );
    let readonly_goal: Response<ThreadGoalGetResult> =
        serde_json::from_value(readonly_goal.unwrap()).unwrap();
    assert!(matches!(
        readonly_goal.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.goal.as_ref().is_some_and(|goal| goal.objective == "shared readonly goal")
    ));
    contender.shutdown_successfully();

    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/goal/clear",
        "params": {"threadId": first_thread_id}
    }));
    let goal_clear: Response<ThreadGoalClearResult> =
        serde_json::from_value(server.response(7)).unwrap();
    assert!(matches!(
        goal_clear.payload,
        kcoder_app_protocol::ResponsePayload::Success { result } if result.cleared
    ));

    server.shutdown();

    let history_path = wait_for_named_file(
        temp.path(),
        &format!("{first_thread_id}.jsonl"),
        Duration::from_secs(2),
    )
    .expect("first app-server must persist its thread history externally");
    let project_dir = history_path.parent().unwrap();
    let checkpoint_turn = project_dir
        .join("client-sessions")
        .join(&first_thread_id)
        .join("checkpoints")
        .join("2");
    std::fs::create_dir_all(&checkpoint_turn).unwrap();
    let rewind_fixture = temp.path().join("resume-rewind-fixture.txt");
    std::fs::write(&rewind_fixture, b"mutated after checkpoint").unwrap();
    std::fs::write(
        checkpoint_turn.join("fixture.snap"),
        b"original before turn 2",
    )
    .unwrap();
    std::fs::write(
        checkpoint_turn.join("meta.json"),
        serde_json::to_vec_pretty(&json!({
            "turn": 2,
            "files": [{
                "path": rewind_fixture,
                "snapshot": "fixture.snap",
                "existed": true
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let mut resumed = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .stream_delay_ms("1")
        .spawn();
    resumed.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 10, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "resume-test", "version": "1"}}
        }),
        json!({
            "jsonrpc": "2.0", "id": 16, "method": "turn/start",
            "params": {"threadId": first_thread_id, "input": [{"type": "text", "text": "must acquire a lease"}]}
        }),
        json!({"jsonrpc": "2.0", "id": 11, "method": "thread/list", "params": {}}),
        json!({
            "jsonrpc": "2.0", "id": 14, "method": "thread/read",
            "params": {"threadId": first_thread_id, "limit": 50}
        }),
        json!({
            "jsonrpc": "2.0", "id": 12, "method": "thread/resume",
            "params": {"threadId": first_thread_id}
        }),
        json!({
            "jsonrpc": "2.0", "id": 15, "method": "turn/start",
            "params": {"threadId": "wrong-thread", "input": [{"type": "text", "text": "must match"}]}
        }),
        json!({
            "jsonrpc": "2.0", "id": 13, "method": "turn/start",
            "params": {"threadId": first_thread_id, "input": [{"type": "text", "text": "continued after restart"}]}
        }),
        json!({
            "jsonrpc": "2.0", "id": 17, "method": "thread/compact",
            "params": {"threadId": first_thread_id}
        }),
        json!({
            "jsonrpc": "2.0", "id": 18, "method": "thread/rollback",
            "params": {"threadId": first_thread_id}
        }),
    ]);

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut resumed_messages = Vec::<Value>::new();
    while Instant::now() < deadline {
        let message = resumed.next_value(deadline);
        let completed = message.get("method").and_then(Value::as_str) == Some("turn/completed");
        resumed_messages.push(message);
        if completed {
            break;
        }
    }
    let resumed_response = |id| {
        resumed_messages
            .iter()
            .find(|message| message["id"] == id)
            .unwrap_or_else(|| panic!("missing response {id}: {resumed_messages:#?}"))
            .clone()
    };
    let listed: Response<ThreadListResult> = serde_json::from_value(resumed_response(11)).unwrap();
    let listed = match listed.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => result,
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/list failed: {}", error.message)
        }
    };
    assert!(
        listed
            .threads
            .iter()
            .any(|thread| thread.id == first_thread_id)
    );
    let transcript: Response<ThreadReadResult> =
        serde_json::from_value(resumed_response(14)).unwrap();
    match transcript.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert_eq!(result.thread.id, first_thread_id);
            assert!(
                result
                    .messages
                    .iter()
                    .any(|message| message.role == "user" && message.content == "hello studio")
            );
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/read failed: {}", error.message)
        }
    }
    let resumed_result: Response<ThreadResumeResult> =
        serde_json::from_value(resumed_response(12)).unwrap();
    match resumed_result.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert_eq!(result.thread.id, first_thread_id)
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/resume failed: {}", error.message)
        }
    }
    assert_eq!(resumed_response(16)["error"]["code"], -32024);
    assert_eq!(resumed_response(15)["error"]["code"], -32025);
    assert_eq!(resumed_response(17)["error"]["code"], -32030);
    assert_eq!(resumed_response(18)["error"]["code"], -32031);
    serde_json::from_value::<Response<TurnStartResult>>(resumed_response(13)).unwrap();
    assert!(
        resumed_messages
            .iter()
            .any(|message| message["method"] == "turn/completed")
    );

    resumed.send(json!({
        "jsonrpc": "2.0", "id": 28, "method": "thread/goal/set",
        "params": {
            "threadId": first_thread_id,
            "objective": "must not be created",
            "mode": "strict",
            "verificationKind": "answer",
            "status": "complete"
        }
    }));
    assert_eq!(resumed.response(28)["error"]["code"], -32033);
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 29, "method": "thread/goal/get",
        "params": {"threadId": first_thread_id}
    }));
    let rejected_create_state: Response<ThreadGoalGetResult> =
        serde_json::from_value(resumed.response(29)).unwrap();
    assert!(matches!(
        rejected_create_state.payload,
        kcoder_app_protocol::ResponsePayload::Success { result } if result.goal.is_none()
    ));

    resumed.send(json!({
        "jsonrpc": "2.0", "id": 30, "method": "thread/goal/set",
        "params": {"threadId": first_thread_id, "objective": "finish parity", "mode": "strict", "verificationKind": "answer", "tokenBudget": 2000, "requireNoGoal": true}
    }));
    let set_goal: Response<ThreadGoalSetResult> =
        serde_json::from_value(resumed.response(30)).unwrap();
    let created_goal = match set_goal.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert_eq!(result.goal.objective, "finish parity");
            assert_eq!(result.goal.mode, "strict");
            assert_eq!(result.goal.verification_kind, "answer");
            assert_eq!(result.goal.token_budget, Some(2000));
            assert!(!result.goal.goal_id.is_empty());
            result.goal
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/goal/set failed: {}", error.message)
        }
    };
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 31, "method": "thread/goal/get",
        "params": {"threadId": first_thread_id}
    }));
    let get_goal: Response<ThreadGoalGetResult> =
        serde_json::from_value(resumed.response(31)).unwrap();
    assert!(matches!(
        get_goal.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.goal.as_ref().is_some_and(|goal| goal.objective == "finish parity")
    ));
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 38, "method": "thread/goal/set",
        "params": {"threadId": first_thread_id, "objective": "edited parity", "edit": true, "tokenBudget": 3000, "expectedGoalId": created_goal.goal_id, "expectedRevision": created_goal.revision}
    }));
    let edited_goal: Response<ThreadGoalSetResult> =
        serde_json::from_value(resumed.response(38)).unwrap();
    let edited_goal = match edited_goal.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert_eq!(result.goal.objective, "edited parity");
            assert_eq!(result.goal.status, "paused");
            assert_eq!(result.goal.mode, "strict");
            assert_eq!(result.goal.verification_kind, "answer");
            assert_eq!(result.goal.token_budget, Some(3000));
            result.goal
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/goal edit failed: {}", error.message)
        }
    };
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 36, "method": "thread/goal/set",
        "params": {"threadId": first_thread_id, "objective": "stale edit", "edit": true, "expectedGoalId": edited_goal.goal_id, "expectedRevision": created_goal.revision}
    }));
    assert_eq!(resumed.response(36)["error"]["code"], -32033);
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 37, "method": "thread/goal/get",
        "params": {"threadId": first_thread_id}
    }));
    let rejected_replace_state: Response<ThreadGoalGetResult> =
        serde_json::from_value(resumed.response(37)).unwrap();
    assert!(matches!(
        rejected_replace_state.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.goal.as_ref().is_some_and(|goal| goal.objective == "edited parity")
    ));

    let mut set_goal_status = |id: i64, status: &str, previous: &ThreadGoal| {
        resumed.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "thread/goal/set",
            "params": {
                "threadId": first_thread_id,
                "status": status,
                "expectedGoalId": previous.goal_id,
                "expectedRevision": previous.revision
            }
        }));
        let response: Response<ThreadGoalSetResult> =
            serde_json::from_value(resumed.response(id)).unwrap();
        match response.payload {
            kcoder_app_protocol::ResponsePayload::Success { result } => result.goal,
            kcoder_app_protocol::ResponsePayload::Error { error } => {
                panic!("thread/goal status {status} failed: {}", error.message)
            }
        }
    };
    let active_from_paused = set_goal_status(42, "active", &edited_goal);
    assert_eq!(active_from_paused.status, "active");
    let blocked = set_goal_status(43, "blocked", &active_from_paused);
    let active_from_blocked = set_goal_status(44, "active", &blocked);
    assert_eq!(active_from_blocked.status, "active");
    let usage_limited = set_goal_status(45, "usageLimited", &active_from_blocked);
    let active_from_usage_limited = set_goal_status(46, "active", &usage_limited);
    assert_eq!(active_from_usage_limited.status, "active");

    resumed.send(json!({
        "jsonrpc": "2.0", "id": 32, "method": "thread/goal/set",
        "params": {"threadId": first_thread_id, "status": "budgetLimited", "clearTokenBudget": true, "expectedGoalId": active_from_usage_limited.goal_id, "expectedRevision": active_from_usage_limited.revision}
    }));
    let update_goal: Response<ThreadGoalSetResult> =
        serde_json::from_value(resumed.response(32)).unwrap();
    let terminal_goal = match update_goal.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert_eq!(result.goal.status, "budgetLimited");
            assert_eq!(result.goal.token_budget, None);
            result.goal
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/goal status failed: {}", error.message)
        }
    };
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 39, "method": "thread/goal/history",
        "params": {"threadId": first_thread_id}
    }));
    let goal_history: Response<ThreadGoalHistoryResult> =
        serde_json::from_value(resumed.response(39)).unwrap();
    match goal_history.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => assert!(
            !result.goals.is_empty(),
            "goal history did not preserve the blocked goal"
        ),
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/goal/history failed: {}", error.message)
        }
    }
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 41, "method": "thread/goal/set",
        "params": {"threadId": first_thread_id, "status": "paused", "expectedGoalId": terminal_goal.goal_id, "expectedRevision": terminal_goal.revision}
    }));
    assert_eq!(resumed.response(41)["error"]["code"], -32033);
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 33, "method": "thread/goal/clear",
        "params": {"threadId": first_thread_id, "expectedGoalId": terminal_goal.goal_id, "expectedRevision": terminal_goal.revision}
    }));
    let clear_goal: Response<ThreadGoalClearResult> =
        serde_json::from_value(resumed.response(33)).unwrap();
    assert!(
        matches!(clear_goal.payload, kcoder_app_protocol::ResponsePayload::Success { result } if result.cleared)
    );
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 34, "method": "thread/rollback",
        "params": {"threadId": first_thread_id}
    }));
    let rollback: Response<ThreadRollbackResult> =
        serde_json::from_value(resumed.response(34)).unwrap();
    assert!(matches!(
        rollback.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.turn == 2 && result.restored_files == 1 && result.failed_files == 0
    ));
    assert_eq!(
        std::fs::read(&rewind_fixture).unwrap(),
        b"original before turn 2"
    );
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 35, "method": "thread/compact",
        "params": {"threadId": first_thread_id}
    }));
    let compact: Response<ThreadCompactResult> =
        serde_json::from_value(resumed.response(35)).unwrap();
    assert!(matches!(
        compact.payload,
        kcoder_app_protocol::ResponsePayload::Success { .. }
    ));

    resumed.shutdown();

    let mut delete_server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .spawn();
    delete_server.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 40, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "delete-test", "version": "1"}}
        }),
        json!({
            "jsonrpc": "2.0", "id": 41, "method": "thread/delete",
            "params": {"threadId": first_thread_id}
        }),
    ]);
    let deadline = Instant::now() + Duration::from_secs(10);
    let delete_response = loop {
        let message = delete_server.next_value(deadline);
        if message["id"] == 41 {
            break message;
        }
    };
    let deleted: Response<ThreadDeleteResult> = serde_json::from_value(delete_response).unwrap();
    assert!(matches!(
        deleted.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.deleted && result.deleted_files >= 2
    ));
    delete_server.shutdown_successfully();
    assert!(!history_path.exists());
    assert!(!checkpoint_turn.parent().unwrap().parent().unwrap().exists());
    assert!(
        !temp.path().join(".kcoder").exists(),
        "app-server must not initialize project-local KCoder metadata"
    );
}
use kcoder_app_protocol::{
    InitializeResult, ItemCompletedParams, ItemDeltaParams, ItemStartedParams, Notification,
    Response, ThreadCompactResult, ThreadDeleteResult, ThreadForkResult, ThreadGoal,
    ThreadGoalClearResult, ThreadGoalGetResult, ThreadGoalHistoryResult, ThreadGoalSetResult,
    ThreadListResult, ThreadReadResult, ThreadResumeResult, ThreadRollbackResult,
    ThreadStartResult, ThreadStartedParams, TurnCompletedParams, TurnStartResult,
    TurnStartedParams,
};

#[test]
fn stdio_app_server_allocates_new_turn_id_for_a_forkable_replacement_after_rewind() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({
            "active_provider": "integration-test",
            "providers": {
                "integration-test": {
                    "api_format": "openai_chat_completions",
                    "endpoint": "http://127.0.0.1:1/v1",
                    "default_model": "deterministic-scenario",
                    "context_window_tokens": 128000,
                    "output_headroom_tokens": 8192,
                    "max_output_tokens": 8192,
                    "request_timeout_secs": 30,
                    "no_proxy": true,
                    "extra_body": {}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let config = temp.path().join("config");
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .config_dir(&config)
        .stream_delay_ms("1")
        .spawn();

    server.send_batch([
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "rewind-fork-test", "version": "1"}}
        }),
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}),
    ]);
    let _: Response<InitializeResult> = serde_json::from_value(server.response(1)).unwrap();
    let started: Response<ThreadStartResult> = serde_json::from_value(server.response(2)).unwrap();
    let thread_id = match started.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => result.thread.id,
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/start failed: {}", error.message)
        }
    };

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "original prompt"}]}
    }));
    let first: Response<TurnStartResult> = serde_json::from_value(server.response(3)).unwrap();
    assert!(matches!(
        first.payload,
        kcoder_app_protocol::ResponsePayload::Success { result } if result.turn.id == "turn-1"
    ));
    wait_for_stdio_turn_completion(&mut server);

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/rollback",
        "params": {"threadId": thread_id}
    }));
    let rollback: Response<ThreadRollbackResult> =
        serde_json::from_value(server.response(4)).unwrap();
    assert!(matches!(
        rollback.payload,
        kcoder_app_protocol::ResponsePayload::Success { result }
            if result.turn == 1 && result.removed_messages > 0
    ));

    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "replacement prompt"}]}
    }));
    let replacement: Response<TurnStartResult> =
        serde_json::from_value(server.response(5)).unwrap();
    assert!(matches!(
        replacement.payload,
        // Accepted operation IDs remain monotonic even when visible history is
        // rewound, so a late old event cannot address the replacement turn.
        kcoder_app_protocol::ResponsePayload::Success { result } if result.turn.id == "turn-2"
    ));
    wait_for_stdio_turn_completion(&mut server);

    server.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/fork",
        "params": {
            "threadId": thread_id,
            "lastTurnId": "turn-2",
            "cwd": temp.path(),
            "excludeTurns": true
        }
    }));
    let fork: Response<ThreadForkResult> = serde_json::from_value(server.response(6)).unwrap();
    let fork_thread_id = match fork.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => result.thread.id,
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("replacement turn was not forkable: {}", error.message)
        }
    };
    assert_ne!(fork_thread_id, thread_id);

    // A deleted admission cannot alias the replacement now at visible position one.
    for (id, ephemeral) in [(60, false), (61, true)] {
        server.send(json!({"id":id,"method":"thread/fork","params":{
            "threadId":thread_id,"lastTurnId":"turn-1","ephemeral":ephemeral
        }}));
        assert!(server.response(id)["error"].is_object());
    }
    server.send(json!({"id":62,"method":"thread/fork","params":{
        "threadId":thread_id,"lastTurnId":"turn-2","ephemeral":true
    }}));
    let temporary = server.response(62);
    assert_eq!(temporary["result"]["ephemeral"], true, "{temporary}");
    server.send(json!({"id":63,"method":"thread/read","params":{
        "threadId":temporary["result"]["thread"]["id"]
    }}));
    let context = server.response(63);
    assert!(context["result"].to_string().contains("replacement prompt"));
    assert!(!context["result"].to_string().contains("original prompt"));
    for (id, last_turn, accepted) in [(64, "turn-2", true), (65, "turn-1", false)] {
        server.send(json!({"id":id,"method":"thread/metadata/update","params":{
            "threadId":fork_thread_id,"parent":{
                "taskId":format!("kcoder:local:{thread_id}"),
                "threadId":thread_id,"lastTurnId":last_turn
            }
        }}));
        let response = server.response(id);
        assert_eq!(response.get("error").is_none(), accepted, "{response}");
    }


    server.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "thread/read",
        "params": {"threadId": fork_thread_id, "limit": 50}
    }));
    let transcript: Response<ThreadReadResult> =
        serde_json::from_value(server.response(7)).unwrap();
    match transcript.payload {
        kcoder_app_protocol::ResponsePayload::Success { result } => {
            assert!(result.messages.iter().any(|message| {
                message.role == "user" && message.content == "replacement prompt"
            }));
            assert!(
                !result.messages.iter().any(|message| {
                    message.role == "user" && message.content == "original prompt"
                })
            );
        }
        kcoder_app_protocol::ResponsePayload::Error { error } => {
            panic!("thread/read failed: {}", error.message)
        }
    }
    server.shutdown_successfully();
}

fn wait_for_stdio_turn_completion(server: &mut TestAppServer) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let message = server.next_value(deadline);
        if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
            return;
        }
    }
}
