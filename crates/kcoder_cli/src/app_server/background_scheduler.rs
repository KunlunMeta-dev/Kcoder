//! Background scheduler: extracted from the app-server connection boundary.

use super::*;

/// The scheduler follows the resident owner instead of retaining the Engine
/// clone that happened to exist when its task was spawned.
pub(super) struct SchedulerEngine {
    engine: QueryEngine,
    lifecycle: Option<kcoder_state::AppStateLifecycleIdentity>,
    lease_target: PathBuf,
    lease_owner: std::sync::Weak<AtomicBool>,
    generation: u64,
}

// Short-lived and moved once; boxing the large variant buys nothing here.
#[allow(clippy::large_enum_variant)]
enum SchedulerEngineObservation {
    Ready {
        engine: QueryEngine,
        generation: u64,
    },
    Busy,
    Unavailable,
}

impl SchedulerEngine {
    fn observe(current: &StdMutex<Self>) -> SchedulerEngineObservation {
        let current = match current.try_lock() {
            Ok(current) => current,
            Err(std::sync::TryLockError::WouldBlock) => return SchedulerEngineObservation::Busy,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return SchedulerEngineObservation::Unavailable;
            }
        };
        let Some(lease_owner) = current.lease_owner.upgrade() else {
            return SchedulerEngineObservation::Unavailable;
        };
        if !lease_owner.load(Ordering::Acquire) {
            return SchedulerEngineObservation::Unavailable;
        }
        // Automatic wake-ups do not carry an original source acceptance. Do
        // not consume a queued follow-up or append a message until they do.
        if current.engine.native_input_requires_source_admission() {
            return SchedulerEngineObservation::Unavailable;
        }
        let Some(lifecycle) = current.lifecycle.as_ref() else {
            return SchedulerEngineObservation::Unavailable;
        };
        match current
            .engine
            .try_matches_session_lease_target(lifecycle, &current.lease_target)
        {
            kcoder_state::TryLifecycleAccess::Current(()) => {
                if lease_owner.load(Ordering::Acquire) {
                    SchedulerEngineObservation::Ready {
                        engine: current.engine.clone(),
                        generation: current.generation,
                    }
                } else {
                    SchedulerEngineObservation::Unavailable
                }
            }
            kcoder_state::TryLifecycleAccess::Busy => SchedulerEngineObservation::Busy,
            kcoder_state::TryLifecycleAccess::Changed
            | kcoder_state::TryLifecycleAccess::Unavailable => {
                SchedulerEngineObservation::Unavailable
            }
        }
    }
}

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
    claim: Option<continuous_work_admission::AutomaticClaimLease>,
    queued_input: Option<continuous_work_admission::QueuedWorkInput>,
    observed_input: Option<tokio::sync::oneshot::Receiver<kcoder_state::CommittedUserInput>>,
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

    let (hook_events, stop_followup) = if is_goal_continuation || cancel.is_cancelled() {
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

    // Whether this turn really asked the provider at all; a queued input that never
    // reached it can go back to the queue instead of wedging later.
    let mut provider_requested = false;
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
                if matches!(&event, EngineEvent::AssistantMessageStarted) {
                    provider_requested = true;
                }
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
    projection.lock().await.turn_terminal = true;
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
    // A queued requirement settles only when the provider request really carried
    // it; anything else stays unknown and keeps blocking completion.
    if let (Some(input), Some(claim)) = (queued_input.as_ref(), claim.as_ref()) {
        let applied = observed_input
            .and_then(|mut receiver| receiver.try_recv().ok())
            .and_then(|committed| {
                if !kcoder_engine::continuous_work::input_handoff::current_provider_request_includes(
                    &committed,
                ) {
                    return None;
                }
                committed
                    .attempt()
                    .map(|attempt| kcoder_state::continuous_work::AppliedInputReference {
                        attempt: attempt.clone(),
                        history_uuid: committed.uuid().to_owned(),
                    })
            });
        // The requirement counts as applied once the provider request really
        // carried it, even if the turn itself later failed. A turn that never
        // asked the provider returns the requirement to the queue; anything else
        // that stayed unobserved keeps blocking as unknown.
        match (applied, provider_requested) {
            (Some(reference), _) => claim.settle_dispatched_input(input, Some(reference)),
            (None, false) => claim.requeue_dispatched_input(input),
            (None, true) => claim.settle_dispatched_input(input, None),
        }
    }
    // The claim settles with the outcome this turn really produced, never with an
    // optimistic value: a completed turn clears the batch failure counters, any
    // other terminal status counts as one consecutive failure.
    if let Some(claim) = claim {
        claim.settle_after_turn(status);
    }
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

pub(super) use kcoder_foreground_runtime::explicit_turn_appended_user_message;

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

/// Reserve outbound capacity without holding the turn-registration gate. A
/// newer turn or goal revision invalidates the old notice before it is sent.
#[allow(clippy::too_many_arguments)]
pub(super) async fn publish_goal_limit_notice(
    engine: &QueryEngine,
    followups: &BackgroundFollowupState,
    activity_gate: &Mutex<()>,
    running: &AtomicBool,
    outbound_tx: &mpsc::Sender<Value>,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    cancel: &CancellationToken,
    notice: goal_lifecycle::GoalLimitNotice,
    scheduler_engine: Option<(&StdMutex<SchedulerEngine>, u64)>,
) -> bool {
    for system_notice in [false, true] {
        loop {
            let permit = tokio::select! {
                biased;
                _ = cancel.cancelled() => return false,
                permit = outbound_tx.reserve() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return false,
                },
            };
            let Ok(_gate) = activity_gate.try_lock() else {
                // A control request holding the gate may itself need outbound
                // capacity. Never wait for that gate while reserving its slot.
                drop(permit);
                let gate = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return false,
                    gate = activity_gate.lock() => gate,
                };
                drop(gate);
                continue;
            };
            if cancel.is_cancelled() {
                return false;
            }
            if let Some((current, expected)) = scheduler_engine {
                match SchedulerEngine::observe(current) {
                    SchedulerEngineObservation::Ready { generation, .. }
                        if generation == expected => {}
                    SchedulerEngineObservation::Busy => {
                        drop(_gate);
                        drop(permit);
                        tokio::select! {
                            _ = cancel.cancelled() => return false,
                            _ = tokio::time::sleep(Duration::from_millis(200)) => {},
                        }
                        continue;
                    }
                    _ => return true,
                }
            }
            if running.load(Ordering::SeqCst)
                || !followups
                    .goals
                    .lock()
                    .unwrap()
                    .limit_notice_is_current(engine, &notice)
            {
                return true;
            }
            let thread_id = engine.session_id();
            let message = if system_notice {
                notification(
                    "item/event",
                    with_event_context(
                        server_id,
                        &thread_id,
                        Some("goal-status"),
                        sequence,
                        json!({"event": engine_event_json(EngineEvent::SystemNotice(notice.message.clone()))}),
                    ),
                )
            } else {
                let value = kcoder_app_protocol::ThreadGoalContinuationParams {
                    thread_id,
                    status: "settled".into(),
                    turn_id: None,
                    reason: Some(notice.message.clone()),
                };
                let Ok(value) = serde_json::to_value(value) else {
                    return true;
                };
                notification(kcoder_app_protocol::method::THREAD_GOAL_CONTINUATION, value)
            };
            permit.send(message);
            break;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_background_followup_scheduler(
    current_engine: Arc<StdMutex<SchedulerEngine>>,
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
    // The last deferred-gate reason the client already saw, so a repeated wait
    // is published once instead of on every scheduler pass.
    let mut gate_wait = continuous_work_admission::GateWaitNotice::default();
    loop {
        let notified = followups.notify.notified();
        let mut spawned = false;
        let mut limit_notice = None;
        let engine;
        let generation;
        {
            // Share the latch with explicit turn/start and thread switching so only one claimant can acquire idle state.
            let _gate = tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                gate = activity_gate.lock() => gate,
            };
            if cancel.is_cancelled() {
                break;
            }
            match SchedulerEngine::observe(&current_engine) {
                SchedulerEngineObservation::Ready {
                    engine: current,
                    generation: current_generation,
                } => {
                    engine = current;
                    generation = current_generation;
                }
                SchedulerEngineObservation::Busy => {
                    drop(_gate);
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = notified => {},
                        _ = tokio::time::sleep(Duration::from_millis(200)) => {},
                    }
                    continue;
                }
                SchedulerEngineObservation::Unavailable => {
                    drop(_gate);
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = notified => {},
                    }
                    continue;
                }
            }
            let has_pending_followup = !followups.queue.lock().await.pending.is_empty();
            let client_lifetime = followups.continuation_client_lifetime();
            let source_active = followups.session_activity.admits(&engine);
            let (has_goal_work, goals_suspended) = {
                let mut goals = followups.goals.lock().unwrap();
                (goals.ready(&engine), goals.is_suspended())
            };
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
            if !cancel.is_cancelled()
                && accepting_turns.load(Ordering::SeqCst)
                && source_active
                && !running.load(Ordering::SeqCst)
                && followups.client_turn_count.get().is_some()
                && !goals_suspended
                && !has_running_background_followups(&engine)
                && (has_pending_followup || has_orchestrate_work || has_goal_work)
                && followups.claim_continuation_source(&client_lifetime, &running)
            {
                if !accepting_turns.load(Ordering::SeqCst) {
                    running.store(false, Ordering::SeqCst);
                    continue;
                }
                let allowed = followups.goals.lock().unwrap().automatic_allowed(&engine);
                if !allowed {
                    limit_notice = followups.goals.lock().unwrap().take_limit_notice(&engine);
                    running.store(false, Ordering::SeqCst);
                    // Wait for a real state change, not a busy loop at the limit.
                } else {
                    // One durable claim gate for every automatic dispatch: the work
                    // item bound to this thread must be ready, and only an acquired
                    // claim may start a model turn. Nothing is consumed before this
                    // decision, so a deferral does not steal a follow-up batch or an
                    // Orchestrate continuation.
                    let continuation_scope = if has_orchestrate_work {
                        kcoder_engine::continuous_work::host_gate::ContinuationScope::Orchestrate
                    } else if has_pending_followup {
                        kcoder_engine::continuous_work::host_gate::ContinuationScope::Business
                    } else {
                        kcoder_engine::continuous_work::host_gate::ContinuationScope::Goal
                    };
                    let pending_question_count = pending_questions
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .len();
                    let claim_nonce = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos();
                    let claim_id = format!("auto-{}-{claim_nonce}", std::process::id());
                    let mut claim = match continuous_work_admission::automatic_dispatch_gate(
                        &engine,
                        &engine.session_id(),
                        &claim_id,
                        continuation_scope,
                        continuous_work_admission::automatic_gate_facts(
                            pending_question_count,
                            has_running_background_followups(&engine),
                        ),
                    ) {
                        continuous_work_admission::AutomaticDispatchGate::Unbound => {
                            gate_wait.clear();
                            None
                        }
                        continuous_work_admission::AutomaticDispatchGate::Claimed(claim) => {
                            gate_wait.clear();
                            Some(claim)
                        }
                        continuous_work_admission::AutomaticDispatchGate::Deferred(reason) => {
                            tracing::info!(
                                reason = %reason,
                                thread_id = %engine.session_id(),
                                "automatic dispatch waits for the continuous-work gate"
                            );
                            running.store(false, Ordering::SeqCst);
                            drop(_gate);
                            // Surface the wait through the existing continuation
                            // notice, once per distinct reason and only after the
                            // shared gate is released.
                            if gate_wait.changed(&reason) {
                                goal_lifecycle::publish_continuation(
                                    &engine,
                                    &outbound_tx,
                                    "settled",
                                    None,
                                    Some(continuous_work_admission::gate_wait_message(&reason)),
                                )
                                .await;
                            }
                            // Wait for a real state change rather than polling. Every
                            // owner that can lift this wait notifies; the long fallback
                            // only exists so a notify created before the state change
                            // cannot park the scheduler forever. It issues no model
                            // request and the wait text is published once per reason.
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = followups.notify.notified() => {}
                                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                            }
                            continue;
                        }
                    };
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
                            if let Some(claim) = claim.take() {
                                claim.settle(
                                    kcoder_state::continuous_work::ClaimSettlement::Abandoned,
                                );
                            }
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
                            if let Some(claim) = claim.take() {
                                claim.settle(
                                    kcoder_state::continuous_work::ClaimSettlement::Abandoned,
                                );
                            }
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
                                if let Some(claim) = claim.take() {
                                    claim.settle(
                                        kcoder_state::continuous_work::ClaimSettlement::Abandoned,
                                    );
                                }
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
                    let mut turn_engine = engine.clone().with_cancel_token(turn_cancel.clone());
                    let turn_outbound = client_lifetime
                        .as_ref()
                        .map(|source| source.outbound.clone())
                        .unwrap_or_else(|| outbound_tx.clone());
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
                    if client_lifetime.is_some() {
                        // The current input owns interactive delivery, even if
                        // the runtime's creating presentation has already left.
                        automatic_permission_prompt.outbound_tx = turn_outbound.clone();
                        turn_engine.set_user_questioner(Arc::new(AppServerQuestioner {
                            outbound_tx: turn_outbound.clone(),
                            pending: pending_questions.clone(),
                            receipts: permission_prompt.receipts.clone(),
                            next_id: permission_prompt.next_id.clone(),
                            context: question_context.clone(),
                        }));
                    }
                    if let Some(mode) = goal_turn.permission_mode {
                        automatic_permission_prompt.mode = mode;
                    }
                    // A queued requirement is dispatched only together with a real
                    // automatic turn, then carried as the first block of its prompt.
                    let queued_input = claim
                        .as_ref()
                        .and_then(|lease| lease.take_next_queued_input());
                    // Append, never prepend: the continuation marker must stay at
                    // the start so the turn is still recognised as a continuation.
                    let summary = match &queued_input {
                        Some(queued) => format!("{summary}\n\n{}", queued.text),
                        None => summary,
                    };
                    let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
                    let observed_input = queued_input.as_ref().map(|_| observed_rx);
                    let handle = kcoder_app_events::turn_tasks::spawn_followup(
                        thread_id.clone(),
                        observed_tx,
                        Box::pin(run_background_followup_turn(
                            turn_engine,
                            summary,
                            followup_runs,
                            goal_turn,
                            turn_outbound,
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
                            claim,
                            queued_input,
                            observed_input,
                        )),
                    );
                    *active_turn.lock().await = Some(ActiveTurn {
                        desktop_owner: None,
                        input_owner: client_lifetime
                            .as_ref()
                            .map(input_lifetime::ClientInputLifetime::owner),
                        handle,
                        cancel: turn_cancel,
                        thread_id,
                        turn_id,
                        attempt: None,
                        origin: request_origin::RequestOrigin::Automation,
                    });
                    spawned = true;
                }
            }
        }
        if spawned {
            continue;
        }
        if let Some(notice) = limit_notice {
            if !publish_goal_limit_notice(
                &engine,
                &followups,
                &activity_gate,
                &running,
                &outbound_tx,
                &server_id,
                &sequence,
                &cancel,
                notice,
                Some((&current_engine, generation)),
            )
            .await
            {
                break;
            }
            // State may have changed while waiting for outbound capacity.
            continue;
        }
        let source_active = followups.session_activity.admits(&engine);
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = notified => {}
            _ = tokio::time::sleep(goal_lifecycle::COOLDOWN), if source_active && followups.goals.lock().unwrap().pending() => {}
            _ = tokio::time::sleep(Duration::from_secs(
                engine.settings.read().unwrap().orchestrate.continuation.cooldown_seconds.max(1)
            )), if source_active && engine.state.session_mode().is_orchestrate() => {}
        }
    }
}

impl BackgroundFollowupScheduler {
    #[cfg(test)]
    pub(super) fn disabled_for_test() -> Self {
        let cancel = CancellationToken::new();
        let child_cancel = cancel.clone();
        let handle = crate::app_server::task_spawn::spawn(async move {
            child_cancel.cancelled().await;
        });
        Self {
            cancel,
            handle,
            engine: None,
        }
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
        lease_target: PathBuf,
        lifecycle: Option<kcoder_state::AppStateLifecycleIdentity>,
        lease_owner: std::sync::Weak<AtomicBool>,
    ) -> Self {
        let cancel = CancellationToken::new();
        let current_engine = Arc::new(StdMutex::new(SchedulerEngine {
            engine: engine.clone(),
            lifecycle,
            lease_target,
            lease_owner,
            generation: 0,
        }));
        let handle = crate::app_server::task_spawn::spawn(run_background_followup_scheduler(
            Arc::clone(&current_engine),
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
        Self {
            cancel,
            handle,
            engine: Some(current_engine),
        }
    }

    /// The caller must hold the original resident's activity gate.
    pub(super) fn replace_engine(
        &self,
        candidate: &QueryEngine,
        lease_target: &Path,
    ) -> Result<()> {
        let Some(current) = self.engine.as_ref() else {
            // A disabled scheduler is only constructed by tests.
            let lifecycle = candidate
                .state
                .try_inspection_lifecycle_identity()
                .context("Thread scheduler lifecycle unavailable")?;
            ensure!(
                matches!(
                    candidate.try_matches_session_lease_target(&lifecycle, lease_target),
                    kcoder_state::TryLifecycleAccess::Current(())
                ),
                "Thread candidate owner mismatch"
            );
            return Ok(());
        };
        let mut current = current
            .try_lock()
            .map_err(|_| anyhow::anyhow!("Thread scheduler engine unavailable"))?;
        ensure!(
            current
                .lease_owner
                .upgrade()
                .is_some_and(|owner| owner.load(Ordering::Acquire)),
            "Thread scheduler lease owner unavailable"
        );
        let lifecycle = current
            .lifecycle
            .as_ref()
            .context("Thread scheduler lifecycle unavailable")?;
        ensure!(
            current.lease_target == lease_target
                && current.engine.state.shares_state_with(&candidate.state)
                && matches!(
                    candidate.try_matches_session_lease_target(lifecycle, lease_target),
                    kcoder_state::TryLifecycleAccess::Current(())
                ),
            "Thread scheduler lifecycle changed or unavailable"
        );
        let generation = current
            .generation
            .checked_add(1)
            .context("Thread scheduler generation exhausted")?;
        current.engine = candidate.clone();
        current.generation = generation;
        Ok(())
    }

    pub(super) async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = (&mut self.handle).await;
        }
    }
}

impl Drop for BackgroundFollowupScheduler {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
