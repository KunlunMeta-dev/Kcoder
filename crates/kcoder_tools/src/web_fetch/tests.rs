use super::*;
use crate::web_network::WebNetworkAuthority;
use std::sync::{
    Arc, RwLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn context(url: &str) -> ToolContext {
    context_at(url, std::path::Path::new("."))
}
fn context_at(url: &str, root: &std::path::Path) -> ToolContext {
    let ctx = ToolContext::new(kcoder_state::AppState::new(root));
    let authority = WebNetworkAuthority::new(&ctx.state);
    authority
        .grant_origin(url, Duration::from_secs(60))
        .unwrap();
    let mut settings = kcoder_config::Settings::default();
    settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
    ctx.with_web_network_authority(authority)
        .with_runtime_settings(Arc::new(RwLock::new(settings)))
}
fn text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|b| match b {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_optional_prompt_and_url_anchor_read_only_the_requested_section() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let ctx = context(&origin);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 2048];
        let n = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..n]);
        assert!(request.starts_with("GET /doc HTTP/1.1"));
        assert!(!request.contains("#cancel"));
        let html = "<main><section id=intro>NO_OTHER_SECTION</section><section id=cancel><h2>Cancellation</h2><p>Propagates to the awaited future.</p></section></main>";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",html.len()).as_bytes()).await.unwrap();
    });
    let url = format!("{origin}/doc#cancel");
    let output = WebFetchTool
        .call(serde_json::json!({"url":url}), &ctx)
        .await
        .unwrap();
    let content = text(&output);
    assert!(!output.is_error);
    assert!(content.contains("Requested HTML section"));
    assert!(content.contains("Propagates to the awaited future"));
    assert!(!content.contains("NO_OTHER_SECTION"));
    let cached = read_page(&url, false, &ctx).await.unwrap();
    assert!(cached.cached);
    assert!(!cached.page.content.markdown.contains("NO_OTHER_SECTION"));
    server.await.unwrap();
}

#[tokio::test]
async fn profile_page_gate_holds_through_body_and_cancelled_waiter_sends_nothing() {
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let ctx = context_at(&url, root.path())
        .with_settings_persistence_path(Some(root.path().join("settings.json")));
    let mut peers = Vec::new();
    let mut sockets = Vec::new();
    for _ in 0..4 {
        let ctx = ctx.clone();
        let url = url.clone();
        peers.push(tokio::spawn(
            async move { read_page(&url, true, &ctx).await },
        ));
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = [0; 2048];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\n").await.unwrap();
        sockets.push(socket);
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    let pending = tokio::spawn({
        let ctx = ctx.clone().with_abort_token(cancel.clone());
        let url = url.clone();
        async move { read_page(&url, true, &ctx).await }
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    cancel.cancel();
    assert!(matches!(pending.await.unwrap(), Err(ToolError::Aborted)));
    for socket in &mut sockets {
        socket.write_all(b"peer").await.unwrap();
    }
    for peer in peers {
        assert_eq!(peer.await.unwrap().unwrap().page.content.markdown, "peer");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn private_destination_requires_real_host_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let ctx = ToolContext::new(kcoder_state::AppState::new("."));
    assert!(
        WebFetchTool
            .call(
                serde_json::json!({"url":url,"prompt":"read","allow_private":true}),
                &ctx
            )
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn follows_same_origin_but_does_not_send_cross_origin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let peer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peeraddr = peer.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 2048];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{peeraddr}/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    });
    let url = format!("http://{addr}");
    let ctx = context(&url);
    let output = WebFetchTool
        .call(serde_json::json!({"url":url,"prompt":"read"}), &ctx)
        .await
        .unwrap();
    assert!(output.is_error);
    assert!(text(&output).contains("REDIRECT DETECTED"));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), peer.accept())
            .await
            .is_err()
    );
    server.await.unwrap();
}
#[tokio::test]
async fn cache_freshness_revocation_and_peer_isolation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0; 2048];
            assert!(socket.read(&mut buf).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 18\r\nConnection: close\r\n\r\n<h1>Local doc</h1>").await.unwrap();
        }
    });
    let ctx = context(&url);
    let first = read_page(&url, false, &ctx).await.unwrap();
    assert!(!first.cached);
    let second = read_page(&url, false, &ctx).await.unwrap();
    assert!(second.cached);
    assert_eq!(first.page.retrieved_at, second.page.retrieved_at);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    read_page(&url, true, &ctx).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    let peer = context(&url);
    read_page(&url, false, &peer).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 3);
    ctx.web_network_authority.as_ref().unwrap().revoke();
    assert!(read_page(&url, false, &ctx).await.is_err());
    assert!(read_page(&url, false, &peer).await.unwrap().cached);
    server.abort();
    let _ = server.await;
}
#[test]
fn decoded_compression_is_also_bounded() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder
        .write_all(&vec![b'a'; MAX_HTTP_CONTENT_BYTES + 1])
        .unwrap();
    let compressed = encoder.finish().unwrap();
    assert!(compressed.len() < MAX_HTTP_CONTENT_BYTES);
    assert!(decode_compression(compressed, "gzip").is_err());
    assert!(decode_compression(vec![0, 1, 2], "gzip").is_err());
    assert_eq!(
        decode_compression(b"text".to_vec(), "identity").unwrap(),
        b"text"
    );
}
#[tokio::test]
async fn cancellation_drops_only_the_owning_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (mut ctx, peer) = (context(&url), context(&url));
    let token = tokio_util::sync::CancellationToken::new();
    ctx.abort_token = Some(token.clone());
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 2048];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        seen_tx.send(()).unwrap();
        let (mut peer, _) = listener.accept().await.unwrap();
        assert!(peer.read(&mut buf).await.unwrap() > 0);
        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\npeer").await.unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let request_url = url.clone();
    let cancelled = tokio::spawn(async move { read_page(&request_url, false, &ctx).await });
    seen_rx.await.unwrap();
    token.cancel();
    assert!(cancelled.await.unwrap().is_err());
    assert_eq!(
        read_page(&url, false, &peer)
            .await
            .unwrap()
            .page
            .content
            .markdown,
        "peer"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn revoked_host_dispatch_check_sends_no_request_after_preparation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let ctx = context(&url).with_web_dispatch_check(Arc::new(|| {
        Err(ToolError::Execution("owned dispatch revoked".into()))
    }));
    let error = read_page(&url, true, &ctx)
        .await
        .err()
        .expect("revocation must prevent dispatch");
    assert!(error.to_string().contains("owned dispatch revoked"));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn source_receipt_marks_partial_when_the_model_output_is_truncated() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        let body = "Owned source fact. ".repeat(100);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    let mut ctx = context_at(&url, root.path())
        .with_output_limits(1024, 800, 128)
        .with_tool_call_id("partial-source-call");
    let input = serde_json::json!({"url":url,"prompt":"read source"});
    let tool: Arc<dyn Tool> = Arc::new(WebFetchTool);
    ctx = ctx.with_native_tool_invocation(&tool, &input).unwrap();
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: ctx.state.session_id(),
        turn_id: "partial-source-turn".into(),
        attempt_id: "partial-source-attempt".into(),
    };
    ctx.state
        .history_attempt_scope(identity)
        .unwrap()
        .run(async {
            // Rebind after entering the real attempt; receipts cannot borrow a
            // history identity installed after their native dispatch was minted.
            let ctx = ctx
                .clone()
                .with_native_tool_invocation(&tool, &input)
                .unwrap();
            let output = tool.call(input, &ctx).await.unwrap();
            assert!(text(&output).contains("Truncated: true"));
            let sources = output
                .execution_metadata
                .iter()
                .find_map(|m| match m {
                    crate::ToolExecutionMetadata::WebSources(sources) => Some(sources),
                    _ => None,
                })
                .unwrap();
            assert_eq!(sources.sources[0].read_status, WebSourceReadStatus::Partial);
        })
        .await;
    server.await.unwrap();
}
