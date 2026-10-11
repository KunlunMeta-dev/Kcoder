// R047: the recoverable-mutation inventory needs each mutation's duplicate
// behaviour pinned down, not assumed.

fn thread_metadata(server: &mut TestAppServer, id: i64, thread_id: &str) -> Value {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 1}
    }));
    server.response(id)["result"]["thread"].clone()
}

fn request_id_gate_response(server: &TestAppServer, expected_id: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let response = server.next_value(deadline);
        if response.get("method").is_none() && response.get("id") == Some(expected_id) {
            return response;
        }
    }
}

fn try_request_id_gate_response(
    server: &TestAppServer,
    expected_id: &Value,
    timeout: Duration,
) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let line = match server.rx.recv_timeout(remaining) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => panic!("app-server response read failed: {error}"),
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        };
        let response: Value = serde_json::from_str(&line).expect("JSON-RPC response frame");
        if response.get("method").is_none() && response.get("id") == Some(expected_id) {
            return Some(response);
        }
    }
}

fn report_cargo_built_app_server_binary() {
    let path = std::path::Path::new(env!("CARGO_BIN_EXE_kcoder"));
    let bytes = std::fs::read(path).expect("Cargo-built app-server test binary");
    eprintln!(
        "app_server_stdio source-built child: path={} sha256={:x}",
        path.display(),
        Sha256::digest(&bytes)
    );
}

#[test]
fn rejects_untyped_request_ids_without_side_effects() {
    report_cargo_built_app_server_binary();
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);

    // A method-shaped initialize without an ID must not initialize the
    // connection. The following valid request remains the handshake owner.
    server.send(json!({
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-27",
            "clientInfo": {"name": "request-id-gate", "version": "1"}
        }
    }));
    let initialized = server.initialize(1);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": "invalid-initialized-request",
        "method": "initialized"
    }));
    let invalid_initialized = try_request_id_gate_response(
        &server,
        &json!("invalid-initialized-request"),
        Duration::from_secs(2),
    );
    assert_eq!(
        invalid_initialized.expect("request-shaped initialized must settle")["error"]["code"],
        -32600
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {}
    }));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "thread/metadata/update",
        "params": {"threadId": thread_id, "title": "before invalid requests"}
    }));
    assert!(server.response(3).get("error").is_none());

    // Exercise each invalid envelope shape against real mutations. Some try
    // to delete the resident thread; the rest try to poison its metadata.
    server.send_batch([
        json!({"jsonrpc":"2.0", "method":"thread/delete", "params":{"threadId":thread_id}}),
        json!({"jsonrpc":"2.0", "id":null, "method":"thread/metadata/update", "params":{"threadId":thread_id,"title":"poisoned null"}}),
        json!({"jsonrpc":"2.0", "id":false, "method":"thread/delete", "params":{"threadId":thread_id}}),
        json!({"jsonrpc":"2.0", "id":[], "method":"thread/metadata/update", "params":{"threadId":thread_id,"title":"poisoned array"}}),
        json!({"jsonrpc":"2.0", "id":{}, "method":"thread/delete", "params":{"threadId":thread_id}}),
        json!({"jsonrpc":"2.0", "id":-1, "method":"thread/metadata/update", "params":{"threadId":thread_id,"title":"poisoned negative"}}),
        json!({"jsonrpc":"2.0", "id":1.5, "method":"thread/delete", "params":{"threadId":thread_id}}),
        json!({"jsonrpc":"2.0", "method":"initialized"}),
        json!({"jsonrpc":"2.0", "id":"typed-read", "method":"thread/read", "params":{"threadId":thread_id,"limit":1}}),
        json!({"jsonrpc":"2.0", "id":4, "method":"thread/list", "params":{"limit":50}}),
    ]);

    let read = request_id_gate_response(&server, &json!("typed-read"));
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["thread"]["title"], "before invalid requests");
    assert!(read["result"]["thread"]["metadata"]["archivedAt"].is_null());

    let listed = server.response(4);
    let listed_thread = listed["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == thread_id)
        .cloned();
    assert!(
        listed_thread.is_some(),
        "invalid-ID requests deleted thread: {listed}"
    );
    assert_eq!(listed_thread.unwrap()["title"], "before invalid requests");

    // A present but unsupported ID is an invalid request and is answered with
    // JSON-RPC's null-ID error. The absent-ID initialize/delete/initialized
    // notifications above must remain silent, so exactly the six explicitly
    // malformed ID frames should have null-ID responses.
    let null_id_responses: Vec<Value> = server
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|frame| {
            frame.get("method").is_none()
                && (frame.get("result").is_some() || frame.get("error").is_some())
                && frame.get("id").is_some_and(Value::is_null)
        })
        .collect();
    assert_eq!(null_id_responses.len(), 6, "{null_id_responses:#?}");
    for response in &null_id_responses {
        assert_eq!(response["jsonrpc"], "2.0", "{response}");
        assert_eq!(response["error"]["code"], -32600, "{response}");
        assert!(response.get("result").is_none(), "{response}");
    }
    assert!(initialized.get("error").is_none(), "{initialized}");

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "thread/delete",
        "params": {"threadId": thread_id}
    }));
    assert_eq!(server.response(5)["result"]["deleted"], true);
    server.send(json!({"jsonrpc":"2.0", "id":6, "method":"thread/list", "params":{"limit":50}}));
    let after_delete = server.response(6);
    assert!(
        !after_delete["result"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|thread| thread["id"] == thread_id),
        "a valid typed request must still delete the thread: {after_delete}"
    );
    server.shutdown();
}

#[test]
fn deleting_a_thread_twice_reports_an_honest_outcome() {
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
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": "one turn"}]}
    }));
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/delete",
        "params": {"threadId": thread_id.clone()}
    }));
    let first = server.response(4);
    assert_eq!(first["result"]["deleted"], true, "{first}");
    let deleted_now = first["result"]["deletedFiles"].as_u64().unwrap();
    assert!(
        deleted_now > 0,
        "the first delete must remove files: {first}"
    );

    // Repeating a delete reports the post-state instead of pretending it deleted
    // the files again: the thread is gone, and the server says so explicitly.
    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/delete",
        "params": {"threadId": thread_id.clone()}
    }));
    let second = server.response(5);
    assert_eq!(second["error"]["code"], -32035, "{second}");
    assert!(
        second["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&thread_id),
        "the refusal must name the thread: {second}"
    );

    server
        .send(json!({"jsonrpc": "2.0", "id": 6, "method": "thread/list", "params": {"limit": 50}}));
    let listed = server.response(6);
    assert!(
        !listed["result"]["threads"]
            .as_array()
            .expect("threads")
            .iter()
            .any(|thread| thread["id"] == thread_id),
        "a deleted thread must not stay listed: {listed}"
    );
    server.shutdown();
}

#[test]
fn archiving_twice_and_unarchiving_twice_settle_to_the_same_state() {
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

    let archived_at = "2026-09-21T00:00:00Z";
    for id in [3, 4] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "thread/metadata/update",
            "params": {"threadId": thread_id.clone(), "archivedAt": archived_at}
        }));
        let response = server.response(id);
        assert!(response.get("error").is_none(), "{response}");
    }
    let archived = thread_metadata(&mut server, 5, &thread_id);
    assert_eq!(
        archived["metadata"]["archivedAt"], archived_at,
        "{archived}"
    );

    for id in [6, 7] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "thread/metadata/update",
            "params": {"threadId": thread_id.clone(), "archivedAt": null}
        }));
        let response = server.response(id);
        assert!(response.get("error").is_none(), "{response}");
    }
    let restored = thread_metadata(&mut server, 8, &thread_id);
    assert_eq!(
        restored["metadata"]["archivedAt"],
        Value::Null,
        "{restored}"
    );
    server.shutdown();
}
