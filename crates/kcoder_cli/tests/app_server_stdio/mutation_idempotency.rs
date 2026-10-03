// R047: the recoverable-mutation inventory needs each mutation's duplicate
// behaviour pinned down, not assumed.

fn thread_metadata(server: &mut TestAppServer, id: i64, thread_id: &str) -> Value {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 1}
    }));
    server.response(id)["result"]["thread"].clone()
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
