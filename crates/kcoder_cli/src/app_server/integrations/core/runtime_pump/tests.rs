//! Real stores, resident Engine and pure JS workflows; source policy is an explicit fixture.
use super::super::runtime_driver::test_support::{Fixture, FixtureInstaller, resident, shutdown};
use super::*;
use kcoder_tools::{ToolRegistry, workflow::WorkflowTool};
use std::sync::atomic::{AtomicBool, Ordering};
mod controls;

struct FixtureAuthority {
    enabled: AtomicBool,
    installer: FixtureInstaller,
    observed: std::sync::Mutex<Vec<(String, IntegrationTaskState)>>,
}
impl NativeRuntimeAuthority for FixtureAuthority {
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.verify()?;
        self.verify_before_admission_commit(context, original, prepared)
    }
    fn verify_before_admission_commit(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.check_captured_scope(&original.scope)?;
        prepared.validate()?;
        ensure!(
            self.enabled.load(Ordering::SeqCst),
            "fixture authority revoked"
        );
        Ok(())
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        &self.installer
    }
    fn observe_task(
        &self,
        _context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        self.observed
            .lock()
            .unwrap()
            .push((original.operation_id.clone().unwrap(), task.state));
        Ok(())
    }
}
fn authority() -> Arc<FixtureAuthority> {
    Arc::new(FixtureAuthority {
        enabled: AtomicBool::new(true),
        installer: FixtureInstaller,
        observed: std::sync::Mutex::new(vec![]),
    })
}

#[tokio::test]
async fn warm_admission_verifies_caller_once_and_rejects_changed_workspace() {
    let fixture = Fixture::new();
    let (mut pump, _client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    pump.driver = Some(NativeRuntimeDriver::initialize(&context, "runtime-init").unwrap());
    let submit = |pump: &mut NativeRuntimePump, operation| {
        let (reply, _response) = oneshot::channel();
        pump.accept_control(Admission {
            context: context.clone(),
            request: fixture.request(operation),
            prepared: fixture.spec(),
            authority: authority(),
            reply,
        })
    };

    let before = context.identity_checks();
    submit(&mut pump, "original").unwrap();
    assert_eq!(context.identity_checks() - before, 1);
    assert!(pump.active.contains_key("original"));

    let old_workspace = fixture.workspace.with_extension("original");
    std::fs::rename(&fixture.workspace, &old_workspace).unwrap();
    std::fs::create_dir(&fixture.workspace).unwrap();
    assert_eq!(
        submit(&mut pump, "stale").unwrap_err().1,
        "RUNTIME_ADMISSION_UNAVAILABLE"
    );
    std::fs::remove_dir(&fixture.workspace).unwrap();
    std::fs::rename(old_workspace, &fixture.workspace).unwrap();
    assert!(!pump.active.contains_key("stale"));
    assert!(
        pump.driver
            .as_ref()
            .unwrap()
            .read_operation(&context, "stale")
            .unwrap()
            .is_none()
    );
}

async fn wait_for_admission(
    pump: &mut NativeRuntimePump,
    outbound: &mpsc::Sender<Value>,
    manager: &ThreadManager,
    operation: &str,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !pump.active.contains_key(operation) {
            let event = pump.receive().await;
            pump.observe(event, outbound, manager).await.unwrap();
        }
    })
    .await
    .expect("native control was not admitted before the bounded deadline");
}

async fn workflow_fixture(fixture: &Fixture) -> (ThreadManager, PreparedRuntimeTask) {
    workflow_fixture_node(fixture,json!({"id":"derive","title":"Derive","kind":"code","config":{"code":{"source":"return {answer: input.value * 2};"}}})).await
}
async fn workflow_fixture_node(
    fixture: &Fixture,
    node: Value,
) -> (ThreadManager, PreparedRuntimeTask) {
    let library =
        kcoder_workflow::store::WorkflowStore::new(fixture.profile.join("workflow-library"));
    let draft = library
        .create("Native pump", "Pure deterministic code; no provider calls")
        .unwrap();
    let node = serde_json::from_value(node).unwrap();
    let draft = library
        .upsert_node(&draft.id, draft.revision, node)
        .unwrap();
    let definition = library.save(&draft.id, draft.revision).unwrap();
    let (mut manager, engine) = resident(fixture).await;
    let engine = engine
        .with_turn_tools(ToolRegistry::new().register(WorkflowTool))
        .with_settings_persistence_path(fixture.profile.join("settings.json"));
    manager
        .replace_host_turn_engine(&engine.session_id(), engine.clone())
        .unwrap();
    let mut prepared = fixture.spec();
    prepared.existing_thread_id = Some(engine.session_id());
    prepared.configuration.model.model = engine.active_model_configuration_summary().unwrap();
    prepared.configuration.allowed_tools = Some(vec!["Workflow".into()]);
    prepared.configuration.workflow = Some(
        RuntimeWorkflowSpec::from_native_source(
            &fixture.context,
            &definition.id,
            1,
            json!({"value":6}),
        )
        .unwrap(),
    );
    (manager, prepared)
}

#[tokio::test]
async fn denied_native_authority_never_creates_an_operation_store() {
    let fixture = Fixture::new();
    let (pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let before = std::fs::read_dir(&fixture.profile).unwrap().count();
    let authority = authority();
    authority.enabled.store(false, Ordering::SeqCst);
    assert!(
        client
            .accept(
                context.clone(),
                fixture.request("denied"),
                fixture.spec(),
                authority
            )
            .await
            .is_err()
    );
    assert!(NativeRuntimeDriver::load(&context).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&fixture.profile).unwrap().count(), before);
    pump.close().await;
}

#[tokio::test]
async fn connection_pump_accepts_only_actual_workflow_run_and_reads_real_output() {
    let fixture = Fixture::new();
    let (mut manager, prepared) = workflow_fixture(&fixture).await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let request = fixture.request("real-pump-run");
    let original_request = request.clone();
    let api_context = context.clone();
    let caller = tokio::spawn(async move {
        client
            .accept(api_context, request, prepared, authority())
            .await
    });
    let (outbound, _) = mpsc::channel(64);
    wait_for_admission(&mut pump, &outbound, &manager, "real-pump-run").await;
    assert!(
        !caller.is_finished(),
        "queuing is not an accepted native task"
    );
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        while !caller.is_finished() {
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await.unwrap();
        }
    })
    .await
    .unwrap();
    let accepted = caller.await.unwrap().unwrap();
    accepted.validate().unwrap();
    assert_eq!(accepted.status, IntegrationStatus::Accepted);
    let acceptance: IntegrationRuntimeAcceptance =
        serde_json::from_value(Value::Object(accepted.result.as_ref().unwrap().clone())).unwrap();
    assert!(
        acceptance
            .task_id
            .as_ref()
            .unwrap()
            .starts_with("workflow-")
    );
    assert!(acceptance.turn_id.is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await.unwrap();
            let task = pump
                .driver
                .as_ref()
                .unwrap()
                .read_task(&context, original_request.operation_id.as_deref().unwrap())
                .unwrap();
            if task.state == IntegrationTaskState::Completed {
                assert!(task.output.unwrap().contains("12"));
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    pump.close().await;
    shutdown(manager).await;
}

#[tokio::test]
async fn waiting_budget_expiry_does_not_cancel_or_replay_the_queued_task() {
    let fixture = Fixture::new();
    let (mut manager, prepared) = workflow_fixture(&fixture).await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let mut request = fixture.request("short-wait");
    request.timeout_ms = 1;
    let api_context = context.clone();
    let caller = tokio::spawn(async move {
        client
            .accept(api_context, request, prepared, authority())
            .await
    });
    let (outbound, _) = mpsc::channel(64);
    wait_for_admission(&mut pump, &outbound, &manager, "short-wait").await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    pump.observe(RuntimePumpEvent::Tick, &outbound, &manager)
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), caller)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .status,
        IntegrationStatus::Unknown
    );
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await.unwrap();
            if pump
                .driver
                .as_ref()
                .unwrap()
                .read_task(&context, "short-wait")
                .is_ok_and(|task| task.state == IntegrationTaskState::Completed)
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    pump.close().await;
    shutdown(manager).await;
}

#[tokio::test]
async fn revoked_queued_admission_settles_rejected_and_does_not_block_a_peer() {
    let fixture = Fixture::new();
    let (mut manager, prepared) = workflow_fixture(&fixture).await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let revoked = authority();
    let first_ctx = context.clone();
    let first_client = client.clone();
    let first_spec = prepared.clone();
    let first_req = fixture.request("revoked");
    let first_auth = revoked.clone();
    let first = tokio::spawn(async move {
        first_client
            .accept(first_ctx, first_req, first_spec, first_auth)
            .await
    });
    let (outbound, _) = mpsc::channel(64);
    wait_for_admission(&mut pump, &outbound, &manager, "revoked").await;
    revoked.enabled.store(false, Ordering::SeqCst);
    let second_ctx = context.clone();
    let second_req = fixture.request("peer");
    let second = tokio::spawn(async move {
        client
            .accept(second_ctx, second_req, prepared, authority())
            .await
    });
    wait_for_admission(&mut pump, &outbound, &manager, "peer").await;
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        while !first.is_finished() || !second.is_finished() {
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        first.await.unwrap().unwrap().status,
        IntegrationStatus::Rejected
    );
    assert_eq!(
        second.await.unwrap().unwrap().status,
        IntegrationStatus::Accepted
    );
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    pump.close().await;
    shutdown(manager).await;
}

mod task_state;
