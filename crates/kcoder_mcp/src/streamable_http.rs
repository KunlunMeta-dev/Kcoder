//! Streamable HTTP transport, the single-endpoint transport introduced in MCP 2025-03-26.
//!
//! Every client message is POSTed to one configured URL, with `Accept` advertising
//! both `application/json` and `text/event-stream`. The server may return one JSON
//! response, upgrade to an SSE stream, or acknowledge a notification with
//! `202 Accepted`. An `Mcp-Session-Id` assigned by the initialize response is echoed
//! on later requests, and `MCP-Protocol-Version` communicates the negotiated version.
//!
//! Optional capabilities not yet implemented: a standalone GET push stream because
//! the client does not consume unsolicited server messages, DELETE session termination
//! because the composition layer has no shutdown path, and Last-Event-ID reconnection.

use crate::sse::{SSE_MESSAGE_QUEUE_CAPACITY, SseParser, drain_sse_stream, enqueue_sse_message};
use crate::transport::McpTransport;
use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::HashMap;
use tracing::debug;

/// Protocol versions negotiable by this transport; the first is offered during initialize.
const STREAMABLE_HTTP_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// The oldest protocol version has no `MCP-Protocol-Version` header, so it is not echoed when negotiated.
const LEGACY_PROTOCOL_VERSION: &str = "2024-11-05";

/// Limit for waiting on response headers after POST. The body may be a long SSE
/// stream and has no total timeout; the client's 60-second request wait remains the fallback.
const POST_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A server authentication challenge retained for explicit authorization discovery.
#[derive(Clone)]
pub struct AuthenticationRequired {
    resource_url: reqwest::Url,
    challenges: Vec<String>,
}

impl AuthenticationRequired {
    pub fn resource_url(&self) -> &reqwest::Url {
        &self.resource_url
    }

    pub fn challenges(&self) -> &[String] {
        &self.challenges
    }

    pub fn metadata_url(&self) -> Result<Option<reqwest::Url>> {
        crate::authorization::metadata_url_from_challenges(&self.challenges)
    }
}

impl std::fmt::Display for AuthenticationRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MCP server requires authentication (HTTP 401)")
    }
}

impl std::fmt::Debug for AuthenticationRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthenticationRequired")
            .finish_non_exhaustive()
    }
}

impl std::error::Error for AuthenticationRequired {}

/// Streamable HTTP transport for an MCP server.
pub struct StreamableHttpTransport {
    client: reqwest::Client,
    url: reqwest::Url,
    headers: reqwest::header::HeaderMap,
    session_id: Option<String>,
    protocol_version: Option<String>,
    /// Failure reason after the server declares a session terminated with 404; all later I/O is rejected.
    failed: Option<String>,
    sender: tokio::sync::mpsc::Sender<String>,
    receiver: tokio::sync::mpsc::Receiver<String>,
    readers: Vec<tokio::task::JoinHandle<()>>,
}

impl StreamableHttpTransport {
    pub async fn new(url: &str, headers: &HashMap<String, String>) -> Result<Self> {
        // Limit only TCP/TLS connection establishment; a POST body may be a long SSE stream and cannot have a total timeout.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .context("failed to build MCP Streamable HTTP client")?;
        let url: reqwest::Url = url.parse().context("invalid MCP Streamable HTTP URL")?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (name, value) in headers {
            let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .with_context(|| format!("invalid MCP header name: {}", name))?;
            // Error messages include header names only, never values, to keep secrets out of logs.
            let header_value = reqwest::header::HeaderValue::from_str(value)
                .with_context(|| format!("invalid value for MCP header: {}", name))?;
            header_map.insert(header_name, header_value);
        }

        let (sender, receiver) = tokio::sync::mpsc::channel(SSE_MESSAGE_QUEUE_CAPACITY);
        Ok(Self {
            client,
            url,
            headers: header_map,
            session_id: None,
            protocol_version: None,
            failed: None,
            sender,
            receiver,
            readers: Vec::new(),
        })
    }
}

impl StreamableHttpTransport {
    pub(crate) async fn send_with_bearer(&mut self, line: &str, token: &str) -> Result<()> {
        self.send_request(line, Some(token)).await
    }

    async fn send_request(&mut self, line: &str, token: Option<&str>) -> Result<()> {
        if let Some(reason) = &self.failed {
            anyhow::bail!("MCP Streamable HTTP session is closed: {}", reason);
        }

        let mut request = self
            .client
            .post(self.url.clone())
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .headers(self.headers.clone());
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(session_id) = &self.session_id {
            request = request.header("mcp-session-id", session_id);
        }
        if let Some(version) = &self.protocol_version
            && version != LEGACY_PROTOCOL_VERSION
        {
            request = request.header("mcp-protocol-version", version);
        }

        let response =
            tokio::time::timeout(POST_HEADER_TIMEOUT, request.body(line.to_string()).send())
                .await
                .map_err(|_| {
                    anyhow!(
                        "MCP Streamable HTTP endpoint did not respond within {}s",
                        POST_HEADER_TIMEOUT.as_secs()
                    )
                })?
                .map_err(|error| {
                    anyhow!("failed to POST to MCP endpoint: {}", error.without_url())
                })?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let challenges = response
                .headers()
                .get_all(reqwest::header::WWW_AUTHENTICATE)
                .iter()
                .filter_map(|value| value.to_str().ok().map(str::to_owned))
                .collect();
            return Err(AuthenticationRequired {
                resource_url: self.url.clone(),
                challenges,
            }
            .into());
        }

        // Any response may assign or rotate the session ID.
        if let Some(value) = response.headers().get("mcp-session-id")
            && let Ok(id) = value.to_str()
        {
            debug!("MCP server assigned session id");
            self.session_id = Some(id.to_string());
        }

        let status = response.status();
        // Bodyless acknowledgement for a notification or response message.
        if status == reqwest::StatusCode::ACCEPTED {
            return Ok(());
        }
        // A request carrying a session ID received 404, so the server terminated the session.
        if status == reqwest::StatusCode::NOT_FOUND && self.session_id.is_some() {
            let reason = "session expired (404)".to_string();
            self.failed = Some(reason.clone());
            anyhow::bail!("MCP Streamable HTTP {}", reason);
        }
        if !status.is_success() {
            // Error bodies and URLs may reflect credentials supplied by the client.
            anyhow::bail!(
                "MCP Streamable HTTP endpoint returned HTTP {}",
                status.as_u16()
            );
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if content_type.starts_with("text/event-stream") {
            // Consume the event stream in the background; the client's 60-second request wait is the fallback.
            self.readers.retain(|task| !task.is_finished());
            if self.readers.len() >= 128 {
                anyhow::bail!("MCP response stream limit reached");
            }
            self.readers.push(tokio::spawn(drain_sse_stream(
                response.bytes_stream(),
                Vec::new(),
                SseParser::default(),
                self.sender.clone(),
            )));
            Ok(())
        } else if content_type.starts_with("application/json") {
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    anyhow!(
                        "failed to read MCP JSON response body: {}",
                        error.without_url()
                    )
                })?;
                if body.len().saturating_add(chunk.len()) > crate::sse::MAX_MCP_FRAME_BYTES {
                    anyhow::bail!("MCP JSON frame exceeds 16 MiB limit");
                }
                body.extend_from_slice(&chunk);
            }
            let body = String::from_utf8(body).context("invalid UTF-8 MCP JSON response")?;
            let body = body.trim();
            if !body.is_empty() {
                enqueue_sse_message(&self.sender, body.to_string());
            }
            Ok(())
        } else {
            anyhow::bail!("MCP Streamable HTTP endpoint returned an unsupported content type");
        }
    }
}

impl Drop for StreamableHttpTransport {
    fn drop(&mut self) {
        for reader in &self.readers {
            reader.abort();
        }
    }
}

#[async_trait]
impl McpTransport for StreamableHttpTransport {
    async fn send(&mut self, line: &str) -> Result<()> {
        self.send_request(line, None).await
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        if let Some(reason) = &self.failed {
            return Err(anyhow!("MCP Streamable HTTP session is closed: {}", reason));
        }
        let message = self.receiver.recv().await;
        if message.as_deref() == Some(crate::sse::FRAME_LIMIT_ERROR) {
            anyhow::bail!("MCP SSE frame exceeds 16 MiB limit");
        }
        Ok(message)
    }

    fn supported_protocol_versions(&self) -> &'static [&'static str] {
        STREAMABLE_HTTP_PROTOCOL_VERSIONS
    }

    fn set_negotiated_protocol_version(&mut self, version: String) {
        self.protocol_version = Some(version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_transport_aborts_owned_stream_reader() {
        struct Guard(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let (dropped, done) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            let _guard = Guard(Some(dropped));
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        let (sender, receiver) = tokio::sync::mpsc::channel(1);

        let transport = StreamableHttpTransport {
            client: reqwest::Client::new(),
            receiver,
            url: "http://127.0.0.1/mcp".parse().unwrap(),
            headers: reqwest::header::HeaderMap::new(),
            session_id: None,
            protocol_version: None,
            failed: None,
            sender,
            readers: vec![reader],
        };
        drop(transport);
        tokio::time::timeout(std::time::Duration::from_secs(1), done)
            .await
            .unwrap()
            .unwrap();
    }

    use crate::client::McpClient;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn unauthorized_response_preserves_discovery_without_logging_credentials() {
        let challenge = "Bearer resource_metadata=\"https://example.invalid/.well-known/oauth-protected-resource\"";
        let server = start_mock(vec![MockResponse {
            status: 401,
            headers: vec![
                ("www-authenticate", challenge.to_string()),
                ("content-type", "text/plain".into()),
            ],
            body: "server echoed confidential-token".into(),
        }])
        .await;
        let url = format!("{}?api_key=confidential-token", server.url);
        let transport = StreamableHttpTransport::new(&url, &HashMap::new())
            .await
            .unwrap();
        let mut client = McpClient::with_transport(Box::new(transport));
        let error = client.initialize().await.unwrap_err();
        let auth = error
            .downcast_ref::<AuthenticationRequired>()
            .expect("typed authentication challenge");
        assert_eq!(auth.resource_url().as_str(), url);
        assert_eq!(auth.challenges(), &[challenge]);
        assert_eq!(
            auth.metadata_url().unwrap().unwrap().as_str(),
            "https://example.invalid/.well-known/oauth-protected-resource"
        );
        for displayed in [
            format!("{error:#}"),
            format!("{error:?}"),
            format!("{auth:?}"),
        ] {
            assert!(!displayed.contains("confidential-token"));
            assert!(!displayed.contains("resource_metadata"));
        }
    }

    /// Minimal HTTP/1.1 mock that handles one request per connection, replays scripted
    /// responses in order, and records requests for assertions. It implements only the
    /// semantics needed by tests, not a complete HTTP parser.
    struct MockHttpServer {
        url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        _handle: tokio::task::JoinHandle<()>,
    }

    struct RecordedRequest {
        headers: Vec<(String, String)>,
        body: String,
    }

    impl RecordedRequest {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(header, _)| header == name)
                .map(|(_, value)| value.as_str())
        }
    }

    struct MockResponse {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: String,
    }

    impl MockResponse {
        fn json(status: u16, body: serde_json::Value) -> Self {
            Self {
                status,
                headers: vec![("content-type", "application/json".to_string())],
                body: body.to_string(),
            }
        }

        fn initialize_result(version: &str) -> Self {
            Self::json(
                200,
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "protocolVersion": version,
                        "capabilities": {},
                        "serverInfo": { "name": "mock", "version": "0.1" }
                    }
                }),
            )
        }
    }

    async fn start_mock(responses: Vec<MockResponse>) -> MockHttpServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock server 绑定失败");
        let addr = listener.local_addr().expect("mock server 无本地地址");
        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let responses = Arc::new(Mutex::new(
            responses
                .into_iter()
                .collect::<std::collections::VecDeque<_>>(),
        ));

        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let recorded = Arc::clone(&recorded);
                let responses = Arc::clone(&responses);
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..n]);
                        if let Some(pos) = find_subslice(&buffer, b"\r\n\r\n") {
                            break pos + 4;
                        }
                    };

                    let header_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
                    let mut content_length = 0usize;
                    let mut headers = Vec::new();
                    for line in header_text.split("\r\n").skip(1) {
                        if line.is_empty() {
                            continue;
                        }
                        if let Some((name, value)) = line.split_once(':') {
                            let name = name.trim().to_ascii_lowercase();
                            let value = value.trim().to_string();
                            if name == "content-length" {
                                content_length = value.parse().unwrap_or(0);
                            }
                            headers.push((name, value));
                        }
                    }
                    while buffer.len() - header_end < content_length {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..n]);
                    }
                    let body =
                        String::from_utf8_lossy(&buffer[header_end..header_end + content_length])
                            .into_owned();
                    recorded
                        .lock()
                        .expect("请求记录锁")
                        .push(RecordedRequest { headers, body });

                    let response =
                        responses
                            .lock()
                            .expect("响应脚本锁")
                            .pop_front()
                            .unwrap_or(MockResponse {
                                status: 500,
                                headers: vec![],
                                body: "no scripted response".to_string(),
                            });
                    let mut reply = format!("HTTP/1.1 {} STATUS\r\n", response.status);
                    let mut has_length = false;
                    for (name, value) in &response.headers {
                        reply.push_str(&format!("{}: {}\r\n", name, value));
                        if name.eq_ignore_ascii_case("content-length") {
                            has_length = true;
                        }
                    }
                    if !has_length {
                        reply.push_str(&format!("content-length: {}\r\n", response.body.len()));
                    }
                    reply.push_str("connection: close\r\n\r\n");
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.write_all(response.body.as_bytes()).await;
                });
            }
        });

        MockHttpServer {
            url: format!("http://{}/mcp", addr),
            requests,
            _handle: handle,
        }
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    #[tokio::test]
    async fn initialize_json_list_and_session_id_roundtrip() {
        let server = start_mock(vec![
            {
                let mut response = MockResponse::initialize_result("2025-06-18");
                response
                    .headers
                    .push(("mcp-session-id", "s-123".to_string()));
                response
            },
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
            MockResponse::json(
                200,
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": { "tools": [ { "name": "echo", "description": "d", "inputSchema": {} } ] }
                }),
            ),
        ])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        let info = client.initialize().await.expect("initialize 失败");
        assert_eq!(info.server_info.name, "mock");
        let tools = client.list_tools().await.expect("tools/list 失败");
        assert_eq!(tools[0].name, "echo");

        let requests = server.requests.lock().expect("请求记录锁");
        assert_eq!(requests.len(), 3, "initialize + notification + tools/list");
        // Accept must advertise both media types.
        assert_eq!(
            requests[0].header("accept"),
            Some("application/json, text/event-stream")
        );
        // Initialize has no session ID; every later request must carry one.
        assert!(requests[0].header("mcp-session-id").is_none());
        assert_eq!(requests[1].header("mcp-session-id"), Some("s-123"));
        assert_eq!(requests[2].header("mcp-session-id"), Some("s-123"));
        // After negotiating 2025-06-18, echo the protocol-version header starting with the notification.
        assert_eq!(
            requests[1].header("mcp-protocol-version"),
            Some("2025-06-18")
        );
        assert_eq!(
            requests[2].header("mcp-protocol-version"),
            Some("2025-06-18")
        );
        // A 202 notification acknowledgement produces no queued message; the notification request has no ID.
        assert!(requests[1].body.contains("notifications/initialized"));
    }

    #[tokio::test]
    async fn tools_call_response_can_arrive_over_sse_stream() {
        let server = start_mock(vec![
            MockResponse::initialize_result("2025-06-18"),
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
            MockResponse {
                status: 200,
                headers: vec![("content-type", "text/event-stream".to_string())],
        // Emit one notification in the stream before the response for this call.
                body: concat!(
                    "event: message\n",
                    "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n",
                    "event: message\n",
                    "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}],\"isError\":false}}\n\n",
                )
                .to_string(),
            },
        ])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        client.initialize().await.expect("initialize 失败");
        let result = client
            .call_tool("echo", json!({}))
            .await
            .expect("tools/call 失败");
        assert!(!result.is_error);
        assert_eq!(result.content[0].text.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn downgraded_protocol_version_is_adopted_and_reported() {
        let server = start_mock(vec![
            MockResponse::initialize_result("2025-03-26"),
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
            MockResponse::json(
                200,
                json!({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}),
            ),
        ])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        let info = client.initialize().await.expect("降级协商必须成功");
        assert_eq!(info.protocol_version, "2025-03-26");
        client.list_tools().await.expect("tools/list 失败");

        let requests = server.requests.lock().expect("请求记录锁");
        assert_eq!(
            requests[2].header("mcp-protocol-version"),
            Some("2025-03-26")
        );
    }

    #[tokio::test]
    async fn legacy_negotiated_version_omits_protocol_version_header() {
        let server = start_mock(vec![
            MockResponse::initialize_result("2024-11-05"),
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
            MockResponse::json(
                200,
                json!({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}),
            ),
        ])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        client.initialize().await.expect("旧版本协商必须成功");
        client.list_tools().await.expect("tools/list 失败");

        let requests = server.requests.lock().expect("请求记录锁");
        // The header does not exist for negotiated version 2024-11-05 and must not be echoed.
        assert!(requests[2].header("mcp-protocol-version").is_none());
    }

    #[tokio::test]
    async fn unsupported_protocol_version_fails_initialize() {
        let server = start_mock(vec![MockResponse::initialize_result("1999-01-01")]).await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        let err = client.initialize().await.expect_err("集合外版本必须报错");
        assert!(
            err.to_string().contains("unsupported protocol version"),
            "意外错误：{err}"
        );
    }

    #[tokio::test]
    async fn configured_headers_are_sent_verbatim() {
        let server = start_mock(vec![
            MockResponse::initialize_result("2025-06-18"),
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
        ])
        .await;
        let headers = HashMap::from([
            ("authorization".to_string(), "Bearer token-x".to_string()),
            ("x-custom".to_string(), "1".to_string()),
        ]);

        let transport = StreamableHttpTransport::new(&server.url, &headers)
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        client.initialize().await.expect("initialize 失败");

        let requests = server.requests.lock().expect("请求记录锁");
        assert_eq!(requests[0].header("authorization"), Some("Bearer token-x"));
        assert_eq!(requests[0].header("x-custom"), Some("1"));
    }

    #[tokio::test]
    async fn redirects_do_not_forward_credentials_or_request_bodies() {
        let destination = start_mock(vec![MockResponse::initialize_result("2025-06-18")]).await;
        let source = start_mock(vec![MockResponse {
            status: 307,
            headers: vec![("location", destination.url.clone())],
            body: String::new(),
        }])
        .await;
        let mut transport = StreamableHttpTransport::new(
            &source.url,
            &HashMap::from([("x-api-key".into(), "private-header-value".into())]),
        )
        .await
        .unwrap();
        let result = transport.send(r#"{"private":"request-body"}"#).await;
        assert!(
            result.is_err(),
            "A redirect must require explicit endpoint configuration"
        );
        assert!(destination.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn http_diagnostics_do_not_echo_urls_or_response_secrets() {
        let server = start_mock(vec![MockResponse {
            status: 403,
            headers: vec![],
            body: "private-response-secret".into(),
        }])
        .await;
        let mut transport = StreamableHttpTransport::new(
            &format!("{}?key=private-url-secret", server.url),
            &HashMap::new(),
        )
        .await
        .unwrap();
        let error = transport.send("{}").await.unwrap_err();
        let diagnostic = format!("{error:?}");
        assert!(diagnostic.contains("403"));
        assert!(!diagnostic.contains("private-response-secret"));
        assert!(!diagnostic.contains("private-url-secret"));
    }

    #[tokio::test]
    async fn http_error_status_surfaces_status_code() {
        let server = start_mock(vec![MockResponse {
            status: 405,
            headers: vec![],
            body: "method not allowed".to_string(),
        }])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        let err = client.initialize().await.expect_err("405 必须报错");
        assert!(err.to_string().contains("405"), "意外错误：{err}");
    }

    #[tokio::test]
    async fn not_found_with_session_id_marks_transport_failed() {
        let server = start_mock(vec![
            {
                let mut response = MockResponse::initialize_result("2025-06-18");
                response
                    .headers
                    .push(("mcp-session-id", "s-123".to_string()));
                response
            },
            MockResponse {
                status: 202,
                headers: vec![],
                body: String::new(),
            },
            MockResponse {
                status: 404,
                headers: vec![],
                body: String::new(),
            },
        ])
        .await;

        let transport = StreamableHttpTransport::new(&server.url, &HashMap::new())
            .await
            .expect("transport 构造失败");
        let mut client = McpClient::with_transport(Box::new(transport));
        client.initialize().await.expect("initialize 失败");
        let err = client.list_tools().await.expect_err("会话过期必须报错");
        assert!(err.to_string().contains("404"), "意外错误：{err}");
        // The failed state is sticky: later requests return an error without being sent.
        let err = client
            .list_tools()
            .await
            .expect_err("failed 态必须持续报错");
        assert!(
            err.to_string().contains("session is closed"),
            "意外错误：{err}"
        );

        let requests = server.requests.lock().expect("请求记录锁");
        assert_eq!(requests.len(), 3, "failed 后不得再发请求");
    }
}
