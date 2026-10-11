// Model-independent: real app-server stdio and files, without starting a turn.
#[test]
fn workspace_text_save_preserves_full_revision_and_refuses_invalid_originals() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::start(&workspace, &settings);
    server.initialize(1);

    // Put four-byte scalars across the 64 KiB reader boundary.
    let original = format!("{}😀中é\r\n{}", "a".repeat(65_535), "尾".repeat(25_000));
    let file = workspace.join("unicode.txt");
    std::fs::write(&file, &original).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    }
    let revision = format!("sha256:{:x}", Sha256::digest(original.as_bytes()));
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"device/execute",
        "params":{"command_key":"workspace_write_text_file","path":workspace,
            "args":["unicode.txt",revision],"stdin":"已保存 😀\r\n"}}));
    let saved = server.response(2);
    assert_eq!(saved["result"]["success"], true, "{saved}");
    assert_eq!(saved["result"]["stdout"]["content"], "已保存 😀\r\n");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "已保存 😀\r\n");
    let previous = saved["result"]["stdout"]["previous_version_path"]
        .as_str()
        .unwrap();
    assert_eq!(std::fs::read_to_string(previous).unwrap(), original);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    for (index, (name, bytes)) in [
        (
            "invalid.txt",
            [vec![b'a'; 65_535], vec![0xf0, 0x9f]].concat(),
        ),
        ("grown.txt", "原文".repeat(400_000).into_bytes()),
    ]
    .into_iter()
    .enumerate()
    {
        let path = workspace.join(name);
        std::fs::write(&path, &bytes).unwrap();
        server.send(
            json!({"jsonrpc":"2.0","id":3+index,"method":"device/execute",
            "params":{"command_key":"workspace_write_text_file","path":workspace,
                "args":[name,"sha256:stale"],"stdin":"must-not-win"}}),
        );
        let rejected = server.response((3 + index) as i64);
        assert!(rejected["error"].is_object(), "{rejected}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"thread/list","params":{}}));
    assert!(
        server.response(5)["result"]["threads"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    server.shutdown();
}

#[test]
fn workspace_text_two_process_writers_share_a_commit_lease() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("same.txt"), "original").unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut left = TestAppServer::start(&workspace, &settings);
    let mut right = TestAppServer::start(&workspace, &settings);
    left.initialize(1);
    right.initialize(1);
    let expected = format!("sha256:{:x}", Sha256::digest(b"original"));
    for (server, content) in [(&mut left, "left"), (&mut right, "right")] {
        server.send(json!({"jsonrpc":"2.0","id":2,"method":"device/execute",
            "params":{"command_key":"workspace_write_text_file","path":workspace,
                "args":["same.txt",expected],"stdin":content}}));
    }
    let results = [left.response(2), right.response(2)];
    assert_eq!(
        results
            .iter()
            .filter(|value| value["result"]["success"] == true)
            .count(),
        1,
        "{results:?}"
    );
    assert_eq!(
        results
            .iter()
            .filter(|value| value["error"].is_object())
            .count(),
        1,
        "{results:?}"
    );
    let winner = results
        .iter()
        .find(|value| value["result"]["success"] == true)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace.join("same.txt")).unwrap(),
        winner["result"]["stdout"]["content"].as_str().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(
            winner["result"]["stdout"]["previous_version_path"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        "original"
    );
    left.shutdown();
    right.shutdown();
}

#[cfg(unix)]
#[test]
fn workspace_startup_rejects_aliased_builtin_skill_commit_logs() {
    for hardlink in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let config = temp.path().join("profile");
        let builtin = config.join("skills/.builtin");
        std::fs::create_dir_all(&builtin).unwrap();
        let external = temp.path().join("external");
        std::fs::write(&external, b"\n").unwrap();
        let log = builtin.join(".commits.jsonl");
        if hardlink {
            std::fs::hard_link(&external, &log).unwrap();
        } else {
            std::os::unix::fs::symlink(&external, &log).unwrap();
        }
        let settings = temp.path().join("settings.json");
        write_test_settings(&settings);
        let result = Command::new(env!("CARGO_BIN_EXE_kcoder"))
            .args([
                "--settings-file",
                settings.to_str().unwrap(),
                "--cwd",
                workspace.to_str().unwrap(),
                "app-server",
                "--scenario",
                "full-turn",
            ])
            .env("KCODER_CONFIG_DIR", &config)
            .env("XDG_CONFIG_HOME", &config)
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_TTY")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success(),
            "aliased built-in log was accepted"
        );
        assert!(
            stderr.contains("skill log"),
            "unexpected startup failure: {stderr}"
        );
        assert_eq!(std::fs::read(&external).unwrap(), b"\n");
    }
}
