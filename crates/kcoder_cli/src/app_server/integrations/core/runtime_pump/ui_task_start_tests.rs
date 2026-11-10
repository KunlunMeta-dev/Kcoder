//! Original creation, durable receipts, and client lifetimes share one Core.
use super::*;
use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
use crate::app_server::{
    AppServerEngineFactory, InteractionReceipts, project_automations::ProjectAutomations,
};
use std::sync::{Weak, atomic::AtomicU64};

struct ForbiddenModel;
impl kcoder_api::Provider for ForbiddenModel {
    fn name(&self) -> &'static str {
        "original-creation-no-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        panic!("Task creation and receipt recovery must not invoke a model")
    }
}

struct OriginalUi(Weak<()>);
impl NativeUiTaskStartAuthority for OriginalUi {
    fn verify(&self, state: &ConnectionState, params: &ThreadStartParams) -> Result<()> {
        ensure!(
            self.0
                .ptr_eq(&Arc::downgrade(&state.source_management_owner))
                && self.0.upgrade().is_some()
                && !state.input_ended.is_cancelled()
                && params.client_request_id.as_deref() == Some("original-create"),
            "ORIGINAL_UI_REQUIRED"
        );
        crate::app_server::integrations::connectivity::task_ui::verify_original_ui_source(state)
    }
}

impl super::super::ui_task_read::NativeUiTaskReadAuthority for OriginalUi {
    fn verify(
        &self,
        state: &ConnectionState,
        input: &kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskRead,
    ) -> Result<()> {
        ensure!(
            self.0
                .ptr_eq(&Arc::downgrade(&state.source_management_owner))
                && self.0.upgrade().is_some()
                && !state.input_ended.is_cancelled(),
            "ORIGINAL_UI_REQUIRED"
        );
        input.validate().map_err(anyhow::Error::msg)?;
        let native = state
            .integration_context
            .as_ref()
            .context("ORIGINAL_SCOPE_REQUIRED")?;
        native.validate_scope(&input.scope)?;
        crate::app_server::integrations::connectivity::task_ui::verify_original_ui_source(state)
    }
}

async fn original_read(
    dispatch: &mut NativeUiTaskStartDispatch<'_>,
    pump: &mut NativeRuntimePump,
    client: &NativeRuntimeClient,
    state: ConnectionState,
    reads: super::super::ui_task_read::NativeUiTaskReadState,
    query: kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskQuery,
) -> Result<(
    ConnectionState,
    super::super::ui_task_read::NativeUiTaskReadState,
    Value,
)> {
    use kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskRead;
    let native = state
        .integration_context
        .as_ref()
        .context("ORIGINAL_SCOPE_REQUIRED")?;
    let input = ChannelPeerTaskRead {
        scope: native.scope().clone(),
        source_authority_epoch: native.source_authority_epoch()?.1,
        query,
    };
    let authority = Arc::new(OriginalUi(Arc::downgrade(&state.source_management_owner)));
    let (reply, response) = oneshot::channel();
    assert!(
        client
            .queue_ui_task_read(super::super::ui_task_read::NativeUiTaskReadRequest {
                state,
                reads,
                input,
                id: json!("original-read"),
                authority,
                reply,
            })
            .is_ok()
    );
    let (outbound, _) = mpsc::channel(1);
    while pump.ui_task_reads.is_empty() {
        let event = pump.receive().await;
        pump.observe_with_task_owners(event, &outbound, dispatch.manager)
            .await?;
    }
    super::super::ui_task_read::dispatch(
        pump.next_ui_task_read().context("ORIGINAL_READ_REQUIRED")?,
        dispatch.workspace,
        dispatch.manager,
    )
    .await;
    let (state, reads, result) = response.await?;
    Ok((state, reads, result?))
}

fn ui(fixture: &Fixture) -> Result<ConnectionState> {
    Ok(ConnectionState {
        initialized: true,
        integration_task_capability_scope_v1: true,
        thread_runtime_handoff_v1: true,
        interaction_binding_v1: true,
        integration_context: Some(fixture.context.recapture_for_owned_service()?),
        ..Default::default()
    })
}

fn factory(fixture: &Fixture) -> AppServerEngineFactory {
    let settings = kcoder_config::Settings {
        credential_store: kcoder_config::CredentialStoreMode::File,
        ..Default::default()
    };
    AppServerEngineFactory::new(
        Arc::new(ForbiddenModel),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        fixture.workspace.clone(),
        Some(fixture.workspace.join("history")),
        true,
        kcoder_engine::WorkspaceRuntimeServices::new(&fixture.workspace, "original-create-test"),
        Some(fixture.profile.join("settings.json")),
        fixture.profile.join("short-ids"),
    )
}

async fn original_start(
    dispatch: &mut NativeUiTaskStartDispatch<'_>,
    pump: &mut NativeRuntimePump,
    client: &NativeRuntimeClient,
    state: ConnectionState,
) -> Result<(ConnectionState, NativeUiTaskCreated, Vec<Value>)> {
    let authority = Arc::new(OriginalUi(Arc::downgrade(&state.source_management_owner)));
    let params: ThreadStartParams =
        serde_json::from_value(json!({"clientRequestId":"original-create"}))?;
    let (outbound, mut frames) = mpsc::channel(32);
    let (reply, response) = oneshot::channel();
    let request = NativeUiTaskStartRequest {
        state,
        params,
        id: json!("create-rpc"),
        outbound: outbound.clone(),
        retired: CancellationToken::new(),
        authority,
        reply,
    };
    assert!(client.queue_ui_task_start(request).is_ok());
    while pump.ui_task_starts.is_empty() {
        let event = pump.receive().await;
        pump.observe_with_task_owners(event, &outbound, dispatch.manager)
            .await?;
    }
    dispatch
        .dispatch(
            pump.next_ui_task_start()
                .context("ORIGINAL_CREATION_REQUIRED")?,
        )
        .await;
    let (state, created) = response.await?;
    let created = created?;
    let mut collected = Vec::new();
    while let Ok(frame) = frames.try_recv() {
        collected.push(frame);
    }
    Ok((state, created, collected))
}

#[tokio::test]
async fn original_creation_receipt_and_peer_attachment_keep_one_task_and_lease() -> Result<()> {
    let fixture = Fixture::new();
    let factory = factory(&fixture);
    let workspace = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let mut engine = workspace.clone();
    let mut manager = ThreadManager::default();
    let mut owners = super::super::NativeUiTaskOwners::default();
    let interactions = Arc::new(AtomicU64::new(1));
    let receipts = Arc::new(std::sync::Mutex::new(InteractionReceipts::default()));
    let sequence = Arc::new(AtomicU64::new(1));
    let mut automations = ProjectAutomations::new(
        workspace.cron_scheduler(),
        false,
        fixture.workspace.to_string_lossy().into_owned(),
    );
    let mut dispatch = NativeUiTaskStartDispatch {
        owners: &mut owners,
        engine: &mut engine,
        workspace: &workspace,
        factory: &factory,
        permission_mode: kcoder_config::PermissionMode::Ask,
        manager: &mut manager,
        interactions: &interactions,
        receipts: &receipts,
        server: "original-app-server",
        sequence: &sequence,
        automations: &mut automations,
    };
    let (mut pump, client) = NativeRuntimePump::new();
    pump.enable_task_owners();
    let (first, created, frames) =
        original_start(&mut dispatch, &mut pump, &client, ui(&fixture)?).await?;
    let thread = created
        .original_thread
        .context("ORIGINAL_COMPLETED_TASK_REQUIRED")?;
    let result = frames
        .iter()
        .find(|f| f["id"] == "create-rpc")
        .context("ORIGINAL_RPC_REQUIRED")?;
    assert_eq!(result["result"]["thread"]["id"], thread, "{result}");
    assert!(frames.iter().any(|f| f["method"] == "thread/started"));
    let resident = dispatch.manager.engine(&thread).unwrap();
    let history = resident
        .state
        .history_path()
        .context("PERSISTED_HISTORY_REQUIRED")?;
    let before = std::fs::read(&history)?;
    assert!(
        dispatch
            .manager
            .lease(&thread)
            .unwrap()
            .matches_target(&resident.session_lease_target())
    );
    use kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskQuery as Query;
    let turn = dispatch.manager.turn_state(&thread).unwrap();
    turn.running
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (first, reads, list) = original_read(
        &mut dispatch,
        &mut pump,
        &client,
        first,
        Default::default(),
        Query::List(serde_json::from_value(json!({"limit":100}))?),
    )
    .await?;
    turn.running
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(
        list["result"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == thread && t["status"] == "running"),
        "Read must use the actual Core manager, rather than a frontend's idle projection"
    );
    let (first, reads, read) = original_read(
        &mut dispatch,
        &mut pump,
        &client,
        first,
        reads,
        Query::Read(serde_json::from_value(
            json!({"threadId":thread,"limit":10}),
        )?),
    )
    .await?;
    assert_eq!(read["result"]["thread"]["id"], thread);
    let (first, reads, creation) = original_read(
        &mut dispatch,
        &mut pump,
        &client,
        first,
        reads,
        Query::Creation(serde_json::from_value(
            json!({"clientRequestId":"original-create"}),
        )?),
    )
    .await?;
    assert_eq!(creation["result"]["receipt"]["threadId"], thread);
    let (first, _, receipt) = original_read(
        &mut dispatch,
        &mut pump,
        &client,
        first,
        reads,
        Query::Receipt(serde_json::from_value(
            json!({"threadId":thread,"clientMessageId":"not-submitted"}),
        )?),
    )
    .await?;
    assert!(receipt["result"]["receipt"].is_null());
    assert_eq!(
        std::fs::read(&history)?,
        before,
        "Read queries cannot change task history"
    );
    let (second, replayed, replay_frames) =
        original_start(&mut dispatch, &mut pump, &client, ui(&fixture)?).await?;
    assert_eq!(replayed.original_thread.as_deref(), Some(thread.as_str()));
    assert_eq!(dispatch.manager.resident_engines().len(), 1);
    assert!(
        dispatch
            .manager
            .engine(&thread)
            .unwrap()
            .state
            .shares_state_with(&resident.state)
    );
    assert!(replayed.owner.is_some());
    assert_eq!(
        replay_frames.len(),
        1,
        "Receipt recovery must not replay startup events or hooks"
    );
    assert_eq!(std::fs::read(&history)?, before);
    first.input_ended.cancel();
    dispatch
        .owners
        .retire_ended(dispatch.manager, dispatch.engine, dispatch.workspace)
        .await;
    assert!(
        dispatch.manager.owns(&thread),
        "Another live client must retain the same resident task"
    );
    second.input_ended.cancel();
    dispatch
        .owners
        .retire_ended(dispatch.manager, dispatch.engine, dispatch.workspace)
        .await;
    assert!(dispatch.manager.owns(&thread));
    assert_eq!(
        std::fs::read(&history)?,
        before,
        "Client detach cannot delete history"
    );
    let original: ThreadStartParams =
        serde_json::from_value(json!({"clientRequestId":"original-create"}))?;
    assert_eq!(
        crate::app_server::thread_creations::completed_original(&workspace, &original)?
            .0
            .id,
        thread
    );
    assert!(crate::app_server::SessionLease::acquire_existing_history(&history).is_err());
    // Cold receipt recovery follows explicit host eviction, not UI EOF.
    dispatch
        .manager
        .remove_if_idle(&thread)
        .map_err(|()| anyhow::anyhow!("original runtime is not idle"))?
        .context("idle original runtime missing")?
        .shutdown()
        .await;
    *dispatch.engine = dispatch.workspace.clone();
    let lease = crate::app_server::SessionLease::acquire(&history)?;
    drop(lease);
    let (_, cold, cold_frames) =
        original_start(&mut dispatch, &mut pump, &client, ui(&fixture)?).await?;
    assert_eq!(cold.original_thread.as_deref(), Some(thread.as_str()));
    assert!(
        cold.owner.is_none(),
        "A cold creation receipt is not a replacement runtime"
    );
    assert!(dispatch.manager.resident_engines().is_empty());
    assert_eq!(cold_frames.len(), 1);
    assert_eq!(std::fs::read(&history)?, before);
    pump.close().await;
    Ok(())
}

#[tokio::test]
async fn rejected_source_creates_no_task_receipt_or_original_rpc_response() -> Result<()> {
    let fixture = Fixture::new();
    let factory = factory(&fixture);
    let workspace = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let mut engine = workspace.clone();
    let mut manager = ThreadManager::default();
    let mut owners = super::super::NativeUiTaskOwners::default();
    let interactions = Arc::new(AtomicU64::new(1));
    let receipts = Arc::new(std::sync::Mutex::new(InteractionReceipts::default()));
    let sequence = Arc::new(AtomicU64::new(1));
    let mut automations =
        ProjectAutomations::new(workspace.cron_scheduler(), false, "owned".into());
    let mut dispatch = NativeUiTaskStartDispatch {
        owners: &mut owners,
        engine: &mut engine,
        workspace: &workspace,
        factory: &factory,
        permission_mode: kcoder_config::PermissionMode::Ask,
        manager: &mut manager,
        interactions: &interactions,
        receipts: &receipts,
        server: "original-app-server",
        sequence: &sequence,
        automations: &mut automations,
    };
    let state = ui(&fixture)?;
    state.input_ended.cancel();
    let authority = Arc::new(OriginalUi(Arc::downgrade(&state.source_management_owner)));
    let params: ThreadStartParams =
        serde_json::from_value(json!({"clientRequestId":"original-create"}))?;
    let (outbound, mut frames) = mpsc::channel(2);
    let (reply, response) = oneshot::channel();
    dispatch
        .dispatch(NativeUiTaskStartRequest {
            state,
            params: params.clone(),
            id: json!("create-rpc"),
            outbound,
            retired: CancellationToken::new(),
            authority,
            reply,
        })
        .await;
    let (_, result) = response.await?;
    assert!(
        result
            .err()
            .context("Original rejection required")?
            .downcast_ref::<super::super::NativeUiTaskResumeRejected>()
            .is_some()
    );
    assert!(frames.try_recv().is_err());
    assert!(dispatch.manager.resident_engines().is_empty());
    assert!(crate::app_server::thread_creations::completed_original(&workspace, &params).is_err());
    Ok(())
}

struct BackgroundConsent(std::sync::atomic::AtomicBool);
impl crate::app_server::thread_runtime::PreparedThreadOwnerFence for BackgroundConsent {
    fn verify(&self) -> Result<()> {
        ensure!(
            self.0.load(std::sync::atomic::Ordering::SeqCst),
            "BACKGROUND_CONSENT_REVOKED"
        );
        Ok(())
    }
    fn allows_ui_resume(&self) -> bool {
        true
    }
}
struct ResidentConsent {
    native: crate::app_server::integrations::core::NativeIntegrationContext,
    thread: String,
    fence: Arc<BackgroundConsent>,
}
impl super::super::NativeTaskOwnerAuthority for ResidentConsent {
    fn verify(&self) -> Result<()> {
        self.native.verify()?;
        crate::app_server::thread_runtime::PreparedThreadOwnerFence::verify(self.fence.as_ref())
    }
    fn thread_id(&self) -> &str {
        &self.thread
    }
    fn prepare(&self) -> Result<crate::app_server::thread_runtime::PreparedThreadOwner> {
        panic!("A resident task must keep its current SessionLease")
    }
    fn retain_resident_background(&self, manager: &mut ThreadManager) -> Result<bool> {
        manager.retain_resident_background_lifetime(
            &self.native,
            &self.thread,
            self.fence.clone(),
        )?;
        Ok(true)
    }
}

#[tokio::test]
async fn background_policy_keeps_one_lease_and_revocation_preserves_a_live_web_client() -> Result<()>
{
    let fixture = Fixture::new();
    let factory = factory(&fixture);
    let workspace = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let mut engine = workspace.clone();
    let mut manager = ThreadManager::default();
    let mut owners = super::super::NativeUiTaskOwners::default();
    let interactions = Arc::new(AtomicU64::new(1));
    let receipts = Arc::new(std::sync::Mutex::new(InteractionReceipts::default()));
    let sequence = Arc::new(AtomicU64::new(1));
    let mut automations =
        ProjectAutomations::new(workspace.cron_scheduler(), false, "owned".into());
    let mut dispatch = NativeUiTaskStartDispatch {
        owners: &mut owners,
        engine: &mut engine,
        workspace: &workspace,
        factory: &factory,
        permission_mode: kcoder_config::PermissionMode::Ask,
        manager: &mut manager,
        interactions: &interactions,
        receipts: &receipts,
        server: "original-app-server",
        sequence: &sequence,
        automations: &mut automations,
    };
    let (mut pump, client) = NativeRuntimePump::new();
    pump.enable_task_owners();
    let (first, created, _) =
        original_start(&mut dispatch, &mut pump, &client, ui(&fixture)?).await?;
    let thread = created
        .original_thread
        .context("ORIGINAL_COMPLETED_TASK_REQUIRED")?;
    let resident = dispatch.manager.engine(&thread).unwrap();
    let history = resident.state.history_path().unwrap();
    let bytes = std::fs::read(&history)?;
    let original_owner = dispatch
        .manager
        .handoff_snapshot(&thread, "original-app-server")
        .owner_ref;
    let consent = Arc::new(BackgroundConsent(std::sync::atomic::AtomicBool::new(true)));
    let authority = Arc::new(ResidentConsent {
        native: fixture.context.recapture_for_owned_service()?,
        thread: thread.clone(),
        fence: consent.clone(),
    });
    let (outbound, _) = mpsc::channel(2);
    let (retained, observed) = tokio::join!(
        client.prepare_task_owner(authority, std::time::Duration::from_secs(5)),
        async {
            loop {
                let event = pump.receive().await;
                let control = matches!(
                    &event,
                    super::super::RuntimePumpEvent::Control(super::super::Control::TaskOwner(_))
                );
                pump.observe_with_task_owners(event, &outbound, dispatch.manager)
                    .await?;
                if control {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(())
        }
    );
    observed?;
    assert!(matches!(
        retained?,
        crate::app_server::thread_runtime::TaskOwnerPresence::Resident
    ));
    assert!(dispatch.manager.has_background_lifetime(&thread));
    first.input_ended.cancel();
    dispatch
        .owners
        .retire_ended(dispatch.manager, dispatch.engine, dispatch.workspace)
        .await;
    assert!(dispatch.manager.owns(&thread));
    assert!(
        dispatch
            .manager
            .engine(&thread)
            .unwrap()
            .state
            .shares_state_with(&resident.state)
    );
    assert_eq!(
        dispatch
            .manager
            .handoff_snapshot(&thread, "original-app-server")
            .owner_ref,
        original_owner
    );
    assert!(crate::app_server::SessionLease::acquire_existing_history(&history).is_err());
    let (second, _, _) = original_start(&mut dispatch, &mut pump, &client, ui(&fixture)?).await?;
    consent.0.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(
        !dispatch.manager.has_background_lifetime(&thread),
        "Revocation must apply before maintenance"
    );
    dispatch.manager.prune_prepared_owners();
    dispatch
        .owners
        .retire_ended(dispatch.manager, dispatch.engine, dispatch.workspace)
        .await;
    assert!(
        dispatch.manager.owns(&thread),
        "A lawful Web client retains its own lifetime"
    );
    second.input_ended.cancel();
    dispatch
        .owners
        .retire_ended(dispatch.manager, dispatch.engine, dispatch.workspace)
        .await;
    assert!(dispatch.manager.owns(&thread));
    assert_eq!(std::fs::read(&history)?, bytes);
    assert!(crate::app_server::SessionLease::acquire_existing_history(&history).is_err());
    for runtime in dispatch.manager.drain() {
        runtime.shutdown().await;
    }
    assert!(crate::app_server::SessionLease::acquire_existing_history(&history).is_ok());
    pump.close().await;
    Ok(())
}
