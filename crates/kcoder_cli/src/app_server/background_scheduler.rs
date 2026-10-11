//! Background scheduler: extracted from the app-server connection boundary.

use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_background_followup_turn(
    engine: QueryEngine,
    summary: String,
    followup_runs: Vec<kcoder_types::BackgroundRunKey>,
    goal_turn: goal_lifecycle::GoalTurn,
    outbound_tx: mpsc::Sender<Value>,
    running: Arc<AtomicBool>,
    thread_id: String,
    turn_id: String,
    server_id: String,
    sequence: Arc<AtomicU64>,
    projection: Arc<Mutex<StreamProjection>>,
    background_projection: Arc<Mutex<BackgroundProjectionState>>,
    followups: Arc<BackgroundFollowupState>,
    question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pending_questions: PendingQuestionResponses,
    approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pending_approvals: PendingApprovalResponses,
    permission_prompt: AppServerPermissionPrompt,
    cancel: CancellationToken,
) {
    let is_goal_continuation = summary.starts_with("[system] Continue working toward the active");
    if is_goal_continuation {
        goal_lifecycle::publish_continuation(
            &engine,
            &outbound_tx,
            "started",
            Some(&turn_id),
            None,
        )
        .await;
    }
    let turn_permissions =
        turn_permissions::TurnPermissions::new(engine.clone(), goal_turn.permission_mode);
    let _ = send(
        &outbound_tx,
        notification(
            "turn/started",
            with_event_context(
                &server_id,
                &thread_id,
                Some(&turn_id),
                &sequence,
                json!({"turn": {
                    "id": turn_id,
                    "threadId": thread_id,
                    "status": "running",
                    "internal": true,
                }}),
            ),
        ),
    )
    .await;

    let (hook_events, stop_followup) = if is_goal_continuation {
        (Vec::new(), false)
    } else {
        engine
            .run_teammate_idle_hooks(
                "subagent_followup",
                json!({
                    "reason": "subagent_followup",
                    "summary": summary,
                    "cwd": engine.state.cwd(),
                }),
            )
            .await
    };
    let mut status = "completed";
    let mut terminal_error = None;
    let mut provider_failure = None;
    for event in hook_events {
        let messages = if background_event_id(&event).is_some() {
            if project_managed_background_event(
                &engine,
                &background_projection,
                &outbound_tx,
                event,
            )
            .await
            .is_err()
            {
                cancel.cancel();
            }
            Vec::new()
        } else {
            projection.lock().await.project(event)
        };
        for message in messages {
            if send(&outbound_tx, message).await.is_err() {
                cancel.cancel();
                break;
            }
        }
    }

    if !stop_followup && !cancel.is_cancelled() {
        let nudge = if summary.starts_with("[system] Orchestrate durable plan continuation.")
            || summary.starts_with("[scheduled task ")
            || is_goal_continuation
        {
            summary.clone()
        } else {
            background_followup_nudge(&summary)
        };
        let committed = if followup_runs.is_empty() {
            append_background_followup_message(
                &engine,
                &followups,
                nudge,
                if summary.starts_with("[scheduled task ") {
                    kcoder_types::MessageOrigin::User
                } else {
                    kcoder_types::MessageOrigin::Runtime
                },
            )
        } else {
            match engine
                .state
                .commit_message_with_uuid(kcoder_types::Message::runtime_text(nudge), &turn_id)
                .await
            {
                Ok(()) => engine
                    .state
                    .mark_background_followup_started(&followup_runs, &turn_id)
                    .and_then(|started| {
                        anyhow::ensure!(started, "background followup start rejected");
                        Ok(())
                    }),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = committed {
            status = "failed";
            terminal_error = Some(error.to_string());
        } else {
            let mut stream = engine.run_turn_stream(&permission_prompt);
            while let Some(event) = stream.next().await {
                let event = normalize_cancelled_terminal_event(event, cancel.is_cancelled());
                if let Some((next_status, error)) = terminal_outcome(&event, cancel.is_cancelled())
                {
                    status = next_status;
                    terminal_error = Some(error);
                    provider_failure = match &event {
                        EngineEvent::ProviderFailed { details, .. } => Some(details.clone()),
                        _ => None,
                    };
                    if let Err(error) = save_turn_outcome(
                        &engine,
                        &thread_id,
                        &turn_id,
                        status,
                        terminal_error.as_deref(),
                        provider_failure.as_ref(),
                    ) {
                        tracing::warn!(%error, "failed to persist background terminal outcome");
                    }
                }
                if let EngineEvent::ToolUseStarted { id, name, .. } = &event
                    && tool_can_spawn_managed_background_job(name)
                {
                    register_background_tool_call(
                        &background_projection,
                        id,
                        &thread_id,
                        &turn_id,
                        Arc::clone(&projection),
                    )
                    .await;
                }
                let messages = if background_event_id(&event).is_some() {
                    if project_managed_background_event(
                        &engine,
                        &background_projection,
                        &outbound_tx,
                        event,
                    )
                    .await
                    .is_err()
                    {
                        cancel.cancel();
                    }
                    Vec::new()
                } else {
                    projection.lock().await.project(event)
                };
                for message in messages {
                    if send(&outbound_tx, message).await.is_err() {
                        cancel.cancel();
                        break;
                    }
                }
                if status != "completed" || cancel.is_cancelled() {
                    break;
                }
            }
        }
    }
    if cancel.is_cancelled() {
        status = "interrupted";
        terminal_error = Some("cancelled by user".into());
        provider_failure = None;
        if let Err(error) = save_turn_outcome(
            &engine,
            &thread_id,
            &turn_id,
            status,
            terminal_error.as_deref(),
            None,
        ) {
            tracing::warn!(%error, "failed to persist cancelled background outcome");
        }
    }
    if status == "completed"
        && !followup_runs.is_empty()
        && let Err(error) = engine.state.flush_history().await.and_then(|()| {
            engine
                .state
                .finish_background_followup(&followup_runs, &turn_id)
        })
    {
        tracing::warn!(%error, %turn_id, "background followup completion receipt remains uncertain");
    }
    let publish_goal = goal_turn.tracks_goal() || engine.state.goal().is_some();
    followups.goals.lock().unwrap().finish(
        &engine,
        goal_turn,
        if stop_followup { "failed" } else { status },
        provider_failure.as_ref(),
    );
    drop(turn_permissions);
    if publish_goal {
        goal_lifecycle::publish(&engine, &outbound_tx).await;
    }
    if is_goal_continuation {
        goal_lifecycle::publish_continuation(
            &engine,
            &outbound_tx,
            "settled",
            Some(&turn_id),
            None,
        )
        .await;
    }
    if let Err(error) = engine.record_orchestrate_continuation_outcome(status != "completed") {
        tracing::warn!(%error, turn_id = %turn_id, "failed to persist Orchestrate continuation outcome");
        if terminal_error.is_none() {
            terminal_error = Some(error.to_string());
            status = "failed";
        }
    }
    if let Err(error) = engine.state.flush_history().await {
        tracing::warn!(%error, turn_id = %turn_id, "failed to flush automatic subagent follow-up transcript");
    }
    pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    {
        let mut context = question_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if context
            .as_ref()
            .is_some_and(|context| context.thread_id == thread_id && context.turn_id == turn_id)
        {
            *context = None;
        }
    }
    {
        let mut context = approval_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if context
            .as_ref()
            .is_some_and(|context| context.thread_id == thread_id && context.turn_id == turn_id)
        {
            *context = None;
        }
    }
    let _ = send(
        &outbound_tx,
        notification(
            "turn/completed",
            with_event_context(
                &server_id,
                &thread_id,
                Some(&turn_id),
                &sequence,
                json!({
                    "turn": {
                        "id": turn_id,
                        "threadId": thread_id,
                        "status": status,
                        "internal": true,
                    },
                    "error": turn_completion_error(terminal_error, provider_failure),
                    "fileChanges": Value::Null,
                }),
            ),
        ),
    )
    .await;
    clear_active_background_projection(&background_projection, &thread_id, &turn_id).await;
    running.store(false, Ordering::SeqCst);
    followups.notify.notify_waiters();
}

pub(super) fn append_background_followup_message(
    engine: &QueryEngine,
    followups: &BackgroundFollowupState,
    text: String,
    origin: kcoder_types::MessageOrigin,
) -> Result<()> {
    let message = kcoder_types::Message::user_text(text).with_origin(origin);
    if kcoder_engine::agent::is_real_user_message(&message) {
        followups.client_turn_count.increment()?;
    }
    engine.state.add_message(message);
    Ok(())
}

pub(super) fn reconstruct_client_turn_count(engine: &QueryEngine) -> Result<usize> {
    match engine.state.history_path() {
        Some(path) => kcoder_state::load_transcript_history(&path)
            .map(|entries| client_transcript_turn_count(&entries))
            .context("failed to reconstruct resident turn count"),
        None => Ok(engine.client_turn_count()),
    }
}

pub(super) fn explicit_turn_appended_user_message(
    engine: &QueryEngine,
    event: &EngineEvent,
    moa_plan_baseline: Option<usize>,
) -> bool {
    if let Some(baseline) = moa_plan_baseline {
        // MoA planning appends directly and does not compact the parent conversation.
        // Its first progress/error/result event follows the append, if one occurred.
        return engine.client_turn_count() > baseline;
    }
    matches!(event, EngineEvent::UserMessageAdded)
        && engine
            .state
            .last_message()
            .as_ref()
            .is_some_and(kcoder_engine::agent::is_real_user_message)
}

pub(super) fn update_client_turn_count_after_rewind(
    engine: &QueryEngine,
    followups: &BackgroundFollowupState,
    conversation: Option<kcoder_state::ConversationRewindOutcome>,
) -> Result<()> {
    let Some(conversation) = conversation else {
        return Ok(());
    };
    // A file-only rewind or a missing durable anchor cannot lower the transcript watermark.
    if engine.state.history_path().is_some() && !conversation.boundary_recorded {
        return Ok(());
    }
    followups.client_turn_count.invalidate();
    let count = reconstruct_client_turn_count(engine)?;
    followups.client_turn_count.reset(count);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_background_followup_scheduler(
    engine: QueryEngine,
    followups: Arc<BackgroundFollowupState>,
    activity_gate: Arc<Mutex<()>>,
    accepting_turns: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    active_turn: Arc<Mutex<Option<ActiveTurn>>>,
    background_projection: Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: mpsc::Sender<Value>,
    server_id: String,
    sequence: Arc<AtomicU64>,
    next_turn_id: Arc<AtomicU64>,
    question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pending_questions: PendingQuestionResponses,
    approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pending_approvals: PendingApprovalResponses,
    permission_prompt: AppServerPermissionPrompt,
    cancel: CancellationToken,
) {
    loop {
        let notified = followups.notify.notified();
        let mut spawned = false;
        {
            // Share the latch with explicit turn/start and thread switching so only one claimant can acquire idle state.
            let _gate = tokio::select! {
                _ = cancel.cancelled() => break,
                gate = activity_gate.lock() => gate,
            };
            let has_pending_followup = !followups.queue.lock().await.pending.is_empty();
            let has_goal_work = followups.goals.lock().unwrap().ready(&engine);
            let orchestrate_store =
                kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
            let has_orchestrate_work = engine.state.session_mode().is_orchestrate()
                && orchestrate_store.read_active_work().is_ok_and(|snapshot| {
                    let cooldown = engine
                        .settings
                        .read()
                        .unwrap()
                        .orchestrate
                        .continuation
                        .cooldown_seconds;
                    let continuation = orchestrate_store
                        .read_continuation_state(&snapshot.work.work_id)
                        .unwrap_or_default();
                    snapshot.work.progress.completed < snapshot.work.progress.total
                        && !continuation.manual_intervention_required
                        && chrono::Utc::now()
                            .signed_duration_since(
                                continuation
                                    .last_claimed_at
                                    .unwrap_or(snapshot.work.updated_at),
                            )
                            .num_seconds()
                            >= cooldown as i64
                });
            if accepting_turns.load(Ordering::SeqCst)
                && !running.load(Ordering::SeqCst)
                && followups.client_turn_count.get().is_some()
                && !followups.goals.lock().unwrap().is_suspended()
                && !has_running_background_followups(&engine)
                && (has_pending_followup || has_orchestrate_work || has_goal_work)
                && running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                if !accepting_turns.load(Ordering::SeqCst) {
                    running.store(false, Ordering::SeqCst);
                    continue;
                }
                let allowed = followups.goals.lock().unwrap().automatic_allowed(&engine);
                if !allowed {
                    let notice = followups.goals.lock().unwrap().take_limit_notice(&engine);
                    if let Some(notice) = notice {
                        goal_lifecycle::publish_continuation(
                            &engine,
                            &outbound_tx,
                            "settled",
                            None,
                            Some(notice.clone()),
                        )
                        .await;
                        let mut projection = StreamProjection::new(
                            server_id.clone(),
                            engine.session_id(),
                            "goal-status".into(),
                            Arc::clone(&sequence),
                        );
                        for event in projection.project(EngineEvent::SystemNotice(notice)) {
                            let _ = send(&outbound_tx, event).await;
                        }
                    }
                    running.store(false, Ordering::SeqCst);
                    // Wait for a real state change, not a busy loop at the limit.
                } else {
                    // `take_ready_background_followup` drops queued entries whose
                    // agent was closed, so the queue can be empty even though
                    // `has_pending_followup` was true when it was computed. Fall
                    // through to the orchestrate/goal continuations instead of
                    // panicking on the now-empty queue.
                    let pending_summary = if has_pending_followup {
                        take_ready_background_followup_batch(
                            &followups,
                            false,
                            Some(&engine),
                            |id| followup_key_is_eligible(&engine, id),
                        )
                        .await
                    } else {
                        None
                    };
                    let followup_runs = pending_summary
                        .as_ref()
                        .map(|(_, keys)| keys.clone())
                        .unwrap_or_default();
                    let summary = if let Some((summary, _)) = pending_summary {
                        summary
                    } else if has_orchestrate_work {
                        match engine.claim_orchestrate_idle_continuation(
                        kcoder_engine::orchestrate::continuation::IdleRequest {
                            cooldown_elapsed: true,
                            ..Default::default()
                        },
                    ) {
                        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued { prompt }) => prompt,
                        Ok(_) => {
                            running.store(false, Ordering::SeqCst);
                            drop(_gate);
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(goal_lifecycle::COOLDOWN) => {}
                            }
                            continue;
                        }
                        Err(error) => {
                            tracing::warn!(%error, "app-server Orchestrate continuation failed");
                            running.store(false, Ordering::SeqCst);
                            drop(_gate);
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(goal_lifecycle::COOLDOWN) => {}
                            }
                            continue;
                        }
                    }
                    } else {
                        match goal_lifecycle::GoalLifecycle::prompt(&engine) {
                            Some(prompt) => prompt,
                            None => {
                                running.store(false, Ordering::SeqCst);
                                continue;
                            }
                        }
                    };
                    let thread_id = engine.session_id();
                    let turn_sequence = next_turn_id.fetch_add(1, Ordering::SeqCst);
                    let turn_id = if let Some(first) = followup_runs.first() {
                        engine
                            .state
                            .background_run_record(first)
                            .and_then(|record| record.followup_turn_id)
                            .unwrap_or_else(|| format!("background-followup-{}", first.run_id))
                    } else if summary.starts_with("[scheduled task ")
                        || summary.starts_with("[system] Continue working toward the active")
                    {
                        // A resumed recurring task must not reuse a prior run's projection id.
                        let nonce = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos();
                        let kind = if summary.starts_with("[scheduled task ") {
                            "cron"
                        } else {
                            "goal"
                        };
                        format!(
                            "background-followup-{kind}-{}-{nonce}-{turn_sequence}",
                            std::process::id()
                        )
                    } else {
                        format!("background-followup-{turn_sequence}")
                    };
                    if !followup_runs.is_empty() {
                        match engine
                            .state
                            .reserve_background_followup(&followup_runs, &turn_id)
                        {
                            Ok(true) => {}
                            result => {
                                tracing::warn!(
                                    ?result,
                                    "background followup reservation was not committed"
                                );
                                let mut queue = followups.queue.lock().await;
                                for key in &followup_runs {
                                    let value = serde_json::to_string(key)
                                        .expect("run identity serializes");
                                    queue.claimed_terminal_ids.remove(&(value, None));
                                }
                                running.store(false, Ordering::SeqCst);
                                continue;
                            }
                        }
                    }
                    let projection = Arc::new(Mutex::new(StreamProjection::new(
                        server_id.clone(),
                        thread_id.clone(),
                        turn_id.clone(),
                        Arc::clone(&sequence),
                    )));
                    set_active_background_projection(
                        &background_projection,
                        &thread_id,
                        &turn_id,
                        Arc::clone(&projection),
                    )
                    .await;
                    *question_context
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(QuestionContext {
                        server_id: server_id.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    });
                    *approval_context
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ApprovalContext {
                        server_id: server_id.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    });
                    let turn_cancel = CancellationToken::new();
                    let turn_engine = engine.clone().with_cancel_token(turn_cancel.clone());
                    let goal_turn = followups.goals.lock().unwrap().begin(
                        &engine,
                        None,
                        Some(turn_cancel.clone()),
                    );
                    let summary =
                        if summary.starts_with("[system] Continue working toward the active") {
                            goal_lifecycle::GoalLifecycle::prompt(&engine).unwrap_or(summary)
                        } else {
                            summary
                        };
                    let mut automatic_permission_prompt = permission_prompt.clone();
                    if let Some(mode) = goal_turn.permission_mode {
                        automatic_permission_prompt.mode = mode;
                    }
                    let handle = tokio::spawn(run_background_followup_turn(
                        turn_engine,
                        summary,
                        followup_runs,
                        goal_turn,
                        outbound_tx.clone(),
                        Arc::clone(&running),
                        thread_id.clone(),
                        turn_id.clone(),
                        server_id.clone(),
                        Arc::clone(&sequence),
                        projection,
                        Arc::clone(&background_projection),
                        Arc::clone(&followups),
                        Arc::clone(&question_context),
                        Arc::clone(&pending_questions),
                        Arc::clone(&approval_context),
                        Arc::clone(&pending_approvals),
                        automatic_permission_prompt,
                        turn_cancel.clone(),
                    ));
                    *active_turn.lock().await = Some(ActiveTurn {
                        handle,
                        cancel: turn_cancel,
                        thread_id,
                        turn_id,
                    });
                    spawned = true;
                }
            }
        }
        if spawned {
            continue;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = notified => {}
            _ = tokio::time::sleep(goal_lifecycle::COOLDOWN), if followups.goals.lock().unwrap().pending() => {}
            _ = tokio::time::sleep(Duration::from_secs(
                engine.settings.read().unwrap().orchestrate.continuation.cooldown_seconds.max(1)
            )), if engine.state.session_mode().is_orchestrate() => {}
        }
    }
}

impl BackgroundFollowupScheduler {
    #[cfg(test)]
    pub(super) fn disabled_for_test() -> Self {
        let cancel = CancellationToken::new();
        let child_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            child_cancel.cancelled().await;
        });
        Self { cancel, handle }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn spawn(
        engine: &QueryEngine,
        followups: Arc<BackgroundFollowupState>,
        activity_gate: Arc<Mutex<()>>,
        accepting_turns: Arc<AtomicBool>,
        running: Arc<AtomicBool>,
        active_turn: Arc<Mutex<Option<ActiveTurn>>>,
        background_projection: Arc<Mutex<BackgroundProjectionState>>,
        outbound_tx: mpsc::Sender<Value>,
        server_id: String,
        sequence: Arc<AtomicU64>,
        question_context: Arc<StdMutex<Option<QuestionContext>>>,
        pending_questions: PendingQuestionResponses,
        approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
        pending_approvals: PendingApprovalResponses,
        permission_prompt: AppServerPermissionPrompt,
    ) -> Self {
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_background_followup_scheduler(
            engine.clone(),
            followups,
            activity_gate,
            accepting_turns,
            running,
            active_turn,
            background_projection,
            outbound_tx,
            server_id,
            sequence,
            Arc::new(AtomicU64::new(1)),
            question_context,
            pending_questions,
            approval_context,
            pending_approvals,
            permission_prompt,
            cancel.clone(),
        ));
        Self { cancel, handle }
    }

    pub(super) async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = self.handle.await;
        }
    }
}
