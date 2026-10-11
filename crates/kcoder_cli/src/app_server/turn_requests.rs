//! Turn requests: extracted from the app-server connection boundary.

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
    engine_factory: &AppServerEngineFactory,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    state: &mut ConnectionState,
    attachment_directories: &mut AttachmentDirectories,
) -> Result<DispatchControl> {
    #[cfg(not(windows))]
    let _ = engine_factory;
    match method {
        "turn/start" | method::COMPUTER_USE_RECOVER => {
            let recovery_ticket;
            let params = if method == method::COMPUTER_USE_RECOVER {
                let recovery = match serde_json::from_value::<
                    kcoder_app_protocol::ComputerUseRecoverParams,
                >(params)
                {
                    Ok(params) => params,
                    Err(error) => {
                        send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
                if !state.computer_use_recovery_v1 {
                    send(
                        outbound_tx,
                        error_response(id, -32602, "computerUseRecoveryV1 negotiation is required"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
                if let Some(ready) = state.private_desktop_recovery.take() {
                    if ready.id != id
                        || ready.params != recovery
                        || ready.ticket.validate_ready().is_err()
                    {
                        send(
                            outbound_tx,
                            error_response(
                                id,
                                -32076,
                                "Desktop recovery authorization or cleanup changed",
                            ),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                    recovery_ticket = Some(ready.ticket);
                } else {
                    match desktop_recovery::launch(
                        thread_manager,
                        recovery,
                        server_id,
                        id.clone(),
                        outbound_tx.clone(),
                        state,
                    ) {
                        Ok(Some(receipt)) => {
                            send(
                                outbound_tx,
                                success_response(id, serde_json::to_value(receipt)?),
                            )
                            .await?
                        }
                        Ok(None) => {}
                        Err(error) => {
                            send(outbound_tx, error_response(id, -32076, &error.to_string()))
                                .await?
                        }
                    }
                    return Ok(DispatchControl::Continue);
                }
                json!({"threadId":recovery.thread_id,
                    "input":[{"type":"text", "text":"Recover desktop control safely. First observe the current full desktop with Snapshot or Screenshot, then report the present state. Do not replay any previous click, typing, shortcut, window switch or prior user task. This recovery turn is observation only."}],
                    "computerUse":{"approved":true,"target":"local_windows_desktop"}})
            } else {
                recovery_ticket = None;
                params
            };
            let turn_params = match serde_json::from_value::<TurnStartParams>(params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            #[cfg(windows)]
            let desktop_session_continuation = turn_params
                .computer_use
                .as_ref()
                .is_some_and(|authorization| authorization.use_session_authorization == Some(true));
            #[cfg(windows)]
            let desktop_conversation_authorization =
                turn_params
                    .computer_use
                    .as_ref()
                    .is_some_and(|authorization| {
                        authorization.use_session_authorization == Some(false)
                    });
            if turn_params
                .computer_use
                .as_ref()
                .is_some_and(|authorization| authorization.use_session_authorization.is_some())
                && !state.computer_use_session_authorization_v1
            {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        "computerUseSessionAuthorizationV1 negotiation is required",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let desktop_requested = turn_params.computer_use.is_some();
            if desktop_requested
                && (!cfg!(windows)
                    || !turn_params
                        .computer_use
                        .as_ref()
                        .is_some_and(|permission| permission.approved))
            {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        "Computer Use requires Windows and explicit desktop approval",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if let Err(error) = turn_params.validate_model_selection() {
                send(outbound_tx, error_response(id, -32602, error)).await?;
                return Ok(DispatchControl::Continue);
            }
            let requested_permission_mode = match turn_params
                .permission_mode
                .as_ref()
                .map(|mode| serde_json::from_value::<kcoder_config::PermissionMode>(json!(mode)))
                .transpose()
            {
                Ok(mode) => mode,
                Err(error) => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, &format!("invalid permissionMode: {error}")),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if !thread_manager.owns(&turn_params.thread_id) {
                let (code, message) = if thread_manager.is_empty() {
                    (-32024, "thread/start or thread/resume is required")
                } else {
                    (-32025, "turn threadId does not match active thread")
                };
                send(outbound_tx, error_response(id, code, message)).await?;
                return Ok(DispatchControl::Continue);
            }
            let turn_state = thread_manager
                .turn_state(&turn_params.thread_id)
                .expect("resident runtime has turn state");
            let turn_running = Arc::clone(&turn_state.running);
            let active_turn = Arc::clone(&turn_state.active_turn);
            let question_context = Arc::clone(&turn_state.question_context);
            let approval_context = Arc::clone(&turn_state.approval_context);
            let permission_prompt = turn_state.permission_prompt.clone();
            let Some(turn_registration) = turn_state.claim_turn_registration().await else {
                send(
                    outbound_tx,
                    error_response(id, TURN_ALREADY_RUNNING, "Turn already running"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            *engine = thread_manager
                .select(&turn_params.thread_id)
                .expect("resident runtime disappeared under activity gate");
            if !thread_manager
                .lease(&turn_params.thread_id)
                .is_some_and(|lease| lease.matches_engine(engine))
            {
                turn_running.store(false, Ordering::SeqCst);
                send(
                    outbound_tx,
                    error_response(id, -32024, "thread/start or thread/resume is required"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let background_projection = thread_manager
                .projection(&turn_params.thread_id)
                .expect("resident runtime has projection state");
            let background_followups = thread_manager
                .followups(&turn_params.thread_id)
                .expect("resident runtime has follow-up state");
            let continuing = turn_params.retry_from_turn_id.is_some();
            let legacy_turn_count = thread_manager
                .volatile_turn_count(&turn_params.thread_id)
                .max(engine.client_turn_count());
            let latest_turn =
                match turn_admissions::latest(engine, &turn_params.thread_id, legacy_turn_count) {
                    Ok(number) => number,
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
            if turn_params.retry_from_attempt_id.is_some()
                && turn_params.retry_from_turn_id.is_none()
            {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(
                    outbound_tx,
                    error_response(id, -32602, "retryFromAttemptId requires retryFromTurnId"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(failed_turn_id) = turn_params.retry_from_turn_id.as_deref() {
                let replay_result =
                    if let Some(attempt) = turn_params.retry_from_attempt_id.as_deref() {
                        turn_attempts::request_fingerprint(&turn_params).and_then(|fingerprint| {
                            turn_attempts::retry_admission(
                                engine,
                                &turn_params.thread_id,
                                failed_turn_id,
                                attempt,
                                turn_params.retry_operation_id.as_deref(),
                                &fingerprint,
                                turn_params.retry_model_configuration
                                    != Some(kcoder_types::RetryModelConfiguration::Current)
                                    && turn_params.model.is_none()
                                    && turn_params.reasoning_effort.is_none()
                                    && turn_params.proxy_url.is_none()
                                    && turn_params.service_tier.is_none(),
                            )
                        })
                    } else {
                        replay_accepted_continuation(
                            engine,
                            &turn_params.thread_id,
                            failed_turn_id,
                            latest_turn,
                        )
                    };
                let replayed = match replay_result {
                    Ok(replayed) => replayed,
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(outbound_tx, error_response(id, -32046, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
                if let Some(replayed) = replayed {
                    // A lost response gets the existing attempt without executing it again.
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, success_response(id, replayed)).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            let retry_operation_id = turn_params
                .retry_operation_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(failed_turn_id) = turn_params.retry_from_turn_id.as_deref() {
                // A retry operation names one recovery. Finding it committed
                // under another failed turn is an identity conflict, not a
                // missing recovery point (S2/R034 family).
                if let Some(operation) = retry_operation_id
                    && let Some(committed) =
                        turn_continuation_for_operation(engine, &turn_params.thread_id, operation)
                    && committed.turn_id != failed_turn_id
                {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(
                            outbound_tx,
                            error_response(
                                id,
                                -32047,
                                &format!(
                                    "retry operation {operation} was already committed as {}; query that attempt instead",
                                    committed.turn_id
                                ),
                            ),
                        )
                        .await?;
                    return Ok(DispatchControl::Continue);
                }
                let validation = (|| -> Result<()> {
                    anyhow::ensure!(
                        turn_params.input.is_empty()
                            && turn_params.client_message_id.is_none()
                            && turn_params.turn_mode.is_none(),
                        "Continuation cannot submit another user input or execution mode"
                    );

                    failed_turn::validate(engine, failed_turn_id, latest_turn)?;
                    Ok(())
                })();
                if let Err(error) = validation {
                    turn_running.store(false, Ordering::SeqCst);
                    send(outbound_tx, error_response(id, -32046, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            if !continuing && let Some(operation) = retry_operation_id {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        &format!("retry operation {operation} requires a failed turn to continue"),
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if !continuing
                && let Some(client_message_id) = turn_params
                    .client_message_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                && !turn_params.resubmit.unwrap_or(false)
            {
                let committed = load_turn_client_message_ids(engine, &turn_params.thread_id);
                if let Some(existing_turn) =
                    committed_turn_for_client_message(&committed, client_message_id)
                {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(
                            outbound_tx,
                            error_response(
                                id,
                                -32047,
                                &format!(
                                    "client message {client_message_id} was already committed as {existing_turn}; resubmit to start another attempt"
                                ),
                            ),
                        )
                        .await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            let prepared_model = if continuing {
                turn_attempts::prepare_continuation_model(engine, &turn_params)
            } else if turn_params.model_selection_mode
                == Some(kcoder_types::ModelSelectionMode::FollowTargetDefault)
            {
                engine.follow_target_default_model()
            } else {
                engine.prepare_client_model_for_turn(turn_params.model.as_deref(), continuing)
            };
            if let Err(error) = prepared_model {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if !continuing {
                match engine_factory.refresh_plugin_credentials(engine).await {
                    Ok(Some(candidate)) => {
                        thread_manager
                            .replace_host_turn_engine(&turn_params.thread_id, candidate.clone())?;
                        *engine = candidate;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(
                            outbound_tx,
                            error_response(
                                id,
                                -32054,
                                &format!("Plugin activation refresh failed: {error}"),
                            ),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            }
            if !continuing
                && let Some(reasoning_effort) = turn_params.reasoning_effort.as_deref()
                && let Err(error) = engine.set_client_reasoning_effort(reasoning_effort)
            {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if !continuing
                && (turn_params.proxy_url.is_some() || turn_params.service_tier.is_some())
                && let Err(error) = engine.set_client_runtime_options(
                    turn_params.proxy_url.as_deref(),
                    turn_params.service_tier.as_deref(),
                )
            {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let Some(prompt) = (if continuing {
                Some(String::new())
            } else {
                prompt_from_params(&params)
            }) else {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(
                    outbound_tx,
                    error_response(id, -32602, "turn/start requires non-empty prompt"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            let turn_mode = turn_params.turn_mode.unwrap_or_default();
            if turn_mode == kcoder_app_protocol::TurnExecutionMode::MoaPlan {
                let preflight = engine.moa_plan_preflight().and_then(|_| {
                    anyhow::ensure!(
                        turn_params.input.iter().all(|input| matches!(
                            input,
                            kcoder_app_protocol::UserInput::Text { .. }
                        )),
                        "MoA planning requires a text planning request"
                    );
                    anyhow::ensure!(
                        !prompt.contains("<kcoder_attachments "),
                        "MoA planning requires a text planning request"
                    );
                    Ok(())
                });
                if let Err(error) = preflight {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            if let Err(error) = engine.acknowledge_orchestrate_user_input() {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                let response = protocol_io::local_runtime_error_response(id, &error.to_string());
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
            // The counter is initialized from the durable transcript on resume and reset on
            // thread/start. Keeping it in the owning app-server process avoids racing the
            // asynchronous first JSONL flush while remaining independent of compacted model
            // context.
            // Scheduled prompts can append genuine user-role turns between
            // explicit requests. Never reuse their durable turn numbers.
            if background_followups.client_turn_count.get().is_none() {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32022,
                        "resident turn count is unavailable; resume the thread before starting another turn")).await?;
                return Ok(DispatchControl::Continue);
            }
            let completed_turns = thread_manager
                .volatile_turn_count(&turn_params.thread_id)
                .max(engine.client_turn_count());
            thread_manager.set_volatile_turn_count(&turn_params.thread_id, completed_turns);
            let turn_id = turn_params
                .retry_from_turn_id
                .clone()
                .unwrap_or_else(|| format!("turn-{}", latest_turn.saturating_add(1)));
            let thread_id = engine.session_id();
            let task_attempt_id = if continuing {
                format!("{}-retry-{}", turn_id, uuid::Uuid::new_v4())
            } else {
                turn_id.clone()
            };
            let task_attempt_identity = kcoder_types::TurnAttemptIdentity {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                attempt_id: task_attempt_id.clone(),
            };
            if let Err(error) = turn_attempts::save_model_snapshot(engine, &task_attempt_identity) {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            // Only validated requests may acquire an accepted-operation identity.
            // Otherwise an invalid model/proxy request poisons the valid retry that follows.
            if continuing {
                let receipt = input_context_hash(&engine.state.messages()).and_then(|hash| {
                    save_turn_continuation_receipt(
                        engine,
                        &thread_id,
                        &turn_id,
                        &hash,
                        retry_operation_id,
                    )
                });
                if let Err(error) = receipt {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            if let Err(error) = clear_turn_outcome(engine, &thread_id, &turn_id) {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            if !continuing
                && let Err(error) = save_turn_client_message_id(
                    engine,
                    &thread_id,
                    &turn_id,
                    turn_params.client_message_id.as_deref(),
                )
            {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let prompt = match materialize_turn_attachments(
                engine,
                &thread_id,
                &turn_id,
                &prompt,
                attachment_directories,
            ) {
                Ok(prompt) => prompt,
                Err(error) => {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let model_message = match model_message_from_materialized_prompt(&prompt) {
                Ok(Some(message)) => message,
                Ok(None) => kcoder_types::Message::user_text(prompt.clone()),
                Err(error) => {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if !continuing
                && let Err(error) =
                    turn_admissions::accept(engine, &thread_id, latest_turn.saturating_add(1))
            {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let mut attempt_inputs = engine.state.messages();
            if !continuing {
                attempt_inputs.push(model_message.clone());
            }
            let attempt_start = serde_json::to_vec(&attempt_inputs)
                .context("failed to hash attempt context")
                .and_then(|bytes| {
                    turn_attempts::begin(
                        engine,
                        &task_attempt_identity,
                        continuing,
                        retry_operation_id,
                        hex_sha256(&bytes),
                        turn_attempts::request_fingerprint(&turn_params)?,
                    )
                });
            if let Err(error) = attempt_start {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let automation_scheduler = if id
                .as_str()
                .is_some_and(|request| request.starts_with("kcoder-automation-turn:"))
            {
                let scheduler = engine.cron_scheduler();
                let model = engine.settings.read().unwrap().model.clone();
                let accepted = scheduler
                    .execution_accepted(
                        id.as_str().unwrap(),
                        &thread_id,
                        &turn_id,
                        &task_attempt_id,
                        Some(&model),
                    )
                    .and_then(|registered| {
                        registered.then_some(()).ok_or_else(|| {
                            "Automation request has no registered execution receipt".to_string()
                        })
                    });
                match accepted {
                    Ok(()) => Some(scheduler),
                    Err(error) => {
                        if let Err(persist_error) = turn_attempts::finish(
                            engine,
                            &task_attempt_identity,
                            "failed",
                            Some(&error),
                            None,
                            &turn_attempts::PartialOutput::default(),
                        ) {
                            tracing::warn!(%persist_error, "automation admission attempt terminal outcome is uncertain");
                        }
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(outbound_tx, error_response(id, -32059, &error)).await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            } else {
                None
            };
            let turn_artifact_dir = engine
                .session_storage_dir_for(&thread_id)
                .join("turn-file-changes");
            send(
                    outbound_tx,
                    success_response(id, if let Some(ticket) = recovery_ticket.as_ref() {
                        serde_json::to_value(kcoder_app_protocol::ComputerUseRecoverResult {
                            thread_id: thread_id.clone(), previous_turn_id: ticket.previous_turn_id().into(), turn_id: turn_id.clone(), status: kcoder_app_protocol::ComputerUseRecoveryStatus::Running,
                        })?
                    } else {
                        json!({"turn": {"id": turn_id, "threadId": thread_id, "attemptId": task_attempt_id, "status": "running"}})
                    }),
                )
                .await?;

            let cancel = CancellationToken::new();
            let task_engine = state.configure_turn_engine(engine, cancel.clone());
            let task_tx = outbound_tx.clone();
            let task_running = Arc::clone(&turn_running);
            let task_turn_id = turn_id.clone();
            let task_thread_id = thread_id.clone();
            let task_server_id = server_id.to_owned();
            let task_sequence = Arc::clone(sequence);
            let task_cancel = cancel.clone();
            let task_projection = Arc::new(Mutex::new(StreamProjection::new(
                task_server_id.to_owned(),
                task_thread_id.clone(),
                task_turn_id.clone(),
                Arc::clone(&task_sequence),
            )));
            task_projection.lock().await.item_namespace = task_attempt_id.clone();
            set_active_background_projection(
                &background_projection,
                &task_thread_id,
                &task_turn_id,
                Arc::clone(&task_projection),
            )
            .await;
            let task_background_projection = Arc::clone(&background_projection);
            let task_background_followups = Arc::clone(&background_followups);
            *question_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(QuestionContext {
                server_id: task_server_id.to_owned(),
                thread_id: task_thread_id.clone(),
                turn_id: task_turn_id.clone(),
            });
            *approval_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ApprovalContext {
                server_id: task_server_id.to_owned(),
                thread_id: task_thread_id.clone(),
                turn_id: task_turn_id.clone(),
            });
            let task_turn_state = turn_state.clone();
            let mut task_permission_prompt = permission_prompt.clone();
            if let Some(mode) = requested_permission_mode {
                task_permission_prompt.mode = mode;
            }
            let task_artifact_dir = turn_artifact_dir.clone();
            let task_workspace = engine.state.cwd().to_path_buf();
            let task_snapshot_policy = engine.settings.read().unwrap().turn_file_changes.clone();
            let goal_turn = task_background_followups.goals.lock().unwrap().begin(
                &task_engine,
                requested_permission_mode,
                None,
            );
            #[cfg(windows)]
            let desktop_diagnostics_negotiated = state.computer_use_recovery_v1;
            #[cfg(windows)]
            let desktop_configuration = engine_factory.clone();
            let handle = tokio::spawn(async move {
                let turn_permissions = turn_permissions::TurnPermissions::new(
                    task_engine.clone(),
                    requested_permission_mode,
                );
                let _ = send(
                    &task_tx,
                    notification(
                        "turn/started",
                        with_event_context(
                            &task_server_id,
                            &task_thread_id,
                            Some(&task_turn_id),
                            &task_sequence,
                            json!({"attemptId": task_attempt_id, "turn": {
                                "id": task_turn_id,
                                "threadId": task_thread_id,
                                "status": "running"
                            }}),
                        ),
                    ),
                )
                .await;
                #[cfg(windows)]
                let (desktop_turn, desktop_error) = if desktop_requested {
                    let owner = kcoder_types::computer_use::DesktopOwner {
                        client_instance: task_server_id.clone(),
                        thread_id: task_thread_id.clone(),
                        turn_id: task_turn_id.clone(),
                    };
                    let prepared = tokio::select! {
                        _ = task_cancel.cancelled() => Err(anyhow::anyhow!("desktop startup cancelled")),
                        result = desktop_turn::DesktopTurn::prepare(&task_engine, owner.clone(), &desktop_configuration, task_turn_state.desktop_grant.clone(), recovery_ticket.as_ref(), desktop_session_continuation, desktop_conversation_authorization) => result,
                    };
                    match prepared {
                        Ok(turn) => (Some(turn), None),
                        Err(error) => {
                            if desktop_diagnostics_negotiated {
                                desktop_recovery::publish_startup_failure(
                                    &task_turn_state.desktop_grant,
                                    &owner,
                                    &task_sequence,
                                    &task_tx,
                                )
                                .await;
                            }
                            (
                                None,
                                Some(format!("Computer Use startup failed: {error:#}")),
                            )
                        }
                    }
                } else {
                    (None, None)
                };
                #[cfg(not(windows))]
                let desktop_error: Option<String> = {
                    let _ = recovery_ticket;
                    None
                };
                #[cfg(windows)]
                let desktop_notifications = desktop_turn.as_ref().map(|turn| {
                    desktop_notifications::DesktopNotifications::start_with_diagnostics(
                        turn.subscribe_state(),
                        turn.subscribe_diagnostics(),
                        if desktop_diagnostics_negotiated {
                            turn.grant()
                        } else {
                            None
                        },
                        kcoder_types::computer_use::DesktopOwner {
                            client_instance: task_server_id.clone(),
                            thread_id: task_thread_id.clone(),
                            turn_id: task_turn_id.clone(),
                        },
                        task_sequence.clone(),
                        task_tx.clone(),
                    )
                });
                #[cfg(windows)]
                let task_engine = desktop_turn
                    .as_ref()
                    .map_or_else(|| task_engine.clone(), |turn| turn.engine().clone());
                let moa_plan_baseline = (turn_mode
                    == kcoder_app_protocol::TurnExecutionMode::MoaPlan)
                    .then(|| task_engine.client_turn_count());
                let mut counted_user_message = false;
                let mut stream: std::pin::Pin<Box<dyn futures::Stream<Item = EngineEvent> + Send>> =
                    if let Some(error) = desktop_error {
                        Box::pin(futures::stream::once(
                            async move { EngineEvent::Error(error) },
                        ))
                    } else if continuing {
                        turn_execution::continue_failed(task_engine.clone(), task_permission_prompt)
                    } else {
                        turn_execution::stream(
                            task_engine.clone(),
                            model_message,
                            prompt,
                            task_permission_prompt,
                            turn_mode,
                            task_cancel.clone(),
                        )
                    };
                let mut before_tree = None;
                let mut snapshot_attempted = false;
                let mut status = "completed";
                let mut terminal_error = None;
                let mut provider_failure = None;
                let mut terminal_outcome_persisted = false;
                let mut attempt_partial = turn_attempts::PartialOutput::default();
                let mut live_files = live_file_progress::LiveFileProgress::new(
                    task_workspace.clone(),
                    task_artifact_dir.clone(),
                    task_turn_id.clone(),
                    task_snapshot_policy.clone(),
                );
                while let Some(update) = live_files.next(&mut stream).await {
                    let event = match update {
                        live_file_progress::Update::Engine(event) => event,
                        live_file_progress::Update::Files(counts) => {
                            if send(&task_tx, notification("item/event", with_event_context(&task_server_id, &task_thread_id, Some(&task_turn_id), &task_sequence, json!({"event":{"type":"workspace_file_progress","counts":counts}})))).await.is_err() {
                                task_cancel.cancel();
                                break;
                            }
                            continue;
                        }
                        live_file_progress::Update::ToolFiles { id, counts } => {
                            if send(&task_tx, notification("item/event", with_event_context(&task_server_id, &task_thread_id, Some(&task_turn_id), &task_sequence, json!({"event":{"type":"tool_file_progress","id":id,"counts":counts}})))).await.is_err() {
                                task_cancel.cancel();
                                break;
                            }
                            continue;
                        }
                    };
                    let event =
                        normalize_cancelled_terminal_event(event, task_cancel.is_cancelled());
                    attempt_partial.observe(&event);
                    if !counted_user_message
                        && explicit_turn_appended_user_message(
                            &task_engine,
                            &event,
                            moa_plan_baseline,
                        )
                    {
                        if let Err(error) = task_background_followups.client_turn_count.increment()
                        {
                            status = "failed";
                            terminal_error = Some(error.to_string());
                            break;
                        }
                        if !continuing
                            && let Err(error) = turn_admissions::bind_user(
                                &task_engine,
                                &task_thread_id,
                                &task_turn_id,
                            )
                        {
                            status = "failed";
                            terminal_error = Some(error.to_string());
                            break;
                        }
                        counted_user_message = true;
                    }
                    // ToolUseStarted yields the event stream before actual execution. Send the
                    // state to the client, then establish a file baseline as needed before the next poll executes the tool.
                    let should_snapshot = !snapshot_attempted
                        && matches!(
                            &event,
                            EngineEvent::ToolUseStarted { name, .. }
                                if live_file_progress::may_mutate_workspace(&task_engine.active_tool_registry(), name)
                        );
                    let executing_writer = match &event {
                        EngineEvent::ToolExecutionStarted { id, name }
                            if live_file_progress::may_mutate_workspace(
                                &task_engine.active_tool_registry(),
                                name,
                            ) =>
                        {
                            Some(id.clone())
                        }
                        _ => None,
                    };
                    // Deliver the last observation before item/completed clears the live tool.
                    if let EngineEvent::ToolResult { id, .. } | EngineEvent::ToolDenied { id, .. } = &event
                        && let Some(counts) = live_files.finish_tool(id).await
                        && send(&task_tx, notification("item/event", with_event_context(&task_server_id, &task_thread_id, Some(&task_turn_id), &task_sequence, json!({"event":{"type":"tool_file_progress","id":id,"counts":counts}})))).await.is_err()
                    {
                        task_cancel.cancel();
                        break;
                    }
                    if let Some((next_status, error)) =
                        terminal_outcome(&event, task_cancel.is_cancelled())
                    {
                        status = next_status;
                        terminal_error = Some(error.clone());
                        provider_failure = match &event {
                            EngineEvent::ProviderFailed { details, .. } => Some(details.clone()),
                            _ => None,
                        };
                        // The page may refresh immediately after a terminal notification reaches the
                        // client. Make failure/interruption artifacts readable first so thread/read
                        // never temporarily restores history without its failure card.
                        match save_turn_outcome_with_continuation(
                            &task_engine,
                            &task_thread_id,
                            &task_turn_id,
                            status,
                            Some(&error),
                            provider_failure.as_ref(),
                            turn_mode == kcoder_app_protocol::TurnExecutionMode::Standard,
                        ) {
                            Ok(()) => terminal_outcome_persisted = true,
                            Err(error) => {
                                tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist terminal turn outcome before projection")
                            }
                        }
                    }
                    if let EngineEvent::ToolUseStarted { id, name, .. } = &event
                        && tool_can_spawn_managed_background_job(name)
                    {
                        register_background_tool_call(
                            &task_background_projection,
                            id,
                            &task_thread_id,
                            &task_turn_id,
                            Arc::clone(&task_projection),
                        )
                        .await;
                    }
                    // Background lifecycle presentation is owned exclusively by the
                    // connection-level broadcast pump. The engine stream may also surface a
                    // terminal event for conversation injection; projecting it here would
                    // duplicate the same job on the wire.
                    let messages = if background_event_id(&event).is_some() {
                        if project_managed_background_event(
                            &task_engine,
                            &task_background_projection,
                            &task_tx,
                            event,
                        )
                        .await
                        .is_err()
                        {
                            task_turn_state.clear_pending();
                            task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                            task_running.store(false, Ordering::SeqCst);
                            task_background_followups.notify.notify_waiters();
                            clear_active_background_projection(
                                &task_background_projection,
                                &task_thread_id,
                                &task_turn_id,
                            )
                            .await;
                            live_files.stop().await;
                            return;
                        }
                        Vec::new()
                    } else {
                        task_projection.lock().await.project(event)
                    };
                    for message in messages {
                        if send(&task_tx, message).await.is_err() {
                            task_turn_state.clear_pending();
                            task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                            task_running.store(false, Ordering::SeqCst);
                            task_background_followups.notify.notify_waiters();
                            clear_active_background_projection(
                                &task_background_projection,
                                &task_thread_id,
                                &task_turn_id,
                            )
                            .await;
                            live_files.stop().await;
                            return;
                        }
                    }
                    if let Some(id) = executing_writer {
                        live_files.start_tool(&id).await;
                    }
                    if should_snapshot && task_snapshot_policy.enabled {
                        snapshot_attempted = true;
                        before_tree = match capture_worktree_tree_with_policy(
                            &task_workspace,
                            &task_artifact_dir,
                            &task_turn_id,
                            "before",
                            &task_snapshot_policy,
                        )
                        .await
                        {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                tracing::warn!(%error, turn_id = %task_turn_id, "failed to snapshot worktree before mutating app-server tool");
                                None
                            }
                        };
                        if let Some(before) = &before_tree {
                            live_files.set_baseline(before);
                        } else {
                            live_files.set_native_baseline().await;
                        }
                    }
                    if status != "completed" {
                        break;
                    }
                }
                drop(stream);
                live_files.stop().await;
                if task_cancel.is_cancelled() {
                    status = "interrupted";
                    terminal_error = Some("cancelled by user".into());
                    provider_failure = None;
                    terminal_outcome_persisted = false;
                }
                let publish_goal = goal_turn.tracks_goal() || task_engine.state.goal().is_some();
                #[cfg(windows)]
                if let Some(desktop_turn) = desktop_turn {
                    if let Err(error) = desktop_turn.finish().await {
                        status = "failed";
                        terminal_error = Some(format!("Computer Use cleanup failed: {error:#}"));
                        terminal_outcome_persisted = false;
                    }
                }
                #[cfg(windows)]
                if let Some(notifications) = desktop_notifications {
                    notifications.finish().await;
                }
                task_background_followups.goals.lock().unwrap().finish(
                    &task_engine,
                    goal_turn,
                    status,
                    provider_failure.as_ref(),
                );
                if publish_goal {
                    goal_lifecycle::publish(&task_engine, &task_tx).await;
                }
                let history_flushed = task_engine.state.flush_history().await;
                if let Err(error) = &history_flushed {
                    tracing::warn!(%error, turn_id = %task_turn_id, "failed to flush app-server transcript before turn completion");
                }
                if !terminal_outcome_persisted
                    && let Err(error) = save_turn_outcome_with_continuation(
                        &task_engine,
                        &task_thread_id,
                        &task_turn_id,
                        status,
                        terminal_error.as_deref(),
                        provider_failure.as_ref(),
                        turn_mode == kcoder_app_protocol::TurnExecutionMode::Standard,
                    )
                {
                    tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist terminal turn outcome");
                }
                let attempt_finished = turn_attempts::finish(
                    &task_engine,
                    &task_attempt_identity,
                    status,
                    terminal_error.as_deref(),
                    provider_failure.as_ref(),
                    &attempt_partial,
                );
                if let Err(error) = &attempt_finished {
                    tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist attempt terminal evidence");
                }
                if history_flushed.is_ok()
                    && attempt_finished.is_ok()
                    && let Some(scheduler) = automation_scheduler.as_ref()
                {
                    // Reuse the identity/committed-history verifier; streamed partial text is not execution evidence.
                    cron_processor::reconcile_execution(&task_engine, scheduler);
                }
                let file_changes = match before_tree {
                    Some(before_tree) => match finalize_turn_file_changes_with_policy(
                        &task_workspace,
                        &task_artifact_dir,
                        &task_thread_id,
                        &task_turn_id,
                        before_tree,
                        &task_snapshot_policy,
                    )
                    .await
                    {
                        Ok(Some(artifact)) => Some(turn_file_changes_summary(&artifact)),
                        Ok(None) => None,
                        Err(error) => {
                            tracing::warn!(%error, turn_id = %task_turn_id, "failed to create turn file changes artifact");
                            None
                        }
                    },
                    None => None,
                };
                drop(turn_permissions);
                task_turn_state.clear_pending();
                task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                let _ = send(
                    &task_tx,
                    notification(
                        "turn/completed",
                        with_event_context(
                            &task_server_id,
                            &task_thread_id,
                            Some(&task_turn_id),
                            &task_sequence,
                            json!({
                                "turn": {
                                    "id": task_turn_id,
                                    "threadId": task_thread_id,
                                    "status": status,
                                },
                                "error": turn_completion_error(terminal_error, provider_failure),
                                "fileChanges": file_changes,
                            }),
                        ),
                    ),
                )
                .await;
                clear_active_background_projection(
                    &task_background_projection,
                    &task_thread_id,
                    &task_turn_id,
                )
                .await;
                task_running.store(false, Ordering::SeqCst);
                task_background_followups.notify.notify_waiters();
            });
            *active_turn.lock().await = Some(ActiveTurn {
                handle,
                cancel,
                thread_id,
                turn_id,
            });
            drop(turn_registration);
        }
        "turn/shorten_wait" => {
            let requested_thread = params.get("threadId").and_then(Value::as_str);
            let requested_turn = params.get("turnId").and_then(Value::as_str);
            let candidate_states = if let Some(thread_id) = requested_thread {
                thread_manager.turn_state(thread_id).into_iter().collect()
            } else {
                thread_manager.turn_states()
            };
            let mut matched_thread_id = None;
            for turn_state in candidate_states {
                if !turn_state.running.load(Ordering::SeqCst) {
                    continue;
                }
                let guard = turn_state.active_turn.lock().await;
                // Peek only: the active-turn record must survive the
                // shorten request, or a following `turn/interrupt` could
                // no longer match and cancel the same turn.
                matched_thread_id = guard
                    .as_ref()
                    .filter(|active| active.matches(requested_thread, requested_turn))
                    .map(|active| active.thread_id.clone());
                if matched_thread_id.is_some() {
                    break;
                }
            }
            let Some(thread_id) = matched_thread_id else {
                send(
                    outbound_tx,
                    success_response(id, json!({"shortened": false})),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            // TUI Escape 的第一段语义：把运行中的 Sleep/wait 剩余等待折叠到
            // 短宽限期，turn 继续而不是取消。信号是一次性的，对之后才启动
            // 的等待无效；没有 waiter 时调用也无害。
            let shortened = thread_manager
                .engine(&thread_id)
                .map(|engine| {
                    engine.shorten_waiting_tools();
                    true
                })
                .unwrap_or(false);
            send(
                outbound_tx,
                success_response(id, json!({"shortened": shortened})),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        "turn/interrupt" => {
            let requested_thread = params.get("threadId").and_then(Value::as_str);
            let requested_turn = params.get("turnId").and_then(Value::as_str);
            let candidate_states = if let Some(thread_id) = requested_thread {
                thread_manager.turn_state(thread_id).into_iter().collect()
            } else {
                thread_manager.turn_states()
            };
            let mut matched = None;
            for turn_state in candidate_states {
                if !turn_state.running.load(Ordering::SeqCst) {
                    continue;
                }
                let mut guard = turn_state.active_turn.lock().await;
                if guard
                    .as_ref()
                    .is_some_and(|active| active.matches(requested_thread, requested_turn))
                {
                    matched = guard.take().map(|active| (turn_state.clone(), active));
                    break;
                }
            }
            let Some((turn_state, active)) = matched else {
                send(
                    outbound_tx,
                    success_response(id, json!({"interrupted": false})),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            let interrupted_thread_id = active.thread_id.clone();
            let interrupted_turn_id = active.turn_id.clone();
            {
                let _gate = turn_state.activity_gate.lock().await;
                if let Some(followups) = thread_manager.followups(&interrupted_thread_id) {
                    followups.goals.lock().unwrap().suspend();
                }
                if let Some(engine) = thread_manager.engine(&interrupted_thread_id)
                    && engine
                        .state
                        .goal()
                        .is_some_and(|goal| goal.status.is_active())
                {
                    engine.state.update_goal_status(GoalStatus::Paused);
                    goal_lifecycle::publish(&engine, outbound_tx).await;
                }
            }
            active.cancel.cancel();
            send(
                outbound_tx,
                success_response(id, json!({"interrupted": true})),
            )
            .await?;
            let background_projection = thread_manager
                .projection(&interrupted_thread_id)
                .expect("matched resident turn has projection state");
            let background_followups = thread_manager
                .followups(&interrupted_thread_id)
                .expect("matched resident turn has follow-up state");
            let forced = cancel_active_turn_bounded(
                active,
                &turn_state,
                &background_projection,
                &background_followups,
            )
            .await;
            if forced {
                let reason = "cancelled by user (forced shutdown)";
                if let Some(engine) = thread_manager.engine(&interrupted_thread_id)
                    && let Err(error) = save_turn_outcome(
                        &engine,
                        &interrupted_thread_id,
                        &interrupted_turn_id,
                        "interrupted",
                        Some(reason),
                        None,
                    )
                {
                    tracing::warn!(%error, "failed to persist forced turn interruption");
                }
                send(outbound_tx, notification("turn/completed", with_event_context(
                    server_id, &interrupted_thread_id, Some(&interrupted_turn_id), sequence,
                    json!({"turn": {"id": interrupted_turn_id, "threadId": interrupted_thread_id, "status": "interrupted"}, "error": {"message": reason}}),
                ))).await?;
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
