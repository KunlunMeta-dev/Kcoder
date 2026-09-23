#[test]
fn thread_timestamps_are_stable_across_reads_turns_and_resume() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let initial = server.response(2)["result"]["thread"].clone();
    let thread_id = initial["id"].as_str().unwrap().to_owned();
    std::thread::sleep(Duration::from_millis(20));
    for (id, method) in [(3, "thread/read"), (4, "thread/list"), (5, "server/info")] {
        server
            .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":{"threadId":thread_id}}));
        let response = server.response(id);
        let thread = match method {
            "thread/read" => &response["result"]["thread"],
            "thread/list" => response["result"]["threads"]
                .as_array()
                .unwrap()
                .iter()
                .find(|thread| thread["id"] == thread_id)
                .unwrap(),
            _ => &response["result"],
        };
        assert_eq!(thread["createdAt"], initial["createdAt"], "{method}");
        assert_eq!(thread["updatedAt"], initial["updatedAt"], "{method}");
    }
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":"stable timestamp fixture"}]}}));
    server.response(6);
    server.wait_for_method("turn/completed");
    server.send(
        json!({"jsonrpc":"2.0","id":7,"method":"thread/read","params":{"threadId":thread_id}}),
    );
    let after_turn = server.response(7)["result"]["thread"].clone();
    assert_eq!(after_turn["createdAt"], initial["createdAt"]);
    assert!(after_turn["updatedAt"].as_str().unwrap() > initial["updatedAt"].as_str().unwrap());
    std::thread::sleep(Duration::from_millis(20));
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"thread/metadata/update","params":{"threadId":thread_id,"title":"Timestamp fixture"}}));
    let after_metadata = server.response(8)["result"]["thread"].clone();
    assert_eq!(after_metadata["createdAt"], initial["createdAt"]);
    assert!(
        after_metadata["updatedAt"].as_str().unwrap() > after_turn["updatedAt"].as_str().unwrap()
    );
    std::thread::sleep(Duration::from_millis(20));
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"thread/metadata/update","params":{"threadId":thread_id,"title":"Timestamp fixture"}}));
    let no_op = server.response(9)["result"]["thread"].clone();
    assert_eq!(no_op["updatedAt"], after_metadata["updatedAt"]);
    assert_eq!(
        no_op["metadata"]["revision"],
        after_metadata["metadata"]["revision"]
    );
    server.shutdown();

    let mut resumed = TestAppServer::start(temp.path(), &settings);
    resumed.initialize(10);
    resumed.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/list","params":{}}));
    let listed = resumed.response(11);
    let persisted = listed["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == thread_id)
        .unwrap();
    assert_eq!(persisted["createdAt"], initial["createdAt"]);
    assert_eq!(persisted["updatedAt"], after_metadata["updatedAt"]);
    resumed.send(
        json!({"jsonrpc":"2.0","id":12,"method":"thread/resume","params":{"threadId":thread_id}}),
    );
    let thread = resumed.response(12)["result"]["thread"].clone();
    assert_eq!(thread["createdAt"], initial["createdAt"]);
    assert_eq!(thread["updatedAt"], after_metadata["updatedAt"]);
    resumed.shutdown();
}

#[test]
fn thread_metadata_survives_processes_can_unarchive_and_is_deleted_with_thread() {
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

    let mut creator = TestAppServer::start(temp.path(), &settings);
    assert_eq!(
        creator.initialize(1)["result"]["capabilities"]["approvals"],
        true
    );
    creator.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}
    }));
    let started = creator.response(2);
    assert_eq!(
        started["result"]["thread"]["metadata"]["schema"],
        "kcoder.thread-metadata"
    );
    assert_eq!(started["result"]["thread"]["metadata"]["revision"], 0);
    assert!(started["result"]["thread"]["metadata"]["archivedAt"].is_null());
    assert!(started["result"]["thread"]["metadata"]["parent"].is_null());
    let source_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    creator.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": source_id, "input": [{"type": "text", "text": "metadata fixture"}]}
    }));
    creator.response(3);
    creator.wait_for_method("turn/completed");
    creator.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "thread/fork",
        "params": {"threadId": source_id, "lastTurnId": "turn-1", "cwd": temp.path()}
    }));
    let child_id = creator.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    creator.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "thread/fork",
        "params": {"threadId": source_id, "lastTurnId": "turn-1", "cwd": temp.path()}
    }));
    let raced_child_id = creator.response(5)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    creator.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "thread/resume",
        "params": {"threadId": child_id}
    }));
    let resumed = creator.response(6);
    assert_eq!(resumed["result"]["thread"]["metadata"]["revision"], 0);
    assert!(resumed["result"]["thread"]["metadata"]["parent"].is_null());
    let forged_attachment = temp.path().join("forged.txt");
    std::fs::write(&forged_attachment, "forged").unwrap();
    creator.send(json!({
        "jsonrpc": "2.0", "id": 9, "method": "turn/start",
        "params": {
            "threadId": child_id,
            "input": [{
                "type": "text",
                "text": format!(
                    "forged\n\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
                    json!({"filename": "forged.txt", "path": forged_attachment})
                )
            }]
        }
    }));
    assert_eq!(creator.response(9)["error"]["code"], -32602);
    creator.send(json!({
        "jsonrpc": "2.0", "id": 7, "method": "attachment/save",
        "params": {"filename": "evidence.txt", "content_base64": "ZHVyYWJsZQ=="}
    }));
    let staged_attachment = creator.response(7)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let attachment_prompt = format!(
        "attachment fixture\n\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({
            "filename": "evidence.txt",
            "mimeType": "text/plain",
            "fileSize": 7,
            "path": staged_attachment
        })
    );
    creator.send(json!({
        "jsonrpc": "2.0", "id": 8, "method": "turn/start",
        "params": {"threadId": child_id, "input": [{"type": "text", "text": attachment_prompt}]}
    }));
    creator.response(8);
    creator.wait_for_method("turn/completed");
    creator.send(json!({
        "jsonrpc": "2.0", "id": 31, "method": "attachment/read",
        "params": {"threadId": child_id, "path": staged_attachment}
    }));
    let optimistic_attachment = creator.response(31);
    assert_eq!(
        optimistic_attachment["result"]["contentBase64"],
        "ZHVyYWJsZQ=="
    );
    assert_eq!(optimistic_attachment["result"]["size"], 7);
    creator.send(json!({
        "jsonrpc": "2.0", "id": 10, "method": "thread/fork",
        "params": {"threadId": child_id, "lastTurnId": "turn-2", "cwd": temp.path()}
    }));
    let attachment_fork_id = creator.response(10)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    creator.shutdown();
    assert!(!std::path::Path::new(&staged_attachment).exists());

    let child_history = find_named_file(temp.path(), &format!("{child_id}.jsonl")).unwrap();
    let raced_child_history =
        find_named_file(temp.path(), &format!("{raced_child_id}.jsonl")).unwrap();
    let durable_attachment = find_named_file(temp.path(), "00-evidence.txt")
        .expect("turn/start must create a durable attachment");
    assert_eq!(std::fs::read(&durable_attachment).unwrap(), b"durable");
    assert!(
        durable_attachment
            .to_string_lossy()
            .contains(&format!("client-sessions/{child_id}/attachments/turn-2-"))
    );
    let forked_durable_attachment = find_named_file(temp.path(), "000-00-evidence.txt")
        .expect("thread/fork must clone durable attachments into the child session");
    assert!(
        forked_durable_attachment
            .to_string_lossy()
            .contains(&format!(
                "client-sessions/{attachment_fork_id}/attachments/fork-"
            ))
    );
    let client_sessions = child_history.parent().unwrap().join("client-sessions");
    std::fs::create_dir_all(&client_sessions).unwrap();
    #[cfg(unix)]
    {
        let outside = temp.path().join("metadata-symlink-target");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, client_sessions.join(&raced_child_id)).unwrap();
    }

    let mut updater = TestAppServer::start(temp.path(), &settings);
    updater.initialize(10);
    #[cfg(unix)]
    {
        updater.send(json!({
            "jsonrpc": "2.0", "id": 13, "method": "thread/metadata/update",
            "params": {"threadId": raced_child_id, "title": "不能写入符号链接"}
        }));
        assert_eq!(updater.response(13)["error"]["code"], -32037);
        assert!(
            !temp
                .path()
                .join("metadata-symlink-target")
                .join("thread-metadata.json")
                .exists()
        );
        std::fs::remove_file(client_sessions.join(&raced_child_id)).unwrap();
    }
    let lifecycle_directory = client_sessions.join(".thread-lifecycle-locks");
    std::fs::create_dir_all(&lifecycle_directory).unwrap();
    let lifecycle_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lifecycle_directory.join(format!("{raced_child_id}.lock")))
        .unwrap();
    lifecycle_lock.lock_exclusive().unwrap();
    updater.send(json!({
        "jsonrpc": "2.0", "id": 16, "method": "thread/metadata/update",
        "params": {"threadId": raced_child_id, "title": "不应复活"}
    }));
    assert!(
        updater.rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "metadata update must wait for the shared lifecycle lock"
    );
    std::fs::remove_file(&raced_child_history).unwrap();
    let raced_artifacts = client_sessions.join(&raced_child_id);
    if raced_artifacts.exists() {
        std::fs::remove_dir_all(&raced_artifacts).unwrap();
    }
    lifecycle_lock.unlock().unwrap();
    assert_eq!(updater.response(16)["error"]["code"], -32037);
    assert!(
        !raced_artifacts.exists(),
        "metadata update must revalidate after waiting and must not recreate deleted state"
    );
    updater.send(json!({
        "jsonrpc": "2.0", "id": 12, "method": "thread/metadata/update",
        "params": {"threadId": "../escape", "title": "不能越界"}
    }));
    assert_eq!(updater.response(12)["error"]["code"], -32037);
    updater.send(json!({
        "jsonrpc": "2.0", "id": 11, "method": "thread/metadata/update",
        "params": {
            "threadId": child_id,
            "title": "跨进程标题",
            "model": "metadata-model",
            "archivedAt": "2026-07-28T12:00:00Z",
            "parent": {
                "taskId": format!("kcoder:local:{source_id}"),
                "threadId": source_id,
                "lastTurnId": "turn-1"
            }
        }
    }));
    let updated = updater.response(11);
    assert_eq!(updated["result"]["thread"]["title"], "跨进程标题");
    assert_eq!(updated["result"]["thread"]["parent"]["threadId"], source_id);
    assert_eq!(
        updated["result"]["thread"]["metadata"]["schema"],
        "kcoder.thread-metadata"
    );
    assert_eq!(updated["result"]["thread"]["metadata"]["version"], 1);
    assert_eq!(updated["result"]["thread"]["metadata"]["revision"], 1);
    assert_eq!(
        updated["result"]["thread"]["metadata"]["title"],
        "跨进程标题"
    );
    updater.send(json!({
        "jsonrpc": "2.0", "id": 14, "method": "thread/metadata/update",
        "params": {
            "threadId": child_id,
            "parent": {"taskId": "bad", "threadId": child_id, "lastTurnId": "turn-1"}
        }
    }));
    assert_eq!(updater.response(14)["error"]["code"], -32037);
    updater.send(json!({
        "jsonrpc": "2.0", "id": 15, "method": "thread/metadata/update",
        "params": {
            "threadId": child_id,
            "parent": {"taskId": "bad", "threadId": source_id, "lastTurnId": "turn-99"}
        }
    }));
    assert_eq!(updater.response(15)["error"]["code"], -32037);
    updater.shutdown();

    let mut reader = TestAppServer::start(temp.path(), &settings);
    reader.initialize(20);
    reader.send(json!({
        "jsonrpc": "2.0", "id": 28, "method": "attachment/save",
        "params": {"filename": "discard.txt", "content_base64": "ZGlzY2FyZA=="}
    }));
    let discarded_path = reader.response(28)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(std::path::Path::new(&discarded_path).is_file());
    reader.send(json!({
        "jsonrpc": "2.0", "id": 29, "method": "attachment/delete",
        "params": {"path": discarded_path}
    }));
    assert_eq!(reader.response(29)["result"]["removed"], true);
    assert!(!std::path::Path::new(&discarded_path).exists());
    reader.send(json!({
        "jsonrpc": "2.0", "id": 30, "method": "attachment/delete",
        "params": {"path": discarded_path}
    }));
    assert_eq!(reader.response(30)["error"]["code"], -32602);
    reader.send(json!({
        "jsonrpc": "2.0", "id": 21, "method": "thread/list", "params": {"limit": 100}
    }));
    let list = reader.response(21);
    let child = list["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == child_id)
        .expect("metadata thread must be visible to another process");
    assert_eq!(child["title"], "跨进程标题");
    assert_eq!(child["model"], "metadata-model");
    assert_eq!(child["archivedAt"], "2026-07-28T12:00:00Z");
    assert_eq!(child["parent"]["threadId"], source_id);
    assert_eq!(child["metadata"]["parent"]["lastTurnId"], "turn-1");
    reader.send(json!({
        "jsonrpc": "2.0", "id": 23, "method": "thread/read",
        "params": {"threadId": child_id, "limit": 100}
    }));
    let transcript = reader.response(23);
    assert_eq!(transcript["result"]["thread"]["metadata"]["revision"], 1);
    assert!(
        transcript["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
            .any(|block| block["type"] == "attachment"
                && block["attachment"]["path"]
                    .as_str()
                    .is_some_and(|path| path == durable_attachment.to_string_lossy().as_ref()))
    );
    reader.send(json!({
        "jsonrpc": "2.0", "id": 24, "method": "thread/resume",
        "params": {"threadId": child_id}
    }));
    assert_eq!(reader.response(24)["result"]["thread"]["id"], child_id);
    reader.send(json!({
        "jsonrpc": "2.0", "id": 25, "method": "attachment/read",
        "params": {"threadId": child_id, "path": durable_attachment}
    }));
    let attachment = reader.response(25);
    assert_eq!(attachment["result"]["contentBase64"], "ZHVyYWJsZQ==");
    assert_eq!(attachment["result"]["size"], 7);
    reader.send(json!({
        "jsonrpc": "2.0", "id": 26, "method": "attachment/read",
        "params": {"threadId": child_id, "path": temp.path().join("settings.json")}
    }));
    assert_eq!(reader.response(26)["error"]["code"], -32038);
    #[cfg(unix)]
    {
        let link = durable_attachment
            .parent()
            .unwrap()
            .join("attachment-link.txt");
        std::os::unix::fs::symlink(&durable_attachment, &link).unwrap();
        reader.send(json!({
            "jsonrpc": "2.0", "id": 27, "method": "attachment/read",
            "params": {"threadId": child_id, "path": link}
        }));
        assert_eq!(reader.response(27)["error"]["code"], -32038);
        std::fs::remove_file(link).unwrap();
    }
    reader.send(json!({
        "jsonrpc": "2.0", "id": 22, "method": "thread/metadata/update",
        "params": {"threadId": child_id, "archivedAt": null}
    }));
    let unarchived = reader.response(22);
    assert!(unarchived["result"]["thread"].get("archivedAt").is_none());
    assert!(unarchived["result"]["thread"]["metadata"]["archivedAt"].is_null());
    assert_eq!(unarchived["result"]["thread"]["metadata"]["revision"], 2);
    reader.shutdown();

    let mut final_reader = TestAppServer::start(temp.path(), &settings);
    final_reader.initialize(30);
    final_reader.send(json!({
        "jsonrpc": "2.0", "id": 31, "method": "thread/list", "params": {"limit": 100}
    }));
    let list = final_reader.response(31);
    let child = list["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == child_id)
        .expect("unarchived thread must remain visible");
    assert!(child.get("archivedAt").is_none());
    assert_eq!(child["metadata"]["revision"], 2);
    assert!(child["metadata"]["archivedAt"].is_null());
    final_reader.send(json!({
        "jsonrpc": "2.0", "id": 32, "method": "thread/delete",
        "params": {"threadId": child_id}
    }));
    assert_eq!(final_reader.response(32)["result"]["deleted"], true);
    assert!(!durable_attachment.exists());
    assert!(forked_durable_attachment.exists());
    final_reader.send(json!({
        "jsonrpc": "2.0", "id": 33, "method": "thread/read",
        "params": {"threadId": attachment_fork_id, "limit": 100}
    }));
    assert!(
        final_reader.response(33)["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
            .any(|block| block["type"] == "attachment"
                && block["attachment"]["path"].as_str().is_some_and(
                    |path| path == forked_durable_attachment.to_string_lossy().as_ref()
                ))
    );
    final_reader.send(json!({
        "jsonrpc": "2.0", "id": 34, "method": "thread/delete",
        "params": {"threadId": attachment_fork_id}
    }));
    assert_eq!(final_reader.response(34)["result"]["deleted"], true);
    final_reader.shutdown();

    assert!(find_named_file(temp.path(), "thread-metadata.json").is_none());
    assert!(!forked_durable_attachment.exists());
}
#[test]
fn thread_list_keeps_interleaved_client_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    server.initialize(1);
    for request in 2..5 {
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"thread/start","params":{}}));
        assert!(server.response(request)["result"]["thread"].is_object());
    }
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"thread/list","params":{"limit":1}}));
    let a = server.response(10);
    server.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/list","params":{"limit":1}}));
    let b = server.response(11);
    let mut a_cursor = a["result"]["nextCursor"].clone();
    let mut b_cursor = b["result"]["nextCursor"].clone();
    assert!(a_cursor.is_string() && b_cursor.is_string());
    let mut a_ids = vec![a["result"]["threads"][0]["id"].clone()];
    let mut b_ids = vec![b["result"]["threads"][0]["id"].clone()];
    for request in [12, 14] {
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"thread/list","params":{"limit":1,"cursor":a_cursor}}));
        let page = server.response(request);
        assert!(page["result"]["threads"].is_array(), "{page}");
        a_ids.push(page["result"]["threads"][0]["id"].clone());
        a_cursor = page["result"]["nextCursor"].clone();
        server.send(json!({"jsonrpc":"2.0","id":request+1,"method":"thread/list","params":{"limit":1,"cursor":b_cursor}}));
        let page = server.response(request + 1);
        assert!(page["result"]["threads"].is_array(), "{page}");
        b_ids.push(page["result"]["threads"][0]["id"].clone());
        b_cursor = page["result"]["nextCursor"].clone();
    }
    assert_eq!(a_ids, b_ids);
    assert_eq!(
        a_ids
            .iter()
            .map(Value::to_string)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert!(a_cursor.is_null() && b_cursor.is_null());
    server.shutdown();
}

#[test]
fn partial_thread_list_stdio_opt_in_and_cursor_privacy() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    server.initialize(1);
    let mut ids = Vec::new();
    for request in 2..5 {
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"thread/start","params":{}}));
        ids.push(
            server.response(request)["result"]["thread"]["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"threadId":ids[0],"input":[{"type":"text","text":"partial list fixture"}]}}));
    server.response(5);
    server.wait_for_method("turn/completed");
    server
        .send(json!({"jsonrpc":"2.0","id":6,"method":"thread/read","params":{"threadId":ids[0]}}));
    assert!(server.response(6)["result"].is_object());
    let path = wait_for_named_file(
        temp.path(),
        &format!("{}.jsonl", ids[0]),
        Duration::from_secs(5),
    )
    .unwrap();
    let secret_id = "foreign-unknown-private-source";
    let unknown = path.parent().unwrap().join(format!("{secret_id}.jsonl"));
    std::fs::write(&unknown, b"{}\n").unwrap();
    let control = unknown.with_extension("hctl");
    std::fs::create_dir_all(&control).unwrap();
    std::fs::write(control.join("source.json"), b"{corrupt").unwrap();
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"thread/list","params":{"limit":1,"allowPartial":true}}));
    let first = server.response(10);
    assert_eq!(first["result"]["completeness"], "partial", "{first}");
    assert_eq!(first["result"]["issueCount"], 1);
    assert!(!first.to_string().contains(secret_id));
    assert!(
        !first
            .to_string()
            .contains(&unknown.to_string_lossy().to_string())
    );
    let cursor = first["result"]["nextCursor"].clone();
    assert!(cursor.is_string());
    for (request, params) in [
        (11, json!({})),
        (12, json!({"cursor":cursor})),
        (13, json!({"cursor":cursor,"allowPartial":false})),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"thread/list","params":params}));
        let error = server.response(request);
        assert_eq!(error["error"]["code"], -32020, "{error}");
        assert!(!error.to_string().contains(secret_id));
    }
    std::fs::remove_file(&unknown).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":14,"method":"thread/list","params":{"limit":100,"cursor":cursor,"allowPartial":true}}));
    let last = server.response(14);
    assert_eq!(last["result"]["completeness"], "partial");
    assert_eq!(last["result"]["issueCount"], 1);
    assert!(last["result"]["nextCursor"].is_null());
    server.send(
        json!({"jsonrpc":"2.0","id":15,"method":"thread/list","params":{"allowPartial":true}}),
    );
    let complete = server.response(15);
    assert_eq!(complete["result"]["completeness"], "complete");
    assert_eq!(complete["result"]["issueCount"], 0);
    server.send(json!({"jsonrpc":"2.0","id":16,"method":"thread/list","params":{}}));
    let legacy = server.response(16);
    assert!(legacy["result"]["threads"].is_array());
    assert!(legacy["result"].get("completeness").is_none());
    assert!(legacy["result"].get("issueCount").is_none());
    server.send(json!({"jsonrpc":"2.0","id":17,"method":"thread/metadata/update","params":{"threadId":ids[0],"title":"metadata failure fixture"}}));
    assert!(server.response(17)["result"]["thread"].is_object());
    let client_metadata = find_named_file(temp.path(), "thread-metadata.json").unwrap();
    std::fs::write(&client_metadata, b"{broken").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","id":18,"method":"thread/list","params":{"allowPartial":true}}),
    );
    let bad_metadata = server.response(18);
    assert_eq!(
        bad_metadata["result"]["completeness"], "partial",
        "{bad_metadata}"
    );
    assert_eq!(bad_metadata["result"]["issueCount"], 1);
    assert_eq!(
        bad_metadata["result"]["threads"].as_array().unwrap().len(),
        2
    );
    server.shutdown();
    let mut cold =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    cold.initialize(20);
    cold.send(
        json!({"jsonrpc":"2.0","id":21,"method":"thread/list","params":{"allowPartial":true}}),
    );
    let bad_persisted_metadata = cold.response(21);
    assert_eq!(bad_persisted_metadata["result"]["completeness"], "partial");
    assert_eq!(bad_persisted_metadata["result"]["issueCount"], 1);
    assert!(
        bad_persisted_metadata["result"]["threads"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    cold.shutdown();
}
