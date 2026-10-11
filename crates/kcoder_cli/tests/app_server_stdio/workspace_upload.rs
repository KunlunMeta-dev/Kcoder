fn stage_workspace_upload(server: &mut TestAppServer, bytes: &[u8]) -> String {
    server.send(
        json!({"jsonrpc":"2.0", "id":700, "method":"attachment/upload/start",
        "params":{"filename":"upload.bin", "size":bytes.len()}}),
    );
    let start = server.response(700);
    let upload_id = start["result"]["upload_id"].as_str().unwrap();
    for (index, chunk) in bytes.chunks(192 * 1024).enumerate() {
        server.send(
            json!({"jsonrpc":"2.0", "id":701, "method":"attachment/upload/chunk",
            "params":{"upload_id":upload_id, "index":index,
                "content_base64":base64::engine::general_purpose::STANDARD.encode(chunk)}}),
        );
        assert_eq!(server.response(701)["result"]["accepted"], true);
    }
    server.send(
        json!({"jsonrpc":"2.0", "id":702, "method":"attachment/upload/finish",
        "params":{"upload_id":upload_id}}),
    );
    server.response(702)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn publish_workspace_upload(server: &mut TestAppServer, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0", "id":703,
        "method":"workspace/file/importAttachment", "params":params}));
    server.response(703)
}

#[test]
fn workspace_upload_publishes_complete_binary_and_empty_files_without_a_thread() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let destination = workspace.join("nested");
    std::fs::create_dir_all(&destination).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workspaceFileImportV1"],
        true
    );
    let bytes: Vec<u8> = (0..600_123).map(|n| (n % 251) as u8).collect();
    for (name, content) in [
        ("资料.bin", bytes.as_slice()),
        ("empty.txt", b"".as_slice()),
    ] {
        let staged = stage_workspace_upload(&mut server, content);
        let params = json!({"attachmentPath":staged,"parentPath":destination,"filename":name});
        let receipt = publish_workspace_upload(&mut server, params.clone());
        assert_eq!(receipt["result"]["status"], "uploaded", "{receipt}");
        assert_eq!(receipt["result"]["size"], content.len());
        assert_eq!(
            receipt["result"]["sha256"],
            format!("{:x}", Sha256::digest(content))
        );
        assert_eq!(std::fs::read(destination.join(name)).unwrap(), content);
        assert!(!std::path::Path::new(&staged).exists());
        assert!(publish_workspace_upload(&mut server, params)["error"].is_object());
    }
    server.send(json!({"jsonrpc":"2.0", "id":704, "method":"thread/list","params":{}}));
    assert!(
        server.response(704)["result"]["threads"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    server.shutdown();
}

#[test]
fn workspace_upload_conflict_cancel_and_confirmed_replace_preserve_changes() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    server.initialize(1);
    let target = workspace.join("same.txt");
    std::fs::write(&target, b"original").unwrap();
    let staged = stage_workspace_upload(&mut server, b"replacement");
    let mut params = json!({"attachmentPath":staged,"parentPath":workspace,"filename":"same.txt"});
    let conflict = publish_workspace_upload(&mut server, params.clone());
    assert_eq!(conflict["result"]["status"], "conflict");
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    assert!(std::path::Path::new(&staged).exists());
    params["overwrite"] = json!(true);
    params["expectedRevision"] = conflict["result"]["revision"].clone();
    std::fs::write(&target, b"concurrently changed").unwrap();
    let changed = publish_workspace_upload(&mut server, params.clone());
    assert_eq!(changed["result"]["status"], "conflict");
    assert_ne!(
        changed["result"]["revision"],
        conflict["result"]["revision"]
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"concurrently changed");
    params["expectedRevision"] = changed["result"]["revision"].clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        // Filesystem change times can share one coarse clock tick. Confirm an
        // explicit metadata change without depending on scheduler timing.
        let modified = std::fs::metadata(&target).unwrap().modified().unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified + Duration::from_secs(1)))
            .unwrap();
        let next = publish_workspace_upload(&mut server, params.clone());
        assert_eq!(next["result"]["status"], "conflict");
        params["expectedRevision"] = next["result"]["revision"].clone();
    }
    let receipt = publish_workspace_upload(&mut server, params);
    assert_eq!(receipt["result"]["status"], "uploaded", "{receipt}");
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o750
        );
    }
    let cancelled = stage_workspace_upload(&mut server, b"cancelled");
    let conflict = publish_workspace_upload(
        &mut server,
        json!({"attachmentPath":cancelled,
        "parentPath":workspace,"filename":"same.txt"}),
    );
    assert_eq!(conflict["result"]["status"], "conflict");
    server.send(
        json!({"jsonrpc":"2.0", "id":704,"method":"attachment/delete","params":{"path":cancelled}}),
    );
    assert!(server.response(704)["result"].is_object());
    assert!(!std::path::Path::new(&cancelled).exists());
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    server.shutdown();
}

#[test]
fn workspace_upload_rejects_unowned_staging_and_paths_outside_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut owner = TestAppServer::start(&workspace, &settings);
    let mut peer = TestAppServer::start(&workspace, &settings);
    owner.initialize(1);
    peer.initialize(1);
    let staged = stage_workspace_upload(&mut owner, b"private");
    assert!(
        publish_workspace_upload(
            &mut peer,
            json!({"attachmentPath":staged,
        "parentPath":workspace,"filename":"private.txt"})
        )["error"]
            .is_object()
    );
    for (parent, name) in [
        (&outside, "escape.txt"),
        (&workspace, "../escape.txt"),
        (&workspace, "a/b"),
    ] {
        assert!(
            publish_workspace_upload(
                &mut owner,
                json!({"attachmentPath":staged,
            "parentPath":parent,"filename":name})
            )["error"]
                .is_object()
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("escape.txt"), workspace.join("link.txt")).unwrap();
        assert!(
            publish_workspace_upload(
                &mut owner,
                json!({"attachmentPath":staged,
            "parentPath":workspace,"filename":"link.txt"})
            )["error"]
                .is_object()
        );
    }
    assert!(!outside.join("escape.txt").exists());
    assert!(!workspace.join("private.txt").exists());
    assert!(std::path::Path::new(&staged).exists());
    owner.shutdown();
    assert!(!std::path::Path::new(&staged).exists());
    peer.shutdown();
}

#[test]
fn workspace_upload_revision_matches_binary_preview_even_before_epoch() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let target = workspace.join("historical.bin");
    let file = std::fs::File::create(&target).unwrap();
    file.set_times(
        std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH - Duration::from_secs(1)),
    )
    .unwrap();
    drop(file);
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"device/execute",
        "params":{"command_key":"workspace_read_file_chunk","path":workspace,
            "args":["historical.bin","0"]}}));
    let preview = server.response(2);
    let revision = preview["result"]["stdout"]["revision"].as_str().unwrap();
    assert!(revision.starts_with("file-v1:"));
    let staged = stage_workspace_upload(&mut server, b"new");
    let conflict = publish_workspace_upload(
        &mut server,
        json!({"attachmentPath":staged,
        "parentPath":workspace,"filename":"historical.bin"}),
    );
    assert_eq!(conflict["result"]["revision"], revision, "{conflict}");
    let stale = publish_workspace_upload(
        &mut server,
        json!({"attachmentPath":staged,
        "parentPath":workspace,"filename":"historical.bin","overwrite":true,
        "expectedRevision":"stat:legacy"}),
    );
    assert_eq!(stale["result"]["status"], "conflict");
    let saved = publish_workspace_upload(
        &mut server,
        json!({"attachmentPath":staged,
        "parentPath":workspace,"filename":"historical.bin","overwrite":true,
        "expectedRevision":revision}),
    );
    assert_eq!(saved["result"]["status"], "uploaded", "{saved}");
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    server.shutdown();
}
