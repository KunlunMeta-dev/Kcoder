#![cfg(unix)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct ChildGuard(std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn app_server_survives_mcp_collision_and_reports_both_original_sources() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let settings = temp.path().join("settings_test.jsonc");
    std::fs::create_dir(&workspace).unwrap();
    let script = r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}' ;;
    *'"method":"tools/list"'*)
      echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read/page","description":"original","inputSchema":{"type":"object"}},{"name":"read_page","description":"rejected","inputSchema":{"type":"object"}},{"name":"other","description":"survives","inputSchema":{"type":"object"}}]}}' ;;
  esac
done
"#;
    std::fs::write(&settings, serde_json::to_vec(&json!({
        "active_provider": "test",
        "providers": {"test": {
            "api_format": "openai_chat_completions", "endpoint": "http://127.0.0.1:1/v1",
            "default_model": "test", "context_window_tokens": 128000,
            "output_headroom_tokens": 8192, "max_output_tokens": 8192
        }},
        "mcp_servers": [{"name": "docs / original", "transport": "stdio", "command": "sh", "args": ["-c", script]}],
        "history_enabled": false
    })).unwrap()).unwrap();
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_kcoder"))
            .arg("--settings-file")
            .arg(&settings)
            .arg("--cwd")
            .arg(&workspace)
            .args(["--tool-profile", "full", "app-server"])
            .env("KCODER_CONFIG_DIR", &config)
            .env("XDG_CONFIG_HOME", &config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let mut stderr = child.0.stderr.take().unwrap();
    let stderr_task = std::thread::spawn(move || {
        let mut text = String::new();
        stderr.read_to_string(&mut text).unwrap();
        text
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let _ = tx.send(line);
        }
    });
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2026-07-27", "clientInfo": {"name": "registration-test", "version": "1"}
    }})).unwrap();
    stdin.flush().unwrap();
    let response: Value =
        serde_json::from_str(&rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap()).unwrap();
    assert_eq!(response["id"], 1, "{response}");
    assert!(response.get("error").is_none(), "{response}");
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "{status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "app-server did not stop after stdin closed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let stderr = stderr_task.join().unwrap();
    assert!(stderr.contains("tool registration conflict"), "{stderr}");
    assert!(stderr.contains("mcp__docs_original__read_page"), "{stderr}");
    assert!(
        stderr.contains("read/page") && stderr.contains("read_page"),
        "{stderr}"
    );
    assert!(stderr.contains("docs / original"), "{stderr}");
}
