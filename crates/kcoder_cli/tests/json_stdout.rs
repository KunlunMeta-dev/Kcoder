use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn kcoder_binary() -> &'static str {
    env!("CARGO_BIN_EXE_kcoder")
}

#[test]
fn explicitly_trusted_marketplace_can_be_added_from_an_untrusted_parent() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let parent = temp.path().join("workspace");
    let marketplace = parent.join("staging/test-marketplace");
    let plugin = marketplace.join("plugins/demo/.claude-plugin");
    let manifest = marketplace.join(".agents/plugins/marketplace.json");
    std::fs::create_dir_all(&config_home).expect("create config home");
    std::fs::create_dir_all(&plugin).expect("create plugin fixture");
    std::fs::create_dir_all(manifest.parent().unwrap()).expect("create marketplace fixture");
    std::fs::write(
        plugin.join("plugin.json"),
        r#"{"name":"demo","version":"1.0.0"}"#,
    )
    .expect("write plugin manifest");
    std::fs::write(
        &manifest,
        r#"{"name":"trusted-market","plugins":[{"name":"demo","source":"./plugins/demo"}]}"#,
    )
    .expect("write marketplace manifest");

    let trust = Command::new(kcoder_binary())
        .current_dir(&parent)
        .env("HOME", temp.path())
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_TRUST_ALL")
        .args(["trust", "add", "--path"])
        .arg(&marketplace)
        .output()
        .expect("trust marketplace source");
    assert!(
        trust.status.success(),
        "trust add failed: {}",
        String::from_utf8_lossy(&trust.stderr)
    );
    let trust_file: Value = serde_json::from_slice(
        &std::fs::read(config_home.join("trusted-folders.json"))
            .expect("read persisted trust store"),
    )
    .expect("parse persisted trust store");
    assert_eq!(trust_file["trusted"].as_array().unwrap().len(), 1);
    let status = Command::new(kcoder_binary())
        .current_dir(&parent)
        .env("HOME", temp.path())
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_TRUST_ALL")
        .args(["trust", "status", "--path"])
        .arg(&marketplace)
        .output()
        .expect("read persisted marketplace trust");
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).starts_with("trusted\t"));

    let added = Command::new(kcoder_binary())
        .current_dir(&parent)
        .env("HOME", temp.path())
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_TRUST_ALL")
        .args(["marketplace", "add", "trusted-market", "--path"])
        .arg(&marketplace)
        .output()
        .expect("add trusted marketplace");
    assert!(
        added.status.success(),
        "marketplace add failed: {}",
        String::from_utf8_lossy(&added.stderr)
    );
    let settings: Value = serde_json::from_slice(
        &std::fs::read(config_home.join("settings.json")).expect("read persisted settings"),
    )
    .expect("parse persisted settings");
    assert_eq!(
        settings["plugins"]["marketplaces"]["trusted-market"]["source"]["type"],
        "local"
    );
}

#[test]
fn version_probe_does_not_initialize_a_user_profile() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("missing-config");

    let output = Command::new(kcoder_binary())
        .env("HOME", temp.path())
        .env("KCODER_HOME", &config_home)
        .env("KCODER_CONFIG_DIR", &config_home)
        .arg("--version")
        .output()
        .expect("run version probe");

    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .expect("version output must be UTF-8")
            .starts_with("kcoder ")
    );
    assert!(
        !config_home.exists(),
        "--version must not initialize {}",
        config_home.display()
    );
}

#[test]
fn json_stdout_is_not_polluted_by_provider_diagnostics() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let cache_home = temp.path().join("cache");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&config_home).expect("create config home");
    std::fs::create_dir_all(&cache_home).expect("create cache home");
    std::fs::create_dir_all(&cwd).expect("create working directory");
    std::fs::write(
        config_home.join("settings.json"),
        r#"{"summary_provider":null,"summary_model":null}"#,
    )
    .expect("disable isolated summary provider for the test");

    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve loopback port");
    let closed_addr = listener.local_addr().expect("read reserved address");
    drop(listener);

    let output = Command::new(kcoder_binary())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("RUST_LOG", "warn")
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_PROFILE")
        .env_remove("KCODER_PROVIDER")
        .env_remove("KCODER_MODEL")
        .env_remove("KCODER_SUMMARY_PROVIDER")
        .env_remove("KCODER_SUMMARY_MODEL")
        .env_remove("KCODER_SUMMARY_PROFILE")
        .env_remove("KCODER_LOCAL_BASE_URL")
        .env_remove("KCODER_MAX_RETRIES")
        .env_remove("KCODER_PERMISSION_MODE")
        .args([
            "--provider",
            "local",
            "--model",
            "local-model",
            "--local-base-url",
            &format!("http://{closed_addr}/v1"),
            "--max-retries",
            "0",
            "--permission-mode",
            "yolo",
            "--json",
            "--cwd",
        ])
        .arg(&cwd)
        .arg("Reply briefly.")
        .output()
        .expect("run kcoder in JSON headless mode");

    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8");
    let stderr = String::from_utf8(output.stderr).expect("stderr must be UTF-8");

    assert!(
        !output.status.success(),
        "provider failure must return non-zero"
    );
    assert!(
        !stdout.contains('\u{1b}'),
        "stdout contains ANSI: {stdout:?}"
    );
    assert!(
        !stdout.contains("kcoder_engine:"),
        "stdout contains tracing diagnostics: {stdout:?}"
    );

    let lines = stdout.lines().collect::<Vec<_>>();
    assert!(!lines.is_empty(), "expected at least one JSON event");
    for (index, line) in lines.iter().enumerate() {
        serde_json::from_str::<Value>(line).unwrap_or_else(|error| {
            panic!("stdout line {} is not JSON: {error}: {line:?}", index + 1)
        });
    }
    let terminal: Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(terminal["type"], "result", "last JSON line: {terminal}");
    assert_eq!(terminal["subtype"], "error", "last JSON line: {terminal}");

    assert!(
        stderr.contains("local provider stream error"),
        "stderr lacks expected provider diagnostic: {stderr:?}"
    );
    assert!(
        !stderr.contains('\u{1b}'),
        "stderr contains ANSI: {stderr:?}"
    );
}

#[test]
fn required_project_skill_preflight_blocks_before_provider_request() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let cache_home = temp.path().join("cache");
    let cwd = temp.path().join("workspace");
    let skill_dir = cwd.join(".kcoder/skills/ci-triage");
    std::fs::create_dir_all(&config_home).unwrap();
    std::fs::create_dir_all(&cache_home).unwrap();
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: ci-triage\ndescription: Triage CI\n---\n\nUse this skill.\n",
    )
    .unwrap();
    std::fs::write(
        config_home.join("settings.json"),
        r#"{"summary_provider":null,"summary_model":null}"#,
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_addr = listener.local_addr().unwrap();
    drop(listener);

    let output = Command::new(kcoder_binary())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_TRUST_ALL")
        .env_remove("KCODER_PROFILE")
        .env_remove("KCODER_PROVIDER")
        .env_remove("KCODER_MODEL")
        .args([
            "--provider",
            "local",
            "--model",
            "local-model",
            "--local-base-url",
            &format!("http://{closed_addr}/v1"),
            "--max-retries",
            "0",
            "--permission-mode",
            "yolo",
            "--require-skill",
            "ci-triage",
            "--json",
            "--cwd",
        ])
        .arg(&cwd)
        .arg("Use ci-triage.")
        .output()
        .expect("run headless preflight");

    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let events = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        events.len(),
        2,
        "provider must not produce any events: {stdout}"
    );
    assert_eq!(events[0]["type"], "preflight_failed");
    assert_eq!(events[0]["reason"], "project_not_trusted");
    assert!(
        events[0]["remediation"]
            .as_str()
            .unwrap()
            .contains("kcoder trust add --path")
    );
    assert_eq!(events[1]["type"], "result");
    assert_eq!(events[1]["task_status"], "blocked");
    assert_eq!(
        events[1]["termination_reason"],
        "required_skill_unavailable"
    );
}

fn read_http_request(stream: &mut std::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let count = stream.read(&mut buffer).expect("read HTTP request");
        if count == 0 {
            return String::new();
        }
        bytes.extend_from_slice(&buffer[..count]);
        let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let body = &bytes[header_end + 4..];
        let is_chunked = headers.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("transfer-encoding")
                    && value
                        .split(',')
                        .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
            })
        });
        if is_chunked && chunked_body_is_complete(body) {
            return headers
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string();
        }
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(str::trim)
                    .map(str::to_string)
            })
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if !is_chunked && body.len() >= content_length {
            return headers
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string();
        }
    }
}

fn chunked_body_is_complete(mut body: &[u8]) -> bool {
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            return false;
        };
        let Ok(line) = std::str::from_utf8(&body[..line_end]) else {
            return false;
        };
        let Some(size) = line
            .split(';')
            .next()
            .and_then(|size| usize::from_str_radix(size.trim(), 16).ok())
        else {
            return false;
        };
        body = &body[line_end + 2..];
        if size == 0 {
            return body.starts_with(b"\r\n")
                || body.windows(4).any(|window| window == b"\r\n\r\n");
        }
        if body.len() < size + 2 || &body[size..size + 2] != b"\r\n" {
            return false;
        }
        body = &body[size + 2..];
    }
}

fn write_sse(stream: &mut std::net::TcpStream, payload: &str) {
    let body = format!("data: {payload}\n\n");
    write!(stream, "{:X}\r\n", body.len()).expect("write SSE chunk length");
    stream
        .write_all(body.as_bytes())
        .expect("write SSE event body");
    stream.write_all(b"\r\n").expect("finish SSE chunk");
    stream.flush().expect("flush SSE event");
}

fn finish_sse(stream: &mut std::net::TcpStream) {
    stream
        .write_all(b"0\r\n\r\n")
        .expect("finish chunked SSE response");
    stream.flush().expect("flush final SSE chunk");
}

fn accept_with_deadline(listener: &TcpListener) -> std::net::TcpStream {
    // The CLI performs startup prewarming before opening the provider socket.
    // Shared CI hosts can spend well over ten seconds compiling shell snapshots
    // or loading the debug binary, so the mock server must outlive that startup.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_nonblocking(false)
                    .expect("make accepted HTTP stream blocking");
                stream
                    .set_read_timeout(Some(Duration::from_secs(60)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(60)))
                    .unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "timed out accepting HTTP request"
                );
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("failed accepting HTTP request: {error}"),
        }
    }
}

fn accept_provider_request(listener: &TcpListener) -> std::net::TcpStream {
    loop {
        let mut stream = accept_with_deadline(listener);
        if read_http_request(&mut stream).eq_ignore_ascii_case("POST") {
            return stream;
        }
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .expect("respond to provider prewarm request");
        stream.flush().expect("flush provider prewarm response");
    }
}

fn wait_child_with_deadline(child: &mut std::process::Child) -> std::process::ExitStatus {
    // Same reasoning as the live-delta budget: child exit includes the
    // session-end summary roundtrip, which is slow on loaded shared machines.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child.wait().unwrap();
            panic!("child did not exit before deadline; killed with {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn json_stdout_streams_before_the_provider_finishes() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let cache_home = temp.path().join("cache");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&config_home).unwrap();
    std::fs::create_dir_all(&cache_home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(
        config_home.join("settings.json"),
        r#"{"summary_provider":null,"summary_model":null}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let (delta_sent_tx, delta_sent_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        // Main turn.
        let mut stream = accept_provider_request(&listener);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"live"},"finish_reason":null}]}"#,
        );
        delta_sent_tx.send(()).unwrap();
        if !release_rx
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or(false)
        {
            return;
        }
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);
        drop(stream);

        // Session-end summary, explicitly routed to this same local provider.
        let mut stream = accept_provider_request(&listener);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<summary>local summary</summary>"},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);
    });

    let mut child = Command::new(kcoder_binary())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_PROFILE")
        .env_remove("KCODER_PROVIDER")
        .env_remove("KCODER_MODEL")
        .env_remove("KCODER_SUMMARY_PROVIDER")
        .env_remove("KCODER_SUMMARY_MODEL")
        .env_remove("KCODER_SUMMARY_PROFILE")
        .args([
            "--provider",
            "local",
            "--model",
            "local-model",
            "--local-base-url",
            &format!("http://{addr}/v1"),
            "--max-retries",
            "0",
            "--permission-mode",
            "yolo",
            "--json",
            "--cwd",
        ])
        .arg(&cwd)
        .arg("Reply briefly.")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kcoder");

    let stdout = child.stdout.take().unwrap();
    let (line_tx, line_rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut saw_live_delta = false;
    let mut read_failure = None;
    // Generous budget: the deadline must cover debug-binary startup plus the
    // first SSE roundtrip on heavily loaded shared machines, not just the
    // happy path. The assertion that matters is "the delta arrives before the
    // provider finishes", not wall-clock speed.
    let live_output_deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < live_output_deadline {
        let remaining = live_output_deadline.saturating_duration_since(Instant::now());
        let line = match line_rx.recv_timeout(remaining.min(Duration::from_millis(500))) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => {
                read_failure = Some(format!("failed reading stdout: {error}"));
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                read_failure =
                    Some("stdout closed before the live JSON output was observed".to_string());
                break;
            }
        };
        let event: Value = match serde_json::from_str(&line) {
            Ok(event) => event,
            Err(error) => {
                read_failure = Some(format!("invalid JSON output: {error}: {line:?}"));
                break;
            }
        };
        if event["type"] == "assistant_text_delta" && event["text"] == "live" {
            saw_live_delta = true;
            break;
        }
    }
    if !saw_live_delta && read_failure.is_none() {
        read_failure = Some("timed out waiting for the live text delta".to_string());
    }
    if read_failure.is_none() && delta_sent_rx.recv_timeout(Duration::from_secs(2)).is_err() {
        read_failure = Some("server did not confirm sending the live delta".to_string());
    }
    if read_failure.is_none() && child.try_wait().unwrap().is_some() {
        read_failure = Some("process exited while the provider awaited release".to_string());
    }
    let continue_server = read_failure.is_none();
    let _ = release_tx.send(continue_server);
    if let Some(error) = read_failure {
        let server_sent_delta = delta_sent_rx.try_recv().is_ok();
        let _ = child.kill();
        let _ = child.wait();
        let mut stderr = String::new();
        if let Some(mut child_stderr) = child.stderr.take() {
            let _ = child_stderr.read_to_string(&mut stderr);
        }
        reader.join().unwrap();
        server.join().unwrap();
        panic!("{error}; server_sent_delta={server_sent_delta}; child stderr: {stderr}");
    }

    let status = wait_child_with_deadline(&mut child);
    assert!(status.success());
    reader.join().unwrap();
    server.join().unwrap();
    let remaining = line_rx.try_iter().collect::<Vec<_>>();
    let last = remaining
        .last()
        .expect("JSON stream must end with a terminal result event")
        .as_ref()
        .expect("terminal JSON line must be readable");
    let terminal: Value = serde_json::from_str(last).expect("terminal line must be JSON");
    assert_eq!(terminal["type"], "result", "last JSON line: {terminal}");
    assert_eq!(terminal["subtype"], "success", "last JSON line: {terminal}");
}

#[test]
fn training_mode_records_only_task_loop_requests_across_a_tool_roundtrip() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let cache_home = temp.path().join("cache");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&config_home).unwrap();
    std::fs::create_dir_all(&cache_home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(config_home.join("settings.json"), "{}").unwrap();
    let plugin_root = config_home.join("plugins/training-probe");
    std::fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(plugin_root.join("hooks")).unwrap();
    let hook_marker = temp.path().join("plugin-hook-ran");
    let mcp_marker = temp.path().join("plugin-mcp-ran");
    std::fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"training-probe","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        plugin_root.join("hooks/hooks.json"),
        serde_json::to_vec(&serde_json::json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": format!(
                            "printf active > '{}'; printf '%s' '{{\"continue\":true,\"suppressOutput\":true}}'",
                            hook_marker.display()
                        )
                    }]
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        plugin_root.join("mcp-server.sh"),
        format!(
            r#"#!/bin/sh
printf active > '{}'
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2024-11-05","capabilities":{{}},"serverInfo":{{"name":"training-probe","version":"1"}}}}}}'
      ;;
    *'"method":"tools/list"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"tools":[]}}}}'
      ;;
  esac
done
"#,
            mcp_marker.display()
        ),
    )
    .unwrap();
    std::fs::write(
        plugin_root.join(".mcp.json"),
        r#"{"mcpServers":{"training-probe":{"command":"/bin/sh","args":["${CLAUDE_PLUGIN_ROOT}/mcp-server.sh"]}}}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let mut request_count = 0usize;

        // The primary agent requests a tool for the first time.
        let mut stream = accept_provider_request(&listener);
        request_count += 1;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-training-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_training","type":"function","function":{"name":"bash","arguments":"{\"command\":\"true\"}"}}]},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-training-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);
        drop(stream);

        // Primary-agent request after the tool result.
        let mut stream = accept_provider_request(&listener);
        request_count += 1;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-training-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-training-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);
        drop(stream);

        // If SessionEnd or another background feature still issues requests, receive
        // and count them in a short window while responding normally so a defective
        // child cannot stall the test while waiting for a summary.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    if read_http_request(&mut stream).eq_ignore_ascii_case("POST") {
                        request_count += 1;
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                        )
                        .unwrap();
                        stream.flush().unwrap();
                        write_sse(
                            &mut stream,
                            r#"{"id":"chatcmpl-unexpected","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"unexpected"},"finish_reason":"stop"}]}"#,
                        );
                        write_sse(&mut stream, "[DONE]");
                        finish_sse(&mut stream);
                    } else {
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .unwrap();
                        stream.flush().unwrap();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("failed while checking for extra requests: {error}"),
            }
        }
        request_count
    });

    let output = Command::new(kcoder_binary())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_PROFILE")
        .env_remove("KCODER_PROVIDER")
        .env_remove("KCODER_MODEL")
        .env_remove("KCODER_TRAINING_MODE")
        .args([
            "--training-mode",
            "--provider",
            "local",
            "--model",
            "local-model",
            "--local-base-url",
            &format!("http://{addr}/v1"),
            "--permission-mode",
            "yolo",
            "--json",
            "--cwd",
        ])
        .arg(&cwd)
        .arg("Run one tool, then finish.")
        .output()
        .expect("run KCoder training harness");

    let request_count = server.join().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        output.status.success(),
        "training harness failed; stdout={stdout}; stderr={stderr}"
    );
    assert_eq!(
        request_count, 2,
        "only the tool request and its task-loop follow-up may reach the Provider"
    );
    assert!(
        !hook_marker.exists(),
        "--training-mode must not execute plugin Hooks"
    );
    assert!(
        !mcp_marker.exists(),
        "--training-mode must not start plugin MCP servers"
    );
}

#[test]
fn json_stdout_reports_max_duration_as_timed_out_task() {
    let temp = tempfile::tempdir().expect("create isolated test directory");
    let config_home = temp.path().join("config");
    let cache_home = temp.path().join("cache");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&config_home).unwrap();
    std::fs::create_dir_all(&cache_home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(
        config_home.join("settings.json"),
        r#"{"summary_provider":null,"summary_model":null}"#,
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        // Deliberately exhaust the first-turn budget and request one tool so the engine enters its finalization subturn.
        let mut stream = accept_provider_request(&listener);
        thread::sleep(Duration::from_millis(1_100));
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"true\"}"}}]},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);

        // The finalization subturn returns text, but terminal status must remain timed_out rather than success.
        let mut stream = accept_provider_request(&listener);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"best effort"},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);

        // The SessionEnd summary uses the local provider.
        let mut stream = accept_provider_request(&listener);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<summary>timed out</summary>"},"finish_reason":null}]}"#,
        );
        write_sse(
            &mut stream,
            r#"{"id":"chatcmpl-timeout-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        );
        write_sse(&mut stream, "[DONE]");
        finish_sse(&mut stream);
    });

    let output = Command::new(kcoder_binary())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("KCODER_CONFIG_DIR", &config_home)
        .env_remove("KCODER_PROFILE")
        .env_remove("KCODER_PROVIDER")
        .env_remove("KCODER_MODEL")
        .env_remove("KCODER_SUMMARY_PROVIDER")
        .env_remove("KCODER_SUMMARY_MODEL")
        .env_remove("KCODER_SUMMARY_PROFILE")
        .args([
            "--provider",
            "local",
            "--model",
            "local-model",
            "--local-base-url",
            &format!("http://{addr}/v1"),
            "--max-retries",
            "0",
            "--max-duration-secs",
            "1",
            "--permission-mode",
            "yolo",
            "--json",
            "--cwd",
        ])
        .arg(&cwd)
        .arg("Run one tool before completing.")
        .output()
        .expect("run kcoder in JSON headless mode");

    server.join().unwrap();
    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8");
    assert!(
        !output.status.success(),
        "timed-out task must return non-zero"
    );
    let events = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        events.iter().any(|event| {
            event["type"] == "stream_aborted" && event["reason"] == "max_duration"
        })
    );
    let terminal = events.last().expect("terminal result event");
    assert_eq!(terminal["type"], "result");
    assert_eq!(terminal["subtype"], "error");
    assert_eq!(terminal["run_status"], "completed");
    assert_eq!(terminal["task_status"], "timed_out");
    assert_eq!(terminal["termination_reason"], "max_duration");
    assert_eq!(terminal["resume_safe"], true);
}
