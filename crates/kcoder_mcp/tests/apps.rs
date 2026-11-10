#![cfg(unix)]
use kcoder_mcp::{McpClient, McpTool};
use kcoder_tools::{Tool, ToolContext, ToolExecutionMetadata};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

async fn client(mode: &str, directory: &Path) -> McpClient {
    let fixture = Path::new(env!("KCODER_WORKSPACE_ROOT"))
        .join("crates/kcoder_mcp/tests/fixtures/apps_server.py");
    let client = McpClient::new(
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
    let mut client = client.with_apps_support(true).unwrap();
    client.initialize().await.unwrap();
    client
}
fn requests(directory: &Path) -> Vec<Value> {
    std::fs::read_to_string(directory.join("messages.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
async fn tool(mode: &str, directory: &Path) -> McpTool {
    let mut client = client(mode, directory).await;
    let definition = client
        .list_tools()
        .await
        .unwrap()
        .into_iter()
        .find(|tool| tool.name == "chart")
        .unwrap();
    McpTool::new(
        "owned-server",
        Arc::new(tokio::sync::Mutex::new(client)),
        definition,
    )
}
fn context(directory: &Path) -> ToolContext {
    ToolContext::new(kcoder_state::AppState::new(directory)).with_inline_widgets_authorized(true)
}

#[tokio::test]
async fn definition_call_resource_and_structured_ui_data_survive_real_stdio() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = client("blob", directory.path()).await;
    let definitions = client.list_tools().await.unwrap();
    assert!(
        !definitions
            .iter()
            .find(|tool| tool.name == "refresh")
            .unwrap()
            .visible_to_model()
    );
    assert!(
        definitions
            .iter()
            .find(|tool| tool.name == "chart")
            .unwrap()
            .visible_to_model()
    );
    let listed = client.list_resources(None).await.unwrap();
    assert_eq!(listed.len(), 1);
    let output = client.call_tool("chart", json!({})).await.unwrap();
    assert_eq!(output.meta.as_ref().unwrap()["revision"], 3);
    let view = client
        .read_ui_resource(
            "owned-server",
            None,
            "chart",
            "ui://fixture/chart",
            output.structured_content,
            output.meta,
            None,
        )
        .await
        .unwrap();
    assert!(view.html.contains("<html>"));
    assert!(view.requested_permissions.clipboard_write);
    assert_eq!(view.server_name, "owned-server");
    assert_eq!(view.structured_content.unwrap()["series"], json!([1, 2]));
    assert!(
        client
            .call_app_tool("model_only", json!({}), None)
            .await
            .is_err()
    );
    assert!(
        client
            .call_app_tool("refresh", json!({}), None)
            .await
            .is_ok()
    );
    let calls = requests(directory.path());
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "tools/call")
            .count(),
        2
    );
}

#[tokio::test]
async fn normal_cli_tool_calls_do_not_fetch_ui_or_expose_result_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool("normal", directory.path()).await;
    let ctx = ToolContext::new(kcoder_state::AppState::new(directory.path()));
    let output = tool.call(json!({}), &ctx).await.unwrap();
    assert!(output.execution_metadata.is_empty());
    assert!(
        !serde_json::to_string(&output.content)
            .unwrap()
            .contains("uiOnly")
    );
    assert!(
        !requests(directory.path())
            .iter()
            .any(|call| call["method"] == "resources/read")
    );
}

#[tokio::test]
async fn authorized_view_redacts_private_html_data_and_meta_without_losing_typed_structure() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool("normal", directory.path())
        .await
        .with_private_values(
            kcoder_mcp::tool::PrivateValues::new(["synthetic-ui-secret".into()]).unwrap(),
        )
        .unwrap();
    let output = tool
        .call(json!({}), &context(directory.path()))
        .await
        .unwrap();
    let Some(ToolExecutionMetadata::McpApp(view)) = output.execution_metadata.first() else {
        panic!("missing typed UI observation")
    };
    assert!(
        !serde_json::to_string(view)
            .unwrap()
            .contains("synthetic-ui-secret")
    );
    assert!(view.structured_content.as_ref().unwrap()["series"].is_array());
    assert!(view.result_meta.as_ref().unwrap().get("uiOnly").is_some());
}

#[tokio::test]
async fn invalid_resource_source_mime_and_size_do_not_replay_a_completed_tool() {
    for mode in ["wrong-uri", "wrong-mime", "oversize"] {
        let directory = tempfile::tempdir().unwrap();
        let tool = tool(mode, directory.path()).await;
        let output = tool
            .call(json!({}), &context(directory.path()))
            .await
            .unwrap();
        assert!(!output.is_error);
        assert!(output.execution_metadata.is_empty());
        assert_eq!(
            requests(directory.path())
                .iter()
                .filter(|call| call["method"] == "tools/call")
                .count(),
            1
        );
        assert!(
            serde_json::to_string(&output.content)
                .unwrap()
                .contains("inline view is unavailable")
        );
    }
}

#[tokio::test]
async fn plugin_view_requires_current_host_authority() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool("normal", directory.path())
        .await
        .with_plugin_source("owned-plugin");
    let output = tool
        .call(json!({}), &context(directory.path()))
        .await
        .unwrap();
    assert!(output.execution_metadata.is_empty());
    assert!(
        !requests(directory.path())
            .iter()
            .any(|call| call["method"] == "resources/read")
    );
}

#[tokio::test]
async fn resource_cancellation_keeps_primary_receipt_and_does_not_repeat_business_call() {
    let directory = tempfile::tempdir().unwrap();
    let tool = tool("cancel", directory.path()).await;
    let token = tokio_util::sync::CancellationToken::new();
    let ctx = context(directory.path()).with_abort_token(token.clone());
    let running = tokio::spawn(async move { tool.call(json!({}), &ctx).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.path().join("read-started").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    token.cancel();
    let output = tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .unwrap()
        .unwrap();
    assert!(!output.is_error);
    assert!(output.execution_metadata.is_empty());
    assert_eq!(
        requests(directory.path())
            .iter()
            .filter(|call| call["method"] == "tools/call")
            .count(),
        1
    );
}

#[tokio::test]
async fn unsupported_resource_method_and_pre_cancelled_read_are_explicit() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = client("unsupported", directory.path()).await;
    assert!(client.list_resources(None).await.is_err());
    let token = tokio_util::sync::CancellationToken::new();
    token.cancel();
    assert!(
        client
            .read_ui_resource(
                "owned",
                None,
                "chart",
                "ui://fixture/chart",
                None,
                None,
                Some(&token)
            )
            .await
            .is_err()
    );
    assert!(
        !requests(directory.path())
            .iter()
            .any(|call| call["method"] == "resources/read")
    );
}

#[tokio::test]
async fn apps_capability_is_explicit_and_never_upgrades_an_initialized_connection() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("KCODER_WORKSPACE_ROOT"))
        .join("crates/kcoder_mcp/tests/fixtures/apps_server.py");
    let mut plain = McpClient::new(
        "python3",
        &[
            fixture.to_string_lossy().into(),
            "normal".into(),
            directory.path().to_string_lossy().into(),
        ],
        &HashMap::new(),
    )
    .await
    .unwrap();
    plain.initialize().await.unwrap();
    assert!(
        plain
            .read_ui_resource(
                "owned",
                None,
                "chart",
                "ui://fixture/chart",
                None,
                None,
                None
            )
            .await
            .is_err()
    );
    assert!(plain.with_apps_support(true).is_err());
    let messages = requests(directory.path());
    assert!(
        messages[0]["params"]["capabilities"]
            .get("extensions")
            .is_none()
    );
    let separate = tempfile::tempdir().unwrap();
    let _apps = client("normal", separate.path()).await;
    assert_eq!(
        requests(separate.path())[0]["params"]["capabilities"]["extensions"]["io.modelcontextprotocol/ui"]
            ["mimeTypes"],
        json!(["text/html;profile=mcp-app"])
    );
}

#[tokio::test]
async fn plugin_authority_is_rechecked_after_the_resource_response() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let directory = tempfile::tempdir().unwrap();
    let checks = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&checks);
    let marker = directory.path().join("ui-resource-returned");
    let tool = tool("revoke-after-resource", directory.path())
        .await
        .with_plugin_source("owned-plugin")
        .with_app_authorizer(Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            !marker.exists()
        }));
    let output = tool
        .call(json!({}), &context(directory.path()))
        .await
        .unwrap();
    assert!(checks.load(Ordering::SeqCst) >= 2);
    assert!(output.execution_metadata.is_empty());
    assert!(!output.is_error);
    assert_eq!(
        requests(directory.path())
            .iter()
            .filter(|call| call["method"] == "resources/read")
            .count(),
        1
    );
}

#[tokio::test]
async fn cancellation_during_app_visibility_discovery_never_sends_the_business_call() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = client("cancel-list", directory.path()).await;
    let token = tokio_util::sync::CancellationToken::new();
    let abort = token.clone();
    let running = tokio::spawn(async move {
        client
            .call_app_tool("refresh", json!({}), Some(&abort))
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.path().join("list-started").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    token.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), running)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        !requests(directory.path())
            .iter()
            .any(|call| call["method"] == "tools/call")
    );
}

#[tokio::test]
async fn composition_filters_app_only_tools_but_preserves_live_raw_discovery() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("KCODER_WORKSPACE_ROOT"))
        .join("crates/kcoder_mcp/tests/fixtures/apps_server.py");
    let config:kcoder_mcp::McpServerConfig=serde_json::from_value(json!({"name":"owned-server","command":"python3","args":[fixture,"normal",directory.path()],"transport":"stdio"})).unwrap();
    let (handle, definitions) = kcoder_mcp::connect_server_for_apps(
        &config,
        None,
        Arc::new(kcoder_mcp::tool::PrivateValues::default()),
    )
    .await
    .unwrap();
    assert_eq!(
        definitions
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["chart", "model_only"]
    );
    let mut client = handle.lock().await;
    let id = client.app_connection_id().unwrap().to_owned();
    assert_eq!(id.len(), 32);
    assert!(
        client
            .list_tools()
            .await
            .unwrap()
            .iter()
            .any(|tool| tool.name == "refresh")
    );
    let view = client
        .read_ui_resource(
            "owned-server",
            None,
            "chart",
            "ui://fixture/chart",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(view.connection_id, id);
}
