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
    next_question_id: &Arc<AtomicU64>,
    next_approval_id: &Arc<AtomicU64>,
    connection_receipts: &Arc<StdMutex<InteractionReceipts>>,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    automations: &mut project_automations::ProjectAutomations,
    automation_fire: &Option<kcoder_tools::cron::CronFire>,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_START => {
            let start_params = match serde_json::from_value::<ThreadStartParams>(params) {
                Ok(params) => params,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
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
                None => config_templates::default_session_template(),
            };
            let mut turn_state = ResidentTurnState::new(
                outbound_tx.clone(),
                permission_mode,
                Arc::clone(next_question_id),
                Arc::clone(next_approval_id),
                Arc::clone(connection_receipts),
            );
            let next_engine = match engine_factory
                .create_fresh_thread_with_template(
                    settings_template.as_ref().map(|(path, _)| path.clone()),
                    Arc::clone(&turn_state.user_questioner),
                )
                .await
            {
                Ok(engine) => engine,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32022, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            turn_state.configure_for_engine(&next_engine);
            if let Some(model) = start_params.model.as_deref()
                && let Err(error) = next_engine.select_client_model(model)
            {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let lease = match SessionLease::acquire(&next_engine.session_lease_target()) {
                Ok(lease) => lease,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32023, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
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
            if let Some((_, binding)) = settings_template.as_ref()
                && let Err(error) = record_thread_settings_template(engine, binding)
            {
                tracing::warn!(%error, "failed to record the session settings template binding");
            }
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
                let request_id = automations.start_turn(fire, &thread_id);
                send(
                    outbound_tx,
                    notification(
                        kcoder_app_protocol::method::AUTOMATION_RUN_STARTED,
                        json!(kcoder_app_protocol::AutomationRunStartedParams {
                            job_id: fire.id.clone(),
                            thread_id,
                            thread: thread.clone(),
                            request_id: Some(request_id),
                            workspace_path: engine.state.cwd().to_string_lossy().into_owned(),
                            title: fire.prompt.chars().take(80).collect(),
                        }),
                    ),
                )
                .await?;
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
