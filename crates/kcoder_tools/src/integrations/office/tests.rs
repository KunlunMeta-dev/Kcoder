//! Consumer tests only: these providers do not establish native authorization or generation.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct TestBackend {
    calls: AtomicUsize,
}
#[async_trait]
impl OfficeToolBackend for TestBackend {
    fn source_revision(&self) -> &str {
        "fixture-native-component-revision"
    }
    async fn create_document(
        &self,
        _: OfficeGenerationSpec,
        _: Vec<OfficeResourceRef>,
        _: Value,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ToolError::Execution("OFFICE_COMPONENT_UNAVAILABLE".into()))
    }
    async fn read_data(
        &self,
        _: OfficeDataAction,
        _: OfficeArtifactRef,
        _: Option<OfficeDatasetQuery>,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"rows":[["x".repeat(40000)]],"totalRows":1,"numberText":[[null]]}))
    }
}
fn context() -> (tempfile::TempDir, ToolContext) {
    let root = tempfile::tempdir().unwrap();
    let state = kcoder_state::AppState::new(root.path());
    let ctx = ToolContext::new(state).with_tool_call_id("real-native-call-fixture");
    (root, ctx)
}
#[tokio::test]
async fn model_arguments_cannot_replace_scope_or_supply_a_program() {
    let backend = Arc::new(TestBackend {
        calls: AtomicUsize::new(0),
    });
    let tool = OfficeDocumentTool::new(backend.clone()).unwrap();
    let (_root, ctx) = context();
    for field in ["scope", "task", "path", "program", "operationId"] {
        let mut input = json!({"specification":{"schemaVersion":1,"kind":"docx","title":"test","paragraphs":[]}});
        input[field] = json!("cannot-override-native-owner");
        assert!(matches!(
            tool.call(input, &ctx).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert!(!tool.is_read_only());
    assert!(!tool.is_concurrency_safe(&json!({})));
}
#[tokio::test]
async fn unsupported_dates_and_layouts_fail_before_backend_side_effects() {
    let backend = Arc::new(TestBackend {
        calls: AtomicUsize::new(0),
    });
    let tool = OfficeDocumentTool::new(backend.clone()).unwrap();
    let (_root, ctx) = context();
    let input = json!({"specification":{"schemaVersion":1,"kind":"xlsx","title":"test","sheets":[{"name":"data","columns":[{"key":"date","title":"Date","type":"date"}],"rows":[["2026-02-30"]]}]}});
    assert!(matches!(
        tool.call(input, &ctx).await,
        Err(ToolError::InvalidInput(_))
    ));
    let input = json!({"specification":{"schemaVersion":1,"kind":"pptx","title":"test","slides":[{"title":"overflow","paragraphs":["长".repeat(401)]}]}});
    assert!(matches!(
        tool.call(input, &ctx).await,
        Err(ToolError::InvalidInput(_))
    ));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn oversized_native_data_is_referenced_instead_of_truncated_into_false_values() {
    let backend = Arc::new(TestBackend {
        calls: AtomicUsize::new(0),
    });
    let tool = OfficeDataTool::new(backend).unwrap();
    let (_root, ctx) = context();
    let output=tool.call(json!({"action":"page","reference":{"id":"actual-dataset","revision":1},"query":{"limit":10}}),&ctx).await.unwrap();
    let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
        panic!("text expected")
    };
    let value: Value = serde_json::from_str(text).unwrap();
    assert_eq!(value["modelPreviewRows"], 0);
    assert_eq!(value["availableRows"], 1);
    assert_eq!(value["reference"]["id"], "actual-dataset");
    assert_eq!(value["omittedFromModel"], true);
    assert!(text.len() < 1024);
    assert!(tool.is_read_only());
    assert!(!tool.is_concurrency_safe(&json!({})));
}
#[test]
fn schema_contains_full_office_shape_and_flat_scalar_cell_constraint() {
    let backend = Arc::new(TestBackend {
        calls: AtomicUsize::new(0),
    });
    let tool = OfficeDocumentTool::new(backend).unwrap();
    let schema = tool.input_schema();
    assert!(
        schema
            .pointer("/definitions/OfficeGenerationSpec")
            .is_some()
    );
    assert_eq!(
        schema
            .pointer("/definitions/OfficeSheetSpec/properties/rows/items/items/type")
            .unwrap(),
        &json!(["string", "number", "boolean", "null"])
    );
    assert!(
        !schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("scope")
    );
}

#[tokio::test]
async fn model_cannot_publish_a_fake_native_operation_receipt() {
    let backend = Arc::new(TestBackend {
        calls: AtomicUsize::new(0),
    });
    let tool = OfficeCardTool::new(backend.clone()).unwrap();
    let (_root, ctx) = context();
    let input = json!({"title":"fake approval","presentation":{"kind":"operation_receipt","operationId":"invented","phase":"completed","detail":"model claim"}});
    assert!(matches!(
        tool.call(input, &ctx).await,
        Err(ToolError::InvalidInput(_))
    ));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}
