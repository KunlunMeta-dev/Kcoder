//! Bounded event loop and deferred turn wake scheduling.

use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn repl_loop(
    terminal: &mut Terminal<impl Backend + Write>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    rx: &mut mpsc::Receiver<AppEvent>,
    tx: AppEventSender,
    terminal_guard: &mut TerminalGuard,
    terminal_events: TerminalEventController,
    frame_requester: FrameRequester,
    prompt: TuiPermissionPrompt,
) -> Result<()> {
    let mut redraw = true;
    loop {
        // Coalesce streaming output at 15 FPS and temporarily raise direct scrolling to
        // 30 FPS. Both paths remain throttled so high-frequency events cannot saturate the terminal queue.
        if redraw {
            if let Some(wait) = app.time_until_next_viewport_draw(Instant::now()) {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    event = rx.recv() => {
                        let event = event.context("event channel closed unexpectedly")?;
                        let handled =
                            handle_event_batch(event, app, engine, &tx, &prompt, rx).await;
                        redraw |= handled.redraw;
                        if handled.flush_frame {
                            app.frame_rate_limiter.reset();
                        }
                        if let Some(action) = handled.action {
                            if handle_user_action_with_terminal(
                                action,
                                engine,
                                app,
                                &tx,
                                &prompt,
                                terminal,
                                terminal_guard,
                                &terminal_events,
                                &frame_requester,
                            )
                            .await?
                            {
                                return Ok(());
                            }
                            redraw = true;
                        }
                        if app.time_until_next_viewport_draw(Instant::now()).is_some() {
                            continue;
                        }
                    }
                }
            }
            // Apply any accumulated mouse-wheel deltas before drawing so the
            // viewport reflects the latest scroll input.
            app.apply_pending_scroll();
            terminal_guard.sync_navigation_mouse(
                app.copy_view.is_some() || app.outline_open || app.navigation.inline,
            )?;
            let surface_mode = if terminal_guard.uses_alternate_screen() {
                TerminalSurfaceMode::Fullscreen
            } else {
                TerminalSurfaceMode::Inline
            };
            let more_scrollback_to_flush =
                draw_kcoder_frame_with_mode(terminal, app, surface_mode)?;
            app.frame_rate_limiter.mark_emitted(Instant::now());
            if app.needs_scheduled_frame_tick() {
                let delay = app.next_frame_tick_delay();
                if delay.is_zero() {
                    frame_requester.schedule_frame();
                } else {
                    frame_requester.schedule_frame_in(delay);
                }
            }
            redraw = more_scrollback_to_flush;
        }

        let event = rx
            .recv()
            .await
            .context("event channel closed unexpectedly")?;
        let handled = handle_event_batch(event, app, engine, &tx, &prompt, rx).await;
        redraw |= handled.redraw;
        if handled.flush_frame {
            app.frame_rate_limiter.reset();
        }

        if let Some(action) = handled.action {
            if handle_user_action_with_terminal(
                action,
                engine,
                app,
                &tx,
                &prompt,
                terminal,
                terminal_guard,
                &terminal_events,
                &frame_requester,
            )
            .await?
            {
                return Ok(());
            }
            redraw = true;
        }
    }
}

pub(super) async fn handle_event_batch(
    event: AppEvent,
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    rx: &mut mpsc::Receiver<AppEvent>,
) -> HandledAppEvent {
    let started_at = Instant::now();
    let mut processed_events = 1usize;
    let mut handled = handle_app_event(event, app, engine, tx, prompt).await;

    // Coalesce rapid events into a single render pass. This keeps the UI
    // responsive during high-frequency streaming while still processing all
    // state updates. Stop as soon as a user action appears so command
    // execution and submissions keep their original ordering. Also stop after
    // a small event/time budget so an always-nonempty stream cannot starve the
    // renderer until the user resizes the terminal.
    while handled.action.is_none() && !handled.flush_frame {
        if event_batch_budget_exhausted(processed_events, started_at, Instant::now()) {
            break;
        }
        match rx.try_recv() {
            Ok(event) => {
                let next = handle_app_event(event, app, engine, tx, prompt).await;
                handled.merge(next);
                processed_events = processed_events.saturating_add(1);
            }
            Err(_) => break,
        }
    }

    handled
}

pub(super) fn event_batch_budget_exhausted(
    processed_events: usize,
    started_at: Instant,
    now: Instant,
) -> bool {
    processed_events >= EVENT_BATCH_MAX_EVENTS
        || now.saturating_duration_since(started_at) >= EVENT_BATCH_MAX_DURATION
}

pub(super) fn schedule_deferred_turn_wake(tx: &AppEventSender, delay: Duration) {
    let tx = tx.clone();
    tokio::spawn(async move {
        if delay.is_zero() {
            tokio::task::yield_now().await;
        } else {
            tokio::time::sleep(delay).await;
        }
        let _ = tx.send_ordered(AppEvent::TurnWakeRequested).await;
    });
}

pub(super) fn turn_wake_delay_after_finish(engine: &QueryEngine, app: &ReplApp) -> Duration {
    if active_goal_for_continuation(engine)
        .is_some_and(|goal| !tui_goal_auto_continuation_limit_reached(engine, app, &goal))
        && app.queued_user_message_count() == 0
        && app.pending_background_followups.is_empty()
    {
        if engine.state.session_mode().is_orchestrate() {
            GOAL_CONTINUATION_COOLDOWN.max(Duration::from_secs(
                engine
                    .settings
                    .read()
                    .unwrap()
                    .orchestrate
                    .continuation
                    .cooldown_seconds,
            ))
        } else {
            GOAL_CONTINUATION_COOLDOWN
        }
    } else if engine.state.session_mode().is_orchestrate()
        && app.queued_user_message_count() == 0
        && app.pending_background_followups.is_empty()
        && kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd())
            .read_active_work()
            .is_ok_and(|snapshot| {
                let continuation =
                    kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd())
                        .read_continuation_state(&snapshot.work.work_id)
                        .unwrap_or_default();
                snapshot.work.progress.completed < snapshot.work.progress.total
                    && !continuation.manual_intervention_required
            })
    {
        Duration::from_secs(
            engine
                .settings
                .read()
                .unwrap()
                .orchestrate
                .continuation
                .cooldown_seconds,
        )
    } else {
        Duration::ZERO
    }
}
