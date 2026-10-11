//! Foreground task spawning, shell/compaction/side-question work, and completion.

use super::*;

pub(super) fn start_turn(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) {
    start_turn_with_transcript_start(engine, app, tx, prompt, None);
}

pub(super) fn start_turn_with_transcript_start(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    transcript_start: Option<usize>,
) {
    let cancel = CancellationToken::new();
    let steer_session = engine.begin_turn_steering();
    let path_preview_generation = app.path_previews.next_generation();
    let handle = spawn_turn(
        engine.clone(),
        None,
        tx.clone(),
        prompt.clone(),
        cancel.clone(),
        steer_session,
        path_preview_generation,
        app.active_background_followup.take(),
    );
    app.begin_turn_with_transcript_start(handle, cancel, transcript_start);
}

pub(super) fn start_user_shell_command(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    command: String,
) {
    let cancel = CancellationToken::new();
    let handle = spawn_user_shell_command(
        engine.clone(),
        command,
        tx.clone(),
        prompt.clone(),
        cancel.clone(),
    );
    app.begin_turn(handle, cancel);
}

pub(super) fn start_manual_compaction(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) {
    let cancel = CancellationToken::new();
    let handle = spawn_manual_compaction(engine.clone(), tx.clone(), cancel.clone());
    app.foreground_operation_label = Some("Compacting context".to_string());
    app.begin_turn(handle, cancel);
}

pub(super) fn start_moa_plan(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    request: String,
) {
    let cancel = CancellationToken::new();
    let operation_engine = engine.clone().with_cancel_token(cancel.clone());
    let operation_tx = tx.clone();
    let progress_tx = tx.clone();
    let visible_request = request.clone();
    let handle = tokio::spawn(async move {
        let _ = operation_tx.send_ordered(AppEvent::TurnStarted).await;
        let _ = operation_tx
            .send_ordered(AppEvent::SystemNotice(
                "MoA plan: running independent planners; final synthesis will start after all planners settle."
                    .to_string(),
            ))
            .await;
        let progress = Arc::new(move |update: kcoder_engine::MoaPlanProgress| {
            progress_tx.send(AppEvent::MoaPlanProgress {
                message: update.message,
                completed: update.completed,
                total: update.total,
            });
        });
        let event = match operation_engine
            .run_moa_plan_with_progress(&request, progress)
            .await
        {
            Ok(result) => AppEvent::MoaPlanFinished {
                final_path: result.final_path,
                draft_count: result.draft_paths.len(),
                failed_count: result.failed_planners.len(),
            },
            Err(error) => AppEvent::MoaPlanFailed {
                error: error.to_string(),
            },
        };
        let _ = operation_tx.send_ordered(event).await;
        let _ = operation_tx.send_ordered(AppEvent::TurnFinished).await;
    });
    app.push_message(MessageRole::User, visible_request);
    app.foreground_operation_label = Some("Building MoA plan".to_string());
    app.begin_turn(handle, cancel);
}

pub(super) fn start_side_question(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    question: String,
) {
    let Some((id, cancel)) = app.open_side_question(question.clone()) else {
        app.push_message(
            MessageRole::System,
            "Close the active dialog before opening /btw.",
        );
        return;
    };
    let engine = engine.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let event = match engine.run_side_question(&question, cancel).await {
            Ok(answer) => AppEvent::SideQuestionCompleted { id, answer },
            Err(error) => AppEvent::SideQuestionFailed {
                id,
                error: error.to_string(),
            },
        };
        let _ = tx.send_ordered(event).await;
    });
}

pub(super) fn spawn_manual_compaction(
    engine: QueryEngine,
    tx: AppEventSender,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        if !tx.send_ordered(AppEvent::TurnStarted).await {
            return;
        }

        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = engine.compact_conversation() => Some(match result {
                Ok(result) => AppEvent::ManualCompactionFinished {
                    did_compact: result.did_compact,
                    pre_compact_tokens: result.pre_compact_tokens,
                    post_compact_tokens: result.post_compact_tokens,
                },
                Err(error) => AppEvent::ManualCompactionFailed {
                    error: error.to_string(),
                },
            }),
        };

        if let Some(event) = event {
            let _ = tx.send_ordered(event).await;
        }
        completion.finish_ordered().await;
    })
}

pub(super) fn spawn_user_shell_command(
    engine: QueryEngine,
    command: String,
    tx: AppEventSender,
    prompt: TuiPermissionPrompt,
    turn_cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        let _ = tx.send_ordered(AppEvent::TurnStarted).await;
        let events = engine
            .run_user_shell_command(command, &prompt, turn_cancel)
            .await;
        for event in events {
            append_repl_engine_event_diagnostic(&engine, &event);
            let Some(app_event) = engine_event_to_app_event_for_generation(event, 0) else {
                continue;
            };
            if !tx.send_ordered(app_event).await {
                break;
            }
        }
        completion.finish_ordered().await;
    })
}

pub(super) fn await_turn_task_for_logging(handle: JoinHandle<()>) {
    tokio::spawn(async move {
        match handle.await {
            Err(error) if !error.is_cancelled() => {
                warn!(%error, "turn task failed");
            }
            _ => {}
        }
    });
}

pub(super) fn complete_finished_turn(
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    handle: Option<JoinHandle<()>>,
) -> HandledAppEvent {
    app.flush_active_turn();
    app.consolidate_finished_assistant_stream();
    app.set_loading(false);
    // Reset the row-count baseline so the next `draw()` recomputes
    // `row_budget` from a clean state. After consolidation the merged
    // assistant message can be far taller than the previous frame's
    // `last_line_count`, and a stale value would shrink the render
    // budget and miscompute the scroll offset. Unconditional because
    // scrolled-away users also need a recompute (they just keep their
    // pinned offset via `snap_to_bottom` being guarded below).
    app.transcript_viewport.invalidate_content_layout();
    if let Some(divider) = app.finish_turn_separator_text() {
        app.push_message(MessageRole::System, divider);
    }
    app.refresh_engine_metadata(engine);
    if app.transcript_viewport.is_at_tail() {
        app.snap_to_bottom();
    }
    // Force a full viewport repaint on the next draw. This is set
    // AFTER all message mutations (flush, consolidation, divider push,
    // metadata refresh) so the invalidated previous-buffer diff sees
    // the final transcript state. Without this, ratatui's cell-level
    // diff leaves stale rows when content shifts (e.g. the active-turn
    // lines disappearing into committed messages), producing visible
    // duplicated text until the user scrolls or resizes. Unconditional
    // so scrolled-away users also get a clean repaint of the shifted
    // window.
    app.force_next_viewport_redraw();
    if let Some(handle) = handle {
        await_turn_task_for_logging(handle);
    }
    schedule_deferred_turn_wake(tx, turn_wake_delay_after_finish(engine, app));
    HandledAppEvent::redraw()
}
