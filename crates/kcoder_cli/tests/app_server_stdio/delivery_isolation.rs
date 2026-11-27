use super::*;

const DELIVERY_REQUEST_ID: &str = "sess-003-stable-operation-9d02c7";

fn partial_stream_then_hold_for_delivery_retry(socket: &mut std::net::TcpStream) {
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial before injected crash\"},\"finish_reason\":null}]}\n\n";
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n",
        body.len()
    )
    .unwrap();
    socket.flush().unwrap();
    std::thread::sleep(Duration::from_secs(10));
}

#[test]
fn lost_turn_reply_after_real_file_effect_is_unknown_and_stable_retry_does_not_replay() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let temp_directory = temp.path().join("tmp");
    std::fs::create_dir_all(&temp_directory).unwrap();

    let append_command =
        format!("printf '%s\\n' '{DELIVERY_REQUEST_ID}' >> .delivery-isolation-effects");
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        move |index, _request| match index {
            0 | 2 => FixtureAnswer::Tool {
                id: format!("delivery-write-{index}"),
                name: "bash".into(),
                input: json!({
                    "command": append_command.clone(),
                    "description": "append the stable delivery request ID"
                }),
            },
            1 => FixtureAnswer::Custom(partial_stream_then_hold_for_delivery_retry),
            _ => FixtureAnswer::Text("delivery complete".into()),
        },
        Some(4),
        Duration::from_secs(30),
    );
    let settings = temp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &endpoint);
    let mut settings_value: Value =
        serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    settings_value["permission_mode"] = json!("bypass");
    std::fs::write(&settings, serde_json::to_vec(&settings_value).unwrap()).unwrap();

    let mut server = TestAppServer::builder(&workspace, &settings)
        .env("HOME", temp.path())
        .temp_dir(&temp_directory)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let turn_start = || {
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"turn/start",
            "params":{
                "threadId":thread_id,
                "clientMessageId":DELIVERY_REQUEST_ID,
                "input":[{"type":"text","text":"Append the stable operation ID once."}]
            }
        })
    };

    // Leave the accepted response unread. The simulated client loses this
    // connection after the external effect and must reconcile after restart.
    server.send(turn_start());
    let deadline = Instant::now() + Duration::from_secs(30);
    let first_two_calls = loop {
        let snapshot = calls.lock().unwrap().clone();
        if snapshot.len() >= 2 {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "provider did not reach the post-tool request; calls={snapshot:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let second_request = &first_two_calls[1];
    assert!(
        second_request["messages"]
            .as_array()
            .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool")),
        "the second provider request must follow the completed tool call: {second_request}"
    );
    let effects = workspace.join(".delivery-isolation-effects");
    let first_effect = std::fs::read_to_string(&effects).unwrap();
    assert_eq!(
        first_effect.lines().collect::<Vec<_>>(),
        [DELIVERY_REQUEST_ID]
    );

    let partial_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let observed = server.observed.lock().unwrap().clone();
        let frames = observed
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect::<Vec<_>>();
        let partial_seen = frames.iter().any(|event| {
            event["method"] == "item/delta"
                && event.to_string().contains("partial before injected crash")
        });
        if partial_seen {
            break;
        }
        assert!(
            Instant::now() < partial_deadline,
            "the partial provider event must be projected before the crash"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    // Terminate the owner process while its next model response is partial.
    server.child.kill().unwrap();
    let killed = server.child.wait().unwrap();
    assert!(
        !killed.success(),
        "the fault injection must kill the process"
    );
    drop(server);

    let mut restored = TestAppServer::builder(&workspace, &settings)
        .env("HOME", temp.path())
        .temp_dir(&temp_directory)
        .without_scenario()
        .spawn();
    restored.initialize(1);
    restored.send(json!({
        "jsonrpc":"2.0","id":2,"method":"thread/resume",
        "params":{"threadId":thread_id}
    }));
    let resumed = restored.response(2);
    assert!(resumed.get("error").is_none(), "{resumed}");

    restored.send(json!({
        "jsonrpc":"2.0","id":4,"method":"turn/receipt/read",
        "params":{"threadId":thread_id,"clientMessageId":DELIVERY_REQUEST_ID}
    }));
    let receipt = restored.response(4);
    assert_eq!(
        receipt["result"]["receipt"]["status"], "unknown",
        "{receipt}"
    );
    let original_turn_id = receipt["result"]["receipt"]["turnId"]
        .as_str()
        .expect("authoritative receipt must retain the original turn ID")
        .to_string();

    restored.send(turn_start());
    let retry = restored.response(3);
    let retry_rejected = retry["error"]["code"] == -32047;
    if retry_rejected {
        assert!(
            retry["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(&original_turn_id),
            "rejection should identify the existing turn: {retry}"
        );
    }
    if retry.get("error").is_none() {
        assert_eq!(
            retry["result"]["turn"]["id"], original_turn_id,
            "a retry must resolve to the original turn, never allocate a new one: {retry}"
        );
    }
    fixture.join().unwrap();
    let final_calls = calls.lock().unwrap().clone();
    let final_effects = std::fs::read_to_string(&effects).unwrap();
    assert_eq!(
        final_calls.len(),
        2,
        "recovery/retry must not reach the Provider again: {final_calls:?}"
    );
    assert_eq!(
        final_effects.lines().collect::<Vec<_>>(),
        [DELIVERY_REQUEST_ID],
        "the physical temporary-file side effect must occur exactly once"
    );
    assert!(
        retry_rejected || retry.get("error").is_none(),
        "retry must either be rejected as already submitted or resolve to the same turn: {retry}"
    );
    if restored.child.try_wait().unwrap().is_none() {
        restored.child.kill().unwrap();
    }
    let _ = restored.child.wait().unwrap();
    drop(restored);
}
