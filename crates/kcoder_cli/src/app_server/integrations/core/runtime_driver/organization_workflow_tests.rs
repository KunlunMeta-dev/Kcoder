//! Actual restricted UID Core Workflow admission; the supervisor owns policy and balances.
use super::*;
use crate::app_server::{
    InteractionReceipts, ResidentTurnState, SessionLease, build_resident_thread_runtime,
    engine_factory::AppServerEngineFactory,
};
use std::io::{BufRead, Write};
use std::sync::atomic::AtomicU64;

struct GovernedWorkflow {
    endpoint: String,
}
impl NativeRuntimeAuthority for GovernedWorkflow {
    fn verify_admission(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        native.validate_scope(&request.scope)?;
        ensure!(native.scope().organization_id.is_some());
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
impl NativeRuntimePolicyInstaller for GovernedWorkflow {
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

#[tokio::test]
#[ignore = "requires the explicit owned Linux UID, original Core Workflow and live organization supervisor"]
async fn actual_uid_direct_core_workflow_children_share_original_root_budget() -> Result<()> {
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
    let endpoint = provider
        .endpoint()
        .context("actual provider endpoint required")?
        .to_owned();
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
            "org-workflow-budget",
        )?,
        Some(profile.join("settings.json")),
        profile.join("session-ids"),
    );
    // Factory construction installs the original mandatory organization observer.
    let engine = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    engine.activate_client_session();
    engine.state.save_history()?;
    ensure!(engine.state.current_history_attempt_identity().is_none());
    let native = crate::app_server::integrations::core::capture_scope(&engine)?;
    println!(
        "ORG_CORE_WORKFLOW_SCOPE:{}",
        serde_json::to_string(native.scope())?
    );
    std::io::stdout().flush()?;
    let mut continuation = String::new();
    ensure!(
        std::io::stdin().lock().read_line(&mut continuation)? > 0
            && continuation.trim() == "continue",
        "owned policy continuation missing"
    );
    let expected = std::env::var("KCODER_TEST_ORGANIZATION_WORKFLOW_EXPECTED")
        .unwrap_or_else(|_| "completed".into());
    ensure!(matches!(
        expected.as_str(),
        "completed" | "failed" | "model_denied"
    ));
    let workflows = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let draft = workflows.create(
        "Original organization Workflow",
        "Actual Core child budget root",
    )?;
    let draft = workflows.upsert_node(&draft.id, draft.revision, serde_json::from_value(json!({
        "id":"first", "title":"First actual child", "kind":"agent", "agentType":"general", "maxTurns":1,
        "prompt":"Return the JSON object {\"verified\":true}. No tools."
    }))?)?;
    let draft = workflows.upsert_node(&draft.id, draft.revision, serde_json::from_value(json!({
        "id":"second", "title":"Second actual child", "kind":"agent", "agentType":"general", "maxTurns":1,
        "dependsOn":["first"], "prompt":"Return the JSON object {\"verified\":true}. No tools."
    }))?)?;
    let saved = workflows.save(&draft.id, draft.revision)?;
    let operation = "original-org-core-workflow";
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(), scope: native.scope().clone(),
        operation_id: Some(operation.into()), expected_revision: None, timeout_ms: 10_000,
        cancellation_ref: None,
        payload: json!({"source":{"kind":"office_assistant","assistantId":"original-org-core-workflow","version":1},
            "message":{"text":"Run the explicitly saved workflow once."}}).as_object().unwrap().clone(),
    };
    let task = PreparedRuntimeTask {
        input: vec![UserInput::Text {
            text: "Run the explicitly saved workflow once.".into(),
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
                &native,
                &saved.id,
                1,
                json!({}),
            )?),
        },
    };
    let lease = SessionLease::acquire(&engine.session_lease_target())?;
    let (outbound, _notifications) = tokio::sync::mpsc::channel(256);
    let turns = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(std::sync::Mutex::new(InteractionReceipts::default())),
    );
    let runtime = build_resident_thread_runtime(
        engine.clone(),
        lease,
        0,
        turns,
        outbound,
        "actual-org-core-workflow".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let mut manager = ThreadManager::default();
    ensure!(manager.insert(runtime).is_ok());
    let result = async {
        let authority = Arc::new(GovernedWorkflow { endpoint });
        let mut driver = NativeRuntimeDriver::initialize(&native, operation)?;
        driver.accept_task(&native, &request, task)?;
        let configure = driver
            .next_command(&native)?
            .context("configure command missing")?;
        let configured = driver.configure_command(
            &native,
            &ticket(&configure),
            &mut manager,
            Some(authority.installer()),
        );
        if expected == "model_denied" {
            ensure!(configured.as_ref().is_err_and(|error| error.chain().any(|cause| cause.to_string()=="ORGANIZATION_MODEL_DENIED")), "original organization model denial missing");
            let receipt=driver.read_operation(&native,operation)?.context("original rejected receipt missing")?;
            ensure!(receipt.phase==IntegrationOperationPhase::Rejected && receipt.runtime_acceptance.is_none());
            println!("ORG_CORE_WORKFLOW_ADMISSION_EVIDENCE:{}",json!({"originalCoreReceipt":receipt,"modelDenied":true}));
            return Ok(());
        }
        configured?;
        let launch = driver
            .next_command(&native)?
            .context("Workflow command missing")?;
        ensure!(matches!(launch, NativeRuntimeCommand::StartWorkflow { .. }));
        let ticket = ticket(&launch);
        let candidate = manager
            .engine(&engine.session_id())
            .context("resident missing")?;
        let job = driver.prepare_workflow_launch(&native, &ticket, candidate, Some(authority))?;
        let launched = job.run().await;
        driver.observe_workflow_launch(&native, &ticket, launched)?;
        let acceptance = driver
            .read_operation(&native, operation)?
            .context("original receipt missing")?
            .runtime_acceptance
            .context("original Core acceptance missing")?;
        ensure!(acceptance.turn_id.is_none());
        let run = acceptance
            .task_id
            .as_ref()
            .context("original Workflow run missing")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
        loop {
            driver.refresh_workflow(&native, operation)?;
            let task = driver.read_task(&native, operation)?;
            if task.state != IntegrationTaskState::Running
                && task.state != IntegrationTaskState::Queued
            {
                let observed =
                    kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"), run)?;
                println!(
                    "ORG_CORE_WORKFLOW_EVIDENCE:{}",
                    json!({"scope":native.scope(),"originalCoreAcceptance":acceptance,
                    "parentAttemptIsNone":engine.state.current_history_attempt_identity().is_none(),
                    "workflowState":format!("{:?}",task.state),"workflowError":observed.error,
                    "nodeStates":observed.node_states,
                    "nativeChildIntents":driver.storage().bindings().get(operation)?.context("original binding missing")?.child_intents})
                );
                ensure!(
                    task.state == if expected=="failed" {IntegrationTaskState::Failed} else {IntegrationTaskState::Completed},
                    "ORIGINAL_ORG_WORKFLOW_NOT_COMPLETED"
                );
                break;
            }
            ensure!(
                std::time::Instant::now() < deadline,
                "owned Workflow did not settle"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    shutdown(manager).await;
    result
}
