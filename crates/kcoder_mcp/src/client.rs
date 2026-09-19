use crate::model::{
    CallToolParams, CallToolResult, Implementation, InitializeParams, InitializeResult,
    JsonRpcRequest, JsonRpcResponse, ListToolsResult,
};
use crate::transport::{McpTransport, StdioTransport};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{debug, warn};

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A minimal MCP client. Supports the initialize handshake, tools/list, and
/// tools/call over any [`McpTransport`].
pub struct McpClient {
    transport: Box<dyn McpTransport>,
    next_id: AtomicU64,
    initialized: bool,
}

impl McpClient {
    pub async fn new(
        command: &str,
        args: &[String],
        env: &std::collections::HashMap<String, String>,
    ) -> Result<Self> {
        let transport = StdioTransport::new(command, args, env).await?;
        Ok(Self::with_transport(Box::new(transport)))
    }

    pub fn with_transport(transport: Box<dyn McpTransport>) -> Self {
        Self {
            transport,
            next_id: AtomicU64::new(1),
            initialized: false,
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Run the initialize handshake and return the server info.
    pub async fn initialize(&mut self) -> Result<InitializeResult> {
        if self.initialized {
            return Err(anyhow!("MCP client is already initialized"));
        }

        let id = self.next_id();
        let params = InitializeParams {
            protocol_version: self.transport.supported_protocol_versions()[0].to_string(),
            capabilities: Value::Object(serde_json::Map::new()),
            client_info: Implementation {
                name: "kcoder".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
        };

        let result: InitializeResult = self.request_raw(id, "initialize", params).await?;

        // The server's negotiated version should belong to the transport's declared
        // set. stdio and legacy SSE declare only 2024-11-05 and retain compatibility
        // with nonconforming old servers by warning on mismatches. Only transports
        // declaring multiple versions, such as Streamable HTTP, reject strictly.
        let supported = self.transport.supported_protocol_versions();
        if supported.contains(&result.protocol_version.as_str()) {
            self.transport
                .set_negotiated_protocol_version(result.protocol_version.clone());
        } else if supported.len() > 1 {
            anyhow::bail!(
                "MCP server '{}' proposed unsupported protocol version '{}' (supported: {})",
                result.server_info.name,
                result.protocol_version,
                supported.join(", ")
            );
        } else {
            warn!(
                "MCP server '{}' responded with protocol version '{}'; continuing as '{}'",
                result.server_info.name, result.protocol_version, supported[0]
            );
        }

        // Bound the initialized notification so a peer that does not read stdin cannot
        // block forever. MCP params must be an object; some newer SDK-based servers
        // ignore params=null and cause later requests to time out.
        let notification = JsonRpcRequest::<Value>::notification(
            "notifications/initialized",
            Value::Object(serde_json::Map::new()),
        );
        let note_line = serde_json::to_string(&notification)
            .context("failed to serialize MCP initialized notification")?;
        tokio::time::timeout(REQUEST_TIMEOUT, self.transport.send(&note_line))
            .await
            .map_err(|_| {
                anyhow!(
                    "MCP notification 'notifications/initialized' timed out after {}s",
                    REQUEST_TIMEOUT.as_secs()
                )
            })??;

        self.initialized = true;
        debug!(
            "MCP client initialized with server {}",
            result.server_info.name
        );
        Ok(result)
    }

    /// List tools exposed by the server.
    pub async fn list_tools(&mut self) -> Result<Vec<crate::model::McpToolDefinition>> {
        self.ensure_initialized()?;
        let result: ListToolsResult = self
            .request("tools/list", Value::Object(serde_json::Map::new()))
            .await?;
        Ok(result.tools)
    }

    /// Call a tool on the server.
    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<CallToolResult> {
        self.ensure_initialized()?;
        let params = CallToolParams {
            name: name.to_string(),
            arguments,
        };
        self.request("tools/call", params).await
    }

    fn ensure_initialized(&self) -> Result<()> {
        if self.initialized {
            Ok(())
        } else {
            Err(anyhow!("MCP client is not initialized"))
        }
    }

    async fn request<T: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: T,
    ) -> Result<R> {
        let id = self.next_id();
        self.request_raw(id, method, params).await
    }

    async fn request_raw<T: Serialize, R: DeserializeOwned>(
        &mut self,
        id: u64,
        method: &str,
        params: T,
    ) -> Result<R> {
        let request = JsonRpcRequest::new(id, method, params);
        let line = serde_json::to_string(&request)
            .with_context(|| format!("failed to serialize MCP request {}", method))?;
        // Sending and receiving share one deadline, so a peer that does not read stdin cannot retain the client lock forever.
        let wait = async {
            self.transport.send(&line).await?;
            loop {
                let Some(line) = self.transport.recv().await? else {
                    return Err(anyhow!(
                        "MCP server closed stdout while waiting for response to {}",
                        method
                    ));
                };

                if line.trim().is_empty() {
                    continue;
                }

                // Ignore notifications and responses for other requests.
                let parsed: JsonRpcResponse<Value> = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        // serde error text may contain raw field values; record only category and location.
                        warn!(
                            category = ?e.classify(),
                            line = e.line(),
                            column = e.column(),
                            "failed to parse MCP response line"
                        );
                        continue;
                    }
                };

                if parsed.id != Some(id) {
                    // Notification or stale response; keep waiting.
                    continue;
                }

                if let Some(error) = parsed.error {
                    return Err(anyhow!("MCP error ({}): {}", error.code, error.message));
                }

                let result = parsed.result.with_context(|| {
                    format!("MCP response to {} had neither result nor error", method)
                })?;

                return serde_json::from_value(result)
                    .with_context(|| format!("failed to deserialize MCP result for {}", method));
            }
        };
        tokio::time::timeout(REQUEST_TIMEOUT, wait)
            .await
            .map_err(|_| {
                anyhow!(
                    "MCP request '{}' timed out after {}s",
                    method,
                    REQUEST_TIMEOUT.as_secs()
                )
            })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::McpTransport;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// Fake transport with scripted response lines and recorded sends. `versions`
    /// simulates the transport's negotiation set: one element for stdio/legacy SSE
    /// behavior and multiple elements for Streamable HTTP.
    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
        versions: &'static [&'static str],
        negotiated: Arc<Mutex<Option<String>>>,
        pending_send_method: Option<&'static str>,
        send_delay: std::time::Duration,
        pending_recv: bool,
    }

    struct FakeHandles {
        sent: Arc<Mutex<Vec<String>>>,
        negotiated: Arc<Mutex<Option<String>>>,
    }

    impl FakeTransport {
        fn new(
            incoming: VecDeque<String>,
            versions: &'static [&'static str],
        ) -> (Self, FakeHandles) {
            let sent = Arc::new(Mutex::new(Vec::new()));
            let negotiated = Arc::new(Mutex::new(None));
            let transport = Self {
                incoming,
                sent: Arc::clone(&sent),
                versions,
                negotiated: Arc::clone(&negotiated),
                pending_send_method: None,
                send_delay: std::time::Duration::ZERO,
                pending_recv: false,
            };
            (transport, FakeHandles { sent, negotiated })
        }

        fn legacy(incoming: VecDeque<String>) -> (Self, FakeHandles) {
            Self::new(incoming, &["2024-11-05"])
        }

        fn strict(incoming: VecDeque<String>) -> (Self, FakeHandles) {
            Self::new(incoming, &["2025-06-18", "2025-03-26", "2024-11-05"])
        }
    }

    #[async_trait::async_trait]
    impl McpTransport for FakeTransport {
        async fn send(&mut self, line: &str) -> Result<()> {
            self.sent.lock().expect("发送记录锁").push(line.to_string());
            let request: Value = serde_json::from_str(line)?;
            if request["method"].as_str() == self.pending_send_method {
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(self.send_delay).await;
            Ok(())
        }

        async fn recv(&mut self) -> Result<Option<String>> {
            if self.pending_recv {
                std::future::pending::<()>().await;
            }
            Ok(self.incoming.pop_front())
        }

        fn supported_protocol_versions(&self) -> &'static [&'static str] {
            self.versions
        }

        fn set_negotiated_protocol_version(&mut self, version: String) {
            *self.negotiated.lock().expect("协商记录锁") = Some(version);
        }
    }

    fn initialize_result_line(version: &str) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": version,
                "capabilities": {},
                "serverInfo": { "name": "fake", "version": "0" }
            }
        })
        .to_string()
    }

    fn list_tools_result_line() -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": { "tools": [] }
        })
        .to_string()
    }

    #[tokio::test(start_paused = true)]
    async fn request_timeout_includes_blocked_send() {
        let (mut transport, _) = FakeTransport::legacy(VecDeque::new());
        transport.pending_send_method = Some("initialize");
        let mut client = McpClient::with_transport(Box::new(transport));
        let result = tokio::time::timeout(std::time::Duration::from_secs(61), client.initialize())
            .await
            .expect("发送阻塞必须在请求期限内结束");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("timed out after 60s")
        );
        assert!(!client.initialized);
    }

    #[tokio::test(start_paused = true)]
    async fn request_timeout_shares_deadline_between_send_and_recv() {
        let (mut transport, _) = FakeTransport::legacy(VecDeque::new());
        transport.send_delay = std::time::Duration::from_secs(30);
        transport.pending_recv = true;
        let mut client = McpClient::with_transport(Box::new(transport));
        let started = tokio::time::Instant::now();
        let error = client.initialize().await.unwrap_err();
        assert!(error.to_string().contains("timed out after 60s"));
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(60));
    }

    #[tokio::test(start_paused = true)]
    async fn initialized_notification_timeout_bounds_blocked_send() {
        let (mut transport, _) =
            FakeTransport::legacy(VecDeque::from([initialize_result_line("2024-11-05")]));
        transport.pending_send_method = Some("notifications/initialized");
        let mut client = McpClient::with_transport(Box::new(transport));
        let error = tokio::time::timeout(std::time::Duration::from_secs(61), client.initialize())
            .await
            .expect("初始化通知阻塞必须有超时")
            .unwrap_err();
        assert!(error.to_string().contains("notifications/initialized"));
        assert!(error.to_string().contains("timed out after 60s"));
        assert!(!client.initialized);
    }

    #[tokio::test]
    async fn mcp_diagnostics_omit_tool_arguments_and_malformed_payloads() {
        use kcoder_tools::{Tool, ToolContext};
        use std::io::Write;
        use tracing::instrument::WithSubscriber;

        #[derive(Clone)]
        struct LogWriter(Arc<Mutex<Vec<u8>>>);
        impl Write for LogWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = LogWriter(Arc::clone(&output));
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish();
        async {
            let (transport, _) = FakeTransport::legacy(VecDeque::from([
                initialize_result_line("2024-11-05"),
                // Type errors may interpolate values into serde messages, so removing only the raw line is insufficient.
                r#"{"jsonrpc":"2.0","id":"private-response-marker"}"#.to_string(),
                serde_json::json!({"jsonrpc":"2.0","id":2,"result":{"content":[]}}).to_string(),
            ]));
            let mut client = McpClient::with_transport(Box::new(transport));
            client.initialize().await.unwrap();
            let definition = crate::model::McpToolDefinition {
                name: "private_tool".to_string(),
                description: String::new(),
                input_schema: serde_json::json!({}),
            };
            let tool = crate::tool::McpTool::new(
                "test_server",
                Arc::new(tokio::sync::Mutex::new(client)),
                definition,
            );
            let ctx = ToolContext::new(kcoder_state::AppState::new(std::env::temp_dir()));
            tool.call(serde_json::json!({"data":"private-argument-marker"}), &ctx)
                .await
                .unwrap();
        }
        .with_subscriber(subscriber)
        .await;
        let logs = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert!(logs.contains("private_tool"), "必须保留工具名诊断");
        assert!(
            logs.contains("failed to parse MCP response"),
            "必须保留协议诊断"
        );
        assert!(
            !logs.contains("private-argument-marker"),
            "工具参数不应进入日志：{logs}"
        );
        assert!(
            !logs.contains("private-response-marker"),
            "响应内容不应进入日志：{logs}"
        );
    }

    #[tokio::test]
    async fn legacy_transport_tolerates_unexpected_protocol_version() {
        // Legacy transports declare only 2024-11-05. Warn but continue when a
        // nonconforming server echoes another version, preserving established compatibility.
        let (transport, _) =
            FakeTransport::legacy(VecDeque::from([initialize_result_line("2025-03-26")]));
        let mut client = McpClient::with_transport(Box::new(transport));

        let info = client
            .initialize()
            .await
            .expect("legacy 传输不得因版本回声失败");
        assert_eq!(info.protocol_version, "2025-03-26");
    }

    #[tokio::test]
    async fn strict_transport_rejects_unsupported_protocol_version() {
        let (transport, _) =
            FakeTransport::strict(VecDeque::from([initialize_result_line("1999-01-01")]));
        let mut client = McpClient::with_transport(Box::new(transport));

        let err = client.initialize().await.expect_err("集合外版本必须报错");
        assert!(
            err.to_string().contains("unsupported protocol version"),
            "意外错误：{err}"
        );
    }

    #[tokio::test]
    async fn strict_transport_records_negotiated_version() {
        let (transport, handles) =
            FakeTransport::strict(VecDeque::from([initialize_result_line("2025-03-26")]));
        let mut client = McpClient::with_transport(Box::new(transport));

        client.initialize().await.expect("降级协商必须成功");
        assert_eq!(
            handles.negotiated.lock().expect("协商记录锁").as_deref(),
            Some("2025-03-26")
        );
    }

    #[tokio::test]
    async fn initialize_offers_the_first_supported_version() {
        let (transport, handles) =
            FakeTransport::strict(VecDeque::from([initialize_result_line("2025-06-18")]));
        let mut client = McpClient::with_transport(Box::new(transport));

        client.initialize().await.expect("initialize 失败");

        let sent = handles.sent.lock().expect("发送记录锁");
        let request: serde_json::Value =
            serde_json::from_str(&sent[0]).expect("initialize 请求必须是合法 JSON");
        assert_eq!(request["params"]["protocolVersion"], "2025-06-18");
        // Send notifications/initialized after successful negotiation.
        let notification: serde_json::Value =
            serde_json::from_str(&sent[1]).expect("initialized 通知必须是合法 JSON");
        assert_eq!(notification["method"], "notifications/initialized");
        assert_eq!(notification["params"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn list_tools_sends_empty_object_params() {
        let (transport, handles) = FakeTransport::legacy(VecDeque::from([
            initialize_result_line("2024-11-05"),
            list_tools_result_line(),
        ]));
        let mut client = McpClient::with_transport(Box::new(transport));

        client.initialize().await.expect("initialize 失败");
        client.list_tools().await.expect("tools/list 失败");

        let sent = handles.sent.lock().expect("发送记录锁");
        let request: serde_json::Value =
            serde_json::from_str(&sent[2]).expect("tools/list 请求必须是合法 JSON");
        assert_eq!(request["method"], "tools/list");
        assert_eq!(request["params"], serde_json::json!({}));
    }

    #[test]
    fn default_transport_versions_stay_on_legacy() {
        // stdio and legacy SSE use the trait default and always declare only 2024-11-05.
        let (transport, _) = FakeTransport::legacy(VecDeque::new());
        let _ = transport;
        struct DefaultVersions;
        #[async_trait::async_trait]
        impl McpTransport for DefaultVersions {
            async fn send(&mut self, _line: &str) -> Result<()> {
                Ok(())
            }
            async fn recv(&mut self) -> Result<Option<String>> {
                Ok(None)
            }
        }
        assert_eq!(
            DefaultVersions.supported_protocol_versions(),
            &["2024-11-05"]
        );
    }
}
