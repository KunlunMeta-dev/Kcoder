//! Connection lifecycle: extracted from the app-server connection boundary.

use super::*;

pub(crate) async fn run_with_retention_parent(
    mut engine: QueryEngine,
    engine_factory: AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
    retention_launch: Option<RetentionLaunchConfiguration>,
) -> Result<()> {
    let retention_authority = match retention_launch {
        None => None,
        Some(launch) => {
            crate::retention_parent_environment::validate_identity(&launch.parent)?;
            let optional = launch.optional;
            match retention_context::VerifiedRetentionAuthority::capture(launch, &engine) {
                Ok(authority) => Some(authority),
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
    let workspace_engine = engine.clone();
    let provider_settings_state =
        provider_settings::capture_state(&workspace_engine).map(|state| {
            state
                .with_session_reload(engine_factory.supports_session_reload())
                .with_turn_model_reload(engine_factory.supports_turn_model_reload())
        });
    let _attachment_cleanup = attachments::AttachmentCleanupSweep::spawn();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let next_question_id = Arc::new(AtomicU64::new(1_000_000));
    let next_approval_id = Arc::new(AtomicU64::new(2_000_000));
    // Replies to an already resolved interaction are answered from here, so a
    // repeated reply is never delivered twice and never applied to a new turn.
    let connection_receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
    let automation_responses =
        project_automations::AutomationResponses::new(engine.cron_scheduler());
    let writer_automations = automation_responses.clone();
    let mut writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outbound_rx.recv().await {
            writer_automations.observe(&message);
            let Some(mut bytes) = bounded_outbound_frame(message, OUTBOUND_FRAME_LIMIT_BYTES)
            else {
                continue;
            };
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let resident_thread_limit = std::env::var("KCODER_APP_SERVER_RESIDENT_THREAD_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1024).contains(value))
        .unwrap_or(thread_runtime::DEFAULT_RESIDENT_THREAD_LIMIT);
    let mut thread_manager = ThreadManager::with_resident_limit(resident_thread_limit);
    let next_terminal_id = AtomicU64::new(1);
    let terminals = TerminalRegistry::default();
    let _terminal_guard = TerminalRegistryGuard(terminals.clone());
    let server_id = format!("server-{}", engine.session_id());
    let sequence = Arc::new(AtomicU64::new(1));
    let mut state = ConnectionState {
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
        if let Err(error) = knowledge_archive_owner::scavenge(&parent) {
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
    let mut plugin_tasks = tokio::task::JoinSet::new();
    let mut provider_tasks = tokio::task::JoinSet::new();
    let storage_scans = storage_scans::StorageScans::default();
    let mut indexed_read_tasks = tokio::task::JoinSet::new();
    let mut indexed_read_gates = indexed_read_gate::IndexedReadGate::default();
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut input_state = protocol_io::JsonRpcLineState::default();
    let mut automations = project_automations::ProjectAutomations::new(
        workspace_engine.cron_scheduler(),
        !workspace_engine.settings.read().unwrap().training_mode,
        workspace_engine.state.cwd().to_string_lossy().into_owned(),
    );
    let mut automation_tick = tokio::time::interval(Duration::from_millis(500));
    let mut automation_requested = false;
    let mut idle_shutdown_requested = false;
    #[cfg(unix)]
    let mut terminate_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .context("failed to install app-server SIGTERM handler")?;
    #[cfg(unix)]
    let mut terminated_by_signal = false;

    loop {
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
        let queued = if state.desktop_recovery_ready.is_empty() {
            automations.next_request()
        } else {
            None
        };
        let automation_fire = queued.as_ref().and_then(|(_, fire)| fire.clone());
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
                result = input_state.read(&mut stdin) => result.context("failed to read app-server stdin")?,
                ready = state.desktop_recovery_tasks.join_next(), if !state.desktop_recovery_tasks.is_empty() => {
                    if let Some(Ok(Some(ready))) = ready { state.desktop_recovery_ready.push_back(ready); }
                    continue;
                },
                _ = terminate_signal.recv() => {
                    terminated_by_signal = true;
                    None
                },
                _ = automations.receive() => continue,
                _ = automation_tick.tick() => {
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
                result = input_state.read(&mut stdin) => result.context("failed to read app-server stdin")?,
                ready = state.desktop_recovery_tasks.join_next(), if !state.desktop_recovery_tasks.is_empty() => {
                    if let Some(Ok(Some(ready))) = ready { state.desktop_recovery_ready.push_back(ready); }
                    continue;
                },
                _ = automations.receive() => continue,
                _ = automation_tick.tick() => {
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
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(
                    frame_bytes = line.len(),
                    object_offset = line.find('{'),
                    %error,
                    "invalid app-server JSON-RPC frame"
                );
                send(
                    &outbound_tx,
                    error_response(
                        Value::Null,
                        -32700,
                        &format!(
                            "{error} (frame bytes: {}, object offset: {:?})",
                            line.len(),
                            line.find('{')
                        ),
                    ),
                )
                .await?;
                continue;
            }
        };
        let has_id = request
            .as_object()
            .is_some_and(|object| object.contains_key("id"));
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if kcoder_app_protocol::is_workspace_operation_v2(method) {
            if let Some(response) = state.require_initialized(id.clone()) {
                send(&outbound_tx, response).await?;
                continue;
            }
            let response = match &retention_authority {
                None => error_response(id, -32001, "Workspace receipt authority unavailable"),
                Some(authority) => {
                    match kcoder_app_protocol::decode_private_retention_request(&line) {
                        Err(_) => error_response(id, -32602, "Invalid private workspace request"),
                        Ok(private) => match authority.validate(&private) {
                            Err(code) => error_response(
                                id,
                                code,
                                "Workspace receipt authority or parameters rejected",
                            ),
                            Ok(()) => match workspace_operation_receipts_v2::dispatch(
                                authority,
                                &workspace_engine,
                                &private,
                            )
                            .await
                            {
                                Ok(result) => success_response(id, result),
                                Err(error) => error_response(
                                    id,
                                    workspace_operation_receipts_v2::error_code(&error),
                                    "Workspace receipt scope conflict or completion unknown",
                                ),
                            },
                        },
                    }
                }
            };
            send(&outbound_tx, response).await?;
            continue;
        }
        if kcoder_app_protocol::is_attachment_retention_method(method) {
            if let Some(response) = state.require_initialized(id.clone()) {
                send(&outbound_tx, response).await?;
                continue;
            }
            // Decode the original frame, not its duplicate-key-erasing Value.
            // Missing/null IDs and request-shaped notifications cannot execute.
            let response = match kcoder_app_protocol::decode_private_retention_request(&line) {
                Err(_) => error_response(
                    id,
                    -32602,
                    attachment_retention_dispatch::error_message(-32602),
                ),
                Ok(private) => match &retention_authority {
                    None => error_response(
                        id,
                        kcoder_app_protocol::RETENTION_ERROR_AUTHORITY,
                        attachment_retention_dispatch::error_message(
                            kcoder_app_protocol::RETENTION_ERROR_AUTHORITY,
                        ),
                    ),
                    Some(authority) => match authority.validate(&private) {
                        Err(code) => error_response(
                            id,
                            code,
                            attachment_retention_dispatch::error_message(code),
                        ),
                        Ok(()) => match if kcoder_app_protocol::is_retention_upload_method(
                            &private.method,
                        ) {
                            attachment_retention_dispatch::dispatch_upload(authority, &private)
                                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                        } else {
                            attachment_retention_dispatch::dispatch_scoped(authority, &private)
                                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                        } {
                            Ok(result) => success_response(id, json!(result)),
                            Err(error) => {
                                let code = attachment_retention_dispatch::error_code(&error);
                                error_response(
                                    id,
                                    code,
                                    attachment_retention_dispatch::error_message(code),
                                )
                            }
                        },
                    },
                },
            };
            // Synchronous service transactions and owner leases have all dropped
            // before the outbound await. No provider/session activation occurs.
            send(&outbound_tx, response).await?;
            continue;
        }
        if retention_context::has_private_authority(&request) {
            let code = match &retention_authority {
                None => -32001,
                Some(authority) => {
                    match kcoder_app_protocol::decode_private_retention_request(&line) {
                        Err(_) => -32602,
                        Ok(private) => match authority.validate(&private) {
                            Err(code) => code,
                            // Validated but intentionally not wired to the service yet.
                            Ok(()) => -32601,
                        },
                    }
                }
            };
            send(
                &outbound_tx,
                error_response(
                    id,
                    code,
                    match code {
                        -32001 => "Private retention authority unavailable",
                        -32601 => "Retention lifecycle unavailable",
                        _ => "Invalid private retention request",
                    },
                ),
            )
            .await?;
            continue;
        }
        // Wiki operations are requests, never executable client notifications.
        if (method.starts_with("knowledge/")
            || matches!(
                method,
                method::WORKFLOW_REQUESTS
                    | method::WORKFLOW_RESPOND
                    | method::COMPUTER_USE_RECOVER
                    | method::COMPUTER_USE_REVOKE
            ))
            && !request
                .as_object()
                .is_some_and(|object| object.contains_key("id"))
        {
            continue;
        }

        if method.is_empty() && !id.is_null() {
            let mut outcome = InteractionReply::Unmatched;
            for turn_state in thread_manager.turn_states() {
                outcome = turn_state.resolve_response(&request, state.interaction_binding_v1);
                if !matches!(outcome, InteractionReply::Unmatched) {
                    break;
                }
            }
            if matches!(outcome, InteractionReply::Misattributed)
                && let Some(request_id) = id.as_u64()
            {
                // The interaction is still pending: replay its request so the
                // client can answer with the identity the connection requires,
                // and never accept the unattributable decision.
                let request_notification = {
                    let mut receipts = connection_receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let request = receipts.outstanding_request(request_id);
                    receipts.note_misattributed();
                    request
                };
                tracing::warn!(
                    request_id,
                    "app-server interaction reply did not name its interaction and was rejected"
                );
                if let Some(notification) = request_notification {
                    send(&outbound_tx, notification).await?;
                }
                continue;
            }
            if matches!(outcome, InteractionReply::Unmatched)
                && let Some(request_id) = id.as_u64()
            {
                let replayed = {
                    let mut receipts = connection_receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    receipts.replay(request_id)
                };
                match replayed {
                    Some(notification) => send(&outbound_tx, notification).await?,
                    None => {
                        connection_receipts
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .note_unmatched();
                        tracing::warn!(
                            request_id,
                            "app-server reply matched no pending interaction and was not applied"
                        );
                    }
                }
            }
            continue;
        }

        // Responses and interaction replies were handled above. From here on,
        // only protocol-typed request IDs may reach a method dispatcher. The
        // sole id-less inbound notification is `initialized`; it is a no-op
        // even before the initialize handshake completes.
        if method.is_empty() {
            continue;
        }
        if method == "initialized" && !has_id {
            continue;
        }
        if !has_id {
            continue;
        }
        if serde_json::from_value::<kcoder_app_protocol::RequestId>(id.clone()).is_err() {
            send(
                &outbound_tx,
                error_response(Value::Null, -32600, "Invalid request ID"),
            )
            .await?;
            continue;
        }
        if method == "initialized" {
            send(
                &outbound_tx,
                error_response(id, -32600, "initialized must be sent as a notification"),
            )
            .await?;
            continue;
        }

        if method == "initialize" {
            let mut response = state.initialize_with_workspace_authority(
                id,
                &params,
                &workspace_engine,
                retention_authority.is_some(),
            );
            if response.get("error").is_none() {
                if let Some(authority) = &retention_authority {
                    if let Ok(admission) = authority.retention_service().upload_admission() {
                        state.attach_upload_admission(&mut response, admission)?;
                    }
                }
            }
            if state.initialized
                && params["capabilities"]["experimental"]["projectAutomations"] == true
            {
                automation_requested = true;
            }
            send(&outbound_tx, response).await?;
            continue;
        }
        if let Some(response) = state.require_initialized(id.clone()) {
            send(&outbound_tx, response).await?;
            continue;
        }
        if method == method::THREAD_READ_INDEXED {
            if indexed_read_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32044,
                        "Indexed history read capacity reached; retry later",
                    ),
                )
                .await?;
                continue;
            }
            let params = match serde_json::from_value::<ThreadReadParams>(params) {
                Ok(params) => params,
                Err(_) => {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "invalid indexed transcript params"),
                    )
                    .await?;
                    continue;
                }
            };
            let target = thread_manager
                .engine(&params.thread_id)
                .unwrap_or_else(|| workspace_engine.clone());
            let read_gate = match indexed_read_gates.for_thread(&params.thread_id) {
                Ok(gate) => gate,
                Err(_) => {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "invalid transcript thread"),
                    )
                    .await?;
                    continue;
                }
            };
            let running = thread_manager.running_thread_ids();
            let run_projection = ThreadRunProjection::for_thread(
                &thread_manager,
                state.run_summary_v1,
                &params.thread_id,
            );
            let outbound = outbound_tx.clone();
            indexed_read_tasks.spawn(async move {
                let read_guard = read_gate.lock_owned().await;
                let read = indexed_transcript::read(&target, params, &running, run_projection);
                let response = match read.await {
                    Ok(mut result) => {
                        recent_error::decorate(
                            &target,
                            &mut result.thread,
                            run_projection.negotiated,
                        );
                        success_response(
                            id,
                            serde_json::to_value(result).expect("transcript serializes"),
                        )
                    }
                    Err(error) => {
                        let message = error.to_string();
                        error_response(
                            id,
                            if message == "TRANSCRIPT_CURSOR_STALE" {
                                -32041
                            } else {
                                -32021
                            },
                            &message,
                        )
                    }
                };
                drop(read_guard);
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send indexed transcript");
                }
            });
            continue;
        }
        if method == method::SKILL_LIST {
            let result = serde_json::from_value::<kcoder_app_protocol::SkillListParams>(params)
                .map_err(|_| anyhow::anyhow!("Invalid skill list parameters"))
                .and_then(|params| {
                    engine_factory
                        .current_skills()
                        .map(|registry| skill_processor::list(&registry, params.include_disabled))
                })
                .and_then(|result| serde_json::to_value(result).map_err(Into::into));
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32021, &error.to_string()),
            };
            send(&outbound_tx, response).await?;
            continue;
        }
        if matches!(
            method,
            method::SKILL_IMPORT | method::SKILL_REMOVE | method::SKILL_SET_ENABLED
        ) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32044,
                        "Extension management capacity reached; retry later",
                    ),
                )
                .await?;
                continue;
            }
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            let registry =
                (operation == method::SKILL_SET_ENABLED).then(|| engine_factory.current_skills());
            plugin_tasks.spawn(async move {
                let result: Result<Value> = if operation == method::SKILL_IMPORT {
                    match serde_json::from_value::<kcoder_app_protocol::SkillImportParams>(params) {
                        Ok(params) => skill_processor::import(params)
                            .await
                            .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
                        Err(_) => Err(anyhow::anyhow!("Invalid skill import parameters")),
                    }
                } else if operation == method::SKILL_SET_ENABLED {
                    match (
                        serde_json::from_value::<kcoder_app_protocol::SkillSetEnabledParams>(
                            params,
                        ),
                        registry,
                    ) {
                        (Ok(params), Some(Ok(registry))) => {
                            skill_processor::set_enabled(params, registry)
                                .await
                                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                        }
                        (_, Some(Err(error))) => Err(error),
                        _ => Err(anyhow::anyhow!("Invalid skill activation parameters")),
                    }
                } else {
                    match serde_json::from_value::<kcoder_app_protocol::SkillRemoveParams>(params) {
                        Ok(params) => skill_processor::remove(params)
                            .await
                            .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
                        Err(_) => Err(anyhow::anyhow!("Invalid skill removal parameters")),
                    }
                };
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32021, &error.to_string()),
                };
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send skill management response");
                }
            });
            continue;
        }
        if matches!(
            method,
            method::HOOK_CONFIGURATION_READ | method::HOOK_CONFIGURATION_UPDATE
        ) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(id, -32044, "Hook management capacity reached; retry later"),
                )
                .await?;
                continue;
            }
            let factory = engine_factory.clone();
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            plugin_tasks.spawn(async move {
                let response = hook_configuration::process(factory, id, operation, params).await;
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send Hook configuration response");
                }
            });
            continue;
        }
        if matches!(
            method,
            method::MCP_LIST
                | method::MCP_INSTALL
                | method::MCP_REMOVE
                | method::MCP_LOGOUT
                | method::MCP_LOGIN
                | method::MCP_CALLBACK
                | method::MCP_CANCEL
        ) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(id, -32044, "MCP management capacity reached; retry later"),
                )
                .await?;
                continue;
            }
            let factory = engine_factory.clone();
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            let authorization = mcp_authorization.clone();
            plugin_tasks.spawn(async move {
                let result = if operation == method::MCP_LIST {
                    mcp_processor::list(factory)
                        .await
                        .and_then(|result| Ok(serde_json::to_value(result)?))
                } else if operation == method::MCP_INSTALL {
                    match serde_json::from_value::<kcoder_app_protocol::McpInstallParams>(params) {
                        Ok(params) => mcp_processor::install(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP installation parameters")),
                    }
                } else if operation == method::MCP_REMOVE {
                    match serde_json::from_value::<kcoder_app_protocol::McpServerParams>(params) {
                        Ok(params) => mcp_processor::remove(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP removal parameters")),
                    }
                } else if operation == method::MCP_LOGIN {
                    match serde_json::from_value::<kcoder_app_protocol::McpLoginParams>(params) {
                        Ok(params) => authorization
                            .login(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP login parameters")),
                    }
                } else if operation == method::MCP_CALLBACK {
                    match serde_json::from_value::<kcoder_app_protocol::McpCallbackParams>(params) {
                        Ok(params) => authorization
                            .callback(factory, params)
                            .await
                            .map(|()| json!({"authorized":true})),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP callback parameters")),
                    }
                } else if operation == method::MCP_CANCEL {
                    match serde_json::from_value::<kcoder_app_protocol::McpCancelParams>(params) {
                        Ok(params) => authorization
                            .cancel(params)
                            .await
                            .map(|()| json!({"cancelled":true})),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP cancellation parameters")),
                    }
                } else {
                    match serde_json::from_value::<kcoder_app_protocol::McpServerParams>(params) {
                        Ok(params) => mcp_processor::logout(factory, params)
                            .await
                            .and_then(|result| Ok(serde_json::to_value(result)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP server selection")),
                    }
                };
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32021, &error.to_string()),
                };
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send MCP management response");
                }
            });
            continue;
        }
        if PluginProcessor::handles(method) {
            let desktop_revocation =
                matches!(method, method::PLUGIN_DISABLE | method::PLUGIN_UNINSTALL)
                    && params.get("pluginId").and_then(Value::as_str)
                        == Some(kcoder_plugins::COMPUTER_USE_PLUGIN_ID);
            let desktop_grants = if desktop_revocation {
                thread_manager
                    .turn_states()
                    .into_iter()
                    .map(|state| state.desktop_grant)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let observation = if method == method::PLUGIN_ACTIVATION_READ {
                let result = (|| -> Result<_> {
                    let input: kcoder_app_protocol::PluginActivationParams =
                        serde_json::from_value(params.clone())?;
                    if let Some(thread_id) = input.thread_id {
                        let target = thread_manager
                            .engine(&thread_id)
                            .context("Plugin conversation is not resident")?;
                        ensure_active_thread(
                            &target,
                            thread_manager.lease(&thread_id),
                            &thread_id,
                        )?;
                        Ok(Some(plugin_processor::RuntimeObservation::capture(
                            &target,
                            &input.plugin_id,
                            &engine_factory,
                        )))
                    } else {
                        Ok(None)
                    }
                })();
                match result {
                    Ok(value) => value,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                }
            } else {
                None
            };
            let processor = plugin_processor.clone();
            let outbound_tx = outbound_tx.clone();
            let method = method.to_string();
            plugin_tasks.spawn(async move {
                let response = processor
                    .process_observed(id, &method, params, observation)
                    .await;
                if response.get("error").is_none() {
                    for grant in desktop_grants {
                        grant
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .revoke();
                    }
                }
                if let Err(error) = send(&outbound_tx, response).await {
                    tracing::warn!(%error, "failed to send app-server plugin response");
                }
            });
            continue;
        }

        if matches!(
            method,
            kcoder_app_protocol::method::PROVIDERS_UPSERT
                | kcoder_app_protocol::method::PROVIDERS_PROBE
        ) {
            if provider_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32034,
                        "[provider_probe_busy] Too many API validations; retry shortly",
                    ),
                )
                .await?;
                continue;
            }
            let Ok(snapshot) = provider_settings_state.as_ref() else {
                send(
                    &outbound_tx,
                    error_response(id, -32602, "Provider configuration snapshot is unavailable"),
                )
                .await?;
                continue;
            };
            let snapshot = snapshot.clone();
            let target = match runtime_requests::selected_provider_engine(
                &workspace_engine,
                &thread_manager,
                &params,
            ) {
                Ok(target) => target,
                Err(error) => {
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
            };
            let independent_probe = method == kcoder_app_protocol::method::PROVIDERS_PROBE;
            let outbound = outbound_tx.clone();
            provider_tasks.spawn(async move {
                let result = if independent_probe {
                    provider_settings::probe(target, params).await
                } else {
                    provider_settings::upsert(target, snapshot, params).await
                };
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32602, &error.to_string()),
                };
                let _ = send(&outbound, response).await;
            });
            continue;
        }

        let dispatched_request_id = id.clone();
        let dispatch_result = rpc_dispatch::dispatch(
            method,
            id,
            params,
            &mut engine,
            &workspace_engine,
            &outbound_tx,
            &mut thread_manager,
            &terminals,
            &mut history_refresh,
            &mut browsers,
            &plugin_tasks,
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
            &next_question_id,
            &next_approval_id,
            &connection_receipts,
            &server_id,
            &sequence,
            &automation_fire,
            &mut state,
            &mut thread_list_snapshots,
        )
        .await;
        if let Err(error) = &dispatch_result {
            automation_responses.dispatch_failed(&dispatched_request_id, &error.to_string());
        }
        if matches!(dispatch_result?, DispatchControl::Shutdown) {
            break;
        }
    }

    drop(automations);
    state.agent_streams.shutdown().await;
    plugin_processor.cancel();
    indexed_read_tasks.abort_all();
    while indexed_read_tasks.join_next().await.is_some() {}
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
    state.knowledge_tasks.abort_all();
    while state.knowledge_tasks.join_next().await.is_some() {}
    provider_tasks.abort_all();
    while provider_tasks.join_next().await.is_some() {}
    if tokio::time::timeout(Duration::from_secs(10), async {
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
        while plugin_tasks.join_next().await.is_some() {}
    }
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
    drop(outbound_tx);
    // Explicitly release host aliases before process::exit skips stack destructors.
    // The selected engine may still own an ephemeral session after its runtime is drained.
    drop(engine);
    drop(engine_factory);
    drop(workspace_engine);
    #[cfg(unix)]
    if terminated_by_signal {
        // Tokio's process-global stdin reader uses a blocking read which cannot be cancelled.
        // Returning from this async function after SIGTERM can therefore leave runtime shutdown
        // waiting forever. All owned subprocesses and temporary data are explicitly released
        // above, so terminate the app-server itself without waiting on that blocked reader.
        writer.abort();
        std::process::exit(0);
    }
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
        std::process::exit(if writer_result.is_ok() { 0 } else { 1 });
    }
    writer_result
}
