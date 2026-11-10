//! One dedicated service drives the original Runtime pump and ordinary thread dispatcher.
use super::diagnostics::{self, Stage};
use super::runtime::NativeCodeRuntimeAuthority;
use super::*;
use crate::app_server::*;
use anyhow::{Context, ensure};
use kcoder_engine::{QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
use std::sync::{Arc, Mutex as StdMutex, atomic::AtomicU64};
use tokio::sync::mpsc;

static MODEL_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct NoModelProvider;
impl kcoder_api::Provider for NoModelProvider {
    fn name(&self) -> &'static str {
        "native-code-service-no-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        MODEL_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(kcoder_api::ApiErrorKind::Api {
            error_type: "NATIVE_CODE_MODEL_NOT_ALLOWED".into(),
            message: "Saved-code services do not call a model".into(),
        })
    }
}

fn factory(owner: &NativeCodeServiceOwner) -> Result<(AppServerEngineFactory, QueryEngine)> {
    let mut settings = super::source::load_settings(
        &owner.launch.profile_path,
        &owner.launch.workspace_path,
        &owner.launch.settings_file,
    )?;
    ensure!(
        settings.history_enabled,
        "NATIVE_CODE_DURABLE_HISTORY_REQUIRED"
    );
    // The fixed saved-code purpose has no model/tool/Agent/Hook permission.
    settings.memory.structured_enabled = false;
    settings.session_memory.enabled = false;
    let provider: Arc<dyn kcoder_api::Provider> = Arc::new(NoModelProvider);
    let permissions = PermissionEngine::from_settings(&settings);
    let memory = MemoryManager::global_only(MemoryStore::empty());
    let services =
        WorkspaceRuntimeServices::new(&owner.launch.workspace_path, "native-code-service");
    let origin = QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
        provider.clone(),
        kcoder_state::AppState::new(&owner.launch.workspace_path),
        ToolRegistry::new(),
        permissions.clone(),
        settings.clone(),
        memory.clone(),
        SkillRegistry::empty(),
        Arc::new(DenyAllUserQuestioner),
        owner.launch.workspace_path.clone(),
        Some(false),
        services.clone(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
    )?
    .with_settings_persistence_path(owner.launch.settings_file.clone());
    let factory = AppServerEngineFactory::new(
        provider,
        ToolRegistry::new(),
        permissions,
        settings.clone(),
        memory,
        SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        owner.launch.workspace_path.clone(),
        Some(settings.history_dir()?),
        false,
        services,
        Some(owner.launch.settings_file.clone()),
        owner.launch.profile_path.join("short-ids.json"),
    );
    Ok((factory, origin))
}

pub(super) async fn run(
    owner: Arc<NativeCodeServiceOwner>,
    ready: &mut Option<std::fs::File>,
) -> Result<()> {
    let (factory, mut engine) = diagnostics::mark(Stage::RuntimeFactory, factory(&owner))?;
    let workspace_engine = engine.clone();
    let permission_mode = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("NATIVE_CODE_CONFIGURATION_UNAVAILABLE"))?
        .permission_mode;
    let mut manager = ThreadManager::default();
    let (mut pump, client) = integrations::core::runtime_pump::NativeRuntimePump::new();
    let context = Arc::new(owner.native().recapture_for_owned_service()?);
    let original = owner.launch.task.runtime_operation_id.clone();
    let known = diagnostics::at(Stage::RuntimeOriginalRead, || {
        Ok(
            integrations::core::runtime_driver::NativeRuntimeDriver::load(&context)?
                .map(|driver| driver.read_operation(&context, &original))
                .transpose()?
                .flatten(),
        )
    })?;
    let fresh = diagnostics::mark(Stage::RuntimeClaim, owner.claim_runtime_once())?;
    let mut submission = if fresh && known.is_none() {
        let authority = diagnostics::mark(
            Stage::RuntimePrepare,
            NativeCodeRuntimeAuthority::prepare(owner.clone(), factory.clone(), &engine).await,
        )?;
        let request = authority.request();
        let task = authority.task();
        let native = context.clone();
        Some(crate::app_server::task_spawn::spawn(async move {
            diagnostics::mark(
                Stage::RuntimeAdmission,
                client.accept(native, request, task, authority).await,
            )
        }))
    } else {
        None
    };
    let (outbound, mut notifications) = mpsc::channel(256);
    let next_interaction_id = Arc::new(AtomicU64::new(200000));
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
    let sequence = Arc::new(AtomicU64::new(1));
    let server_id = format!("native-code-service-{}", owner.intent().lease_id);
    let mut automations = project_automations::ProjectAutomations::new(
        engine.cron_scheduler(),
        false,
        owner.launch.workspace_path.to_string_lossy().into_owned(),
    );
    let mut state = ConnectionState {
        initialized: true,
        // The same-image private host implements the fixed Kcoder declaration;
        // this protocol version grants no tool, model or Accepted authority.
        studio_work_modes_v1: true,
        integration_context: Some(owner.native().recapture_for_owned_service()?),
        ..Default::default()
    };
    let mut accepted: Option<IntegrationRuntimeAcceptance> = None;
    let mut observed = None;
    if submission.is_none() {
        write_ready(
            ready,
            &owner,
            known
                .as_ref()
                .and_then(|receipt| receipt.runtime_acceptance.as_ref()),
        )?;
    }
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let stop = owner.cancellation();
    let result:Result<()>=async {
        loop {
            while let Some(generated)=pump.next_request(&mut manager)? {
                ensure!(generated.method=="thread/start","NATIVE_CODE_GENERATED_METHOD_NOT_ALLOWED");
                state.native_source_dispatch=true;
                state.native_runtime_thread_initializer=generated.thread_initializer;
                let dispatched=thread_creation_requests::dispatch(generated.method,serde_json::json!(generated.ticket.id()),generated.params,
                    &mut engine,&workspace_engine,&factory,permission_mode,&generated.outbound,&next_interaction_id,&receipts,
                    &mut manager,&server_id,&sequence,&mut automations,&None,&mut state,
                    ).await;
                state.native_source_dispatch=false;state.native_runtime_thread_initializer=None;
                if dispatched.is_err(){pump.dispatch_failed(&generated.ticket);}
                diagnostics::mark(Stage::RuntimeDispatch, dispatched)?;
            }
            if submission.as_ref().is_some_and(|call|call.is_finished()) {
                let reply=diagnostics::mark(Stage::RuntimeReply, submission.take().unwrap().await.context("NATIVE_CODE_RUNTIME_SUBMISSION_UNCONFIRMED")?)?;
                if reply.status!=IntegrationStatus::Accepted {
                    return Err(diagnostics::rejected_reply(Stage::RuntimeReply, reply.error.as_ref().map(|error|error.code.as_str())));
                }
                accepted=Some(serde_json::from_value(serde_json::Value::Object(reply.result.as_ref().context("NATIVE_CODE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?.clone()))?);
                write_ready(ready,&owner,accepted.as_ref())?;
            }
            tokio::select! {
                _=stop.cancelled()=>break,
                _=terminate.recv()=>{owner.request_stop();break;},
                event=pump.receive()=>{
                    let private_error = match &event {
                        integrations::core::runtime_pump::RuntimePumpEvent::PrivateFrame(frame) => frame.get("error").map(|error|
                            diagnostics::private_rpc_error(error.get("message").and_then(Value::as_str))),
                        _ => None,
                    };
                    // The original private ticket is consumed and its Unknown
                    // receipt is saved before returning diagnostic metadata.
                    pump.observe(event,&outbound,&manager).await?;
                    if let Some(error)=private_error {return Err(error);}
                },
                _=notifications.recv()=>{},
                _=tick.tick()=>{
                    if owner.verify().is_err(){owner.request_stop();break;}
                    if let Some(driver)=integrations::core::runtime_driver::NativeRuntimeDriver::load(&context)?
                        && let Some(receipt)=driver.read_operation(&context,&original)?
                    {
                        if accepted.is_none(){accepted=receipt.runtime_acceptance;}
                        if let Ok(task)=driver.read_task(&context,&original)
                            && observed!=Some(task.state) {observed=Some(task.state);}
                    }
                },
            }
        }
        Ok(())
    }.await;
    // These are actual resident handles created by this pump. A restored DTO
    // cannot appoint a cold process to stop another runtime or recreate a task.
    if let Some(acceptance) = &accepted
        && let Some(actual) = manager.engine(&acceptance.thread_id)
        && let Some(run) = &acceptance.task_id
    {
        actual.stop_background_task(run).await;
    }
    // Cleanup observes the original owned run even after its execution grant
    // was revoked. OS exit or a stop request cannot fabricate a task outcome.
    if let Ok(Some(mut driver)) =
        integrations::core::runtime_driver::NativeRuntimeDriver::load(&context)
    {
        let _ = driver.refresh_workflow(&context, &original);
    }
    pump.close().await;
    if let Some(call) = submission {
        let _ = call.await;
    }
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    result
}

fn write_ready(
    ready: &mut Option<std::fs::File>,
    owner: &NativeCodeServiceOwner,
    accepted: Option<&IntegrationRuntimeAcceptance>,
) -> Result<()> {
    use std::io::Write;
    if let Some(mut pipe) = ready.take() {
        let mut bytes = serde_json::to_vec(&serde_json::json!({"leaseId":owner.intent().lease_id,
            "operationId":owner.launch.task.runtime_operation_id,"acceptance":accepted,"modelCalls":MODEL_CALLS.load(std::sync::atomic::Ordering::SeqCst)}))?;
        ensure!(bytes.len() <= 8192, "NATIVE_CODE_READY_RECEIPT_TOO_LARGE");
        bytes.push(b'\n');
        pipe.write_all(&bytes)?;
        pipe.flush()?;
    }
    Ok(())
}
