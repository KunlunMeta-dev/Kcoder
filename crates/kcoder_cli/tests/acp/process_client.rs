//! Independent literal-JSON ACP client driving the actual CLI executable.
//! No ACP adapter/SDK types or conversion functions construct these expectations.
use kcoder_test_harness::{ModelPolicy, RunContext, RunMetadata, RunStatus, TestTier};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

const FRAME_LIMIT: usize = 2 * 1024 * 1024;
const PRIVATE_ALPHA: &str = "independent-client-private-alpha";
const PRIVATE_BETA: &str = "independent-client-private-beta";

struct ObservedChild {
    pid: u32,
    start: u64,
    handle: OwnedFd,
}

impl ObservedChild {
    fn exited(&self) -> bool {
        let mut fd = libc::pollfd {
            fd: self.handle.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        (unsafe { libc::poll(&mut fd, 1, 0) }) == 1
    }
    fn kill(&self) {
        // A held pidfd never targets a reused PID, including after reparenting.
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.handle.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
    }
}

fn child_identity(pid: u32) -> Option<(u32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

fn observe_child(pid: u32, parent: u32, observed: &mut Vec<ObservedChild>) -> bool {
    let Some(before @ (ppid, start)) = child_identity(pid) else {
        return false;
    };
    if ppid != parent {
        return false;
    }
    if observed
        .iter()
        .any(|old| old.pid == pid && old.start == start)
    {
        return true;
    }
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if raw < 0 {
        assert!(
            child_identity(pid).is_none(),
            "cannot acquire identity-bound child cleanup"
        );
        return false;
    }
    // SAFETY: pidfd_open returned a new owned descriptor.
    let handle = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    if child_identity(pid) != Some(before) {
        return false;
    }
    observed.push(ObservedChild { pid, start, handle });
    true
}

fn observe_descendants(parent: u32, observed: &mut Vec<ObservedChild>) {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{parent}/task")) else {
        return;
    };
    let mut children = BTreeSet::new();
    for task in tasks.flatten() {
        if let Ok(value) = std::fs::read_to_string(task.path().join("children")) {
            children.extend(
                value
                    .split_whitespace()
                    .filter_map(|pid| pid.parse::<u32>().ok()),
            );
        }
    }
    for pid in children {
        if observe_child(pid, parent, observed) {
            observe_descendants(pid, observed);
        }
    }
}

struct CliClient {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: Option<ChildStderr>,
    child: Child,
    command: Command,
    observed: Arc<Mutex<Vec<ObservedChild>>>,
    context: RunContext,
    workspace: PathBuf,
    frames: usize,
    _unused_listener: Option<std::net::TcpListener>,
}

impl CliClient {
    fn spawn(case: &str, endpoint: Option<&str>, permission: &str) -> Self {
        let base = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../target/test/crates/kcoder_cli/acp");
        let mut context = RunContext::create(
            base,
            RunMetadata::new(case, TestTier::Pr, ModelPolicy::Forbidden),
        )
        .unwrap();
        context.register_secret(PRIVATE_ALPHA).unwrap();
        context.register_secret(PRIVATE_BETA).unwrap();
        // Place runtime state outside the checkout so parent project settings,
        // Hooks and MCP declarations cannot enter this isolated provider fixture.
        let private = tempfile::tempdir().unwrap();
        let home = private.path().to_owned();
        let observed = Arc::new(Mutex::new(Vec::<ObservedChild>::new()));
        let cleanup_handles = observed.clone();
        context.register_cleanup(move || {
            if cleanup_handles
                .lock()
                .unwrap()
                .iter()
                .any(|child| !child.exited())
            {
                let retained = private.keep();
                anyhow::bail!(
                    "Owned test process is still active; isolated state retained at {}",
                    retained.display()
                );
            }
            private.close().map_err(Into::into)
        });
        let workspace = home.join("项目 资料");
        std::fs::create_dir(&workspace).unwrap();
        let config = home.join("config");
        let env = BTreeMap::from([
            ("HOME", home.as_os_str().to_owned()),
            ("KCODER_CONFIG_DIR", config.into_os_string()),
            ("PATH", std::env::var_os("PATH").unwrap_or_default()),
            ("KCODER_TUI_LAB_STREAM_DELAY_MS", "20".into()),
        ]);
        super::write_direct_transport_settings(&home.join("config"));
        let trust = std::process::Command::new(super::kcoder_binary())
            .env_clear()
            .envs(&env)
            .current_dir(&workspace)
            .args(["trust", "add", "--path"])
            .arg(&workspace)
            .output()
            .unwrap();
        assert!(
            trust.status.success(),
            "cannot prepare isolated project trust"
        );
        let mut command = Command::new(super::kcoder_binary());
        command
            .env_clear()
            .envs(&env)
            .current_dir(&workspace)
            .args([
                "--training-mode",
                "--permission-mode",
                permission,
                "--max-retries",
                "0",
            ]);
        let unused_listener = endpoint
            .is_none()
            .then(|| std::net::TcpListener::bind("127.0.0.1:0").unwrap());
        let fallback = unused_listener
            .as_ref()
            .map(|listener| format!("http://{}/v1", listener.local_addr().unwrap()));
        command.args([
            "--provider",
            "local",
            "--model",
            "fixture",
            "--local-base-url",
            endpoint.or(fallback.as_deref()).unwrap(),
        ]);
        command
            .arg("acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        assert!(
            observe_child(
                child.id().unwrap(),
                std::process::id(),
                &mut observed.lock().unwrap()
            ),
            "cannot register CLI process identity"
        );
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let stderr = child.stderr.take();
        Self {
            stdin,
            stdout,
            stderr,
            child,
            command,
            observed,
            context,
            workspace,
            frames: 0,
            _unused_listener: unused_listener,
        }
    }

    async fn bytes(&mut self, bytes: &[u8]) {
        tokio::time::timeout(
            Duration::from_secs(10),
            self.stdin.as_mut().unwrap().write_all(bytes),
        )
        .await
        .unwrap()
        .unwrap();
    }

    async fn send(&mut self, frame: Value) {
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        self.bytes(&bytes).await;
    }

    async fn read(&mut self) -> Value {
        let mut bytes = Vec::new();
        let mut bounded = (&mut self.stdout).take((FRAME_LIMIT + 2) as u64);
        tokio::time::timeout(
            Duration::from_secs(30),
            bounded.read_until(b'\n', &mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        if let Some(pid) = self.child.id() {
            observe_descendants(pid, &mut self.observed.lock().unwrap());
        }
        if bytes.len() > FRAME_LIMIT + 1 || bytes.last() != Some(&b'\n') {
            let mut diagnostic = Vec::new();
            if let Some(stderr) = self.stderr.take() {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    stderr.take(64 * 1024).read_to_end(&mut diagnostic),
                )
                .await;
            }
            let diagnostic = self
                .context
                .redact_text(&String::from_utf8_lossy(&diagnostic));
            panic!(
                "invalid CLI stdout frame ({} bytes); bounded stderr: {diagnostic}",
                bytes.len()
            );
        }
        let frame: Value = serde_json::from_slice(&bytes).expect("human text polluted ACP stdout");
        assert_eq!(frame["jsonrpc"], "2.0");
        assert!(
            !bytes
                .windows(PRIVATE_ALPHA.len())
                .any(|value| value == PRIVATE_ALPHA.as_bytes()),
            "private alpha leaked"
        );
        assert!(
            !bytes
                .windows(PRIVATE_BETA.len())
                .any(|value| value == PRIVATE_BETA.as_bytes()),
            "private beta leaked"
        );
        self.frames += 1;
        frame
    }

    async fn initialize(&mut self) {
        self.send(json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"futureOptionalCapability":true},"clientInfo":{"name":"independent-wire-client","version":"1"}}})).await;
        let frame = self.read().await;
        assert_eq!(frame["id"], "init");
        assert_eq!(frame["result"]["protocolVersion"], 1);
        assert_eq!(frame["result"]["agentInfo"]["name"], "kcoder");
        assert_ne!(frame["result"]["agentCapabilities"]["loadSession"], true);
    }

    async fn new_session(&mut self, id: &str, servers: Value) -> String {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"session/new","params":{"cwd":self.workspace,"mcpServers":servers}})).await;
        let frame = self.read().await;
        assert_eq!(frame["id"], id);
        frame["result"]["sessionId"]
            .as_str()
            .expect("CLI failed to create session")
            .into()
    }

    async fn prompt(&mut self, id: &str, session: &str, text: &str) {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":text}]}})).await;
    }

    async fn shutdown(&mut self) {
        drop(self.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(15), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "ACP CLI did not exit cleanly on EOF");
        let mut tail = Vec::new();
        (&mut self.stdout)
            .take((FRAME_LIMIT + 2) as u64)
            .read_to_end(&mut tail)
            .await
            .unwrap();
        assert!(
            tail.is_empty(),
            "unexpected stdout after the final response"
        );
        assert!(
            self.observed
                .lock()
                .unwrap()
                .iter()
                .all(ObservedChild::exited),
            "owned descendants survived normal CLI shutdown"
        );
    }

    async fn restart(&mut self) {
        self.shutdown().await;
        let mut child = self.command.spawn().unwrap();
        assert!(observe_child(
            child.id().unwrap(),
            std::process::id(),
            &mut self.observed.lock().unwrap()
        ));
        self.stdin = child.stdin.take();
        self.stdout = BufReader::new(child.stdout.take().unwrap());
        self.stderr = child.stderr.take();
        self.child = child;
    }

    async fn diagnostics(&mut self) -> Vec<Value> {
        let mut bytes = Vec::new();
        if let Some(stderr) = self.stderr.take() {
            tokio::time::timeout(
                Duration::from_secs(2),
                stderr.take(64 * 1024).read_to_end(&mut bytes),
            )
            .await
            .unwrap()
            .unwrap();
        }
        for private in [PRIVATE_ALPHA, PRIVATE_BETA] {
            assert!(
                !bytes
                    .windows(private.len())
                    .any(|window| window == private.as_bytes()),
                "private MCP value leaked into diagnostics"
            );
        }
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value["event"] == "acp_lifecycle")
            .collect()
    }

    async fn finish(mut self) {
        self.shutdown().await;
        self.diagnostics().await;
        self.context.write_artifact_json("summary.json", &json!({"frames":self.frames,"observed_processes":self.observed.lock().unwrap().len(),"all_observed_processes_exited":true})).unwrap();
        let cleanup = self.context.finish(RunStatus::Passed, None).unwrap();
        assert!(cleanup.failures.is_empty(), "isolated state cleanup failed");
    }
}

fn assert_no_private_disk_data(root: &Path) {
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() {
            assert!(
                entry.metadata().unwrap().len() <= 16 * 1024 * 1024,
                "fixture state exceeded its read budget"
            );
            let bytes = std::fs::read(entry.path()).unwrap();
            for secret in [PRIVATE_ALPHA, PRIVATE_BETA] {
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|value| value == secret.as_bytes()),
                    "private MCP data persisted in fixture state"
                );
            }
        }
    }
}

#[tokio::test]
async fn acp_cli_process_keeps_mcp_private_and_revokes_it_across_a_real_restart() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        for step in 0..5 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let request = super::acp_session_mcp::request_body(&mut stream).await;
            let body = request.to_string();
            assert!(
                !body.contains(PRIVATE_ALPHA) && !body.contains(PRIVATE_BETA),
                "private MCP launch data reached the provider"
            );
            let has_host = request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "mcp__host__echo");
            assert_eq!(
                has_host,
                step < 4,
                "MCP contribution survived a CLI restart"
            );
            if step == 4 {
                model_reply(&mut stream, json!({"content":"重启后没有临时服务"}), "stop").await;
            } else if step % 2 == 0 {
                model_reply(&mut stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":"same-native-call","type":"function","function":{"name":"mcp__host__echo","arguments":"{}"}}]}),"tool_calls").await;
            } else {
                assert!(
                    body.contains(if step == 1 {
                        "owner=alpha"
                    } else {
                        "owner=beta"
                    }),
                    "same-named MCP was routed to another session"
                );
                model_reply(&mut stream, json!({"content":"临时服务完成"}), "stop").await;
            }
        }
    });
    let mut client = CliClient::spawn("process-private-mcp", Some(&endpoint), "yolo");
    client.initialize().await;
    client.send(json!({"jsonrpc":"2.0","id":"http-not-supported","method":"session/new","params":{"cwd":client.workspace,"mcpServers":[{"type":"http","name":"not-executed","url":endpoint,"headers":[{"name":"Authorization","value":PRIVATE_ALPHA}]}]}})).await;
    let http = client.read().await;
    assert!(
        http["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Only stdio")
    );
    client.send(json!({"jsonrpc":"2.0","id":"missing-command","method":"session/new","params":{"cwd":client.workspace,"mcpServers":[{"name":"missing","command":"/__kcoder_acp_missing_executable__","args":[PRIVATE_ALPHA],"env":[{"name":"TOKEN","value":PRIVATE_ALPHA}]}]}})).await;
    let missing = client.read().await;
    assert!(missing.get("error").is_some());
    assert!(
        !missing
            .to_string()
            .contains("/__kcoder_acp_missing_executable__"),
        "private launch path leaked"
    );
    let python = which::which("python3").unwrap();
    let fixture = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("tests/acp/fixtures/session_mcp.py");
    let mut directories = Vec::new();
    for (owner, secret) in [("alpha", PRIVATE_ALPHA), ("beta", PRIVATE_BETA)] {
        let directory = client.workspace.join(owner);
        std::fs::create_dir(&directory).unwrap();
        let session=client.new_session(owner,json!([{"name":"host","command":python,"args":[fixture,directory,owner],"env":[{"name":"TOKEN","value":secret}]}])).await;
        client.prompt(owner, &session, "调用本会话的临时服务").await;
        let mut completed = false;
        loop {
            let frame = client.read().await;
            if frame["id"] == owner {
                assert_eq!(frame["result"]["stopReason"], "end_turn");
                break;
            }
            assert_eq!(frame["params"]["sessionId"], session);
            if frame["params"]["update"]["status"] == "completed" {
                completed = true;
            }
        }
        assert!(completed);
        assert_eq!(
            std::fs::read_to_string(directory.join("called")).unwrap(),
            owner
        );
        directories.push(directory);
    }
    assert_no_private_disk_data(client.workspace.parent().unwrap());
    client.restart().await;
    assert!(
        client
            .observed
            .lock()
            .unwrap()
            .iter()
            .filter(|child| !child.exited())
            .count()
            == 1,
        "old native/MCP process survived restart"
    );
    client.initialize().await;
    let session = client.new_session("new-after-restart", json!([])).await;
    client
        .prompt("fresh", &session, "核对重启后没有临时服务")
        .await;
    loop {
        let frame = client.read().await;
        if frame["id"] == "fresh" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        }
        assert_eq!(frame["params"]["sessionId"], session);
        assert_ne!(frame["params"]["update"]["sessionUpdate"], "tool_call");
    }
    for directory in directories {
        assert!(directory.join("called").is_file());
    }
    assert_no_private_disk_data(client.workspace.parent().unwrap());
    provider.await.unwrap();
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_native_sigkill_cleans_stubborn_mcp_and_reports_unknown_write_once() {
    assert_native_sigkill_cleanup(CrashWork::Mcp).await;
}

#[tokio::test]
async fn acp_cli_process_native_sigkill_cleans_foreground_shell_and_reports_unknown_write_once() {
    assert_native_sigkill_cleanup(CrashWork::Shell).await;
}

#[tokio::test]
async fn acp_cli_process_native_sigkill_cleans_subagent_shell_and_reports_unknown_write_once() {
    assert_native_sigkill_cleanup(CrashWork::SubagentShell).await;
}

#[derive(Clone, Copy)]
enum CrashWork {
    Mcp,
    Shell,
    SubagentShell,
}

async fn assert_native_sigkill_cleanup(work: CrashWork) {
    let shell = !matches!(work, CrashWork::Mcp);
    let subagent = matches!(work, CrashWork::SubagentShell);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (peer_started, started) = tokio::sync::oneshot::channel();
    let (release_peer, released) = tokio::sync::oneshot::channel();
    let mut client = CliClient::spawn(
        match work {
            CrashWork::Mcp => "process-native-sigkill",
            CrashWork::Shell => "process-shell-sigkill",
            CrashWork::SubagentShell => "process-subagent-shell-sigkill",
        },
        Some(&endpoint),
        "yolo",
    );
    let directory = client.workspace.join("stubborn");
    std::fs::create_dir(&directory).unwrap();
    let python = which::which("python3").unwrap();
    let fixture = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join(if shell {
            "tests/acp/fixtures/command_tree.py"
        } else {
            "tests/acp/fixtures/session_mcp.py"
        });
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
    }
    let arguments = if shell {
        json!({"command":format!("{} {} {}", shell_quote(&python), shell_quote(&fixture), shell_quote(&directory)), "timeout":30000})
    } else {
        json!({})
    };
    let provider = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        super::acp_session_mcp::request_body(&mut stream).await;
        if subagent {
            let delegated = json!({"message":"Run the authorized fixture command exactly once and wait for its result","max_turns":2,"run_in_background":false});
            model_reply(&mut stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":"lost-write","type":"function","function":{"name":"spawn_agent","arguments":delegated.to_string()}}]}),"tool_calls").await;
            let (mut child_stream, _) =
                tokio::time::timeout(Duration::from_secs(30), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let child = super::acp_session_mcp::request_body(&mut child_stream).await;
            assert!(
                child["messages"]
                    .to_string()
                    .contains("authorized fixture command")
            );
            model_reply(&mut child_stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":"child-write","type":"function","function":{"name":"bash","arguments":arguments.to_string()}}]}),"tool_calls").await;
        } else {
            model_reply(&mut stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":"lost-write","type":"function","function":{"name":if shell {"bash"} else {"mcp__host__echo"},"arguments":arguments.to_string()}}]}),"tool_calls").await;
        }
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        super::acp_session_mcp::request_body(&mut stream).await;
        peer_started.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), released)
            .await
            .unwrap()
            .unwrap();
        model_reply(&mut stream, json!({"content":"其他会话完成"}), "stop").await;
        tokio::time::timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err()
    });
    client.initialize().await;
    let servers = if shell {
        json!([])
    } else {
        json!([{"name":"host","command":python,"args":[fixture,directory,"stubborn"],"env":[{"name":"TOKEN","value":PRIVATE_ALPHA}]}])
    };
    let first = client.new_session("new-first", servers).await;
    let root = client.child.id().unwrap();
    let first_tree: Vec<_> = client
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter(|child| child.pid != root)
        .map(|child| ObservedChild {
            pid: child.pid,
            start: child.start,
            handle: child.handle.try_clone().unwrap(),
        })
        .collect();
    let native_ref = first_tree
        .iter()
        .find(|child| child_identity(child.pid).is_some_and(|identity| identity.0 == root))
        .unwrap();
    let native_pid = native_ref.pid;
    let native = native_ref.handle.try_clone().unwrap();
    let peer = client.new_session("new-peer", json!([])).await;
    client
        .prompt("lost", &first, "执行一次受控写入，等待回执")
        .await;
    let tool = loop {
        let frame = client.read().await;
        if frame["params"]["update"]["status"] == "in_progress" {
            break frame["params"]["update"]["toolCallId"]
                .as_str()
                .unwrap()
                .to_owned();
        }
        assert!(
            frame.get("error").is_none(),
            "tool failed before the controlled side effect"
        );
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while std::fs::read_to_string(directory.join("writes"))
            .ok()
            .as_deref()
            != Some("committed\n")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // Observe the detached leaf before killing the exact first native owner.
    observe_descendants(root, &mut client.observed.lock().unwrap());
    let mut first_tree = vec![ObservedChild {
        pid: native_pid,
        start: child_identity(native_pid).unwrap().1,
        handle: native.try_clone().unwrap(),
    }];
    observe_descendants(native_pid, &mut first_tree);
    let leaf = std::fs::read_to_string(directory.join("leaf.pid"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert!(
        first_tree.iter().any(|child| child.pid == leaf),
        "detached leaf was not registered"
    );
    client.prompt("peer-run", &peer, "另一个会话继续执行").await;
    tokio::time::timeout(Duration::from_secs(10), started)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                native.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        },
        0
    );
    release_peer.send(()).unwrap();
    let mut failed = false;
    let mut peer_done = false;
    let mut unresolved = false;
    while !failed || !peer_done {
        let frame = client.read().await;
        if frame["id"] == "lost" {
            assert_eq!(frame["error"]["code"], -32603);
            assert!(
                frame["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("unknown")
            );
            failed = true;
        } else if frame["id"] == "peer-run" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            peer_done = true;
        } else if frame["params"]["update"]["toolCallId"] == tool {
            let update = &frame["params"]["update"];
            assert_ne!(
                update["status"], "completed",
                "a lost write receipt was reported as success"
            );
            if update["status"] == "failed" {
                assert!(
                    update
                        .to_string()
                        .contains("External effects may have occurred")
                );
                unresolved = true;
            }
        }
    }
    assert!(unresolved);
    assert!(
        first_tree.len() >= 3,
        "owned command/MCP descendants were not observed"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while first_tree.iter().any(|child| !child.exited()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned foreground command or private MCP survived native owner SIGKILL");
    assert_eq!(
        std::fs::read_to_string(directory.join("writes")).unwrap(),
        "committed\n"
    );
    assert!(
        provider.await.unwrap(),
        "native failure blindly replayed a model request"
    );
    client.finish().await;
}

impl Drop for CliClient {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(6);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        for child in self.observed.lock().unwrap().iter() {
            if !child.exited() {
                child.kill();
            }
        }
        let _ = self.child.start_kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while (matches!(self.child.try_wait(), Ok(None))
            || self
                .observed
                .lock()
                .unwrap()
                .iter()
                .any(|child| !child.exited()))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[tokio::test]
async fn acp_cli_process_connection_sigkill_releases_commands_and_preserves_independent_wiki_worker()
 {
    use fs2::FileExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut client = CliClient::spawn("process-connection-sigkill", Some(&endpoint), "yolo");
    let profile = client.workspace.join("durable-wiki");
    std::fs::create_dir(&profile).unwrap();
    let settings = profile.join("settings.json");
    std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":false}}"#).unwrap();
    let worker = std::process::Command::new(super::kcoder_binary())
        .args(["--internal-wiki-worker"])
        .arg(&settings)
        .env_clear()
        .env("HOME", client.workspace.parent().unwrap())
        .env("KCODER_CONFIG_DIR", &profile)
        .current_dir(&client.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let worker_pid = worker.id();
    let worker = Arc::new(Mutex::new(worker));
    assert!(observe_child(
        worker_pid,
        std::process::id(),
        &mut client.observed.lock().unwrap()
    ));
    let worker_cleanup = worker.clone();
    client.context.register_cleanup(move || {
        let mut child = worker_cleanup.lock().unwrap();
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait()?.is_none() {
            anyhow::ensure!(Instant::now() < deadline, "owned Wiki fixture did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.wait()?;
        Ok(())
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(lock) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(profile.join(".wiki-worker.lock"))
            {
                match lock.try_lock_exclusive() {
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Ok(()) => FileExt::unlock(&lock).unwrap(),
                    Err(error) => panic!("private Wiki worker lock failed: {error}"),
                }
            }
            assert!(worker.lock().unwrap().try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let directory = client.workspace.join("command");
    std::fs::create_dir(&directory).unwrap();
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let command = format!(
        "{} {} {}",
        quote(&which::which("python3").unwrap()),
        quote(
            &kcoder_test_harness::workspace_root()
                .expect("resolve current workspace")
                .join("crates/kcoder_cli")
                .join("tests/acp/fixtures/command_tree.py")
        ),
        quote(&directory)
    );
    let provider = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        super::acp_session_mcp::request_body(&mut stream).await;
        model_reply(&mut stream, json!({"role":"assistant","tool_calls":[{"index":0,"id":"connection-lost-write","type":"function","function":{"name":"bash","arguments":json!({"command":command,"timeout":30000}).to_string()}}]}), "tool_calls").await;
        assert!(
            tokio::time::timeout(Duration::from_millis(500), listener.accept())
                .await
                .is_err(),
            "connection failure replayed a model request"
        );
    });
    client.initialize().await;
    let session = client.new_session("new", json!([])).await;
    client
        .prompt(
            "lost",
            &session,
            "Run one owned command before transport failure",
        )
        .await;
    loop {
        let frame = client.read().await;
        if frame["params"]["update"]["status"] == "in_progress" {
            break;
        }
        assert!(frame.get("error").is_none());
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.join("leaf.pid").is_file() || !directory.join("writes").is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let root = client.child.id().unwrap();
    observe_descendants(root, &mut client.observed.lock().unwrap());
    let victims = client
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter(|child| child.pid != worker_pid)
        .map(|child| ObservedChild {
            pid: child.pid,
            start: child.start,
            handle: child.handle.try_clone().unwrap(),
        })
        .collect::<Vec<_>>();
    let leaf: u32 = std::fs::read_to_string(directory.join("leaf.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(victims.iter().any(|child| child.pid == leaf));
    victims
        .iter()
        .find(|child| child.pid == root)
        .unwrap()
        .kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.child.wait())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while victims.iter().any(|child| !child.exited()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connection-owned process survived the ACP launcher crash");
    assert!(
        worker.lock().unwrap().try_wait().unwrap().is_none(),
        "independent durable Wiki worker was killed"
    );
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(profile.join(".wiki-worker.lock"))
        .unwrap();
    assert!(
        lock.try_lock_exclusive().is_err(),
        "durable worker relinquished its active lease"
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("writes")).unwrap(),
        "committed\n"
    );
    provider.await.unwrap();
    let worker_ref = client
        .observed
        .lock()
        .unwrap()
        .iter()
        .find(|child| child.pid == worker_pid)
        .unwrap()
        .handle
        .try_clone()
        .unwrap();
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                worker_ref.as_raw_fd(),
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        },
        0
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while worker.lock().unwrap().try_wait().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        client
            .observed
            .lock()
            .unwrap()
            .iter()
            .all(ObservedChild::exited)
    );
    client.context.write_artifact_json("summary.json", &json!({"failure":"ACP launcher SIGKILL","tool_receipt":"unknown","write_count":1,"independent_wiki_worker_preserved":true,"cleanup_confirmed":true})).unwrap();
    assert!(
        client
            .context
            .finish(RunStatus::Passed, None)
            .unwrap()
            .failures
            .is_empty()
    );
}

async fn model_reply(stream: &mut tokio::net::TcpStream, delta: Value, reason: &str) {
    let chunk = json!({"id":"independent-provider","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let stop = json!({"id":"independent-provider","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":reason}]});
    let body = format!("data: {chunk}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn acp_cli_process_streams_parameter_line_progress_before_arguments_finish() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut client = CliClient::spawn("process-incremental-input", Some(&endpoint), "ask");
    let target = client.workspace.join("incremental.txt");
    let (second, release_second) = tokio::sync::oneshot::channel();
    let (finish, release_finish) = tokio::sync::oneshot::channel();
    let prefix = format!(
        "{{\"file_path\":{},\"content\":\"alpha\\n",
        serde_json::to_string(&target).unwrap()
    );
    async fn chunk(stream: &mut tokio::net::TcpStream, delta: Value, reason: Value) {
        let frame = json!({"id":"slow-parameters","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":reason}]});
        stream
            .write_all(format!("data: {frame}\n\n").as_bytes())
            .await
            .unwrap();
        stream.flush().await.unwrap();
    }
    let provider = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        super::acp_session_mcp::request_body(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        chunk(&mut stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":"streamed-write","type":"function","function":{"name":"write","arguments":prefix}}]}),Value::Null).await;
        tokio::time::timeout(Duration::from_secs(15), release_second)
            .await
            .unwrap()
            .unwrap();
        chunk(
            &mut stream,
            json!({"tool_calls":[{"index":0,"function":{"arguments":"beta\\ngamma\\n"}}]}),
            Value::Null,
        )
        .await;
        tokio::time::timeout(Duration::from_secs(15), release_finish)
            .await
            .unwrap()
            .unwrap();
        chunk(
            &mut stream,
            json!({"tool_calls":[{"index":0,"function":{"arguments":"\"}"}}]}),
            Value::Null,
        )
        .await;
        chunk(&mut stream, json!({}), json!("tool_calls")).await;
        stream.write_all(b"data: [DONE]\n\n").await.unwrap();
        drop(stream);
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        super::acp_session_mcp::request_body(&mut stream).await;
        model_reply(&mut stream, json!({"content":"saved"}), "stop").await;
    });
    client.initialize().await;
    let session = client.new_session("new", json!([])).await;
    client
        .prompt(
            "run",
            &session,
            "Write the streamed file after asking permission",
        )
        .await;
    let mut rows = BTreeSet::new();
    let (id, first_lines) = loop {
        let frame = client.read().await;
        assert!(frame.get("error").is_none());
        let update = &frame["params"]["update"];
        if update["sessionUpdate"] == "tool_call" {
            assert!(rows.insert(update["toolCallId"].clone().to_string()));
        }
        if let Some(lines) = update["_meta"]["kcoder/inputProgress"]["generatedLines"].as_u64() {
            assert_eq!(update["status"].as_str().unwrap_or("pending"), "pending");
            assert!(
                !target.exists(),
                "tool executed before its arguments were complete"
            );
            break (update["toolCallId"].clone(), lines);
        }
    };
    second.send(()).unwrap();
    loop {
        let frame = client.read().await;
        assert!(frame.get("error").is_none());
        let update = &frame["params"]["update"];
        if update["sessionUpdate"] == "tool_call" {
            assert!(rows.insert(update["toolCallId"].clone().to_string()));
        }
        if update["_meta"]["kcoder/inputProgress"]["generatedLines"]
            .as_u64()
            .is_some_and(|lines| lines > first_lines)
        {
            assert_eq!(update["toolCallId"], id);
            assert_eq!(update["status"], "pending");
            assert!(!target.exists());
            break;
        }
    }
    finish.send(()).unwrap();
    let (mut approvals, mut executing, mut completed) = (0, false, false);
    loop {
        let frame = client.read().await;
        if frame["method"] == "session/request_permission" {
            assert_eq!(frame["params"]["toolCall"]["toolCallId"], id);
            let option = frame["params"]["options"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["kind"] == "allow_once")
                .unwrap()["optionId"]
                .clone();
            client.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"selected","optionId":option}}})).await;
            approvals += 1;
        } else if frame["id"] == "run" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        } else {
            let update = &frame["params"]["update"];
            if update["sessionUpdate"] == "tool_call" {
                assert!(rows.insert(update["toolCallId"].clone().to_string()));
            }
            if update["toolCallId"] == id {
                executing |= update["status"] == "in_progress";
                completed |= update["status"] == "completed";
            }
        }
    }
    assert_eq!(
        rows.len(),
        1,
        "input progress duplicated the actual tool row"
    );
    assert_eq!(approvals, 1);
    assert!(executing && completed);
    assert_eq!(
        std::fs::read_to_string(target).unwrap(),
        "alpha\nbeta\ngamma\n"
    );
    provider.await.unwrap();
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_recovers_framing_and_rejects_unnegotiated_operations() {
    let mut client = CliClient::spawn("process-framing", None, "ask");
    client
        .send(json!({"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1}}))
        .await;
    client
        .send(json!({"jsonrpc":"2.0","id":"early","method":"session/new","params":{}}))
        .await;
    assert_eq!(client.read().await["error"]["code"], -32600);
    client
        .send(
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":999}}),
        )
        .await;
    assert_eq!(client.read().await["error"]["code"], -32602);
    client.bytes(b"\xff\n").await;
    assert_eq!(client.read().await["error"]["code"], -32700);
    let frame = json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"中文🙂","version":"1"}}});
    let mut bytes = serde_json::to_vec(&frame).unwrap();
    bytes.push(b'\n');
    let split = bytes
        .windows(4)
        .position(|value| value == "🙂".as_bytes())
        .unwrap()
        + 1;
    client.bytes(&bytes[..split]).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    client.bytes(&bytes[split..]).await;
    assert_eq!(client.read().await["result"]["protocolVersion"], 1);
    client.bytes(&vec![b'x'; FRAME_LIMIT + 1]).await;
    client.bytes(b"\n").await;
    assert_eq!(client.read().await["error"]["code"], -32600);
    client
        .bytes(b"\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/load\",\"params\":{}}\n")
        .await;
    assert_eq!(client.read().await["error"]["code"], -32700);
    let unsupported = client.read().await;
    assert_eq!(unsupported["id"], 7);
    assert_eq!(unsupported["error"]["code"], -32601);
    client.send(json!({"jsonrpc":"2.0","id":8,"method":"authenticate","params":{"methodId":"not-advertised"}})).await;
    assert_eq!(client.read().await["error"]["code"], -32601);
    assert_eq!(
        client.observed.lock().unwrap().len(),
        1,
        "a probe started native sessions"
    );
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_output_disconnect_exits_even_while_input_stays_open() {
    let mut client = CliClient::spawn("process-output-disconnect", None, "ask");
    client.initialize().await;
    // Retain an EOF reader in the fixture while dropping the actual ACP stdout.
    let mut ended = Command::new("/bin/true")
        .env_clear()
        .current_dir(&client.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    assert!(observe_child(
        ended.id().unwrap(),
        std::process::id(),
        &mut client.observed.lock().unwrap()
    ));
    let dummy = ended.stdout.take().unwrap();
    assert!(ended.wait().await.unwrap().success());
    drop(std::mem::replace(&mut client.stdout, BufReader::new(dummy)));
    client
        .send(json!({"jsonrpc":"2.0","id":"unreadable-response","method":"not_a_real_method"}))
        .await;
    let status = tokio::time::timeout(Duration::from_secs(5), client.child.wait())
        .await
        .expect("ACP runtime waited forever on its still-open stdin after output failure")
        .unwrap();
    assert!(client.stdin.is_some(), "test accidentally supplied EOF");
    assert!(
        !status.success(),
        "undelivered output was reported as success"
    );
    assert!(
        client
            .observed
            .lock()
            .unwrap()
            .iter()
            .all(ObservedChild::exited)
    );
    client.context.write_artifact_json("summary.json", &json!({"failure":"output disconnected while input stayed open","cleanup_confirmed":true})).unwrap();
    assert!(
        client
            .context
            .finish(RunStatus::Passed, None)
            .unwrap()
            .failures
            .is_empty()
    );
}

#[tokio::test]
async fn acp_cli_process_binds_one_time_approvals_and_preserves_followup_context() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut client = CliClient::spawn("process-approval-context", Some(&endpoint), "ask");
    let target = client.workspace.join("结果 文件.txt");
    let file = target.clone();
    let provider = tokio::spawn(async move {
        for step in 0..4 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let request = super::acp_session_mcp::request_body(&mut stream).await;
            if step == 3 {
                assert!(
                    request["messages"]
                        .to_string()
                        .contains("首次任务 独立上下文")
                );
                assert!(request["messages"].to_string().contains("首次完成🙂"));
                model_reply(&mut stream, json!({"content":"后续完成✓"}), "stop").await;
            } else if step == 2 {
                model_reply(&mut stream, json!({"content":"首次完成🙂"}), "stop").await;
            } else {
                let arguments = json!({"file_path":target,"content":if step==0 {"已批准的内容🙂\n"} else {"不得覆盖"}});
                model_reply(&mut stream,json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("native-{step}"),"type":"function","function":{"name":"write","arguments":arguments.to_string()}}]}),"tool_calls").await;
            }
        }
    });
    client.initialize().await;
    let session = client.new_session("new", json!([])).await;
    client
        .prompt("first", &session, "首次任务 独立上下文")
        .await;
    let mut permissions = 0;
    let mut tool_states = BTreeMap::new();
    let mut permission_tools = Vec::new();
    let mut text = String::new();
    let mut independent_reply = false;
    let mut probe_id = None;
    loop {
        let frame = client.read().await;
        if frame["method"] == "session/request_permission" {
            assert_eq!(frame["params"]["sessionId"], session);
            let call = frame["params"]["toolCall"]["toolCallId"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(
                tool_states.contains_key(&call),
                "permission had no streamed tool row"
            );
            permission_tools.push(call);
            let options = frame["params"]["options"].as_array().unwrap();
            assert_eq!(options.len(), 2);
            let kind = if permissions == 0 {
                "allow_once"
            } else {
                "reject_once"
            };
            let option = options
                .iter()
                .find(|option| option["kind"] == kind)
                .unwrap()["optionId"]
                .clone();
            if permissions == 0 {
                // An inbound request may use the same ID as an outbound permission.
                probe_id = Some(frame["id"].clone());
                client
                    .send(json!({"jsonrpc":"2.0","id":frame["id"],"method":"independent_probe"}))
                    .await;
            }
            client.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"selected","optionId":option}}})).await;
            permissions += 1;
        } else if frame["method"] == "session/update" {
            assert_eq!(frame["params"]["sessionId"], session);
            let update = &frame["params"]["update"];
            if update["sessionUpdate"] == "agent_message_chunk" {
                text.push_str(update["content"]["text"].as_str().unwrap());
            }
            if let Some(id) = update["toolCallId"].as_str() {
                if update["sessionUpdate"] == "tool_call" {
                    assert!(
                        tool_states
                            .insert(id.to_owned(), "pending".to_owned())
                            .is_none()
                    );
                }
                if let Some(status) = update["status"].as_str() {
                    tool_states.insert(id.to_owned(), status.into());
                }
            }
        } else if frame["id"] == "first" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        } else if probe_id.as_ref() == frame.get("id") {
            assert_eq!(frame["error"]["code"], -32601);
            independent_reply = true;
        } else {
            panic!("unexpected independent client response");
        }
    }
    assert!(independent_reply);
    assert_eq!(permissions, 2);
    assert_eq!(text, "首次完成🙂");
    assert_eq!(tool_states[&permission_tools[0]], "completed");
    assert_eq!(tool_states[&permission_tools[1]], "failed");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "已批准的内容🙂\n");
    client
        .prompt("followup", &session, "继续同一任务，不要再次写入")
        .await;
    let mut text = String::new();
    loop {
        let frame = client.read().await;
        if frame["id"] == "followup" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        }
        assert_eq!(frame["params"]["sessionId"], session);
        if frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk" {
            text.push_str(
                frame["params"]["update"]["content"]["text"]
                    .as_str()
                    .unwrap(),
            );
        }
    }
    assert_eq!(text, "后续完成✓");
    provider.await.unwrap();
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_reports_token_limit_and_closes_refused_context_without_replay() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        for step in 0..3 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let request = super::acp_session_mcp::request_body(&mut stream).await;
            if step == 1 {
                assert!(request["messages"].to_string().contains("partial-output"));
            }
            let (text, finish) = match step {
                0 => ("partial-output", "length"),
                1 => ("refused-response", "content_filter"),
                _ => ("peer-completed", "stop"),
            };
            model_reply(&mut stream, json!({"content":text}), finish).await;
        }
    });
    let mut client = CliClient::spawn("process-provider-stop-reasons", Some(&endpoint), "yolo");
    client.initialize().await;
    let session = client.new_session("new", json!([])).await;
    client
        .prompt(
            "limited",
            &session,
            "Return a response that hits its output limit",
        )
        .await;
    loop {
        let frame = client.read().await;
        if frame["id"] == "limited" {
            assert_eq!(frame["result"]["stopReason"], "max_tokens");
            break;
        }
    }
    client
        .prompt("refused", &session, "Continue the partial response")
        .await;
    loop {
        let frame = client.read().await;
        if frame["id"] == "refused" {
            assert_eq!(frame["error"]["code"], -32603);
            assert!(
                frame["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Provider refused")
            );
            break;
        }
    }
    client
        .prompt("closed", &session, "Must not reuse refused prompt history")
        .await;
    let closed = client.read().await;
    assert_eq!(closed["id"], "closed");
    assert_eq!(closed["error"]["code"], -32002);
    assert!(
        closed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("closed")
    );
    let peer = client.new_session("peer", json!([])).await;
    client
        .prompt("peer-result", &peer, "Continue independently")
        .await;
    loop {
        let frame = client.read().await;
        if frame["id"] == "peer-result" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        }
    }
    provider.await.unwrap();
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_limits_sessions_and_cancels_without_poisoning_peers_or_next_turns() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..3 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            jobs.spawn(async move {
                let request = super::acp_session_mcp::request_body(&mut stream).await;
                let last = request["messages"].as_array().unwrap().iter().rev().find(|message|message["role"]=="user").unwrap().to_string();
                if last.contains("等待取消") {
                    let delta = json!({"id":"cancel-process","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"任务已开始"},"finish_reason":null}]});
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {delta}\n\n").as_bytes()).await.unwrap();
                    let mut byte=[0];
                    assert!(matches!(tokio::time::timeout(Duration::from_secs(10),stream.read(&mut byte)).await.unwrap(),Ok(0)|Err(_)),"native provider connection survived cancellation");
                } else { model_reply(&mut stream,json!({"content":"独立任务完成✓"}),"stop").await; }
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap();
        }
    });
    let mut client = CliClient::spawn("process-session-lifecycle", Some(&endpoint), "ask");
    client.initialize().await;
    let mut sessions = Vec::new();
    for index in 0..4 {
        sessions.push(client.new_session(&format!("new-{index}"), json!([])).await);
    }
    assert_eq!(sessions.iter().collect::<BTreeSet<_>>().len(), 4);
    client.send(json!({"jsonrpc":"2.0","id":"overflow","method":"session/new","params":{"cwd":client.workspace,"mcpServers":[]}})).await;
    assert_eq!(client.read().await["error"]["code"], -32060);
    client.prompt("active", &sessions[0], "等待取消").await;
    client
        .prompt("busy", &sessions[0], "不得替换正在运行的请求")
        .await;
    client
        .prompt("peer", &sessions[1], "其他会话照常完成")
        .await;
    let mut busy = false;
    let mut stopped = false;
    let mut peer = false;
    let mut requested = false;
    while !busy || !stopped || !peer {
        let frame = client.read().await;
        match frame["id"].as_str() {
            Some("busy") => {
                assert_eq!(frame["error"]["code"], -32061);
                busy = true;
            }
            Some("active") => {
                assert_eq!(frame["result"]["stopReason"], "cancelled");
                stopped = true;
            }
            Some("peer") => {
                assert_eq!(frame["result"]["stopReason"], "end_turn");
                peer = true;
            }
            None if frame["method"] == "session/update" => {
                let session = frame["params"]["sessionId"].as_str().unwrap();
                assert!(session == sessions[0] || session == sessions[1]);
                assert!(
                    !(stopped && session == sessions[0]),
                    "late update reopened a cancelled turn"
                );
                if session == sessions[0]
                    && !requested
                    && frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
                {
                    for _ in 0..2 {
                        client.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sessions[0]}})).await;
                    }
                    requested = true;
                }
            }
            _ => panic!("unexpected session lifecycle response"),
        }
    }
    assert!(requested);
    client
        .prompt("after-cancel", &sessions[0], "下一轮照常完成")
        .await;
    loop {
        let frame = client.read().await;
        if frame["id"] == "after-cancel" {
            assert_eq!(frame["result"]["stopReason"], "end_turn");
            break;
        }
        assert_eq!(frame["params"]["sessionId"], sessions[0]);
    }
    assert!(
        client.observed.lock().unwrap().len() >= 5,
        "native session ownership was not observed"
    );
    provider.await.unwrap();
    client.shutdown().await;
    let diagnostic = client.diagnostics().await;
    assert!(
        diagnostic
            .iter()
            .any(|event| event["source"] == "client_cancel")
    );
    assert!(
        diagnostic
            .iter()
            .any(|event| event["source"] == "input_eof")
    );
    assert!(
        diagnostic
            .iter()
            .any(|event| event["outcome"] == "root_reaped")
    );
    assert!(
        diagnostic
            .iter()
            .any(|event| event["stage"] == "turn" && event["nativeTurnRef"].is_string())
    );
    client.finish().await;
}

#[tokio::test]
async fn acp_cli_process_host_stop_settles_owned_sessions_without_waiting_for_input_eof() {
    let mut client = CliClient::spawn("process-host-stop", None, "ask");
    client.initialize().await;
    client.new_session("owned", json!([])).await;
    let pid = client.child.id().unwrap();
    {
        let observed = client.observed.lock().unwrap();
        let root = observed.iter().find(|child| child.pid == pid).unwrap();
        let sent = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                root.handle.as_raw_fd(),
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        assert_eq!(sent, 0);
    }
    // Keep stdin open until the host-stop path has exited and reclaimed its child.
    let status = tokio::time::timeout(Duration::from_secs(15), client.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    let events = client.diagnostics().await;
    assert!(events.iter().any(|event| event["source"] == "host_sigterm"));
    assert!(!events.iter().any(|event| event["source"] == "input_eof"));
    assert!(events.iter().any(|event| event["outcome"] == "root_reaped"));
    client.finish().await;
}
