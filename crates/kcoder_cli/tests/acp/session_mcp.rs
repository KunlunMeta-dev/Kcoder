//! End-to-end ACP -> app-server -> private MCP -> model continuation, without paid calls.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct FixtureOwner {
    root: PathBuf,
    disarmed: bool,
}
impl FixtureOwner {
    fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            disarmed: false,
        }
    }
}
impl Drop for FixtureOwner {
    fn drop(&mut self) {
        if !self.disarmed {
            for owner in ["alpha", "beta", "hang"] {
                if let Ok(pid) = std::fs::read_to_string(self.root.join(owner).join("pid"))
                    && let Ok(pid) = pid.parse::<i32>()
                    && pid > 1
                {
                    // The private fixture records only its own process-group leader.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                }
            }
        }
    }
}

pub(super) async fn request_body(stream: &mut tokio::net::TcpStream) -> Value {
    let mut stream = BufReader::new(stream);
    let mut length = None;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        assert!(stream.read_line(&mut line).await.unwrap() > 0);
        assert!(line.len() < 16384);
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = Some(value.trim().parse::<usize>().unwrap());
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value.to_ascii_lowercase().contains("chunked");
            }
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let count = usize::from_str_radix(line.trim().split(';').next().unwrap(), 16).unwrap();
            if count == 0 {
                break;
            }
            assert!(body.len() + count <= 2 * 1024 * 1024);
            let start = body.len();
            body.resize(start + count, 0);
            stream.read_exact(&mut body[start..]).await.unwrap();
            let mut end = [0u8; 2];
            stream.read_exact(&mut end).await.unwrap();
            assert_eq!(&end, b"\r\n");
        }
    } else {
        let count = length.expect("provider request has no body length");
        assert!(count <= 2 * 1024 * 1024);
        body.resize(count, 0);
        stream.read_exact(&mut body).await.unwrap();
    }
    serde_json::from_slice(&body).unwrap()
}

pub(super) async fn send(writer: &mut (impl tokio::io::AsyncWrite + Unpin), value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    writer.write_all(&bytes).await.unwrap();
}
pub(super) async fn receive(
    lines: &mut tokio::io::Lines<impl tokio::io::AsyncBufRead + Unpin>,
) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .expect("ACP EOF");
    serde_json::from_str(&line).unwrap()
}

fn assert_no_private_files(root: &Path) {
    for item in std::fs::read_dir(root).unwrap() {
        let path = item.unwrap().path();
        if path.is_dir() {
            assert_no_private_files(&path);
        } else if let Ok(text) = std::fs::read_to_string(&path) {
            for secret in [
                "session-private-alpha-unique",
                "session-private-beta-unique",
            ] {
                assert!(
                    !text.contains(secret),
                    "private environment persisted at {}",
                    path.display()
                );
            }
        }
    }
}

#[tokio::test]
async fn acp_mcp_is_private_session_owned_and_does_not_modify_settings() {
    let root = tempfile::tempdir().unwrap();
    let mut owner_guard = FixtureOwner::new(root.path());
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let config = root.path().join("config");
    let environment: BTreeMap<OsString, OsString> = [
        ("HOME".into(), root.path().as_os_str().to_owned()),
        ("KCODER_CONFIG_DIR".into(), config.clone().into_os_string()),
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
    ]
    .into_iter()
    .collect();
    super::write_direct_transport_settings(&config);
    let trust = std::process::Command::new(super::kcoder_binary())
        .env_clear()
        .envs(&environment)
        .args(["trust", "add", "--path"])
        .arg(&workspace)
        .output()
        .unwrap();
    assert!(
        trust.status.success(),
        "cannot prepare isolated trust fixture"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        let mut requests = Vec::new();
        for step in 0..4 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let request = request_body(&mut stream).await;
            let body = request.to_string();
            assert!(!body.contains("session-private-alpha-unique"));
            assert!(!body.contains("session-private-beta-unique"));
            assert!(
                request["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "mcp__host__echo")
            );
            if step % 2 == 1 {
                assert!(body.contains(if step == 1 {
                    "owner=alpha"
                } else {
                    "owner=beta"
                }));
            }
            requests.push(request);
            let delta = if step % 2 == 0 {
                json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("call-{step}"),"type":"function","function":{"name":"mcp__host__echo","arguments":"{}"}}]})
            } else {
                json!({"content":"Fixture finished"})
            };
            let mut response = format!(
                "data: {}\n\n",
                json!({"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]})
            );
            response.push_str(&format!("data: {}\n\ndata: [DONE]\n\n",json!({"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":if step%2==0 {"tool_calls"} else {"stop"}}]})));
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let info = kcoder_acp::AgentInfo {
        version: "test".into(),
        app_server: Some(kcoder_acp::AppServerConfig {
            executable: super::kcoder_binary().into(),
            environment: Some(environment),
            args: [
                "app-server",
                "--training-mode",
                "--provider",
                "local",
                "--model",
                "fixture",
                "--max-retries",
                "0",
                "--local-base-url",
                &format!("http://{address}/v1"),
                "--permission-mode",
                "yolo",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
        }),
    };
    let (client, server) = tokio::io::duplex(65536);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    assert_eq!(receive(&mut lines).await["result"]["protocolVersion"], 1);
    let python = which::which("python3").unwrap();
    let fixture = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("tests/acp/fixtures/session_mcp.py");
    let mut pids = Vec::new();
    for (index, owner) in ["alpha", "beta"].into_iter().enumerate() {
        let directory = root.path().join(owner);
        std::fs::create_dir(&directory).unwrap();
        send(&mut write,json!({"jsonrpc":"2.0","id":index+1,"method":"session/new","params":{"cwd":workspace,"mcpServers":[{"name":"host","command":python,"args":[fixture,directory,owner],"env":[{"name":"TOKEN","value":format!("session-private-{owner}-unique")}]}]}})).await;
        let created = receive(&mut lines).await;
        assert!(created.get("error").is_none(), "{created}");
        let session = created["result"]["sessionId"].as_str().unwrap();
        pids.push(
            std::fs::read_to_string(directory.join("pid"))
                .unwrap()
                .parse::<i32>()
                .unwrap(),
        );
        send(&mut write,json!({"jsonrpc":"2.0","id":index+10,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Run the host echo once"}]}})).await;
        let mut completed = false;
        loop {
            let frame = receive(&mut lines).await;
            assert!(!frame.to_string().contains("session-private-"));
            if frame["id"] == index + 10 {
                assert_eq!(frame["result"]["stopReason"], "end_turn", "{frame}");
                break;
            }
            assert_eq!(frame["params"]["sessionId"], session);
            if frame["params"]["update"]["sessionUpdate"] == "tool_call_update"
                && frame["params"]["update"]["status"] == "completed"
            {
                completed = true;
            }
        }
        assert!(completed);
        assert_eq!(
            std::fs::read_to_string(directory.join("called")).unwrap(),
            owner
        );
    }
    assert_eq!(provider.await.unwrap().len(), 4);
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), adapter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    for pid in pids {
        tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned MCP process outlived ACP EOF");
    }
    assert_no_private_files(root.path());
    let settings = std::fs::read_to_string(config.join("settings.json")).unwrap_or_default();
    assert!(!settings.contains("session_mcp.py"));
    assert!(!settings.contains("mcp__host__echo"));
    owner_guard.disarmed = true;
}

#[tokio::test]
async fn acp_mcp_initialization_is_cancelled_on_disconnect() {
    let root = tempfile::tempdir().unwrap();
    let mut owner_guard = FixtureOwner::new(root.path());
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let directory = root.path().join("hang");
    std::fs::create_dir(&directory).unwrap();
    let first = root.path().join("alpha");
    std::fs::create_dir(&first).unwrap();
    let environment: BTreeMap<OsString, OsString> = [
        ("HOME".into(), root.path().as_os_str().to_owned()),
        (
            "KCODER_CONFIG_DIR".into(),
            root.path().join("config").into_os_string(),
        ),
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
    ]
    .into_iter()
    .collect();
    let trust = std::process::Command::new(super::kcoder_binary())
        .env_clear()
        .envs(&environment)
        .args(["trust", "add", "--path"])
        .arg(&workspace)
        .output()
        .unwrap();
    assert!(trust.status.success());
    let info = kcoder_acp::AgentInfo {
        version: "test".into(),
        app_server: Some(kcoder_acp::AppServerConfig {
            executable: super::kcoder_binary().into(),
            environment: Some(environment),
            args: ["app-server", "--training-mode", "--scenario", "full-turn"]
                .into_iter()
                .map(Into::into)
                .collect(),
        }),
    };
    let (client, server) = tokio::io::duplex(65536);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    receive(&mut lines).await;
    let fixture = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("tests/acp/fixtures/session_mcp.py");
    send(&mut write,json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":workspace,"mcpServers":[{
        "name":"first","command":which::which("python3").unwrap(),"args":[fixture,first,"alpha"],"env":[{"name":"TOKEN","value":"first-private-fixture"}]
    },{
        "name":"hanging","command":which::which("python3").unwrap(),"args":[kcoder_test_harness::workspace_root().expect("resolve current workspace").join("crates/kcoder_cli").join("tests/acp/fixtures/session_mcp.py"),directory,"hang"],"env":[{"name":"TOKEN","value":"private-fixture"}]
    }]}})).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        while !directory.join("pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("MCP fixture was not launched");
    let pid = std::fs::read_to_string(directory.join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), adapter)
        .await
        .expect("MCP handshake blocked disconnect cleanup")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("initializing MCP process was left running");
    let pid = std::fs::read_to_string(first.join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("previously connected MCP process was not rolled back");
    owner_guard.disarmed = true;
}
