//! Actual model-free roots contend for the original organization task slot.
use super::*;
use crate::app_server::{
    InteractionReceipts, ResidentTurnState, SessionLease, build_resident_thread_runtime,
    engine_factory::AppServerEngineFactory,
};
use std::{
    io::{BufRead, Write},
    sync::atomic::AtomicU64,
};

struct CurrentSource {
    endpoint: String,
}
struct RejectAdditionalRoot;
impl kcoder_engine::native_model_requests::NativeModelRequestObserver for RejectAdditionalRoot {
    fn observe_workflow_accepted(
        &self,
        _: &kcoder_engine::native_model_requests::NativeWorkflowRootRequest<'_>,
    ) -> std::result::Result<(), kcoder_engine::native_model_requests::NativeModelRequestError>
    {
        Err(kcoder_engine::native_model_requests::NativeModelRequestError::Denied)
    }
    fn reserve(
        &self,
        _: &kcoder_engine::native_model_requests::NativeModelRequestContext,
        _: &kcoder_types::MessagesRequest,
    ) -> std::result::Result<
        Box<dyn kcoder_engine::native_model_requests::NativeModelRequestLease>,
        kcoder_engine::native_model_requests::NativeModelRequestError,
    > {
        Err(kcoder_engine::native_model_requests::NativeModelRequestError::Denied)
    }
}
impl NativeRuntimeAuthority for CurrentSource {
    fn verify_admission(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        native.validate_scope(&request.scope)?;
        native.authorize_organization_resource(
            "use",
            native
                .scope()
                .workspace_id
                .as_ref()
                .context("workspace missing")?,
            &request.request_id,
        )?;
        task.validate()
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
}
impl NativeRuntimePolicyInstaller for CurrentSource {
    fn install(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(native, request, task)?;
        native.authorize_organization_model(
            &engine.active_model_configuration_summary()?,
            &self.endpoint,
            &request.request_id,
        )?;
        Ok(engine)
    }
}
fn resident(manager: &mut ThreadManager, engine: &QueryEngine) -> Result<()> {
    let lease = SessionLease::acquire(&engine.session_lease_target())?;
    let (outbound, _notifications) = tokio::sync::mpsc::channel(256);
    let turns = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(std::sync::Mutex::new(InteractionReceipts::default())),
    );
    ensure!(
        manager
            .insert(build_resident_thread_runtime(
                engine.clone(),
                lease,
                0,
                turns,
                outbound,
                "actual-pure-workflow".into(),
                Arc::new(AtomicU64::new(1))
            ))
            .is_ok()
    );
    Ok(())
}
fn request(native: &NativeIntegrationContext, operation: &str) -> IntegrationRequest {
    IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,request_id:uuid::Uuid::new_v4().to_string(),
        scope:native.scope().clone(),operation_id:Some(operation.into()),expected_revision:None,timeout_ms:10_000,cancellation_ref:None,
        payload:json!({"source":{"kind":"office_assistant","assistantId":"owned-pure-root","version":1},"message":{"text":"Run the explicitly saved model-free workflow."}}).as_object().unwrap().clone()}
}
async fn launch(
    driver: &mut NativeRuntimeDriver,
    native: &NativeIntegrationContext,
    manager: &mut ThreadManager,
    engine: &QueryEngine,
    definition: &str,
    operation: &str,
    authority: Arc<CurrentSource>,
) -> Result<IntegrationRuntimeAcceptance> {
    let task = PreparedRuntimeTask {
        input: vec![UserInput::Text {
            text: "Run the explicitly saved model-free workflow.".into(),
        }],
        studio_work_mode: StudioWorkMode::Kcoder,
        existing_thread_id: Some(engine.session_id()),
        client_presentation: None,
        configuration: RuntimeExecutionConfiguration {
            model: IntegrationModelResolutionResult {
                selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                model: engine.active_model_configuration_summary()?,
                policy_ref: IntegrationNullable::Null,
                budget: IntegrationModelBudget {
                    reservation_state: IntegrationBudgetReservationState::NotReserved,
                    cost_known: false,
                },
            },
            allowed_tools: Some(vec!["Workflow".into()]),
            external_send: RuntimeExternalSend::Deny,
            workflow: Some(RuntimeWorkflowSpec::from_native_source(
                native,
                definition,
                1,
                json!({}),
            )?),
        },
    };
    driver.accept_task(native, &request(native, operation), task)?;
    let configure = driver.next_command(native)?.context("configure missing")?;
    driver.configure_command(
        native,
        &ticket(&configure),
        manager,
        Some(authority.installer()),
    )?;
    let command = driver.next_command(native)?.context("launch missing")?;
    ensure!(matches!(
        command,
        NativeRuntimeCommand::StartWorkflow { .. }
    ));
    let launch_ticket = ticket(&command);
    let candidate = manager
        .engine(&engine.session_id())
        .context("resident missing")?;
    let result = driver
        .prepare_workflow_launch(native, &launch_ticket, candidate, Some(authority))?
        .run()
        .await;
    driver.observe_workflow_launch(native, &launch_ticket, result)?;
    driver
        .read_operation(native, operation)?
        .context("original Core receipt missing")?
        .runtime_acceptance
        .context("original Core acceptance missing")
}
async fn terminal(
    driver: &mut NativeRuntimeDriver,
    native: &NativeIntegrationContext,
    operation: &str,
) -> Result<IntegrationRuntimeTask> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        driver.refresh_workflow(native, operation)?;
        let task = driver.read_task(native, operation)?;
        if !matches!(
            task.state,
            IntegrationTaskState::Queued | IntegrationTaskState::Running
        ) {
            return Ok(task);
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "owned root terminal deadline"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
#[tokio::test]
#[ignore = "requires the explicit owned Linux UID, model-free Core roots and original organization budget service"]
async fn actual_uid_pure_wait_and_code_roots_contend_before_any_node_effect() -> Result<()> {
    ensure!(std::env::var("KCODER_TEST_ORGANIZATION_CORE_WORKFLOW").as_deref() == Ok("1"));
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").context("profile missing")?);
    let workspace = std::env::current_dir()?;
    let settings = kcoder_config::SettingsLoader::new(&workspace)
        .with_config_dir(&profile)
        .with_executable_dir(&workspace)
        .load()?
        .settings;
    let provider = kcoder_api::ProviderFactory::new(&settings)
        .build_named("fixture", "owned-workflow-model")?;
    let authority = Arc::new(CurrentSource {
        endpoint: provider.endpoint().context("endpoint missing")?.into(),
    });
    let factory = AppServerEngineFactory::new(
        provider,
        ToolRegistry::new().register(WorkflowTool),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.clone(),
        Some(profile.join("history")),
        true,
        kcoder_engine::WorkspaceRuntimeServices::try_new_for_client(
            &workspace,
            "pure-workflow-budget",
        )?,
        Some(profile.join("settings.json")),
        profile.join("session-ids"),
    );
    let mut manager = ThreadManager::default();
    let result=async {
        let first=factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        first.activate_client_session();first.state.save_history()?;resident(&mut manager,&first)?;
        let native=crate::app_server::integrations::core::capture_scope(&first)?;
        println!("ORG_CORE_WORKFLOW_SCOPE:{}",serde_json::to_string(native.scope())?);std::io::stdout().flush()?;
        let mut continuation=String::new();ensure!(std::io::stdin().lock().read_line(&mut continuation)?>0&&continuation.trim()=="continue");
        let store=kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
        let wait=store.create("Owned pure Wait root","No Agent or model request")?;
        let wait=store.upsert_node(&wait.id,wait.revision,serde_json::from_value(json!({"id":"wait","title":"Owned wait","kind":"wait","config":{"wait":{"delayMs":30000}}}))?)?;
        let wait=store.save(&wait.id,wait.revision)?;
        let code=store.create("Owned pure Code root","No Agent or model request")?;
        let code=store.upsert_node(&code.id,code.revision,serde_json::from_value(json!({"id":"code","title":"Owned calculation","kind":"code","config":{"code":{"source":"return {verified: true, actualPureCode: true};"}}}))?)?;
        let code=store.save(&code.id,code.revision)?;
        let mut driver=NativeRuntimeDriver::initialize(&native,"original-pure-wait")?;
        let first_accepted=launch(&mut driver,&native,&mut manager,&first,&wait.id,"original-pure-wait",authority.clone()).await?;
        let first_run=first_accepted.task_id.as_ref().context("first root run missing")?;
        let first_snapshot=kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"),first_run)?;
        ensure!(first_snapshot.status=="running");
        println!("ORG_CORE_WORKFLOW_PURE_ACTIVE:{}",json!({"originalCoreAcceptance":first_accepted,"workflow":first_snapshot,"parentAttemptIsNone":first.state.current_history_attempt_identity().is_none()}));std::io::stdout().flush()?;
        continuation.clear();ensure!(std::io::stdin().lock().read_line(&mut continuation)?>0&&continuation.trim()=="continue");
        // The bounded supervisor handshake blocks this libtest runtime thread.
        // Yield to the original Workflow owner before testing a running Wait.
        let wait_started_deadline=std::time::Instant::now()+std::time::Duration::from_secs(3);
        loop {
            let observed=kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"),first_run)?;
            if observed.node_states.iter().any(|node|node.node_id=="wait"&&node.started_at_ms.is_some()) {break}
            ensure!(std::time::Instant::now()<wait_started_deadline,"actual Wait startup deadline");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let second=factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        second.activate_client_session();second.state.save_history()?;resident(&mut manager,&second)?;
        let second_accepted=launch(&mut driver,&native,&mut manager,&second,&code.id,"original-blocked-code",authority.clone()).await?;
        let second_task=terminal(&mut driver,&native,"original-blocked-code").await?;
        let second_snapshot=kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"),second_accepted.task_id.as_ref().context("second root run missing")?)?;
        driver.refresh_workflow(&native,"original-pure-wait")?;
        let first_task=driver.read_task(&native,"original-pure-wait")?;
        let first_current=kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"),first_run)?;
        println!("ORG_CORE_WORKFLOW_PURE_CONTENTION:{}",json!({"firstAccepted":first_accepted,"firstState":format!("{:?}",first_task.state),"firstWorkflow":first_current,"secondAccepted":second_accepted,"secondState":format!("{:?}",second_task.state),"secondWorkflow":second_snapshot}));
        ensure!(matches!(first_task.state,IntegrationTaskState::Queued|IntegrationTaskState::Running));
        ensure!(first_current.node_states.iter().any(|node|node.node_id=="wait"&&node.started_at_ms.is_some()),"original Wait node did not actually start");
        ensure!(second_task.state==IntegrationTaskState::Failed,"SECOND_MODEL_FREE_ROOT_BYPASSED_CONCURRENT_TASK_LIMIT");
        ensure!(second_snapshot.node_states.iter().all(|node|node.started_at_ms.is_none()),"rejected Code node executed");
        let mut cancel=request(&native,"cancel-original-pure-wait");cancel.payload=json!({"threadId":first_accepted.thread_id,"taskId":first_run}).as_object().unwrap().clone();
        driver.cancel_task(&native,"original-pure-wait",&cancel)?;
        let stop=driver.next_command(&native)?.context("original stop missing")?;ensure!(matches!(stop,NativeRuntimeCommand::StopWorkflow { .. }));
        let stop_ticket=ticket(&stop);let found=driver.prepare_workflow_stop(&native,&stop_ticket,first.clone())?.run().await;
        driver.observe_workflow_stop(&native,&stop_ticket,found)?;
        let first_terminal=terminal(&mut driver,&native,"original-pure-wait").await?;
        ensure!(first_terminal.state==IntegrationTaskState::Cancelled);
        let denied=factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?
            .with_additional_native_model_request_observer(Arc::new(RejectAdditionalRoot))?;
        denied.activate_client_session();denied.state.save_history()?;resident(&mut manager,&denied)?;
        let denied_accepted=launch(&mut driver,&native,&mut manager,&denied,&code.id,"original-additional-meter-denied",authority.clone()).await?;
        let denied_terminal=terminal(&mut driver,&native,"original-additional-meter-denied").await?;
        let denied_snapshot=kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"),denied_accepted.task_id.as_ref().context("denied run missing")?)?;
        ensure!(denied_terminal.state==IntegrationTaskState::Failed&&denied_snapshot.node_states.iter().all(|node|node.started_at_ms.is_none()));
        let third=factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        third.activate_client_session();third.state.save_history()?;resident(&mut manager,&third)?;
        let third_accepted=launch(&mut driver,&native,&mut manager,&third,&code.id,"original-code-after-release",authority).await?;
        let third_terminal=terminal(&mut driver,&native,"original-code-after-release").await?;
        ensure!(third_terminal.state==IntegrationTaskState::Completed);
        let no_parent_attempt=first.state.current_history_attempt_identity().is_none()&&second.state.current_history_attempt_identity().is_none()&&third.state.current_history_attempt_identity().is_none()&&denied.state.current_history_attempt_identity().is_none();ensure!(no_parent_attempt);
        println!("ORG_CORE_WORKFLOW_PURE_EVIDENCE:{}",json!({"firstAccepted":first_accepted,"firstTerminal":"Cancelled","blockedAccepted":second_accepted,"blockedTerminal":"Failed","additionalMeterDeniedAccepted":denied_accepted,"additionalMeterDeniedWorkflow":denied_snapshot,"afterReleaseAccepted":third_accepted,"afterReleaseTerminal":"Completed","providerCalls":0,"noParentTurnAttempt":no_parent_attempt}));
        Ok::<_,anyhow::Error>(())
    }.await;
    shutdown(manager).await;
    result
}
