//! Public arguments cannot supply Native launch or authorization inputs.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Backend(AtomicUsize);
#[async_trait]
impl RemoteDelegateBackend for Backend {
    fn source_revision(&self) -> &str {
        "real-native-source-contract-test"
    }
    fn operation(&self, _: RemoteOperationInput, _: &ToolContext) -> Result<Value, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"state":"original_only","executionTerminalConfirmed":false}))
    }
    async fn delegate(
        &self,
        _: RemoteDelegateInput,
        actual: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"operationId":actual.tool_call_id,"state":"outcome_unknown","businessCompleted":false}),
        )
    }
}
#[tokio::test]
async fn runner_permissions_and_identity_cannot_enter_through_tool_json() {
    let backend = Arc::new(Backend(AtomicUsize::new(0)));
    let tool = Arc::new(RemoteDelegateTool::new(backend.clone()).unwrap());
    let emitter: Arc<dyn Tool> = tool.clone();
    let temp = tempfile::tempdir().unwrap();
    let actual =
        ToolContext::new(kcoder_state::AppState::new(temp.path())).with_tool_call_id("actual-call");
    let input = json!({"peerId":"explicit-peer","peerRevision":"a".repeat(64),"prompt":"Frozen input","maximumSeconds":30});
    for (field, value) in [
        ("approved", json!(true)),
        ("command", json!("download-and-run")),
        ("environment", json!({"TOKEN":"must-not-cross"})),
        ("actor", json!("admin")),
        ("model", json!("another-model")),
        ("toolCeiling", json!(["Shell"])),
    ] {
        let mut forged = input.clone();
        forged[field] = value;
        let receipt = actual
            .clone()
            .with_native_tool_invocation(&emitter, &forged)
            .unwrap();
        assert!(tool.call(forged, &receipt).await.is_err(), "{field}");
    }
    assert!(
        tool.call(input.clone(), &ToolContext::new(actual.state.clone()))
            .await
            .is_err()
    );
    assert_eq!(backend.0.load(Ordering::SeqCst), 0);
    assert!(tool.call(input.clone(), &actual).await.is_err());
    // The native receipt here is a contract fixture. Engine tests prove that
    // production issuance follows permissions, Hooks and all dispatch guards.
    let approved = actual
        .clone()
        .with_native_tool_invocation(&emitter, &input)
        .unwrap();
    let impostor = RemoteDelegateTool::new(backend.clone()).unwrap();
    assert!(impostor.call(input.clone(), &approved).await.is_err());
    assert!(
        tool.call(
            input.clone(),
            &approved.clone().with_tool_call_id("another-call")
        )
        .await
        .is_err()
    );
    let mut changed = input.clone();
    changed["maximumSeconds"] = json!(31);
    assert!(tool.call(changed, &approved).await.is_err());
    assert!(!tool.is_read_only());
    assert!(!tool.is_concurrency_safe(&input));
    let output = tool.call(input, &approved).await.unwrap();
    assert!(output.content.iter().any(|part|matches!(part,kcoder_types::ContentBlock::Text{text,..} if text.contains("outcome_unknown"))));
    assert_eq!(backend.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn management_requires_exact_native_receipt_and_original_cancel_revision() {
    let backend = Arc::new(Backend(AtomicUsize::new(0)));
    let tool = Arc::new(RemoteOperationTool::new(backend.clone()));
    let registered: Arc<dyn Tool> = tool.clone();
    let temp = tempfile::tempdir().unwrap();
    let actual = ToolContext::new(kcoder_state::AppState::new(temp.path()))
        .with_tool_call_id("original-management-call");
    for input in [
        json!({"action":"cancel","operationId":"original"}),
        json!({"action":"read","operationId":"original","command":"new-runner"}),
        json!({"action":"retry","operationId":"original"}),
    ] {
        let receipt = actual
            .clone()
            .with_native_tool_invocation(&registered, &input)
            .unwrap();
        assert!(tool.call(input, &receipt).await.is_err());
    }
    let input = json!({"action":"cancel","operationId":"original","expectedRevision":2});
    assert!(tool.call(input.clone(), &actual).await.is_err());
    assert_eq!(backend.0.load(Ordering::SeqCst), 0);
    let approved = actual
        .with_native_tool_invocation(&registered, &input)
        .unwrap();
    let mut changed = input.clone();
    changed["operationId"] = json!("another");
    assert!(tool.call(changed, &approved).await.is_err());
    assert!(!tool.is_read_only() && !tool.is_concurrency_safe(&input));
    tool.call(input, &approved).await.unwrap();
    assert_eq!(backend.0.load(Ordering::SeqCst), 1);
}

#[test]
fn material_selectors_are_optional_unique_native_refs_and_never_paths_or_grants() {
    let base = serde_json::json!({"peerId":"owned-peer","peerRevision":"a".repeat(64),"prompt":"Use the original material once","maximumSeconds":120});
    let empty: super::RemoteDelegateInput = serde_json::from_value(base.clone()).unwrap();
    assert!(empty.materials.is_empty());
    empty.validate().unwrap();
    let mut input = base;
    input["materials"] = serde_json::json!([{"id":"actual-original-input","revision":1}]);
    serde_json::from_value::<super::RemoteDelegateInput>(input.clone())
        .unwrap()
        .validate()
        .unwrap();
    for field in ["path", "owner", "approved", "command"] {
        let mut denied = input.clone();
        denied["materials"][0][field] = serde_json::json!("not-authority");
        assert!(serde_json::from_value::<super::RemoteDelegateInput>(denied).is_err());
    }
    input["materials"] = serde_json::json!([{"id":"same","revision":1},{"id":"same","revision":1}]);
    assert!(
        serde_json::from_value::<super::RemoteDelegateInput>(input)
            .unwrap()
            .validate()
            .is_err()
    );
}
