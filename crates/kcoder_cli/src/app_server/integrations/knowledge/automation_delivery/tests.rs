use super::super::{KnowledgePolicyEvaluator, KnowledgeResource};
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;
use std::sync::Mutex;
struct Policy;
impl KnowledgePolicyEvaluator for Policy {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &KnowledgeResource,
    ) -> anyhow::Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Allow,
            policy_revision: "fixture-policy".into(),
            reason_code: "fixture".into(),
        })
    }
}
struct Port {
    mode: Mutex<u8>,
    calls: Mutex<Vec<String>>,
}
#[async_trait::async_trait]
impl KnowledgeDependencyPort for Port {
    fn registered(&self, _: IntegrationPort, _: &str) -> bool {
        *self.mode.lock().unwrap() != 0
    }
    async fn call(
        &self,
        _: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        self.calls.lock().unwrap().push(method.into());
        let mode = *self.mode.lock().unwrap();
        let status = if mode == 3 {
            IntegrationStatus::Rejected
        } else if method == "submitDelivery" || mode == 1 {
            IntegrationStatus::Accepted
        } else {
            IntegrationStatus::Completed
        };
        let state = if mode == 2 { "cancelled" } else { "pending" };
        let result = json!({"deliveryId":request.payload["deliveryId"],"deliveryState":state,"cancelled":mode==2,"receipt":null});
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: "2026-10-24T00:00:00Z".into(),
            status,
            result: if mode == 3 {
                IntegrationNullable::Null
            } else {
                IntegrationNullable::Value(result.as_object().unwrap().clone())
            },
            error: if mode == 3 {
                IntegrationNullable::Value(IntegrationError {
                    code: "PLATFORM_QUERY_UNSUPPORTED".into(),
                    message_key: "safe".into(),
                    recovery: IntegrationRecovery::ExplicitUserDecision,
                })
            } else {
                IntegrationNullable::Null
            },
        }
    }
}
fn setup() -> anyhow::Result<(
    tempfile::TempDir,
    AutomationStore,
    IntegrationRequest,
    String,
)> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope = serde_json::from_value(
        json!({"accountId":"fixture","targetId":"local","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}),
    )?;
    let store = AutomationStore::create(&root.path().join("automation"), &scope)?;
    let draft = AutomationSubscriptionDraft {
        id: "fixture-sub".into(),
        title: "Fixture report".into(),
        workflow_id: "fixture-flow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: None,
        event_source: Some("fixture-event-source".into()),
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 10,
        delivery: AutomationDestination::Channel {
            destination_ref: "fixture-destination".into(),
            destination_revision: "1".into(),
        },
    };
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "fixture-consent", &draft)?;
    store.save_subscription("save", 0, draft, &consent, None, 100)?;
    let run = store.prepare_run("fixture-sub", 1, "event-1", json!({}), None, 200)?;
    store.record_native_acceptance(
        &run.id,
        "fixture-native-thread",
        Some("fixture-native-turn"),
        201,
    )?;
    store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Actual fixture result".into()),
        vec![],
        202,
    )?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "fixture-call".into(),
        scope,
        operation_id: Some("fixture-delivery-op".into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: json!({"runId":run.id}).as_object().unwrap().clone(),
    };
    Ok((root, store, request, run.id))
}
#[tokio::test]
async fn cancellation_acceptance_is_not_terminal_cancel_and_does_not_stop_subscription()
-> anyhow::Result<()> {
    let (_root, store, request, id) = setup()?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 300,
        explicit_user_action: true,
        policy: &policy,
    };
    let port = Port {
        mode: Mutex::new(1),
        calls: Mutex::new(vec![]),
    };
    deliver_automation_run(
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    control_automation_delivery(
        "cancelDelivery",
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        store.read_run(&id)?.delivery_status,
        AutomationDeliveryStatus::Pending
    );
    *port.mode.lock().unwrap() = 2;
    deliver_automation_run(
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        store.read_run(&id)?.delivery_status,
        AutomationDeliveryStatus::Cancelled
    );
    assert_eq!(store.read_run(&id)?.status, AutomationRunStatus::Completed);
    assert!(store.read_subscription("fixture-sub")?.enabled);
    Ok(())
}
#[tokio::test]
async fn unsupported_reconciliation_requires_explicit_decision_and_never_sends_again()
-> anyhow::Result<()> {
    let (_root, store, request, id) = setup()?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 300,
        explicit_user_action: true,
        policy: &policy,
    };
    let port = Port {
        mode: Mutex::new(1),
        calls: Mutex::new(vec![]),
    };
    deliver_automation_run(
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    *port.mode.lock().unwrap() = 3;
    let result = control_automation_delivery(
        "reconcileDelivery",
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        result.error.as_ref().unwrap().recovery,
        IntegrationRecovery::ExplicitUserDecision
    );
    assert_eq!(
        *port.calls.lock().unwrap(),
        vec!["submitDelivery", "reconcileDelivery"]
    );
    assert_eq!(
        store.read_run(&id)?.output.as_deref(),
        Some("Actual fixture result")
    );
    Ok(())
}
#[tokio::test]
async fn missing_driver_or_missing_explicit_action_cannot_cancel_another_effect()
-> anyhow::Result<()> {
    let (_root, store, request, id) = setup()?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 300,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        mode: Mutex::new(1),
        calls: Mutex::new(vec![]),
    };
    let result = control_automation_delivery(
        "cancelDelivery",
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(result.status, IntegrationStatus::Rejected);
    assert!(port.calls.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn original_tick_delivers_hidden_results_and_reopens_unknown_by_the_same_receipt_without_resubmission()
-> anyhow::Result<()> {
    let (root, store, mut request, id) = setup()?;
    request.operation_id = None;
    store.hide_run("explicit-hide-history", &id)?;
    assert!(store.list_runs(None)?.items.is_empty());
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 300,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        mode: Mutex::new(1),
        calls: Mutex::new(vec![]),
    };
    let (replies, next) = process_pending_deliveries(
        &request,
        &ctx,
        &store,
        &port,
        None,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].status, IntegrationStatus::Completed);
    assert_eq!(next, None);
    let delivery_id = store.read_run(&id)?.delivery_id.unwrap();
    store.record_delivery(&id, &delivery_id, AutomationDeliveryStatus::Unknown, 301)?;
    let reopened = AutomationStore::open(&root.path().join("automation"), &request.scope)?;
    process_pending_deliveries(
        &request,
        &ctx,
        &reopened,
        &port,
        None,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(
        *port.calls.lock().unwrap(),
        ["submitDelivery", "readDelivery"]
    );
    assert_eq!(
        reopened.read_run(&id)?.delivery_id.as_deref(),
        Some(delivery_id.as_str())
    );
    assert_eq!(
        reopened.read_run(&id)?.status,
        AutomationRunStatus::Completed
    );
    *port.mode.lock().unwrap() = 2;
    process_pending_deliveries(
        &request,
        &ctx,
        &reopened,
        &port,
        None,
        &CancellationToken::new(),
    )
    .await?;
    assert!(reopened.pending_delivery_runs(None)?.items.is_empty());
    assert!(reopened.read_subscription("fixture-sub")?.enabled);
    Ok(())
}

#[tokio::test]
async fn denied_original_receipt_read_cannot_claim_an_existing_external_effect_failed_or_send_it_again()
-> anyhow::Result<()> {
    let (_root, store, request, id) = setup()?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &request.scope,
        now_ms: 300,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        mode: Mutex::new(1),
        calls: Mutex::new(vec![]),
    };
    deliver_automation_run(
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    *port.mode.lock().unwrap() = 3;
    deliver_automation_run(
        &request,
        &ctx,
        &store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        store.read_run(&id)?.delivery_status,
        AutomationDeliveryStatus::Unknown
    );
    assert_eq!(store.read_run(&id)?.status, AutomationRunStatus::Completed);
    assert_eq!(
        *port.calls.lock().unwrap(),
        ["submitDelivery", "readDelivery"]
    );
    Ok(())
}
