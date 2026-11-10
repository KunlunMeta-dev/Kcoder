//! Thread creation requests: extracted from the app-server connection boundary.

use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engine: &mut QueryEngine,
    workspace_engine: &QueryEngine,
    engine_factory: &AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
    outbound_tx: &mpsc::Sender<Value>,
    next_interaction_id: &Arc<AtomicU64>,
    connection_receipts: &Arc<StdMutex<InteractionReceipts>>,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    automations: &mut project_automations::ProjectAutomations,
    automation_fire: &Option<kcoder_tools::cron::CronFire>,
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_START => {
            let native_initializer = state.native_runtime_thread_initializer.clone();
            if let Some(initializer) = &native_initializer
                && initializer.verify_request(&id, &params).is_err()
            {
                send(
                    outbound_tx,
                    error_response(id, -32022, "RUNTIME_PRIVATE_THREAD_REQUEST_CHANGED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let private_mcp_input = params.get("mcpServers").is_some();
            let start_params = match kcoder_app_rpc_codec::decode::<ThreadStartParams>(params) {
                Ok(params) => params,
                Err(error) => {
                    let message = if private_mcp_input {
                        "Invalid thread creation parameters with temporary MCP launch data".into()
                    } else {
                        error.to_string()
                    };
                    send(outbound_tx, error_response(id, -32602, &message)).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if start_params.agent_definition.is_some()
                && (!state.agent_definitions_v1
                    || state.native_source_dispatch
                    || start_params
                        .studio_work_mode
                        .is_some_and(|mode| mode != kcoder_types::StudioWorkMode::Kcoder)
                    || start_params.session_mode.is_some_and(|mode| {
                        mode != kcoder_app_protocol::ThreadSessionMode::Default
                    }))
            {
                send(
                    outbound_tx,
                    error_response(id, -32602, "AGENT_ORDINARY_TASK_REQUIRED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if !start_params.mcp_servers.is_empty() && !state.temporary_mcp_servers_v1 {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        "Temporary MCP servers require negotiated threadMcpServersV1",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            #[cfg(target_os = "linux")]
            let mut start_params = start_params;
            #[cfg(target_os = "linux")]
            if let Some(binding) = &state.native_acp_receiver_binding
                && binding.apply_thread_defaults(&mut start_params).is_err()
            {
                send(
                    outbound_tx,
                    error_response(id, -32086, "REMOTE_RECEIVER_SESSION_OVERRIDE_DENIED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            #[cfg(target_os = "linux")]
            if start_params.studio_work_mode.is_none() || start_params.model.is_none() {
                let defaults =
                    integrations::core::remote_delegations::observe_current_receiver_defaults(
                        workspace_engine,
                    )
                    .and_then(|defaults| {
                        defaults
                            .map(|value| value.apply_to_unset(&mut start_params))
                            .transpose()
                    });
                if let Err(error) = defaults {
                    let code = error
                        .chain()
                        .map(ToString::to_string)
                        .find(|value| {
                            value.len() <= 160
                                && value.starts_with("REMOTE_")
                                && value.bytes().all(|byte| {
                                    byte.is_ascii_uppercase()
                                        || byte.is_ascii_digit()
                                        || byte == b'_'
                                })
                        })
                        .unwrap_or_else(|| "REMOTE_OFFICE_NATIVE_STARTUP_UNAVAILABLE".into());
                    tracing::warn!(%code,"Native receiver startup defaults unavailable");
                    send(outbound_tx, error_response(id, -32602, &code)).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            if let Err(error) =
                studio_presentation::validate_creation(state, start_params.studio_work_mode)
            {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(requested_cwd) = start_params.cwd.as_deref()
                && let Err(error) =
                    ensure_same_workspace(&workspace_engine.state.cwd(), Path::new(requested_cwd))
                        .await
            {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            match thread_creations::replay(workspace_engine, &start_params) {
                Ok(Some(result)) => {
                    send(outbound_tx, success_response(id, result)).await?;
                    return Ok(DispatchControl::Continue);
                }
                Ok(None) => {}
                Err(error) => {
                    send(outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            let settings_template = match start_params.settings_template.as_deref() {
                Some(template_id) => match resolve_session_template(template_id) {
                    Ok(resolved) => Some(resolved),
                    Err(error) => {
                        send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                },
                // Without an explicit choice the store's default template keeps
                // new sessions from needing a manual switch every time.
                None => match config_templates::default_session_template() {
                    Ok(value) => value,
                    Err(error) => {
                        send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                },
            };
            let mut turn_state = ResidentTurnState::new(
                outbound_tx.clone(),
                permission_mode,
                Arc::clone(next_interaction_id),
                Arc::clone(connection_receipts),
            )
            .with_approval_tool_identity(state.approval_tool_call_identity_v1);
            let native_factory = match native_initializer
                .as_ref()
                .map(|initializer| initializer.factory())
                .transpose()
            {
                Ok(factory) => factory,
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32022, "RUNTIME_PRE_START_POLICY_UNAVAILABLE"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let selected_factory = native_factory.as_ref().unwrap_or(engine_factory);
            let (next_engine, scheduler_lifecycle) = match selected_factory
                .create_fresh_thread_with_mcp(
                    settings_template.as_ref().map(|(path, _)| path.clone()),
                    Arc::clone(&turn_state.user_questioner),
                    &start_params.mcp_servers,
                    &state.input_ended,
                    &mut state.temporary_mcp_cleanup,
                )
                .await
            {
                Ok(engine) => engine,
                Err(error) => {
                    let code = if error.is::<session_mcp::SetupError>() {
                        kcoder_app_protocol::THREAD_MCP_SETUP_FAILED
                    } else {
                        -32022
                    };
                    send(outbound_tx, error_response(id, code, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let next_engine = match native_initializer {
                Some(initializer) => match initializer.install_created(next_engine) {
                    Ok(engine) => engine,
                    Err(_) => {
                        send(
                            outbound_tx,
                            error_response(id, -32022, "RUNTIME_PRE_START_POLICY_UNAVAILABLE"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                },
                None => next_engine,
            };
            let next_engine = if state.native_source_dispatch {
                match next_engine.with_required_native_host_source_admission() {
                    Ok(engine) => engine,
                    Err(_) => {
                        send(
                            outbound_tx,
                            error_response(id, -32022, "Original source owner is unavailable"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            } else {
                next_engine
            };
            let next_engine = next_engine.with_client_questions_supported(state.client_questions);
            turn_state.configure_for_engine(&next_engine);
            if let Some(model) = start_params.model.as_deref()
                && let Err(error) = next_engine.select_client_model(model)
            {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let next_engine = if let Some(reference) = &start_params.agent_definition {
                match integrations::agent_tasks::bind(next_engine, reference) {
                    Ok(engine) => engine,
                    Err(_) => {
                        send(
                            outbound_tx,
                            error_response(id, -32602, "AGENT_DEFINITION_UNAVAILABLE"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            } else {
                next_engine
            };
            let mut lease = match SessionLease::acquire(&next_engine.session_lease_target()) {
                Ok(lease) => lease,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32023, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            lease.bind_scheduler_lifecycle(scheduler_lifecycle);
            // Do not retain a poisoned lock guard while sending the rejection.
            let creation_permission = next_engine
                .settings
                .read()
                .map(|settings| settings.permission_mode)
                .map_err(|_| ());
            let permission_mode_at_creation = match creation_permission {
                Ok(mode) => mode,
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32022, "thread settings are unavailable"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if let Err(error) = record_thread_creation_configuration(
                &next_engine,
                &next_engine.session_id(),
                permission_mode_at_creation,
                settings_template.as_ref().map(|(_, binding)| binding),
            ) {
                send(outbound_tx, error_response(id, -32022, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            match thread_creations::reserve(
                workspace_engine,
                &start_params,
                &next_engine.session_id(),
            ) {
                Ok(true) => {}
                Ok(false) => {
                    let response = match thread_creations::replay(workspace_engine, &start_params) {
                        Ok(Some(result)) => success_response(id, result),
                        Ok(None) => error_response(id, -32059, "creation reservation disappeared"),
                        Err(error) => error_response(id, -32059, &error.to_string()),
                    };
                    send(outbound_tx, response).await?;
                    return Ok(DispatchControl::Continue);
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            *engine = next_engine;
            let runtime = build_resident_thread_runtime(
                engine.clone(),
                lease,
                0,
                turn_state,
                outbound_tx.clone(),
                server_id.to_owned(),
                Arc::clone(sequence),
            );
            match thread_manager.insert(runtime) {
                Ok(Some(evicted)) => evicted.shutdown().await,
                Ok(None) => {}
                Err(rejected) => {
                    (*rejected).shutdown().await;
                    send(
                        outbound_tx,
                        error_response(
                            id,
                            -32039,
                            "resident thread capacity is full; no idle runtime can be evicted",
                        ),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            // Materialize a new thread only after admission to the resident manager;
            // capacity rejection must not leave invisible empty history or session sidecars.
            engine.activate_client_session();
            // Establish an explicit never-run observation only for this newly admitted empty thread.
            // Legacy missing pointers remain unknown and are never repaired by directory reads.
            if let Err(error) = recent_error::initialize_empty(engine, &engine.session_id()) {
                if let Ok(Some(runtime)) = thread_manager.remove_if_idle(&engine.session_id()) {
                    runtime.shutdown().await;
                }
                send(outbound_tx, error_response(id, -32022, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if let Err(error) = engine.state.set_studio_work_mode_before_first_message(
                start_params.studio_work_mode.unwrap_or_default(),
            ) {
                if let Ok(Some(runtime)) = thread_manager.remove_if_idle(&engine.session_id()) {
                    runtime.shutdown().await;
                }
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(mode) = start_params.session_mode
                && let Err(error) = turn_execution::set_mode(engine, mode)
            {
                if let Ok(Some(runtime)) = thread_manager.remove_if_idle(&engine.session_id()) {
                    runtime.shutdown().await;
                }
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(definition_id) = start_params.workflow_definition_id.as_deref() {
                let binding = (|| -> Result<()> {
                    anyhow::ensure!(
                        start_params.session_mode
                            == Some(kcoder_app_protocol::ThreadSessionMode::WorkflowDraft),
                        "Workflow binding requires workflow_draft mode"
                    );
                    workflow_canvas::request(
                        engine,
                        method::WORKFLOW_READ,
                        json!({"id":definition_id}),
                    )?;
                    engine
                        .state
                        .bind_workflow_definition_before_first_message(definition_id)
                })();
                if let Err(error) = binding {
                    if let Ok(Some(runtime)) = thread_manager.remove_if_idle(&engine.session_id()) {
                        runtime.shutdown().await;
                    }
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            let _ = engine.run_startup_hooks().await;
            if let Some(fire) = automation_fire.as_ref() {
                let title: String = fire
                    .prompt
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(80)
                    .collect();
                let patch = serde_json::from_value(
                    json!({"threadId": engine.session_id(), "title": title}),
                )?;
                if let Err(error) = update_thread_metadata(
                    engine,
                    patch,
                    &thread_manager.running_thread_ids(),
                    true,
                ) {
                    tracing::warn!(%error, "failed to persist automation conversation title");
                }
            }
            if start_params.client_request_id.is_some()
                && let Err(error) = engine.state.materialize_history()
            {
                send(outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if start_params.client_request_id.is_some()
                && let Err(error) = engine.state.flush_history().await
            {
                send(outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let thread = thread_snapshot(engine, false);
            if let Some(request_id) = start_params.client_request_id.as_deref()
                && let Err(error) =
                    thread_creations::complete(workspace_engine, request_id, thread.clone())
            {
                send(outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(fire) = automation_fire.as_ref() {
                let thread_id = engine.session_id();
                match automations.start_turn(fire, &thread_id) {
                    Ok(request_id) => {
                        send(
                            outbound_tx,
                            notification(
                                kcoder_app_protocol::method::AUTOMATION_RUN_STARTED,
                                json!(kcoder_app_protocol::AutomationRunStartedParams {
                                    job_id: fire.id.clone(),
                                    thread_id,
                                    thread: thread.clone(),
                                    request_id: Some(request_id),
                                    workspace_path: engine
                                        .state
                                        .cwd()
                                        .to_string_lossy()
                                        .into_owned(),
                                    title: fire.prompt.chars().take(80).collect(),
                                }),
                            ),
                        )
                        .await?
                    }
                    Err(error) => {
                        let request_id = fire.execution_turn_request_id();
                        automations.request_failed(&request_id, "starting_turn", &error);
                        send(
                            outbound_tx,
                            notification(
                                kcoder_app_protocol::method::AUTOMATION_RUN_FAILED,
                                json!(kcoder_app_protocol::AutomationRunFailedParams {
                                    job_id: fire.id.clone(),
                                    thread_id,
                                    request_id,
                                    error: kcoder_app_protocol::RpcError {
                                        code: -32059,
                                        message:
                                            "Scheduled task could not persist its execution start"
                                                .into(),
                                        data: None,
                                    },
                                }),
                            ),
                        )
                        .await?;
                    }
                }
            }
            send(
                outbound_tx,
                success_response(id, json!({"thread": thread.clone()})),
            )
            .await?;
            send(
                outbound_tx,
                notification(
                    "thread/started",
                    with_event_context(
                        server_id,
                        thread["id"].as_str().unwrap_or_default(),
                        None,
                        sequence,
                        json!({"thread": thread}),
                    ),
                ),
            )
            .await?;
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
