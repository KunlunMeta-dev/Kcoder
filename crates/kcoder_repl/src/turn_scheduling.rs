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

pub(super) async fn try_start_next_turn(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<StartTurnOutcome> {
    if app.turn_lifecycle_in_progress() {
        return Ok(StartTurnOutcome::Idle);
    }

    loop {
        let next = app
            .rejected_turn_steers
            .front()
            .or_else(|| app.user_message_queue.front());
        if next.is_some_and(|queued| queued.action == QueuedInputAction::Plain)
            && let Err(error) = engine.prepare_client_model_for_turn(None, false)
        {
            let message = format!("Cannot prepare selected model; queued input was kept: {error}");
            if app.queued_model_error.as_deref() != Some(&message) {
                app.queued_model_error = Some(message.clone());
                let _ = tx.send(AppEvent::SystemNotice(message));
            }
            return Ok(StartTurnOutcome::Idle);
        }
        app.queued_model_error = None;
        let Some(queued_input) = app.pop_user_message_for_turn() else {
            break;
        };
        match queued_input {
            QueuedTurnInput::User {
                model_message,
                display_message,
            } => {
                if let Err(error) = engine.acknowledge_orchestrate_user_input() {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Orchestrate work could not acknowledge user input: {error:#}"
                    )));
                    return Ok(StartTurnOutcome::Idle);
                }
                let transcript_start = app.push_scheduled_user_message(&display_message);
                engine.state.add_message(model_message);
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
                "[system] All tracked background sub-agents have finished. Aggregate \
             their results now using the available `<subagent_notification .../>` \
             entries and output files. Events: {}. Continue the original task, \
             do not repeat work already delegated to a sub-agent, and do not give \
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
