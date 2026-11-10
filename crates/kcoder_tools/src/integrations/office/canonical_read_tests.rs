//! Schema/result consumers, not native authorization or generator evidence.
use super::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner};
use std::sync::Mutex;
struct Reader {
    calls: Mutex<Vec<OfficeCanonicalSourceReadParams>>,
}
#[async_trait]
impl OfficeToolBackend for Reader {
    fn source_revision(&self) -> &str {
        "source-reader-contract-fixture"
    }
    async fn create_document(
        &self,
        _: OfficeGenerationSpec,
        _: Vec<OfficeResourceRef>,
        _: Value,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution("fixture does not generate".into()))
    }
    async fn read_data(
        &self,
        _: OfficeDataAction,
        _: OfficeArtifactRef,
        _: Option<OfficeDatasetQuery>,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "fixture does not read datasets".into(),
        ))
    }
    async fn read_canonical_source(
        &self,
        parameters: OfficeCanonicalSourceReadParams,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.calls.lock().unwrap().push(parameters);
        Ok(
            json!({"availability":"not_recorded","source":null,"chunk":null,"offset":0,"nextOffset":null,"complete":false}),
        )
    }
}
fn context() -> (tempfile::TempDir, ToolContext) {
    let root = tempfile::tempdir().unwrap();
    let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
        .with_tool_call_id("actual-reader-contract-call");
    (root, context)
}
fn reference() -> OfficeArtifactRef {
    OfficeArtifactRef {
        id: "owned-artifact-r1".into(),
        revision: 1,
    }
}
fn metadata() -> OfficeCanonicalSourceReadParams {
    OfficeCanonicalSourceReadParams {
        reference: reference(),
        metadata_only: true,
        expected_sha256: None,
        offset: 0,
        limit: OFFICE_CANONICAL_SOURCE_CHUNK_BYTES,
    }
}
fn descriptor() -> OfficeCanonicalSourceDescriptor {
    OfficeCanonicalSourceDescriptor {
        schema_version: 1,
        id: "native-source-r1".into(),
        revision: 1,
        owner: IntegrationOwner {
            account_id: "owner".into(),
            target_id: "target".into(),
            workspace_id: IntegrationNullable::Null,
            organization_id: None,
        },
        operation_id: "native-source-operation".into(),
        task: OfficeTaskRef {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            run_id: None,
        },
        artifact: reference(),
        output_sha256: "a".repeat(64),
        specification_sha256: "b".repeat(64),
        specification_bytes: 6,
        generator: OfficeGeneratorIdentity {
            component: "controlled-contract-fixture".into(),
            version: "1".into(),
            schema_revision: "office-generation/v1".into(),
            implementation_sha256: "c".repeat(64),
            dependency_lock_sha256: "d".repeat(64),
        },
        inputs: vec![],
        created_at_ms: 1,
    }
}
fn value(output: ToolOutput) -> Value {
    let ContentBlock::Text { text } = &output.content[0] else {
        panic!("text")
    };
    serde_json::from_str(text).unwrap()
}
use kcoder_types::ContentBlock;

#[tokio::test]
async fn metadata_is_the_default_and_body_pages_require_explicit_source_sha_offset_and_limit() {
    let reader = Arc::new(Reader {
        calls: Mutex::new(vec![]),
    });
    let tool = OfficeDataTool::new(reader.clone()).unwrap();
    let (_root, ctx) = context();
    let result = value(
        tool.call(
            json!({"action":"canonical_source","reference":reference()}),
            &ctx,
        )
        .await
        .unwrap(),
    );
    assert_eq!(result["availability"], "not_recorded");
    assert_eq!(result["chunk"], Value::Null);
    assert_eq!(result["coversEntireSource"], false);
    assert!(reader.calls.lock().unwrap()[0].metadata_only);
    let valid = json!({"action":"canonical_source","reference":reference(),"sourceRead":{"metadataOnly":false,"expectedSha256":"b".repeat(64),"offset":0,"limit":8192}});
    crate::validate_input_against_schema(&valid, &tool.input_schema()).unwrap();
    tool.call(valid.clone(), &ctx).await.unwrap();
    let params = reader.calls.lock().unwrap()[1].clone();
    assert!(!params.metadata_only);
    assert_eq!(params.limit, 8192);
    assert_eq!(params.offset, 0);
    let mut maximum = valid.clone();
    maximum["sourceRead"]["limit"] = json!(65536);
    tool.call(maximum, &ctx).await.unwrap();
    assert_eq!(reader.calls.lock().unwrap()[2].limit, 16384);
    let before = reader.calls.lock().unwrap().len();
    for property in ["expectedSha256", "offset", "limit"] {
        let mut input = valid.clone();
        input["sourceRead"]
            .as_object_mut()
            .unwrap()
            .remove(property);
        assert!(matches!(
            tool.call(input, &ctx).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    for limit in [0, 65537] {
        let mut input = valid.clone();
        input["sourceRead"]["limit"] = json!(limit);
        assert!(tool.call(input, &ctx).await.is_err());
    }
    for input in [
        json!({"action":"canonical_source","reference":reference(),"sourceRead":{"expectedSha256":"b".repeat(64)}}),
        json!({"action":"canonical_source","reference":reference(),"query":{"limit":1}}),
        json!({"action":"read_manifest","reference":reference(),"sourceRead":{"metadataOnly":true}}),
        json!({"action":"canonical_source","reference":reference(),"sourceRead":{"metadataOnly":true,"scope":"fake"}}),
    ] {
        assert!(tool.call(input, &ctx).await.is_err());
    }
    assert_eq!(reader.calls.lock().unwrap().len(), before);
    assert!(tool.is_read_only());
    assert!(!tool.is_concurrency_safe(&json!({})));
    let schema = tool.input_schema();
    assert_eq!(
        schema["definitions"]["CanonicalSourceReadOptions"]["properties"]["limit"]["maximum"],
        65536
    );
}
#[test]
fn end_of_page_is_not_misreported_as_the_complete_source() {
    let (_root, ctx) = context();
    let mut parameters = metadata();
    parameters.metadata_only = false;
    parameters.expected_sha256 = Some("b".repeat(64));
    parameters.offset = 3;
    parameters.limit = 3;
    let result = OfficeCanonicalSourceReadResult {
        availability: OfficeCanonicalSourceAvailability::Available,
        source: Some(descriptor()),
        chunk: Some("def".into()),
        offset: 3,
        next_offset: None,
        complete: true,
    };
    let result =
        value(source_output(serde_json::to_value(&result).unwrap(), &parameters, &ctx).unwrap());
    assert_eq!(result["complete"], true);
    assert_eq!(result["coversEntireSource"], false);
    assert_eq!(result["offset"], 3);
    assert_eq!(result["returnedBytes"], 3);
    parameters.offset = 0;
    parameters.limit = 6;
    let result = OfficeCanonicalSourceReadResult {
        availability: OfficeCanonicalSourceAvailability::Available,
        source: Some(descriptor()),
        chunk: Some("abcdef".into()),
        offset: 0,
        next_offset: None,
        complete: true,
    };
    let result =
        value(source_output(serde_json::to_value(&result).unwrap(), &parameters, &ctx).unwrap());
    assert_eq!(result["coversEntireSource"], true);
}
#[test]
fn mismatched_native_result_hash_reference_offsets_or_coverage_are_rejected() {
    let (_root, ctx) = context();
    let mut parameters = metadata();
    parameters.metadata_only = false;
    parameters.expected_sha256 = Some("b".repeat(64));
    parameters.limit = 3;
    let result = OfficeCanonicalSourceReadResult {
        availability: OfficeCanonicalSourceAvailability::Available,
        source: Some(descriptor()),
        chunk: Some("abc".into()),
        offset: 0,
        next_offset: Some(3),
        complete: false,
    };
    source_output(serde_json::to_value(&result).unwrap(), &parameters, &ctx).unwrap();
    for mutation in ["artifact", "sha", "offset", "next", "complete"] {
        let mut wrong = result.clone();
        match mutation {
            "artifact" => wrong.source.as_mut().unwrap().artifact.id = "different-artifact".into(),
            "sha" => wrong.source.as_mut().unwrap().specification_sha256 = "f".repeat(64),
            "offset" => wrong.offset = 1,
            "next" => wrong.next_offset = Some(4),
            "complete" => wrong.complete = true,
            _ => unreachable!(),
        }
        assert!(source_output(serde_json::to_value(&wrong).unwrap(), &parameters, &ctx).is_err());
    }
}
#[test]
fn over_budget_source_is_an_explicit_error_instead_of_truncated_json() {
    let (_root, mut ctx) = context();
    ctx.max_output_bytes = 20;
    let result = OfficeCanonicalSourceReadResult {
        availability: OfficeCanonicalSourceAvailability::Available,
        source: Some(descriptor()),
        chunk: None,
        offset: 0,
        next_offset: None,
        complete: false,
    };
    assert!(matches!(
        source_output(serde_json::to_value(result).unwrap(), &metadata(), &ctx),
        Err(ToolError::InvalidInput(_))
    ));
}
