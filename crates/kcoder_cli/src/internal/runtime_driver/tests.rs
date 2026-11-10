use super::*;
use kcoder_app_protocol::UserInput;
use kcoder_config::PrivateDirectory;
use kcoder_types::StudioWorkMode;
use serde_json::json;

#[test]
fn restored_driver_retains_rejected_input_without_issuing_a_command() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = PrivateDirectory::open_existing(temp.path())?;
    root.create_private_child(OsStr::new("profile"))?;
    root.create_private_child(OsStr::new("workspace"))?;
    let context = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "test-connection",
        "test-configuration",
    )?;
    let operation = "paused-original-input";
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "runtime-test-request".into(),
        scope: context.scope().clone(),
        operation_id: Some(operation.into()),
        expected_revision: None,
        timeout_ms: INTEGRATION_MAX_WAIT_MS,
        cancellation_ref: None,
        payload: json!({
            "source": {"kind":"office_assistant","assistantId":"fixed-template","version":1},
            "message": {"text":"Process original input"}
        })
        .as_object()
        .unwrap()
        .clone(),
    };
    let model = serde_json::from_value(json!({
        "modelId":"fixture","chatProtocol":"auto","requestOutputLimits":{},
        "text":true,"tools":false,"vision":false,"reasoning":false,"structuredOutput":false,
        "extraBodyConfigured":false,"requestOverrideFields":[],
        "revision":"fixture-model-revision","boundary":"session_snapshot","sources":{}
    }))?;
    let spec = PreparedRuntimeTask {
        input: vec![UserInput::Text {
            text: "Process original input".into(),
        }],
        studio_work_mode: StudioWorkMode::Kcoder,
        configuration: RuntimeExecutionConfiguration {
            model: IntegrationModelResolutionResult {
                selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                model,
                policy_ref: IntegrationNullable::Null,
                budget: IntegrationModelBudget {
                    reservation_state: IntegrationBudgetReservationState::NotReserved,
                    cost_known: false,
                },
            },
            allowed_tools: Some(Vec::new()),
            external_send: RuntimeExternalSend::Deny,
            workflow: None,
        },
        existing_thread_id: Some("original-task".into()),
        client_presentation: None,
    };
    let mut driver = NativeRuntimeDriver::initialize(&context, "test-runtime-initialization")?;
    assert!(matches!(
        driver.accept_task(&context, &request, spec)?,
        RuntimeSubmission::Queued
    ));
    driver.reject_queued_with_reason(&context, operation, "SESSION_PAUSED_NO_CLIENT")?;
    drop(driver);

    let mut restored = NativeRuntimeDriver::load(&context)?.context("driver disappeared")?;
    assert!(restored.next_command(&context)?.is_none());
    let receipt = restored
        .read_operation(&context, operation)?
        .context("receipt disappeared")?;
    assert_eq!(receipt.phase, IntegrationOperationPhase::Rejected);
    assert!(receipt.runtime_acceptance.is_none());
    assert_eq!(
        receipt.error.context("rejection missing")?.code,
        "SESSION_PAUSED_NO_CLIENT"
    );
    Ok(())
}
