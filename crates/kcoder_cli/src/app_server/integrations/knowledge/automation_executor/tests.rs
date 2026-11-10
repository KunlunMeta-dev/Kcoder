use super::super::{KnowledgePolicyEvaluator, KnowledgeResource};
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_state::integrations::knowledge::ApprovedAutomationConsent;
use std::sync::{
    Mutex,
    atomic::{AtomicU8, Ordering},
};
struct Policy;
impl KnowledgePolicyEvaluator for Policy {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Allow,
            policy_revision: "fixture-policy".into(),
            reason_code: "fixture".into(),
        })
    }
}
struct Port {
    enabled: bool,
    mode: AtomicU8,
    calls: Mutex<Vec<String>>,
}
#[async_trait::async_trait]
impl KnowledgeDependencyPort for Port {
    fn registered(&self, _: IntegrationPort, _: &str) -> bool {
        self.enabled
    }
    async fn call(
        &self,
        _: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        self.calls.lock().unwrap().push(method.into());
        let mode = self.mode.load(Ordering::SeqCst);
        if method == "cancelTask" && mode == 17 {
            // Decode with the same strict contract as the original Core pump.
            let reference: IntegrationRuntimeReadTaskParams =
                serde_json::from_value(Value::Object(request.payload.clone()))
                    .expect("D cancellation must use the original Core exact-reference contract");
            reference.validate().unwrap();
            assert_eq!(
                reference.thread_id.as_deref(),
                Some("fixture-native-thread")
            );
            assert!(reference.turn_id.is_none());
            assert_eq!(reference.task_id.as_deref(), Some("fixture-native-task"));
        }
        let (status, result) = match method {
            "acceptTask" if mode == 11 => (
                IntegrationStatus::Accepted,
                Some(
                    json!({"threadId":"fixture-native-thread","taskId":"fixture-native-task","state":"queued"}),
                ),
            ),
            "acceptTask" if mode == 6 => (
                IntegrationStatus::Accepted,
                Some(json!({"fabricatedReceipt":true})),
            ),
            "acceptTask" if mode == 1 => (IntegrationStatus::Unknown, None),
            "acceptTask" if mode == 5 => (IntegrationStatus::Rejected, None),
            "acceptTask" => (
                IntegrationStatus::Accepted,
                Some(
                    json!({"threadId":"fixture-native-thread","turnId":"fixture-native-turn","state":"queued"}),
                ),
            ),
            "readOperation" if mode == 13 => {
                (IntegrationStatus::Completed, Some(json!({"receipt":null})))
            }
            "readOperation" if mode == 14 || mode == 15 => {
                let mut receipt = json!({"operationId":request.payload["operationId"],"scope":request.scope,"port":"P-RUNTIME","method":"acceptTask","revision":1,"phase":"accepted","createdAtMs":2000,"updatedAtMs":2000,"entityRef":{"kind":"thread","id":"fixture-native-thread"},"error":null});
                if mode == 15 {
                    receipt["runtimeAcceptance"] = json!({"threadId":"fixture-native-thread","turnId":"fixture-native-turn","taskId":"fixture-native-task","state":"queued"});
                }
                (
                    IntegrationStatus::Completed,
                    Some(json!({"receipt":receipt})),
                )
            }
            "readOperation" => (IntegrationStatus::Unknown, None),
            "submitDelivery" | "readDelivery" if mode == 8 => (IntegrationStatus::Unknown, None),
            "submitDelivery" => {
                assert!(request.payload.get("parentOperationId").is_some());
                assert!(request.payload["destinationRef"].get("revision").is_some());
                (
                    IntegrationStatus::Accepted,
                    Some(
                        json!({"deliveryId":request.payload["deliveryId"],"deliveryState":"pending"}),
                    ),
                )
            }
            "readDelivery" => (
                IntegrationStatus::Completed,
                Some(
                    json!({"deliveryId":request.payload["deliveryId"],"deliveryState":"pending","cancelled":false,"receipt":null}),
                ),
            ),
            "cancelTask" => (
                IntegrationStatus::Accepted,
                Some(json!({"cancelRequested":true})),
            ),
            "readTask" => {
                let mut result = json!({"threadId":"fixture-native-thread","turnId":"fixture-native-turn","state":if mode==11||mode==12||mode==15{"running"}else if mode==9{"waiting_for_user"}else if mode==10{"cancelled"}else if mode>=3{"completed"}else{"running"},"artifactRefs":[]});
                if mode == 11 || mode == 15 {
                    result["taskId"] = json!("fixture-native-task");
                }
                if mode == 12 {
                    result["taskId"] = json!("fixture-other-task");
                }
                if mode == 15 {
                    assert_eq!(request.payload["turnId"], "fixture-native-turn");
                    assert_eq!(request.payload["taskId"], "fixture-native-task");
                }
                if mode == 4 {
                    result["output"] = json!("Synthetic completed report");
                }
                (IntegrationStatus::Completed, Some(result))
            }
            _ => (IntegrationStatus::Unavailable, None),
        };
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            status,
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: "2026-10-24T00:00:00Z".into(),
            result: result
                .map(|v| v.as_object().unwrap().clone())
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            error: IntegrationNullable::Null,
        }
    }
}
struct Fixture {
    store: AutomationStore,
    workflows: WorkflowStore,
    scope: IntegrationScope,
    sub: AutomationSubscription,
    _root: tempfile::TempDir,
}
fn fixture() -> Result<Fixture> {
    fixture_with_destination(AutomationDestination::Studio)
}
fn fixture_with_destination(delivery: AutomationDestination) -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope = serde_json::from_value(
        json!({"accountId":"fixture-account","targetId":"fixture-target","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}),
    )?;
    let workflows = WorkflowStore::new(root.path().join("workflows"));
    let flow = workflows.create("Synthetic workflow", "")?;
    let node = serde_json::from_value(
        json!({"id":"step","title":"Synthetic step","prompt":"Produce a synthetic report","maxTurns":1}),
    )?;
    let flow = workflows.upsert_node(&flow.id, flow.revision, node)?;
    let flow = workflows.save(&flow.id, flow.revision)?;
    let draft = AutomationSubscriptionDraft {
        id: "fixture-subscription".into(),
        title: "Synthetic subscription".into(),
        workflow_id: flow.id,
        workflow_version: flow.saved_version.unwrap(),
        model_selection: None,
        inputs: json!({}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 1 }),
        event_source: None,
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 10,
        delivery,
    };
    let store = AutomationStore::create(&root.path().join("automations"), &scope)?;
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "fixture-consent", &draft)?;
    let sub = store.save_subscription("save", 0, draft, &consent, Some(2000), 1000)?;
    Ok(Fixture {
        _root: root,
        store,
        workflows,
        scope,
        sub,
    })
}
fn request(f: &Fixture) -> Result<(IntegrationRequest, ApprovedSubscriptionTrigger)> {
    let proof = ApprovedSubscriptionTrigger::from_native_scheduler(&f.scope, &f.sub)?;
    let payload = serde_json::to_value(proof.params(json!({"scheduledAtMs":2000})))?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "fixture-call".into(),
        scope: f.scope.clone(),
        operation_id: Some("fixture-tick".into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    };
    Ok((request, proof))
}
fn run(reply: &IntegrationReply) -> Result<AutomationRun> {
    Ok(serde_json::from_value(
        reply.result.as_ref().unwrap()["run"].clone(),
    )?)
}
#[tokio::test]
async fn missing_native_driver_does_not_create_a_run() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: false,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let reply = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(reply.status, IntegrationStatus::Unavailable);
    assert!(f.store.list_runs(None)?.items.is_empty());
    assert!(port.calls.lock().unwrap().is_empty());
    Ok(())
}
#[tokio::test]
async fn native_acceptance_is_not_completion_and_duplicate_trigger_reads_original() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let reply = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let accepted = run(&reply)?;
    assert_eq!(accepted.status, AutomationRunStatus::Accepted);
    assert_eq!(accepted.delivery_status, AutomationDeliveryStatus::NotReady);
    let again = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&again)?.status, AutomationRunStatus::Running);
    assert_eq!(*port.calls.lock().unwrap(), vec!["acceptTask", "readTask"]);
    Ok(())
}
#[tokio::test]
async fn lost_native_ack_is_reconciled_without_resubmission() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(1),
        calls: Mutex::new(vec![]),
    };
    let first = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&first)?.status, AutomationRunStatus::Unknown);
    let reopened = AutomationStore::open(&f._root.path().join("automations"), &f.scope)?;
    let second = trigger_approved_subscription(
        &request,
        &ctx,
        &reopened,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&second)?.status, AutomationRunStatus::Unknown);
    assert_eq!(
        *port.calls.lock().unwrap(),
        vec!["acceptTask", "readOperation"]
    );
    Ok(())
}
#[tokio::test]
async fn completed_read_requires_real_output_before_studio_inbox() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let first = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let accepted = run(&first)?;
    port.mode.store(3, Ordering::SeqCst);
    let read = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &accepted.id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&read)?.status, AutomationRunStatus::Unknown);
    assert_eq!(
        run(&read)?.delivery_status,
        AutomationDeliveryStatus::NotReady
    );
    port.mode.store(4, Ordering::SeqCst);
    let read = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &accepted.id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&read)?.status, AutomationRunStatus::Completed);
    assert_eq!(
        run(&read)?.delivery_status,
        AutomationDeliveryStatus::StudioAvailable
    );
    Ok(())
}
#[tokio::test]
async fn cancellation_before_submission_keeps_ledger_empty() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let cancel = CancellationToken::new();
    cancel.cancel();
    trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &cancel,
    )
    .await;
    assert!(f.store.list_runs(None)?.items.is_empty());
    assert!(port.calls.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn malformed_native_acceptance_is_unknown_not_a_safe_retry() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(6),
        calls: Mutex::new(vec![]),
    };
    let first = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&first)?.status, AutomationRunStatus::Unknown);
    trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        *port.calls.lock().unwrap(),
        vec!["acceptTask", "readOperation"]
    );
    Ok(())
}

#[tokio::test]
async fn external_outbox_acceptance_is_not_platform_delivery_and_does_not_resubmit() -> Result<()> {
    use super::super::deliver_automation_run;
    let f = fixture_with_destination(AutomationDestination::Channel {
        destination_ref: "approved-fixture-destination".into(),
        destination_revision: "1".into(),
    })?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let accepted = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let id = run(&accepted)?.id;
    port.mode.store(4, Ordering::SeqCst);
    refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    port.mode.store(7, Ordering::SeqCst);
    let delivered = deliver_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&delivered)?.status, AutomationRunStatus::Completed);
    assert_eq!(
        run(&delivered)?.delivery_status,
        AutomationDeliveryStatus::Pending
    );
    deliver_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        port.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.as_str() == "submitDelivery")
            .count(),
        1
    );
    assert_eq!(port.calls.lock().unwrap().last().unwrap(), "readDelivery");
    Ok(())
}
#[tokio::test]
async fn lost_external_ack_remains_unknown_and_only_original_delivery_is_read() -> Result<()> {
    use super::super::deliver_automation_run;
    let f = fixture_with_destination(AutomationDestination::Channel {
        destination_ref: "approved-fixture-destination".into(),
        destination_revision: "1".into(),
    })?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let accepted = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let id = run(&accepted)?.id;
    port.mode.store(4, Ordering::SeqCst);
    refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    port.mode.store(8, Ordering::SeqCst);
    let first = deliver_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        run(&first)?.delivery_status,
        AutomationDeliveryStatus::Unknown
    );
    let original_id = run(&first)?.delivery_id;
    let second = deliver_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&second)?.delivery_id, original_id);
    assert_eq!(
        port.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.as_str() == "submitDelivery")
            .count(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn waiting_and_cancel_acceptance_are_not_completion_or_terminal_cancellation() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: true,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let accepted = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let id = run(&accepted)?.id;
    port.mode.store(9, Ordering::SeqCst);
    let waiting = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&waiting)?.status, AutomationRunStatus::Waiting);
    assert_eq!(
        run(&waiting)?.delivery_status,
        AutomationDeliveryStatus::NotReady
    );
    let cancel = cancel_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&cancel)?.status, AutomationRunStatus::Unknown);
    port.mode.store(10, Ordering::SeqCst);
    let terminal = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&terminal)?.status, AutomationRunStatus::Cancelled);
    assert!(f.store.read_subscription(&f.sub.draft.id)?.enabled);
    Ok(())
}

#[tokio::test]
async fn task_only_acceptance_persists_exact_id_and_rejects_another_task_in_same_thread()
-> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(11),
        calls: Mutex::new(vec![]),
    };
    let first = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let id = run(&first)?.id;
    assert_eq!(
        f.store
            .read_native_acceptance(&id)?
            .unwrap()
            .task_id
            .as_deref(),
        Some("fixture-native-task")
    );
    let actual = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&actual)?.status, AutomationRunStatus::Running);
    port.mode.store(12, Ordering::SeqCst);
    let wrong = refresh_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &id,
        &CancellationToken::new(),
    )
    .await;
    assert_ne!(wrong.status, IntegrationStatus::Completed);
    assert_eq!(f.store.read_run(&id)?.status, AutomationRunStatus::Running);
    Ok(())
}
#[tokio::test]
async fn null_or_legacy_receipts_never_read_the_latest_thread_turn() -> Result<()> {
    for observed in [13, 14] {
        let f = fixture()?;
        let (request, proof) = request(&f)?;
        let policy = Policy;
        let ctx = KnowledgeHostContext {
            scope: &f.scope,
            now_ms: 2000,
            explicit_user_action: false,
            policy: &policy,
        };
        let port = Port {
            enabled: true,
            mode: AtomicU8::new(1),
            calls: Mutex::new(vec![]),
        };
        trigger_approved_subscription(
            &request,
            &ctx,
            &f.store,
            &f.workflows,
            &port,
            &proof,
            &CancellationToken::new(),
        )
        .await;
        port.mode.store(observed, Ordering::SeqCst);
        let reconciled = trigger_approved_subscription(
            &request,
            &ctx,
            &f.store,
            &f.workflows,
            &port,
            &proof,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(run(&reconciled)?.status, AutomationRunStatus::Unknown);
        assert_eq!(
            *port.calls.lock().unwrap(),
            vec!["acceptTask", "readOperation"]
        );
    }
    Ok(())
}
#[tokio::test]
async fn lost_ack_recovery_uses_frozen_runtime_acceptance_in_authoritative_receipt() -> Result<()> {
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(1),
        calls: Mutex::new(vec![]),
    };
    trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    port.mode.store(15, Ordering::SeqCst);
    let reconciled = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run(&reconciled)?.status, AutomationRunStatus::Running);
    assert_eq!(
        *port.calls.lock().unwrap(),
        vec!["acceptTask", "readOperation", "readTask"]
    );
    Ok(())
}
#[test]
fn owned_async_trigger_future_is_send_for_native_dispatch() -> Result<()> {
    fn require_send<T: Send>(_: T) {}
    let f = fixture()?;
    let (request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: false,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(0),
        calls: Mutex::new(vec![]),
    };
    let cancel = CancellationToken::new();
    require_send(trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &cancel,
    ));
    assert!(f.store.list_runs(None)?.items.is_empty());
    Ok(())
}

#[tokio::test]
async fn task_only_cancel_uses_the_original_strict_core_reference_without_extra_fields()
-> Result<()> {
    let f = fixture()?;
    let (mut request, proof) = request(&f)?;
    let policy = Policy;
    let ctx = KnowledgeHostContext {
        scope: &f.scope,
        now_ms: 2000,
        explicit_user_action: true,
        policy: &policy,
    };
    let port = Port {
        enabled: true,
        mode: AtomicU8::new(11),
        calls: Mutex::new(vec![]),
    };
    let accepted = trigger_approved_subscription(
        &request,
        &ctx,
        &f.store,
        &f.workflows,
        &port,
        &proof,
        &CancellationToken::new(),
    )
    .await;
    let original = run(&accepted)?;
    assert!(original.native_turn_id.is_none());
    port.mode.store(17, Ordering::SeqCst);
    request.operation_id = Some("explicit-original-task-cancel".into());
    request.payload = json!({"runId":original.id}).as_object().unwrap().clone();
    let reply = cancel_automation_run(
        &request,
        &ctx,
        &f.store,
        &port,
        &original.id,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(reply.status, IntegrationStatus::Completed);
    // A valid request acceptance still is not confirmed terminal cancellation.
    assert_eq!(run(&reply)?.status, AutomationRunStatus::Unknown);
    assert_eq!(*port.calls.lock().unwrap(), ["acceptTask", "cancelTask"]);
    assert!(f.store.read_subscription(&f.sub.draft.id)?.enabled);
    Ok(())
}
