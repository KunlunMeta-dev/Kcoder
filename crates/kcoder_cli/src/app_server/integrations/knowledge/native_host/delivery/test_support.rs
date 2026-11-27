//! Declared D result fixtures for actual Main/SDK authorization tests, never execution success evidence.
use super::*;
use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;

pub(crate) struct NativeDeliveryTestFixture {
    pub(crate) host: Arc<NativeKnowledgeHost>,
    pub(crate) submit_use: Arc<NativeAutomationDeliveryUse>,
}
impl NativeDeliveryTestFixture {
    /// Read/control proofs retain the original result and pass the production factory.
    pub(crate) fn original_use(
        &self,
        method: &str,
        operation: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Arc<NativeAutomationDeliveryUse>> {
        ensure!(
            matches!(
                method,
                "readDelivery" | "cancelDelivery" | "reconcileDelivery"
            ),
            "FIXTURE_ORIGINAL_CONTROL_REQUIRED"
        );
        let original = self.submit_use.request();
        let request = IntegrationRequest {
            contract_version: original.contract_version,
            request_id: uuid::Uuid::new_v4().to_string(),
            scope: original.scope.clone(),
            operation_id: operation.map(str::to_owned),
            expected_revision: None,
            timeout_ms: 30_000,
            cancellation_ref: None,
            payload: json!({"deliveryId":original.payload["deliveryId"]})
                .as_object()
                .unwrap()
                .clone(),
        };
        self.host
            .delivery_use(method, &request, method != "readDelivery", cancel)
    }
}
impl Drop for NativeDeliveryTestFixture {
    fn drop(&mut self) {
        self.host.invalidate_runtime_sources();
    }
}

/// This creates a declared persisted result using real D guard/store APIs. It
/// does not execute Core/Workflow/model code and must never be reported as doing so.
pub(crate) fn native_delivery_test_fixture(
    native: &NativeIntegrationContext,
    destination: IntegrationRevisionRef,
    cancel: &CancellationToken,
) -> Result<NativeDeliveryTestFixture> {
    let host = Arc::new(NativeKnowledgeHost::new(
        native,
        KnowledgeIntegrationSettings {
            business_automation_enabled: true,
            ..Default::default()
        },
    )?);
    let id = uuid::Uuid::new_v4().to_string();
    let owned = host.initialize_automation(&format!("declared-d-fixture-initialize-{id}"))?;
    let draft = AutomationSubscriptionDraft {
        id: format!("declared-d-subscription-{id}"),
        title: "Declared D result fixture".into(),
        workflow_id: "declared-d-fixture-workflow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: None,
        event_source: Some("declared-d-fixture-source".into()),
        maximum_tokens: 1000,
        maximum_runtime_seconds: 30,
        period_budget: None,
        delivery: AutomationDestination::Channel {
            destination_ref: destination.id.clone(),
            destination_revision: destination.revision.clone(),
        },
    };
    let at = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    let consent = ApprovedAutomationConsent::from_explicit_user_action(
        native.scope(),
        &format!("declared-d-consent-{id}"),
        &draft,
    )?;
    owned.store.save_subscription(
        &format!("declared-d-save-{id}"),
        0,
        draft.clone(),
        &consent,
        None,
        at,
    )?;
    let run = owned.store.prepare_run(
        &draft.id,
        1,
        &format!("declared-d-trigger-{id}"),
        json!({"fixture":"declared-result-only"}),
        None,
        at,
    )?;
    owned.store.record_native_acceptance(
        &run.id,
        &format!("declared-d-thread-{id}"),
        Some(&format!("declared-d-turn-{id}")),
        at,
    )?;
    owned.store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Declared D result; not actual Core execution evidence".into()),
        vec![],
        at,
    )?;
    let run = owned.store.record_delivery(
        &run.id,
        &format!("delivery-{}", run.id),
        AutomationDeliveryStatus::Pending,
        at,
    )?;
    let delivery_id = run.delivery_id.as_deref().unwrap();
    let payload = super::super::super::automation_delivery::original_delivery_payload(
        &owned.store,
        &run,
        delivery_id,
        &destination.id,
        &destination.revision,
    )?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: native.scope().clone(),
        operation_id: Some(format!("submit-{delivery_id}")),
        expected_revision: None,
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    };
    let submit_use = host.delivery_use("submitDelivery", &request, false, cancel)?;
    Ok(NativeDeliveryTestFixture { host, submit_use })
}

#[test]
fn declared_result_fixture_uses_production_proofs_and_drop_revokes_only_its_owned_use() -> Result<()>
{
    let native =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let cancel = CancellationToken::new();
    let fixture = native_delivery_test_fixture(
        &native.context,
        IntegrationRevisionRef {
            id: "declared-existing-destination".into(),
            revision: "1".into(),
        },
        &cancel,
    )?;
    let submit = fixture.submit_use.clone();
    submit.verify_current(&native.context)?;
    let read = fixture.original_use("readDelivery", None, &cancel)?;
    assert_eq!(read.method(), "readDelivery");
    assert_eq!(read.original_payload()?, submit.original_payload()?);
    assert!(read.request().operation_id.is_none());
    drop(fixture);
    assert!(submit.verify_current(&native.context).is_err());
    assert!(read.verify_current(&native.context).is_err());
    Ok(())
}
