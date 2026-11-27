use super::*;
use kcoder_types::{ContentDelta, StreamEvent, ToolDefinition};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_rustls::{TlsAcceptor, rustls};

fn write_request(model: &str) -> MessagesRequest {
    MessagesRequest::new(model, vec![Message::user_text("Write a file")]).with_tools(vec![
        ToolDefinition {
            name: "Write".to_string(),
            description: "Write a file".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "content": {"type": "string"}
                },
                "required": ["file_path", "content"]
            }),
        },
    ])
}

#[test]
fn fine_grained_streaming_requires_the_official_https_origin() {
    for endpoint in [
        "https://api.anthropic.com",
        "https://API.ANTHROPIC.COM/",
        "https://api.anthropic.com:443",
    ] {
        assert!(supports_fine_grained_tool_streaming(endpoint), "{endpoint}");
    }
    for endpoint in [
        "http://api.anthropic.com",
        "https://api.anthropic.com:8443",
        "https://api.anthropic.com.compat.example",
        "https://compat.example/api.anthropic.com",
        "https://api.minimax.io/anthropic",
        "http://127.0.0.1:8000",
        "not a URL",
    ] {
        assert!(
            !supports_fine_grained_tool_streaming(endpoint),
            "{endpoint}"
        );
    }
}

#[test]
fn official_streaming_requests_enable_eager_input_on_user_tools() {
    let request = write_request("claude-sonnet-4-6");
    let body = anthropic_request_body_with_options(&request, Map::new(), false, true).unwrap();
    let payload: Value = serde_json::from_str(&body).unwrap();

    assert_eq!(payload["tools"][0]["eager_input_streaming"], true);
    assert_eq!(
        payload["tools"][0]["input_schema"],
        request.tools[0].input_schema
    );
    assert_eq!(payload["stream"], true);
    assert!(payload.get("eager_input_streaming").is_none());
    assert!(payload.get("tool_choice").is_none());
}

#[test]
fn fine_grained_streaming_preserves_explicit_tools_and_stream_overrides() {
    let request = write_request("claude-sonnet-4-6");
    let tools = serde_json::json!([
        {"name": "Write", "input_schema": {"type": "object"}, "eager_input_streaming": false},
        {"name": "Read", "input_schema": {"type": "object"}},
        {"type": "computer_20251124", "name": "computer", "display_width_px": 1280, "display_height_px": 720}
    ]);
    let extra = serde_json::json!({"tools": tools});
    let payload: Value = serde_json::from_str(
        &anthropic_request_body_with_options(
            &request,
            extra.as_object().unwrap().clone(),
            false,
            true,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["tools"], tools);

    for extra in [
        Map::new(),
        serde_json::json!({"stream": false})
            .as_object()
            .unwrap()
            .clone(),
    ] {
        let mut request = request.clone();
        if extra.is_empty() {
            request.stream = false;
        }
        let payload: Value = serde_json::from_str(
            &anthropic_request_body_with_options(&request, extra, false, true).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["stream"], false);
        assert!(payload["tools"][0].get("eager_input_streaming").is_none());
    }
}

#[test]
fn fine_grained_streaming_skips_native_tools_and_keeps_explicit_false() {
    let mut payload = serde_json::json!({"tools": [
        {"name": "Write", "input_schema": {"type": "object"}, "eager_input_streaming": false},
        {"type": "custom", "name": "Read", "input_schema": {"type": "object"}},
        {"type": "computer_20251124", "name": "computer", "input_schema": {"type": "object"}},
        {"type": "browser_20260617", "name": "browser"},
        {"type": "toolset_reference", "toolset_id": "fixture"}
    ]});
    let original = payload.clone();
    enable_fine_grained_tool_streaming(&mut payload);
    assert_eq!(payload["tools"][0], original["tools"][0]);
    assert_eq!(payload["tools"][1]["eager_input_streaming"], true);
    for index in 2..5 {
        assert_eq!(payload["tools"][index], original["tools"][index]);
    }
}

async fn read_http_request(socket: &mut (impl AsyncRead + Unpin)) -> (String, Value) {
    let mut bytes = Vec::new();
    loop {
        assert!(bytes.len() < 65_536, "bounded fixture request");
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0, "connection closed before the complete request");
        bytes.extend_from_slice(&chunk[..count]);
        let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .expect("request must declare its length");
        assert!(end + 4 + length < 65_536);
        if bytes.len() >= end + 4 + length {
            assert_eq!(bytes.len(), end + 4 + length);
            return (
                headers.to_string(),
                serde_json::from_slice(&bytes[end + 4..]).unwrap(),
            );
        }
    }
}

fn sse(event: &str, payload: Value) -> String {
    format!("event: {event}\ndata: {payload}\n\n")
}

async fn loopback_provider(
    hostname: &str,
) -> (tokio::net::TcpListener, TlsAcceptor, AnthropicProvider) {
    // These public synthetic self-signed assets are not service credentials.
    // Trust is restricted to this client, without changing the system trust store.
    let certificate = include_bytes!("fixtures/loopback-cert.der");
    let private_key = include_bytes!("fixtures/loopback-key.der");
    let tls = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![rustls::pki_types::CertificateDer::from(
            certificate.to_vec(),
        )],
        rustls::pki_types::PrivateKeyDer::try_from(private_key.to_vec()).unwrap(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut provider = AnthropicProvider::new("fixture-only")
        .unwrap()
        .with_base_url(format!("https://{hostname}"));
    provider.client = reqwest::Client::builder()
        .http1_only()
        .no_proxy()
        .resolve(hostname, address)
        .add_root_certificate(reqwest::Certificate::from_der(certificate).unwrap())
        .build()
        .unwrap();
    (
        listener,
        TlsAcceptor::from(std::sync::Arc::new(tls)),
        provider,
    )
}

#[tokio::test]
async fn native_provider_sends_eager_input_and_delivers_a_fragment_before_block_stop() {
    // DNS is pinned to loopback; the test never contacts the real Claude API.
    let (listener, acceptor, provider) = loopback_provider("api.anthropic.com").await;
    let first_fragment = "{\"file_path\":\"fixture.txt\",\"content\":\"one\\n";
    let second_fragment = "two\"}";
    let prefix = sse(
        "content_block_start",
        serde_json::json!({
            "type": "content_block_start", "index": 0,
            "content_block": {"type": "tool_use", "id": "fixture-call", "name": "Write", "input": {}}
        }),
    ) + &sse(
        "content_block_delta",
        serde_json::json!({
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": first_fragment}
        }),
    );
    let suffix = sse(
        "content_block_delta",
        serde_json::json!({
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": second_fragment}
        }),
    ) + &sse(
        "content_block_stop",
        serde_json::json!({"type": "content_block_stop", "index": 0}),
    ) + &sse("message_stop", serde_json::json!({"type": "message_stop"}));
    let (fragment_seen, wait_for_fragment) = tokio::sync::oneshot::channel();
    let server = async {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = acceptor.accept(socket).await.unwrap();
        let (headers, payload) = read_http_request(&mut socket).await;
        assert!(headers.starts_with("POST /v1/messages HTTP/1.1\r\n"));
        assert!(!headers.to_ascii_lowercase().contains("anthropic-beta:"));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("anthropic-version: 2023-06-01")
        );
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-slime-agent-depth: 3")
        );
        assert_eq!(payload["tools"][0]["eager_input_streaming"], true);
        assert!(payload.get("trajectory_agent_depth").is_none());
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{prefix}",
            prefix.len() + suffix.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.flush().await.unwrap();
        wait_for_fragment
            .await
            .expect("first fragment was not delivered");
        socket.write_all(suffix.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    };
    let client = async {
        let mut stream = provider
            .stream_messages(write_request("claude-sonnet-4-6").with_trajectory_agent_depth(3))
            .unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamEvent::ContentBlockStart { .. }
        ));
        let StreamEvent::ContentBlockDelta {
            delta: ContentDelta::InputJsonDelta { partial_json },
            ..
        } = stream.next().await.unwrap().unwrap()
        else {
            panic!("first input fragment was not delivered");
        };
        assert_eq!(partial_json, first_fragment);
        assert!(serde_json::from_str::<Value>(&partial_json).is_err());
        fragment_seen.send(()).unwrap();
        let StreamEvent::ContentBlockDelta {
            delta:
                ContentDelta::InputJsonDelta {
                    partial_json: second,
                },
            ..
        } = stream.next().await.unwrap().unwrap()
        else {
            panic!("second input fragment was not delivered");
        };
        assert_eq!(second, second_fragment);
        assert_eq!(
            serde_json::from_str::<Value>(&(partial_json + &second)).unwrap(),
            serde_json::json!({
                "file_path": "fixture.txt", "content": "one\ntwo"
            })
        );
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamEvent::ContentBlockStop { index: 0 }
        ));
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamEvent::MessageStop
        ));
        assert!(stream.next().await.is_none());
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(server, client);
    })
    .await
    .expect("isolated eager-input SSE probe exceeded its deadline");
}

#[tokio::test]
async fn native_provider_leaves_compatible_tools_unchanged_even_for_claude_model_names() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for model in ["DeepSeek-V4.1-Flash", "MiniMax-M3", "claude-sonnet-4-6"] {
            let (listener, acceptor, provider) = loopback_provider("compat.example").await;
            let request = write_request(model);
            let expected_tools = serde_json::to_value(&request.tools).unwrap();
            let server = async {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = acceptor.accept(socket).await.unwrap();
                let (headers, payload) = read_http_request(&mut socket).await;
                assert_eq!(payload["tools"], expected_tools);
                assert!(!headers.to_ascii_lowercase().contains("anthropic-beta:"));
                let body = sse("message_stop", serde_json::json!({"type": "message_stop"}));
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            };
            let client = async {
                let mut stream = provider.stream_messages(request).unwrap();
                assert!(matches!(stream.next().await.unwrap().unwrap(), StreamEvent::MessageStop));
                assert!(stream.next().await.is_none());
            };
            tokio::join!(server, client);
        }
    })
    .await
    .expect("isolated compatible-endpoint SSE probe exceeded its deadline");
}
