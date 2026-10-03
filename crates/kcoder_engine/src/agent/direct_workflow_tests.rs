use super::*;
use kcoder_tools::{Tool, ToolError};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Probe {
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
}
#[async_trait::async_trait]
impl Tool for Probe {
    fn name(&self) -> String {
        "mcp__fixture__lookup".into()
    }
    fn description(&self) -> String {
        "Stateful test tool".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object"})
    }
    fn is_concurrency_safe(&self, _: &serde_json::Value) -> bool {
        false
    }
    async fn call(&self, _: serde_json::Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(ToolOutput::text("done"))
    }
}
fn engine(root: &Path) -> (QueryEngine, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new().register(Probe {
        active: Arc::new(AtomicUsize::new(0)),
        maximum: maximum.clone(),
        calls: calls.clone(),
    });
    let mut settings = Settings::default();
    settings.permission_mode = PermissionMode::Ask;
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root)
        .settings(settings)
        .tool_registry(registry)
        .build();
    (engine, calls, maximum)
}
#[tokio::test]
async fn direct_workflow_tools_use_parent_registry_permissions_and_serialization() {
    let root = tempfile::tempdir().unwrap();
    let (engine, calls, maximum) = engine(root.path());
    engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("mcp__fixture__lookup");
    let runner = QueryEngineAgentRunner::new(engine.clone());
    let (workflow, foreground) = tokio::join!(
        runner.run_workflow_tool("wf", "mcp__fixture__lookup", serde_json::json!({})),
        engine.execute_tool(
            "fg",
            "mcp__fixture__lookup",
            serde_json::json!({}),
            &AutoDenyPrompt
        )
    );
    assert!(!workflow.unwrap().0.is_error);
    assert!(!foreground.unwrap().0.is_error);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    let unavailable = runner
        .run_workflow_tool("missing", "unregistered", serde_json::json!({}))
        .await
        .unwrap();
    assert!(unavailable.0.is_error);
    assert!(!unavailable.1);
}
#[tokio::test]
async fn direct_workflow_permission_denial_does_not_execute_or_claim_an_effect() {
    let root = tempfile::tempdir().unwrap();
    let (engine, calls, _) = engine(root.path());
    let runner = QueryEngineAgentRunner::new(engine);
    let (output, executed) = runner
        .run_workflow_tool("wf", "mcp__fixture__lookup", serde_json::json!({}))
        .await
        .unwrap();
    assert!(output.is_error);
    assert!(!executed);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn direct_workflow_reads_return_content_instead_of_conversation_placeholders() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("data.txt"), "machine-readable-data\n").unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build();
    engine
        .permissions
        .write()
        .unwrap()
        .allow_for_session("read");
    let runner = QueryEngineAgentRunner::new(engine);
    for id in ["first", "second"] {
        let (output, _) = runner
            .run_workflow_tool(id, "read", serde_json::json!({"file_path":"data.txt"}))
            .await
            .unwrap();
        assert!(!output.is_error);
        let encoded = serde_json::to_string(&output.content).unwrap();
        assert!(encoded.contains("machine-readable-data"));
        assert!(!encoded.contains("File unchanged"));
    }
}
