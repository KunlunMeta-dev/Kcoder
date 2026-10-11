// Fixtures run exclusively in the temporary workspace and never open a model turn.
fn lifecycle_fixture_running(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            stat.rsplit_once(") ")
                .map(|(_, fields)| !fields.starts_with('Z'))
        })
        .unwrap_or(false)
}

struct LifecycleFixturePids(Vec<u32>);
impl Drop for LifecycleFixturePids {
    fn drop(&mut self) {
        for pid in &self.0 {
            if lifecycle_fixture_running(*pid) {
                unsafe {
                    libc::kill(*pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
    }
}

fn lifecycle_fixture_pids(workspace: &std::path::Path, names: &[&str]) -> LifecycleFixturePids {
    let mut owned = LifecycleFixturePids(Vec::new());
    for name in names {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(value) = std::fs::read_to_string(workspace.join(name))
                && let Ok(pid) = value.trim().parse::<u32>()
            {
                owned.0.push(pid);
                break;
            }
            assert!(Instant::now() < deadline, "fixture did not write {name}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    owned
}

fn assert_lifecycle_fixture_stopped(pids: &LifecycleFixturePids) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while pids.0.iter().any(|pid| lifecycle_fixture_running(*pid)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        pids.0.iter().all(|pid| !lifecycle_fixture_running(*pid)),
        "owned fixture processes survived: {:?}",
        pids.0
    );
}

#[test]
fn terminal_lifecycle_rpc_eof_close_and_disconnect_clean_owned_jobs() {
    for ending in ["eof", "close", "disconnect", "eof-disconnect"] {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let script = format!(
            "set -m\ntrap '' HUP\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $$ > leader\necho $! > job\n{}wait\n",
            if ending.starts_with("eof") {
                "exec 0</dev/null 1>/dev/null 2>&1\n"
            } else {
                ""
            }
        );
        std::fs::write(workspace.join("fixture.sh"), script).unwrap();
        let settings = temp.path().join("settings.jsonc");
        write_test_settings(&settings);
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&temp.path().join("config"))
            .discard_stderr()
            .spawn();
        server.initialize(1);
        server.send(json!({"jsonrpc":"2.0","id":2,"method":"terminal/start","params":{"rows":24,"cols":80}}));
        let started = server.response(2);
        let session_id = started["result"]["session_id"]
            .as_str()
            .expect("terminal started")
            .to_string();
        server.send(json!({"jsonrpc":"2.0","id":3,"method":"terminal/write","params":{"session_id":session_id,"data":"exec bash fixture.sh\n"}}));
        assert!(server.response(3).get("result").is_some());
        let pids = lifecycle_fixture_pids(&workspace, &["leader", "job"]);
        if ending.ends_with("disconnect") {
            server.shutdown();
            assert_lifecycle_fixture_stopped(&pids);
            continue;
        }
        if ending == "close" {
            server.send(json!({"jsonrpc":"2.0","id":4,"method":"terminal/close","params":{"session_id":session_id}}));
            assert_eq!(server.response(4)["result"]["closed"], true);
        }
        assert_lifecycle_fixture_stopped(&pids);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let exited = server
                .observed
                .lock()
                .unwrap()
                .iter()
                .filter(|line| {
                    let value: Value = serde_json::from_str(line).unwrap();
                    value["method"] == "terminal/exit"
                        && value["params"]["session_id"] == session_id
                })
                .count();
            if exited > 0 {
                assert_eq!(exited, 1);
                break;
            }
            assert!(Instant::now() < deadline, "terminal/exit not emitted");
            std::thread::sleep(Duration::from_millis(10));
        }
        server.send(json!({"jsonrpc":"2.0","id":5,"method":"terminal/list","params":{}}));
        assert!(
            server.response(5)["result"]["sessions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        server.send(json!({"jsonrpc":"2.0","id":6,"method":"terminal/close","params":{"session_id":session_id}}));
        assert_eq!(server.response(6)["result"]["closed"], false);
        server.send(json!({"jsonrpc":"2.0","id":7,"method":"server/resources/read","params":{}}));
        assert_eq!(
            server.response(7)["result"]["activity"]["terminalSessions"],
            0
        );
        server.shutdown();
    }
}

#[test]
fn git_timeout_rpc_cleans_owned_hook_job_and_allows_followup_requests() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&workspace)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    std::fs::write(workspace.join("tracked.txt"), "fixture\n").unwrap();
    assert!(
        Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(&workspace)
            .output()
            .unwrap()
            .status
            .success()
    );
    let hook = workspace.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho $PPID > git-leader\necho $$ > git-hook\nsleep 30 &\necho $! > git-job\nwait\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let settings = temp.path().join("settings.jsonc");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings)
        .config_dir(&temp.path().join("config"))
        .discard_stderr()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"device/execute","params":{"command_key":"git_commit","args":["-m","fixture"],"timeout_seconds":1}}));
    let pids = lifecycle_fixture_pids(&workspace, &["git-leader", "git-hook", "git-job"]);
    assert_eq!(server.response(2)["result"]["exit_code"], 124);
    assert_lifecycle_fixture_stopped(&pids);
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"server/resources/read","params":{}}));
    assert!(server.response(3).get("result").is_some());
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"device/execute","params":{"command_key":"git_status_porcelain","timeout_seconds":2}}));
    assert_eq!(server.response(4)["result"]["success"], true);
    server.shutdown();
}
