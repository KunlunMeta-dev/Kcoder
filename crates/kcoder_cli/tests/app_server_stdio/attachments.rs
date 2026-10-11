#[test]
fn attachment_rpc_materializes_once_and_rejects_second_consumption() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    assert!(server.initialize(1)["result"].is_object());
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "attachment/save",
        "params": {"filename": "evidence.txt", "content_base64": "YXR0YWNobWVudA=="}
    }));
    let staged_path = server.response(3)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(std::fs::read(&staged_path).unwrap(), b"attachment");
    for (id, method) in [(30, "attachment/read"), (31, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &staged_path, "offset": 0, "length": 32}
        }));
        let response = server.response(id);
        assert_eq!(
            response["result"]["contentBase64"], "YXR0YWNobWVudA==",
            "{response}"
        );
    }
    let prompt = format!(
        "attachment black box\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({"filename": "evidence.txt", "path": staged_path})
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": &prompt}]}
    }));
    assert_eq!(server.response(4)["result"]["turn"]["status"], "running");
    server.wait_for_method("turn/completed");
    assert!(!std::path::Path::new(&staged_path).exists());
    let durable = wait_for_named_file(temp.path(), "00-evidence.txt", Duration::from_secs(5))
        .expect("turn/start must materialize the staged attachment");
    assert_eq!(std::fs::read(&durable).unwrap(), b"attachment");
    for (id, method) in [(32, "attachment/read"), (33, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &staged_path, "offset": 0, "length": 32}
        }));
        assert_eq!(
            server.response(id)["result"]["contentBase64"],
            "YXR0YWNobWVudA=="
        );
    }

    server.send(json!({"jsonrpc": "2.0", "id": 34, "method": "thread/start", "params": {}}));
    let other_thread_id = server.response(34)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (id, method) in [(35, "attachment/read"), (36, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &other_thread_id, "path": &staged_path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&server.response(id), temp.path());
    }

    server.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": &prompt}]}
    }));
    let second = server.response(5);
    assert_eq!(second["error"]["code"], -32602);
    assert!(
        second["error"]["message"]
            .as_str()
            .unwrap()
            .contains("was not staged")
    );
    server.shutdown();

    let mut resumed = TestAppServer::start(&workspace, &settings);
    assert!(resumed.initialize(1)["result"].is_object());
    resumed.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/resume", "params": {"threadId": &thread_id}
    }));
    assert!(resumed.response(2)["result"].is_object());
    for (id, method) in [(3, "attachment/read"), (4, "attachment/read/chunk")] {
        resumed.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &durable, "offset": 0, "length": 32}
        }));
        let response = resumed.response(id);
        assert_eq!(
            response["result"]["contentBase64"], "YXR0YWNobWVudA==",
            "{response}"
        );
    }
    let missing = durable.with_file_name("missing.txt");
    for (id, method) in [(5, "attachment/read"), (6, "attachment/read/chunk")] {
        resumed.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &missing, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&resumed.response(id), temp.path());
    }
    resumed.shutdown();
}

fn assert_attachment_read_error_is_private(response: &Value, private_root: &std::path::Path) {
    assert_eq!(response["error"]["code"], -32038, "{response}");
    let message = response["error"]["message"].as_str().unwrap();
    assert!(
        !message.contains(private_root.to_str().unwrap()),
        "{message}"
    );
    assert!(!message.contains("/"), "{message}");
}

#[test]
fn attachment_read_rejects_other_connection_staging_and_redacts_missing_directories() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut owner = TestAppServer::start(&workspace, &settings);
    assert!(owner.initialize(1)["result"].is_object());
    owner.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    assert!(owner.response(2)["result"].is_object());
    owner.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "attachment/save",
        "params": {"filename": "private.txt", "content_base64": "cHJpdmF0ZQ=="}
    }));
    let path = owner.response(3)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut peer = TestAppServer::start(&workspace, &settings);
    assert!(peer.initialize(1)["result"].is_object());
    peer.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = peer.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (id, method) in [(3, "attachment/read"), (4, "attachment/read/chunk")] {
        peer.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&peer.response(id), temp.path());
    }
    peer.send(json!({
        "jsonrpc": "2.0", "id": 5, "method": "attachment/save",
        "params": {"filename": "peer.txt", "content_base64": "cGVlcg=="}
    }));
    let peer_path = peer.response(5)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let prompt = format!(
        "peer attachment\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({"filename": "peer.txt", "path": peer_path})
    );
    peer.send(json!({
        "jsonrpc": "2.0", "id": 6, "method": "turn/start",
        "params": {"threadId": &thread_id, "input": [{"type": "text", "text": prompt}]}
    }));
    assert_eq!(peer.response(6)["result"]["turn"]["status"], "running");
    peer.wait_for_method("turn/completed");
    for (id, method) in [(7, "attachment/read"), (8, "attachment/read/chunk")] {
        peer.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&peer.response(id), temp.path());
    }
    assert_eq!(std::fs::read(&path).unwrap(), b"private");
    peer.shutdown();
    owner.shutdown();
}

#[cfg(unix)]
#[test]
fn attachment_staged_preview_rejects_symlink_and_directory_replacements() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    assert!(server.initialize(1)["result"].is_object());
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "attachment/save",
        "params": {"filename": "private.txt", "content_base64": "cHJpdmF0ZQ=="}
    }));
    let path = std::path::PathBuf::from(server.response(3)["result"]["path"].as_str().unwrap());
    let outside = temp.path().join("private.txt");
    std::fs::write(&outside, b"outside").unwrap();
    std::fs::remove_file(&path).unwrap();
    symlink(&outside, &path).unwrap();
    for (id, method) in [(4, "attachment/read"), (5, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&server.response(id), temp.path());
    }
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    for (id, method) in [(6, "attachment/read"), (7, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&server.response(id), temp.path());
    }
    std::fs::remove_dir(&path).unwrap();
    let directory = path.parent().unwrap();
    std::fs::remove_dir(directory).unwrap();
    symlink(temp.path(), directory).unwrap();
    for (id, method) in [(8, "attachment/read"), (9, "attachment/read/chunk")] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method,
            "params": {"threadId": &thread_id, "path": &path, "offset": 0, "length": 32}
        }));
        assert_attachment_read_error_is_private(&server.response(id), temp.path());
    }
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    server.shutdown();
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
}

#[test]
fn attachment_chunk_rpc_crosses_the_legacy_direct_upload_limit() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    assert!(server.initialize(1)["result"].is_object());
    server.send(json!({"jsonrpc": "2.0", "id": 20, "method": "thread/start", "params": {}}));
    let thread_id = server.response(20)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let payload = vec![b'z'; 300 * 1024];
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "attachment/upload/start",
        "params": {"filename": "large.bin", "size": payload.len()}
    }));
    let upload_id = server.response(2)["result"]["upload_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (index, chunk) in payload.chunks(200 * 1024).enumerate() {
        let request_id = 3 + index as i64;
        server.send(json!({
            "jsonrpc": "2.0", "id": request_id, "method": "attachment/upload/chunk",
            "params": {
                "upload_id": &upload_id,
                "index": index,
                "content_base64": base64::engine::general_purpose::STANDARD.encode(chunk)
            }
        }));
        assert_eq!(server.response(request_id)["result"]["accepted"], true);
    }
    server.send(json!({
        "jsonrpc": "2.0", "id": 10, "method": "attachment/upload/finish",
        "params": {"upload_id": upload_id}
    }));
    let path = server.response(10)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(std::fs::read(&path).unwrap(), payload);

    let prompt = format!(
        "large attachment\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({"filename": "large.bin", "path": path})
    );
    server.send(json!({
        "jsonrpc": "2.0", "id": 21, "method": "turn/start",
        "params": {"threadId": &thread_id, "input": [{"type": "text", "text": prompt}]}
    }));
    assert_eq!(server.response(21)["result"]["turn"]["status"], "running");
    server.wait_for_method("turn/completed");

    server.send(json!({
        "jsonrpc": "2.0", "id": 22, "method": "attachment/read",
        "params": {"threadId": &thread_id, "path": &path}
    }));
    assert!(
        server.response(22)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("256 KiB")
    );

    let mut downloaded = Vec::new();
    let mut offset = 0_u64;
    for request_id in 30..40 {
        server.send(json!({
            "jsonrpc": "2.0", "id": request_id, "method": "attachment/read/chunk",
            "params": {"threadId": &thread_id, "path": &path, "offset": offset, "length": 200 * 1024}
        }));
        let result = server.response(request_id)["result"].clone();
        assert_eq!(result["offset"], offset);
        assert_eq!(result["totalSize"], payload.len() as u64);
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(result["contentBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(result["size"], chunk.len() as u64);
        offset += chunk.len() as u64;
        downloaded.extend_from_slice(&chunk);
        if result["eof"] == true {
            break;
        }
    }
    assert_eq!(downloaded, payload);
    server.shutdown();
}
