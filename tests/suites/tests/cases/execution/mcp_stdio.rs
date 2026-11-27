use kcoder_mcp::McpClient;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

fn read_marker(path: &Path) -> Vec<Value> {
    let source = std::fs::read_to_string(path).unwrap_or_default();
    let complete = source
        .rfind('\n')
        .map_or("", |last_newline| &source[..=last_newline]);
    complete
        .lines()
        .map(|line| serde_json::from_str(line).expect("marker 必须是 JSONL"))
        .collect()
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("tasklist 应可执行");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split(',').nth(1))
        .any(|field| field.trim_matches('"').parse::<u32>() == Ok(pid))
}

async fn wait_for_marker(path: &Path) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let records = read_marker(path);
            if !records.is_empty() {
                return records;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("MCP fixture 应及时写入启动记录")
}

async fn wait_for_exit(pid: u32) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while process_exists(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("McpClient drop 后应及时回收确切 PID 的子进程");
}

#[test]
fn marker_reader_ignores_an_incomplete_trailing_jsonl_record() {
    let temp = tempfile::tempdir().expect("应创建临时目录");
    let marker = temp.path().join("partial.jsonl");
    std::fs::write(&marker, "{\"method\":\"started\"}\n{\"method\":").expect("应写入部分 JSONL");

    assert_eq!(read_marker(&marker), vec![json!({"method": "started"})]);
}

#[tokio::test]
async fn stdio_client_completes_handshake_call_and_reaps_child() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let temp = tempfile::tempdir().expect("应创建临时目录");
        let marker = temp.path().join("mcp-marker.jsonl");
        let args = vec![
            "--marker".to_string(),
            marker.to_string_lossy().into_owned(),
        ];
        let mut client = McpClient::new(
            env!("CARGO_BIN_EXE_fixture_mcp_server"),
            &args,
            &HashMap::new(),
        )
        .await
        .expect("应启动真实 stdio MCP server");

        let started = wait_for_marker(&marker).await;
        let pid = started[0]["pid"].as_u64().expect("marker 应记录 PID") as u32;
        assert!(process_exists(pid), "fixture MCP 子进程应处于运行状态");

        let initialized = client.initialize().await.expect("initialize 应成功");
        assert_eq!(initialized.server_info.name, "fixture-mcp");
        let tools = client.list_tools().await.expect("tools/list 应成功");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        let result = client
            .call_tool("echo", serde_json::json!({"text": "跨进程回声"}))
            .await
            .expect("tools/call 应成功");
        assert!(!result.is_error);
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].text.as_deref(), Some("跨进程回声"));

        let records = read_marker(&marker);
        let methods = records
            .iter()
            .filter_map(|record| record["method"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "started",
                "initialize",
                "notifications/initialized",
                "tools/list",
                "tools/call"
            ]
        );
        assert_eq!(
            records[1]["request"],
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "kcoder", "version": env!("CARGO_PKG_VERSION")}
                }
            })
        );
        assert_eq!(
            records[2]["request"],
            json!({
                "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
            })
        );
        assert_eq!(
            records[3]["request"],
            json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
            })
        );
        assert_eq!(
            records[4]["request"],
            json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "echo", "arguments": {"text": "跨进程回声"}}
            })
        );

        drop(client);
        wait_for_exit(pid).await;
    })
    .await
    .expect("真实 MCP stdio 边界测试总时限为 10 秒");
}

#[tokio::test]
async fn fixture_mcp_server_rejects_invalid_envelopes_with_failure_exit() {
    let temp = tempfile::tempdir().expect("应创建临时目录");
    let marker = temp.path().join("invalid-marker.jsonl");
    let mut command = Command::new(env!("CARGO_BIN_EXE_fixture_mcp_server"));
    command
        .args(["--marker", marker.to_str().expect("临时路径必须是 UTF-8")])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().expect("应启动 fixture MCP server");
    let pid = child.id().expect("fixture 应有精确 PID");
    let mut stdin = child.stdin.take().expect("fixture stdin 必须存在");
    let request = format!(
        "{}\n",
        json!({"jsonrpc": "1.0", "id": 1, "method": "initialize", "params": {}})
    );
    stdin
        .write_all(request.as_bytes())
        .await
        .expect("应发送非法请求");
    stdin.shutdown().await.expect("应关闭 fixture stdin");
    drop(stdin);
    let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(result) => result.expect("fixture wait 应成功"),
        Err(_) => {
            child
                .kill()
                .await
                .expect("超时后必须精确终止 fixture child");
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .expect("终止后必须及时回收 fixture child")
                .expect("fixture reap 应成功");
            panic!("非法 envelope fixture 未在 2 秒内退出");
        }
    };

    assert!(
        !status.success(),
        "非法 JSON-RPC envelope 必须使 fixture 失败退出"
    );
    assert!(!process_exists(pid), "fixture 失败退出后不得遗留精确 PID");
}
