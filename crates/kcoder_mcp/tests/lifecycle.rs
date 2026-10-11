use kcoder_mcp::{McpClient, McpTool, McpToolDefinition};
use kcoder_tools::{Tool, ToolContext};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

async fn client(mode: &str, directory: &Path) -> McpClient {
    let fixture = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo must provide the workspace root"),
    )
    .join("crates/kcoder_mcp/tests/fixtures/lifecycle_server.py");
    let mut client = McpClient::new(
        "python3",
        &[
            fixture.to_string_lossy().into(),
            mode.into(),
            directory.to_string_lossy().into(),
        ],
        &HashMap::new(),
    )
    .await
    .unwrap();
    client.initialize().await.unwrap();
    client
}

fn tool(client: McpClient) -> McpTool {
    McpTool::new(
        "fixture",
        Arc::new(tokio::sync::Mutex::new(client)),
        McpToolDefinition {
            name: "effect".into(),
            description: String::new(),
            input_schema: json!({}),
        },
    )
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

fn messages(directory: &Path) -> Vec<Value> {
    std::fs::read_to_string(directory.join("messages.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn receipt(output: &kcoder_tools::ToolOutput) -> Value {
    let Some(kcoder_types::ContentBlock::Text { text }) = output.content.first() else {
        return json!({});
    };
    serde_json::from_str(text).unwrap_or_else(|_| json!({"legacyText": text}))
}

#[tokio::test]
async fn pre_cancelled_context_does_not_send_business_request() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool(client("effect", directory.path()).await);
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()))
        .with_abort_token(Default::default());
    context.abort_token.as_ref().unwrap().cancel();
    let output = tool.call(json!({}), &context).await.unwrap();
    assert_eq!(receipt(&output)["status"], "notSent");
    assert!(!directory.path().join("called").exists());
}

#[tokio::test]
async fn sent_cancel_is_unknown_and_does_not_replay_or_close_shared_connection() {
    let directory = tempfile::tempdir().unwrap();
    let handle = Arc::new(tokio::sync::Mutex::new(
        client("effect", directory.path()).await,
    ));
    let tool = McpTool::new(
        "fixture",
        handle.clone(),
        McpToolDefinition {
            name: "effect".into(),
            description: String::new(),
            input_schema: json!({}),
        },
    );
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()))
        .with_abort_token(Default::default());
    let cancel = context.abort_token.clone().unwrap();
    let called = directory.path().join("called");
    let (_, output) = tokio::join!(
        async {
            wait_file(&called).await;
            cancel.cancel();
        },
        tool.call(json!({}), &context)
    );
    let output = output.unwrap();
    assert_eq!(receipt(&output)["status"], "outcomeUnknown");
    assert_eq!(receipt(&output)["cancellationNotificationSent"], true);
    wait_file(&directory.path().join("effect")).await;
    assert_eq!(handle.lock().await.list_tools().await.unwrap().len(), 1);
    let sent = messages(directory.path());
    assert_eq!(
        sent.iter().filter(|v| v["method"] == "tools/call").count(),
        1
    );
    let original = sent.iter().find(|v| v["method"] == "tools/call").unwrap();
    let note = sent
        .iter()
        .find(|v| v["method"] == "notifications/cancelled")
        .unwrap();
    assert_eq!(note["params"]["requestId"], original["id"]);
    assert!(note.get("id").is_none());
}

#[tokio::test]
async fn colliding_server_ping_and_unsupported_request_do_not_complete_tool_call() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = client("ping", directory.path()).await;
    client.call_tool("effect", json!({})).await.unwrap();
    client.list_tools().await.unwrap();
    let sent = messages(directory.path());
    assert!(
        sent.iter()
            .any(|v| v["id"] == 2 && v["result"] == json!({}) && v.get("method").is_none())
    );
    assert!(
        sent.iter()
            .any(|v| v["id"] == "server-request" && v["error"]["code"] == -32601)
    );
}

#[tokio::test]
async fn timed_out_sent_call_has_unknown_receipt_and_cancel_request_id() {
    use async_trait::async_trait;
    use kcoder_mcp::McpTransport;
    struct Peer {
        sent: Arc<std::sync::Mutex<Vec<Value>>>,
    }
    #[async_trait]
    impl McpTransport for Peer {
        async fn send(&mut self, line: &str) -> anyhow::Result<()> {
            self.sent.lock().unwrap().push(serde_json::from_str(line)?);
            Ok(())
        }
        async fn recv(&mut self) -> anyhow::Result<Option<String>> {
            if self.sent.lock().unwrap().len() == 1 {
                Ok(Some(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}}}).to_string()))
            } else {
                std::future::pending().await
            }
        }
    }
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut client = McpClient::with_transport(Box::new(Peer { sent: sent.clone() }));
    client.initialize().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let tool = tool(client);
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()));
    tokio::time::pause();
    let output = tool.call(json!({}), &context).await.unwrap();
    tokio::time::resume();
    assert_eq!(receipt(&output)["status"], "outcomeUnknown");
    assert_eq!(receipt(&output)["reason"], "timedOut");
    assert!(
        sent.lock()
            .unwrap()
            .iter()
            .any(|v| v["method"] == "notifications/cancelled" && v["params"]["requestId"] == 2)
    );
}

#[tokio::test]
async fn queued_cancel_does_not_wait_for_or_dispatch_on_shared_connection() {
    let directory = tempfile::tempdir().unwrap();
    let handle = Arc::new(tokio::sync::Mutex::new(
        client("effect", directory.path()).await,
    ));
    let locked = handle.lock().await;
    let tool = McpTool::new(
        "fixture",
        handle.clone(),
        McpToolDefinition {
            name: "effect".into(),
            description: String::new(),
            input_schema: json!({}),
        },
    );
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()))
        .with_abort_token(Default::default());
    let cancellation = context.abort_token.clone().unwrap();
    let (_, output) = tokio::join!(
        async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancellation.cancel();
        },
        tokio::time::timeout(Duration::from_secs(1), tool.call(json!({}), &context))
    );
    assert_eq!(receipt(&output.unwrap().unwrap())["status"], "notSent");
    assert!(!directory.path().join("called").exists());
    drop(locked);
}

#[tokio::test]
async fn cancellation_during_partial_stdio_write_preserves_jsonl_framing() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool(client("slowread", directory.path()).await);
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()))
        .with_abort_token(Default::default());
    let cancellation = context.abort_token.clone().unwrap();
    let (_, output) = tokio::join!(
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancellation.cancel();
        },
        tool.call(json!({"padding":"x".repeat(4 * 1024 * 1024)}), &context)
    );
    let receipt = receipt(&output.unwrap());
    assert_eq!(receipt["status"], "outcomeUnknown");
    assert_eq!(receipt["cancellationNotificationSent"], true);
    wait_file(&directory.path().join("effect")).await;
    let sent = messages(directory.path());
    assert_eq!(
        sent.iter().filter(|v| v["method"] == "tools/call").count(),
        1
    );
    assert!(
        sent.iter()
            .any(|v| v["method"] == "notifications/cancelled" && v["params"]["requestId"] == 2)
    );
}

#[tokio::test]
async fn externally_dropped_wait_retires_handle_without_replaying_effect() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = client("effect", directory.path()).await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(20),
            client.call_tool("effect", json!({}))
        )
        .await
        .is_err()
    );
    wait_file(&directory.path().join("effect")).await;
    assert!(client.connection_failure_reason().is_some());
    assert!(client.call_tool("effect", json!({})).await.is_err());
    assert_eq!(
        messages(directory.path())
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
}
