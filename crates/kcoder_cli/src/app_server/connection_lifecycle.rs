//! Connection lifecycle: extracted from the app-server connection boundary.

use super::*;
use futures::{FutureExt, future::LocalBoxFuture};

mod outbound_writer;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep purpose-specific private launches separate from inherited host resources"
)]
pub(crate) fn run_with_native_launches(
    engine: QueryEngine,
    factory: AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
    retention_launch: Option<RetentionLaunchConfiguration>,
    migration_launch: Option<RetentionLaunchConfiguration>,
    peer_ssh_launch: Option<session_messages::ssh_parent::PeerSshLaunch>,
    office_launch: Option<std::ffi::OsString>,
    connectivity_launch: Option<std::ffi::OsString>,
) -> LocalBoxFuture<'static, Result<()>> {
    run_with_native_launches_inner(
        engine,
        factory,
        permission_mode,
        retention_launch,
        migration_launch,
        peer_ssh_launch,
        office_launch,
        connectivity_launch,
    )
    .boxed_local()
}
#[expect(
    clippy::too_many_arguments,
    reason = "Keep purpose-specific private launches separate from inherited host resources"
)]
async fn run_with_native_launches_inner(
    mut engine: QueryEngine,
    mut engine_factory: AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
    retention_launch: Option<RetentionLaunchConfiguration>,
    migration_launch: Option<RetentionLaunchConfiguration>,
    peer_ssh_launch: Option<session_messages::ssh_parent::PeerSshLaunch>,
    office_launch: Option<std::ffi::OsString>,
    connectivity_launch: Option<std::ffi::OsString>,
) -> Result<()> {
    ensure!(
        migration_launch.is_none() || retention_launch.is_none(),
        "source_transfer_parent_conflict"
    );
    let peer_launch = migration_launch
        .as_ref()
        .or(retention_launch.as_ref())
        .map(|launch| session_messages::service::PeerRouterLaunch {
            parent: launch.parent.clone(),
            account_root: launch.account_root.clone(),
        });
    let peer_service = match engine_factory.profile_paths().and_then(|paths| {
        session_messages::service::PeerMessageService::capture_native(
            paths,
            engine.state.cwd(),
            peer_launch,
            peer_ssh_launch.as_ref(),
        )
    }) {
        Ok(service) => Some(service),
        Err(_) => {
            tracing::debug!(
                code = "peer_message_profile_unavailable",
                "Peer communication profile unavailable"
            );
            None
        }
    };
    let migration_source_authority = match migration_launch.as_ref().or(retention_launch.as_ref()) {
        None => None,
        Some(launch) => {
            let captured = (|| -> Result<_> {
                let settings = engine_factory.hook_user_settings_path()?;
                ensure!(
                    settings
                        .file_name()
                        .is_some_and(|name| name == "settings.json"),
                    "source_transfer_invalid_profile"
                );
                migration_source_authority::MigrationSourceAuthority::capture(
                    &launch.parent,
                    &launch.account_root,
                    settings
                        .parent()
                        .context("source_transfer_invalid_profile")?,
                )
            })();
            match captured {
                Ok(authority) => Some(Arc::new(authority)),
                Err(_) if migration_launch.is_some() => {
                    anyhow::bail!("source_transfer_authority_unavailable")
                }
                Err(_) => None,
            }
        }
    };
    let _migration_source_close_guard = migration_source_authority
        .as_ref()
        .map(|authority| authority.close_guard());
    #[cfg(windows)]
    let windows_component_parent = retention_launch.as_ref().and_then(|configuration| {
        match native_component_parent::WindowsComponentParent::capture(configuration, &engine) {
            Ok(parent) => Some(Arc::new(parent)),
            Err(_) => {
                tracing::warn!(
                    code = "NATIVE_WINDOWS_PARENT_UNAVAILABLE",
                    "Native component parent unavailable"
                );
                None
            }
        }
    });
    #[cfg(target_os = "macos")]
    let macos_component_parent = retention_launch.as_ref().and_then(|configuration| {
        match native_component_parent::MacosComponentParent::capture(configuration, &engine) {
            Ok(parent) => Some(Arc::new(parent)),
            Err(_) => {
                tracing::warn!(
                    code = "NATIVE_MACOS_PARENT_UNAVAILABLE",
                    "Native component parent unavailable"
                );
                None
            }
        }
    });
    let retention_authority = match retention_launch {
        None => None,
        Some(launch) => {
            crate::retention_parent_environment::validate_identity(&launch.parent)?;
            let optional = launch.optional;
            match retention_context::capture(launch, &engine) {
                Ok(authority) => Some(Arc::new(authority)),
                Err(_) if optional => {
                    // Never expose raw parent facts, filesystem paths or secrets.
                    tracing::warn!(
                        code = "workspace_receipts_v2_unavailable",
                        "Workspace V2 authority unavailable; ordinary runtime remains available"
                    );
                    None
                }
                Err(error) => return Err(error),
            }
        }
    };
    let component_parent_owner = retention_authority
        .as_ref()
        .map(native_component_parent::from_retention);
    #[cfg(windows)]
    let component_parent_owner = component_parent_owner.or_else(|| {
        windows_component_parent.as_ref().map(|parent| {
            parent.clone() as Arc<dyn native_component_parent::NativeComponentParentAuthority>
        })
    });
    #[cfg(target_os = "macos")]
    let component_parent_owner = component_parent_owner.or_else(|| {
        macos_component_parent.as_ref().map(|parent| {
            parent.clone() as Arc<dyn native_component_parent::NativeComponentParentAuthority>
        })
    });
    let component_parent = component_parent_owner.as_deref();
    let integration_office_resources = if component_parent.is_some() {
        match office_launch {
            Some(raw) => {
                let captured = raw.to_str().ok_or_else(|| anyhow::anyhow!("OFFICE_STARTUP_INVALID"))
                    .and_then(|value| integrations::office::startup_binding::NativeOfficeStartupBinding::capture_with_verified_parent_owner(
                        component_parent_owner.clone(), &engine, Some(value),
                    ));
                match captured {
                    Ok(binding) => binding.map(Arc::new),
                    Err(_) => {
                        tracing::warn!(
                            code = "OFFICE_NATIVE_UNAVAILABLE",
                            "Office startup configuration unavailable; ordinary runtime remains available"
                        );
                        None
                    }
                }
            }
            None => None,
        }
    } else {
        None
    };
    let workspace_engine = engine.clone();
    let (discovery_host, mut discovery_requests) = session_discovery::channel(&workspace_engine);
    let mut discovery_pages = session_discovery::DiscoveryPages::default();
    let mut discovery_jobs = session_discovery::DiscoveryJobs::default();
    let provider_settings_state =
        provider_settings::capture_state(&workspace_engine).map(|state| {
            state
                .with_session_reload(engine_factory.supports_session_reload())
                .with_turn_model_reload(engine_factory.supports_turn_model_reload())
        });
    let _attachment_cleanup = attachments::AttachmentCleanupSweep::spawn();
    let (outbound_tx, outbound_rx) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let peer_presentation = Arc::new(rpc_hub::PeerMessagePresentation::default());
    let peer_backchannel = Some(session_messages::backchannel::PeerRouterBackchannel::new(
        outbound_tx.clone(),
    ));
    let (peer_host, global_discovery, mut peer_requests) = session_messages::host::channel(
        peer_backchannel
            .as_ref()
            .expect("owned peer backchannel")
            .clone(),
        discovery_host.clone(),
    );
    engine_factory.set_session_discovery_host(if peer_service.is_some() {
        global_discovery
    } else {
        discovery_host
    });
    if peer_service.is_some() {
        engine_factory.set_session_messages_host(peer_host);
    }
    engine = engine_factory.attach_session_host_tools(engine)?;
    let peer_router_rpc = peer_service.as_ref().and_then(|service| {
        let router = session_messages::router_rpc::RouterRpc::capture(
            service.clone(),
            workspace_engine.state.cwd(),
            workspace_engine.client_storage_root(),
            engine_factory.peer_message_history_directory(),
        )
        .ok()?;
        let router = if service.can_prepare_private_services() {
            let cold = session_messages::cold_source::NativeColdPeerSourceVerifier::capture(
                service.clone(),
                engine_factory.clone(),
                workspace_engine.state.cwd(),
                workspace_engine.client_storage_root(),
                engine_factory.peer_message_history_directory(),
            )
            .ok()?;
            router.with_cold_source_verifier(Arc::new(cold))
        } else {
            router
        };
        Some(Arc::new(router))
    });
    let (mut native_runtime, native_runtime_client) =
        integrations::core::runtime_pump::NativeRuntimePump::new();
    let next_interaction_id = Arc::new(AtomicU64::new(1_000_000));
    // Replies to an already resolved interaction are answered from here, so a
    // repeated reply is never delivered twice and never applied to a new turn.
    let app_server_epoch = uuid::Uuid::new_v4().simple().to_string();
    let connection_receipts = Arc::new(StdMutex::new(InteractionReceipts::new(app_server_epoch)));
    let automation_responses =
        project_automations::AutomationResponses::new(engine.cron_scheduler());
    let writer_automations = automation_responses.clone();
    let rpc_hub = native_runtime.rpc_hub();
    let writer_peer_presentation = peer_presentation.clone();
    let mut writer = tokio_util::task::AbortOnDropHandle::new(
        crate::app_server::task_spawn::spawn(async move {
            outbound_writer::write_frames(tokio::io::stdout(), outbound_rx, |message| {
                writer_automations.observe(&message);
                rpc_hub.observe(&message, None);
                if !writer_peer_presentation.allows_notification(&message) {
                    return None;
                }
                bounded_outbound_frame(message, OUTBOUND_FRAME_LIMIT_BYTES)
            })
            .await?;
            Ok::<(), anyhow::Error>(())
        }),
    );

    let resident_thread_limit = std::env::var("KCODER_APP_SERVER_RESIDENT_THREAD_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1024).contains(value))
        .unwrap_or(thread_runtime::DEFAULT_RESIDENT_THREAD_LIMIT);
    let mut thread_manager = ThreadManager::with_resident_limit(resident_thread_limit);
    if let Some(service) = &peer_service {
        thread_manager.configure_peer_services(service.clone(), peer_backchannel.clone());
    }
    let next_terminal_id = AtomicU64::new(1);
    let terminals = TerminalRegistry::default();
    let _terminal_guard = TerminalRegistryGuard(terminals.clone());
    let server_id = format!("server-{}", engine.session_id());
    let sequence = Arc::new(AtomicU64::new(1));
    let integration_connectivity_resources = match connectivity_launch.as_ref().and_then(|raw| raw.to_str()) {
        Some(raw) => match integrations::connectivity::installed_resources::NativeConnectivityStartupBinding::capture_after_verified_parent(
            component_parent, &engine, Some(raw),
        ) {
            Ok(binding) => binding.map(Arc::new),
            Err(_) => { tracing::warn!(code="APPLICATION_NATIVE_UNAVAILABLE", "Application host startup binding unavailable"); None }
        },
        None => None,
    };
    // Gateway owns app-server. The component descriptor enables its application host workers.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    let (scope_host, _legacy_host_guard) = {
        // `integrations.connectivity` is the persisted application-integration switch.
        let applications_enabled = workspace_engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("INTEGRATION_SETTINGS_UNAVAILABLE"))?
            .integrations
            .connectivity
            .enabled;
        if integration_connectivity_resources.is_some()
            && applications_enabled
            && integrations::core::service_leases::application_account_supported()
        {
            (
                Some(NativeScopeHostBootstrap::open_gateway(
                    integrations::core::capture_scope(&engine)?,
                )?),
                None,
            )
        } else {
            // Keep the original scope fence until stdio shuts down, even without SDK workers.
            let guard = integrations::core::service_leases::scope_host::task_frontend::guard_stdio_against_legacy_host(&engine)?;
            (None, guard)
        }
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    let scope_host: Option<Arc<NativeScopeHostBootstrap>> = None;
    let native_remote_host_client = component_parent_owner
        .as_ref()
        .and_then(|parent| {
            integrations::core::remote_delegations::transport::host_client::NativeRemoteHostClient::capture_if_configured(
                parent.clone(),
                &|| engine.settings_persistence_path(),
                &|| engine.state.cwd(),
                outbound_tx.clone(),
            ).map_err(|_| tracing::warn!(code = "REMOTE_HOST_PARENT_UNAVAILABLE", "Native remote host byte lane unavailable")).ok().flatten()
        });
    let _native_remote_host_connection = native_remote_host_client
        .as_ref()
        .map(|client| client.connection_guard());
    let mut state = ConnectionState {
        peer_presentation,
        native_scope_host: scope_host.clone(),
        direct_task_stdio: true,
        integration_context: scope_host
            .as_ref()
            .map(|host| host.native().recapture_for_owned_service())
            .transpose()?,
        native_remote_host_client,
        integration_office_resources,
        integration_connectivity_resources,
        integration_runtime: Some(native_runtime_client.clone()),
        tool_profiles_v1: engine_factory.supports_session_reload(),
        ..ConnectionState::default()
    };
    for parent in [
        Some(std::env::temp_dir()),
        kcoder_config::Settings::config_dir().ok(),
    ]
    .into_iter()
    .flatten()
    {
        if let Err(error) = kcoder_knowledge_rpc::scavenge_archive_staging(&parent) {
            tracing::warn!(%error, "failed to scavenge abandoned Wiki archive owners");
        }
    }
    let mut attachment_directories = AttachmentDirectories::default();
    let mut thread_list_snapshots = thread_list_snapshots::ThreadListSnapshots::default();
    let mut history_refresh = history_refresh_processor::HistoryRefreshProcessor::default();
    let mut browsers = BrowserRegistry::new();
    let (plugin_settings, credential_mode) = {
        let settings = engine.settings.read().unwrap();
        (settings.plugins.clone(), settings.credential_store)
    };
    let credentials_path = engine
        .settings_persistence_path()
        .context("plugin credential profile unavailable")?
        .with_file_name("credentials.json");
    let plugin_processor = PluginProcessor::open_with_profile(
        &engine.state.cwd(),
        plugin_settings,
        credentials_path,
        credential_mode,
    )
    .context("failed to initialize app-server plugin processor")?;
    let mcp_authorization = mcp_authorization_processor::McpAuthorizationProcessor::default();
    let migration_processor = Arc::new(migration_processor::MigrationProcessor::new());
    let _migration_cancellation_guard = migration_processor.cancellation().drop_guard();
    let mut migration_control_tasks = tokio::task::JoinSet::new();
    let mut migration_observation_tasks = tokio::task::JoinSet::new();
    let mut plugin_tasks = tokio::task::JoinSet::new();
    let mut deferred_rpc_admissions = tokio::task::JoinSet::new();
    let peer_admission_cancel = CancellationToken::new();
    let mut provider_tasks = tokio::task::JoinSet::new();
    let storage_scans = storage_scans::StorageScans::default();
    let mut indexed_read_tasks = tokio::task::JoinSet::new();
    let mut indexed_read_gates = indexed_read_gate::IndexedReadGate::default();
    let thread_presence_gate = Arc::new(tokio::sync::Semaphore::new(1));
    let thread_presence_cancellation = CancellationToken::new();
    let thread_goal_status_gate = Arc::new(tokio::sync::Semaphore::new(1));
    let thread_goal_status_cancellation = CancellationToken::new();
    let _thread_goal_status_cancellation_guard =
        thread_goal_status_cancellation.clone().drop_guard();
    let _thread_presence_cancellation_guard =
        thread_presence_requests::CancellationGuard::new(thread_presence_cancellation.clone());
    let mut input = connection_input::ConnectionInput::stdin();
    state.input_ended = input.ended();
    state.defer_thread_resumes = true;
    let mut deferred_native_resumes = std::collections::BTreeMap::new();
    let mut automations = project_automations::ProjectAutomations::new(
        workspace_engine.cron_scheduler(),
        !workspace_engine.settings.read().unwrap().training_mode,
        workspace_engine.state.cwd().to_string_lossy().into_owned(),
    );
    let business_automation = integrations::knowledge::NativeAutomationScheduler::default();
    let mut automation_tick = tokio::time::interval(Duration::from_millis(500));
    let mut peer_idle_tick = tokio::time::interval(Duration::from_secs(1));
    peer_idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut peer_idle_driver = session_messages::idle::PeerIdleDriver::new(
        session_messages::idle_turn::PeerIdleTurnContext {
            outbound: outbound_tx.clone(),
            server_id: server_id.clone(),
            sequence: sequence.clone(),
            next_turn_id: Arc::new(AtomicU64::new(1)),
            cancel: CancellationToken::new(),
            attended: true,
        },
    );
    let mut peer_cold_driver = peer_service.as_ref().and_then(|service| {
        session_messages::cold_target_runtime::ColdTargetDriver::new(
            engine_factory.clone(),
            service.clone(),
            workspace_engine.client_storage_root(),
            peer_backchannel.clone(),
            outbound_tx.clone(),
            server_id.clone(),
            sequence.clone(),
            next_interaction_id.clone(),
            connection_receipts.clone(),
            false,
            None,
        )
        .ok()
    });
    automation_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut automation_requested = false;
    let mut idle_shutdown_requested = false;
    #[cfg(unix)]
    let mut terminate_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .context("failed to install app-server SIGTERM handler")?;
    #[cfg(unix)]
    let mut terminated_by_signal = false;

    let mut next_scope_host_check = std::time::Instant::now();
    let connection_result: Result<()> = async {
    loop {
        if let Some(host) = &scope_host {
            // Infrastructure liveness is independent of per-input/per-effect
            // authorization. Busy RPC/event traffic must not replay this audit
            // on every dispatcher iteration. Admission still checks revocation.
            // TODO(channel-latency): replace this bounded infrastructure poll
            // with owned process/configuration notifications.
            if std::time::Instant::now() >= next_scope_host_check {
                if host.verify_original_main_lifetime().is_err() {
                    tracing::warn!(
                        code = "CHANNEL_HOST_OWNER_CHANGED",
                        "Original scope owner ended; closing its owned tree"
                    );
                    break;
                }
                next_scope_host_check = std::time::Instant::now() + Duration::from_secs(1);
            }
        }
        #[cfg(target_os = "linux")]
        state.native_interrupts.reap();
        while let Some(result) = state.mcp_app_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error,"MCP App owned request task exited unexpectedly");
            }
        }
        while let Some(result) = state.desktop_recovery_tasks.try_join_next() {
            if let Ok(Some(ready)) = result {
                state.desktop_recovery_ready.push_back(ready);
            }
        }
        while let Some(result) = state.knowledge_rpc_tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Wiki request task exited unexpectedly");
            }
        }
        while let Some(result) = state.continuous_work_read_tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("continuous work read task exited unexpectedly");
            }
        }
        while let Some(result) = state.continuous_work_mutation_tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("continuous work mutation task exited unexpectedly");
            }
        }
        while let Some(result) = state.wiki_rpc_tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Wiki RPC task exited unexpectedly");
            }
        }
        while let Some(result) = state.knowledge_tasks.try_join_next() {
            if result.is_err() {
                tracing::warn!("Wiki background task exited unexpectedly");
            }
        }
        while let Some(result) = provider_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "provider validation task failed");
            }
        }
        while let Some(result) = indexed_read_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "indexed transcript task failed");
            }
        }
        while let Some(result) = plugin_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "app-server plugin request task failed");
            }
        }
        while migration_control_tasks.try_join_next().is_some() {}
        while migration_observation_tasks.try_join_next().is_some() {}
        while deferred_rpc_admissions.try_join_next().is_some() {}
        let task_state_notifications = (state.initialized && state.integration_task_state_v1)
            || native_runtime.rpc_hub().needs_task_state();
        native_runtime.set_task_state_notifications(task_state_notifications);
        if (state.initialized || scope_host.is_some()) && state.desktop_recovery_ready.is_empty() {
            thread_manager.enforce_session_lifetimes().await;
            native_runtime
                .retire_ended_ui_tasks(&mut thread_manager, &mut engine, &workspace_engine)
                .await;
            if let Some(request) = native_runtime.next_rpc_request() {
                rpc_connection::dispatch(
                    request,
                    rpc_connection::HostContext {
                        deferred_admissions: Some((&mut deferred_rpc_admissions, native_runtime_client.clone())),
                        engine_factory: &engine_factory,
                        workspace_engine: &workspace_engine,
                        permission_mode,
                        thread_manager: &mut thread_manager,
                        next_interaction_id: &next_interaction_id,
                        server_id: &server_id,
                        sequence: &sequence,
                        owners: native_runtime.ui_task_owners(),
                        #[cfg(target_os = "linux")]
                        interruptions: &mut state.native_interrupts,
                    },
                )
                .boxed_local()
                .await;
                continue;
            }
            let generated = if let Some(ready) = &state.ready_thread_resume {
                debug_assert!(matches!(ready.input, thread_resume_preparation::Input::Native));
                let original = ready.id.as_str().and_then(|ticket| deferred_native_resumes.remove(ticket));
                if original.is_none() {
                    state.ready_thread_resume = None;
                }
                original
            } else {
                match native_runtime.next_request(&mut thread_manager) {
                    Ok(generated) => generated,
                    Err(_) => {
                        tracing::warn!(
                            code = "native_runtime_command_unconfirmed",
                            "Native command preparation requires reconciliation"
                        );
                        None
                    }
                }
            };
            if let Some(generated) = generated {
                // Only the actual in-process ticket branch marks a non-public origin.
                // Until its receipt is bound at Accepted, source selection fails closed.
                let previous_source_origin =
                    std::mem::replace(&mut state.native_source_dispatch, true);
                let previous_request_origin = std::mem::replace(
                    &mut state.request_origin,
                    request_origin::RequestOrigin::NativeSource,
                );
                // This same-image private ticket understands its fixed presentation
                // declaration. Public UI streams retain independent negotiation.
                let previous_work_modes = std::mem::replace(&mut state.studio_work_modes_v1, true);
                let previous_source_observer = std::mem::replace(
                    &mut state.native_source_accepted,
                    generated.accepted_observer.clone(),
                );
                let previous_thread_initializer = std::mem::replace(
                    &mut state.native_runtime_thread_initializer,
                    generated.thread_initializer.clone(),
                );
                let deferred_count = state.deferred_thread_resumes.len();
                if generated.method == method::THREAD_RESUME && state.ready_thread_resume.is_none() {
                    state.thread_resume_input = Some(thread_resume_preparation::Input::Native);
                }
                eprintln!(
                    "{}",
                    serde_json::json!({"event":"native_runtime_ticket_stage","stage":"dispatch_enter","method":generated.method})
                );
                let result = rpc_dispatch::dispatch(
                    generated.method,
                    Value::String(generated.ticket.id().into()),
                    generated.params.clone(),
                    &mut engine,
                    &workspace_engine,
                    &generated.outbound,
                    &mut thread_manager,
                    &terminals,
                    &mut history_refresh,
                    &mut browsers,
                    &plugin_tasks,
                    migration_control_tasks.len()
                        + migration_observation_tasks.len()
                        + migration_processor.activity(),
                    &mut provider_tasks,
                    &indexed_read_tasks,
                    &mut automations,
                    &mut automation_requested,
                    &mut idle_shutdown_requested,
                    &engine_factory,
                    &storage_scans,
                    &provider_settings_state,
                    &mut attachment_directories,
                    &next_terminal_id,
                    permission_mode,
                    &next_interaction_id,
                    &connection_receipts,
                    &server_id,
                    &sequence,
                    &None,
                    &mut state,
                    &mut thread_list_snapshots,
                    None,
                    retention_authority.as_deref(),
                )
                .boxed_local()
                .await;
                eprintln!(
                    "{}",
                    serde_json::json!({"event":"native_runtime_ticket_stage","stage":"dispatch_returned","method":generated.method,"isError":result.is_err()})
                );
                state.native_source_dispatch = previous_source_origin;
                state.request_origin = previous_request_origin;
                state.studio_work_modes_v1 = previous_work_modes;
                state.native_source_accepted = previous_source_observer;
                state.native_runtime_thread_initializer = previous_thread_initializer;
                state.thread_resume_input = None;
                state.ready_thread_resume = None;
                if result.is_err() {
                    native_runtime.dispatch_failed(&generated.ticket);
                } else if state.deferred_thread_resumes.len() > deferred_count {
                    // Keep the in-process ticket and its private response channel off the wire.
                    deferred_native_resumes.insert(generated.ticket.id().to_owned(), generated);
                }
                // Only this in-process branch has the private response sender and
                // ticket. Public JSON IDs cannot settle a native command.
                continue;
            }
        }
        let queued = if state.desktop_recovery_ready.is_empty() {
            automations.next_request()
        } else {
            None
        };
        let automation_fire = queued.as_ref().and_then(|(_, fire)| fire.clone());
        let request_origin = request_origin::RequestOrigin::selected_by_owner(
            !state.desktop_recovery_ready.is_empty(),
            queued.is_some(),
        );
        let next_line = if let Some(ready) = state.desktop_recovery_ready.pop_front() {
            let request = json!({"jsonrpc":"2.0", "id":ready.id, "method":method::COMPUTER_USE_RECOVER, "params":ready.params});
            state.private_desktop_recovery = Some(ready);
            Some(JsonRpcLine::Line(request.to_string()))
        } else if let Some((request, _)) = queued {
            automation_responses.register(&request);
            Some(JsonRpcLine::Line(request.to_string()))
        } else {
            #[cfg(unix)]
            let result = tokio::select! {
                result = input.read() => result?,
                ready = state.deferred_user_turns.next(), if !state.deferred_user_turns.is_empty() => {
                    let Some(ready) = ready else { continue };
                    let line = ready.line.clone(); state.ready_user_turn = Some(ready);
                    Some(JsonRpcLine::Line(line))
                },
                ready = state.deferred_thread_resumes.next(), if !state.deferred_thread_resumes.is_empty() => {
                    let Some(ready) = ready else { continue };
                    let line = match &ready.input {
                        thread_resume_preparation::Input::Client(line) => Some(line.clone()),
                        thread_resume_preparation::Input::Native => None,
                    };
                    state.ready_thread_resume = Some(ready);
                    let Some(line) = line else { continue };
                    Some(JsonRpcLine::Line(line))
                },
                Some(request) = discovery_requests.recv() => {
                    discovery_jobs.start(request, &thread_manager, &mut discovery_pages);
                    continue;
                },
                Some(request)=peer_requests.recv()=>{
                    session_messages::host::dispatch(request,&thread_manager,peer_service.as_ref(),peer_backchannel.as_ref(),&mut deferred_rpc_admissions,&peer_admission_cancel);
                    continue;
                },
                Some(completed) = discovery_jobs.next(), if !discovery_jobs.is_empty() => {
                    session_discovery::publish(completed, &thread_manager);
                    continue;
                },
                event = native_runtime.receive() => {
                    native_runtime.observe_with_task_owners(event, &outbound_tx, &mut thread_manager).await?;
                    continue;
                },
                ready = state.desktop_recovery_tasks.join_next(), if !state.desktop_recovery_tasks.is_empty() => {
                    if let Some(Ok(Some(ready))) = ready { state.desktop_recovery_ready.push_back(ready); }
                    continue;
                },
                _ = terminate_signal.recv() => {
                    terminated_by_signal = true;
                    None
                },
                _ = automations.receive() => continue,
                _=peer_idle_tick.tick(),if state.initialized&&peer_service.is_some()=>{
                    if let Some(cold) = peer_cold_driver.as_mut() { cold.tick(&mut thread_manager).await; }
                    peer_idle_driver.tick(&thread_manager,peer_service.as_ref());
                    continue;
                },
                _ = automation_tick.tick() => {
                    if state.initialized {
                        business_automation.queue_tick(&workspace_engine, &mut state);
                    }
                if state.initialized && automation_requested {
                        automations.activate();
                        automations.queue_if_idle(thread_manager.project_is_idle());
                        if let Some(params) = automations.take_state_change() {
                            send(&outbound_tx, notification(kcoder_app_protocol::method::AUTOMATION_STATE_CHANGED, params)).await?;
                        }
                    }
                    continue;
                },
            };
            #[cfg(not(unix))]
            let result = tokio::select! {
                result = input.read() => result?,
                ready = state.deferred_user_turns.next(), if !state.deferred_user_turns.is_empty() => {
                    let Some(ready) = ready else { continue };
                    let line = ready.line.clone(); state.ready_user_turn = Some(ready);
                    Some(JsonRpcLine::Line(line))
                },
                ready = state.deferred_thread_resumes.next(), if !state.deferred_thread_resumes.is_empty() => {
                    let Some(ready) = ready else { continue };
                    let line = match &ready.input {
                        thread_resume_preparation::Input::Client(line) => Some(line.clone()),
                        thread_resume_preparation::Input::Native => None,
                    };
                    state.ready_thread_resume = Some(ready);
                    let Some(line) = line else { continue };
                    Some(JsonRpcLine::Line(line))
                },
                Some(request) = discovery_requests.recv() => {
                    discovery_jobs.start(request, &thread_manager, &mut discovery_pages);
                    continue;
                },
                Some(request)=peer_requests.recv()=>{
                    session_messages::host::dispatch(request,&thread_manager,peer_service.as_ref(),peer_backchannel.as_ref(),&mut deferred_rpc_admissions,&peer_admission_cancel);
                    continue;
                },
                Some(completed) = discovery_jobs.next(), if !discovery_jobs.is_empty() => {
                    session_discovery::publish(completed, &thread_manager);
                    continue;
                },
                event = native_runtime.receive() => {
                    native_runtime.observe_with_task_owners(event, &outbound_tx, &mut thread_manager).await?;
                    continue;
                },
                ready = state.desktop_recovery_tasks.join_next(), if !state.desktop_recovery_tasks.is_empty() => {
                    if let Some(Ok(Some(ready))) = ready { state.desktop_recovery_ready.push_back(ready); }
                    continue;
                },
                _ = automations.receive() => continue,
                _=peer_idle_tick.tick(),if state.initialized&&peer_service.is_some()=>{
                    if let Some(cold) = peer_cold_driver.as_mut() { cold.tick(&mut thread_manager).await; }
                    peer_idle_driver.tick(&thread_manager,peer_service.as_ref());
                    continue;
                },
                _ = automation_tick.tick() => {
                    if state.initialized {
                        business_automation.queue_tick(&workspace_engine, &mut state);
                    }
                if state.initialized && automation_requested {
                        automations.activate();
                        automations.queue_if_idle(thread_manager.project_is_idle());
                        if let Some(params) = automations.take_state_change() {
                            send(&outbound_tx, notification(kcoder_app_protocol::method::AUTOMATION_STATE_CHANGED, params)).await?;
                        }
                    }
                    continue;
                },
            };
            result
        };
        let Some(next_line) = next_line else { break };
        let line = match next_line {
            JsonRpcLine::Line(line) => line,
            JsonRpcLine::InvalidUtf8 => {
                send(
                    &outbound_tx,
                    error_response(Value::Null, -32700, "Request is not valid UTF-8"),
                )
                .await?;
                continue;
            }
            JsonRpcLine::TooLarge => {
                send(
                    &outbound_tx,
                    error_response(Value::Null, -32600, "Request is too large"),
                )
                .await?;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let control = connection_requests::dispatch(
            connection_requests::RequestContext {
                engine: &mut engine,
                engine_factory: &engine_factory,
                workspace_engine: &workspace_engine,
                permission_mode,
                outbound_tx: &outbound_tx,
                thread_manager: &mut thread_manager,
                terminals: &terminals,
                history_refresh: &mut history_refresh,
                browsers: &mut browsers,
                plugin_tasks: &mut plugin_tasks,
                migration_control_tasks: &mut migration_control_tasks,
                migration_observation_tasks: &mut migration_observation_tasks,
                provider_tasks: &mut provider_tasks,
                indexed_read_tasks: &mut indexed_read_tasks,
                automations: &mut automations,
                automation_requested: &mut automation_requested,
                idle_shutdown_requested: &mut idle_shutdown_requested,
                storage_scans: &storage_scans,
                provider_settings_state: &provider_settings_state,
                attachment_directories: &mut attachment_directories,
                next_terminal_id: &next_terminal_id,
                next_interaction_id: &next_interaction_id,
                connection_receipts: &connection_receipts,
                server_id: &server_id,
                sequence: &sequence,
                automation_fire: &automation_fire,
                state: &mut state,
                thread_list_snapshots: &mut thread_list_snapshots,
                retention_authority: &retention_authority,
                migration_source_authority: &migration_source_authority,
                peer_service:&peer_service,
                peer_backchannel:&peer_backchannel,
                peer_router_rpc:&peer_router_rpc,
                allow_private_peer:true,
                migration_processor: &migration_processor,
                plugin_processor: &plugin_processor,
                mcp_authorization: &mcp_authorization,
                indexed_read_gates: &mut indexed_read_gates,
                thread_presence_gate: &thread_presence_gate,
                thread_presence_cancellation: &thread_presence_cancellation,
                thread_goal_status_gate: &thread_goal_status_gate,
                thread_goal_status_cancellation: &thread_goal_status_cancellation,
                request_origin,
                automation_responses: &automation_responses,
            },
            &line,
        )
        .await?;
        if matches!(control, DispatchControl::Shutdown) {
            break;
        }
    }
    Ok(())
    }.await;

    #[cfg(target_os = "linux")]
    state.native_acp_receiver_closed.close();
    #[cfg(target_os = "linux")]
    state.native_interrupts.drain().await;
    thread_presence_cancellation.cancel();
    thread_goal_status_cancellation.cancel();
    state.deferred_user_turns.shutdown().await;
    state.ready_user_turn = None;
    state.deferred_thread_resumes.shutdown().await;
    state.ready_thread_resume = None;
    deferred_native_resumes.clear();
    peer_admission_cancel.cancel();
    deferred_rpc_admissions.abort_all();
    while deferred_rpc_admissions.join_next().await.is_some() {}
    if let Some(cold) = peer_cold_driver.as_mut() {
        cold.shutdown(&mut thread_manager).await;
    }
    peer_idle_driver.shutdown().await;
    native_runtime.close().await;
    discovery_requests.close();
    peer_requests.close();
    if let Some(bridge) = &peer_backchannel {
        bridge.close();
    }
    if let Some(service) = &peer_service {
        service.close();
    }
    discovery_jobs.finish().await;
    state.workspace_lookup.shutdown().await;
    indexed_read_tasks.abort_all();
    while indexed_read_tasks.join_next().await.is_some() {}
    drop(automations);
    if let Err(error) = mcp_apps_rpc::revoke_thread(&mut state, None).await {
        tracing::warn!(%error,"MCP Apps revocation did not settle before disconnect");
    }
    state.mcp_app_tasks.abort_all();
    while state.mcp_app_tasks.join_next().await.is_some() {}
    state.agent_streams.shutdown().await;
    plugin_processor.cancel();
    drop(storage_scans);
    for turn_state in thread_manager.turn_states() {
        turn_state
            .desktop_grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .revoke();
    }
    state.desktop_recovery_tasks.abort_all();
    while state.desktop_recovery_tasks.join_next().await.is_some() {}
    state.desktop_recovery_ready.clear();
    state.private_desktop_recovery = None;
    state.knowledge_rpc_tasks.abort_all();
    while state.knowledge_rpc_tasks.join_next().await.is_some() {}
    close_owned_tasks(&mut state.continuous_work_read_tasks).await;
    close_owned_tasks(&mut state.continuous_work_mutation_tasks).await;
    state.wiki_rpc_tasks.abort_all();
    while state.wiki_rpc_tasks.join_next().await.is_some() {}
    if let Err(error) = state.integration_connectivity.close().await {
        tracing::warn!(code = "CHANNEL_OWNER_CLOSE_UNCONFIRMED", %error,
            "Owned channel host cleanup requires reconciliation");
    }
    state.knowledge_tasks.abort_all();
    while state.knowledge_tasks.join_next().await.is_some() {}
    provider_tasks.abort_all();
    while provider_tasks.join_next().await.is_some() {}
    migration_processor.cancellation().cancel();
    if let Some(authority) = &migration_source_authority {
        authority.close();
    }
    if tokio::time::timeout(Duration::from_secs(10), async {
        while migration_control_tasks.join_next().await.is_some() {}
        while migration_observation_tasks.join_next().await.is_some() {}
        while let Some(result) = plugin_tasks.join_next().await {
            if let Err(error) = result {
                tracing::warn!(%error, "app-server plugin request task failed during shutdown");
            }
        }
    })
    .await
    .is_err()
    {
        plugin_tasks.abort_all();
        migration_control_tasks.abort_all();
        migration_observation_tasks.abort_all();
        while migration_control_tasks.join_next().await.is_some() {}
        while migration_observation_tasks.join_next().await.is_some() {}
        while plugin_tasks.join_next().await.is_some() {}
    }
    migration_processor.shutdown().await;
    // The `evolution/changed` forwarder holds an outbound sender clone in the
    // manager and the engines; release it so the writer sees the closed channel.
    thread_manager.clear_evolution_change_sink();
    workspace_engine.set_evolution_change_sink(None);
    engine.set_evolution_change_sink(None);
    let diagnostic_deadline =
        std::time::Instant::now() + thread_runtime::DIAGNOSTIC_SHUTDOWN_TIMEOUT;
    for runtime in thread_manager.drain() {
        runtime
            .shutdown_with_diagnostic_deadline(diagnostic_deadline)
            .await;
    }
    workspace_engine.prepare_session_replacement();
    workspace_engine
        .flush_workspace_diagnostics_until(diagnostic_deadline)
        .await;
    terminals.shutdown_all();
    drop(_terminal_guard);
    drop(terminals);
    browsers.shutdown_all().await;
    drop(browsers);
    drop(attachment_directories);
    // Release every connection-owned outbound sender before waiting for the
    // writer; a surviving clone keeps it from seeing the closed channel, so
    // shutdown would always run into the writer timeout.
    drop(peer_idle_driver);
    drop(peer_cold_driver);
    drop(state.native_remote_host_client.take());
    drop(outbound_tx);
    // Explicitly release host aliases before process::exit skips stack destructors.
    // The selected engine may still own an ephemeral session after its runtime is drained.
    drop(engine);
    drop(engine_factory);
    drop(workspace_engine);
    let mcp_cleanup = session_mcp::await_cleanup(&mut state.temporary_mcp_cleanup).await;
    #[cfg(unix)]
    if terminated_by_signal {
        // Tokio's process-global stdin reader uses a blocking read which cannot be cancelled.
        // Returning from this async function after SIGTERM can therefore leave runtime shutdown
        // waiting forever. Cleanup is explicitly awaited above; an unconfirmed MCP cleanup
        // exits with failure rather than claiming that all owned resources were released.
        writer.abort();
        std::process::exit(if mcp_cleanup.is_ok() { 0 } else { 1 });
    }
    mcp_cleanup?;
    let writer_result = match tokio::time::timeout(Duration::from_secs(2), &mut writer).await {
        Ok(result) => result
            .context("app-server stdout task failed")
            .and_then(|result| result),
        Err(_) => {
            writer.abort();
            let _ = writer.await;
            if idle_shutdown_requested {
                Err(anyhow::anyhow!("idle shutdown stdout flush timed out"))
            } else {
                Ok(())
            }
        }
    };
    if idle_shutdown_requested {
        // The stdin blocking reader can still be waiting; owned resources were released above.
        std::process::exit(if writer_result.is_ok() && connection_result.is_ok() {
            0
        } else {
            1
        });
    }
    connection_result?;
    writer_result
}

/// Abort and await one connection-owned task set so no owned work outlives its
/// owner. A blocking task already running still finishes its own store write.
async fn close_owned_tasks(tasks: &mut tokio::task::JoinSet<()>) {
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

#[cfg(test)]
#[path = "connection_lifecycle.test.rs"]
mod tests;
