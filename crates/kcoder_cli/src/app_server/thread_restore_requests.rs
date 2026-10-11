//! Thread restore requests: extracted from the app-server connection boundary.

use super::*;
use kcoder_app_protocol::ThreadResumeParams;

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
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_RESUME => {
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
            let resume: ThreadResumeParams = match serde_json::from_value(params) {
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
            let result = (|| {
                let thread_id = resume.thread_id.as_str();
                validate_thread_id(thread_id)?;
                if thread_manager.owns(thread_id) {
                    Ok(PreparedThreadResume::Resident {
                        thread_id: thread_id.to_string(),
                    })
                } else {
                    let settings_template =
                        recorded_settings_template_path(workspace_engine, thread_id);
                    prepare_persisted_thread_resume(workspace_engine, thread_id).map(
                        |(prepared, lease, client_turn_count)| PreparedThreadResume::Persisted {
                            prepared: Box::new(prepared),
                            lease,
                            client_turn_count,
                            settings_template,
                        },
                    )
                }
            })();
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
                        let response = resume_history::response(
                            id,
                            engine,
                            thread_manager,
                            state,
                            thread,
                            resume.history.as_ref(),
                        )
                        .await?;
                        send(outbound_tx, response).await?;
                    }
                    PreparedThreadResume::Persisted {
                        prepared,
                        lease,
                        client_turn_count,
                        settings_template,
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
                        let mut turn_state = ResidentTurnState::new(
                            outbound_tx.clone(),
                            permission_mode,
                            Arc::clone(next_question_id),
                            Arc::clone(next_approval_id),
                            Arc::clone(connection_receipts),
                        );
                        let next_engine = match engine_factory
                            .resume_fresh_thread_with_template(
                                settings_template.clone(),
                                *prepared,
                                Arc::clone(&turn_state.user_questioner),
                            )
                            .await
                        {
                            Ok((engine, _)) => engine,
                            Err(error) => {
                                send(outbound_tx, error_response(id, -32022, &error.to_string()))
                                    .await?;
                                return Ok(DispatchControl::Continue);
                            }
                        };
                        turn_state.configure_for_engine(&next_engine);
                        next_engine.activate_client_session();
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
                        let response = resume_history::response(
                            id,
                            engine,
                            thread_manager,
                            state,
                            thread,
                            resume.history.as_ref(),
                        )
                        .await?;
                        send(outbound_tx, response).await?;
                    }
                },
                Err(error) => {
                    send(outbound_tx, error_response(id, -32022, &error.to_string())).await?
                }
            }
        }
        method::THREAD_FORK => {
            if params.get("ephemeral").and_then(Value::as_bool) == Some(true) {
                let result: Result<Value> = async {
                        let params: ThreadForkParams = serde_json::from_value(params)?;
                        anyhow::ensure!(
                            !thread_manager.is_turn_running(&params.thread_id),
                            "temporary chat requires a completed source turn; wait for the current response to finish"
                        );
                        let source = thread_manager.engine(&params.thread_id)
                            .context("source thread must be started or resumed before a temporary fork")?;
                        ensure_active_thread(&source, thread_manager.lease(&params.thread_id), &params.thread_id)?;
                        if let Some(cwd) = params.cwd.as_deref() {
                            ensure_same_workspace(&source.state.cwd(), Path::new(cwd)).await?;
                        }
                        let mut messages = if params.last_turn_id.is_empty() {
                            source.state.messages()
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
                            Arc::clone(next_question_id),
                            Arc::clone(next_approval_id),
                            Arc::clone(connection_receipts),
                        );
                        let child = engine_factory.create_ephemeral_thread(
                            &source, messages.clone(), Arc::clone(&turn_state.user_questioner),
                        )?;
                        attachments::clone_fork_attachments_between(
                            &source, &child, &params.thread_id, &child.session_id(), &mut messages,
                        )?;
                        child.state.set_messages(messages);
                        child.state.save_history()?;
                        let lease = SessionLease::acquire(&child.session_lease_target())?;
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
            let result = match serde_json::from_value::<ThreadForkParams>(params) {
                Ok(params) => {
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
                                let thread = serde_json::from_value(persisted_thread_value(
                                    &target_engine,
                                    &fork_id,
                                    &fork_path,
                                    false,
                                )?)?;
                                Ok(ThreadForkResult {
                                    thread,
                                    ephemeral: false,
                                })
                            })
                        })
                    }
                }
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
