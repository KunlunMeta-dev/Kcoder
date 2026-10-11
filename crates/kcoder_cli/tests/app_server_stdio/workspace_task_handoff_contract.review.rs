// Real app-server contract coverage for the durable workspace-to-task handoff.
// These tests exercise only the stdio server and its deterministic scenario;
// they do not assert model output or contact a configured Provider.

fn handoff_thread_start(id: i64, client_request_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/start",
        "params": {"clientRequestId": client_request_id}
    })
}

fn handoff_creation_read(id: i64, client_request_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/creation/read",
        "params": {"clientRequestId": client_request_id}
    })
}

fn set_handoff_startup_hook(settings: &std::path::Path, command: &str) {
    let mut value: Value = serde_json::from_slice(&std::fs::read(settings).unwrap()).unwrap();
    value["providers"]["integration-test"]["authentication"] = json!({"mode": "none"});
    value["hooks"] = json!({
        "SessionStart": [{"hooks": [{
            "type": "command",
            "shell": "sh",
            "timeout": 60,
            "command": command
        }]}]
    });
    std::fs::write(settings, serde_json::to_vec(&value).unwrap()).unwrap();
}

fn wait_for_file_length(path: &std::path::Path, expected: u64, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(metadata) = std::fs::metadata(path)
            && metadata.len() == expected
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} did not reach {expected} bytes",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn spawn_handoff_server_in_own_process_group(
    workspace: &std::path::Path,
    settings: &std::path::Path,
    config_dir: &std::path::Path,
    hook_identity_file: &std::path::Path,
) -> HandoffServerProcessGroup {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
    command
        .args([
            "--settings-file",
            settings.to_str().unwrap(),
            "--cwd",
            workspace.to_str().unwrap(),
            "app-server",
        ])
        .env("XDG_CONFIG_HOME", config_dir)
        .env("KCODER_CONFIG_DIR", config_dir)
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_TTY")
        .env_remove("KCODER_ACCOUNT_PRINCIPAL_ID")
        .env_remove("KCODER_WIKI_WORKER_MANAGED")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.process_group(0);

    let mut child = command.spawn().unwrap();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let process_group = child.id() as libc::pid_t;
            // SAFETY: process_group(0) gave this child its own group.
            let _ = unsafe { signal_owned_process_group(process_group, libc::SIGKILL) };
            let _ = child.wait();
            panic!("piped app-server stdout was not available");
        }
    };
    let (tx, rx) = mpsc::channel();
    let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let journal = std::sync::Arc::clone(&observed);
    let mut guard = HandoffServerProcessGroup {
        server: TestAppServer {
            stdin: child.stdin.take(),
            child,
            rx,
            observed,
        },
        hook_identity_file: hook_identity_file.to_path_buf(),
        stdout_reader: None,
        hook_may_have_started: false,
        app_server_group_cleaned: false,
        hook_group_cleaned: false,
        cleaned: false,
    };
    let reader = std::thread::Builder::new().spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if let Ok(line) = &line {
                let mut journal = journal.lock().unwrap();
                if journal.len() < 4096 {
                    journal.push(line.clone());
                }
            }
            let _ = tx.send(line);
        }
    });
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            drop(guard);
            panic!("could not start app-server stdout reader: {error}");
        }
    };
    guard.stdout_reader = Some(reader);
    guard
}

#[cfg(target_os = "linux")]
struct HandoffServerProcessGroup {
    server: TestAppServer,
    hook_identity_file: std::path::PathBuf,
    stdout_reader: Option<std::thread::JoinHandle<()>>,
    hook_may_have_started: bool,
    app_server_group_cleaned: bool,
    hook_group_cleaned: bool,
    cleaned: bool,
}

#[cfg(target_os = "linux")]
impl HandoffServerProcessGroup {
    fn mark_hook_may_have_started(&mut self) {
        self.hook_may_have_started = true;
    }

    fn terminate_and_wait(&mut self) -> std::process::ExitStatus {
        self.cleanup(true)
            .expect("owned app-server child must be reaped")
    }

    fn cleanup(&mut self, strict: bool) -> Option<std::process::ExitStatus> {
        if self.cleaned {
            return self.server.child.try_wait().ok().flatten();
        }

        let app_server_group = self.server.child.id() as libc::pid_t;
        let app_server_group_signalled = if self.app_server_group_cleaned {
            true
        } else {
            // SAFETY: process_group(0) gave this app-server child its own group.
            unsafe { signal_owned_process_group(app_server_group, libc::SIGKILL) }
        };
        drop(self.server.stdin.take());
        let status = if self.app_server_group_cleaned {
            self.server.child.try_wait().ok().flatten()
        } else if app_server_group_signalled {
            self.server.child.wait().ok()
        } else {
            self.server.child.try_wait().ok().flatten()
        };
        if app_server_group_signalled && status.is_some() {
            self.app_server_group_cleaned = true;
        }
        if self.app_server_group_cleaned
            && let Some(reader) = self.stdout_reader.take()
        {
            let _ = reader.join();
        }

        let hook_group_clean = if self.hook_group_cleaned {
            true
        } else if self.hook_may_have_started {
            self.cleanup_hook_group(strict)
        } else {
            true
        };
        if hook_group_clean {
            self.hook_group_cleaned = true;
        }
        self.cleaned = self.app_server_group_cleaned && self.hook_group_cleaned;

        if strict {
            assert!(
                app_server_group_signalled,
                "could not signal the dedicated app-server process group"
            );
            assert!(status.is_some(), "the app-server child must be reaped");
            assert!(
                hook_group_clean,
                "the owned startup-hook group was not reaped"
            );
        }
        status
    }

    fn cleanup_hook_group(&self, strict: bool) -> bool {
        // The hook runner deliberately creates a second process group. The
        // hook writes its PID and Linux start-time into this private test
        // fixture before signaling readiness, so cleanup can verify identity
        // and never signal a recycled PID or a foreign process group.
        let Some((hook_pid, expected_start_time)) =
            wait_for_owned_hook_identity(&self.hook_identity_file, Duration::from_secs(5))
        else {
            return !strict;
        };

        if !hook_process_identity_matches(hook_pid, &expected_start_time) {
            return !strict;
        }
        // SAFETY: the private identity file plus /proc start-time and pgrp
        // check prove that this PID is the dedicated hook group leader.
        let signalled = unsafe { signal_owned_process_group(hook_pid, libc::SIGKILL) };
        let gone = wait_for_process_group_exit(hook_pid, Duration::from_secs(5));
        signalled && gone
    }
}

#[cfg(target_os = "linux")]
impl std::ops::Deref for HandoffServerProcessGroup {
    type Target = TestAppServer;

    fn deref(&self) -> &Self::Target {
        &self.server
    }
}

#[cfg(target_os = "linux")]
impl std::ops::DerefMut for HandoffServerProcessGroup {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.server
    }
}

#[cfg(target_os = "linux")]
impl Drop for HandoffServerProcessGroup {
    fn drop(&mut self) {
        let _ = self.cleanup(false);
    }
}

#[cfg(target_os = "linux")]
unsafe fn signal_owned_process_group(process_group: libc::pid_t, signal: i32) -> bool {
    let result = unsafe { libc::kill(-process_group, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
fn hook_process_identity_matches(pid: libc::pid_t, expected_start_time: &str) -> bool {
    linux_process_identity(pid).is_some_and(|(process_group, start_time)| {
        process_group == pid && start_time == expected_start_time
    })
}

#[cfg(target_os = "linux")]
fn linux_process_identity(pid: libc::pid_t) -> Option<(libc::pid_t, String)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    let fields = fields.split_whitespace().collect::<Vec<_>>();
    let process_group = fields.get(2)?.parse().ok()?;
    // The suffix starts at field 3 (state); starttime is field 22.
    let start_time = fields.get(19)?.to_string();
    Some((process_group, start_time))
}

#[cfg(target_os = "linux")]
fn wait_for_owned_hook_identity(
    path: &std::path::Path,
    timeout: Duration,
) -> Option<(libc::pid_t, String)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(contents) = std::fs::read_to_string(path)
            && let Some((pid, start_time)) = contents.trim().split_once(':')
            && let Ok(pid) = pid.parse::<libc::pid_t>()
            && pid > 1
            && hook_process_identity_matches(pid, start_time)
        {
            return Some((pid, start_time.to_owned()));
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn wait_for_process_group_exit(process_group: libc::pid_t, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        // SAFETY: signal 0 only checks whether the previously verified owned group exists.
        let result = unsafe { libc::kill(-process_group, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[cfg(target_os = "linux")]
fn stdio_workspace_task_handoff_thread_receipt_replays_and_reserved_unknown_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let marker = temp.path().join("startup-count");
    let marker_q = marker.to_string_lossy().replace('\'', "'\\''");
    set_handoff_startup_hook(&settings, &format!("printf x >> '{marker_q}'"));
    let spawn = || {
        TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .without_scenario()
            .discard_stderr()
            .spawn()
    };

    let ready_id = "handoff-ready-replay";
    let mut server = spawn();
    let initialized = server.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"],
        true
    );
    server.send(handoff_thread_start(2, ready_id));
    // Waiting for the later read response drops the original start ACK by ID.
    server.send(handoff_creation_read(3, ready_id));
    let observed_before_restart = server.response(3);
    assert!(
        observed_before_restart.get("error").is_none(),
        "{observed_before_restart}"
    );
    assert_eq!(
        observed_before_restart["result"]["receipt"]["status"],
        "ready"
    );
    let original_thread_id = observed_before_restart["result"]["receipt"]["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    server.shutdown_successfully();

    let mut restored = spawn();
    let initialized = restored.initialize(10);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"],
        true
    );
    restored.send(handoff_creation_read(11, ready_id));
    let ready = restored.response(11);
    assert_eq!(ready["result"]["receipt"]["status"], "ready", "{ready}");
    assert_eq!(ready["result"]["receipt"]["threadId"], original_thread_id);
    restored.send(handoff_thread_start(12, ready_id));
    let replay = restored.response(12);
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(replay["result"]["thread"]["id"], original_thread_id);
    assert_eq!(
        replay["result"]["thread"], ready["result"]["receipt"]["thread"],
        "ready replay must return the exact original thread snapshot"
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    restored.shutdown_successfully();

    // Reserve a second identity, enter its startup hook, then SIGKILL the
    // isolated server group before completion can be recorded.
    let hook_identity_file = temp.path().join("startup-hook-identity");
    let hook_identity_q = hook_identity_file.to_string_lossy().replace('\'', "'\\''");
    // The controlled hook exits before sleeping if it cannot publish its
    // identity; once published, the guard can signal only its verified group.
    set_handoff_startup_hook(
        &settings,
        &format!(
            "hook_pid=$$; hook_start=$(awk '{{print $22}}' /proc/$$/stat) || exit 3; case \"$hook_start\" in ''|*[!0-9]*) exit 3;; esac; printf '%s:%s' \"$hook_pid\" \"$hook_start\" > '{hook_identity_q}' || exit 4; printf x >> '{marker_q}' || exit 5; exec sleep 30"
        ),
    );
    let unknown_id = "handoff-reserved-crash";
    let mut crashing = spawn_handoff_server_in_own_process_group(
        &workspace,
        &settings,
        &config,
        &hook_identity_file,
    );
    // From this point on any unwind owns the app-server and possible hook group.
    crashing.mark_hook_may_have_started();
    let initialized = crashing.initialize(20);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"],
        true
    );
    crashing.send(handoff_thread_start(21, unknown_id));
    wait_for_file_length(&marker, 2, Duration::from_secs(10));
    assert!(
        hook_identity_file.is_file(),
        "hook must publish its identity"
    );
    use std::os::unix::process::ExitStatusExt;
    let status = crashing.terminate_and_wait();
    assert_eq!(
        status.signal(),
        Some(libc::SIGKILL),
        "the app-server child must be killed mid-reservation"
    );
    drop(crashing);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "xx");

    let mut recovered = spawn();
    let initialized = recovered.initialize(30);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"],
        true
    );
    recovered.send(handoff_creation_read(31, unknown_id));
    let unknown = recovered.response(31);
    assert_eq!(
        unknown["result"]["receipt"]["status"], "unknown",
        "{unknown}"
    );
    recovered.send(handoff_thread_start(32, unknown_id));
    let refused = recovered.response(32);
    assert_eq!(refused["error"]["code"], -32059, "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("completion is unknown"),
        "{refused}"
    );
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "xx",
        "the unknown reservation must not rerun startup hooks"
    );
    recovered.shutdown_successfully();
}

#[test]
fn stdio_workspace_task_handoff_turn_receipt_survives_restart_for_exact_identity() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || {
        TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .scenario("full-turn")
            .stream_delay_ms("1")
            .subagent_stream_delay_ms("0")
            .followup_stream_delay_ms("0")
            .discard_stderr()
            .spawn()
    };

    let mut first = spawn();
    let initialized = first.initialize(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["turnReceiptsV1"],
        true
    );
    first.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}
    }));
    let thread = first.response(2);
    assert!(thread.get("error").is_none(), "{thread}");
    let thread_id = thread["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let client_message_id = "handoff-initial-turn-v1";
    first.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "clientMessageId": client_message_id,
            "input": [{"type": "text", "text": "stdio receipt fixture"}]
        }
    }));
    let accepted = first.response(3);
    assert_eq!(
        accepted["result"]["turn"]["status"], "running",
        "{accepted}"
    );
    let turn_id = accepted["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_for_stdio_turn_completion(&mut first);
    let receipt_query = json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/receipt/read",
        "params": {"threadId": thread_id, "clientMessageId": client_message_id}
    });
    first.send(receipt_query.clone());
    let receipt = first.response(4);
    assert_eq!(receipt["result"]["receipt"]["threadId"], thread_id);
    assert_eq!(receipt["result"]["receipt"]["turnId"], turn_id);
    assert_eq!(receipt["result"]["receipt"]["status"], "completed");
    first.shutdown_successfully();

    let mut restored = spawn();
    let initialized = restored.initialize(10);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["turnReceiptsV1"],
        true
    );
    restored.send(json!({
        "jsonrpc": "2.0", "id": 11, "method": "turn/receipt/read",
        "params": {"threadId": thread_id, "clientMessageId": client_message_id}
    }));
    let after_restart = restored.response(11);
    assert!(after_restart.get("error").is_none(), "{after_restart}");
    assert_eq!(after_restart["result"]["receipt"]["threadId"], thread_id);
    assert_eq!(after_restart["result"]["receipt"]["turnId"], turn_id);
    assert_eq!(after_restart["result"]["receipt"]["status"], "completed");
    restored.shutdown_successfully();
}

#[test]
fn stdio_workspace_task_handoff_worktree_link_upserts_one_conversation_after_ack_loss_restart() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let worktree_root = temp.path().join("worktrees");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(workspace.join("README.md"), "stdio fixture\n").unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "KCoder Test"]);
    git(&["config", "user.email", "kcoder@example.invalid"]);
    git(&["add", "README.md"]);
    git(&["commit", "-m", "stdio fixture"]);

    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || {
        TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .without_scenario()
            .discard_stderr()
            .spawn()
    };
    let mut server = spawn();
    assert!(server.initialize(1).get("error").is_none());
    server.send(json!({
        "jsonrpc": "2.0", "id": 2, "method": "runtime.worktrees.settings.update",
        "params": {"deviceId": "local", "worktreeRoot": worktree_root, "keepCount": 7}
    }));
    let settings_response = server.response(2);
    assert!(
        settings_response.get("error").is_none(),
        "{settings_response}"
    );

    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "runtime.worktrees.prepare",
        "params": {
            "deviceId": "local", "sourcePath": workspace,
            "worktreeId": "handoff-task", "ref": "main"
        }
    }));
    let prepared = server.response(3);
    assert!(prepared.get("error").is_none(), "{prepared}");
    let prepared_path = std::fs::canonicalize(
        prepared["result"]["path"]
            .as_str()
            .expect("prepare returns the actual worktree path"),
    )
    .unwrap();
    assert_eq!(
        prepared["result"]["worktree"]["path"],
        prepared_path.to_string_lossy().as_ref(),
        "the recorded worktree path must match the returned path"
    );
    assert!(prepared_path.join("README.md").is_file());

    // Mobile's task client is scoped to the prepared worktree, while its
    // managed-worktree registry client remains scoped to the source workspace.
    let mut task_server = TestAppServer::builder(&prepared_path, &settings)
        .config_dir(&config)
        .without_scenario()
        .discard_stderr()
        .spawn();
    assert!(task_server.initialize(20).get("error").is_none());
    task_server.send(json!({
        "jsonrpc": "2.0", "id": 21, "method": "thread/start",
        "params": {"cwd": prepared_path}
    }));
    let started = task_server.response(21);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        started["result"]["thread"]["cwd"],
        prepared_path.to_string_lossy().as_ref(),
        "the task thread must be created in the actual prepared worktree"
    );
    task_server.shutdown_successfully();
    let task_id = "handoff-task-stable-id";
    let conversation = json!({
        "deviceId": "local",
        "taskId": task_id,
        "threadId": thread_id,
        "workspacePath": prepared_path,
        "title": "stdio handoff fixture",
        "createdAt": 1_791_446_400_000_u64,
        "updatedAt": 1_791_446_400_000_u64
    });
    let link = |id| {
        json!({
            "jsonrpc": "2.0", "id": id, "method": "runtime.worktrees.conversations.link",
            "params": {
                "deviceId": "local", "path": prepared_path,
                "conversation": conversation
            }
        })
    };
    let list = |id| {
        json!({
            "jsonrpc": "2.0", "id": id, "method": "runtime.worktrees.list",
            "params": {"deviceId": "local"}
        })
    };
    // The list response waits behind the link response; response(id=6) drops
    // the link ACK while verifying the durable upsert through the real store.
    server.send(link(5));
    server.send(list(6));
    let linked_before_restart = server.response(6);
    assert!(
        linked_before_restart.get("error").is_none(),
        "{linked_before_restart}"
    );
    let item = linked_before_restart["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == prepared_path.to_string_lossy().as_ref())
        .unwrap();
    assert_eq!(item["conversations"].as_array().unwrap().len(), 1, "{item}");
    assert_eq!(item["conversations"][0]["taskId"], task_id);
    assert_eq!(item["conversations"][0]["threadId"], thread_id);
    assert_eq!(
        item["conversations"][0]["workspacePath"],
        prepared_path.to_string_lossy().as_ref()
    );
    server.shutdown_successfully();

    let mut restored = spawn();
    assert!(restored.initialize(10).get("error").is_none());
    // Replay only the same association payload. No thread/start or worktree
    // prepare is sent after restart; task_id is the store's upsert key.
    restored.send(link(11));
    restored.send(list(12));
    let linked_after_restart = restored.response(12);
    assert!(
        linked_after_restart.get("error").is_none(),
        "{linked_after_restart}"
    );
    let item = linked_after_restart["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == prepared_path.to_string_lossy().as_ref())
        .unwrap();
    let conversations = item["conversations"].as_array().unwrap();
    assert_eq!(conversations.len(), 1, "{item}");
    assert_eq!(conversations[0]["taskId"], task_id);
    assert_eq!(conversations[0]["threadId"], thread_id);
    assert_eq!(
        conversations[0]["workspacePath"],
        prepared_path.to_string_lossy().as_ref()
    );
    assert_eq!(conversations[0]["createdAt"], 1_791_446_400_000_u64);
    assert_eq!(conversations[0]["updatedAt"], 1_791_446_400_000_u64);
    restored.shutdown_successfully();
}
