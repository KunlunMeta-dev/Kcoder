#[test]
fn stdio_app_server_worktree_settings_load_refresh_and_persist() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let settings = temp.path().join("runtime-settings.json");
    std::fs::create_dir(&workspace).unwrap();
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .spawn();
    assert!(server.initialize(1).get("error").is_none());

    // The settings page requests both methods, including for a fresh profile.
    for (id, method) in [
        (2, "runtime.worktrees.settings.get"),
        (3, "runtime.worktrees.list"),
        (4, "runtime.worktrees.list"),
    ] {
        server.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": {}}));
        let response = server.response(id);
        assert!(response.get("error").is_none(), "{response}");
        if method.ends_with(".list") {
            assert_eq!(response["result"]["items"], json!([]));
        }
    }
    assert!(find_named_file(&config, "managed-worktrees.json").is_none());

    for (id, keep_count) in [(5, 7), (6, 9)] {
        server.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "runtime.worktrees.settings.update",
            "params": {"keepCount": keep_count}
        }));
        let response = server.response(id);
        assert!(response.get("error").is_none(), "{response}");
    }
    let registry = find_named_file(&config, "managed-worktrees.json").unwrap();
    let modified = std::fs::metadata(&registry).unwrap().modified().unwrap();
    server
        .send(json!({"jsonrpc": "2.0", "id": 7, "method": "runtime.worktrees.list", "params": {}}));
    let response = server.response(7);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        std::fs::metadata(&registry).unwrap().modified().unwrap(),
        modified
    );
    server.shutdown_successfully();

    let mut resumed = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .spawn();
    assert!(resumed.initialize(8).get("error").is_none());
    resumed.send(json!({"jsonrpc": "2.0", "id": 9, "method": "runtime.worktrees.settings.get", "params": {}}));
    let response = resumed.response(9);
    assert_eq!(response["result"]["keepCount"], 9, "{response}");
    resumed.shutdown_successfully();

    // Seed an active entry whose directory has disappeared outside the app.
    let mut state: Value = serde_json::from_slice(&std::fs::read(&registry).unwrap()).unwrap();
    let missing_path =
        std::path::Path::new(state["settings"]["resolvedWorktreeRoot"].as_str().unwrap())
            .join("task-missing")
            .join("repository")
            .to_string_lossy()
            .into_owned();
    state["records"][&missing_path] = json!({
        "worktreeId": "task-missing", "path": missing_path,
        "repositoryName": "repository", "state": "active", "revision": 1
    });
    std::fs::write(&registry, serde_json::to_vec(&state).unwrap()).unwrap();
    for (initialize_id, list_id) in [(10, 11), (12, 13)] {
        let mut reader = TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .spawn();
        assert!(reader.initialize(initialize_id).get("error").is_none());
        reader.send(json!({"jsonrpc": "2.0", "id": list_id, "method": "runtime.worktrees.list", "params": {}}));
        let response = reader.response(list_id);
        assert_eq!(
            response["result"]["items"][0]["state"], "missing",
            "{response}"
        );
        assert_eq!(response["result"]["items"][0]["revision"], 2, "{response}");
        reader.shutdown_successfully();
        let persisted: Value = serde_json::from_slice(&std::fs::read(&registry).unwrap()).unwrap();
        assert_eq!(persisted["records"][&missing_path]["state"], "missing");
        assert_eq!(persisted["records"][&missing_path]["revision"], 2);
    }
    assert!(!workspace.join(".kcoder").exists());
}

#[test]
fn stdio_app_server_manages_clean_git_worktrees_outside_the_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let worktree_root = temp.path().join("worktrees");
    let secondary_workspace = temp.path().join("secondary-workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&secondary_workspace).unwrap();
    std::fs::write(workspace.join("README.md"), "initial\n").unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "KCoder Test"]);
    git(&["config", "user.email", "kcoder@example.invalid"]);
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);
    std::fs::write(secondary_workspace.join("README.md"), "secondary\n").unwrap();
    let secondary_git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(&secondary_workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "secondary git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    secondary_git(&["init", "-b", "main"]);
    secondary_git(&["config", "user.name", "KCoder Test"]);
    secondary_git(&["config", "user.email", "kcoder@example.invalid"]);
    secondary_git(&["add", "README.md"]);
    secondary_git(&["commit", "-m", "secondary"]);

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
    let mut child = Command::new(env!("CARGO_BIN_EXE_kcoder"))
        .args([
            "--settings-file",
            settings.to_str().unwrap(),
            "--cwd",
            workspace.to_str().unwrap(),
            "app-server",
            "--scenario",
            "full-turn",
        ])
        .env("XDG_CONFIG_HOME", &config)
        .env("KCODER_CONFIG_DIR", &config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let _ = tx.send(line);
        }
    });
    let stdin = child.stdin.as_mut().unwrap();
    let requests = [
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "worktree-test", "version": "1"}}
        }),
        json!({
            "jsonrpc": "2.0", "id": 2, "method": "runtime.worktrees.settings.update",
            "params": {"deviceId": "local", "worktreeRoot": worktree_root, "keepCount": 7}
        }),
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "runtime.worktrees.prepare",
            "params": {"deviceId": "local", "sourcePath": workspace, "worktreeId": "task-1", "ref": "main"}
        }),
    ];
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let response = receive_response(&rx, request["id"].as_i64().unwrap());
        assert!(response.get("error").is_none(), "{response}");
    }
    let prepared = worktree_root.join("task-1").join("workspace");
    assert!(prepared.join("README.md").is_file());

    let unsafe_delete = json!({
        "jsonrpc": "2.0", "id": 47, "method": "runtime.worktrees.delete",
        "params": {"deviceId": "local", "path": prepared, "preserveSnapshot": false}
    });
    writeln!(stdin, "{unsafe_delete}").unwrap();
    stdin.flush().unwrap();
    let unsafe_delete = receive_response(&rx, 47);
    assert!(
        unsafe_delete["error"]["message"]
            .as_str()
            .unwrap()
            .contains("irreversible")
    );
    assert!(prepared.exists());

    let list_request = json!({
        "jsonrpc": "2.0", "id": 4, "method": "runtime.worktrees.list",
        "params": {"deviceId": "local"}
    });
    writeln!(stdin, "{list_request}").unwrap();
    stdin.flush().unwrap();
    let listed = receive_response(&rx, 4);
    assert_eq!(listed["result"]["items"][0]["state"], "active");
    let revision = listed["result"]["items"][0]["revision"].as_u64().unwrap();

    let preview_request = json!({
        "jsonrpc": "2.0", "id": 5, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": prepared}
    });
    writeln!(stdin, "{preview_request}").unwrap();
    stdin.flush().unwrap();
    let preview = receive_response(&rx, 5);
    assert!(preview.get("error").is_none(), "{preview}");
    assert_eq!(preview["result"]["preview"]["archiveAllowed"], true);
    let content_token = preview["result"]["preview"]["contentToken"]
        .as_str()
        .unwrap();
    std::fs::write(prepared.join("README.md"), "changed after preview\n").unwrap();
    let stale_archive = json!({
        "jsonrpc": "2.0", "id": 44, "method": "runtime.worktrees.archive",
        "params": {
            "deviceId": "local", "path": prepared,
            "expectedRevision": revision, "expectedContentToken": content_token,
            "riskAccepted": true
        }
    });
    writeln!(stdin, "{stale_archive}").unwrap();
    stdin.flush().unwrap();
    let stale = receive_response(&rx, 44);
    assert!(
        stale["error"]["message"]
            .as_str()
            .unwrap()
            .contains("content changed")
    );
    assert!(prepared.exists());
    std::fs::write(prepared.join("README.md"), "initial\n").unwrap();
    let refreshed_preview = json!({
        "jsonrpc": "2.0", "id": 45, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": prepared}
    });
    writeln!(stdin, "{refreshed_preview}").unwrap();
    stdin.flush().unwrap();
    let refreshed_preview = receive_response(&rx, 45);
    let content_token = refreshed_preview["result"]["preview"]["contentToken"]
        .as_str()
        .unwrap();
    let archive_request = json!({
        "jsonrpc": "2.0", "id": 6, "method": "runtime.worktrees.archive",
        "params": {
            "deviceId": "local", "path": prepared,
            "expectedRevision": revision, "expectedContentToken": content_token
        }
    });
    writeln!(stdin, "{archive_request}").unwrap();
    stdin.flush().unwrap();
    let archived = receive_response(&rx, 6);
    assert!(archived.get("error").is_none(), "{archived}");
    assert!(!prepared.exists());
    assert_eq!(archived["result"]["worktree"]["state"], "restorable");
    let archived_revision = archived["result"]["worktree"]["revision"].as_u64().unwrap();

    let restore_request = json!({
        "jsonrpc": "2.0", "id": 7, "method": "runtime.worktrees.restore",
        "params": {"deviceId": "local", "path": prepared, "expectedRevision": archived_revision}
    });
    writeln!(stdin, "{restore_request}").unwrap();
    stdin.flush().unwrap();
    let restored = receive_response(&rx, 7);
    assert!(restored.get("error").is_none(), "{restored}");
    assert!(prepared.join("README.md").is_file());
    assert_eq!(restored["result"]["worktree"]["state"], "active");

    let models_request = json!({
        "jsonrpc": "2.0", "id": 8, "method": "runtime.models.list", "params": {}
    });
    writeln!(stdin, "{models_request}").unwrap();
    stdin.flush().unwrap();
    let models = receive_response(&rx, 8);
    assert_eq!(models["result"]["providers"][0]["id"], "integration-test");
    assert_eq!(
        models["result"]["providers"][0]["data"][0]["model"],
        "deterministic-scenario"
    );
    let skills_request = json!({
        "jsonrpc": "2.0", "id": 9, "method": "device/execute",
        "params": {"command_key": "ls_skills"}
    });
    writeln!(stdin, "{skills_request}").unwrap();
    stdin.flush().unwrap();
    let skills = receive_response(&rx, 9);
    assert!(skills["result"]["stdout"].is_array());
    let search_request = json!({
        "jsonrpc": "2.0", "id": 10, "method": "runtime.workspace.search",
        "params": {"deviceId": "local", "root": prepared, "query": "readme"}
    });
    writeln!(stdin, "{search_request}").unwrap();
    stdin.flush().unwrap();
    let search = receive_response(&rx, 10);
    assert_eq!(search["result"]["files"][0]["path"], "README.md");
    let outside_search = json!({
        "jsonrpc": "2.0", "id": 11, "method": "runtime.workspace.search",
        "params": {"deviceId": "local", "root": config, "query": "settings"}
    });
    writeln!(stdin, "{outside_search}").unwrap();
    stdin.flush().unwrap();
    let outside = receive_response(&rx, 11);
    assert!(
        outside["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("has not been opened")
    );

    for request in [
        json!({
            "jsonrpc": "2.0", "id": 12, "method": "runtime.workspaces.open",
            "params": {"deviceId": "local", "runtime": "kcoder", "workspacePath": secondary_workspace, "label": "Second"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 13, "method": "runtime.workspaces.list",
            "params": {"deviceId": "local"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 14, "method": "runtime.workspaces.rename",
            "params": {"deviceId": "local", "runtime": "kcoder", "workspacePath": secondary_workspace, "name": "Renamed"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 15, "method": "runtime.sidebar.projects.pin",
            "params": {"deviceId": "local", "projectKey": secondary_workspace, "pinned": true}
        }),
        json!({
            "jsonrpc": "2.0", "id": 16, "method": "runtime.sidebar.projects.appearance",
            "params": {"deviceId": "local", "projectKey": secondary_workspace, "appearance": {"color": "blue"}}
        }),
        json!({
            "jsonrpc": "2.0", "id": 17, "method": "runtime.workspaces.list",
            "params": {"deviceId": "local"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 23, "method": "runtime.worktrees.prepare",
            "params": {"deviceId": "local", "sourcePath": secondary_workspace, "worktreeId": "task-secondary", "ref": "main"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 24, "method": "runtime.worktrees.list",
            "params": {"deviceId": "local"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 18, "method": "runtime.workspaces.remove",
            "params": {"deviceId": "local", "runtime": "kcoder", "workspacePath": secondary_workspace}
        }),
        json!({
            "jsonrpc": "2.0", "id": 19, "method": "runtime.workspaces.list",
            "params": {"deviceId": "local"}
        }),
    ] {
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let response = receive_response(&rx, request["id"].as_i64().unwrap());
        assert!(response.get("error").is_none(), "{response}");
        match request["id"].as_i64().unwrap() {
            12 => {
                assert_eq!(response["result"]["accepted"], true);
                assert_eq!(response["result"]["runtime"], "kcoder");
            }
            13 => assert_eq!(response["result"]["items"][0]["label"], "Second"),
            17 => {
                assert_eq!(response["result"]["items"][0]["label"], "Renamed");
                assert_eq!(response["result"]["items"][0]["projectPinned"], true);
                assert_eq!(
                    response["result"]["items"][0]["projectAppearance"]["color"],
                    "blue"
                );
            }
            23 => {
                assert_eq!(response["result"]["success"], true);
                assert!(
                    std::path::Path::new(response["result"]["path"].as_str().unwrap()).is_dir()
                );
            }
            24 => assert!(response["result"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["worktreeId"] == "task-secondary"
                    && item["state"] == "active")),
            19 => assert_eq!(response["result"]["items"], json!([])),
            _ => assert_eq!(response["result"]["accepted"], true),
        }
    }

    let prepared_workspace = temp.path().join("prepared-workspace");
    for request in [
        json!({
            "jsonrpc": "2.0", "id": 20, "method": "runtime.workspaces.prepare",
            "params": {"deviceId": "local", "projectId": 42, "workspacePath": prepared_workspace, "action": "create", "label": "Prepared"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 21, "method": "runtime.workspaces.list",
            "params": {"deviceId": "local"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 22, "method": "runtime.workspaces.delete",
            "params": {"deviceId": "local", "projectId": 42, "workspacePath": prepared_workspace}
        }),
    ] {
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let response = receive_response(&rx, request["id"].as_i64().unwrap());
        assert!(response.get("error").is_none(), "{response}");
        match request["id"].as_i64().unwrap() {
            20 => {
                assert_eq!(response["result"]["preparedAction"], "created");
                assert_eq!(response["result"]["mapping"]["projectId"], 42);
                assert!(prepared_workspace.is_dir());
            }
            21 => {
                assert_eq!(response["result"]["items"][0]["label"], "Prepared");
                assert_eq!(response["result"]["items"][0]["available"], true);
                std::fs::remove_dir(&prepared_workspace).unwrap();
                let missing_list = json!({
                    "jsonrpc": "2.0", "id": 27, "method": "runtime.workspaces.list",
                    "params": {"deviceId": "local"}
                });
                writeln!(stdin, "{missing_list}").unwrap();
                stdin.flush().unwrap();
                let missing_response = receive_response(&rx, 27);
                assert_eq!(missing_response["result"]["items"][0]["available"], false);
                assert_eq!(
                    missing_response["result"]["items"][0]["error"],
                    "workspace directory is unavailable"
                );
            }
            22 => assert_eq!(response["result"]["deleted"], true),
            _ => unreachable!(),
        }
    }

    let local_project_primary = temp.path().join("z-local-project-primary");
    let local_project_secondary = temp.path().join("a-local-project-secondary");
    std::fs::create_dir(&local_project_primary).unwrap();
    std::fs::create_dir(&local_project_secondary).unwrap();
    let upsert_project = json!({
        "jsonrpc": "2.0", "id": 25, "method": "runtime.projects.upsert_local",
        "params": {
            "deviceId": "local",
            "runtime": "kcoder",
            "projectKey": "project:test-local",
            "name": "Test local project",
            "roots": [local_project_primary, local_project_secondary]
        }
    });
    writeln!(stdin, "{upsert_project}").unwrap();
    stdin.flush().unwrap();
    let upsert_response = receive_response(&rx, 25);
    assert!(upsert_response.get("error").is_none(), "{upsert_response}");
    assert_eq!(upsert_response["result"]["accepted"], true);
    assert_eq!(upsert_response["result"]["runtime"], "kcoder");
    assert_eq!(
        upsert_response["result"]["roots"],
        json!([local_project_primary, local_project_secondary])
    );
    let list_local_project = json!({
        "jsonrpc": "2.0", "id": 26, "method": "runtime.workspaces.list",
        "params": {"deviceId": "local"}
    });
    writeln!(stdin, "{list_local_project}").unwrap();
    stdin.flush().unwrap();
    let list_local_project_response = receive_response(&rx, 26);
    assert!(
        list_local_project_response.get("error").is_none(),
        "{list_local_project_response}"
    );
    assert_eq!(
        list_local_project_response["result"]["items"][0]["projectRoots"],
        json!([local_project_primary, local_project_secondary])
    );

    std::fs::write(prepared.join(".gitignore"), "secret.log\n").unwrap();
    std::fs::write(prepared.join("secret.log"), "must not be lost\n").unwrap();
    let ignored_preview = json!({
        "jsonrpc": "2.0", "id": 46, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": prepared}
    });
    writeln!(stdin, "{ignored_preview}").unwrap();
    stdin.flush().unwrap();
    let ignored_preview = receive_response(&rx, 46);
    assert_eq!(
        ignored_preview["result"]["preview"]["archiveAllowed"],
        false
    );
    assert!(
        ignored_preview["result"]["preview"]["ignoredEntryCount"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(prepared.join("secret.log").exists());
    std::fs::remove_file(prepared.join("secret.log")).unwrap();
    std::fs::remove_file(prepared.join(".gitignore")).unwrap();

    std::fs::write(prepared.join("README.md"), "tracked change\n").unwrap();
    std::fs::write(prepared.join("dirty.txt"), "do not lose\n").unwrap();
    let dirty_preview = json!({
        "jsonrpc": "2.0", "id": 40, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": prepared}
    });
    writeln!(stdin, "{dirty_preview}").unwrap();
    stdin.flush().unwrap();
    let preview = receive_response(&rx, 40);
    assert_eq!(preview["result"]["preview"]["dirty"], true);
    assert_eq!(preview["result"]["preview"]["requiresConfirmation"], true);
    let dirty_revision = preview["result"]["preview"]["revision"].as_u64().unwrap();
    let dirty_content_token = preview["result"]["preview"]["contentToken"]
        .as_str()
        .unwrap();
    let dirty_archive = json!({
        "jsonrpc": "2.0", "id": 27, "method": "runtime.worktrees.archive",
        "params": {
            "deviceId": "local",
            "path": prepared,
            "expectedRevision": dirty_revision,
            "expectedContentToken": dirty_content_token,
            "riskAccepted": true,
            "archivedConversations": [{
                "deviceId": "local",
                "taskId": "kcoder:local:archived-thread",
                "threadId": "archived-thread",
                "workspacePath": prepared,
                "title": "Archived worktree task",
                "createdAt": 10,
                "updatedAt": 20
            }]
        }
    });
    writeln!(stdin, "{dirty_archive}").unwrap();
    stdin.flush().unwrap();
    let response = receive_response(&rx, 27);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["worktree"]["state"], "restorable");
    assert!(response["result"]["worktree"]["snapshotAt"].is_number());
    assert_eq!(
        response["result"]["worktree"]["archivedConversations"][0]["taskId"],
        "kcoder:local:archived-thread"
    );
    assert!(!prepared.exists());
    let dirty_archived_revision = response["result"]["worktree"]["revision"].as_u64().unwrap();

    let list_archived_index = json!({
        "jsonrpc": "2.0", "id": 30, "method": "runtime.worktrees.list",
        "params": {"deviceId": "local"}
    });
    writeln!(stdin, "{list_archived_index}").unwrap();
    stdin.flush().unwrap();
    let response = receive_response(&rx, 30);
    let archived_worktree = response["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == prepared.to_string_lossy().as_ref())
        .unwrap();
    assert_eq!(
        archived_worktree["conversations"][0]["taskId"],
        "kcoder:local:archived-thread"
    );

    let task_2 = worktree_root.join("task-2").join("workspace");
    let prepare_task_2 = json!({
        "jsonrpc": "2.0", "id": 32, "method": "runtime.worktrees.prepare",
        "params": {"deviceId": "local", "sourcePath": workspace, "worktreeId": "task-2", "ref": "main"}
    });
    writeln!(stdin, "{prepare_task_2}").unwrap();
    stdin.flush().unwrap();
    assert!(receive_response(&rx, 32).get("error").is_none());
    let preview_task_2 = json!({
        "jsonrpc": "2.0", "id": 33, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": task_2}
    });
    writeln!(stdin, "{preview_task_2}").unwrap();
    stdin.flush().unwrap();
    let preview_task_2 = receive_response(&rx, 33);
    let archive_task_2 = json!({
        "jsonrpc": "2.0", "id": 34, "method": "runtime.worktrees.archive",
        "params": {
            "deviceId": "local", "path": task_2,
            "expectedRevision": preview_task_2["result"]["preview"]["revision"],
            "expectedContentToken": preview_task_2["result"]["preview"]["contentToken"]
        }
    });
    writeln!(stdin, "{archive_task_2}").unwrap();
    stdin.flush().unwrap();
    let archived_task_2 = receive_response(&rx, 34);
    assert!(archived_task_2.get("error").is_none(), "{archived_task_2}");
    let forget_task_2 = json!({
        "jsonrpc": "2.0", "id": 35, "method": "runtime.worktrees.forget",
        "params": {
            "deviceId": "local", "path": task_2,
            "expectedRevision": archived_task_2["result"]["worktree"]["revision"],
            "confirmPermanent": true
        }
    });
    writeln!(stdin, "{forget_task_2}").unwrap();
    stdin.flush().unwrap();
    assert_eq!(receive_response(&rx, 35)["result"]["forgotten"], true);
    for request in [
        json!({
            "jsonrpc": "2.0", "id": 36, "method": "runtime.worktrees.settings.update",
            "params": {"deviceId": "local", "keepCount": 1}
        }),
        json!({
            "jsonrpc": "2.0", "id": 37, "method": "runtime.worktrees.prune",
            "params": {"deviceId": "local"}
        }),
        json!({
            "jsonrpc": "2.0", "id": 38, "method": "runtime.worktrees.list",
            "params": {"deviceId": "local"}
        }),
    ] {
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let response = receive_response(&rx, request["id"].as_i64().unwrap());
        assert!(response.get("error").is_none(), "{response}");
        if request["id"] == 38 {
            assert!(
                response["result"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["path"] == prepared.to_string_lossy().as_ref()
                        && item["conversations"][0]["taskId"] == "kcoder:local:archived-thread")
            );
        }
    }

    let dirty_restore = json!({
        "jsonrpc": "2.0", "id": 28, "method": "runtime.worktrees.restore",
        "params": {"deviceId": "local", "path": prepared, "expectedRevision": dirty_archived_revision}
    });
    writeln!(stdin, "{dirty_restore}").unwrap();
    stdin.flush().unwrap();
    let response = receive_response(&rx, 28);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        std::fs::read_to_string(prepared.join("dirty.txt")).unwrap(),
        "do not lose\n"
    );
    assert_eq!(
        std::fs::read_to_string(prepared.join("README.md")).unwrap(),
        "tracked change\n"
    );

    let remove_archived_index = json!({
        "jsonrpc": "2.0", "id": 31, "method": "runtime.worktrees.conversations.remove",
        "params": {
            "deviceId": "local",
            "path": prepared,
            "taskId": "kcoder:local:archived-thread"
        }
    });
    writeln!(stdin, "{remove_archived_index}").unwrap();
    stdin.flush().unwrap();
    let response = receive_response(&rx, 31);
    assert_eq!(response["result"]["removed"], true);

    std::fs::write(prepared.join("discard.txt"), "discard me\n").unwrap();
    let final_preview = json!({
        "jsonrpc": "2.0", "id": 41, "method": "runtime.worktrees.archive.preview",
        "params": {"deviceId": "local", "path": prepared}
    });
    writeln!(stdin, "{final_preview}").unwrap();
    stdin.flush().unwrap();
    let final_preview = receive_response(&rx, 41);
    let final_archive = json!({
        "jsonrpc": "2.0", "id": 42, "method": "runtime.worktrees.archive",
        "params": {
            "deviceId": "local", "path": prepared,
            "expectedRevision": final_preview["result"]["preview"]["revision"],
            "expectedContentToken": final_preview["result"]["preview"]["contentToken"],
            "riskAccepted": true
        }
    });
    writeln!(stdin, "{final_archive}").unwrap();
    stdin.flush().unwrap();
    let final_archive = receive_response(&rx, 42);
    assert!(final_archive.get("error").is_none(), "{final_archive}");
    assert!(!prepared.exists());
    let forget = json!({
        "jsonrpc": "2.0", "id": 43, "method": "runtime.worktrees.forget",
        "params": {
            "deviceId": "local", "path": prepared,
            "expectedRevision": final_archive["result"]["worktree"]["revision"],
            "confirmPermanent": true
        }
    });
    writeln!(stdin, "{forget}").unwrap();
    stdin.flush().unwrap();
    assert_eq!(receive_response(&rx, 43)["result"]["forgotten"], true);

    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(!workspace.join(".kcoder").exists());
}
