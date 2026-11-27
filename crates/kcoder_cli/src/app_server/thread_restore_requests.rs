//! Thread restore requests: extracted from the app-server connection boundary.

use super::*;
use kcoder_app_protocol::ThreadResumeParams;

pub(super) fn prepare_cold_resume(
    workspace_engine: &QueryEngine,
    thread_id: &str,
) -> Result<PreparedThreadResume> {
    let (mut prepared, lease, client_turn_count) =
        prepare_persisted_thread_resume(workspace_engine, thread_id)?;
    let settings_template = recorded_settings_template_path(workspace_engine, thread_id)?;
    let permission_mode_at_creation =
        recorded_thread_permission_mode_at_creation(workspace_engine, thread_id)?;
    prepared.prepare_background_delivery()?;
    Ok(PreparedThreadResume::Persisted {
        prepared: Box::new(prepared),
        lease,
        client_turn_count,
        settings_template,
        permission_mode_at_creation,
    })
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
    workspace_engine: &QueryEngine,
    engine_factory: &AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
    outbound_tx: &mpsc::Sender<Value>,
    next_interaction_id: &Arc<AtomicU64>,
    connection_receipts: &Arc<StdMutex<InteractionReceipts>>,
    thread_manager: &mut ThreadManager,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_RESUME => {
            let native_initializer = state.native_runtime_thread_initializer.clone();
            if let Some(initializer) = &native_initializer
                && (!state.native_source_dispatch
                    || initializer.verify_restore_request(&id, &params).is_err())
            {
                send(
                    outbound_tx,
                    error_response(id, -32022, "RUNTIME_PRIVATE_THREAD_REQUEST_CHANGED"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if params.get("settingsTemplate").is_some() {
                send(
                        outbound_tx,
                        error_response(
                            id,
                            -32602,
                            "cannot change the settings template of an existing thread; start a new thread instead",
                        ),
                    )
                    .await?;
                return Ok(DispatchControl::Continue);
            }
            let resume: ThreadResumeParams = match serde_json::from_value(params.clone()) {
                Ok(params) => params,
                Err(_) => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, "invalid thread/resume params"),
                    )
                    .await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if resume
                .history
                .as_ref()
                .is_some_and(|options| !options.is_valid())
            {
                send(
                    outbound_tx,
                    error_response(id, -32602, "thread/resume history limit must be 1..100"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let thread_id = resume.thread_id.as_str();
            let ready = state.ready_thread_resume.take();
            let verified = validate_thread_id(thread_id).and_then(|()| match &ready {
                Some(ready) => ready.verify(&id, &params, state),
                None => Ok(()),
            });
            let result = match verified {
                Err(error) => Err(error),
                Ok(()) if thread_manager.owns(thread_id) => {
                    if native_initializer.is_some() {
                        Err(anyhow::anyhow!("RUNTIME_PRIVATE_RESTORE_ALREADY_RESIDENT"))
                    } else {
                        Ok(PreparedThreadResume::Resident {
                            thread_id: thread_id.to_owned(),
                        })
                    }
                }
                Ok(()) => match (ready, state.thread_resume_input.take()) {
                    (Some(ready), _) => ready.into_prepared(),
                    (None, Some(input)) => {
                        let started = thread_manager
                            .reserve_resume_preparation(thread_id)
                            .is_some_and(|(owner, cold_preparation)| {
                                state.deferred_thread_resumes.start(
                                    input,
                                    &id,
                                    &params,
                                    thread_id,
                                    workspace_engine,
                                    &state.source_management_owner,
                                    &state.input_ended,
                                    owner,
                                    cold_preparation,
                                )
                            });
                        if !started {
                            send(
                                outbound_tx,
                                error_response(
                                    id,
                                    -32044,
                                    "Thread resume preparation is busy; retry later",
                                ),
                            )
                            .await?;
                        }
                        return Ok(DispatchControl::Continue);
                    }
                    (None, None) => prepare_cold_resume(workspace_engine, thread_id),
                },
            };
            match result {
                Ok(prepared_resume) => match prepared_resume {
                    PreparedThreadResume::Resident { thread_id } => {
                        *engine = thread_manager
                            .select(&thread_id)
                            .expect("resident runtime disappeared");
                        let mut thread =
                            thread_snapshot(engine, thread_manager.is_turn_running(&thread_id));
                        let followups = thread_manager
                            .followups(&thread_id)
                            .expect("resident runtime disappeared");
                        if followups.client_turn_count.get().is_none() {
                            let turn_state = thread_manager
                                .turn_state(&thread_id)
                                .expect("resident runtime disappeared");
                            let _activity = turn_state.activity_gate.lock().await;
                            match reconstruct_client_turn_count(engine) {
                                Ok(count) => {
                                    followups.client_turn_count.reset(count);
                                    followups.notify.notify_waiters();
                                }
                                Err(error) => {
                                    send(
                                        outbound_tx,
                                        error_response(id, -32022, &error.to_string()),
                                    )
                                    .await?;
                                    return Ok(DispatchControl::Continue);
                                }
                            }
                        }
                        ThreadRunProjection::for_thread(
                            thread_manager,
                            state.run_summary_v1,
                            &thread_id,
                        )
                        .apply(&mut thread);
                        let mut response = resume_history::response(
                            id,
                            engine,
                            thread_manager,
                            state,
                            thread,
                            resume.history.as_ref(),
                        )
                        .await?;
                        thread_stream_context::attach(
                            &mut response,
                            state,
                            thread_manager,
                            &thread_id,
                            server_id,
                            sequence,
                        )
                        .await;
                        send(outbound_tx, response).await?;
                    }
                    PreparedThreadResume::Persisted {
                        prepared,
                        mut lease,
                        client_turn_count,
                        settings_template,
                        permission_mode_at_creation,
                    } => {
                        let reserved = match thread_manager.reserve_capacity() {
                            Ok(reserved) => reserved,
                            Err(()) => {
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
                        };
                        if let Some(evicted) = reserved {
                            evicted.shutdown().await;
                        }
                        let restored_history = match native_initializer
                            .as_ref()
                            .map(|initializer| {
                                initializer.prepare_restored_history(
                                    &prepared,
                                    &workspace_engine.session_storage_dir_for(&resume.thread_id),
                                )
                            })
                            .transpose()
                        {
                            Ok(history) => history,
                            Err(_) => {
                                send(
                                    outbound_tx,
                                    error_response(
                                        id,
                                        -32022,
                                        "RUNTIME_RESTORED_HISTORY_UNCONFIRMED",
                                    ),
                                )
                                .await?;
                                return Ok(DispatchControl::Continue);
                            }
                        };
                        let native_factory = match native_initializer
                            .as_ref()
                            .map(|initializer| initializer.factory())
                            .transpose()
                        {
                            Ok(factory) => factory,
                            Err(_) => {
                                send(
                                    outbound_tx,
                                    error_response(
                                        id,
                                        -32022,
                                        "RUNTIME_PRE_START_POLICY_UNAVAILABLE",
                                    ),
                                )
                                .await?;
                                return Ok(DispatchControl::Continue);
                            }
                        };
                        let mut turn_state = ResidentTurnState::new(
                            outbound_tx.clone(),
                            permission_mode,
                            Arc::clone(next_interaction_id),
                            Arc::clone(connection_receipts),
                        )
                        .with_approval_tool_identity(state.approval_tool_call_identity_v1);
                        let selected_factory = native_factory.as_ref().unwrap_or(engine_factory);
                        let (next_engine, scheduler_lifecycle) = match selected_factory
                            .resume_fresh_thread_with_template_and_lifecycle(
                                settings_template.clone(),
                                permission_mode_at_creation,
                                *prepared,
                                Arc::clone(&turn_state.user_questioner),
                            )
                            .await
                        {
                            Ok((engine, _, lifecycle)) => (engine, lifecycle),
                            Err(error) => {
                                send(outbound_tx, error_response(id, -32022, &error.to_string()))
                                    .await?;
                                return Ok(DispatchControl::Continue);
                            }
                        };
                        let next_engine =
                            next_engine.with_client_questions_supported(state.client_questions);
                        if !lease.matches_target(&next_engine.session_lease_target()) {
                            anyhow::bail!("restored thread lease identity changed");
                        }
                        let next_engine = match native_initializer.as_ref() {
                            Some(initializer) => {
                                let installed = restored_history
                                    .as_ref()
                                    .context("RUNTIME_RESTORED_HISTORY_UNCONFIRMED")
                                    .and_then(|history| {
                                        initializer.install_restored(next_engine, history)
                                    });
                                match installed {
                                    Ok(engine) => engine,
                                    Err(_) => {
                                        send(
                                            outbound_tx,
                                            error_response(
                                                id,
                                                -32022,
                                                "RUNTIME_RESTORED_HISTORY_UNCONFIRMED",
                                            ),
                                        )
                                        .await?;
                                        return Ok(DispatchControl::Continue);
                                    }
                                }
                            }
                            None => next_engine,
                        };
                        let next_engine = if state.native_source_dispatch {
                            match next_engine.with_required_native_host_source_admission() {
                                Ok(engine) => engine,
                                Err(_) => {
                                    send(
                                        outbound_tx,
                                        error_response(
                                            id,
                                            -32022,
                                            "Original source owner is unavailable",
                                        ),
                                    )
                                    .await?;
                                    return Ok(DispatchControl::Continue);
                                }
                            }
                        } else {
                            next_engine
                        };
                        if !lease.matches_target(&next_engine.session_lease_target()) {
                            anyhow::bail!("restored thread lease identity changed");
                        }
                        lease.bind_scheduler_lifecycle(scheduler_lifecycle);
                        // No resident runtime/background task exists yet, and
                        // this exact SessionLease excludes a competing owner.
                        let exited_turns =
                            retained_turn::recover_unstarted_on_resume(&next_engine)?;
                        turn_state.configure_for_engine(&next_engine);
                        next_engine.activate_client_session();
                        retained_turn::append_recovery_notice(&next_engine, &exited_turns).await?;
                        *engine = next_engine;
                        let runtime = build_resident_thread_runtime(
                            engine.clone(),
                            lease,
                            client_turn_count,
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
                        let _ = engine.run_startup_hooks().await;
                        let mut thread = thread_snapshot(engine, false);
                        ThreadRunProjection::for_thread(
                            thread_manager,
                            state.run_summary_v1,
                            &engine.session_id(),
                        )
                        .apply(&mut thread);
                        let mut response = resume_history::response(
                            id,
                            engine,
                            thread_manager,
                            state,
                            thread,
                            resume.history.as_ref(),
                        )
                        .await?;
                        thread_stream_context::attach(
                            &mut response,
                            state,
                            thread_manager,
                            &engine.session_id(),
                            server_id,
                            sequence,
                        )
                        .await;
                        send(outbound_tx, response).await?;
                    }
                },
                Err(error) => {
                    let mut response = error_response(id, -32022, &error.to_string());
                    if error.downcast_ref::<kcoder_cli_storage::session_lease::SessionLeaseOwnedElsewhere>().is_some()
                        && let Some(data) = kcoder_app_protocol::thread_ownership::ThreadOwnershipErrorDataV1::owned_elsewhere(&resume.thread_id)
                    {
                        response["error"]["data"] = serde_json::to_value(data)?;
                    }
                    send(outbound_tx, response).await?
                }
            }
        }
        method::THREAD_FORK => {
            if params.get("ephemeral").and_then(Value::as_bool) == Some(true) {
                let result: Result<Value> = async {
                        let params: ThreadForkParams = serde_json::from_value(params)?;
                        anyhow::ensure!(params.client_request_id.is_none(),
                            "creation receipts are only supported for durable forks");
                        anyhow::ensure!(
                            !thread_manager.is_turn_running(&params.thread_id),
                            "temporary chat requires a completed source turn; wait for the current response to finish"
                        );
                        let source = thread_manager.engine(&params.thread_id)
                            .context("source thread must be started or resumed before a temporary fork")?;
                        ensure_active_thread(&source, thread_manager.lease(&params.thread_id), &params.thread_id)?;
                        anyhow::ensure!(
                            !source.native_input_requires_source_admission(),
                            "This thread belongs to a restricted source. Continue from the original source or start a new thread."
                        );
                        if let Some(cwd) = params.cwd.as_deref() {
                            ensure_same_workspace(&source.state.cwd(), Path::new(cwd)).await?;
                        }
                        let source_messages = source.state.shared_messages_with_revision().0;
                        let context_history_anchor = params.last_turn_id.is_empty()
                            .then(|| source.state.context_history_anchor(&source_messages)).flatten();
                        let mut messages = if params.last_turn_id.is_empty() {
                            source_messages.to_vec()
                        } else {
                            let path = thread_history_path(&source, &params.thread_id)?;
                            turn_admissions::fork_transcript(
                                &kcoder_state::load_transcript_history(&path)?,
                                &turn_admissions::bindings(&source, &params.thread_id)?,
                                &params.last_turn_id,
                            )?
                        };
                        anyhow::ensure!(!messages.is_empty(), "source thread has no completed context to fork");
                        let mut turn_state = ResidentTurnState::new(
                            outbound_tx.clone(), permission_mode,
                            Arc::clone(next_interaction_id),
                            Arc::clone(connection_receipts),
                        ).with_approval_tool_identity(state.approval_tool_call_identity_v1);
                        let (child, scheduler_lifecycle) = engine_factory.create_ephemeral_thread_with_lifecycle(
                            &source, messages.clone(), Arc::clone(&turn_state.user_questioner),
                        )?;
                        let child=child.with_client_questions_supported(state.client_questions);
                        if let Some(anchor) = context_history_anchor {
                            source.state.flush_history().await?;
                            let copy_source = source.clone();
                            let copy_child = child.clone();
                            let cancel = source.cancel_token().child_token();
                            let _copy_scope = cancel.clone().drop_guard();
                            tokio::task::spawn_blocking(move || {
                                copy_child.state.inherit_compacted_history_from(&copy_source.state, &anchor, || cancel.is_cancelled())
                            }).await.context("compression inheritance worker stopped")??;
                        }
                        attachments::clone_fork_attachments_between(
                            &source, &child, &params.thread_id, &child.session_id(), &mut messages,
                        )?;
                        child.state.set_messages_preserving_history_ids(messages);
                        child.state.save_history()?;
                        let mut lease = SessionLease::acquire(&child.session_lease_target())?;
                        lease.bind_scheduler_lifecycle(scheduler_lifecycle);
                        turn_state.configure_for_engine(&child);
                        child.activate_client_session();
                        let snapshot = thread_snapshot(&child, false);
                        let runtime = build_resident_thread_runtime(
                            child.clone(), lease, child.client_turn_count(), turn_state,
                            outbound_tx.clone(), server_id.to_owned(), Arc::clone(sequence),
                        ).with_ephemeral();
                        match thread_manager.insert(runtime) {
                            Ok(Some(evicted)) => evicted.shutdown().await,
                            Ok(None) => {},
                            Err(rejected) => {
                                (*rejected).shutdown().await;
                                anyhow::bail!("resident thread capacity is full; close another temporary chat first");
                            }
                        }
                        Ok(json!({"thread":snapshot,"ephemeral":true}))
                    }.await;
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32036, &error.to_string()),
                };
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
            let result = match kcoder_app_rpc_codec::decode::<ThreadForkParams>(params) {
                Ok(params) => (|| {
                    if let Some(result) = thread_creations::replay_fork(workspace_engine, &params)?
                    {
                        return serde_json::from_value(result)
                            .context("invalid original fork receipt");
                    }
                    if thread_manager.is_ephemeral(&params.thread_id) {
                        Err(anyhow::anyhow!(
                            "temporary threads cannot be forked into durable conversations"
                        ))
                    } else if thread_manager.is_turn_running(&params.thread_id) {
                        Err(anyhow::anyhow!("cannot fork an incomplete turn"))
                    } else {
                        let target_engine = thread_manager
                            .select(&params.thread_id)
                            .context("thread/start or thread/resume is required");
                        target_engine.and_then(|target_engine| {
                            ensure_active_thread(
                                &target_engine,
                                thread_manager.lease(&params.thread_id),
                                &params.thread_id,
                            )
                            .and_then(|_| {
                                anyhow::ensure!(
                                    !target_engine.native_input_requires_source_admission(),
                                    "This thread belongs to a restricted source. Continue from the original source or start a new thread."
                                );
                                if let Some(cwd) = params.cwd.as_deref() {
                                    let expected =
                                        std::fs::canonicalize(target_engine.state.cwd())?;
                                    let requested = std::fs::canonicalize(cwd)?;
                                    if requested != expected {
                                        anyhow::bail!(
                                            "fork cwd does not match the active workspace"
                                        )
                                    }
                                }
                                let fork_template = checked_recorded_settings_template_binding(
                                    &target_engine,
                                    &params.thread_id,
                                )?;
                                if let Some(binding) = &fork_template {
                                    config_templates::user_template_store()?
                                        .recorded_session_path(binding)?;
                                }
                                let source_history =
                                    thread_history_path(&target_engine, &params.thread_id)?;
                                let transcript =
                                    kcoder_state::load_transcript_history(&source_history)?;
                                let mut messages = turn_admissions::fork_transcript(
                                    &transcript,
                                    &turn_admissions::bindings(&target_engine, &params.thread_id)?,
                                    &params.last_turn_id,
                                )?;
                                let history_dir = source_history
                                    .parent()
                                    .context("session history path has no parent")?;
                                let fork_state =
                                    kcoder_state::AppState::new(target_engine.state.cwd());
                                let fork_id = fork_state.session_id();
                                if !thread_creations::reserve_fork(workspace_engine, &params, &fork_id)? {
                                    return serde_json::from_value(thread_creations::replay_fork(workspace_engine, &params)?
                                        .context("fork reservation disappeared")?).context("invalid original fork receipt");
                                }
                                let fork_path =
                                    candidate_thread_history_path(history_dir, &fork_id)?;
                                fork_state.with_history_path(&fork_path);
                                if let Err(error) = clone_fork_attachments(
                                    &target_engine,
                                    &params.thread_id,
                                    &fork_id,
                                    &mut messages,
                                ) {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    return Err(error);
                                }
                                if let Err(error) = fork_state
                                    .enter_session_mode_before_first_message(
                                        target_engine.state.session_mode(),
                                    )
                                {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    let _ = kcoder_state::delete_session_history_files(&fork_path);
                                    return Err(error);
                                }
                                if let Some(definition_id) =
                                    target_engine.state.workflow_definition_id()
                                {
                                    fork_state.bind_workflow_definition_before_first_message(
                                        &definition_id,
                                    )?;
                                }
                                fork_state.set_studio_work_mode_before_first_message(
                                    target_engine.state.studio_work_mode(),
                                )?;
                                if let Err(error) = target_engine
                                    .capture_imported_context_snapshot()
                                    .and_then(|()| {
                                        fork_state
                                            .inherit_task_configuration_before_first_message(
                                                &target_engine.state,
                                            )?;
                                        fork_state
                                            .inherit_imported_context_snapshot(&target_engine.state)
                                    })
                                {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    let _ = kcoder_state::delete_session_history_files(&fork_path);
                                    return Err(error);
                                }
                                fork_state.set_messages(messages);
                                if let Err(error) = fork_state.save_history() {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    let _ = kcoder_state::delete_session_history_files(&fork_path);
                                    return Err(error);
                                }
                                if let Err(error) = clone_turn_client_message_ids(
                                    &target_engine,
                                    &params.thread_id,
                                    &fork_id,
                                ) {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    let _ = kcoder_state::delete_session_history_files(&fork_path);
                                    return Err(error);
                                }
                                // Fork admission rejects running turns, so this is the stable session baseline.
                                let fork_permission_mode =
                                    fork_permission_mode_at_creation(&target_engine)?;
                                let recorded = record_thread_creation_configuration(
                                    &target_engine,
                                    &fork_id,
                                    fork_permission_mode,
                                    fork_template.as_ref(),
                                );
                                if let Err(error) = recorded {
                                    let _ = std::fs::remove_dir_all(
                                        target_engine.session_storage_dir_for(&fork_id),
                                    );
                                    let _ = kcoder_state::delete_session_history_files(&fork_path);
                                    return Err(error);
                                }
                                let thread: kcoder_app_protocol::Thread = serde_json::from_value(persisted_thread_value(
                                    &target_engine,
                                    &fork_id,
                                    &fork_path,
                                    false,
                                )?)?;
                                if let Some(request_id) = params.client_request_id.as_deref() {
                                    thread_creations::complete(workspace_engine, request_id, serde_json::to_value(&thread)?)?;
                                }
                                Ok(ThreadForkResult {
                                    thread,
                                    ephemeral: false,
                                })
                            })
                        })
                    }
                })(),
                Err(error) => Err(error).context("invalid thread/fork params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32036, &error.to_string())).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}

/// A fork inherits the source conversation's current effective permission mode.
pub(super) fn fork_permission_mode_at_creation(
    engine: &QueryEngine,
) -> Result<kcoder_config::PermissionMode> {
    Ok(engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("source thread settings are unavailable"))?
        .permission_mode)
}
