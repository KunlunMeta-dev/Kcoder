//! Queued messages and background followups select the next foreground turn.

use super::*;

pub(super) fn has_nonterminal_background_subagents(engine: &QueryEngine) -> bool {
    engine.state.tasks().values().any(|task| {
        matches!(task.kind, kcoder_state::TaskKind::Subagent)
            && task.notify_parent_on_completion
            // `Paused` is deliberately excluded: a paused agent emits no
            // notification and is not recovered, so counting it would gate the
            // aggregate turn forever. When it later resumes and finishes, its
            // own completion notification wakes the parent. This matches the
            // app-server and headless gates.
            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
    })
}

pub(super) fn take_merged_background_followup(
    app: &mut ReplApp,
) -> Option<PendingBackgroundFollowup> {
    let mut ids = Vec::new();
    let mut events = Vec::new();
    while let Some(followup) = app.pending_background_followups.pop_front() {
        for (id, event) in followup.ids.into_iter().zip(followup.events) {
            if !ids.contains(&id) || id.is_empty() && !events.contains(&event) {
                ids.push(id);
                events.push(event);
            }
        }
    }
    if events.is_empty() {
        None
    } else {
        let summary = events.join(" ");
        Some(PendingBackgroundFollowup {
            ids,
            events,
            summary,
        })
    }
}

pub(super) fn enqueue_background_followup(
    app: &mut ReplApp,
    ids: Vec<String>,
    events: Vec<String>,
    summary: String,
) {
    debug_assert_eq!(ids.len(), events.len());
    if let Some(pending) = app.pending_background_followups.back_mut() {
        for (id, event) in ids.into_iter().zip(events) {
            if !pending.ids.contains(&id) || id.is_empty() && !pending.events.contains(&event) {
                pending.ids.push(id);
                pending.events.push(event);
            }
        }
        pending.summary = pending.events.join(" ");
    } else {
        app.pending_background_followups
            .push_back(PendingBackgroundFollowup {
                ids,
                events,
                summary,
            });
    }
}

/// Outcome of attempting to start the next queued or follow-up turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StartTurnOutcome {
    /// A new turn (or follow-up) was started.
    Started,
    /// Nothing to start; the REPL stays idle.
    Idle,
    /// A queued slash command requested shutdown (e.g. `/quit`).
    Quit,
}

impl StartTurnOutcome {
    #[cfg(test)]
    pub(super) fn started(self) -> bool {
        matches!(self, StartTurnOutcome::Started)
    }
}

pub(super) fn select_background_followup_batch(
    engine: &QueryEngine,
    app: &mut ReplApp,
    followup: PendingBackgroundFollowup,
) -> PendingBackgroundFollowup {
    let batch_for = |id: &str| {
        serde_json::from_str::<kcoder_types::BackgroundRunKey>(id)
            .ok()
            .and_then(|run| engine.state.background_run_record(&run))
            .and_then(|record| record.followup_turn_id)
    };
    let selected_batch = followup.ids.iter().find_map(|id| batch_for(id));
    let mut selected = PendingBackgroundFollowup {
        ids: Vec::new(),
        events: Vec::new(),
        summary: String::new(),
    };
    let mut remaining = PendingBackgroundFollowup {
        ids: Vec::new(),
        events: Vec::new(),
        summary: String::new(),
    };
    for (id, event) in followup.ids.into_iter().zip(followup.events) {
        let batch = if batch_for(&id) == selected_batch {
            &mut selected
        } else {
            &mut remaining
        };
        batch.ids.push(id);
        batch.events.push(event);
    }
    selected.summary = selected.events.join(" ");
    if !remaining.events.is_empty() {
        remaining.summary = remaining.events.join(" ");
        app.pending_background_followups.push_front(remaining);
    }
    selected
}

pub(super) async fn prepare_background_followup(
    engine: &QueryEngine,
    ids: impl IntoIterator<Item = String>,
    nudge: String,
) -> Result<Option<(Vec<kcoder_types::BackgroundRunKey>, String)>> {
    let keys: Vec<kcoder_types::BackgroundRunKey> = ids
        .into_iter()
        .filter_map(|id| serde_json::from_str(&id).ok())
        .collect();
    if keys.is_empty() {
        engine.state.add_message(Message::runtime_text(nudge));
        return Ok(Some((keys, String::new())));
    }
    let records: Vec<_> = keys
        .iter()
        .filter_map(|key| engine.state.background_run_record(key))
        .collect();
    if records
        .iter()
        .any(|record| record.followup_started || record.followup_handled)
    {
        tracing::warn!("background follow-up was already started; automatic replay suppressed");
        return Ok(None);
    }
    let turn_id = records
        .iter()
        .find_map(|record| record.followup_turn_id.clone())
        .unwrap_or_else(|| format!("{}:followup", keys[0].run_id));
    if !engine.state.reserve_background_followup(&keys, &turn_id)? {
        return Ok(None);
    }
    engine
        .state
        .commit_message_with_uuid(Message::runtime_text(nudge), &turn_id)
        .await?;
    if !engine
        .state
        .mark_background_followup_started(&keys, &turn_id)?
    {
        return Ok(None);
    }
    Ok(Some((keys, turn_id)))
}

fn queued_session_reset_ready(app: &ReplApp) -> bool {
    let queued_reset = app
        .rejected_turn_steers
        .front()
        .or_else(|| app.user_message_queue.front())
        .is_some_and(|queued| {
            queued.action == QueuedInputAction::Slash
                && matches!(
                    parse_slash_input(&queued.restore_text)
                        .0
                        .to_ascii_lowercase()
                        .as_str(),
                    "/new" | "/clear" | "/luna"
                )
        });
    queued_reset
        && !app.has_current_input_uncertainty()
        && app.input_admission.as_ref().is_some_and(|admission| {
            admission.cancelled && admission.observer.is_none() && admission.witness.is_some()
        })
}

pub(super) async fn try_start_next_turn(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<StartTurnOutcome> {
    if app.turn_lifecycle_in_progress() {
        return Ok(StartTurnOutcome::Idle);
    }
    if app.input_admission.as_ref().is_some_and(|admission| {
        app.input_session_owner
            .as_ref()
            .is_some_and(|owner| !admission.owner.same_lifecycle(owner))
    }) && !app.retire_stale_input_admission()
    {
        return Ok(StartTurnOutcome::Idle);
    }
    if app.has_current_input_uncertainty() && !queued_session_reset_ready(app) {
        return Ok(StartTurnOutcome::Idle);
    }
    if app.has_running_side_questions() {
        if !app.user_message_queue.is_empty()
            || !app.rejected_turn_steers.is_empty()
            || !app.pending_background_followups.is_empty()
        {
            app.input_start_retry_at = Some(Instant::now() + Duration::from_millis(80));
            app.sync_input_preparation_indicator();
        }
        return Ok(StartTurnOutcome::Idle);
    }

    loop {
        let reset_ready = queued_session_reset_ready(app);
        let next = app
            .rejected_turn_steers
            .front()
            .or_else(|| app.user_message_queue.front());
        let next_action = next.map(|queued| queued.action);
        if let Some(admission) = app.input_admission.as_ref()
            && !matches!(next_action, Some(QueuedInputAction::Admitted(id)) if id == admission.id && !admission.cancelled)
            && !reset_ready
        {
            return Ok(StartTurnOutcome::Idle);
        }
        if next.is_some_and(|queued| {
            matches!(
                queued.action,
                QueuedInputAction::Preparing(_)
                    | QueuedInputAction::Admitting(_)
                    | QueuedInputAction::Uncertain
                    | QueuedInputAction::Held
            )
        }) {
            return Ok(StartTurnOutcome::Idle);
        }
        if let Some(owner) = next.and_then(|queued| queued.owner.as_ref()) {
            match engine.state.try_check_lifecycle_identity(owner) {
                Ok(None) => {
                    app.input_start_retry_at = Some(Instant::now() + Duration::from_millis(80));
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
                Ok(Some(false)) | Err(_) => {
                    if matches!(next_action, Some(QueuedInputAction::Admitted(_))) {
                        let original_owner = owner.clone();
                        if let Some(front) = app
                            .rejected_turn_steers
                            .front_mut()
                            .or_else(|| app.user_message_queue.front_mut())
                        {
                            front.action = QueuedInputAction::Uncertain;
                        }
                        if let Some(admission) = app.input_admission.as_mut() {
                            admission.cancel_dispatch();
                        }
                        app.mark_input_uncertain_for(Some(original_owner));
                        app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                        app.sync_input_preparation_indicator();
                    } else {
                        app.hold_next_user_input(
                            "The session changed; the input remains queued for editing or clearing.",
                        );
                    }
                    return Ok(StartTurnOutcome::Idle);
                }
                Ok(Some(true)) => {}
            }
        }
        if matches!(
            next_action,
            Some(QueuedInputAction::Plain | QueuedInputAction::Admitted(_))
        ) && let Err(error) = engine.prepare_client_model_for_turn(None, false)
        {
            let message = format!("Cannot prepare selected model; queued input was kept: {error}");
            if app.queued_model_error.as_deref() != Some(&message) {
                app.queued_model_error = Some(message.clone());
                let _ = tx.send(AppEvent::SystemNotice(message));
            }
            return Ok(StartTurnOutcome::Idle);
        }
        app.queued_model_error = None;
        let already_appended = if let Some(queued) = app
            .rejected_turn_steers
            .front()
            .or_else(|| app.user_message_queue.front())
            && queued.action == QueuedInputAction::Plain
            && let Some(owner) = queued.owner.as_ref()
        {
            if app.input_admission.is_some() {
                return Ok(StartTurnOutcome::Idle);
            }
            let input_owner = owner.clone();
            match engine
                .state
                .try_begin_user_input(owner, queued.model_message.clone())
            {
                kcoder_state::UserInputStart::Busy(_) => {
                    app.input_start_retry_at = Some(Instant::now() + Duration::from_millis(80));
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
                kcoder_state::UserInputStart::Rejected { .. } => {
                    app.hold_next_user_input("The input could not be saved. Check the conversation or edit the input before trying again.");
                    return Ok(StartTurnOutcome::Idle);
                }
                kcoder_state::UserInputStart::Unknown {
                    uuid,
                    error,
                    pending,
                    ..
                } => {
                    app.input_unknown_diagnostic = Some((uuid, error));
                    app.mark_input_uncertain_for(Some(input_owner.clone()));
                    if let Some(pending) = pending {
                        app.next_input_admission_id = app.next_input_admission_id.saturating_add(1);
                        app.input_admission =
                            Some(crate::input_admission::PendingInputAdmission::new(
                                app.next_input_admission_id,
                                pending,
                                true,
                                input_owner.clone(),
                            ));
                    }
                    if let Some(front) = app
                        .rejected_turn_steers
                        .front_mut()
                        .or_else(|| app.user_message_queue.front_mut())
                    {
                        front.action = QueuedInputAction::Uncertain;
                    }
                    app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
                kcoder_state::UserInputStart::Accepted(pending) => {
                    if !pending.ticket_is_retained() {
                        app.input_unknown_diagnostic = Some((
                            pending.uuid().to_owned(),
                            "original ticket owner was unavailable".into(),
                        ));
                        app.mark_input_uncertain_for(Some(input_owner.clone()));
                        app.next_input_admission_id = app.next_input_admission_id.saturating_add(1);
                        app.input_admission =
                            Some(crate::input_admission::PendingInputAdmission::new(
                                app.next_input_admission_id,
                                pending,
                                true,
                                input_owner.clone(),
                            ));
                        if let Some(front) = app
                            .rejected_turn_steers
                            .front_mut()
                            .or_else(|| app.user_message_queue.front_mut())
                        {
                            front.action = QueuedInputAction::Uncertain;
                        }
                        app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                        return Ok(StartTurnOutcome::Idle);
                    }
                    let Some(id) = app.next_input_admission_id.checked_add(1) else {
                        app.input_unknown_diagnostic = Some((
                            pending.uuid().to_owned(),
                            "input identity space was exhausted".into(),
                        ));
                        app.mark_input_uncertain_for(Some(input_owner.clone()));
                        app.input_admission =
                            Some(crate::input_admission::PendingInputAdmission::new(
                                app.next_input_admission_id,
                                pending,
                                true,
                                input_owner.clone(),
                            ));
                        if let Some(front) = app
                            .rejected_turn_steers
                            .front_mut()
                            .or_else(|| app.user_message_queue.front_mut())
                        {
                            front.action = QueuedInputAction::Uncertain;
                        }
                        return Ok(StartTurnOutcome::Idle);
                    };
                    app.next_input_admission_id = id;
                    if let Some(front) = app
                        .rejected_turn_steers
                        .front_mut()
                        .or_else(|| app.user_message_queue.front_mut())
                    {
                        front.action = QueuedInputAction::Admitting(id);
                    }
                    app.input_admission = Some(crate::input_admission::PendingInputAdmission::new(
                        id,
                        pending,
                        false,
                        input_owner,
                    ));
                    app.input_start_retry_at = None;
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
            }
        } else if let Some(QueuedInputAction::Admitted(id)) = next_action {
            let Some(admission) = app
                .input_admission
                .as_ref()
                .filter(|admission| admission.id == id && !admission.cancelled)
            else {
                let owner = app
                    .rejected_turn_steers
                    .front()
                    .or_else(|| app.user_message_queue.front())
                    .and_then(|queued| queued.owner.clone());
                if let Some(front) = app
                    .rejected_turn_steers
                    .front_mut()
                    .or_else(|| app.user_message_queue.front_mut())
                {
                    front.action = QueuedInputAction::Uncertain;
                }
                app.mark_input_uncertain_for(owner);
                app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                return Ok(StartTurnOutcome::Idle);
            };
            let Some(witness) = admission.witness.as_ref() else {
                return Ok(StartTurnOutcome::Idle);
            };
            match witness.try_is_current() {
                Ok(true) => true,
                Ok(false) => {
                    app.input_start_retry_at = Some(Instant::now() + Duration::from_millis(80));
                    return Ok(StartTurnOutcome::Idle);
                }
                Err(error) => {
                    let owner = admission.owner.clone();
                    app.input_unknown_diagnostic =
                        Some((admission.uuid.clone(), error.to_string()));
                    app.mark_input_uncertain_for(Some(owner));
                    if let Some(front) = app
                        .rejected_turn_steers
                        .front_mut()
                        .or_else(|| app.user_message_queue.front_mut())
                    {
                        front.action = QueuedInputAction::Uncertain;
                    }
                    if let Some(admission) = app.input_admission.as_mut() {
                        admission.cancel_dispatch();
                    }
                    app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
            }
        } else {
            false
        };
        if matches!(
            next_action,
            Some(QueuedInputAction::Plain | QueuedInputAction::Admitted(_))
        ) && let Err(error) = engine.acknowledge_orchestrate_user_input()
        {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Orchestrate work could not acknowledge user input: {error:#}"
            )));
            return Ok(StartTurnOutcome::Idle);
        }
        if already_appended {
            let current = app
                .input_admission
                .as_ref()
                .and_then(|admission| admission.witness.as_ref())
                .map(|witness| witness.try_is_current());
            match current {
                Some(Ok(true)) => {}
                Some(Ok(false)) => {
                    app.input_start_retry_at = Some(Instant::now() + Duration::from_millis(80));
                    return Ok(StartTurnOutcome::Idle);
                }
                Some(Err(error)) => {
                    let owner = app
                        .input_admission
                        .as_ref()
                        .map(|admission| admission.owner.clone());
                    app.input_unknown_diagnostic = Some((
                        app.input_admission
                            .as_ref()
                            .map(|admission| admission.uuid.clone())
                            .unwrap_or_default(),
                        error.to_string(),
                    ));
                    app.mark_input_uncertain_for(owner);
                    if let Some(front) = app
                        .rejected_turn_steers
                        .front_mut()
                        .or_else(|| app.user_message_queue.front_mut())
                    {
                        front.action = QueuedInputAction::Uncertain;
                    }
                    if let Some(admission) = app.input_admission.as_mut() {
                        admission.cancel_dispatch();
                    }
                    app.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
                    app.sync_input_preparation_indicator();
                    return Ok(StartTurnOutcome::Idle);
                }
                None => {
                    let owner = app
                        .input_admission
                        .as_ref()
                        .map(|admission| admission.owner.clone());
                    app.mark_input_uncertain_for(owner);
                    if let Some(front) = app
                        .rejected_turn_steers
                        .front_mut()
                        .or_else(|| app.user_message_queue.front_mut())
                    {
                        front.action = QueuedInputAction::Uncertain;
                    }
                    return Ok(StartTurnOutcome::Idle);
                }
            }
        }
        app.input_start_retry_at = None;
        let Some(queued_input) = app.pop_user_message_for_turn() else {
            break;
        };
        match queued_input {
            QueuedTurnInput::User {
                model_message,
                display_message,
            } => {
                if already_appended {
                    // The original witness was just rechecked. It does not by
                    // itself linearize the subsequent Provider transport.
                    app.input_admission = None;
                    app.sync_input_preparation_indicator();
                }
                let transcript_start = app.push_scheduled_user_message(&display_message);
                if !already_appended {
                    engine.state.add_message(model_message);
                }
                app.frame_rate_limiter.reset();
                start_turn_with_transcript_start(engine, app, tx, prompt, Some(transcript_start));
                return Ok(StartTurnOutcome::Started);
            }
            QueuedTurnInput::Slash { command } => {
                if let Some(action) = handle_slash_command(&command, app, engine).await {
                    let should_quit =
                        Box::pin(handle_user_action(action, engine, app, tx, prompt)).await?;
                    if should_quit {
                        // Propagate the quit request (e.g. `/quit` typed while a
                        // turn was running) instead of swallowing it.
                        return Ok(StartTurnOutcome::Quit);
                    }
                }
                app.refresh_engine_metadata(engine);
                if app.turn_state.is_active() {
                    return Ok(StartTurnOutcome::Started);
                }
                continue;
            }
            QueuedTurnInput::Shell { command } => {
                if command.is_empty() {
                    app.push_user_shell_help();
                    continue;
                }
                start_user_shell_command(engine, app, tx, prompt, command);
                return Ok(StartTurnOutcome::Started);
            }
        }
    }

    // Completion notifications may arrive a few milliseconds apart. Keep
    // them queued while any parent-notifying background sub-agent is still
    // active, then start one aggregate turn with all terminal events.
    if !app.pending_background_followups.is_empty() && has_nonterminal_background_subagents(engine)
    {
        return Ok(StartTurnOutcome::Idle);
    }

    // Aggregating sub-agent results also starts an automatic goal turn and must
    // share the process allowance with regular goal continuations. A background
    // wakeup cannot bypass the limit.
    if !app.pending_background_followups.is_empty()
        && let Some(goal) = active_goal_for_automatic_turn(engine)
        && tui_goal_auto_continuation_limit_reached(engine, app, &goal)
    {
        emit_tui_goal_auto_continuation_limit_notice(engine, app, tx, &goal);
        return Ok(StartTurnOutcome::Idle);
    }

    if let Some(mut followup) = take_merged_background_followup(app) {
        followup.retain_followup_tasks(engine);
        let followup = select_background_followup_batch(engine, app, followup);
        // Every queued event may be invalidated (typically `close_agent`);
        // in that case skip the aggregate turn below and fall through to the
        // goal/orchestrate continuations instead of starting an empty turn.
        if !followup.events.is_empty() {
            let events = followup.events.clone();
            let summary = followup.summary.clone();
            let (idle_hook_events, stop_followup) = engine
                .run_teammate_idle_hooks(
                    "subagent_followup",
                    serde_json::json!({
                        "reason": "subagent_followup",
                        "events": events,
                        "summary": summary,
                        "cwd": engine.state.cwd(),
                    }),
                )
                .await;
            for event in idle_hook_events {
                if let EngineEvent::HookMessage { text, is_error } = event {
                    let _ = tx.send(AppEvent::SystemNotice(if is_error {
                        format!("[hook error] {}", text)
                    } else {
                        text
                    }));
                }
            }
            if stop_followup {
                return Ok(StartTurnOutcome::Idle);
            }

            let nudge = format!(
                "[system] All tracked background work has finished. Aggregate the \
             results now using the available `<subagent_notification .../>`, \
             `<workflow_notification .../>` and `<task_notification .../>` entries \
             and output files. Events: {}. Continue the original task, do not \
             repeat work already delegated to background work, and do not give \
             a final conclusion until the relevant results have been inspected.",
                summary
            );
            let Some(batch) = prepare_background_followup(engine, followup.ids, nudge).await?
            else {
                return Ok(StartTurnOutcome::Idle);
            };
            app.active_background_followup = Some(batch);
            if let Some(goal) = active_goal_for_automatic_turn(engine) {
                record_tui_goal_auto_continuation_start(engine, app, &goal);
            }
            start_turn(engine, app, tx, prompt);
            return Ok(StartTurnOutcome::Started);
        }
    }

    if try_start_goal_continuation(engine, app, tx, prompt) {
        return Ok(StartTurnOutcome::Started);
    }

    match engine.claim_orchestrate_idle_continuation(
        kcoder_engine::orchestrate::continuation::IdleRequest {
            pending_question: app.pending_question.is_some(),
            cooldown_elapsed: true,
            goal_limit_reached: active_goal_for_automatic_turn(engine)
                .is_some_and(|goal| tui_goal_auto_continuation_limit_reached(engine, app, &goal)),
            ..Default::default()
        },
    ) {
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued {
            prompt: nudge,
        }) => {
            engine.state.add_message(Message::runtime_text(nudge));
            start_turn(engine, app, tx, prompt);
            return Ok(StartTurnOutcome::Started);
        }
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
            reason,
            notify_once: true,
        }) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Orchestrate automatic continuation stopped ({reason}); the work remains active and requires user review."
            )));
        }
        Ok(_) => {}
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Orchestrate continuation could not be prepared: {error:#}"
            )));
        }
    }

    Ok(StartTurnOutcome::Idle)
}
