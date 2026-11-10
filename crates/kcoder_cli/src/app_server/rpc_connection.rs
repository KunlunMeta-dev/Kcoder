//! A client owns presentation resources; the host alone owns its ThreadManager.
use super::*;
use integrations::core::runtime_pump::{NativeUiTaskOwner, NativeUiTaskOwners};
use std::collections::{BTreeMap, BTreeSet};

pub(super) trait RpcSource: Send + Sync {
    fn verify(&self, state: &ConnectionState) -> Result<()>;
}
pub(super) struct RpcRequest {
    pub client: Box<RpcClient>,
    pub line: Option<String>,
    pub source: Arc<dyn RpcSource>,
    pub reply: tokio::sync::oneshot::Sender<(Box<RpcClient>, Result<bool>)>,
}
pub(super) struct HostContext<'a> {
    pub engine_factory: &'a AppServerEngineFactory,
    pub workspace_engine: &'a QueryEngine,
    pub permission_mode: kcoder_config::PermissionMode,
    pub thread_manager: &'a mut ThreadManager,
    pub next_interaction_id: &'a Arc<AtomicU64>,
    pub server_id: &'a String,
    pub sequence: &'a Arc<AtomicU64>,
    pub owners: &'a mut NativeUiTaskOwners,
    #[cfg(target_os = "linux")]
    pub interruptions: &'a mut turn_interrupt::NativeInterruptJobs,
}
pub(super) struct RpcClient {
    pub state: ConnectionState,
    engine: QueryEngine,
    outbound_tx: mpsc::Sender<Value>,
    id: String,
    hub: rpc_hub::RpcHub,
    owners: BTreeMap<String, Arc<NativeUiTaskOwner>>,
    terminals: TerminalRegistry,
    browsers: BrowserRegistry,
    history_refresh: history_refresh_processor::HistoryRefreshProcessor,
    thread_list_snapshots: thread_list_snapshots::ThreadListSnapshots,
    attachment_directories: AttachmentDirectories,
    plugin_tasks: tokio::task::JoinSet<()>,
    provider_tasks: tokio::task::JoinSet<()>,
    indexed_read_tasks: tokio::task::JoinSet<()>,
    migration_control_tasks: tokio::task::JoinSet<()>,
    migration_observation_tasks: tokio::task::JoinSet<()>,
    storage_scans: storage_scans::StorageScans,
    indexed_read_gates: indexed_read_gate::IndexedReadGate,
    thread_presence_gate: Arc<tokio::sync::Semaphore>,
    thread_presence_cancellation: CancellationToken,
    thread_goal_status_gate: Arc<tokio::sync::Semaphore>,
    thread_goal_status_cancellation: CancellationToken,
    plugin_processor: PluginProcessor,
    mcp_authorization: mcp_authorization_processor::McpAuthorizationProcessor,
    migration_processor: Arc<migration_processor::MigrationProcessor>,
    provider_settings_state: Result<provider_settings::ProviderSettingsState>,
    automations: project_automations::ProjectAutomations,
    automation_responses: project_automations::AutomationResponses,
    automation_requested: bool,
    idle_shutdown_requested: bool,
    next_terminal_id: AtomicU64,
    connection_receipts: Arc<StdMutex<InteractionReceipts>>,
    delivered_interactions: Arc<StdMutex<BTreeSet<u64>>>,
    retention_authority: Option<Arc<retention_context::VerifiedRetentionAuthority>>,
    migration_source_authority: Option<Arc<migration_source_authority::MigrationSourceAuthority>>,
}
impl RpcClient {
    pub fn open(
        state: ConnectionState,
        workspace: &QueryEngine,
        factory: &AppServerEngineFactory,
        hub: rpc_hub::RpcHub,
        wire: mpsc::Sender<Value>,
        connection_receipts: Arc<StdMutex<InteractionReceipts>>,
    ) -> Result<Box<Self>> {
        ensure!(
            state
                .native_scope_host
                .as_ref()
                .is_some_and(|host| host.launch().persistent_task_host()),
            "APP_SERVER_RPC_ORIGINAL_HOST_REQUIRED"
        );
        Self::open_resources(state, workspace, factory, hub, wire, connection_receipts)
    }

    fn open_resources(
        mut state: ConnectionState,
        workspace: &QueryEngine,
        factory: &AppServerEngineFactory,
        hub: rpc_hub::RpcHub,
        wire: mpsc::Sender<Value>,
        connection_receipts: Arc<StdMutex<InteractionReceipts>>,
    ) -> Result<Box<Self>> {
        state.client_transport_only = true;
        let settings = workspace.settings.read().unwrap();
        let credentials_path = workspace
            .settings_persistence_path()
            .context("plugin credential profile unavailable")?
            .with_file_name("credentials.json");
        let plugin_processor = PluginProcessor::open_with_profile(
            &workspace.state.cwd(),
            settings.plugins.clone(),
            credentials_path,
            settings.credential_store,
        )?;
        let training = settings.training_mode;
        drop(settings);
        let id = uuid::Uuid::new_v4().simple().to_string();
        hub.attach(&id, wire, state.input_ended.clone());
        hub.negotiate_task_state(&id, state.integration_task_state_v1);
        let (outbound_tx, frames) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
        let delivered_interactions =
            match hub.relay_client(id.clone(), frames, state.input_ended.clone()) {
                Ok(delivered) => delivered,
                Err(error) => {
                    state.input_ended.cancel();
                    hub.detach(&id);
                    return Err(error);
                }
            };
        Ok(Box::new(Self {
            engine: workspace.clone(),
            state,
            outbound_tx,
            id,
            hub,
            owners: Default::default(),
            terminals: Default::default(),
            browsers: BrowserRegistry::new(),
            history_refresh: Default::default(),
            thread_list_snapshots: Default::default(),
            attachment_directories: Default::default(),
            plugin_tasks: Default::default(),
            provider_tasks: Default::default(),
            indexed_read_tasks: Default::default(),
            migration_control_tasks: Default::default(),
            migration_observation_tasks: Default::default(),
            storage_scans: Default::default(),
            indexed_read_gates: Default::default(),
            thread_presence_gate: Arc::new(tokio::sync::Semaphore::new(1)),
            thread_presence_cancellation: CancellationToken::new(),
            thread_goal_status_gate: Arc::new(tokio::sync::Semaphore::new(1)),
            thread_goal_status_cancellation: CancellationToken::new(),
            plugin_processor,
            mcp_authorization: Default::default(),
            migration_processor: Arc::new(migration_processor::MigrationProcessor::new()),
            provider_settings_state: provider_settings::capture_state(workspace).map(|state| {
                state
                    .with_session_reload(factory.supports_session_reload())
                    .with_turn_model_reload(factory.supports_turn_model_reload())
            }),
            automations: project_automations::ProjectAutomations::new(
                workspace.cron_scheduler(),
                !training,
                workspace.state.cwd().to_string_lossy().into_owned(),
            ),
            automation_responses: project_automations::AutomationResponses::new(
                workspace.cron_scheduler(),
            ),
            automation_requested: false,
            idle_shutdown_requested: false,
            next_terminal_id: AtomicU64::new(1),
            connection_receipts,
            delivered_interactions,
            // A UI transport does not inherit another process's private parent proofs.
            retention_authority: None,
            migration_source_authority: None,
        }))
    }
    async fn close(&mut self) {
        self.state.input_ended.cancel();
        self.thread_presence_cancellation.cancel();
        self.thread_goal_status_cancellation.cancel();
        self.hub.detach(&self.id);
        self.plugin_processor.cancel();
        self.migration_processor.cancellation().cancel();
        self.terminals.shutdown_all();
        self.browsers.shutdown_all().await;
        let _ = mcp_apps_rpc::revoke_original_registry(&self.state.mcp_app_registry, None).await;
        self.state.desktop_recovery_tasks.abort_all();
        self.state.knowledge_rpc_tasks.abort_all();
        self.state.wiki_rpc_tasks.abort_all();
        while self.state.wiki_rpc_tasks.join_next().await.is_some() {}
        for tasks in [
            &mut self.state.continuous_work_read_tasks,
            &mut self.state.continuous_work_mutation_tasks,
        ] {
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        }
        self.state.knowledge_tasks.abort_all();
        self.provider_tasks.abort_all();
        self.indexed_read_tasks.abort_all();
        self.plugin_tasks.abort_all();
        self.migration_control_tasks.abort_all();
        self.migration_observation_tasks.abort_all();
        self.migration_processor.shutdown().await;
        let _ = session_mcp::await_cleanup(&mut self.state.temporary_mcp_cleanup).await;
    }
}
impl Drop for RpcClient {
    fn drop(&mut self) {
        self.state.input_ended.cancel();
        self.thread_presence_cancellation.cancel();
        self.thread_goal_status_cancellation.cancel();
        self.hub.detach(&self.id);
        self.terminals.shutdown_all();
        self.plugin_processor.cancel();
        self.migration_processor.cancellation().cancel();
    }
}

pub(super) async fn dispatch(mut request: RpcRequest, host: HostContext<'_>) {
    let client = &mut request.client;
    let result = async {
        let Some(line) = request.line.as_deref() else {
            // Cleanup must also work after the source has ended or was revoked.
            client.close().await;
            return Ok(false);
        };
        request.source.verify(&client.state)?;
        let frame = serde_json::from_str::<Value>(line).ok();
        // Replies are accepted only on the connection that received the original
        // question/approval. Knowing another client's numeric ID grants nothing.
        if let Some(frame) = &frame
            && frame.get("method").is_none()
            && let Some(id) = frame.get("id").and_then(Value::as_u64)
        {
            let delivered = client
                .delivered_interactions
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !delivered.contains(&id) {
                return Ok(true);
            }
        }
        let target = frame
            .as_ref()
            .and_then(rpc_hub::thread_id)
            .map(str::to_owned);
        if let Some(thread) = &target
            && host.thread_manager.is_ephemeral(thread)
            && !client.owners.contains_key(thread)
        {
            let id = frame
                .as_ref()
                .and_then(|f| f.get("id"))
                .cloned()
                .unwrap_or(Value::Null);
            send(
                &client.outbound_tx,
                error_response(id, -32036, "Temporary thread belongs to another client"),
            )
            .await?;
            return Ok(true);
        }
        if let Some(thread) = &target
            && (client.owners.contains_key(thread)
                || integrations::connectivity::task_ui::verify_expert_control(
                    &client.state,
                    host.workspace_engine,
                    thread,
                )
                .is_ok())
        {
            client.hub.subscribe(&client.id, thread);
        }
        let before: BTreeMap<_, _> = host
            .thread_manager
            .resident_engines()
            .into_iter()
            .map(|engine| {
                let id = engine.session_id();
                let owner = host
                    .thread_manager
                    .handoff_snapshot(&id, host.server_id)
                    .owner_ref;
                (id, owner)
            })
            .collect();
        while client.plugin_tasks.try_join_next().is_some() {}
        while client.provider_tasks.try_join_next().is_some() {}
        while client.indexed_read_tasks.try_join_next().is_some() {}
        while client.state.knowledge_rpc_tasks.try_join_next().is_some() {}
        while client.state.wiki_rpc_tasks.try_join_next().is_some() {}
        while client
            .state
            .continuous_work_read_tasks
            .try_join_next()
            .is_some()
        {}
        while client
            .state
            .continuous_work_mutation_tasks
            .try_join_next()
            .is_some()
        {}
        while client.migration_control_tasks.try_join_next().is_some() {}
        while client.migration_observation_tasks.try_join_next().is_some() {}
        // An interrupt may wait for a Native reply after this client leaves.
        // Its original settlement job belongs to the host, not the socket.
        #[cfg(target_os = "linux")]
        let interrupts_host_turn = frame.as_ref().is_some_and(|frame| {
            frame.get("method").and_then(Value::as_str) == Some("turn/interrupt")
        });
        #[cfg(target_os = "linux")]
        if interrupts_host_turn {
            std::mem::swap(&mut client.state.native_interrupts, host.interruptions);
        }
        let result = Box::pin(connection_requests::dispatch(
            connection_requests::RequestContext {
                engine: &mut client.engine,
                engine_factory: host.engine_factory,
                workspace_engine: host.workspace_engine,
                permission_mode: host.permission_mode,
                outbound_tx: &client.outbound_tx,
                thread_manager: &mut *host.thread_manager,
                terminals: &client.terminals,
                history_refresh: &mut client.history_refresh,
                browsers: &mut client.browsers,
                plugin_tasks: &mut client.plugin_tasks,
                migration_control_tasks: &mut client.migration_control_tasks,
                migration_observation_tasks: &mut client.migration_observation_tasks,
                provider_tasks: &mut client.provider_tasks,
                indexed_read_tasks: &mut client.indexed_read_tasks,
                automations: &mut client.automations,
                automation_requested: &mut client.automation_requested,
                idle_shutdown_requested: &mut client.idle_shutdown_requested,
                storage_scans: &client.storage_scans,
                provider_settings_state: &client.provider_settings_state,
                attachment_directories: &mut client.attachment_directories,
                next_terminal_id: &client.next_terminal_id,
                next_interaction_id: host.next_interaction_id,
                connection_receipts: &client.connection_receipts,
                server_id: host.server_id,
                sequence: host.sequence,
                automation_fire: &None,
                state: &mut client.state,
                thread_list_snapshots: &mut client.thread_list_snapshots,
                retention_authority: &client.retention_authority,
                migration_source_authority: &client.migration_source_authority,
                migration_processor: &client.migration_processor,
                plugin_processor: &client.plugin_processor,
                mcp_authorization: &client.mcp_authorization,
                indexed_read_gates: &mut client.indexed_read_gates,
                thread_presence_gate: &client.thread_presence_gate,
                thread_presence_cancellation: &client.thread_presence_cancellation,
                thread_goal_status_gate: &client.thread_goal_status_gate,
                thread_goal_status_cancellation: &client.thread_goal_status_cancellation,
                // Every frame on this transport comes from its attached client.
                request_origin: request_origin::RequestOrigin::ClientFrame,
                automation_responses: &client.automation_responses,
            },
            line,
        ))
        .await;
        #[cfg(target_os = "linux")]
        if interrupts_host_turn {
            std::mem::swap(&mut client.state.native_interrupts, host.interruptions);
        }
        if let Some(thread) = &target
            && !host.thread_manager.owns(thread)
        {
            client.hub.unsubscribe(&client.id, thread);
        }
        for engine in host.thread_manager.resident_engines() {
            let thread = engine.session_id();
            let current = host
                .thread_manager
                .handoff_snapshot(&thread, host.server_id)
                .owner_ref;
            let newly_resident = before.get(&thread) != Some(&current);
            if !newly_resident && target.as_deref() != Some(&thread) {
                continue;
            }
            if newly_resident && client.state.integration_context.is_some() {
                integrations::connectivity::task_ui::retain_original_configuration(
                    &client.state,
                    host.thread_manager,
                    &thread,
                )?;
            }
            let owner = NativeUiTaskOwner::capture_presentation(
                &client.state,
                host.thread_manager,
                &thread,
                host.server_id,
                CancellationToken::new(),
            )?;
            if client
                .owners
                .get(&thread)
                .is_none_or(|previous| previous.retired() || !previous.same_resident(&owner))
            {
                host.owners.retain(owner.clone());
                client.owners.insert(thread.clone(), owner);
            }
        }
        request.source.verify(&client.state)?;
        match result? {
            DispatchControl::Continue => Ok(true),
            DispatchControl::Shutdown => {
                client.close().await;
                Ok(false)
            }
        }
    }
    .await;
    // A transport error still retires only this client's resources.
    if result.is_err() {
        client.close().await;
    }
    let _ = request.reply.send((request.client, result));
}
pub(super) fn unavailable(request: RpcRequest) {
    let _ = request.reply.send((
        request.client,
        Err(anyhow::anyhow!("APP_SERVER_RPC_NOT_SUBMITTED")),
    ));
}

#[cfg(test)]
mod tests;
