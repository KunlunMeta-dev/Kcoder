// Deterministic external mutations at actual libc boundaries in a child process.
fn file_fault_library() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let source = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo must provide the workspace root"),
    )
    .join("crates/kcoder_cli/tests/fixtures/workspace_faults.c");
    let result = Command::new("cc")
        .args(["-shared", "-fPIC", "-Wall", "-Werror"])
        .arg(source)
        .arg("-o")
        .arg(directory.path().join("fault.so"))
        .arg("-ldl")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    directory
}

fn workspace_file_fault_case(mode: &str) {
    let library = file_fault_library();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let parent = workspace.join("folder");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&parent).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(parent.join("note.txt"), "ORIGINAL_TEXT").unwrap();
    std::fs::write(parent.join("source.txt"), "SOURCE_TEXT").unwrap();
    std::fs::write(outside.join("note.txt"), "OUTSIDE_SENTINEL").unwrap();
    let target = parent.join(if mode == "rename" {
        "dest.txt"
    } else {
        "note.txt"
    });
    let ready = temp.path().join("ready");
    let marker = temp.path().join("injected");
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .discard_stderr()
        .env("LD_PRELOAD", library.path().join("fault.so"))
        .env("KCODER_FILE_FAULT_MODE", mode)
        .env("KCODER_FILE_FAULT_READY", &ready)
        .env("KCODER_FILE_FAULT_MARKER", &marker)
        .env("KCODER_FILE_FAULT_PARENT", &parent)
        .env("KCODER_FILE_FAULT_TARGET", &target)
        .env("KCODER_FILE_FAULT_OUTSIDE", &outside)
        .spawn();
    server.initialize(1);
    std::fs::write(&ready, "ready").unwrap();
    let (command, args, stdin) = match mode {
        "read" => ("workspace_read_text_file", json!(["note.txt"]), ""),
        "rename" => (
            "workspace_rename_entry",
            json!(["source.txt", "dest.txt"]),
            "",
        ),
        _ => (
            "workspace_write_text_file",
            json!([
                "note.txt",
                format!("sha256:{:x}", Sha256::digest(b"ORIGINAL_TEXT"))
            ]),
            "STUDIO_EDIT",
        ),
    };
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"device/execute",
            "params":{"command_key":command,"path":parent,"args":args,"stdin":stdin}}));
    let response = server.response(2);
    assert!(
        marker.exists(),
        "injection did not fire for {mode}: {response}"
    );
    match mode {
        "read" => {
            if !response["error"].is_object() {
                assert_eq!(
                    response["result"]["stdout"]["content"], "ORIGINAL_TEXT",
                    "{response}"
                );
                assert_eq!(response["result"]["stdout"]["size"], 13);
            }
            assert!(parent.is_symlink());
            assert_eq!(
                std::fs::read_to_string(outside.join("note.txt")).unwrap(),
                "OUTSIDE_SENTINEL"
            );
        }
        "rename" => {
            assert!(response["error"].is_object(), "{response}");
            assert_eq!(
                std::fs::read_to_string(target).unwrap(),
                "EXTERNAL_NEW_TARGET"
            );
            assert_eq!(
                std::fs::read_to_string(parent.join("source.txt")).unwrap(),
                "SOURCE_TEXT"
            );
        }
        _ => {
            assert!(response["error"].is_object(), "{response}");
            if mode == "save-new-target" {
                assert_eq!(
                    std::fs::read_to_string(&target).unwrap(),
                    "EXTERNAL_NEW_TARGET"
                );
                let previous = std::fs::read_dir(&parent)
                    .unwrap()
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".kcoder-previous-")
                    })
                    .unwrap();
                assert_eq!(
                    std::fs::read_to_string(previous.path()).unwrap(),
                    "ORIGINAL_TEXT"
                );
                assert!(
                    response["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("previous version retained")
                );
            } else {
                assert_eq!(
                    std::fs::read_to_string(target).unwrap(),
                    "EXTERNAL_NEW_EDIT"
                );
            }
        }
    }
    server.shutdown();
}

#[test]
fn workspace_file_integrity_read_keeps_opened_parent_identity() {
    workspace_file_fault_case("read");
}
#[test]
fn workspace_file_integrity_rename_preserves_concurrent_destination() {
    workspace_file_fault_case("rename");
}
#[test]
fn workspace_file_integrity_save_rechecks_after_temporary_sync() {
    workspace_file_fault_case("save");
}

#[test]
fn workspace_file_integrity_save_detects_external_edit_at_old_entry_move() {
    workspace_file_fault_case("save-late");
}
#[test]
fn workspace_file_integrity_save_retains_previous_when_external_new_entry_wins() {
    workspace_file_fault_case("save-new-target");
}
