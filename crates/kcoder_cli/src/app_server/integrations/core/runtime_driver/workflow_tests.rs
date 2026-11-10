use super::*;
use kcoder_tools::{ToolRegistry, workflow::WorkflowTool};

#[cfg(target_os = "linux")]
#[path = "organization_pure_workflow_tests.rs"]
mod organization_pure_workflow_tests;
#[path = "organization_workflow_tests.rs"]
mod organization_workflow_tests;

fn save_workflow(fixture: &Fixture, mut node: Value) -> String {
    node["title"] = json!("Native deterministic node");
    let store =
        kcoder_workflow::store::WorkflowStore::new(fixture.profile.join("workflow-library"));
    let draft = store
        .create(
            "Native deterministic acceptance",
            "Owned local regression; no model or external provider",
        )
        .unwrap();
    let draft = store
        .upsert_node(
            &draft.id,
            draft.revision,
            serde_json::from_value(node).unwrap(),
        )
        .unwrap();
    store.save(&draft.id, draft.revision).unwrap().id
}

async fn prepare_launch(
    fixture: &Fixture,
    node: Value,
    authority: Arc<dyn NativeRuntimeAuthority>,
) -> (
    NativeRuntimeDriver,
    ThreadManager,
    QueryEngine,
    NativeRuntimeTicket,
    NativeWorkflowLaunch,
) {
    let definition = save_workflow(fixture, node);
    let (mut manager, engine) = resident(fixture).await;
    let engine = engine
        .with_turn_tools(ToolRegistry::new().register(WorkflowTool))
        .with_settings_persistence_path(fixture.profile.join("settings.json"));
    manager
        .replace_host_turn_engine(&engine.session_id(), engine.clone())
        .unwrap();
    let mut spec = fixture.spec();
    spec.existing_thread_id = Some(engine.session_id());
    spec.configuration.allowed_tools = Some(vec!["Workflow".into()]);
    spec.configuration.model.model = engine.active_model_configuration_summary().unwrap();
    spec.configuration.workflow = Some(
        RuntimeWorkflowSpec::from_native_source(
            &fixture.context,
            &definition,
            1,
            json!({"value":6}),
        )
        .unwrap(),
    );
    let mut driver = fixture.driver();
    driver
        .accept_task(&fixture.context, &fixture.request("real-workflow"), spec)
        .unwrap();
    let configure = driver.next_command(&fixture.context).unwrap().unwrap();
    driver
        .configure_command(
            &fixture.context,
            &ticket(&configure),
            &mut manager,
            Some(authority.installer()),
        )
        .unwrap();
    let command = driver.next_command(&fixture.context).unwrap().unwrap();
    assert!(matches!(
        command,
        NativeRuntimeCommand::StartWorkflow { .. }
    ));
    let ticket = ticket(&command);
    let engine = manager.engine(&engine.session_id()).unwrap();
    let job = driver
        .prepare_workflow_launch(&fixture.context, &ticket, engine.clone(), Some(authority))
        .unwrap();
    (driver, manager, engine, ticket, job)
}

async fn launch(
    fixture: &Fixture,
    node: Value,
) -> (
    NativeRuntimeDriver,
    ThreadManager,
    QueryEngine,
    NativeRuntimeTicket,
) {
    let (driver, manager, engine, ticket, job) =
        prepare_launch(fixture, node, Arc::new(FixtureInstaller)).await;
    job.run().await.unwrap();
    // Native observer has committed an actual run before its response is used.
    let receipt = driver
        .read_operation(&fixture.context, "real-workflow")
        .unwrap()
        .unwrap();
    let accepted = receipt.runtime_acceptance.as_ref().unwrap();
    assert!(accepted.task_id.as_ref().unwrap().starts_with("workflow-"));
    assert!(accepted.turn_id.is_none());
    (driver, manager, engine, ticket)
}

#[tokio::test]
async fn actual_pinned_workflow_registers_original_run_and_recovers_real_output_without_prompt() {
    let fixture = Fixture::new();
    let (driver, manager, engine, launch_ticket) = launch(&fixture, json!({"id":"derive","kind":"code","config":{"code":{"source":"return {doubled: input.value * 2};"}}})).await;
    let run = driver
        .read_operation(&fixture.context, "real-workflow")
        .unwrap()
        .unwrap()
        .runtime_acceptance
        .unwrap()
        .task_id
        .unwrap();
    // Deliberately discard native start response and reload the persistent owner.
    drop(driver);
    let mut driver = NativeRuntimeDriver::load(&fixture.context)
        .unwrap()
        .unwrap();
    for _ in 0..300 {
        driver
            .reconcile_operation(&fixture.context, "real-workflow")
            .unwrap();
        if driver
            .read_task(&fixture.context, "real-workflow")
            .unwrap()
            .state
            != IntegrationTaskState::Running
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let task = driver.read_task(&fixture.context, "real-workflow").unwrap();
    assert_eq!(task.task_id.as_deref(), Some(run.as_str()));
    assert_eq!(task.state, IntegrationTaskState::Completed);
    assert!(task.output.is_none());
    assert!(!driver.has_commands());
    driver
        .observe_workflow_output(&fixture.context, "real-workflow", &engine)
        .unwrap();
    let output = driver
        .read_task(&fixture.context, "real-workflow")
        .unwrap()
        .output
        .unwrap();
    assert!(output.contains("12"), "{output}");
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(launch_ticket.operation_id(), "real-workflow");
    let original = driver
        .storage()
        .bindings()
        .get("real-workflow")
        .unwrap()
        .unwrap();
    std::fs::remove_dir_all(fixture.profile.join("workflow-library")).unwrap();
    assert!(matches!(
        driver
            .accept_task(&fixture.context, &original.original_request, original.spec)
            .unwrap(),
        RuntimeSubmission::Known(_)
    ));
    assert!(!driver.has_commands());
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    shutdown(manager).await;
}

#[test]
fn builtin_arguments_and_definition_are_pinned_before_first_admission() {
    let fixture = Fixture::new();
    let input = json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"explicit-fixture-source","revision":"1"}]});
    let workflow = RuntimeWorkflowSpec::from_native_source(
        &fixture.context,
        "builtin-office-weekly-report",
        1,
        input,
    )
    .unwrap();
    assert_eq!(workflow.args["outputLanguage"], "zh-CN");
    assert_eq!(workflow.args["requirements"], "");
    assert_eq!(workflow.definition_sha256.as_ref().unwrap().len(), 64);
    let mut spec = fixture.spec();
    spec.configuration.workflow = Some(workflow.clone());
    let mut driver = fixture.driver();
    driver
        .accept_task(
            &fixture.context,
            &fixture.request("fixed-defaults"),
            spec.clone(),
        )
        .unwrap();
    assert_eq!(
        driver
            .storage()
            .bindings()
            .get("fixed-defaults")
            .unwrap()
            .unwrap()
            .spec,
        spec
    );
    assert!(!fixture.profile.join("workflow-library").exists());
    let mut legacy = serde_json::to_value(&workflow).unwrap();
    legacy.as_object_mut().unwrap().remove("definitionSha256");
    spec.configuration.workflow = Some(serde_json::from_value(legacy).unwrap());
    assert!(
        driver
            .accept_task(&fixture.context, &fixture.request("unpinned"), spec)
            .unwrap_err()
            .to_string()
            .contains("RUNTIME_WORKFLOW_PIN_REQUIRED")
    );
    assert!(
        driver
            .read_operation(&fixture.context, "unpinned")
            .unwrap()
            .is_none()
    );
}

struct CurrentAuthority {
    enabled: std::sync::atomic::AtomicBool,
    checks: std::sync::atomic::AtomicUsize,
    allowed_checks: usize,
}
impl NativeRuntimeAuthority for CurrentAuthority {
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.validate_scope(&original.scope)?;
        prepared.validate()?;
        let previous = self
            .checks
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ensure!(
            self.enabled.load(std::sync::atomic::Ordering::SeqCst)
                && previous < self.allowed_checks,
            "controlled source authority revoked"
        );
        Ok(())
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        &FixtureInstaller
    }
}

#[tokio::test]
async fn source_loss_and_current_revocation_reject_before_node_dispatch_without_unknown_replay() {
    for condition in ["source_removed", "before_start", "before_native_callback"] {
        let fixture = Fixture::new();
        let authority = Arc::new(CurrentAuthority {
            enabled: std::sync::atomic::AtomicBool::new(true),
            checks: std::sync::atomic::AtomicUsize::new(0),
            allowed_checks: if condition == "before_native_callback" {
                2
            } else {
                usize::MAX
            },
        });
        let (mut driver, manager, _engine, ticket, job) = prepare_launch(&fixture,
            json!({"id":"derive","kind":"code","config":{"code":{"source":"return {doubled: input.value * 2};"}}}), authority.clone()).await;
        if condition == "source_removed" {
            std::fs::remove_dir_all(fixture.profile.join("workflow-library")).unwrap();
        }
        if condition == "before_start" {
            authority
                .enabled
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
        let result = job.run().await;
        assert_eq!(
            result.as_ref().unwrap_err().to_string(),
            "RUNTIME_WORKFLOW_NATIVE_REJECTED",
            "{condition}"
        );
        driver
            .observe_workflow_launch(&fixture.context, &ticket, result)
            .unwrap();
        let receipt = driver
            .read_operation(&fixture.context, "real-workflow")
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.phase,
            IntegrationOperationPhase::Rejected,
            "{condition}"
        );
        assert!(receipt.runtime_acceptance.is_none());
        assert!(!driver.has_commands());
        if condition != "before_native_callback" {
            assert!(!fixture.profile.join("workflow-runs").exists());
        }
        shutdown(manager).await;
    }
}

#[tokio::test]
async fn actual_workflow_cancel_uses_original_background_owner_and_observes_terminal_state() {
    let fixture = Fixture::new();
    let (mut driver, manager, engine, launch_ticket) = launch(
        &fixture,
        json!({"id":"wait","kind":"wait","config":{"wait":{"delayMs":30_000}}}),
    )
    .await;
    driver
        .observe_workflow_launch(&fixture.context, &launch_ticket, Ok(()))
        .unwrap();
    let accepted = driver
        .read_operation(&fixture.context, "real-workflow")
        .unwrap()
        .unwrap()
        .runtime_acceptance
        .unwrap();
    let mut cancel = fixture.request("cancel-workflow");
    cancel.payload = json!({"threadId":accepted.thread_id,"taskId":accepted.task_id})
        .as_object()
        .unwrap()
        .clone();
    driver
        .cancel_task(&fixture.context, "real-workflow", &cancel)
        .unwrap();
    let stop = driver.next_command(&fixture.context).unwrap().unwrap();
    assert!(matches!(stop, NativeRuntimeCommand::StopWorkflow { .. }));
    assert_ne!(
        driver
            .read_task(&fixture.context, "real-workflow")
            .unwrap()
            .state,
        IntegrationTaskState::Cancelled
    );
    let ticket = ticket(&stop);
    let job = driver
        .prepare_workflow_stop(&fixture.context, &ticket, engine)
        .unwrap();
    let found = tokio::time::timeout(std::time::Duration::from_secs(5), job.run())
        .await
        .unwrap();
    driver
        .observe_workflow_stop(&fixture.context, &ticket, found)
        .unwrap();
    assert_eq!(
        driver
            .read_task(&fixture.context, "real-workflow")
            .unwrap()
            .state,
        IntegrationTaskState::Cancelled
    );
    let receipt = driver
        .read_operation(&fixture.context, "real-workflow")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.phase, IntegrationOperationPhase::Cancelled);
    assert_eq!(
        kcoder_tools::workflow_runs::list(fixture.profile.join("workflow-runs"))
            .unwrap()
            .len(),
        1
    );
    shutdown(manager).await;
}

#[path = "workflow_human_tests.rs"]
mod workflow_human_tests;
