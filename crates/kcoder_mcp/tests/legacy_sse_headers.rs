use kcoder_mcp::McpServerConfig;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Task(tokio::task::JoinHandle<()>);
impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn request(socket: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return (head, bytes[end + 4..end + 4 + length].to_vec());
            }
        }
    }
}

#[tokio::test]
async fn legacy_sse_configuration_headers_reach_get_and_every_post() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let _task = Task(tokio::spawn(async move {
        let (mut get, _) = listener.accept().await.unwrap();
        let head = request(&mut get).await.0;
        recorded.lock().unwrap().push(head);
        get.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: endpoint\ndata: /messages\n\n").await.unwrap();
        for _ in 0..3 {
            let (mut post, _) = listener.accept().await.unwrap();
            let (head, body) = request(&mut post).await;
            recorded.lock().unwrap().push(head);
            let input: Value = serde_json::from_slice(&body).unwrap();
            post.write_all(
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let result = match input["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}})
                }
                "tools/list" => json!({"tools":[]}),
                _ => continue,
            };
            let response = json!({"jsonrpc":"2.0","id":input["id"],"result":result});
            get.write_all(format!("event: message\ndata: {response}\n\n").as_bytes())
                .await
                .unwrap();
        }
        std::future::pending::<()>().await;
    }));
    let config: McpServerConfig = serde_json::from_value(json!({
        "name":"fixture", "transport":"sse", "url":url,
        "headers": {"Authorization":"Bearer synthetic-secret", "X-Fixture-Credential":"owned-value"}
    }))
    .unwrap();
    let _connected =
        tokio::time::timeout(Duration::from_secs(3), kcoder_mcp::connect_server(&config))
            .await
            .unwrap()
            .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 4);
    for head in seen.iter() {
        let head = head.to_ascii_lowercase();
        assert!(head.contains("authorization: bearer synthetic-secret"));
        assert!(head.contains("x-fixture-credential: owned-value"));
    }
}

#[tokio::test]
async fn legacy_sse_rejects_foreign_post_endpoint_before_forwarding_credentials() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let _task = Task(tokio::spawn(async move {
        let (mut get, _) = listener.accept().await.unwrap();
        request(&mut get).await;
        get.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: endpoint\ndata: http://127.0.0.1:1/foreign\n\n").await.unwrap();
        std::future::pending::<()>().await;
    }));
    let result = kcoder_mcp::SseTransport::new(&url).await;
    assert!(
        result.is_err(),
        "A POST endpoint may not change the configured origin"
    );
}

#[tokio::test]
async fn legacy_sse_does_not_follow_redirects() {
    let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination_url = format!("http://{}/foreign", destination.local_addr().unwrap());
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let received = count.clone();
    let _destination = Task(tokio::spawn(async move {
        let (mut socket, _) = destination.accept().await.unwrap();
        received.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let _task = Task(tokio::spawn(async move {
        let (mut get, _) = listener.accept().await.unwrap();
        request(&mut get).await;
        get.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {destination_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    }));
    let error = kcoder_mcp::SseTransport::new(&url).await.err().unwrap();
    assert_eq!(
        kcoder_mcp::failure::failure_reason(&error),
        kcoder_types::mcp_failure::McpFailureReason::ProtocolFailed
    );
    assert!(!error.to_string().contains(&url));
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn legacy_sse_post_redirect_never_forwards_headers_or_request_body() {
    let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination_url = format!("http://{}/foreign", destination.local_addr().unwrap());
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let received = count.clone();
    let _destination = Task(tokio::spawn(async move {
        let (mut socket, _) = destination.accept().await.unwrap();
        received.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/sse", listener.local_addr().unwrap());
    let _source = Task(tokio::spawn(async move {
        let (mut get, _) = listener.accept().await.unwrap();
        request(&mut get).await;
        get.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: endpoint\ndata: /messages\n\n").await.unwrap();
        let (mut post, _) = listener.accept().await.unwrap();
        let (head, _) = request(&mut post).await;
        assert!(
            head.to_ascii_lowercase()
                .contains("authorization: bearer synthetic-secret")
        );
        post.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {destination_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        std::future::pending::<()>().await;
    }));
    let config: McpServerConfig = serde_json::from_value(json!({"name":"fixture", "transport":"sse", "url":url, "headers":{"Authorization":"Bearer synthetic-secret"}})).unwrap();
    let error = kcoder_mcp::connect_server(&config).await.err().unwrap();
    assert_eq!(
        kcoder_mcp::failure::failure_reason(&error),
        kcoder_types::mcp_failure::McpFailureReason::ProtocolFailed
    );
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(!format!("{error:?} {error:#}").contains("synthetic-secret"));
}

#[tokio::test]
async fn legacy_sse_invalid_header_diagnostics_omit_secret_values_and_url() {
    let url = "http://127.0.0.1:1/synthetic-private-url";
    let headers = std::collections::HashMap::from([(
        "Authorization".into(),
        "synthetic-private-secret\n".into(),
    )]);
    let error = kcoder_mcp::SseTransport::with_headers(url, &headers)
        .await
        .err()
        .unwrap();
    let diagnostic = format!("{error:?} {error:#}");
    assert!(!diagnostic.contains("synthetic-private-secret"));
    assert!(!diagnostic.contains("synthetic-private-url"));
}
