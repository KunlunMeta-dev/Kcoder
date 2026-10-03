//! Terminal and engine startup wiring; public REPL entry point.

use super::*;

/// Run the REPL backed by a QueryEngine.
pub async fn run_repl_with_engine(
    mut engine: QueryEngine,
    startup_notice: Option<String>,
) -> Result<()> {
    let tui_settings = recover_read_lock(&engine.settings, "engine.settings")
        .tui
        .clone();
    configure_tui_alternate_screen(tui_settings.no_alt_screen, tui_settings.alternate_screen);
    engine = engine.with_tool_path_previews(tui_settings.path_preview.enabled);

    let mut app = ReplApp::default();
    app.refresh_engine_metadata(&engine);
    let restored_messages = engine.state.messages();
    if !restored_messages.is_empty() {
        app.replace_transcript_from_history(&restored_messages);
        app.reconcile_subagent_panels_from_engine(&engine);
    }
    seed_startup_messages(&mut app, startup_notice);
    if !restored_messages.is_empty() && engine.state.session_mode().is_orchestrate() {
        let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
        if let Ok(snapshot) = store.read_active_work()
            && snapshot.work.progress.completed < snapshot.work.progress.total
        {
            app.push_message(
                MessageRole::System,
                format!(
                    "Detected unfinished Orchestrate work `{}` ({}, revision {}, progress {}/{}). The active plan and bounded notepad context were restored; child-agent transcripts are not resurrected automatically. Use `/work status` to inspect it or `/work select <work_id>` to choose another work.",
                    snapshot.work.display_slug,
                    snapshot.work.work_id,
                    snapshot.work.revision,
                    snapshot.work.progress.completed,
                    snapshot.work.progress.total,
                ),
            );
        } else if let Ok(works) = store.list_works() {
            let candidates = works
                .into_iter()
                .filter(|snapshot| snapshot.work.progress.completed < snapshot.work.progress.total)
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                let choices = candidates
                    .iter()
                    .map(|snapshot| {
                        format!("{} ({})", snapshot.work.display_slug, snapshot.work.work_id)
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Detected unfinished Orchestrate work without an active pointer: {choices}. Use `/work select <work_id>` explicitly before continuing; child-agent transcripts are not resurrected."
                    ),
                );
            }
        }
    }
    if let Ok(settings) = Settings::load()
        && let Ok(dir) = settings.history_dir()
    {
        let path = dir.join("input_history.jsonl");
        let legacy_path = dir.join("input_history.txt");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            warn!("failed to create history directory {:?}: {}", dir, e);
        }
        app.set_input_history_path(path);
        if app
            .input_history_path
            .as_ref()
            .is_some_and(|current| current.exists())
        {
            app.load_input_history();
        } else if legacy_path.exists() {
            match load_input_history_file(&legacy_path) {
                Ok(history) => {
                    app.input_history = history;
                    if let Some(current) = app.input_history_path.as_ref()
                        && let Err(error) = save_input_history_file(current, &app.input_history)
                    {
                        warn!("failed to migrate input history: {}", error);
                    }
                }
                Err(error) => warn!("failed to load legacy input history: {}", error),
            }
        }
    }

    // Complete the sole terminal probe before automatic theme warmup and cache failures so repeated color replies cannot enter the composer.
    let startup_probe = terminal_modes::startup_probe();
    terminal_palette::set_default_colors_from_startup_probe(startup_probe.default_colors);

    // Pre-load Markdown/syntax-highlighting resources off the UI thread so the
    // first terminal draw does not stutter on syntect asset initialization.
    let code_theme = recover_read_lock(&engine.settings, "engine.settings")
        .code_theme
        .clone();
    let _ = tokio::task::spawn_blocking(move || crate::markdown::warm_up(&code_theme)).await;

    let (raw_tx, mut rx) = mpsc::channel::<AppEvent>(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);

    // Run the terminal startup probe BEFORE spawning the crossterm event
    // reader. crossterm 0.28's input parser has no OSC state machine: when it
    // sees the OSC 10/11 query replies (e.g. `\x1B]10;rgb:cccc/cccc/cccc\x1B\\`)
    // it falls back to per-byte parsing and converts the payload into a
    // stream of `KeyCode::Char` events. If the crossterm reader is already
    // polling on stdin when the probe fires, it can race the probe for those
    // response bytes and leak them straight into the prompt buffer.
    // Drain anything that arrived on stdin during the probe window (including
    // any OSC bytes that crossterm may have read concurrently) so the
    // EventStream starts on a clean buffer.
    flush_terminal_input_buffer();

    // Spawn a terminal event reader. It can be paused while an external
    // interactive program owns stdin.
    let terminal_events = spawn_terminal_event_reader(tx.clone());

    spawn_signal_listener(tx.clone());
    let frame_requester = FrameRequester::new(tx.clone());

    let prompt = TuiPermissionPrompt::new(tx.clone());
    engine.set_user_questioner(Arc::new(TuiUserQuestioner::new(tx.clone())));

    // Two cooperating watchers sit on the engine's background-job broadcast:
    //
    // 1. The "injection" watcher is the only one that drains the engine's
    //    own `background_job_rx`. It calls
    //    `QueryEngine::flush_background_jobs` so the corresponding
    //    `<subagent_notification .../>` lands in the main conversation. It
    //    asks the TUI event loop to schedule follow-up work, but never
    //    touches the user prompt queue or starts turns directly.
    //
    // 2. The "tui" watcher subscribes to a *separate* broadcast receiver
    //    (via `subscribe_background_jobs`) and only feeds the TUI a tiny
    //    status hint. The hint is not written to the transcript; it only
    //    updates compact status surfaces, so the user sees delegated work
    //    state without it appearing in the transcript or being confused for
    //    assistant output.
    {
        let injection_engine = engine.clone();
        let followup_tx = tx.clone();
        tokio::spawn(async move {
            let mut last_goal_wake: Option<String> = None;
            // The injection watcher owns the engine's primary receiver. We
            // can subscribe to a fresh broadcast receiver for the TUI
            // watcher; they coexist without starving each other as long as
            // only the injection one drains engine state.
            //
            // To avoid double-broadcasting, we re-implement the polling
            // loop here using `try_recv` semantics: every 100 ms we ask the
            // engine to flush whatever it has buffered and then act on it.
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                // While a turn stream is alive the engine turn loop owns
                // background event delivery: it defers events and injects them
                // at the next protocol boundary. Flushing here would race that
                // claim and turn a same-turn continuation into a spurious extra
                // follow-up turn. The next 100 ms tick after the turn ends
                // picks the event up instead (nothing else drains the receiver
                // in that gap, so no event can be lost).
                if injection_engine.turn_driver_active() {
                    continue;
                }
                let drained = injection_engine.flush_background_jobs_with_hooks().await;
                for event in &drained {
                    if let EngineEvent::HookMessage { text, is_error } = event {
                        let _ = followup_tx
                            .send_ordered(AppEvent::SystemNotice(if *is_error {
                                format!("[hook error] {}", text)
                            } else {
                                text.clone()
                            }))
                            .await;
                    }
                }
                // `flush_background_jobs` also reports explicit
                // background shell tasks and internal maintenance jobs.
                // Only sub-agent completions should wake the main model;
                // tool background tasks are consumed by TaskOutput.
                let followup_events: Vec<EngineEvent> = drained
                    .iter()
                    .filter(|event| injection_engine.background_event_triggers_followup(event))
                    .cloned()
                    .collect();
                let active_goal_id =
                    active_goal_for_continuation(&injection_engine).map(|goal| goal.goal_id);
                if !followup_events.is_empty() {
                    // Mirror `events` one-to-one: an id-less event becomes an
                    // empty id (which always survives validation) instead of
                    // being dropped, so `ids` and `events` can never
                    // desynchronize under `zip` in the enqueue/merge paths.
                    let ids = followup_events
                        .iter()
                        .map(|event| {
                            event
                                .background_identity()
                                .map(|identity| {
                                    serde_json::to_string(&identity.run)
                                        .expect("serializable run key")
                                })
                                .unwrap_or_else(|| {
                                    background_event_id(event).unwrap_or_default().to_string()
                                })
                        })
                        .collect::<Vec<_>>();
                    let events = followup_events
                        .iter()
                        .map(format_background_event)
                        .collect::<Vec<_>>();
                    let summary = events.join(" ");
                    let _ = followup_tx
                        .send_ordered(AppEvent::BackgroundFollowupRequested {
                            ids,
                            events,
                            summary,
                        })
                        .await;
                    if active_goal_id.is_none() {
                        last_goal_wake = None;
                    }
                } else if let Some(goal_id) = active_goal_id {
                    if last_goal_wake.as_deref() != Some(goal_id.as_str())
                        && followup_tx.send_ordered(AppEvent::TurnWakeRequested).await
                    {
                        last_goal_wake = Some(goal_id);
                    }
                } else {
                    last_goal_wake = None;
                }
            }
        });
    }
    {
        let bg_tx = tx.clone();
        let mut bg_rx = engine.subscribe_background_jobs();
        let bg_diagnostic_engine = engine.clone();
        tokio::spawn(async move {
            // Broadcasts cover only the current process. Rebuild panels from persisted task
            // sidecars at startup so normal restarts show paused, stopped, and running sub-agents.
            for event in reconciled_subagent_task_events(&bg_diagnostic_engine) {
                if !bg_tx.send_ordered(event).await {
                    return;
                }
            }
            let mut seen_background_events = std::collections::HashSet::new();
            let mut background_event_order = std::collections::VecDeque::new();
            'watcher: loop {
                let event = match bg_rx.recv().await {
                    Ok(event) => event,
                    Err(error) => {
                        if let Some(app_event) = background_watcher_error_event(error) {
                            if !bg_tx.send_ordered(app_event).await {
                                break;
                            }
                            for event in reconciled_subagent_task_events(&bg_diagnostic_engine) {
                                if !bg_tx.send_ordered(event).await {
                                    break 'watcher;
                                }
                            }
                            continue;
                        }
                        break;
                    }
                };
                if let Some(identity) = event.identity() {
                    if !seen_background_events.insert(identity.event_id.clone()) {
                        continue;
                    }
                    background_event_order.push_back(identity.event_id.clone());
                    if background_event_order.len() > 4096
                        && let Some(oldest) = background_event_order.pop_front()
                    {
                        seen_background_events.remove(&oldest);
                    }
                    if bg_diagnostic_engine
                        .state
                        .task(&identity.run.agent_id)
                        .is_none_or(|task| task.background_run.as_ref() != Some(&identity.run))
                    {
                        // A deleted or superseded run must not recreate the current status panel.
                        continue;
                    }
                }
                let app_event = match event.into_payload() {
                    BackgroundJobEvent::Scoped { .. } => {
                        unreachable!("into_payload unwraps scoped events")
                    }
                    BackgroundJobEvent::Started {
                        id,
                        description,
                        continuation,
                    } => AppEvent::BackgroundJobStarted {
                        id,
                        description,
                        continuation,
                    },
                    BackgroundJobEvent::Associated {
                        id,
                        tool_call_id,
                        run_in_background,
                    } => AppEvent::BackgroundJobAssociated {
                        id,
                        tool_call_id,
                        run_in_background,
                    },
                    BackgroundJobEvent::Promoted { id } => AppEvent::BackgroundJobPromoted { id },
                    BackgroundJobEvent::Progress {
                        id,
                        message,
                        detail,
                        current,
                        total,
                    } => AppEvent::BackgroundJobProgress {
                        id,
                        message,
                        detail,
                        current,
                        total,
                    },
                    BackgroundJobEvent::SubagentSteerApplied {
                        id,
                        message_id,
                        queue_depth,
                    } => AppEvent::SubagentSteerApplied {
                        id,
                        message_id,
                        queue_depth,
                    },
                    BackgroundJobEvent::Completed { id, output } => {
                        // Status indicator only — the engine already has the
                        // actual result, the model has been (or will be)
                        // nudged via `<subagent_notification .../>`, and the
                        // transcript stays clean.
                        let text = content_blocks_text(&output.content);
                        AppEvent::BackgroundJobCompleted {
                            id,
                            summary: (!text.trim().is_empty())
                                .then(|| truncate_display_text(text.trim(), 2_000)),
                        }
                    }
                    BackgroundJobEvent::Failed { id, error } => {
                        append_repl_exit_diagnostic(
                            &bg_diagnostic_engine,
                            "background_job_failed",
                            &format!("{id}: {error}"),
                        );
                        AppEvent::BackgroundJobFailed { id, error }
                    }
                    BackgroundJobEvent::Paused { id, reason } => {
                        let reason = orchestrate_agent_terminal_control_detail(
                            &bg_diagnostic_engine,
                            &id,
                            &reason,
                        );
                        AppEvent::BackgroundJobPaused { id, reason }
                    }
                    BackgroundJobEvent::Halted { id, reason } => {
                        let reason = orchestrate_agent_terminal_control_detail(
                            &bg_diagnostic_engine,
                            &id,
                            &reason,
                        );
                        AppEvent::BackgroundJobHalted { id, reason }
                    }
                    BackgroundJobEvent::Cancelled { id, .. } => {
                        AppEvent::BackgroundJobCancelled { id }
                    }
                };
                if !bg_tx.send_ordered(app_event).await {
                    break;
                }
            }
        });
    }
    {
        let cron_tx = tx.clone();
        let cron_scheduler = engine.cron_scheduler();
        let mut cron_rx = engine.subscribe_cron();
        tokio::spawn(async move {
            while let Ok(fire) = cron_rx.recv().await {
                let folded = if fire.coalesced == 0 {
                    String::new()
                } else {
                    format!(
                        " {} additional missed trigger(s) were coalesced.",
                        fire.coalesced
                    )
                };
                let event = format!(
                    "[scheduled task {} due at {}] {}{}",
                    fire.id, fire.scheduled_at, fire.prompt, folded
                );
                if !cron_tx
                    .send_ordered(AppEvent::BackgroundFollowupRequested {
                        ids: vec![String::new()],
                        events: vec![event.clone()],
                        summary: event,
                    })
                    .await
                {
                    break;
                }
                // Acknowledge only queue delivery, never model/tool execution.
                // Failure leaves the durable receipt uncertain; do not resend.
                if cron_scheduler.acknowledge_delivery(&fire).is_err() {
                    let _ = cron_tx.send_ordered(AppEvent::SystemNotice(
                        format!("Scheduled task {} was queued, but its delivery record could not be saved. Inspect cron delivery diagnostics before retrying.", fire.id),
                    )).await;
                }
            }
        });
    }

    let (mut terminal, mut terminal_guard) = init_kcoder_terminal(startup_probe)?;
    let result = repl_loop(
        &mut terminal,
        &engine,
        &mut app,
        &mut rx,
        tx,
        &mut terminal_guard,
        terminal_events,
        frame_requester,
        prompt,
    )
    .await;
    match &result {
        Ok(()) => append_repl_exit_diagnostic(&engine, "exit", "success"),
        Err(error) => append_repl_exit_diagnostic(&engine, "exit", &format!("error: {error:#}")),
    }
    let exit_reason = if result.is_ok() { "success" } else { "error" };
    let title_cleanup_result = app.clear_managed_terminal_title(terminal.backend_mut());
    let cleanup_result = if terminal_guard.uses_alternate_screen() {
        let cleanup_result = cleanup_alternate_screen_for_exit(&mut terminal);
        terminal_guard.restore();
        cleanup_result
    } else {
        // Restoring terminal modes resets the scroll region (`ESC[r`), and many
        // terminals move the cursor to home as part of that reset. Do it before
        // the final inline cleanup so the shell prompt lands after the emitted
        // transcript instead of overwriting the top of the old viewport.
        terminal_guard.restore();
        cleanup_inline_viewport_for_exit(&mut terminal, &mut app)
    };
    let _ = engine.run_session_end_hooks(exit_reason).await;
    result.and(title_cleanup_result).and(cleanup_result)
}
