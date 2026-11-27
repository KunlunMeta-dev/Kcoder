//! Controlled real HTTP peers exercise activation categories without accounts.
use kcoder_mcp::{McpServerConfig, failure::failure_reason};
use kcoder_types::mcp_failure::McpFailureReason as Reason;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn peer(mode: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let steps = if mode == "zero" { 3 } else { 1 };
        for _ in 0..steps {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break bytes[end + 4..end + 4 + length].to_vec();
                    }
                }
            };
            if mode == "disconnect" {
                return;
            }
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let (status, payload) = match mode {
                "unauthorized" => ("401 Unauthorized", "private-response-marker".into()),
                "rejected" => ("200 OK", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32602,"message":"private-response-marker"}}).to_string()),
                "version" => ("200 OK", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"1999-01-01","capabilities":{},"serverInfo":{"name":"private-response-marker","version":"0"}}}).to_string()),
                "malformed" => ("200 OK", "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}".into()),
                "zero" if request["method"] == "initialize" => ("200 OK", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}}}).to_string()),
                "zero" if request["method"] == "tools/list" => ("200 OK", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"tools":[]}}).to_string()),
                _ => ("202 Accepted", String::new()),
            };
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",payload.len()).as_bytes()).await.unwrap();
        }
    });
    (url, task)
}

#[tokio::test]
async fn real_peers_classify_rejection_authorization_disconnect_and_zero_tools() {
    for (mode, expected) in [
        ("unauthorized", Some(Reason::AuthorizationRequired)),
        ("rejected", Some(Reason::ProtocolFailed)),
        ("version", Some(Reason::ProtocolFailed)),
        ("malformed", Some(Reason::ProtocolFailed)),
        ("disconnect", Some(Reason::ConnectionFailed)),
        ("zero", None),
    ] {
        for private in [false, true] {
            let (url, task) = peer(mode).await;
            let config: McpServerConfig = serde_json::from_value(
                serde_json::json!({"name":"fixture","transport":"http","url":url}),
            )
            .unwrap();
            let values = kcoder_mcp::tool::PrivateValues::new(if private {
                vec!["private-response-marker".into()]
            } else {
                vec![]
            })
            .unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                kcoder_mcp::connect_server_with_private_values(&config, None, values),
            )
            .await
            .unwrap();
            match expected {
                Some(expected) => {
                    let error = result.err().unwrap();
                    assert_eq!(
                        failure_reason(&error),
                        expected,
                        "mode={mode} private={private}"
                    );
                    assert!(!format!("{error:?} {error:#}").contains("private-response-marker"));
                    assert!(!format!("{error:?} {error:#}").contains(&url));
                }
                None => assert!(result.unwrap().1.is_empty()),
            }
            task.await.unwrap();
        }
    }
}
