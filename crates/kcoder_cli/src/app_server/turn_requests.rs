//! Turn requests: extracted from the app-server connection boundary.

use super::*;
use kcoder_app_events::foreground_events;
use kcoder_app_protocol::integrations::channel_peer::ChannelPeerReply;
use kcoder_app_rpc_codec as rpc_codec;

struct UnusedGoalObservationGuard(Option<kcoder_state::NativeGoalMetadataSettlement>);

impl Drop for UnusedGoalObservationGuard {
    fn drop(&mut self) {
        if let Some(settlement) = &self.0 {
            settlement.try_revoke_if_armed();
        }
    }
}

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
    retained_authority: Option<retained_turn::Authority<'_>>,
) -> Result<DispatchControl> {
    match method {
        "turn/start" | method::COMPUTER_USE_RECOVER => {
            dispatch_start(
                method,
                id,
                params,
                engine,
                engine_factory,
                outbound_tx,
                thread_manager,
                server_id,
                sequence,
                state,
                attachment_directories,
                retained_authority,
                None,
                None,
            )
            .await
        }
        "turn/shorten_wait" => shorten_wait(id, params, outbound_tx, thread_manager).await,
        "turn/interrupt" => {
            interrupt(
                id,
                params,
                engine,
                outbound_tx,
                thread_manager,
                server_id,
                sequence,
                state,
            )
            .await
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the existing turn-start route and optional internal async-question admission explicit"
)]
pub(super) async fn dispatch_async_question_claim(
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
    retained_authority: Option<retained_turn::Authority<'_>>,
    claim: kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
    receipt_id: u64,
    turn_registration: tokio::sync::OwnedMutexGuard<()>,
) -> Result<DispatchControl> {
    dispatch_start(
        "turn/start",
        id,
        params,
        engine,
        engine_factory,
        outbound_tx,
        thread_manager,
        server_id,
        sequence,
        state,
        attachment_directories,
        retained_authority,
        Some((claim, receipt_id)),
        Some(turn_registration),
    )
    .await
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed app-server resources explicit at the turn boundary"
)]
fn dispatch_start<'a>(
    method: &'a str,
    id: Value,
    params: Value,
    engine: &'a mut QueryEngine,
    engine_factory: &'a AppServerEngineFactory,
    outbound_tx: &'a mpsc::Sender<Value>,
    thread_manager: &'a mut ThreadManager,
    server_id: &'a str,
    sequence: &'a Arc<AtomicU64>,
    state: &'a mut ConnectionState,
    attachment_directories: &'a mut AttachmentDirectories,
    retained_authority: Option<retained_turn::Authority<'a>>,
    async_question_admission: Option<(
        kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
        u64,
    )>,
    preclaimed_turn_registration: Option<tokio::sync::OwnedMutexGuard<()>>,
) -> futures::future::BoxFuture<'a, Result<DispatchControl>> {
    futures::FutureExt::boxed(dispatch_start_inner(
        method,
        id,
        params,
        engine,
        engine_factory,
        outbound_tx,
        thread_manager,
        server_id,
        sequence,
        state,
        attachment_directories,
        retained_authority,
        async_question_admission,
        preclaimed_turn_registration,
    ))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the original separately borrowed owners behind the erased request future"
)]
async fn dispatch_start_inner(
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
    retained_authority: Option<retained_turn::Authority<'_>>,
    mut async_question_admission: Option<(
        kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
        u64,
    )>,
    mut preclaimed_turn_registration: Option<tokio::sync::OwnedMutexGuard<()>>,
) -> Result<DispatchControl> {
    #[cfg(not(windows))]
    let _ = engine_factory;
    match method {
        "turn/start" | method::COMPUTER_USE_RECOVER => {
            let recovery_ticket;
            let params = if method == method::COMPUTER_USE_RECOVER {
                let recovery = match rpc_codec::decode::<
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
            let turn_params = match rpc_codec::decode::<TurnStartParams>(params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if turn_params.channel_tool_restrictions.is_some()
                && turn_params.unattended != Some(true)
            {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        "channelToolRestrictions requires unattended input",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let start_gates = kcoder_turn_lifecycle::admission::StartGates {
                async_questions_enabled: state.async_user_questions_v1,
                async_answer_claimed: async_question_admission.is_some(),
                retention_verified: retained_authority.is_some(),
                desktop_session_authorization_enabled: state.computer_use_session_authorization_v1,
            };
            let preflight = {
                let receiver_rejects = |params: &TurnStartParams| {
                    #[cfg(target_os = "linux")]
                    {
                        state
                            .native_acp_receiver_binding
                            .as_ref()
                            .is_some_and(|binding| binding.validate_turn(params).is_err())
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        let _ = params;
                        false
                    }
                };
                kcoder_turn_lifecycle::admission::validate_start(
                    &turn_params,
                    start_gates,
                    &receiver_rejects,
                )
            };
            let start_options = match preflight {
                Ok(options) => options,
                Err(rejection) => {
                    send(
                        outbound_tx,
                        error_response(id, rejection.code, &rejection.message),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let requested_permission_mode = start_options.permission_mode;
            #[cfg(windows)]
            let desktop_requested = start_options.desktop_requested;
            #[cfg(windows)]
            let desktop_session_continuation = start_options.desktop_session_continuation;
            #[cfg(windows)]
            let desktop_conversation_authorization =
                start_options.desktop_conversation_authorization;
            if !thread_manager.owns(&turn_params.thread_id) {
                let (code, message) = if thread_manager.is_empty() {
                    (-32024, "thread/start or thread/resume is required")
                } else {
                    (-32025, "turn threadId does not match active thread")
                };
                send(outbound_tx, error_response(id, code, message)).await?;
                return Ok(DispatchControl::Continue);
            }
            let original_source_required = thread_manager
                .engine(&turn_params.thread_id)
                .is_some_and(|resident| resident.native_input_requires_source_admission());
            let source_check = original_source_required
                .then(|| {
                    state.native_source_accepted.as_ref().and_then(|observer| {
                        thread_manager
                            .engine(&turn_params.thread_id)
                            .map(|resident| observer.verify_before_accept(&resident, &turn_params))
                    })
                })
                .flatten();
            let original_source_verified =
                original_source_required && matches!(source_check.as_ref(), Some(Ok(())));
            let independently_authorized_ui = original_source_required
                && !original_source_verified
                && matches!(
                    integrations::connectivity::task_ui::prepare_resident_input(
                        state,
                        thread_manager,
                        &turn_params.thread_id,
                    ),
                    Ok(Some(_))
                );
            if original_source_required && !original_source_verified && !independently_authorized_ui
            {
                if matches!(source_check, Some(Err(_))) {
                    tracing::warn!(
                        code = "native_source_admission_unconfirmed",
                        "Original source admission could not be verified"
                    );
                }
                send(
                    outbound_tx,
                    error_response(id, -32022, "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if !state.session_lifetime_v1 && !state.native_source_dispatch {
                // Legacy transports represent one real client. Negotiated
                // multiplexers register each actual viewer through thread/attach.
                if let Some(followups) = thread_manager.followups(&turn_params.thread_id) {
                    followups.session_activity.attach(
                        state,
                        "00000000-0000-0000-0000-000000000001",
                        "00000000-0000-0000-0000-000000000002",
                    )?;
                }
            }
            if let Err(error) = thread_manager.session_admission(&turn_params.thread_id) {
                send(outbound_tx, error_response(id, -32091, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let turn_state = thread_manager
                .turn_state(&turn_params.thread_id)
                .expect("resident runtime has turn state");
            let turn_running = Arc::clone(&turn_state.running);
            let active_turn = Arc::clone(&turn_state.active_turn);
            let question_context = Arc::clone(&turn_state.question_context);
            let approval_context = Arc::clone(&turn_state.approval_context);
            let (permission_prompt, user_questioner) =
                turn_state.interactions_for_input(outbound_tx.clone());
            let turn_registration = match preclaimed_turn_registration.take() {
                Some(registration) => turn_state.try_claim_turn().then_some(registration),
                None => turn_state.claim_turn_registration().await,
            };
            let Some(turn_registration) = turn_registration else {
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
                .is_some_and(|lease| lease.matches_target(&engine.session_lease_target()))
            {
                turn_running.store(false, Ordering::SeqCst);
                send(
                    outbound_tx,
                    error_response(id, -32024, "thread/start or thread/resume is required"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            match integrations::connectivity::task_ui::prepare_resident_input(
                state,
                thread_manager,
                &turn_params.thread_id,
            ) {
                Ok(Some(_)) => {
                    let candidate = state
                        .integration_context
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("TASK_UI_SCOPE_REQUIRED"))
                        .and_then(|native| {
                            thread_manager.restore_original_task_engine_during_registration(
                                &turn_params.thread_id,
                                native,
                                &turn_registration,
                            )
                        });
                    let candidate = match candidate {
                        Ok(candidate) => candidate,
                        Err(_) => {
                            turn_running.store(false, Ordering::SeqCst);
                            if let Some(followups) =
                                thread_manager.followups(&turn_params.thread_id)
                            {
                                followups.notify.notify_waiters();
                            }
                            send(
                                outbound_tx,
                                error_response(
                                    id,
                                    -32022,
                                    "resident turn engine replacement failed",
                                ),
                            )
                            .await?;
                            return Ok(DispatchControl::Continue);
                        }
                    };
                    *engine = candidate;
                }
                Ok(None) => {}
                Err(error) => {
                    turn_running.store(false, Ordering::SeqCst);
                    send(outbound_tx, error_response(id, -32022, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
            if engine.native_input_requires_source_admission()
                && (engine.native_host_source_lifecycle_is_current() != Some(true)
                    || !original_source_verified
                    || state
                        .native_source_accepted
                        .as_ref()
                        .is_none_or(|observer| observer.try_matches_resident(engine) != Some(true)))
            {
                turn_running.store(false, Ordering::SeqCst);
                drop(turn_registration);
                send(
                    outbound_tx,
                    error_response(id, -32022, "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let presentation = match studio_presentation::validate(
                state,
                turn_params.client_presentation.as_ref(),
                Some(engine.state.studio_work_mode()),
            ) {
                Ok(value) => value,
                Err(error) => {
                    turn_running.store(false, Ordering::SeqCst);
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
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
            let (latest_turn, retry_operation_id) = match kcoder_turn_lifecycle::admission::inspect(
                engine,
                &turn_params,
                legacy_turn_count,
            ) {
                Ok(kcoder_turn_lifecycle::admission::TurnAdmission::Start {
                    latest_turn,
                    retry_operation_id,
                }) => (latest_turn, retry_operation_id),
                Ok(kcoder_turn_lifecycle::admission::TurnAdmission::Replay(replayed)) => {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(outbound_tx, success_response(id, replayed)).await?;
                    return Ok(DispatchControl::Continue);
                }
                Err(rejection) => {
                    turn_running.store(false, Ordering::SeqCst);
                    if rejection.wake_followups {
                        background_followups.notify.notify_waiters();
                    }
                    send(
                        outbound_tx,
                        error_response(id, rejection.code, &rejection.message),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let prepared_model =
                kcoder_turn_lifecycle::admission::prepare_model(engine, &turn_params);
            if let Err(error) = prepared_model {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            {
                match integrations::agent_tasks::configure_for_turn(engine.clone(), &turn_params) {
                    Ok(configured) => {
                        if thread_manager
                            .replace_host_turn_engine_during_registration(
                                &turn_params.thread_id,
                                configured.clone(),
                                &turn_registration,
                            )
                            .is_err()
                        {
                            turn_running.store(false, Ordering::SeqCst);
                            background_followups.notify.notify_waiters();
                            send(
                                outbound_tx,
                                error_response(
                                    id,
                                    -32022,
                                    "resident turn engine replacement failed",
                                ),
                            )
                            .await?;
                            return Ok(DispatchControl::Continue);
                        }
                        *engine = configured;
                    }
                    Err(_) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(
                            outbound_tx,
                            error_response(id, -32602, "AGENT_DEFINITION_UNAVAILABLE_OR_READ_ONLY"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            }
            if !continuing {
                match engine_factory.refresh_plugin_credentials(engine).await {
                    Ok(Some(candidate)) => {
                        if thread_manager
                            .replace_host_turn_engine_during_registration(
                                &turn_params.thread_id,
                                candidate.clone(),
                                &turn_registration,
                            )
                            .is_err()
                        {
                            turn_running.store(false, Ordering::SeqCst);
                            background_followups.notify.notify_waiters();
                            send(
                                outbound_tx,
                                error_response(
                                    id,
                                    -32022,
                                    "resident turn engine replacement failed",
                                ),
                            )
                            .await?;
                            return Ok(DispatchControl::Continue);
                        }
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
            let (prompt, async_answer_message, turn_mode) =
                match kcoder_turn_lifecycle::admission::prepare_start_input(
                    engine,
                    &turn_params,
                    &params,
                    continuing,
                    async_question_admission.as_ref().map(|(claim, _)| claim),
                ) {
                    Ok(input) => input,
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
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
            let mut turn_id = turn_params
                .retry_from_turn_id
                .clone()
                .unwrap_or_else(|| format!("turn-{}", latest_turn.saturating_add(1)));
            let thread_id = engine.session_id();
            let mut task_attempt_id = if continuing {
                format!("{}-retry-{}", turn_id, uuid::Uuid::new_v4())
            } else {
                turn_id.clone()
            };
            let mut task_attempt_identity = kcoder_types::TurnAttemptIdentity {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                attempt_id: task_attempt_id.clone(),
            };
            let retained_prepared = if let Some(authority) = retained_authority {
                match retained_turn::prepare(
                    authority,
                    engine,
                    &turn_params,
                    &task_attempt_identity,
                    &prompt,
                ) {
                    Ok(retained_turn::Preparation::Fresh(prepared)) => {
                        task_attempt_identity = prepared.identity().clone();
                        turn_id = task_attempt_identity.turn_id.clone();
                        task_attempt_id = task_attempt_identity.attempt_id.clone();
                        Some(prepared)
                    }
                    Ok(retained_turn::Preparation::Receipt(receipt)) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(outbound_tx, success_response(id, receipt)).await?;
                        return Ok(DispatchControl::Continue);
                    }
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        let code = attachment_retention_dispatch::error_code(&error);
                        send(
                            outbound_tx,
                            error_response(
                                id,
                                code,
                                attachment_retention_dispatch::error_message(code),
                            ),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
            } else {
                None
            };
            if let Err(error) = kcoder_turn_lifecycle::admission::prepare_foreground(
                engine,
                &thread_id,
                &task_attempt_identity,
                continuing,
                retry_operation_id,
                turn_params.client_message_id.as_deref(),
            ) {
                use kcoder_turn_lifecycle::admission::ForegroundPreparationError;
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                let response = match error {
                    ForegroundPreparationError::Model(error)
                        if error
                            .is::<crate::model_configuration::MissingSnapshotCredentialAuthority>(
                            ) =>
                    {
                        error_response(
                            id,
                            kcoder_app_protocol::PROVIDER_AUTHENTICATION_REQUIRED,
                            "Provider credentials are required before starting this turn",
                        )
                    }
                    ForegroundPreparationError::Model(error)
                    | ForegroundPreparationError::Persistence(error) => {
                        error_response(id, -32603, &error.to_string())
                    }
                };
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
            let (prompt, model_message) = if let Some(message) = async_answer_message {
                (prompt, message)
            } else if let Some(prepared) = &retained_prepared {
                (prepared.prompt.clone(), prepared.model_message.clone())
            } else {
                let (prompt, model_message) =
                    match kcoder_turn_lifecycle::admission::materialize_foreground_input(
                        engine,
                        &thread_id,
                        &turn_id,
                        &prompt,
                        attachment_directories,
                    ) {
                        Ok(input) => input,
                        Err(error) => {
                            turn_running.store(false, Ordering::SeqCst);
                            background_followups.notify.notify_waiters();
                            send(outbound_tx, error_response(id, -32602, &error.to_string()))
                                .await?;
                            return Ok(DispatchControl::Continue);
                        }
                    };
                match state
                    .native_source_accepted
                    .as_ref()
                    .map(|observer| observer.verify_before_accept(engine, &turn_params))
                    .transpose()
                {
                    Ok(_) => {}
                    Err(_) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        tracing::warn!(
                            code = "native_source_admission_unconfirmed",
                            "Original source admission could not be verified"
                        );
                        send(
                            outbound_tx,
                            error_response(id, -32022, "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
                (prompt, model_message)
            };
            // This optional, nonblocking reservation precedes Accepted and
            // grants no authority to run a tool or continue a task.
            let pending_goal_observation = state
                .thread_goal_status_batch_v1
                .then(|| thread_manager.prepare_goal_metadata_lineage(&thread_id))
                .flatten();
            let attempt_start = kcoder_turn_lifecycle::admission::begin_foreground(
                engine,
                &task_attempt_identity,
                &turn_params,
                &model_message,
                retained_prepared.as_deref(),
                presentation.as_ref(),
                latest_turn,
                continuing,
                retry_operation_id,
            );
            if let Err(error) = &attempt_start {
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let history_append_scope = attempt_start?;
            if let Some(prepared) = &retained_prepared
                && let Err(error) = retained_turn::handoff(prepared, engine)
            {
                let status = kcoder_turn_lifecycle::retained_turn::reject_foreground_handoff(
                    engine,
                    &task_attempt_identity,
                    &error,
                );
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                send(
                    outbound_tx,
                    success_response(
                        id,
                        json!({"turn": {
                            "id": turn_id, "threadId": thread_id, "attemptId": task_attempt_id,
                            "status": status,
                        }}),
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            // Owner leases protect byte handoff only, never the Provider lifetime.
            drop(retained_prepared);
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
            if let Err(error) = send(
                    outbound_tx,
                    success_response(id, if let Some(ticket) = recovery_ticket.as_ref() {
                        rpc_codec::encode(kcoder_app_protocol::ComputerUseRecoverResult {
                            thread_id: thread_id.clone(), previous_turn_id: ticket.previous_turn_id().into(), turn_id: turn_id.clone(), status: kcoder_app_protocol::ComputerUseRecoveryStatus::Running,
                        })?
                    } else {
                        json!({"turn": {"id": turn_id, "threadId": thread_id, "attemptId": task_attempt_id, "status": "running"}})
                    }),
                )
                .await {
                // Accepted is durable, but no task has been spawned at this point.
                // A closed response queue must not strand an unexecutable attempt.
                let reason = "turn interrupted before execution: acceptance response queue closed";
                let outcome = save_turn_outcome_with_continuation(
                    engine, &thread_id, &turn_id, "interrupted", Some(reason), None, false,
                );
                let attempt = turn_attempts::finish(
                    engine, &task_attempt_identity, "interrupted", Some(reason), None,
                    &turn_attempts::PartialOutput::default(),
                );
                turn_running.store(false, Ordering::SeqCst);
                background_followups.notify.notify_waiters();
                if let Err(persist_error) = &outcome {
                    tracing::warn!(%persist_error, "unstarted turn terminal outcome is uncertain");
                }
                if let Err(persist_error) = &attempt {
                    tracing::warn!(%persist_error, "unstarted attempt terminal evidence is uncertain");
                }
                if outcome.is_ok() && attempt.is_ok()
                    && let Some(scheduler) = automation_scheduler.as_ref()
                {
                    cron_processor::reconcile_execution(engine, scheduler);
                }
                return Err(error).context("accepted turn was not started after response send failed");
            }

            let gateway_ui_input = automation_scheduler.is_none();
            let client_lifetime = if gateway_ui_input {
                input_lifetime::ClientInputLifetime::capture(state, outbound_tx)
            } else {
                None
            };
            // The session host signals this exact turn after the last attach's
            // reconnect grace. The submitting UI owns only its resources.
            let cancel = CancellationToken::new();
            *background_followups.client_lifetime.lock().unwrap() = client_lifetime;
            let isolated_authorized = presentation
                .as_ref()
                .is_some_and(|value| value.isolated_widgets);
            let mut task_engine = state
                .configure_turn_engine(engine, cancel.clone())
                .with_client_presentation(presentation)
                .with_inline_widget_tool(
                    kcoder_tools::ShowWidgetTool::new(kcoder_types::widgets::WidgetTurnBinding {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        attempt_id: task_attempt_id.clone(),
                    })
                    .with_isolated_html_authorized(isolated_authorized),
                );
            if turn_params.unattended == Some(true) {
                // Preserve the host's tool capability without advertising channel answer delivery.
                task_engine = task_engine
                    .with_async_user_questions_supported(state.async_user_questions_v1)
                    .with_unattended_input()
                    .with_channel_tool_restrictions(
                        turn_params
                            .channel_tool_restrictions
                            .clone()
                            .unwrap_or_default(),
                    );
            } else {
                task_engine = task_engine.with_async_user_questions_supported(
                    state.async_user_questions_v1
                        && turn_params.async_user_questions.unwrap_or(false),
                );
            }
            // Only this turn's Engine clone receives the actual input route.
            task_engine.set_user_questioner(user_questioner);
            let runtime_current_source = state.native_source_accepted.clone();
            // An actual private Native observer requires its source guard even when
            // a public client did not negotiate the optional source-management UI.
            let source_preparation =
                if state.integration_task_capability_scope_v1 || runtime_current_source.is_some() {
                    Some(
                        thread_manager
                            .lease(&thread_id)
                            .context("TASK_CAPABILITY_SCOPE_RESIDENT_OWNER_REQUIRED")
                            .and_then(|lease| {
                                state
                                    .integration_task_capability_scope
                                    .clone()
                                    .prepare_public_accepted(
                                        state,
                                        &task_engine,
                                        lease,
                                        engine_factory,
                                        &task_attempt_identity,
                                    )
                            }),
                    )
                } else {
                    None
                };
            let task_engine = match source_preparation.as_ref() {
                Some(Ok(prepared)) => prepared.guarded_engine(task_engine),
                _ => task_engine,
            };
            let remote_turn_context = state
                .integration_context
                .as_ref()
                .map(|native| native.recapture_for_owned_service())
                .transpose();
            let turn_memory_context = integration_requests::memory_context_for_turn(
                &task_engine,
                state.integration_context.as_ref(),
            );
            let task_tx = outbound_tx.clone();
            let task_turn_id = turn_id.clone();
            let task_thread_id = thread_id.clone();
            let task_client_message_id = turn_params.client_message_id.clone();
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
            let apps_runtime = Arc::clone(&state.mcp_apps);
            let apps_factory = engine_factory.clone();
            let apps_authorized =
                state.mcp_apps_v1 && state.isolated_widgets_v1 && isolated_authorized;
            let apps_preparation = apps_authorized
                .then(|| state.mcp_app_registry.prepare(&task_thread_id))
                .flatten();
            // Only actual appends to this exact parent State inside the owned
            // attempt acquire provenance, including tool/background injections.
            let native_remote_host_client = state.native_remote_host_client.clone();
            let active_attempt = task_attempt_identity.clone();
            let active_origin = if method == method::COMPUTER_USE_RECOVER {
                request_origin::RequestOrigin::DesktopRecovery
            } else {
                state.request_origin
            };
            // Preserve the original Studio source binding when one was prepared.
            let work_source = match source_preparation.as_ref() {
                None => Some(None),
                Some(Ok(prepared)) => prepared.initial_work_source().ok().map(Some),
                Some(Err(_)) => None,
            };
            let mut pending_followup_work = if active_origin
                == request_origin::RequestOrigin::ClientFrame
                && !continuing
                && runtime_current_source.is_none()
                && turn_mode != kcoder_app_protocol::TurnExecutionMode::MoaPlan
                && work_source.is_some()
            {
                continuous_work_admission::PendingFollowupWork::capture(
                    &task_engine,
                    thread_manager,
                    &task_attempt_identity,
                    &model_message,
                    turn_params.client_message_id.as_deref(),
                )
            } else {
                None
            };
            let mut pending_initial_work = if active_origin
                == request_origin::RequestOrigin::ClientFrame
                && !continuing
                && runtime_current_source.is_none()
                && turn_mode != kcoder_app_protocol::TurnExecutionMode::MoaPlan
                && pending_followup_work.is_none()
            {
                work_source.and_then(|source| {
                    continuous_work_admission::PendingInitialWork::capture(
                        &task_engine,
                        thread_manager,
                        &task_attempt_identity,
                        &model_message,
                        source,
                    )
                })
            } else {
                None
            };
            let (work_input_sender, work_input_receiver) = oneshot::channel();
            let mut work_input_receiver = (pending_initial_work.is_some()
                || pending_followup_work.is_some())
            .then_some(work_input_receiver);
            let handoff_attempt = task_attempt_identity.clone();
            let goal_observation_guard =
                UnusedGoalObservationGuard(if let Some(tracker) = pending_goal_observation {
                    thread_manager.install_accepted_goal_metadata_lineage(
                        &thread_id,
                        &task_attempt_identity,
                        &history_append_scope.lifecycle_identity(),
                        tracker,
                    )
                } else {
                    None
                });
            #[cfg(target_os = "linux")]
            let native_acp_receiver_binding = state.native_acp_receiver_binding.clone();
            #[cfg(target_os = "linux")]
            let native_acp_receiver_owner = state.native_acp_receiver_owner.clone();
            let task_async_question_admission = async_question_admission.take();
            // Preserve the existing turn body layout while changing its task boundary.
            #[rustfmt::skip]
            let handle = kcoder_app_events::turn_tasks::spawn_foreground(
                handoff_attempt, work_input_sender, history_append_scope, futures::FutureExt::boxed(async move {
                let _goal_observation_guard = goal_observation_guard;
                let native_admission_error = match runtime_current_source.as_ref() {
                    Some(observer) => observer.admit_current_source(&task_engine, &task_attempt_identity, &task_cancel)
                        .await.err().map(|error| format!("NATIVE_RUNTIME_CURRENT_SOURCE_UNAVAILABLE:{}",
                            integrations::connectivity::task_capability_scope_runtime::safe_source_error(&error))),
                    None => None,
                };
                let native_admission_error = if native_admission_error.is_some() {
                    native_admission_error
                } else {
                    task_engine.observe_native_turn_acceptance(&task_attempt_identity)
                        .await.err().map(|_| "NATIVE_TASK_ADMISSION_UNAVAILABLE".to_owned())
                };
                let native_admission_error = if native_admission_error.is_some() {
                    native_admission_error
                } else {
                    match source_preparation {
                        Some(Ok(prepared)) => prepared.bind(&task_engine, &task_attempt_identity, &task_cancel)
                            .await.err().map(|error| format!("TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE:{}",
                                integrations::connectivity::task_capability_scope_runtime::safe_source_error(&error))),
                        Some(Err(error)) => Some(format!("TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE:{}",
                            integrations::connectivity::task_capability_scope_runtime::safe_source_error(&error))),
                        None => None,
                    }
                };
                let remote_locator = std::env::var(integrations::core::remote_delegations::native_launch_environment_name()).ok();
                let (task_engine, _remote_receiver_owner, native_admission_error) = if native_admission_error.is_none() {
                    match integrations::core::remote_delegations::install_incoming_for_accepted_turn(
                        task_engine.clone(), &task_attempt_identity, remote_locator.as_deref(), &task_cancel,
                    ) {
                        Ok((installed, owner)) => {
                            let prepared = if let Some(owner) = owner.as_ref() {
                                owner.prepare_for_model(installed.clone(), &task_cancel).await
                            } else { Ok(installed.clone()) };
                            match prepared {
                                Ok(prepared) => (prepared, owner, None),
                                Err(_) => (installed, owner, Some("REMOTE_NATIVE_RECEIVER_ADMISSION_UNAVAILABLE".to_owned())),
                            }
                        },
                        Err(_) => (task_engine, None, Some("REMOTE_NATIVE_RECEIVER_ADMISSION_UNAVAILABLE".to_owned())),
                    }
                } else { (task_engine, None, native_admission_error) };
                let (task_engine, native_admission_error) = if native_admission_error.is_none() {
                    match remote_turn_context.and_then(|native| match native {
                        Some(native) => integrations::core::remote_delegations::install_outgoing_for_accepted_turn(
                            &native, &task_attempt_identity, task_engine.clone(), native_remote_host_client,
                        ),
                        None => Ok(task_engine.clone()),
                    }) {
                        Ok(installed) => (installed, None),
                        Err(_) => (task_engine, Some("REMOTE_NATIVE_SENDER_ADMISSION_UNAVAILABLE".to_owned())),
                    }
                } else { (task_engine, native_admission_error) };
                #[cfg(target_os = "linux")]
                let (task_engine,native_admission_error)=if native_admission_error.is_none() {
                    match native_acp_receiver_binding {
                        Some(binding)=>match integrations::core::remote_delegations::receiver_acp_binding::prepare_accepted(
                            binding,task_engine.clone(),task_attempt_identity.clone(),task_cancel.clone()).await {
                            Ok((installed,owner))=>{*native_acp_receiver_owner.lock().unwrap_or_else(|error|error.into_inner())=Some(owner);(installed,None)},
                            Err(error)=>{
                                let code=integrations::core::remote_delegations::receiver_acp_binding::admission_code(&error);
                                tracing::warn!(code=%code,"Native ACP Receiver admission unavailable");
                                (task_engine,Some(code))
                            },
                        },None=>(task_engine,None),
                    }
                }else{(task_engine,native_admission_error)};
                let (task_engine, native_admission_error) = if native_admission_error.is_none() {
                    match turn_memory_context.and_then(|native| integrations::knowledge::prepare_native_turn_memory(
                        task_engine.clone(), native, &task_attempt_identity,
                    )) {
                        Ok(prepared) => (prepared, None),
                        Err(_) => (task_engine, Some("MEMORY_TURN_CONTEXT_UNAVAILABLE".to_owned())),
                    }
                } else { (task_engine, native_admission_error) };
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
                                "status": "running",
                                "memorySnapshotId": task_engine.native_reviewed_memory_snapshot_id()
                            }}),
                        ),
                    ),
                )
                .await;
                let task_engine = if let Some(apps_preparation) = apps_preparation.filter(|_| native_admission_error.is_none()) {
                    let preparation_actor = tokio::select! {biased;_=task_cancel.cancelled()=>None,_=apps_preparation.revoked()=>{task_cancel.cancel();None},actor=apps_runtime.lock()=>Some(actor)};
                    if let Some(mut actor) = preparation_actor {
                        actor
                            .prepare_turn(
                                Arc::new(move || apps_factory.current_mcp_apps_sources()),
                                task_engine,
                                kcoder_types::widgets::WidgetTurnBinding {
                                    thread_id: task_thread_id.clone(),
                                    turn_id: task_turn_id.clone(),
                                    attempt_id: task_attempt_id.clone(),
                                },
                                &task_cancel,
                                apps_preparation,
                            )
                            .await
                    } else {
                        task_engine
                    }
                } else {
                    task_engine
                };
                #[cfg(windows)]
                let (desktop_turn, desktop_error) = if desktop_requested && native_admission_error.is_none() {
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
                let mut committed_work_input = None;
                let mut observed_followup_work = None;
                let mut pending_user_commit = None;
                let mut stream: std::pin::Pin<Box<dyn futures::Stream<Item = EngineEvent> + Send>> =
                    if let Some(error) = native_admission_error.or(desktop_error) {
                        Box::pin(futures::stream::once(
                            async move { EngineEvent::Error(error) },
                        ))
                    } else if continuing {
                        turn_execution::continue_failed(task_engine.clone(), Box::new(task_permission_prompt))
                    } else if let Some((claim, receipt_id)) = task_async_question_admission {
                        turn_execution::stream_async_question_answer(
                            task_engine.clone(),
                            claim,
                            receipt_id,
                            Box::new(task_permission_prompt),
                        )
                    } else {
                        turn_execution::stream(
                            task_engine.clone(),
                            model_message,
                            prompt,
                            Box::new(task_permission_prompt),
                            turn_mode,
                            task_cancel.clone(),
                        )
                    };
                let file_scope = worktree_artifacts::TurnFileScope {
                    workspace: &task_workspace,
                    artifact_dir: &task_artifact_dir,
                    thread_id: &task_thread_id,
                    turn_id: &task_turn_id,
                    policy: &task_snapshot_policy,
                };
                let mut before_tree = None;
                let mut snapshot_attempted = false;
                let mut file_capture: Option<TurnFileCaptureTracker> = None;
                let mut review = TurnReviewTracker::new(&task_engine, &task_attempt_identity);
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
                if kcoder_foreground_runtime::pump(kcoder_foreground_runtime::ForegroundStream {
                    task_engine: &task_engine,
                    task_tx: &task_tx,
                    task_server_id: &task_server_id,
                    task_thread_id: &task_thread_id,
                    task_turn_id: &task_turn_id,
                    task_sequence: &task_sequence,
                    task_cancel: &task_cancel,
                    task_attempt_identity: &task_attempt_identity,
                    task_turn_state: &task_turn_state,
                    task_background_projection: &task_background_projection,
                    task_projection: &task_projection,
                    followup_notify: &task_background_followups.notify,
                    client_turn_count: &task_background_followups.client_turn_count,
                    task_client_message_id: &task_client_message_id,
                    turn_mode,
                    continuing,
                    moa_plan_baseline,
                    stream: &mut stream,
                    pending_initial_work: &mut pending_initial_work,
                    pending_followup_work: &mut pending_followup_work,
                    work_input_receiver: &mut work_input_receiver,
                    pending_user_commit: &mut pending_user_commit,
                    counted_user_message: &mut counted_user_message,
                    committed_work_input: &mut committed_work_input,
                    observed_followup_work: &mut observed_followup_work,
                    snapshot_attempted: &mut snapshot_attempted,
                    file_scope: &file_scope,
                    before_tree: &mut before_tree,
                    file_capture: &mut file_capture,
                    review: &mut review,
                    status: &mut status,
                    terminal_error: &mut terminal_error,
                    provider_failure: &mut provider_failure,
                    terminal_outcome_persisted: &mut terminal_outcome_persisted,
                    attempt_partial: &mut attempt_partial,
                    live_files: &mut live_files,
                }).await.is_break() {
                    return;
                }
                drop(stream);
                // A stream that ended without a terminal event dropped its mailbox
                // with any pending steers; settle the ones this turn still owns.
                let residual: Vec<u64> = task_turn_state
                    .user_steers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .iter()
                    .filter(|(_, steer)| steer.turn_id == task_turn_id)
                    .map(|(steer_id, _)| *steer_id)
                    .collect();
                for dropped in
                    foreground_events::dropped_notifications(&task_turn_state, &residual)
                {
                    let _ = send(&task_tx, dropped).await;
                }
                if let Err(error) = task_engine.apply_pending_client_model_selection() {
                    tracing::warn!(
                        %error,
                        thread_id = %task_thread_id,
                        "queued model selection could not be applied after the turn"
                    );
                }
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
                } else if let Some(item) = pending_user_commit {
                    // The first barrier can fail before it captures its writer.
                    // This turn's terminal barrier can still confirm the input.
                    let _ = kcoder_foreground_runtime::emit_committed_user( &task_tx, &task_server_id, &task_thread_id, &task_turn_id, &task_sequence, item).await;
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
                let file_changes = file_scope.finish_capture(before_tree, &mut file_capture).await;
                let file_changes_capture = file_capture.as_mut().map(|capture| {
                    let background_uncertain = task_engine
                        .try_background_activity_counts()
                        .is_none_or(|(jobs, cancelled, prefire)| jobs > 0 || cancelled > 0 || prefire > 0);
                    capture.settle(status == "interrupted", background_uncertain)
                });
                let review_evidence = review.settle(&task_engine, status == "interrupted");
                if status != "completed" {
                    let owner = task_engine.state.inspection_lifecycle_identity();
                    match task_engine
                        .state
                        .mark_async_questions_stale_for_turn(&owner, &task_turn_id)
                    {
                        Ok(stale_questions) => {
                            for question in stale_questions {
                                async_question_requests::publish_changed(&task_tx, &question).await;
                            }
                        }
                        Err(_) => {
                            tracing::warn!(
                                code = "ASYNC_QUESTION_STALE_PERSISTENCE_UNCERTAIN",
                                "terminal source questions could not be marked stale"
                            );
                        }
                    }
                }
                drop(turn_permissions);
                task_turn_state.clear_pending();
                task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                task_projection.lock().await.turn_terminal = true;
                clear_active_background_projection(
                    &task_background_projection,
                    &task_thread_id,
                    &task_turn_id,
                )
                .await;
                let _ = task_turn_state.publish_turn_completion(
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
                                "fileChangesCapture": file_changes_capture,
                                "reviewEvidence": review_evidence,
                            }),
                        ),
                    ),
                )
                .await;
                task_background_followups.notify.notify_waiters();
            }));
            #[cfg(windows)]
            let desktop_owner =
                desktop_requested.then(|| kcoder_types::computer_use::DesktopOwner {
                    client_instance: server_id.to_owned(),
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                });
            #[cfg(not(windows))]
            let desktop_owner = None;
            *active_turn.lock().await = Some(ActiveTurn {
                desktop_owner,
                input_owner: Some(Arc::downgrade(&state.source_management_owner)),
                handle,
                cancel,
                thread_id,
                turn_id,
                attempt: Some(active_attempt),
                origin: active_origin,
            });
            drop(turn_registration);
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}

async fn shorten_wait(
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &ThreadManager,
) -> Result<DispatchControl> {
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
    Ok(DispatchControl::Continue)
}

async fn interrupt(
    id: Value,
    params: Value,
    engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    let requested_thread = params.get("threadId").and_then(Value::as_str);
    let requested_turn = params.get("turnId").and_then(Value::as_str);

    #[cfg(target_os = "linux")]
    if state
        .native_interrupts
        .is_pending(requested_thread, requested_turn)
    {
        send(
            outbound_tx,
            success_response(id, json!({"interrupted":true})),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
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
    active.cancel.cancel();
    let stale_questions = {
        let _gate = turn_state.activity_gate.lock().await;
        if let Some(source_engine) = thread_manager.engine(&interrupted_thread_id) {
            let owner = source_engine.state.inspection_lifecycle_identity();
            match source_engine
                .state
                .mark_async_questions_stale_for_task(&owner)
            {
                Ok(questions) => questions,
                Err(_) => {
                    tracing::warn!(
                        code = "ASYNC_QUESTION_STALE_PERSISTENCE_UNCERTAIN",
                        "interrupted task questions could not be marked stale"
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        }
    };
    let background_projection = thread_manager
        .projection(&interrupted_thread_id)
        .expect("matched resident turn has projection state");
    let background_followups = thread_manager
        .followups(&interrupted_thread_id)
        .expect("matched resident turn has follow-up state");
    let interrupted_engine = thread_manager.engine(&interrupted_thread_id);
    let goal_changed = turn_interrupt::pause_goal_and_cancel(
        &turn_state,
        Some(background_followups.as_ref()),
        interrupted_engine.as_ref(),
        &active.cancel,
    )
    .await;
    let activity_gate = Arc::clone(&turn_state.activity_gate);
    let response_engine = interrupted_engine.clone();
    let response = async {
        for question in stale_questions {
            async_question_requests::publish_changed(outbound_tx, &question).await;
        }
        if goal_changed && let Some(engine) = &response_engine {
            goal_lifecycle::publish_current_guarded(engine, outbound_tx, &activity_gate).await;
        }
        send(
            outbound_tx,
            success_response(id, json!({"interrupted": true})),
        )
        .await
    };
    let interruption = turn_interrupt::Interruption {
        active,
        turn_state,
        projection: background_projection,
        followups: background_followups,
        engine: interrupted_engine,
        outbound: outbound_tx.clone(),
        server_id: server_id.to_owned(),
        sequence: sequence.clone(),
    };
    #[cfg(target_os = "linux")]
    {
        // Native model guards may await private replies on this same
        // connection. Keep its dispatcher free while the owned task settles.
        let (response_enqueued, after_response) = oneshot::channel();
        state
            .native_interrupts
            .spawn_after_response(interruption, after_response)?;
        let result = response.await;
        let _ = response_enqueued.send(());
        result?;
        Ok(DispatchControl::Continue)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Cleanup proceeds even when the outbound queue is full.
        let (response, settled) = tokio::join!(response, interruption.settle());
        response?;
        settled.publish().await?;
        Ok(DispatchControl::Continue)
    }
}

#[cfg(test)]
#[path = "turn_requests_response_closed_tests.rs"]
mod response_closed_tests;

#[cfg(test)]
mod goal_observation_guard_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_before_and_after_first_poll_releases_only_the_armed_owner() {
        for started in [false, true] {
            #[cfg(unix)]
            let temp = {
                use std::os::unix::fs::PermissionsExt;
                tempfile::Builder::new()
                    .permissions(std::fs::Permissions::from_mode(0o700))
                    .tempdir()
                    .unwrap()
            };
            #[cfg(not(unix))]
            let temp = tempfile::tempdir().unwrap();
            let state = kcoder_state::AppState::new(temp.path());
            state.with_history_path(temp.path().join("owned.jsonl"));
            state.add_message(kcoder_types::Message::user_text("owned"));
            state.save_history().unwrap();
            let owner = state.inspection_lifecycle_identity();
            let tracker = state
                .try_reserve_native_goal_metadata_lineage(&owner)
                .unwrap()
                .unwrap();
            let old_observer = tracker.observer();
            let guard = UnusedGoalObservationGuard(Some(tracker.settlement()));
            let (ready, observed) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _guard = guard;
                let _ = ready.send(());
                futures::future::pending::<()>().await;
            });
            if started {
                observed.await.unwrap();
            }
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert!(tracker.is_definitively_revoked());
            drop(tracker);
            let renewed = state
                .try_reserve_native_goal_metadata_lineage(&owner)
                .unwrap()
                .unwrap();
            state.set_goal("after cancellation", None);
            assert!(
                renewed
                    .try_capture(1024 * 1024, || Ok(()))
                    .unwrap()
                    .is_some()
            );
            assert!(
                old_observer
                    .try_capture(1024 * 1024, || Ok(()))
                    .unwrap()
                    .is_none()
            );
        }
    }
}
