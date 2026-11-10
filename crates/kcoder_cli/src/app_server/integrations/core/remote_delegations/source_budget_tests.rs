//! Real private Accepted/P-RUNTIME/BudgetStore composition; authorization installers below are explicit test PDP fixtures.
use super::*;
use crate::app_server::{
    integrations::core::runtime_driver::*,
    thread_runtime::{ThreadManager, test_support::test_runtime},
};
use kcoder_app_protocol::UserInput;
use kcoder_config::PrivateDirectory;
use kcoder_state::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptStore};
use kcoder_types::{StudioWorkMode, TurnAttemptStatus};
use serde_json::json;
use std::ffi::OsStr;

pub(in crate::app_server::integrations::core::remote_delegations) struct Fixture {
    _temp: tempfile::TempDir,
    pub(in crate::app_server::integrations::core::remote_delegations) native:
        NativeIntegrationContext,
    pub(in crate::app_server::integrations::core::remote_delegations) engine: QueryEngine,
    pub(in crate::app_server::integrations::core::remote_delegations) attempt: TurnAttemptIdentity,
    manager: ThreadManager,
    root: String,
}
struct TestInstaller;
impl NativeRuntimePolicyInstaller for TestInstaller {
    fn install(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        spec: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        native.validate_scope(&request.scope)?;
        spec.validate()?;
        Ok(engine)
    }
}
impl Fixture {
    pub(in crate::app_server::integrations::core::remote_delegations) fn new() -> Self {
        Self::with_provider(None)
    }
    pub(in crate::app_server::integrations::core::remote_delegations) fn new_with_provider(
        provider: Arc<dyn kcoder_api::Provider>,
    ) -> Self {
        Self::with_provider(Some(provider))
    }
    fn with_provider(provider: Option<Arc<dyn kcoder_api::Provider>>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let native = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "actual-budget-source",
            "config-1",
        )
        .unwrap();
        let runtime = match provider {
            Some(provider) => {
                crate::app_server::thread_runtime::test_support::test_runtime_with_provider(
                    &workspace.join("history.jsonl"),
                    provider,
                )
            }
            None => test_runtime("remote-source-budget", &workspace.join("history.jsonl")),
        };
        let engine = runtime
            .engine()
            .with_settings_persistence_path(profile.join("settings.json"));
        engine
            .state
            .with_history_path(workspace.join("history.jsonl"));
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let attempt = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "actual-native-budget-source-turn".into(),
            attempt_id: "actual-native-budget-source-attempt".into(),
        };
        TurnAttemptStore::open(
            &engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )
        .unwrap()
        .begin(TurnAttemptRecord {
            version: 1,
            identity: attempt.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: now().unwrap(),
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
            client_presentation: None,
        })
        .unwrap();
        let root = "actual-original-runtime-task".to_owned();
        Self {
            _temp: temp,
            native,
            engine,
            attempt,
            manager,
            root,
        }
    }
    fn caller(&self) -> ToolContext {
        ToolContext::new(self.engine.state.clone())
            .with_tool_call_id("actual-current-remote-tool-call")
    }
    fn accept_runtime(&mut self) {
        self.accept_runtime_with_policy(RuntimeExternalSend::Deny);
    }
    pub(in crate::app_server::integrations::core::remote_delegations) fn accept_runtime_with_policy(
        &mut self,
        external_send: RuntimeExternalSend,
    ) {
        let mut driver = NativeRuntimeDriver::initialize(&self.native, &self.root).unwrap();
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "actual-root-runtime-request".into(),
            scope: self.native.scope().clone(),
            operation_id: Some(self.root.clone()),
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: Default::default(),
        };
        let spec = PreparedRuntimeTask {
            input: vec![UserInput::Text {
                text: "Actual native root task".into(),
            }],
            studio_work_mode: StudioWorkMode::Kcoder,
            existing_thread_id: Some(self.attempt.thread_id.clone()),
            client_presentation: None,
            configuration: RuntimeExecutionConfiguration {
                model: IntegrationModelResolutionResult {
                    selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                    model: self.engine.active_model_configuration_summary().unwrap(),
                    policy_ref: IntegrationNullable::Null,
                    budget: IntegrationModelBudget {
                        reservation_state: IntegrationBudgetReservationState::NotReserved,
                        cost_known: false,
                    },
                },
                allowed_tools: None,
                external_send,
                workflow: None,
            },
        };
        driver.accept_task(&self.native, &request, spec).unwrap();
        let configure = driver.next_command(&self.native).unwrap().unwrap();
        driver
            .configure_command(
                &self.native,
                configure.ticket(),
                &mut self.manager,
                Some(&TestInstaller),
            )
            .unwrap();
        let dispatch = driver.next_command(&self.native).unwrap().unwrap();
        driver.observe_response(&self.native,dispatch.ticket(),&json!({"result":{"turn":{"id":self.attempt.turn_id,"threadId":self.attempt.thread_id,"status":"running"}}})).unwrap();
    }
    fn install_original_budget(&self) -> Arc<NativeBudgetStore> {
        self.install_original_budget_with_tokens(100)
    }
    pub(in crate::app_server::integrations::core::remote_delegations) fn install_original_budget_with_tokens(
        &self,
        tokens: u64,
    ) -> Arc<NativeBudgetStore> {
        let service = NativeBudgetService::initialize(&self.native, &self.root).unwrap();
        let store = service.accounting_store();
        let policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: "actual-approved-account-budget".into(),
            version: 1,
            revision: "actual-policy-r1".into(),
            scope: BudgetScope::Account(self.native.scope().account_id.clone()),
            window: BudgetWindow {
                id: "actual-window".into(),
                starts_at_ms: 0,
                ends_at_ms: u64::MAX,
            },
            limits: BudgetLimits {
                tokens: Some(tokens),
                model_calls: Some(2),
                concurrent_tasks: Some(1),
                concurrent_calls: Some(1),
                ..Default::default()
            },
            currency: None,
        })
        .unwrap();
        store
            .reserve(
                &NativeBudgetRequest {
                    reservation_id: "actual-original-slot".into(),
                    operation_id: self.root.clone(),
                    principal: NativeBudgetPrincipal::from_native_facts(
                        self.native.scope().account_id.clone(),
                        None,
                        self.native.scope().workspace_id.as_ref().cloned(),
                        None,
                    )
                    .unwrap(),
                    unit: BudgetUnit::TaskSlot,
                    task: BudgetTaskLink {
                        root_operation_id: self.root.clone(),
                        root_task: Some(IntegrationEntityRef {
                            kind: IntegrationEntityKind::Turn,
                            id: self.attempt.turn_id.clone(),
                            revision: None,
                        }),
                        actor: BudgetActor::Main,
                        actor_attempt_id: self.attempt.attempt_id.clone(),
                        parent_reservation_id: None,
                    },
                    estimate: BudgetCharge::zero(),
                },
                &[policy],
                now().unwrap(),
            )
            .unwrap();
        store
    }
    pub(in crate::app_server::integrations::core::remote_delegations) fn finish(&self) {
        TurnAttemptStore::open_existing(
            &self.engine.session_storage_dir_for(&self.attempt.thread_id),
            &self.attempt.thread_id,
        )
        .unwrap()
        .unwrap()
        .finish(
            &self.attempt,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: now().unwrap(),
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            },
        )
        .unwrap();
    }
    pub(in crate::app_server::integrations::core::remote_delegations) async fn close(mut self) {
        for runtime in self.manager.drain() {
            runtime.shutdown().await
        }
    }
}
#[tokio::test]
async fn real_source_accepted_runtime_and_original_slot_are_required_before_remote_credit() {
    let mut f = Fixture::new();
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            assert!(
                NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller())
                    .is_err()
            );
            f.accept_runtime();
            assert!(
                NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller())
                    .is_err()
            );
            let ledger = f.install_original_budget();
            let source =
                NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller())
                    .unwrap();
            let estimate = BudgetCharge {
                tokens: 40,
                model_calls: 1,
                run_millis: 1000,
                cost_micros: None,
            };
            let mut lease = source
                .reserve_actual_call("actual-native-receiver-model-call", estimate.clone())
                .unwrap();
            assert_eq!(
                lease.receipt().task.parent_reservation_id.as_deref(),
                Some("actual-original-slot")
            );
            assert_eq!(lease.receipt().task.root_operation_id, f.root);
            assert_eq!(
                lease.receipt().task.root_task.as_ref().unwrap().id,
                f.attempt.turn_id
            );
            lease.before_dispatch().unwrap();
            lease.check_current().unwrap();
            let id = lease.receipt().reservation_id.clone();
            drop(lease);
            let unknown = ledger.read_reservation(&id).unwrap().unwrap();
            assert_eq!(unknown.coverage, BudgetUsageCoverage::Unreported);
            assert_eq!(unknown.charged.tokens, 40);
            assert!(!unknown.execution_confirmed_terminal);
            assert!(
                source
                    .reserve_actual_call("actual-native-receiver-model-call", estimate.clone())
                    .is_err()
            );
            assert!(
                source
                    .reserve_actual_call("another-call", estimate)
                    .is_err()
            );
            f.finish();
            assert!(source.check_current().is_err());
        })
        .await;
    f.close().await;
}

#[tokio::test]
async fn ordinary_actual_accepted_uses_explicit_finite_policy_without_synthesizing_runtime_or_credit()
 {
    let f = Fixture::new();
    f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
        assert!(NativeRemoteSourceBudget::capture(&f.native,&f.engine,&f.attempt,&f.caller()).is_err());
        assert!(NativeBudgetService::load(&f.native).unwrap().is_none());
        f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"),&serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":1,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
        let source=NativeRemoteSourceBudget::capture(&f.native,&f.engine,&f.attempt,&f.caller()).unwrap();
        assert!(source.acceptance.is_none());
        assert!(NativeRuntimeDriver::load(&f.native).unwrap().is_none());
        assert!(NativeOperations::load(&f.native).unwrap().is_none());
        let mut lease=source.reserve_actual_call("actual-ordinary-native-call",BudgetCharge{tokens:40,model_calls:1,run_millis:1000,cost_micros:None}).unwrap();
        assert!(lease.receipt().task.parent_reservation_id.as_ref().unwrap().starts_with("remote-source-slot-"));
        assert_eq!(lease.receipt().task.root_operation_id,source.root_operation);
        lease.before_dispatch().unwrap();
        assert!(source.reserve_actual_call("second-actual-native-call",BudgetCharge{tokens:40,model_calls:1,run_millis:1000,cost_micros:None}).is_err());
        f.finish();
        source.settle_actual_source_terminal().unwrap();
        source.verify_retained_observation_owner().unwrap();
        assert!(source.reserve_actual_call("cannot-revive-terminal-task",BudgetCharge {tokens:1,model_calls:1,run_millis:1,cost_micros:None}).is_err());
        assert!(source.service.accounting_store().read_reservation(&source.parent.receipt().reservation_id).unwrap().unwrap().execution_confirmed_terminal);
        assert!(source.check_current().is_err());
        // Unknown dispatched model cost remains reserved; terminating the real
        // original task does not fabricate an unused-call refund.
        assert!(!source.service.accounting_store().read_reservation(&lease.receipt().reservation_id).unwrap().unwrap().execution_confirmed_terminal);
    }).await;
    f.close().await;
}

#[tokio::test]
async fn original_runtime_accepted_uses_same_finite_source_slot_and_same_goal_without_new_runtime()
{
    let mut f = Fixture::new();
    f.accept_runtime_with_policy(RuntimeExternalSend::Ask);
    let original = NativeOperations::load(&f.native)
        .unwrap()
        .unwrap()
        .read(&f.native, &f.root)
        .unwrap()
        .unwrap();
    f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,
        "outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":1,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
    let goal = f
        .engine
        .state
        .set_goal("original P-RUNTIME product Goal", Some(1000));
    assert!(NativeBudgetService::load(&f.native).unwrap().is_none());
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let owners = Mutex::new(Vec::new());
            let first =
                NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller())
                    .unwrap();
            first.bind_goal_for_original_owner(&owners).unwrap();
            first.require_delegation_policy().unwrap();
            assert_eq!(first.root_operation, f.root);
            assert!(first.acceptance.is_some());
            assert_eq!(first.parent.receipt().task.root_operation_id, f.root);
            assert_eq!(f.engine.state.goal().unwrap().tokens_used, 80);
            let slot = first.parent.receipt().reservation_id.clone();
            let second =
                NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller())
                    .unwrap();
            second.bind_goal_for_original_owner(&owners).unwrap();
            assert_eq!(second.parent.receipt().reservation_id, slot);
            assert_eq!(owners.lock().unwrap().len(), 1);
            assert_eq!(f.engine.state.goal().unwrap().tokens_used, 80);
            assert_eq!(
                NativeOperations::load(&f.native)
                    .unwrap()
                    .unwrap()
                    .read(&f.native, &f.root)
                    .unwrap()
                    .unwrap(),
                original
            );
            f.finish();
            first.settle_actual_source_terminal().unwrap();
            assert_eq!(f.engine.state.goal().unwrap().goal_id, goal.goal_id);
            assert_eq!(f.engine.state.goal().unwrap().tokens_used, 0);
            assert!(
                first
                    .service
                    .accounting_store()
                    .read_reservation(&slot)
                    .unwrap()
                    .unwrap()
                    .execution_confirmed_terminal
            );
        })
        .await;
    f.close().await;
}

#[tokio::test]
async fn original_runtime_denied_outbound_or_existing_foreign_slot_cannot_manufacture_goal_credit()
{
    for existing in [false, true] {
        let mut f = Fixture::new();
        f.accept_runtime_with_policy(if existing {
            RuntimeExternalSend::Ask
        } else {
            RuntimeExternalSend::Deny
        });
        let ledger = existing.then(|| f.install_original_budget_with_tokens(100));
        let before = ledger.as_ref().map(|ledger| {
            ledger
                .read_reservation("actual-original-slot")
                .unwrap()
                .unwrap()
        });
        f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,
            "outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":1,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
        f.engine
            .state
            .set_goal("no replacement original policy or slot", Some(1000));
        f.engine
            .state
            .history_attempt_scope(f.attempt.clone())
            .unwrap()
            .run(async {
                let owners = Mutex::new(Vec::new());
                let captured = NativeRemoteSourceBudget::capture(
                    &f.native,
                    &f.engine,
                    &f.attempt,
                    &f.caller(),
                );
                if existing {
                    let source = captured.unwrap();
                    assert!(source.bind_goal_for_original_owner(&owners).is_err());
                    assert_eq!(
                        ledger
                            .as_ref()
                            .unwrap()
                            .read_reservation("actual-original-slot")
                            .unwrap()
                            .unwrap(),
                        before.unwrap()
                    );
                    assert_eq!(f.engine.state.goal().unwrap().tokens_used, 0);
                } else {
                    assert!(captured.is_err());
                    assert!(NativeBudgetService::load(&f.native).unwrap().is_none());
                }
            })
            .await;
        f.close().await;
    }
}

#[tokio::test]
async fn authenticated_receiver_settlement_keeps_unknown_charge_and_never_grants_money_credit() {
    for completed in [false, true] {
        let f = Fixture::new();
        f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
            f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"),&serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":1,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
            let source=NativeRemoteSourceBudget::capture(&f.native,&f.engine,&f.attempt,&f.caller()).unwrap();
            let mut lease=source.reserve_actual_call("original-receiver-call",BudgetCharge{tokens:40,model_calls:1,run_millis:1000,cost_micros:None}).unwrap();
            lease.before_dispatch().unwrap();
            // This closed receipt is test data, not proof of an authenticated
            // Receiver. Production reaches this method only via its held owner.
            let receiver=NativeRemoteAcceptedFactsV1{identity:NativeRemoteTurnIdentityV1{thread_id:"receiver-thread".into(),turn_id:"receiver-turn".into(),attempt_id:"receiver-attempt".into()},accepted_input_sha256:"a".repeat(64),accepted_receipt_sha256:"b".repeat(64),receiver_scope:None,receiver_settings_sha256:"c".repeat(64)};
            assert!(lease.finish_authenticated_receiver_call("original-receiver-call",&receiver,NativeRemoteCallOutcomeV1::Completed,Some(BudgetCharge{tokens:9,model_calls:1,run_millis:20,cost_micros:Some(0)})).is_err());
            lease.finish_authenticated_receiver_call("original-receiver-call",&receiver,
                if completed{NativeRemoteCallOutcomeV1::Completed}else{NativeRemoteCallOutcomeV1::OutcomeUnknown},
                completed.then_some(BudgetCharge{tokens:9,model_calls:1,run_millis:20,cost_micros:None})).unwrap();
            assert_eq!(lease.receipt().charged.tokens,if completed{9}else{40});
            assert_eq!(lease.receipt().charged.model_calls,1);
            assert_eq!(lease.receipt().execution_confirmed_terminal,completed);
            assert_eq!(lease.receipt().charged.cost_micros,None);
            assert!(source.reserve_actual_call("original-receiver-call",BudgetCharge{tokens:40,model_calls:1,run_millis:1000,cost_micros:None}).is_err());
        }).await;
        f.close().await;
    }
}

#[tokio::test]
async fn owned_frame_tasks_revalidate_the_captured_source_without_borrowing_another_task_scope() {
    let f = Fixture::new();
    let source=f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
        f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"),&serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":1,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
        NativeRemoteSourceBudget::capture(&f.native,&f.engine,&f.attempt,&f.caller()).unwrap()
    }).await;
    assert!(source.check_current().is_err());
    assert!(
        NativeRemoteSourceBudget::capture(&f.native, &f.engine, &f.attempt, &f.caller()).is_err()
    );
    let captured = source.clone();
    tokio::spawn(async move { captured.require_owned_transport_policy() })
        .await
        .unwrap()
        .unwrap();
    let callback = source.clone();
    tokio::spawn(async move {
        let mut call = callback.reserve_owned_callback_call(
            "owned-pump-regression",
            BudgetCharge {
                tokens: 10,
                model_calls: 1,
                run_millis: 1000,
                cost_micros: None,
            },
        )?;
        call.dispatch_owned_callback_call()?;
        Ok::<_, anyhow::Error>(())
    })
    .await
    .unwrap()
    .expect("Actual captured owner must support the original spawned private callback");
    f.finish();
    assert!(source.require_owned_transport_policy().is_err());
    f.close().await;
}
