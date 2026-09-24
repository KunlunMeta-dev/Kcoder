use base64::Engine as _;
use fs2::FileExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn find_named_file(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = find_named_file(&path, name)
        {
            return Some(found);
        }
    }
    None
}

fn wait_for_named_file(
    root: &std::path::Path,
    name: &str,
    timeout: Duration,
) -> Option<std::path::PathBuf> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(path) = find_named_file(root, name) {
            return Some(path);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn write_turn_file_changes_fixture(
    project_dir: &std::path::Path,
    workspace: &std::path::Path,
    thread_id: &str,
    artifact_id: &str,
    file_name: &str,
) -> String {
    let output = Command::new("git")
        .args(["diff", "--no-index", "--", "/dev/null", file_name])
        .current_dir(workspace)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let patch = String::from_utf8(output.stdout).unwrap();
    let artifact_dir = project_dir
        .join("client-sessions")
        .join(thread_id)
        .join("turn-file-changes");
    std::fs::create_dir_all(&artifact_dir).unwrap();
    std::fs::write(artifact_dir.join(format!("{artifact_id}.patch")), &patch).unwrap();
    std::fs::write(
        artifact_dir.join(format!("{artifact_id}.json")),
        serde_json::to_vec(&json!({
            "version": 1,
            "status": "active",
            "artifact_id": artifact_id,
            "thread_id": thread_id,
            "turn_id": format!("fixture-{thread_id}"),
            "workspace_path": std::fs::canonicalize(workspace).unwrap(),
            "before_tree": "fixture-before",
            "after_tree": "fixture-after",
            "patch_sha256": format!("{:x}", Sha256::digest(patch.as_bytes())),
            "file_count": 1,
            "additions": 1,
            "deletions": 0,
            "files": [{
                "path": file_name,
                "change_type": "created",
                "additions": 1,
                "deletions": 0,
                "binary": false
            }],
            "created_at": "2026-07-30T00:00:00Z"
        }))
        .unwrap(),
    )
    .unwrap();
    patch
}

fn receive_response(rx: &mpsc::Receiver<std::io::Result<String>>, id: i64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let line = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("app-server response {id} timed out"))
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == id {
            return value;
        }
    }
}

struct TestAppServer {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    rx: mpsc::Receiver<std::io::Result<String>>,
    /// Every frame the server has written, in arrival order. A timed-out wait
    /// reports this journal so the failure says what the server actually sent
    /// instead of only that something did not arrive.
    observed: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl Drop for TestAppServer {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct TestAppServerBuilder {
    workspace: std::path::PathBuf,
    settings: std::path::PathBuf,
    config_dir: std::path::PathBuf,
    scenario: Option<String>,
    stream_delay_ms: Option<String>,
    subagent_stream_delay_ms: Option<String>,
    followup_stream_delay_ms: Option<String>,
    resident_limit: Option<usize>,
    discard_stderr: bool,
    training_mode: bool,
    temp_dir: Option<std::path::PathBuf>,
}

impl TestAppServerBuilder {
    fn new(workspace: &std::path::Path, settings: &std::path::Path) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            settings: settings.to_path_buf(),
            config_dir: workspace.join("config"),
            scenario: Some("full-turn".into()),
            stream_delay_ms: None,
            subagent_stream_delay_ms: None,
            followup_stream_delay_ms: None,
            resident_limit: None,
            discard_stderr: false,
            training_mode: false,
            temp_dir: None,
        }
    }

    fn scenario(mut self, scenario: &str) -> Self {
        self.scenario = Some(scenario.into());
        self
    }

    fn config_dir(mut self, config_dir: &std::path::Path) -> Self {
        self.config_dir = config_dir.to_path_buf();
        self
    }

    fn temp_dir(mut self, temp_dir: &std::path::Path) -> Self {
        self.temp_dir = Some(temp_dir.to_path_buf());
        self
    }

    fn without_scenario(mut self) -> Self {
        self.scenario = None;
        self
    }

    fn stream_delay_ms(mut self, value: &str) -> Self {
        self.stream_delay_ms = Some(value.into());
        self
    }

    fn subagent_stream_delay_ms(mut self, value: &str) -> Self {
        self.subagent_stream_delay_ms = Some(value.into());
        self
    }

    fn followup_stream_delay_ms(mut self, value: &str) -> Self {
        self.followup_stream_delay_ms = Some(value.into());
        self
    }

    fn discard_stderr(mut self) -> Self {
        self.discard_stderr = true;
        self
    }

    fn resident_limit(mut self, value: usize) -> Self {
        self.resident_limit = Some(value);
        self
    }

    fn spawn(self) -> TestAppServer {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
        command
            .args([
                "--settings-file",
                self.settings.to_str().unwrap(),
                "--cwd",
                self.workspace.to_str().unwrap(),
                "app-server",
            ])
            .env("XDG_CONFIG_HOME", &self.config_dir)
            .env("KCODER_CONFIG_DIR", &self.config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if self.discard_stderr {
                Stdio::null()
            } else {
                Stdio::piped()
            });
        if let Some(temp_dir) = self.temp_dir {
            for name in ["TMPDIR", "TEMP", "TMP"] {
                command.env(name, &temp_dir);
            }
        }
        if let Some(scenario) = self.scenario {
            command.args(["--scenario", &scenario]);
        }
        if self.training_mode {
            command.arg("--training-mode");
        }
        for (name, value) in [
            ("KCODER_TUI_LAB_STREAM_DELAY_MS", self.stream_delay_ms),
            (
                "KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS",
                self.subagent_stream_delay_ms,
            ),
            (
                "KCODER_TUI_LAB_FOLLOWUP_STREAM_DELAY_MS",
                self.followup_stream_delay_ms,
            ),
        ] {
            if let Some(value) = value {
                command.env(name, value);
            }
        }
        if let Some(limit) = self.resident_limit {
            command.env("KCODER_APP_SERVER_RESIDENT_THREAD_LIMIT", limit.to_string());
        }

        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let journal = std::sync::Arc::clone(&observed);
        std::thread::spawn(move || {
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
        let stdin = child.stdin.take();
        TestAppServer {
            child,
            stdin,
            rx,
            observed,
        }
    }
}

impl TestAppServer {
    fn builder(workspace: &std::path::Path, settings: &std::path::Path) -> TestAppServerBuilder {
        TestAppServerBuilder::new(workspace, settings)
    }

    fn start(workspace: &std::path::Path, settings: &std::path::Path) -> Self {
        Self::start_scenario(workspace, settings, "full-turn", "1", "0", "0")
    }

    fn start_with_resident_limit(
        workspace: &std::path::Path,
        settings: &std::path::Path,
        resident_limit: usize,
    ) -> Self {
        Self::builder(workspace, settings)
            .resident_limit(resident_limit)
            .stream_delay_ms("1")
            .subagent_stream_delay_ms("0")
            .followup_stream_delay_ms("0")
            .discard_stderr()
            .spawn()
    }

    fn start_scenario(
        workspace: &std::path::Path,
        settings: &std::path::Path,
        scenario: &str,
        stream_delay_ms: &str,
        subagent_stream_delay_ms: &str,
        followup_stream_delay_ms: &str,
    ) -> Self {
        Self::builder(workspace, settings)
            .scenario(scenario)
            .stream_delay_ms(stream_delay_ms)
            .subagent_stream_delay_ms(subagent_stream_delay_ms)
            .followup_stream_delay_ms(followup_stream_delay_ms)
            .discard_stderr()
            .spawn()
    }

    fn send(&mut self, request: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
    }

    fn send_batch(&mut self, requests: impl IntoIterator<Item = Value>) {
        let stdin = self.stdin.as_mut().unwrap();
        for request in requests {
            writeln!(stdin, "{request}").unwrap();
        }
        stdin.flush().unwrap();
    }

    fn write_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn response(&self, id: i64) -> Value {
        receive_response(&self.rx, id)
    }

    fn wait_for_method(&self, method: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let line = self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("app-server method {method} timed out"))
                .unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["method"] == method {
                return value;
            }
        }
    }

    fn next_value(&self, deadline: Instant) -> Value {
        let line = self
            .rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("app-server event timed out; {}", self.observed_tail()))
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// A bounded summary of the frames the server has sent so far. Only the
    /// routing fields are kept, so the report stays readable.
    fn observed_tail(&self) -> String {
        let observed = self.observed.lock().unwrap();
        if observed.is_empty() {
            return "the server sent no frame at all".to_string();
        }
        let start = observed.len().saturating_sub(40);
        let shown = observed[start..]
            .iter()
            .map(|line| {
                let value: Value = match serde_json::from_str(line) {
                    Ok(value) => value,
                    Err(_) => return "<unparsable frame>".to_string(),
                };
                if let Some(method) = value["method"].as_str() {
                    format!(
                        "{method}(agent={})",
                        value["params"]["agentId"].as_str().unwrap_or("-")
                    )
                } else {
                    format!("response id={}", value["id"])
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{} frames seen, last {}: {}",
            observed.len(),
            observed.len() - start,
            shown
        )
    }

    fn initialize(&mut self, id: i64) -> Value {
        self.send(json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "metadata-test", "version": "1"}}
        }));
        self.response(id)
    }

    fn shutdown(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                panic!("app-server did not exit after stdin closed");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn shutdown_successfully(mut self) {
        drop(self.stdin.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn write_test_settings(path: &std::path::Path) {
    std::fs::write(
        path,
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
}

include!("app_server_stdio/attachments.rs");
include!("app_server_stdio/ephemeral.rs");
include!("app_server_stdio/limits.rs");
include!("app_server_stdio/background.rs");
include!("app_server_stdio/thread_metadata.rs");
include!("app_server_stdio/turn.rs");
include!("app_server_stdio/config_historyless.rs");
include!("app_server_stdio/diagnostics.rs");
include!("app_server_stdio/context_settings.rs");
include!("app_server_stdio/provider_settings.rs");
include!("app_server_stdio/browser_preflight.rs");
include!("app_server_stdio/worktree.rs");
include!("app_server_stdio/resident.rs");
include!("app_server_stdio/agent_artifacts.rs");
include!("app_server_stdio/plugins.rs");
include!("app_server_stdio/goals.rs");
include!("app_server_stdio/modes.rs");
include!("app_server_stdio/tools_catalog.rs");
include!("app_server_stdio/history_refresh.rs");
include!("app_server_stdio/settings_templates.rs");
include!("app_server_stdio/storage_diagnostics.rs");
include!("app_server_stdio/turn_file_changes_settings.rs");

include!("app_server_stdio/session_reload.rs");
include!("app_server_stdio/run_summary.rs");
include!("app_server_stdio/turn_submission.rs");
include!("app_server_stdio/provider_fixture.rs");
include!("app_server_stdio/continuation_race.rs");
include!("app_server_stdio/continuation_safety.rs");
include!("app_server_stdio/continuation_attachments.rs");
include!("app_server_stdio/continuation_partial_stream.rs");
include!("app_server_stdio/continuation_unverified_tool.rs");
include!("app_server_stdio/continuation_completed_tool.rs");
include!("app_server_stdio/continuation_capability.rs");
include!("app_server_stdio/continuation_model_identity.rs");
include!("app_server_stdio/continuation_receipt.rs");
include!("app_server_stdio/mutation_idempotency.rs");
include!("app_server_stdio/continuation_retry_operation.rs");
include!("app_server_stdio/partial_stream_crash.rs");
include!("app_server_stdio/continuation_hook_delivery.rs");
include!("app_server_stdio/continuation_background_delivery.rs");

include!("app_server_stdio/thread_creation_receipts.rs");

include!("app_server_stdio/workflow_canvas.rs");
